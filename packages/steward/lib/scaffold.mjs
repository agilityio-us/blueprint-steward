// Steward's scaffold job. In the session's worktree at the payload's sha, which must be the tip of origin's branch,
// it cleans the tree, extracts, deletes every stub the
// committed <root>/<KEY>/scaffold.json lists that is still blob-identical to what was created (an edited one is kept
// and reported), runs the repository's designTooling.scaffold with --write --json, --design and --map on the bundle
// (so agreed scenarios become it.todo tests), and commits what it wrote, its barrel appends and the new scaffold.json
// by plumbing on that sha, fast-forward only. Every run that reaches the commit makes one, under the trailer
// `Blueprint-Scaffold: <KEY>`, so the latest such commit on the branch is the scaffold in force: one with nothing to
// write commits scaffold.json alone, and a repository that declares no scaffold command commits a scaffold.json whose
// status is skipped. No model runs and no test runs: this module starts git and the declared
// scaffold command, and calls the `extract` it is handed (Steward's extractIn, which runs the declared extract
// command and, when that fails in a worktree with no node_modules, one install without build scripts). Exit 3
// (SCAFFOLD_EXIT_BLOCKED) commits and reports blocked; any other non-zero exit fails.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { BLUEPRINT_CONFIG_FILE, SCAFFOLD_EXIT_BLOCKED, SCAFFOLD_EXIT_OK, SCAFFOLD_REPORT_FILE, SCAFFOLD_TRAILER } from '@bett3r-dev/blueprint-spec';
import { runChild } from './child.mjs';
import { bundleDirAt, gitFailure, gitOut, KEY_SEGMENT, remoteTip } from './flush.mjs';

export const SCAFFOLD_JOB_KIND = 'scaffold';
/** The report's file name, written one level above the bundle (<root>/<KEY>/). */
export const SCAFFOLD_REPORT = SCAFFOLD_REPORT_FILE;
/** The scaffold command's exit codes that commit: done, and blocked. */
const EXIT_OK = SCAFFOLD_EXIT_OK;
const EXIT_BLOCKED = SCAFFOLD_EXIT_BLOCKED;
/** How much of a failed scaffolder's stderr the report carries: its tail. */
const STDERR_TAIL = 2048;
const CONFIG = BLUEPRINT_CONFIG_FILE;
// The fragment artifacts the report lists as topology: a worklist entry, owed as not-placed.
const TOPOLOGY = [ 'command', 'event', 'invariant' ];
const SHA = /^[0-9a-f]{40}$/;

const failed = ( error, detail, reason ) => ( { ok: false, ...( reason ? { reason } : {} ), result: JSON.stringify( { error, ...detail } ) } );
const done = ( result ) => ( { ok: true, result: JSON.stringify( result ) } );

// A repository-relative path that stays inside the repository, or undefined.
const insideRepo = ( value ) => {
  if ( typeof value !== 'string' || value === '' || value.includes( '\0' ) || isAbsolute( value ) ) return undefined;
  const normal = posix.normalize( value );
  return normal === '.' || normal.startsWith( '../' ) || normal === '..' || normal.split( '/' )[ 0 ] === '.git' ? undefined : normal;
};

const compare = ( a, b ) => ( a < b ? -1 : a > b ? 1 : 0 );
const byKey = ( items, ...keys ) => [ ...items ].sort( ( a, b ) => {
  for ( const key of keys ) { const order = compare( String( a[ key ] ), String( b[ key ] ) ); if ( order !== 0 ) return order; }
  return 0;
} );
// Keys sorted at every depth, two-space indent and a final newline.
const sortKeys = ( value ) => Array.isArray( value ) ? value.map( sortKeys )
  : value !== null && typeof value === 'object' ? Object.fromEntries( Object.keys( value ).sort().map( ( k ) => [ k, sortKeys( value[ k ] ) ] ) )
    : value;
const reportText = ( report ) => `${ JSON.stringify( sortKeys( report ), null, 2 ) }\n`;
/** The scaffold commit's message: its subject and the trailer naming the item. */
export const scaffoldMessage = ( key ) => `chore(${ key }): scaffold the agreed design\n\n${ SCAFFOLD_TRAILER }: ${ key }\n`;
const digest = async ( file ) => `sha256:${ createHash( 'sha256' ).update( await readFile( file ) ).digest( 'hex' ) }`;

// Removes `rel`'s now-empty parent directories, up to the repository root.
const pruneDirs = async ( dir, rel ) => {
  for ( let at = posix.dirname( rel ); at !== '.' && at !== ''; at = posix.dirname( at ) ) {
    const full = join( dir, at );
    try {
      if ( ( await readdir( full ) ).length > 0 ) return;
      await rmdir( full );
    } catch { return; }
  }
};

// The scaffolder's --json report, printed alone on stdout; a wrapper's banner before it is tolerated.
const parseReport = ( stdout ) => {
  const start = stdout.indexOf( '{' );
  const end = stdout.lastIndexOf( '}' );
  if ( start === -1 || end < start ) return undefined;
  try { return JSON.parse( stdout.slice( start, end + 1 ) ); } catch { return undefined; }
};

// A file's lines with their line endings, and whether one of them, its line ending stripped, is `code`.
const linesOf = ( text ) => text.split( /(?<=\n)/ ).filter( ( line ) => line !== '' );
const bare = ( line ) => line.replace( /\r?\n$/, '' );
const hasLine = async ( file, code ) => {
  try { return linesOf( await readFile( file, 'utf-8' ) ).some( ( line ) => bare( line ) === code ); } catch { return false; }
};

// Unappend: from its barrel, each line the prior report's appended[] recorded for a stale
// stub's node goes, unless this run's scaffolder appends the same line again; the stale entry lists what went as
// barrel[]. Answers the barrel files it rewrote.
const unappend = async ( dir, stale, appended, result ) => {
  const again = new Set( ( result.appends ?? [] ).map( ( a ) => `${ a?.file }\n${ a?.code }` ) );
  const rewritten = new Set();
  for ( const entry of stale ) {
    const removed = [];
    for ( const a of appended.filter( ( x ) => x.node === entry.node && !again.has( `${ x.file }\n${ x.code }` ) ) ) {
      const rel = insideRepo( a.file );
      let text;
      try { text = await readFile( join( dir, rel ), 'utf-8' ); } catch { continue; }
      const lines = linesOf( text );
      const kept = lines.filter( ( line ) => bare( line ) !== a.code );
      if ( kept.length === lines.length ) continue;
      await writeFile( join( dir, rel ), kept.join( '' ) );
      rewritten.add( rel );
      removed.push( { file: rel, code: a.code } );
    }
    if ( removed.length > 0 ) entry.barrel = byKey( removed, 'file', 'code' );
  }
  return [ ...rewritten ];
};

// The summary of a scaffold commit for `sha` already on origin at `tip` (its one parent is `sha` and its report's
// baseSha is `sha`), or undefined when `tip` is no such commit.
const scaffoldCommitOf = async ( git, dir, tip, sha, reportPath ) => {
  const parents = await git( dir, [ 'rev-list', '--parents', '-n', '1', tip ] );
  if ( parents.status !== 0 || parents.stdout.trim() !== `${ tip } ${ sha }` ) return undefined;
  const shown = await git( dir, [ 'cat-file', 'blob', `${ tip }:${ reportPath }` ] );
  if ( shown.status !== 0 ) return undefined;
  let report;
  try { report = JSON.parse( shown.stdout ); } catch { return undefined; }
  if ( report?.baseSha !== sha ) return undefined;
  const result = report.scaffolder ?? {};
  // The status the report states; a report without one (an older Steward's) is read back from the scaffolder's report it
  // carries: its --json output has no scenarios.decisions, so a scenario test with outcome `decision` (as classify reads
  // it) stands in for that half of EXIT_BLOCKED.
  const blocked = ( result.skipped ?? [] ).some( ( s ) => s?.reason === 'blocked' || s?.reason === 'error' )
    || ( result.scenarioTests ?? [] ).some( ( t ) => t?.outcome === 'decision' );
  const outcome = [ 'done', 'blocked', 'skipped' ].includes( report.status ) ? report.status : blocked ? 'blocked' : 'done';
  const changed = await gitOut( git, dir, [ 'diff-tree', '--no-commit-id', '-r', '--name-only', sha, tip ] );
  return {
    outcome, committed: true, commitSha: tip, resumed: true, report: reportPath,
    written: changed.split( '\n' ).filter( ( p ) => p !== '' && p !== reportPath && !( report.stale ?? [] ).some( ( s ) => s?.file === p ) ),
    deleted: ( report.stale ?? [] ).map( ( s ) => s.file ), edited: ( report.edited ?? [] ).map( ( e ) => e.file ),
    held: report.held ?? [], asked: report.asked ?? [], stillOwed: report.stillOwed ?? [], deferred: result.deferred ?? [],
  };
};

// Classify the scaffolder's --json report: a blocked unit whose every decision is no-template is still owed, any other
// is asked; a scenario test on a decision is asked; a topology fragment is owed not-placed and on the worklist, any
// other fragment owed as registration; a deferred unit is owed deferred.
const classify = ( result ) => {
  const asked = [];
  const owed = [];
  for ( const s of result.skipped ?? [] ) {
    if ( s?.reason !== 'blocked' && s?.reason !== 'error' ) continue;
    const decisions = Array.isArray( s.decisions ) ? s.decisions : [];
    if ( decisions.length > 0 && decisions.every( ( d ) => d?.code === 'no-template' ) ) owed.push( { node: s.node, reason: 'no-template', detail: s.detail } );
    else asked.push( { node: s.node, question: decisions.map( ( d ) => d?.question ?? '' ).join( '; ' ) || s.detail || 'blocked' } );
  }
  for ( const t of result.scenarioTests ?? [] ) {
    if ( t?.outcome === 'decision' ) asked.push( { node: t.scenarioId, question: 'scenario test placement needs a decision' } );
  }
  const isTopology = ( f ) => TOPOLOGY.includes( f?.artifact ) && !String( f?.file ?? '' ).startsWith( 'unplaced:' );
  const worklist = byKey( ( result.fragments ?? [] ).filter( isTopology ), 'node', 'file' );
  for ( const f of result.fragments ?? [] ) owed.push( { node: f?.node, reason: isTopology( f ) ? 'not-placed' : 'registration', detail: f?.file } );
  for ( const d of result.deferred ?? [] ) owed.push( { node: d?.node, reason: 'deferred', detail: ( d?.waitsOn ?? [] ).join( ', ' ) } );
  return { asked, owed: byKey( owed, 'node', 'reason' ), worklist };
};

/**
 * Runs one scaffold job in `dir` (the session's worktree) for `payload` { sha, key, design?, map? } on origin's
 * `branch`, and answers the outcome Steward reports: done with { outcome: done | blocked, committed, commitSha,
 * report, written, deleted, edited, held, asked, stillOwed, deferred }, done with { outcome: skipped, committed: true,
 * commitSha, report, detail } when no scaffold command is declared, or failed with { error, ... }. scaffold.json's
 * `status` is the outcome. When origin's tip is already
 * this sha's scaffold commit (a re-run after a push that landed unreported), done with { outcome, committed: true,
 * commitSha: that commit, resumed: true, ... } read back from the report it carries. `design` and `map` default
 * to the bundle's design.json and map.json at `sha`.
 * `extract( dir, command )` runs the declared extractor; `git( cwd, argv, { env, input } )` runs git.
 */
export const runScaffoldJob = async ( { dir, branch, payload = {}, git, extract } ) => {
  const { sha, key } = payload;
  if ( typeof branch !== 'string' || branch === '' ) return failed( 'payload-invalid', { detail: 'the scaffold job names no branch' } );
  if ( typeof sha !== 'string' || !SHA.test( sha ) ) return failed( 'payload-invalid', { detail: `the scaffold job's sha ${ JSON.stringify( sha ) } is not a commit id` } );
  if ( typeof key !== 'string' || !KEY_SEGMENT.test( key ) ) return failed( 'payload-invalid', { detail: `the ticket key ${ JSON.stringify( key ) } is not one plain path segment` } );

  // Origin's branch, which must still be at `sha`: the commit is made on it and pushed fast-forward only.
  const tracking = `refs/remotes/origin/${ branch }`;
  const fetched = await git( dir, [ 'fetch', '--quiet', 'origin', `+refs/heads/${ branch }:${ tracking }` ] );
  if ( fetched.status !== 0 ) {
    const now = await remoteTip( git, dir, branch );
    if ( now.missing ) return failed( 'branch-missing', { detail: `origin has no branch ${ branch }` }, 'branch-missing' );
    return failed( 'checkout-failed', { detail: `git fetch origin ${ branch } failed: ${ gitFailure( fetched ) }` }, 'checkout-failed' );
  }
  const tip = await gitOut( git, dir, [ 'rev-parse', '--verify', `${ tracking }^{commit}` ] );

  // The repository's declared command, or nothing runs.
  const shown = await git( dir, [ 'cat-file', 'blob', `${ sha }:${ CONFIG }` ] );
  let tooling;
  try { tooling = shown.status === 0 ? JSON.parse( shown.stdout )?.designTooling ?? {} : {}; } catch {
    return failed( 'config-invalid', { detail: `${ CONFIG } at ${ sha } is not JSON` }, 'config-invalid' );
  }
  const command = typeof tooling.scaffold === 'string' && tooling.scaffold.trim() !== '' ? tooling.scaffold : undefined;
  const at = await bundleDirAt( git, dir, sha, key );
  if ( at.error !== undefined ) return failed( 'config-invalid', { detail: at.error }, 'config-invalid' );
  const docsDir = posix.dirname( at.path );
  const reportPath = `${ docsDir }/${ SCAFFOLD_REPORT }`;
  if ( tip !== sha ) {
    // A re-run of a scaffold whose push landed before its report did finds its own commit as the tip, and is done.
    const resumed = await scaffoldCommitOf( git, dir, tip, sha, reportPath );
    if ( resumed !== undefined ) return done( resumed );
    return failed( 'non-ff', { detail: `origin's ${ branch } is at ${ tip }, not at the payload's sha ${ sha }; the scaffold commit is fast-forward only` }, 'non-ff' );
  }
  if ( command === undefined ) {
    const detail = `no designTooling.scaffold in ${ CONFIG } at ${ sha }`;
    const report = { version: 1, status: 'skipped', ticket: key, baseSha: sha, detail };
    const pushed = await commitReport( { git, dir, branch, sha, key, reportPath, report } );
    return pushed.failure ?? done( { outcome: 'skipped', committed: true, commitSha: pushed.commit, report: reportPath, detail } );
  }
  const designPath = insideRepo( payload.design ?? `${ at.path }/design.json` );
  const mapPath = insideRepo( payload.map ?? `${ at.path }/map.json` );
  if ( designPath === undefined || mapPath === undefined ) return failed( 'payload-invalid', { detail: 'the design or map path is not inside the repository' } );

  // The tree as `sha` has it, with no file a prior job left behind (ignored files, node_modules, stay).
  const moved = await git( dir, [ 'checkout', '--quiet', '--force', '--detach', sha ] );
  if ( moved.status !== 0 ) return failed( 'checkout-failed', { detail: `git checkout ${ sha } failed: ${ gitFailure( moved ) }` }, 'checkout-failed' );
  const cleaned = await git( dir, [ 'clean', '-fd' ] );
  if ( cleaned.status !== 0 ) return failed( 'checkout-failed', { detail: `git clean -fd failed: ${ gitFailure( cleaned ) }` }, 'checkout-failed' );
  const extractCommand = typeof tooling.extract === 'string' && tooling.extract.trim() !== '' ? tooling.extract : undefined;
  const extracted = async () => {
    if ( extractCommand === undefined ) return undefined;
    try { await extract( dir, extractCommand ); return undefined; } catch ( err ) { return failed( 'extract-failed', { detail: err.message } ); }
  };
  const firstExtract = await extracted();
  if ( firstExtract !== undefined ) return firstExtract;

  // The stubs of the prior scaffold commit. Untouched (blob-identical to the manifest) ones go, edited ones stay.
  const priorShown = await git( dir, [ 'cat-file', 'blob', `${ sha }:${ reportPath }` ] );
  let prior = null;
  if ( priorShown.status === 0 ) { try { prior = JSON.parse( priorShown.stdout ); } catch { prior = null; } }
  const deleted = [];
  const edited = [];
  const carried = [];
  for ( const entry of Array.isArray( prior?.manifest ) ? prior.manifest : [] ) {
    const rel = insideRepo( entry?.file );
    if ( rel === undefined ) continue;
    const hashed = await git( dir, [ 'hash-object', '--', rel ] );
    if ( hashed.status !== 0 ) continue;
    if ( hashed.stdout.trim() === entry.blob ) {
      await rm( join( dir, rel ), { force: true } );
      await pruneDirs( dir, rel );
      deleted.push( { file: rel, node: entry.node } );
    } else {
      edited.push( { file: rel, node: entry.node } );
      carried.push( entry );
    }
  }
  // The graph extracted above still counts the deleted stubs as code, and the scaffolder writes nothing for a node the
  // extracted graph already holds: extract again whenever any were deleted.
  if ( deleted.length > 0 ) {
    const again = await extracted();
    if ( again !== undefined ) return again;
  }

  // The declared command with the bundle's design and map, so agreed scenarios become it.todo tests.
  const ran = await runChild( 'sh', [ '-c', `${ command } "$@"`, 'sh', '--write', '--json', '--design', designPath, '--map', mapPath ], { cwd: dir } );
  if ( ran.status !== EXIT_OK && ran.status !== EXIT_BLOCKED ) {
    return failed( 'scaffold-failed', { exitCode: ran.status, timedOut: ran.timedOut === true, stderr: ( ran.stderr || ran.error?.message || '' ).slice( -STDERR_TAIL ) } );
  }
  const result = parseReport( ran.stdout );
  if ( result === undefined ) return failed( 'scaffold-output-invalid', { exitCode: ran.status, detail: 'the scaffold command printed no JSON report' } );

  // What the commit holds: files[].file and appends[].file, never a file under the bundle's <root>/<KEY>/ folder.
  const created = [];
  for ( const f of result.files ?? [] ) {
    const rel = insideRepo( f?.file );
    if ( rel === undefined ) return failed( 'scaffold-output-invalid', { detail: `the scaffold command reported the file ${ JSON.stringify( f?.file ) }, outside the repository` } );
    created.push( { file: rel, node: f.node } );
  }
  const createdPaths = new Set( created.map( ( c ) => c.file ) );
  const appendedNow = ( result.appends ?? [] ).filter( ( a ) => a?.kind === 'barrel' && !createdPaths.has( a.file ) );
  const stale = deleted.filter( ( d ) => !createdPaths.has( d.file ) );
  const priorAppended = ( Array.isArray( prior?.appended ) ? prior.appended : [] ).filter( ( a ) => a?.kind === 'barrel' && insideRepo( a.file ) !== undefined );
  const unappended = await unappend( dir, stale, priorAppended, result );
  // A barrel line the prior report recorded and this run neither removed nor appends again (the scaffolder reports a
  // line only where its barrel lacks it) is still the scaffold's: it stays recorded, so a later rename can remove it.
  const now = new Set( appendedNow.map( ( a ) => `${ a.file }\n${ a.code }` ) );
  const kept = [];
  for ( const a of priorAppended ) {
    if ( now.has( `${ a.file }\n${ a.code }` ) || !await hasLine( join( dir, a.file ), a.code ) ) continue;
    kept.push( a );
  }
  const appended = byKey( [ ...appendedNow, ...kept ], 'file', 'code' );
  const written = [ ...new Set( [ ...createdPaths, ...appendedNow.map( ( a ) => insideRepo( a.file ) ).filter( Boolean ), ...unappended ] ) ].sort();
  const ignored = written.filter( ( path ) => path.startsWith( `${ docsDir }/` ) );
  const committed = written.filter( ( path ) => !ignored.includes( path ) );

  const blobs = {};
  for ( const path of committed ) blobs[ path ] = await gitOut( git, dir, [ 'hash-object', '-w', '--', path ] );
  const { asked, owed, worklist } = classify( result );
  const outcome = ran.status === EXIT_BLOCKED ? 'blocked' : 'done';
  const report = {
    version: 1, status: outcome, mode: 'hosted-cli', ticket: key, baseSha: sha,
    inputs: { maps: [ { file: mapPath, digest: await digest( join( dir, mapPath ) ) } ], design: await digest( join( dir, designPath ) ), graph: await digest( join( dir, '.blueprint', 'graph.json' ) ).catch( () => null ) },
    created: byKey( created, 'file' ), appended,
    manifest: byKey( [ ...created.filter( ( c ) => blobs[ c.file ] !== undefined ).map( ( c ) => ( { file: c.file, node: c.node, blob: blobs[ c.file ] } ) ), ...carried ], 'file' ),
    worklist, placed: [], held: result.held ?? [], asked, stillOwed: owed, stale: byKey( stale, 'file' ), edited: byKey( edited, 'file' ),
    observe: null, typecheck: null,
    scenarioTests: result.scenarioTests ?? [], unplaced: result.unplaced ?? [], scenariosExcluded: result.scenariosExcluded ?? [],
    scaffolder: result,
  };

  // A temporary index from `sha`'s tree: the deleted stubs out, the written files in. Nothing else moves.
  const scratch = await mkdtemp( join( tmpdir(), 'blueprint-scaffold-' ) );
  let tree;
  try {
    const env = { GIT_INDEX_FILE: join( scratch, 'index' ) };
    await gitOut( git, dir, [ 'read-tree', `${ sha }^{tree}` ], { env } );
    for ( const d of stale ) await gitOut( git, dir, [ 'update-index', '--force-remove', '--', d.file ], { env } );
    for ( const path of committed ) await gitOut( git, dir, [ 'update-index', '--add', '--cacheinfo', `100644,${ blobs[ path ] },${ path }` ], { env } );
    const reportBlob = await gitOut( git, dir, [ 'hash-object', '-w', '--stdin' ], { input: reportText( report ) } );
    await gitOut( git, dir, [ 'update-index', '--add', '--cacheinfo', `100644,${ reportBlob },${ reportPath }` ], { env } );
    tree = await gitOut( git, dir, [ 'write-tree' ], { env } );
  } finally {
    await rm( scratch, { recursive: true, force: true } );
  }

  const summary = {
    outcome, report: reportPath, written: committed, deleted: stale.map( ( d ) => d.file ), edited: edited.map( ( e ) => e.file ),
    held: report.held, asked, stillOwed: owed, deferred: result.deferred ?? [], ...( ignored.length > 0 ? { ignored } : {} ),
  };
  // Always a commit, even one that changes only scaffold.json: the latest scaffold commit is the one in force.
  const pushed = await pushScaffold( { git, dir, branch, sha, key, tree } );
  return pushed.failure ?? done( { ...summary, committed: true, commitSha: pushed.commit } );
};

// The scaffold commit of `tree` on `sha`, pushed to origin's branch fast-forward only: { commit }, or { failure }.
const pushScaffold = async ( { git, dir, branch, sha, key, tree } ) => {
  const commit = await gitOut( git, dir, [ 'commit-tree', tree, '-p', sha, '-F', '-' ], { input: scaffoldMessage( key ) } );
  // Fast-forward only: the push names the commit and the branch, and is never forced.
  const pushed = await git( dir, [ 'push', '--quiet', 'origin', `${ commit }:refs/heads/${ branch }` ] );
  if ( pushed.status === 0 ) return { commit };
  const now = await remoteTip( git, dir, branch );
  // A push that landed and then exited non-zero (the connection dropped after the ref moved) is done.
  if ( now.tip === commit ) return { commit };
  if ( now.missing ) return { failure: failed( 'branch-missing', { detail: `origin's branch ${ branch } was deleted during the scaffold` }, 'branch-missing' ) };
  const reason = now.tip === sha ? 'push-rejected' : 'non-ff';
  return { failure: failed( reason, { detail: gitFailure( pushed ) }, reason ) };
};

// The scaffold commit of `sha`'s tree with `report` alone written at `reportPath`, pushed as pushScaffold does.
const commitReport = async ( { git, dir, branch, sha, key, reportPath, report } ) => {
  const scratch = await mkdtemp( join( tmpdir(), 'blueprint-scaffold-' ) );
  let tree;
  try {
    const env = { GIT_INDEX_FILE: join( scratch, 'index' ) };
    await gitOut( git, dir, [ 'read-tree', `${ sha }^{tree}` ], { env } );
    const reportBlob = await gitOut( git, dir, [ 'hash-object', '-w', '--stdin' ], { input: reportText( report ) } );
    await gitOut( git, dir, [ 'update-index', '--add', '--cacheinfo', `100644,${ reportBlob },${ reportPath }` ], { env } );
    tree = await gitOut( git, dir, [ 'write-tree' ], { env } );
  } finally {
    await rm( scratch, { recursive: true, force: true } );
  }
  return pushScaffold( { git, dir, branch, sha, key, tree } );
};
