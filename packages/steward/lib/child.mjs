// The one place Steward starts a child process. Every child gets childEnv (no org key),
// every git / gh call is async (the event loop keeps beating), serialised per repository, and bounded by a timeout.
import { spawn } from 'node:child_process';
import { TOKEN_VARS } from './env.mjs';
import { ROUTINE_ENV_PREFIX } from './routine.mjs';

/** Environment variables that hold a secret of Steward's own: the org key, and the Jira API token. */
export const STEWARD_SECRET_VARS = [ ...TOKEN_VARS, 'BLUEPRINT_JIRA_API_TOKEN' ];
// Every variable under BLUEPRINT_ROUTINE_ is a routine's URL or token (lib/routine.mjs), held for Steward
// alone: dropped by prefix, so no alias's routine reaches a child whatever its name.
const STEWARD_SECRET_PREFIXES = [ ROUTINE_ENV_PREFIX ];
const secretName = ( name ) => STEWARD_SECRET_VARS.includes( name ) || STEWARD_SECRET_PREFIXES.some( ( prefix ) => name.startsWith( prefix ) );

// Secrets Steward holds by value (the --token value); a variable carrying exactly one is dropped whatever its name.
const held = new Set();
export const holdSecret = ( value ) => { if ( typeof value === 'string' && value !== '' ) held.add( value ); };

/**
 * The environment a child gets: a deny-list, never an allow-list (the team's own tools need variables Steward
 * cannot enumerate). Drops every STEWARD_SECRET_VARS name, every BLUEPRINT_ROUTINE_* name, and every variable whose
 * value exactly equals a held secret.
 */
export const childEnv = ( env = process.env, extra = {} ) => {
  const secrets = new Set( [ ...held, ...STEWARD_SECRET_VARS.map( ( name ) => env[ name ] ).filter( ( v ) => typeof v === 'string' && v !== '' ) ] );
  const kept = Object.entries( env ).filter( ( [ name, value ] ) => !secretName( name ) && !secrets.has( value ) );
  return { ...Object.fromEntries( kept ), ...extra };
};

/** A long-lived child (claude, the extractor): spawned with childEnv. */
export const spawnChild = ( file, argv, options = {} ) => spawn( file, argv, { ...options, env: childEnv( options.env ?? process.env ) } );

// One promise chain per key: work runs one after another, and a failure does not stop the next.
const tails = new Map();
export const serialised = ( key, work ) => {
  const run = ( tails.get( key ) ?? Promise.resolve() ).then( work );
  const tail = run.catch( () => undefined ).finally( () => { if ( tails.get( key ) === tail ) tails.delete( key ); } );
  tails.set( key, tail );
  return run;
};

let timeoutMs = 600_000;
export const setChildTimeout = ( seconds ) => { timeoutMs = seconds * 1000; };

/**
 * Runs a short child to its exit without blocking the loop: { status, stdout, stderr, error, timedOut }. `timeoutMs`
 * bounds this one call (an observability read's 30 s); without it the call takes Steward's --git-timeout.
 */
export const runChild = ( file, argv, { cwd, input, env, extraEnv, timeoutMs: callTimeoutMs } = {} ) => new Promise( ( resolvePromise ) => {
  const boundMs = callTimeoutMs ?? timeoutMs;
  let settled = false;
  const settle = ( result ) => { if ( !settled ) { settled = true; clearTimeout( timer ); resolvePromise( result ); } };
  let stdout = '';
  let stderr = '';
  const child = spawn( file, argv, { cwd, env: childEnv( env ?? process.env, { GIT_TERMINAL_PROMPT: '0', ...extraEnv } ), stdio: [ 'pipe', 'pipe', 'pipe' ] } );
  const timer = setTimeout( () => {
    child.kill( 'SIGKILL' );
    settle( { status: null, stdout, stderr: `${ stderr }timed out after ${ boundMs / 1000 }s`.trim(), timedOut: true } );
  }, boundMs );
  child.stdout.on( 'data', ( c ) => { stdout += c; } );
  child.stderr.on( 'data', ( c ) => { stderr += c; } );
  child.stdin.on( 'error', () => undefined );
  child.on( 'error', ( error ) => settle( { status: null, stdout, stderr, error } ) );
  child.on( 'close', ( status ) => settle( { status, stdout, stderr } ) );
  child.stdin.end( input );
} );

/** A git / gh call, queued behind the repository's other calls. `repoKey` names the repository. */
export const runQueued = ( repoKey, file, argv, options ) => serialised( `repo:${ repoKey }`, () => runChild( file, argv, options ) );
