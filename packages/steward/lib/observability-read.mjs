// An observability-read job has Steward run the repository's declared read command, the `observability.read` string
// in .blueprint.config.json, for the hosted agent's KPI lookup. Steward holds no APM client and no credential of its
// own: the reader takes the team's from the environment it inherits (childEnv, so never the org key). Agent text
// reaches it only as a positional argument (`sh -c '<cmd> "$@"' sh <op> <arg>`), so the shell never parses it.
// Steward does not interpret the reader's output; it reports it as read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChild } from './child.mjs';

export const OBSERVABILITY_READ_JOB_KIND = 'observability-read';
/** The longest one read may take; past it the reader is killed and the read answered timed out. */
export const READ_TIMEOUT_MS = 30_000;
/** Reader stdout over this many bytes is reported too-large, never passed on. */
export const READ_STDOUT_MAX_BYTES = 256 * 1024;
/** The longest search text or ref Steward hands a reader, in characters. */
export const READ_ARGUMENT_MAX = 512;
/** How much of a failed reader's stderr the report carries: its tail. */
export const READ_STDERR_TAIL = 2048;

const ARGUMENT_OF = { search: 'text', resolve: 'ref' };

const refused = ( detail ) => ( { ok: false, result: JSON.stringify( { status: 'refused', detail } ) } );
const answered = ( result ) => ( { ok: true, result: JSON.stringify( result ) } );

/** The `observability.read` string `dir`'s .blueprint.config.json declares, or undefined for none (or no readable file). */
const declaredReader = ( dir ) => {
  try {
    const read = JSON.parse( readFileSync( join( dir, '.blueprint.config.json' ), 'utf-8' ) )?.observability?.read;
    return typeof read === 'string' && read.trim() !== '' ? read : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Runs one read in `dir` (the session's worktree, else the --repo checkout). The job is done whenever the reader was
 * asked or found undeclared, its result one of: { status: 'ok', stdout }, { status: 'too-large', bytes },
 * { status: 'unreachable', exitCode, timedOut, stderr } (stderr's last 2 kB), { status: 'not-declared' }. A payload
 * that is not { op: search, text } or { op: resolve, ref } of at most 512 characters fails { status: 'refused', detail }
 * and runs nothing.
 */
export const runObservabilityRead = async ( job, { dir, timeoutMs = READ_TIMEOUT_MS } ) => {
  const payload = job.payload ?? {};
  if ( typeof payload.op !== 'string' || !Object.hasOwn( ARGUMENT_OF, payload.op ) ) return refused( `op must be search or resolve, not ${ JSON.stringify( payload.op ) }` );
  const name = ARGUMENT_OF[ payload.op ];
  const argument = payload[ name ];
  if ( typeof argument !== 'string' || argument === '' ) return refused( `a ${ payload.op } read needs a non-empty ${ name }` );
  if ( argument.length > READ_ARGUMENT_MAX ) return refused( `the ${ name } is ${ argument.length } characters, over ${ READ_ARGUMENT_MAX }` );
  const command = declaredReader( dir );
  if ( command === undefined ) return answered( { status: 'not-declared' } );
  const run = await runChild( 'sh', [ '-c', `${ command } "$@"`, 'sh', payload.op, argument ], { cwd: dir, timeoutMs } );
  if ( run.status === 0 ) {
    const bytes = Buffer.byteLength( run.stdout );
    return answered( bytes > READ_STDOUT_MAX_BYTES ? { status: 'too-large', bytes } : { status: 'ok', stdout: run.stdout } );
  }
  const stderr = run.stderr || run.error?.message || '';
  return answered( { status: 'unreachable', exitCode: run.status, timedOut: run.timedOut === true, stderr: stderr.slice( -READ_STDERR_TAIL ) } );
};
