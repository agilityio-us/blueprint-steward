// The merge poll reads one git trailer off the commits each
// listed branch gained since the tip it last saw and reports each value as read, giving it no meaning. The
// key comes with the branch list, per branch, as `signalTrailerKey`; a branch naming none reads the default.

import {
  AGENT_BRANCH_PREFIX, RUNNER_SIGNALS_ROUTE, SIGNAL_DONE, SIGNAL_NEEDS_HUMAN, SIGNAL_TRAILER_KEY_DEFAULT, SIGNAL_TRAILER_KEY_PATTERN,
} from '@bett3r-dev/blueprint-spec';

export { AGENT_BRANCH_PREFIX, SIGNAL_DONE, SIGNAL_NEEDS_HUMAN, SIGNAL_TRAILER_KEY_DEFAULT };
export const SIGNALS_ROUTE = RUNNER_SIGNALS_ROUTE;


// A key outside SIGNAL_TRAILER_KEY_PATTERN would rewrite the format it is spliced into (git's
// `%(trailers:key=<key>,...)` placeholder), so such a branch reads nothing.
const TRAILER_KEY = SIGNAL_TRAILER_KEY_PATTERN;

/** The trailer key a branch-list entry names, the default when it names none, or undefined for a key unsafe to read. */
export const trailerKeyOf = ( entry ) => {
  const key = entry?.signalTrailerKey;
  if ( key === undefined ) return SIGNAL_TRAILER_KEY_DEFAULT;
  return typeof key === 'string' && TRAILER_KEY.test( key ) ? key : undefined;
};

// Unit separator between a commit's fields and between its trailer values; -z ends each commit with a NUL.
const FIELD = '\u001f';

/** The `git log` argv listing `range`'s commits oldest first: sha, subject, then each value of trailer `key`. */
export const signalLogArgv = ( key, range ) => [
  'log', '-z', '--reverse', `--format=%H%x1f%s%x1f%(trailers:key=${ key },valueonly,separator=%x1f)`, ...range,
];

/** The signals in `signalLogArgv`'s output: one { sha, key, value, subject } per non-empty trailer value, oldest first. */
export const parseSignals = ( stdout, key ) => stdout.split( '\u0000' ).filter( ( record ) => record.trim() !== '' ).flatMap( ( record ) => {
  const [ sha, subject, ...values ] = record.replace( /^\n/, '' ).split( FIELD );
  return values.map( ( value ) => value.trim() ).filter( ( value ) => value !== '' ).map( ( value ) => ( { sha, key, value, subject } ) );
} );
