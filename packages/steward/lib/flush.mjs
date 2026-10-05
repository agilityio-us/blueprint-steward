// Steward's flush job. The host serves the session bundle
// (GET /api/blueprint/runner/jobs/:id/bundle, as { files, expect, branch, remoteUrl, key, headSeq }); this
// module commits its five files, and the two docs when it carries them, to origin's branch by plumbing. Nothing here
// moves a HEAD, writes an index other than a temporary one, or touches a working-tree file, so the commit holds exactly
// the owned paths whatever else (the extract's .blueprint/graph.json and diagnostics.json, untracked files) the checkout
// carries. The push is fast-forward only and never forced: a branch that moved under it is fetched again and the commit
// rebuilt on the new tip.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { normalizeRemoteUrl } from '@bett3r-dev/blueprint-spec';
import { runQueued } from './child.mjs';

export { normalizeRemoteUrl };

/** The bundle's five files, by name; `files`, `expect` and the report's `blobShas` are keyed by these names. */
export const FLUSH_FILES = [ 'manifest.json', 'ops.jsonl', 'design.json', 'board.json', 'map.json' ];

/**
 * The docs a bundle carries while a completion is at `bundle`, committed one level above the bundle's
 * directory (<root>/<KEY>/) and keyed like the bundle's files. A bundle without them commits the five files alone.
 */
export const FLUSH_DOC_FILES = [ 'blueprint.md', 'decisions.md' ];

/** A push that loses to a branch that moved is retried from the fetch this many times, then reported non-ff. */
export const FLUSH_PUSH_RETRIES = 3;

// The bundle lives under <workDocsRoot>/<KEY>/blueprint/. `.claude/bett3r-ai-workflow.json`'s workDocsRoot,
// read at the branch's head, overrides docs/prs; an invalid one fails the flush and never falls back.
const DEFAULT_WORK_DOCS_ROOT = 'docs/prs';
const WORKFLOW_CONFIG = '.claude/bett3r-ai-workflow.json';
export const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// git runs async through child.mjs (childEnv, per-repository queue, timeout); flushBundle may be handed
// Steward's own queued git, keyed by --repo, so a worktree's calls queue behind the repository's.
const defaultGit = ( cwd, argv, { env, input } = {} ) => runQueued( cwd, 'git', argv, { cwd, input, extraEnv: env } );
export const gitFailure = ( result ) => ( result.stderr || result.error?.message || `exit ${ result.status }` ).trim();
export const gitOut = async ( git, cwd, argv, options ) => {
  const result = await git( cwd, argv, options );
  if ( result.status !== 0 ) throw new Error( `git ${ argv[ 0 ] } failed: ${ gitFailure( result ) }` );
  return result.stdout.trim();
};

// A typed failure: the report's reason, and a result of { error } naming it.
const failed = ( reason, detail ) => ( { ok: false, reason, result: JSON.stringify( { error: reason, detail } ) } );

// The branch's tip as origin holds it now, or undefined when origin has no such branch. Shared with lib/scaffold.mjs.
export const remoteTip = async ( git, dir, branch ) => {
  const listed = await git( dir, [ 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${ branch }` ] );
  if ( listed.status === 2 ) return { missing: true };
  if ( listed.status !== 0 ) return { error: gitFailure( listed ) };
  return { tip: listed.stdout.split( /\s/ )[ 0 ] };
};

// Where the bundle goes on this commit of the branch, or a failure when its workflow config is invalid. Shared with
// lib/scaffold.mjs, whose scaffold.json goes one level above it.
export const bundleDirAt = async ( git, dir, commit, key ) => {
  const shown = await git( dir, [ 'cat-file', 'blob', `${ commit }:${ WORKFLOW_CONFIG }` ] );
  let root = DEFAULT_WORK_DOCS_ROOT;
  if ( shown.status === 0 ) {
    let config;
    try { config = JSON.parse( shown.stdout ); } catch { return { error: `${ WORKFLOW_CONFIG } at ${ commit } is not JSON` }; }
    const value = config?.workDocsRoot;
    if ( value !== undefined ) {
      const normal = typeof value === 'string' ? posix.normalize( value ).replace( /\/+$/, '' ) : '';
      if ( normal === '' || normal === '.' || isAbsolute( normal ) || normal.split( '/' ).includes( '..' ) ) {
        return { error: `${ WORKFLOW_CONFIG } at ${ commit } names workDocsRoot ${ JSON.stringify( value ) }, not a path inside the repository` };
      }
      root = normal;
    }
  }
  return { path: `${ root }/${ key }/blueprint` };
};

// The commit message: the subject, then the session, the head and every actor the ops name.
const messageOf = ( bundle, sessionId ) => {
  let manifest = {};
  try { manifest = JSON.parse( bundle.files[ 'manifest.json' ] ); } catch { manifest = {}; }
  const oneLine = ( value ) => String( value ).replace( /\s+/g, ' ' ).trim();
  const actors = new Set();
  for ( const line of bundle.files[ 'ops.jsonl' ].split( '\n' ) ) {
    if ( line.trim() === '' ) continue;
    let op;
    try { op = JSON.parse( line ); } catch { continue; }
    for ( const actor of [ op?.principal, op?.onBehalfOf ] ) if ( typeof actor === 'string' && actor !== '' ) actors.add( oneLine( actor ) );
  }
  const session = typeof manifest.sessionId === 'string' ? manifest.sessionId : sessionId;
  const name = typeof manifest.name === 'string' ? manifest.name : session;
  return [
    `design(${ bundle.key }): session ${ oneLine( name ) } through seq ${ bundle.headSeq }`,
    '',
    `Blueprint-Session: ${ oneLine( session ) }`,
    `Blueprint-Seq: ${ bundle.headSeq }`,
    `Blueprint-Actors: ${ actors.size === 0 ? 'none' : [ ...actors ].sort().join( ', ' ) }`,
    '',
  ].join( '\n' );
};

// The bundle as the host served it, or the reason it cannot be flushed as it stands.
const invalidBundle = ( bundle ) => {
  if ( typeof bundle !== 'object' || bundle === null ) return 'the host served no bundle';
  if ( typeof bundle.branch !== 'string' || bundle.branch === '' ) return 'the bundle names no branch';
  if ( typeof bundle.remoteUrl !== 'string' || bundle.remoteUrl.trim() === '' ) return 'the bundle names no repository';
  if ( typeof bundle.key !== 'string' || !KEY_SEGMENT.test( bundle.key ) ) return `the bundle key ${ JSON.stringify( bundle.key ) } is not one plain path segment`;
  if ( !Number.isSafeInteger( bundle.headSeq ) ) return 'the bundle carries no head seq';
  const missing = FLUSH_FILES.filter( ( name ) => typeof bundle.files?.[ name ] !== 'string' );
  if ( missing.length > 0 ) return `the bundle lacks ${ missing.join( ', ' ) }`;
  return undefined;
};

/**
 * Commits `bundle` to origin's `bundle.branch` from the repository at `dir` (the session's worktree), and answers the
 * outcome Steward reports: done with { commitSha, headSeq, blobShas }, or failed with { diverged } or { error }.
 */
export const flushBundle = async ( { dir, bundle, sessionId, git = defaultGit } ) => {
  const invalid = invalidBundle( bundle );
  if ( invalid !== undefined ) throw new Error( invalid );
  const { branch } = bundle;
  // (2) The job's repository is origin's, or nothing is fetched or written.
  const origin = await git( dir, [ 'remote', 'get-url', 'origin' ] );
  const originUrl = origin.status === 0 ? origin.stdout.trim() : '';
  if ( originUrl === '' || normalizeRemoteUrl( originUrl ) !== normalizeRemoteUrl( bundle.remoteUrl ) ) {
    return failed( 'wrong-repo', `origin is ${ originUrl || 'unset' }, the job's repository is ${ bundle.remoteUrl }` );
  }
  const tracking = `refs/remotes/origin/${ branch }`;
  for ( let attempt = 0; attempt <= FLUSH_PUSH_RETRIES; attempt += 1 ) {
    // (1) Fetch the branch. (7) A branch origin lacks is reported, and never created.
    const fetched = await git( dir, [ 'fetch', '--quiet', 'origin', `+refs/heads/${ branch }:${ tracking }` ] );
    if ( fetched.status !== 0 ) {
      const now = await remoteTip( git, dir, branch );
      if ( now.missing ) return failed( 'branch-missing', `origin has no branch ${ branch }` );
      return failed( 'checkout-failed', `git fetch origin ${ branch } failed: ${ gitFailure( fetched ) }` );
    }
    const base = await gitOut( git, dir, [ 'rev-parse', '--verify', `${ tracking }^{commit}` ] );
    const at = await bundleDirAt( git, dir, base, bundle.key );
    if ( at.error !== undefined ) return failed( 'config-invalid', at.error );
    const docs = FLUSH_DOC_FILES.filter( ( name ) => typeof bundle.files[ name ] === 'string' );
    const owned = [ ...FLUSH_FILES, ...docs ];
    const paths = Object.fromEntries( [
      ...FLUSH_FILES.map( ( name ) => [ name, `${ at.path }/${ name }` ] ),
      ...docs.map( ( name ) => [ name, `${ posix.dirname( at.path ) }/${ name }` ] ),
    ] );
    // (3) An owned path whose object at the tip is not the one last committed is diverged. The job expects null for a
    // file never committed, so absence passes only before the first commit; a file deleted after it is diverged.
    const listed = await gitOut( git, dir, [ 'ls-tree', '-z', base, '--', ...Object.values( paths ) ] );
    const found = Object.fromEntries( listed.split( '\0' ).filter( ( entry ) => entry !== '' ).map( ( entry ) => {
      const [ meta, path ] = entry.split( '\t' );
      return [ path, meta.split( ' ' )[ 2 ] ];
    } ) );
    const diverged = owned
      .map( ( name ) => ( { path: paths[ name ], expected: bundle.expect?.[ name ] ?? null, found: found[ paths[ name ] ] ?? null } ) )
      .filter( ( entry ) => entry.found !== entry.expected );
    if ( diverged.length > 0 ) return { ok: false, reason: 'diverged', result: JSON.stringify( { diverged } ) };
    // (4) The blobs, a tree from the tip's through a temporary index holding only the owned paths, the commit on the tip.
    const blobShas = {};
    for ( const name of owned ) blobShas[ name ] = await gitOut( git, dir, [ 'hash-object', '-w', '--stdin' ], { input: bundle.files[ name ] } );
    const scratch = await mkdtemp( join( tmpdir(), 'blueprint-flush-' ) );
    let tree;
    try {
      const env = { GIT_INDEX_FILE: join( scratch, 'index' ) };
      await gitOut( git, dir, [ 'read-tree', `${ base }^{tree}` ], { env } );
      for ( const name of owned ) await gitOut( git, dir, [ 'update-index', '--add', '--cacheinfo', `100644,${ blobShas[ name ] },${ paths[ name ] }` ], { env } );
      tree = await gitOut( git, dir, [ 'write-tree' ], { env } );
    } finally {
      await rm( scratch, { recursive: true, force: true } );
    }
    // A branch that already holds the bundle as served is committed through it: no empty commit is made.
    if ( tree === await gitOut( git, dir, [ 'rev-parse', `${ base }^{tree}` ] ) ) {
      return { ok: true, result: JSON.stringify( { commitSha: base, headSeq: bundle.headSeq, blobShas } ) };
    }
    const commit = await gitOut( git, dir, [ 'commit-tree', tree, '-p', base, '-F', '-' ], { input: messageOf( bundle, sessionId ) } );
    // (5) The push names the commit and the branch, and is never forced.
    const pushed = await git( dir, [ 'push', '--quiet', 'origin', `${ commit }:refs/heads/${ branch }` ] );
    if ( pushed.status === 0 ) return { ok: true, result: JSON.stringify( { commitSha: commit, headSeq: bundle.headSeq, blobShas } ) };
    // (6) A push refused because the branch moved from the tip it was built on goes round again from the fetch;
    // any other refusal (a protected branch, a hook) is reported with git's own words.
    const now = await remoteTip( git, dir, branch );
    if ( now.missing ) return failed( 'branch-missing', `origin's branch ${ branch } was deleted during the flush` );
    // A push that landed and then exited non-zero (the connection dropped after the ref moved) is done.
    if ( now.tip === commit ) return { ok: true, result: JSON.stringify( { commitSha: commit, headSeq: bundle.headSeq, blobShas } ) };
    if ( now.tip === undefined || now.tip === base ) return failed( 'push-rejected', gitFailure( pushed ) );
  }
  return failed( 'non-ff', `origin's branch ${ branch } moved under each of ${ FLUSH_PUSH_RETRIES + 1 } pushes` );
};
