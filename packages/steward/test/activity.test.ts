import { describe, expect, it } from 'vitest';
import { ACTIVITY_BATCH_MAX } from '@bett3r-dev/blueprint-spec';
import { activityOf, createActivityRelay, lineSplitter, logLinesOf } from '../lib/activity.mjs';

const AT = '2026-10-05T04:49:56.310Z';
const assistant = ( ...content: unknown[] ) => JSON.stringify( { type: 'assistant', message: { content } } );

describe( 'activity', () => {
  it( 'a line yields its tool names and that claude wrote text, never inputs, text or thinking', () => {
    const line = assistant(
      { type: 'thinking', thinking: 'secret' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/repo/secret.ts' } },
      { type: 'text', text: 'here is the code' },
      { type: 'text', text: '   ' },
    );
    expect( activityOf( line, AT ) ).toEqual( [ { at: AT, kind: 'tool', name: 'Read' }, { at: AT, kind: 'text' } ] );
    expect( activityOf( JSON.stringify( { type: 'user', message: { content: [ { type: 'tool_result', content: 'x' } ] } } ), AT ) ).toEqual( [] );
    expect( activityOf( 'not json', AT ) ).toEqual( [] );
  } );

  it( 'logs one tagged line per event and nothing for thinking or token counts', () => {
    expect( logLinesOf( assistant( { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } } ), '[j]' ) ).toEqual( [ '[j] → Grep pattern=foo' ] );
    expect( logLinesOf( assistant( { type: 'thinking', thinking: '', signature: 'abc' } ), '[j]' ) ).toEqual( [] );
    expect( logLinesOf( JSON.stringify( { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 } ), '[j]' ) ).toEqual( [] );
    expect( logLinesOf( JSON.stringify( { type: 'user', message: { content: [ { type: 'tool_result', is_error: true, content: [ { type: 'text', text: 'boom' } ] } ] } } ), '[j]' ) )
      .toEqual( [ '[j] ← error · 4 chars' ] );
    expect( logLinesOf( 'plain output', '[j]' ) ).toEqual( [ '[j] plain output' ] );
    expect( logLinesOf( assistant( { type: 'text', text: 'x'.repeat( 400 ) } ), '[j]' )[ 0 ] ).toHaveLength( '[j] ✎ '.length + 160 );
  } );

  it( 'splits a stream into complete lines and keeps the unterminated tail', () => {
    const lines = lineSplitter();
    expect( lines.push( 'a\nb' ) ).toEqual( [ 'a' ] );
    expect( lines.push( 'c\nd\n' ) ).toEqual( [ 'bc', 'd' ] );
    expect( lines.push( 'e' ) ).toEqual( [] );
    expect( lines.rest() ).toEqual( [ 'e' ] );
  } );

  it( 'the relay batches entries on a timer, posts the rest on close, and stops on a 404', async () => {
    const posted: unknown[][] = [];
    const timers: ( () => void )[] = [];
    const relay = createActivityRelay( {
      post: async ( entries: unknown[] ) => { posted.push( entries ); },
      setTimer: ( run: () => void ) => { timers.push( run ); return timers.length; },
      clearTimer: () => undefined,
    } );
    relay.push( { at: AT, kind: 'tool', name: 'Read' } );
    relay.push( { at: AT, kind: 'text' } );
    expect( timers ).toHaveLength( 1 );
    timers[ 0 ]();
    await relay.close();
    expect( posted ).toEqual( [ [ { at: AT, kind: 'tool', name: 'Read' }, { at: AT, kind: 'text' } ] ] );

    const refused: unknown[][] = [];
    const gone = createActivityRelay( {
      post: async ( entries: unknown[] ) => { refused.push( entries ); throw Object.assign( new Error( 'gone' ), { status: 404 } ); },
      setTimer: () => 0, clearTimer: () => undefined,
    } );
    gone.push( { at: AT, kind: 'text' } );
    await gone.close();
    gone.push( { at: AT, kind: 'text' } );
    await gone.close();
    expect( refused ).toHaveLength( 1 );
  } );
} );
