import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FALLBACK_DESCRIPTIONS, FALLBACK_INSTRUCTIONS, FALLBACK_NOTES } from '../src/tool-text.js';

/**
 * The model-facing text of the design tools is served (TOOL_TEXT_ROUTE); what ships here is terse. Every fallback is
 * short, and no zod field in the packages' source carries a description longer than a short type hint.
 */
const FALLBACK_LIMIT = 120;
const FIELD_LIMIT = 64;

const PACKAGES = fileURLToPath( new URL( '../../..', import.meta.url ));
const SKIPPED = new Set( [ 'node_modules', 'dist', 'test' ] );

const sourcesUnder = ( dir: string ): string[] => readdirSync( dir, { withFileTypes: true }).flatMap( entry => {
  if ( SKIPPED.has( entry.name )) return [];
  const path = join( dir, entry.name );
  if ( entry.isDirectory()) return sourcesUnder( path );
  return /\.(ts|mts|js|mjs)$/.test( entry.name ) ? [ path ] : [];
});

const QUOTES = new Set( [ '\'', '"', '`' ] );

// The text of every `.describe( … )` argument in `source`: its string literals joined, as the model would read it.
const describeArguments = ( source: string ): string[] => {
  const found: string[] = [];
  for ( let at = source.indexOf( '.describe(' ); at !== -1; at = source.indexOf( '.describe(', at + 1 )){
    let depth = 1;
    let quote: string | undefined;
    let literal = '';
    let text = '';
    for ( let index = at + '.describe('.length; depth > 0 && index < source.length; index += 1 ){
      const char = source[ index ];
      if ( quote !== undefined ){
        if ( char === '\\' ){ literal += source[ index + 1 ]; index += 1; } else if ( char === quote ){ text += literal; literal = ''; quote = undefined; } else literal += char;
      } else if ( QUOTES.has( char )) quote = char;
      else if ( char === '(' ) depth += 1;
      else if ( char === ')' ) depth -= 1;
    }
    found.push( text );
  }
  return found;
};

describe( 'the design tools\' shipped text is terse', () => {
  it( `Given the fallbacks then the instructions, every tool description and every note are under ${ FALLBACK_LIMIT } characters`, () => {
    const long = Object.entries({ instructions: FALLBACK_INSTRUCTIONS, ...FALLBACK_DESCRIPTIONS, ...FALLBACK_NOTES })
      .filter(([ , text ]) => text.length >= FALLBACK_LIMIT );

    expect( long ).toEqual( [] );
  });

  it( `Given the packages' source then no zod field description is ${ FIELD_LIMIT } characters or more, and the scan finds the descriptions there are`, () => {
    const described = sourcesUnder( PACKAGES ).flatMap( path =>
      describeArguments( readFileSync( path, 'utf8' )).map( text => ({ file: relative( PACKAGES, path ), text })));

    expect( described.length ).toBeGreaterThan( 0 );
    expect( described.filter(({ text }) => text.length >= FIELD_LIMIT )).toEqual( [] );
  });
});
