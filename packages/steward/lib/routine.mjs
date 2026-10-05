// Steward fires a Claude routine for the server. An
// implementation-dispatch job carries { alias, text }; Steward reads the alias's
// routine from its own environment, BLUEPRINT_ROUTINE_<ALIAS>_URL (the routine's /fire endpoint) and
// BLUEPRINT_ROUTINE_<ALIAS>_TOKEN (its per-routine bearer token), POSTs { text }, and reports what the routine answered.
// The URL and token never leave Steward: its claim names the aliases it holds, and no report or log carries either.

export const IMPLEMENTATION_DISPATCH_JOB_KIND = 'implementation-dispatch';

/** The prefix of every routine variable; childEnv (lib/child.mjs) strips each one from every child. */
export const ROUTINE_ENV_PREFIX = 'BLUEPRINT_ROUTINE_';

// The routine API's beta header (code.claude.com/docs/en/routines), versioned with Steward: a new header value is a
// new STEWARD_VERSION.
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';

const ROUTINE_VAR = new RegExp( `^${ ROUTINE_ENV_PREFIX }([A-Z0-9_]+)_(URL|TOKEN)$` );
const present = ( value ) => typeof value === 'string' && value.trim() !== '';

/**
 * The aliases `env` holds a whole routine for (both _URL and _TOKEN set), lowercased, sorted: BLUEPRINT_ROUTINE_TEAM_A_*
 * is the alias `team_a`. A pair missing either half is not held.
 */
export const routineAliases = ( env = process.env ) => {
  const parts = new Map();
  for ( const [ name, value ] of Object.entries( env ) ) {
    const match = ROUTINE_VAR.exec( name );
    if ( match === null || !present( value ) ) continue;
    parts.set( match[ 1 ], { ...parts.get( match[ 1 ] ), [ match[ 2 ] ]: value } );
  }
  return [ ...parts ].filter( ( [ , pair ] ) => pair.URL !== undefined && pair.TOKEN !== undefined ).map( ( [ alias ] ) => alias.toLowerCase() ).sort();
};

/**
 * Fires the job's alias's routine with the job's text: done with the routine's claude_code_session_url, or failed with
 * the status and body the routine answered. A job naming no alias or no text, or an alias Steward holds no routine
 * for, is failed before any request.
 */
export const runImplementationDispatch = async ( job, env = process.env ) => {
  const alias = job?.payload?.alias;
  const text = job?.payload?.text;
  if ( typeof alias !== 'string' || !/^[A-Za-z0-9_]+$/.test( alias ) || typeof text !== 'string' || text === '' ) {
    return { ok: false, result: 'the implementation-dispatch job carried no alias or no text; Steward composes none of its own' };
  }
  const key = alias.toUpperCase();
  const url = env[ `${ ROUTINE_ENV_PREFIX }${ key }_URL` ];
  const token = env[ `${ ROUTINE_ENV_PREFIX }${ key }_TOKEN` ];
  if ( !present( url ) || !present( token ) ) {
    return { ok: false, result: JSON.stringify( { alias, error: `this Steward holds no routine for alias ${ alias } (${ ROUTINE_ENV_PREFIX }${ key }_URL and _TOKEN)` } ) };
  }
  let response;
  try {
    response = await fetch( url, {
      method: 'POST',
      headers: { authorization: `Bearer ${ token }`, 'anthropic-beta': ROUTINE_BETA, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify( { text } ),
    } );
  } catch ( err ) {
    // Only the failure's code is reported: fetch's message for an unparsable URL quotes the URL.
    return { ok: false, result: JSON.stringify( { alias, error: `the routine for alias ${ alias } could not be reached (${ err.cause?.code ?? err.name })` } ) };
  }
  const body = await response.text();
  if ( !response.ok ) return { ok: false, result: JSON.stringify( { alias, status: response.status, body } ) };
  let fired;
  try {
    fired = JSON.parse( body );
  } catch {
    fired = undefined;
  }
  if ( typeof fired?.claude_code_session_url !== 'string' ) {
    return { ok: false, result: JSON.stringify( { alias, status: response.status, body, error: 'the routine answered no claude_code_session_url' } ) };
  }
  return { ok: true, result: JSON.stringify( { alias, claude_code_session_url: fired.claude_code_session_url } ) };
};

/**
 * The dispatch entry (kind, handler) bin/blueprint-steward.mjs spreads into its JOB_HANDLERS. Holding no
 * routine, Steward gives none, so its claim never declares the kind.
 */
export const routineJobHandlers = ( env = process.env ) =>
  ( routineAliases( env ).length === 0 ? [] : [ [ IMPLEMENTATION_DISPATCH_JOB_KIND, ( job ) => runImplementationDispatch( job, env ) ] ] );
