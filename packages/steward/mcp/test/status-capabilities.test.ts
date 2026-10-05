import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BLUEPRINT_MCP_CAPABILITIES, UNFAMILIED_TOOLS } from '../src/capabilities.js';
import { createHostedTarget } from '../src/hosted-target.js';
import { createBlueprintMcpServer } from '../src/server.js';

let repoPath: string;

type FetchInput = Parameters<typeof globalThis.fetch>[ 0 ];

// A request no case expects: the call fails loudly instead of reaching anything.
const noHost = async (): Promise<Response> => {
  throw new Error( 'this call must not reach the host' );
};

async function connect( fetch: ( input: FetchInput, init?: RequestInit ) => Promise<Response> = noHost ): Promise<Client> {
  const target = createHostedTarget({
    hostUrl: 'https://host.invalid',
    accessToken: 'run-token-value',
    sessionId: 'session-abc',
    fetch: fetch as typeof globalThis.fetch,
    attempts: 1,
    baseDelayMs: 0
  });
  const server = createBlueprintMcpServer({ repoPath, target });
  const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-harness', version: '0.0.0' });
  await Promise.all( [ server.connect( serverTransport ), client.connect( clientTransport ) ] );
  return client;
}

type CallToolOutcome = Awaited<ReturnType<Client[ 'callTool' ]>>;

function firstBody( result: CallToolOutcome ): Record<string, unknown> {
  if ( !( 'content' in result ) || !Array.isArray( result.content )){
    throw new Error( 'the tool result carried no content block' );
  }
  const [ first ] = result.content;
  if ( first?.type !== 'text' ){
    throw new Error( `expected a text content block, got ${ String( first?.type ) }` );
  }
  return JSON.parse( first.text ) as Record<string, unknown>;
}

beforeEach( () => {
  repoPath = mkdtempSync( join( tmpdir(), 'blueprint-mcp-capabilities-' ));
});

afterEach( () => {
  rmSync( repoPath, { recursive: true, force: true });
});

describe( 'blueprint-mcp status advertises verb families', () => {
  it( 'Given a hosted session when status is called then the first block carries the capabilities', async () => {
    const client = await connect( async ( input ): Promise<Response> => {
      expect( new URL( String( input )).pathname ).toBe( '/api/blueprint/sync-status' );
      return new Response( JSON.stringify({ lastSeq: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const body = firstBody( await client.callTool({ name: 'status', arguments: {} }) );

    expect( body.ok ).toBe( true );
    expect( body.capabilities ).toEqual({ schemaVersion: 1, verbFamilies: [ 'design', 'map', 'spec' ] });
    await client.close();
  });

  it( 'Given a host that does not answer when status is called then it refuses HOST_UNREACHABLE and still carries the capabilities', async () => {
    const client = await connect( async (): Promise<Response> => new Response( '', { status: 503 }));

    const result = await client.callTool({ name: 'status', arguments: {} });
    const body = firstBody( result );

    expect( body.ok ).toBe( false );
    expect( ( body.error as { code: string } ).code ).toBe( 'HOST_UNREACHABLE' );
    expect( ( body.capabilities as { verbFamilies: string[] } ).verbFamilies ).toContain( 'map' );
    expect( result.isError ).toBe( true );
    await client.close();
  });

  it( 'Given another tool fails BLUEPRINT_DIR_MISSING then it carries no capabilities', async () => {
    const client = await connect();

    const body = firstBody( await client.callTool({ name: 'get_design', arguments: {} }) );

    expect( body.ok ).toBe( false );
    expect( ( body.error as { code: string } ).code ).toBe( 'BLUEPRINT_DIR_MISSING' );
    expect( body ).not.toHaveProperty( 'capabilities' );
    await client.close();
  });

  it( 'Given the family table when the tools are listed then the families and the unfamilied list partition them, and listing reaches no host', async () => {
    const client = await connect();
    await expectPartition( client );
    await client.close();
  });

  it( 'Given the census when the tools are listed then kpi_lookup is an unfamilied tool beside status and read_changes, in no verb family', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect( [ ...UNFAMILIED_TOOLS ] ).toEqual( expect.arrayContaining( [ 'kpi_lookup', 'read_changes', 'status' ] ));
    expect( Object.values( BLUEPRINT_MCP_CAPABILITIES.families ).flat()).not.toContain( 'kpi_lookup' );
    expect( tools.map( tool => tool.name )).toContain( 'kpi_lookup' );
    await client.close();
  });
});

async function expectPartition( client: Client ): Promise<void> {
  {
    const { tools } = await client.listTools();
    const registered = tools.map( tool => tool.name );

    const classifiedNames = [
      ...Object.values( BLUEPRINT_MCP_CAPABILITIES.families ).flat(),
      ...UNFAMILIED_TOOLS
    ];

    const duplicates = classifiedNames.filter(
      ( name, index ) => classifiedNames.indexOf( name ) !== index
    );
    expect( duplicates, `classified twice: ${ duplicates.join( ', ' ) }` ).toEqual( [] );

    const classified = new Set<string>( classifiedNames );
    const registeredSet = new Set( registered );

    const unclassified = registered.filter( name => !classified.has( name ));
    expect(
      unclassified,
      `registered but in no verb family and not in UNFAMILIED_TOOLS: ${ unclassified.join( ', ' ) }`
    ).toEqual( [] );

    const unregistered = [ ...classified ].filter( name => !registeredSet.has( name ));
    expect(
      unregistered,
      `classified but not registered on this server: ${ unregistered.join( ', ' ) }`
    ).toEqual( [] );
  }
}

// The spec family.
const SPEC_TOOLS = [ 'get_spec', 'spec_post', 'spec_strike' ];

const STORY = { id: 'story-1', section: 'userStories', kind: 'story', refs: [ 'I1', 'A1' ], body: 'As a buyer, I want to pay in one step.' };

describe( 'the spec tools', () => {
  it( 'Given the server when its tools are listed then the three spec tools are listed and classified as the spec family', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map( tool => tool.name );
    expect( names ).toEqual( expect.arrayContaining( SPEC_TOOLS ));
    expect( [ ...BLUEPRINT_MCP_CAPABILITIES.families.spec ] ).toEqual( SPEC_TOOLS );
    await client.close();
  });

  it( 'Given a hosted session when spec_post, spec_strike and get_spec are called then each goes to the host: the writes as spec-post and spec-strike submissions, the read to the spec route', async () => {
    const spec = { specVersion: 1, entries: [ STORY ] };
    const sent: Array<{ path: string; verb?: string; args?: unknown }> = [];
    const client = await connect( async ( input, init ): Promise<Response> => {
      const path = new URL( String( input )).pathname;
      const body = init?.body === undefined ? {} : JSON.parse( String( init.body )) as { verb?: string; args?: unknown };
      sent.push( { path, ...( body.verb === undefined ? {} : { verb: body.verb, args: body.args } ) } );
      const answer = path === '/api/blueprint/submit'
        ? { ok: true, seqs: [ 7 ], seq: 7, replayed: false, result: { verb: body.verb, events: [ 'SpecEntriesPosted' ] } }
        : { ok: true, seq: 7, spec };
      return new Response( JSON.stringify( answer ), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const posted = firstBody( await client.callTool({ name: 'spec_post', arguments: { entries: [ STORY ] } }));
    const struck = firstBody( await client.callTool({ name: 'spec_strike', arguments: { entries: [ { id: 'story-1', reason: 'restated' } ] } }));
    const read = firstBody( await client.callTool({ name: 'get_spec', arguments: {} }));

    expect( posted ).toEqual( { ok: true, seq: 7, spec } );
    expect( struck ).toEqual( { ok: true, seq: 7, spec } );
    expect( read ).toEqual( { ok: true, seq: 7, spec } );
    expect( sent ).toEqual( [
      { path: '/api/blueprint/submit', verb: 'spec-post', args: { entries: [ STORY ] } },
      { path: '/api/blueprint/spec' },
      { path: '/api/blueprint/submit', verb: 'spec-strike', args: { entries: [ { id: 'story-1', reason: 'restated' } ] } },
      { path: '/api/blueprint/spec' },
      { path: '/api/blueprint/spec' }
    ] );
    await client.close();
  });
});
