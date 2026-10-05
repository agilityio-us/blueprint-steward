// Steward's own environment variables were named BLUEPRINT_RUNNER_* before Steward had its name. This is the one place
// an old name is still read: when BLUEPRINT_STEWARD_<NAME> is unset, BLUEPRINT_RUNNER_<NAME> stands in for it, and
// Steward says so once per name on stderr. Every other BLUEPRINT_* variable kept its name.

export const STEWARD_ENV_PREFIX = 'BLUEPRINT_STEWARD_';
export const LEGACY_ENV_PREFIX = 'BLUEPRINT_RUNNER_';

/** The names that moved: TOKEN (the org key), CLAUDE and GH (binaries), and REF, WORK and IMAGE (the image's). */
export const STEWARD_ENV_NAMES = Object.freeze( [ 'TOKEN', 'CLAUDE', 'GH', 'REF', 'WORK', 'IMAGE' ] );

/** The org key's variable under both names; a child process never inherits either. */
export const TOKEN_VARS = Object.freeze( [ `${ STEWARD_ENV_PREFIX }TOKEN`, `${ LEGACY_ENV_PREFIX }TOKEN` ] );

const set = ( value ) => typeof value === 'string' && value !== '';
const warned = new Set();
const deprecation = ( name ) => {
  if ( warned.has( name ) ) return;
  warned.add( name );
  console.error( `blueprint-steward: ${ LEGACY_ENV_PREFIX }${ name } is deprecated; set ${ STEWARD_ENV_PREFIX }${ name } instead` );
};

/** The value of BLUEPRINT_STEWARD_<name>, else of its old name BLUEPRINT_RUNNER_<name> (with a deprecation line), else undefined. */
export const stewardEnv = ( name, env = process.env ) => {
  if ( !STEWARD_ENV_NAMES.includes( name ) ) throw new Error( `${ STEWARD_ENV_PREFIX }${ name } is not one of Steward's variables` );
  if ( set( env[ `${ STEWARD_ENV_PREFIX }${ name }` ] ) ) return env[ `${ STEWARD_ENV_PREFIX }${ name }` ];
  if ( set( env[ `${ LEGACY_ENV_PREFIX }${ name }` ] ) ) {
    deprecation( name );
    return env[ `${ LEGACY_ENV_PREFIX }${ name }` ];
  }
  return undefined;
};
