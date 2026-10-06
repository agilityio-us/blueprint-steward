// The merge poll reads one git trailer off the commits each
// listed branch gained since the tip it last saw and reports each value as read, with its commit's subject and body,
// giving it no meaning. The key comes with the branch list, per branch, as `signalTrailerKey`; a branch naming none
// reads the default.

import {
  AGENT_BRANCH_PREFIX, SIGNAL_DONE, SIGNAL_NEEDS_HUMAN, SIGNAL_TRAILER_KEY_DEFAULT, SIGNAL_TRAILER_KEY_PATTERN, STEWARD_SIGNALS_ROUTE,
} from '@bett3r-dev/blueprint-spec';

export { AGENT_BRANCH_PREFIX, SIGNAL_DONE, SIGNAL_NEEDS_HUMAN, SIGNAL_TRAILER_KEY_DEFAULT };
export const SIGNALS_ROUTE = STEWARD_SIGNALS_ROUTE;

/** The most of a commit's body a signal carries. */
export const SIGNAL_BODY_MAX = 8000;

// A key outside SIGNAL_TRAILER_KEY_PATTERN would rewrite the format it is spliced into (git's
// `%(trailers:key=<key>,...)` placeholder), so such a branch reads nothing.
const TRAILER_KEY = SIGNAL_TRAILER_KEY_PATTERN;

/** The trailer key a branch-list entry names, the default when it names none, or undefined for a key unsafe to read. */
export const trailerKeyOf = ( entry ) => {
  const key = entry?.signalTrailerKey;
  if ( key === undefined ) return SIGNAL_TRAILER_KEY_DEFAULT;
  return typeof key === 'string' && TRAILER_KEY.test( key ) ? key : undefined;
};

// Unit separator between a commit's fields and between its trailer values, record separator before its body; -z ends
// each commit with a NUL.
const FIELD = '\u001f';
const BODY = '\u001e';

/** The `git log` argv listing `range`'s commits oldest first: sha, subject, each value of trailer `key`, then the body. */
export const signalLogArgv = ( key, range ) => [
  'log', '-z', '--reverse', `--format=%H%x1f%s%x1f%(trailers:key=${ key },valueonly,separator=%x1f)%x1e%b`, ...range,
];

// A trailer line (`Token: value`) or the indented continuation of one.
const TRAILER_LINE = /^(?:[A-Za-z0-9][A-Za-z0-9-]*:\s|\s+\S)/;

/** A commit body without its trailer block (its last paragraph, when every line of it is a trailer), trimmed and bounded. */
export const bodyWithoutTrailers = ( raw ) => {
  const paragraphs = raw.replace( /\r\n/g, '\n' ).trim().split( /\n\s*\n/ );
  const last = paragraphs[ paragraphs.length - 1 ]?.split( '\n' ) ?? [];
  if ( last.length > 0 && last.every( ( line ) => TRAILER_LINE.test( line ) ) && /^[A-Za-z0-9]/.test( last[ 0 ] ) ) paragraphs.pop();
  return paragraphs.join( '\n\n' ).trim().slice( 0, SIGNAL_BODY_MAX );
};

/**
 * The signals in `signalLogArgv`'s output: one { sha, key, value, subject, body? } per non-empty trailer value, oldest
 * first; `body` is the commit's body without its trailers, absent when that is empty.
 */
export const parseSignals = ( stdout, key ) => stdout.split( '\u0000' ).filter( ( record ) => record.trim() !== '' ).flatMap( ( record ) => {
  const at = record.indexOf( BODY );
  const head = ( at === -1 ? record : record.slice( 0, at ) ).replace( /^\n/, '' );
  const body = at === -1 ? '' : bodyWithoutTrailers( record.slice( at + 1 ) );
  const [ sha, subject, ...values ] = head.split( FIELD );
  return values.map( ( value ) => value.trim() ).filter( ( value ) => value !== '' )
    .map( ( value ) => ( { sha, key, value, subject, ...( body === '' ? {} : { body } ) } ) );
} );

/** The latest of `signals` (oldest first): the state of the branch they were read from. */
export const latestSignal = ( signals ) => signals[ signals.length - 1 ];
