// A pr-ready job takes the ticket branch's draft PR out of draft through
// Steward's own gh (BLUEPRINT_STEWARD_GH overrides the binary), first setting its body to the item's pull-request.md
// when the branch's tip commits one (payload.key names the item; <docsRoot>/<KEY>/pull-request.md, the docs root as
// lib/flush.mjs reads it). GitHub only: on any other host, or for a branch with no open PR, the job is done and reports
// `skipped`, and gh is never asked to edit or ready anything. Bitbucket readiness is a follow-up. The result is JSON:
// { branch, state: 'ready' | 'already-ready' | 'skipped', pr?, body?: 'set' | 'absent', reason? }.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { itemDocsPathOf, PULL_REQUEST_FILE } from '@bett3r-dev/blueprint-spec';
import { runQueued } from './child.mjs';
import { stewardEnv } from './env.mjs';
import { docsRootAt, KEY_SEGMENT } from './flush.mjs';
import { hostAdapter } from './merge-detect.mjs';

export const PR_READY_JOB_KIND = 'pr-ready';

const failure = ( result ) => ( result.stderr || result.error?.message || `exit ${ result.status }` ).trim();

// The item's pull-request.md at origin's tip of `branch`, fetched now: { text }, {} when the tip holds none, or { error }.
const pullRequestBodyOf = async ( repo, branch, key ) => {
  const git = ( cwd, argv ) => runQueued( repo, 'git', argv, { cwd } );
  const tracking = `refs/remotes/origin/${ branch }`;
  const fetched = await git( repo, [ 'fetch', '--quiet', 'origin', `+refs/heads/${ branch }:${ tracking }` ] );
  if ( fetched.status !== 0 ) return { error: `git fetch origin ${ branch } failed: ${ failure( fetched ) }` };
  const at = await docsRootAt( git, repo, tracking );
  if ( at.error !== undefined ) return { error: at.error };
  const shown = await git( repo, [ 'cat-file', 'blob', `${ tracking }:${ itemDocsPathOf( at.root, key, PULL_REQUEST_FILE ) }` ] );
  return shown.status === 0 && shown.stdout.trim() !== '' ? { text: shown.stdout } : {};
};

/** Sets the open PR's body from the item's pull-request.md, then readies it; the PR is the one whose head is the job's branch. */
export const runPrReady = async ( job, { repo, remoteUrl, env = process.env } ) => {
  const branch = typeof job?.payload?.branch === 'string' && job.payload.branch !== '' ? job.payload.branch : job?.branch;
  if ( typeof branch !== 'string' || branch === '' ) return { ok: false, result: 'the pr-ready job carried no branch; Steward names none of its own' };
  const key = typeof job?.payload?.key === 'string' && KEY_SEGMENT.test( job.payload.key ) ? job.payload.key : undefined;
  const done = ( report ) => ( { ok: true, result: JSON.stringify( { branch, ...report } ) } );
  const host = hostAdapter( { repo, remoteUrl, env } ).adapter?.name;
  if ( host !== 'github' ) return done( { state: 'skipped', reason: `pr-ready is GitHub only; ${ host ?? 'this repository\'s host' } is not` } );
  const gh = stewardEnv( 'GH', env ) ?? 'gh';
  const listed = await runQueued( repo, gh, [ 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isDraft,url,headRefName' ], { cwd: repo } );
  if ( listed.status !== 0 ) return { ok: false, result: `gh pr list for ${ branch } failed: ${ failure( listed ) }` };
  let prs;
  try { prs = JSON.parse( listed.stdout || '[]' ); } catch { return { ok: false, result: `gh pr list for ${ branch } printed no JSON` }; }
  const pr = ( Array.isArray( prs ) ? prs : [] ).find( ( p ) => p?.headRefName === branch );
  if ( pr === undefined ) return done( { state: 'skipped', reason: `no open PR has head ${ branch }` } );
  let body;
  if ( key !== undefined ) {
    const read = await pullRequestBodyOf( repo, branch, key );
    if ( read.error !== undefined ) return { ok: false, result: `the pull request body of ${ branch } could not be read: ${ read.error }` };
    body = 'absent';
    if ( read.text !== undefined ) {
      const scratch = await mkdtemp( join( tmpdir(), 'blueprint-pr-body-' ) );
      try {
        const file = join( scratch, PULL_REQUEST_FILE );
        await writeFile( file, read.text );
        const edited = await runQueued( repo, gh, [ 'pr', 'edit', String( pr.number ), '--body-file', file ], { cwd: repo } );
        if ( edited.status !== 0 ) return { ok: false, result: `gh pr edit ${ pr.number } failed: ${ failure( edited ) }` };
      } finally {
        await rm( scratch, { recursive: true, force: true } );
      }
      body = 'set';
    }
  }
  const described = body === undefined ? {} : { body };
  if ( pr.isDraft !== true ) return done( { state: 'already-ready', pr: pr.url, ...described } );
  const readied = await runQueued( repo, gh, [ 'pr', 'ready', String( pr.number ) ], { cwd: repo } );
  if ( readied.status !== 0 ) return { ok: false, result: `gh pr ready ${ pr.number } failed: ${ failure( readied ) }` };
  console.error( `blueprint-steward: PR ${ pr.url } of ${ branch } is ready for review` );
  return done( { state: 'ready', pr: pr.url, ...described } );
};
