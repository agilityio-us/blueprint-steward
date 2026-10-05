// A design job's agent, made legible. claude's --output-format stream-json is one JSON event per line; Steward
// reads each line twice: once into a one-line log entry for the operator, once into the activity entries the board
// shows. An activity entry names a tool, a step or that claude wrote text, never a tool's input or result, and never the
// text itself: the team's code never leaves its environment.

import { ACTIVITY_BATCH_MAX } from '@bett3r-dev/blueprint-spec';

/** How often the relay posts what it has gathered; one post carries at most ACTIVITY_BATCH_MAX entries. */
export const ACTIVITY_FLUSH_MS = 2000;

const eventOf = ( line ) => {
  try { return JSON.parse( line ); } catch { return undefined; }
};

const contentOf = ( event ) => ( Array.isArray( event?.message?.content ) ? event.message.content : [] );

/** The activity entries one stream-json line yields, stamped `at`: a tool call, or that claude wrote text. */
export const activityOf = ( line, at = new Date().toISOString() ) => {
  const event = eventOf( line );
  if ( event?.type !== 'assistant' ) return [];
  return contentOf( event ).flatMap( ( item ) => {
    if ( item?.type === 'tool_use' && typeof item.name === 'string' && item.name !== '' ) return [ { at, kind: 'tool', name: item.name } ];
    if ( item?.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '' ) return [ { at, kind: 'text' } ];
    return [];
  } );
};

const clip = ( text, max ) => {
  const flat = text.replace( /\s+/g, ' ' ).trim();
  return flat.length > max ? `${ flat.slice( 0, max - 1 ) }…` : flat;
};

const argsOf = ( input ) => {
  if ( typeof input !== 'object' || input === null ) return '';
  return clip( Object.entries( input ).map( ( [ key, value ] ) => `${ key }=${ typeof value === 'string' ? value : JSON.stringify( value ) }` ).join( ' ' ), 100 );
};

const resultSizeOf = ( content ) => {
  if ( typeof content === 'string' ) return content.length;
  if ( Array.isArray( content ) ) return content.reduce( ( sum, part ) => sum + ( typeof part?.text === 'string' ? part.text.length : 0 ), 0 );
  return 0;
};

/**
 * The operator's log lines for one stream-json line, each prefixed `tag`: the init, a tool call with its arguments
 * clipped, a tool result's size, claude's text clipped, and the final result. Thinking, hook and token-count events log
 * nothing; a line that is not JSON is logged as it came.
 */
export const logLinesOf = ( line, tag ) => {
  if ( line.trim() === '' ) return [];
  const event = eventOf( line );
  if ( event === undefined ) return [ `${ tag } ${ clip( line, 200 ) }` ];
  if ( event.type === 'system' && event.subtype === 'init' )
    return [ `${ tag } ▶ claude ${ event.claude_code_version ?? '' } · ${ event.model ?? 'default model' } · ${ Array.isArray( event.tools ) ? event.tools.length : 0 } tools`.replace( /\s+·/, ' ·' ) ];
  if ( event.type === 'assistant' ) {
    return contentOf( event ).flatMap( ( item ) => {
      if ( item?.type === 'tool_use' ) return [ `${ tag } → ${ item.name } ${ argsOf( item.input ) }`.trimEnd() ];
      if ( item?.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '' ) return [ `${ tag } ✎ ${ clip( item.text, 160 ) }` ];
      return [];
    } );
  }
  if ( event.type === 'user' ) {
    return contentOf( event ).flatMap( ( item ) => item?.type === 'tool_result'
      ? [ `${ tag } ← ${ item.is_error === true ? 'error' : 'ok' } · ${ resultSizeOf( item.content ) } chars` ]
      : [] );
  }
  if ( event.type === 'result' ) {
    const seconds = typeof event.duration_ms === 'number' ? ` · ${ Math.round( event.duration_ms / 1000 ) }s` : '';
    const turns = typeof event.num_turns === 'number' ? ` · ${ event.num_turns } turns` : '';
    const cost = typeof event.total_cost_usd === 'number' ? ` · $${ event.total_cost_usd.toFixed( 2 ) }` : '';
    return [ `${ tag } ■ ${ event.subtype ?? 'result' }${ seconds }${ turns }${ cost }` ];
  }
  return [];
};

/**
 * Splits a stream into complete lines: `push(chunk)` answers the lines the chunk completed, `rest()` the unterminated
 * tail (claude's last line may come without its newline).
 */
export const lineSplitter = () => {
  let pending = '';
  return {
    push: ( chunk ) => {
      pending += chunk;
      const lines = pending.split( '\n' );
      pending = lines.pop();
      return lines;
    },
    rest: () => {
      const tail = pending;
      pending = '';
      return tail === '' ? [] : [ tail ];
    },
  };
};

/**
 * Gathers a job's activity entries and posts them in batches every `intervalMs`. `post(entries)` sends one batch; a
 * post refused 404 (the host no longer holds the job, or predates the route) stops the relay, and any other failure
 * is passed to `onError` and the batch dropped: activity is ephemeral and never holds the job up. `close()` posts what
 * is left and stops.
 */
export const createActivityRelay = ( { post, onError = () => undefined, intervalMs = ACTIVITY_FLUSH_MS, setTimer = setTimeout, clearTimer = clearTimeout } ) => {
  let queue = [];
  let timer;
  let stopped = false;
  let sending = Promise.resolve();
  const send = () => {
    timer = undefined;
    if ( stopped || queue.length === 0 ) return sending;
    const batch = queue.slice( -ACTIVITY_BATCH_MAX );
    queue = [];
    sending = sending.then( () => post( batch ) ).catch( ( err ) => {
      if ( err?.status === 404 ) stopped = true;
      else onError( err );
    } );
    return sending;
  };
  return {
    push: ( ...entries ) => {
      if ( stopped || entries.length === 0 ) return;
      queue.push( ...entries );
      if ( timer === undefined ) timer = setTimer( send, intervalMs );
    },
    close: async () => {
      if ( timer !== undefined ) clearTimer( timer );
      await send();
      stopped = true;
    },
  };
};
