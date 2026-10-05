// A pr-ready job takes the ticket branch's draft PR out of draft through
// Steward's own gh (BLUEPRINT_STEWARD_GH overrides the binary). GitHub only: on any other host, or for a branch with no
// open PR, the job is done and reports `skipped`, and gh is never asked to ready anything. Bitbucket readiness is a
// follow-up. The result is JSON: { branch, state: 'ready' | 'already-ready' | 'skipped', pr?, reason? }.
import { runQueued } from './child.mjs';
import { stewardEnv } from './env.mjs';
import { hostAdapter } from './merge-detect.mjs';

export const PR_READY_JOB_KIND = 'pr-ready';

const failure = ( result ) => ( result.stderr || result.error?.message || `exit ${ result.status }` ).trim();

/** Readies the open PR whose head is the job's branch (payload.branch, else the job's own branch). */
export const runPrReady = async ( job, { repo, remoteUrl, env = process.env } ) => {
  const branch = typeof job?.payload?.branch === 'string' && job.payload.branch !== '' ? job.payload.branch : job?.branch;
  if ( typeof branch !== 'string' || branch === '' ) return { ok: false, result: 'the pr-ready job carried no branch; Steward names none of its own' };
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
  if ( pr.isDraft !== true ) return done( { state: 'already-ready', pr: pr.url } );
  const readied = await runQueued( repo, gh, [ 'pr', 'ready', String( pr.number ) ], { cwd: repo } );
  if ( readied.status !== 0 ) return { ok: false, result: `gh pr ready ${ pr.number } failed: ${ failure( readied ) }` };
  console.error( `blueprint-steward: PR ${ pr.url } of ${ branch } is ready for review` );
  return done( { state: 'ready', pr: pr.url } );
};
