import { describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SESSION_HEADER, TOOL_TEXT_ROUTE, type ToolText } from '@bett3r-dev/blueprint-spec';

import { HostRefusal } from '../src/hosted-target.js';
import type { BlueprintTarget } from '../src/handlers.js';
import { createBlueprintMcpServer } from '../src/server.js';
import { FALLBACK_DESCRIPTIONS, FALLBACK_INSTRUCTIONS, FALLBACK_NOTES, fetchToolText, parseToolText } from '../src/tool-text.js';

/**
 * The tools' model-facing text is the server's: served on TOOL_TEXT_ROUTE, overlaid by tool name and error code, and
 * replaced by terse fallbacks when it cannot be read.
 */

// A target whose every strike is refused with the code given, as the host refuses it.
const refusingStrike = ( code: string ): BlueprintTarget =>
  ( { mapStrike: async () => { throw new HostRefusal( code, `refused ${ code }` ); } } as unknown as BlueprintTarget );

// A target whose every reclassify answers, as the host does, whether the overrides file changed.
const reclassifying = ( overridesChanged: boolean ): BlueprintTarget =>
  ( { reclassify: async () => ({ moved: [], alreadyPresent: [], design: {}, overridesChanged }) } as unknown as BlueprintTarget );

const connect = async ( toolText: ToolText | undefined, target: BlueprintTarget = {} as BlueprintTarget ) => {
  const server = createBlueprintMcpServer({ repoPath: '.', target, ...( toolText !== undefined ? { toolText } : {}) });
  const [ serverSide, clientSide ] = InMemoryTransport.createLinkedPair();
  await server.connect( serverSide );
  const client = new Client({ name: 'tool-text-harness', version: '0.0.0' });
  await client.connect( clientSide );
  const tools = ( await client.listTools()).tools;
  const descriptions = Object.fromEntries( tools.map( tool => [ tool.name, tool.description ] ));
  const schemas = Object.fromEntries( tools.map( tool => [ tool.name, tool.inputSchema as Record<string, any> ] ));
  const strike = async () => JSON.parse(( await client.callTool({ name: 'map_strike', arguments: { id: 'SCN-0000000A', reason: 'x' } })).content[ 0 ].text ) as
    { ok: false; error: { code: string; recovery?: string } };
  const reclassify = async () => JSON.parse(( await client.callTool({ name: 'reclassify', arguments: { entries: [] } })).content[ 0 ].text ) as
    { ok: true; workingTree: { dirty: boolean; note: string } };
  return { descriptions, schemas, instructions: client.getInstructions(), strike, reclassify };
};

const SERVED: ToolText = {
  version: 1,
  instructions: 'Served instructions.',
  tools: { propose: 'Served propose.' },
  fields: {
    propose: { 'nodes': 'Served nodes.', 'nodes[].label': 'Served label.' },
    remove: { 'entries[].edge.from': 'Served edge source.' },
    comment: { 'entries[].anchor.edge.kind': 'Served anchor kind.' },
    map_propose_scenario: { 'title': 'Served title.' }
  },
  recovery: { map_strike: { MAP_EXAMPLE_NOT_OWN: 'Served recovery.' } },
  notes: { 'reclassify.workingTree.changed': 'Served note.' }
};

// Every description an input schema carries, at any depth.
const fieldDescriptions = ( schema: unknown ): string[] =>
  schema === null || typeof schema !== 'object'
    ? []
    : Object.entries( schema ).flatMap(([ key, value ]) =>
      key === 'description' && typeof value === 'string' ? [ value ] : fieldDescriptions( value ));

describe( 'the served tool text', () => {
  it( 'Given a served document when the server is created then its instructions and descriptions are overlaid by tool name, and every other tool keeps its fallback', async () => {
    const { descriptions, instructions } = await connect( SERVED );

    expect( instructions ).toBe( 'Served instructions.' );
    expect( descriptions.propose ).toBe( 'Served propose.' );
    expect( descriptions.modify ).toBe( FALLBACK_DESCRIPTIONS.modify );
    expect( Object.keys( descriptions ).sort()).toEqual( Object.keys( FALLBACK_DESCRIPTIONS ).sort());
  });

  it( 'Given a served recovery for a tool and code when that tool is refused that code then the failure carries it, and another code carries none', async () => {
    const named = await ( await connect( SERVED, refusingStrike( 'MAP_EXAMPLE_NOT_OWN' ))).strike();
    const other = await ( await connect( SERVED, refusingStrike( 'MAP_ID_UNKNOWN' ))).strike();

    expect( named.error ).toMatchObject({ code: 'MAP_EXAMPLE_NOT_OWN', recovery: 'Served recovery.' });
    expect( other.error.code ).toBe( 'MAP_ID_UNKNOWN' );
    expect( other.error ).not.toHaveProperty( 'recovery' );
  });

  it( 'Given no served document when the server is created then every one of the 34 tools is described by its fallback, no input field is described and no refusal carries a recovery', async () => {
    const { descriptions, schemas, instructions, strike } = await connect( undefined, refusingStrike( 'MAP_EXAMPLE_NOT_OWN' ));

    expect( instructions ).toBe( FALLBACK_INSTRUCTIONS );
    expect( Object.values( schemas ).flatMap( fieldDescriptions )).toEqual( [] );
    expect( Object.keys( descriptions )).toHaveLength( 34 );
    expect( descriptions ).toEqual( FALLBACK_DESCRIPTIONS );
    expect(( await strike()).error ).not.toHaveProperty( 'recovery' );
  });

  it( 'Given served field descriptions when the tools are listed then each is on its field by path, through arrays, unions and discriminated variants, and no other field is described', async () => {
    const { schemas } = await connect( SERVED );

    expect( schemas.propose.properties.nodes.description ).toBe( 'Served nodes.' );
    expect( schemas.propose.properties.nodes.items.properties.label.description ).toBe( 'Served label.' );
    expect( schemas.remove.properties.entries.items.anyOf.find(( variant: any ) => variant.properties.kind.const === 'edge' ).properties.from.description )
      .toBe( 'Served edge source.' );
    expect( schemas.comment.properties.entries.items.properties.anchor.anyOf.find(( option: any ) => option.properties.edge ).properties.edge.properties.kind.description )
      .toBe( 'Served anchor kind.' );
    expect( schemas.map_propose_scenario.properties.title.description ).toBe( 'Served title.' );
    expect( Object.values( schemas ).flatMap( fieldDescriptions ).sort()).toEqual(
      [ 'Served anchor kind.', 'Served edge source.', 'Served label.', 'Served nodes.', 'Served title.' ]
    );
  });

  it( 'Given a served note when a result carries that note then it is the served text, and a note not served is its fallback', async () => {
    const changed = await ( await connect( SERVED, reclassifying( true ))).reclassify();
    const unchanged = await ( await connect( SERVED, reclassifying( false ))).reclassify();

    expect( changed.workingTree ).toMatchObject({ dirty: true, note: 'Served note.' });
    expect( unchanged.workingTree ).toMatchObject({ dirty: false, note: FALLBACK_NOTES[ 'reclassify.workingTree.unchanged' ] });
  });

  it( 'Given a document with keys this MCP does not know and an entry that is not text when it is overlaid then the unknown keys are ignored and the bad entry falls back', async () => {
    const served = parseToolText({
      version: 1,
      futureField: { anything: true },
      tools: { propose: 7, modify: 'Served modify.', not_a_tool: 'ignored' },
      recovery: { not_a_tool: { CODE: 'ignored' }, map_strike: 'not a table' }
    });
    const { descriptions } = await connect( served );

    expect( descriptions.propose ).toBe( FALLBACK_DESCRIPTIONS.propose );
    expect( descriptions.modify ).toBe( 'Served modify.' );
    expect( descriptions ).not.toHaveProperty( 'not_a_tool' );
    expect( Object.keys( descriptions )).toHaveLength( 34 );
  });

  it( 'Given a document of another version or not an object then it is not read as one', () => {
    expect( parseToolText({ version: 2, tools: { propose: 'x' } })).toBeUndefined();
    expect( parseToolText( 'text' )).toBeUndefined();
    expect( parseToolText( null )).toBeUndefined();
  });
});

describe( 'fetching the tool text', () => {
  const options = { hostUrl: 'https://host.example/', accessToken: 'job-key-value', sessionId: 'session-abc' };

  it( 'Given the host answers the document when it is fetched then it is read from TOOL_TEXT_ROUTE with the job key and the session header', async () => {
    const fetch = vi.fn( async () => new Response( JSON.stringify( SERVED ), { status: 200 }));
    const log = vi.fn();

    const text = await fetchToolText({ ...options, fetch, log });

    expect( text ).toEqual( SERVED );
    expect( log ).not.toHaveBeenCalled();
    const [ url, init ] = fetch.mock.calls[ 0 ] as unknown as [ string, RequestInit ];
    expect( url ).toBe( `https://host.example${ TOOL_TEXT_ROUTE }` );
    expect( init.headers ).toMatchObject({ authorization: 'Bearer job-key-value', [ SESSION_HEADER ]: 'session-abc' });
  });

  it.each([
    [ 'the host is unreachable', async () => { throw new Error( 'connect ECONNREFUSED job-key-value' ); } ],
    [ 'the host refuses', async () => new Response( '{"error":{"code":"TOOL_TEXT_NOT_JOB_KEY"}}', { status: 403 }) ],
    [ 'the route is absent', async () => new Response( 'not found', { status: 404 }) ],
    [ 'the body is not the document', async () => new Response( JSON.stringify({ version: 9 }), { status: 200 }) ],
    [ 'the body is not JSON', async () => new Response( '<html>', { status: 200 }) ]
  ])( 'Given %s when the tool text is fetched then it answers undefined and logs one line, never the key', async ( _case, answer ) => {
    const log = vi.fn();

    const text = await fetchToolText({ ...options, fetch: vi.fn( answer ) as unknown as typeof globalThis.fetch, log });

    expect( text ).toBeUndefined();
    expect( log ).toHaveBeenCalledTimes( 1 );
    const line = log.mock.calls[ 0 ][ 0 ] as string;
    expect( line ).toMatch( /fallback/ );
    expect( line ).not.toContain( '\n' );
    expect( line ).not.toContain( 'job-key-value' );
  });
});
