import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { BlueprintGraph, DesignFile, ProposedEdge, ProposedNode } from '@bett3r-dev/blueprint-schema';
import { emptyMap, nodeId, proposedNodeId } from '@bett3r-dev/blueprint-schema';
import { API_BLUEPRINT_DESIGN_JSON, CHANGES_ROUTE, MAP_ROUTE, SESSION_HEADER, SUBMIT_ROUTE } from '@bett3r-dev/blueprint-spec';

import { createHostedTarget } from '../src/hosted-target.js';
import { createBlueprintMcpServer } from '../src/server.js';

/**
 * The hosted target over the wire: a fake host answers the spec package's routes, and the agent's tool calls are
 * checked against the requests the host saw and the answers the agent got back.
 */

const TOKEN = 'run-token-value';
const SESSION = 'session-abc';

const ORDER = 'sales_agg_order';
const PLACE = nodeId( 'sales', 'command', 'Place Order' );
const SHIPPED = nodeId( 'sales', 'event', 'Order Shipped' );
const RESERVE = proposedNodeId({ subdomain: 'sales', type: 'command', label: 'Reserve Stock' });

const GRAPH: BlueprintGraph = {
  schemaVersion: 1,
  subdomains: [ 'sales' ],
  nodes: [
    { id: ORDER, type: 'aggregate', label: 'Order', subdomain: 'sales' },
    { id: PLACE, type: 'command', label: 'Place Order', subdomain: 'sales' },
    { id: SHIPPED, type: 'event', label: 'Order Shipped', subdomain: 'sales' }
  ],
  edges: [
    { from: PLACE, to: ORDER, kind: 'handled-by', origin: 'extracted' },
    { from: PLACE, to: SHIPPED, kind: 'produces', origin: 'extracted' }
  ]
};

type FetchInput = Parameters<typeof globalThis.fetch>[ 0 ];

type HostCall = {
  method: string;
  route: string;
  authorization: string | null;
  session: string | null;
  submissionId?: string;
  verb?: string;
  args?: Record<string, unknown>;
};

// A scripted answer for one request, taken before the host's own routes answer it.
type Scripted = { status: number; body: unknown } | { throws: string };

type FakeHost = {
  fetch: typeof globalThis.fetch;
  calls: HostCall[];
  design: DesignFile;
};

function jsonResponse( status: number, body: unknown ): Response {
  return new Response( JSON.stringify( body ), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// The fake host keeps the session's design and answers a submission it has seen before as already recorded
// (replayed: true), under the seqs it first landed at.
function createFakeHost( options: { script?: Scripted[]; design?: DesignFile } = {}): FakeHost {
  const script = [ ...( options.script ?? []) ];
  const calls: HostCall[] = [];
  const design: DesignFile = options.design ?? { schemaVersion: 1 };
  const recorded = new Map<string, number[]>();
  const ops: { seq: number; verb: string; author: string; payload: unknown }[] = [];
  let lastSeq = 0;

  const fetchImpl = ( async ( input: FetchInput, init?: RequestInit ): Promise<Response> => {
    const url = new URL( String( input ));
    const headers = new Headers( init?.headers );
    const body = init?.body === undefined
      ? undefined
      : JSON.parse( String( init.body )) as { submissionId?: string; verb?: string; args?: Record<string, unknown> };
    calls.push({
      method: init?.method ?? 'GET',
      route: url.pathname,
      authorization: headers.get( 'authorization' ),
      session: headers.get( SESSION_HEADER ),
      ...( body?.verb !== undefined ? { submissionId: body.submissionId, verb: body.verb, args: body.args } : {})
    });

    const scripted = script.shift();
    if ( scripted !== undefined ){
      if ( 'throws' in scripted ) throw new TypeError( scripted.throws );
      return jsonResponse( scripted.status, scripted.body );
    }

    if ( url.pathname === API_BLUEPRINT_DESIGN_JSON ) return jsonResponse( 200, design );
    if ( url.pathname === MAP_ROUTE ){
      return jsonResponse( 200, { ok: true, map: { ...emptyMap(), shape: 'impact', grounded: true }, mapSeq: 3 });
    }
    if ( url.pathname === SUBMIT_ROUTE && body?.verb === 'propose' ){
      const submissionId = body.submissionId ?? '';
      const landed = recorded.get( submissionId );
      if ( landed !== undefined ){
        return jsonResponse( 200, { ok: true, submissionId, seqs: landed, seq: lastSeq, replayed: true });
      }
      const ts = new Date( 0 ).toISOString();
      const args = body.args as { nodes?: Omit<ProposedNode, 'author' | 'ts'>[]; edges?: Omit<ProposedEdge, 'author' | 'ts'>[] };
      design.propose = {
        nodes: [ ...( design.propose?.nodes ?? []), ...( args.nodes ?? []).map( node => ({ ...node, author: 'ai' as const, ts })) ],
        edges: [ ...( design.propose?.edges ?? []), ...( args.edges ?? []).map( edge => ({ ...edge, author: 'ai' as const, ts })) ]
      };
      lastSeq += 1;
      recorded.set( submissionId, [ lastSeq ] );
      return jsonResponse( 200, {
        ok: true,
        submissionId,
        seqs: [ lastSeq ],
        seq: lastSeq,
        replayed: false,
        result: { verb: 'propose', events: [ 'NodesProposed' ] }
      });
    }
    // A comment is acked as the host acks it, { verb, events }; the ids it mints ride only in the op's payload, which
    // the changes route serves.
    if ( url.pathname === SUBMIT_ROUTE && body?.verb === 'comment' ){
      const ts = new Date( 0 ).toISOString();
      const entries = (( body.args as { entries: { anchor: null; text: string }[] } ).entries ).map(( entry, index ) =>
        ({ ...entry, id: `c${ ( design.comments ?? []).length + index + 1 }`, author: 'ai' as const, ts, resolved: false }));
      design.comments = [ ...( design.comments ?? []), ...entries ];
      lastSeq += 1;
      ops.push({ seq: lastSeq, verb: 'comment', author: 'ai', payload: { entries } });
      return jsonResponse( 200, { ok: true, submissionId: body.submissionId, seqs: [ lastSeq ], seq: lastSeq, replayed: false, result: { verb: 'comment', events: [ 'CommentsAdded' ] } });
    }
    if ( url.pathname === CHANGES_ROUTE ){
      const since = Number( url.searchParams.get( 'sinceSeq' ) ?? 0 );
      return jsonResponse( 200, { ok: true, ops: ops.filter( op => op.seq > since ) });
    }
    return jsonResponse( 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } });
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls, design };
}

let repoPath: string;

async function connect( host: Pick<FakeHost, 'fetch'>, attempts = 3 ): Promise<Client> {
  const target = createHostedTarget({
    hostUrl: 'https://host.invalid',
    accessToken: TOKEN,
    sessionId: SESSION,
    fetch: host.fetch,
    attempts,
    baseDelayMs: 0
  });
  const server = createBlueprintMcpServer({ repoPath, target });
  const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-harness', version: '0.0.0' });
  await Promise.all( [ server.connect( serverTransport ), client.connect( clientTransport ) ] );
  return client;
}

type CallToolOutcome = Awaited<ReturnType<Client[ 'callTool' ]>>;

function toolBody( result: CallToolOutcome ): Record<string, unknown> {
  if ( !( 'content' in result ) || !Array.isArray( result.content )){
    throw new Error( 'the tool result carried no content block' );
  }
  const [ first ] = result.content;
  if ( first?.type !== 'text' ){
    throw new Error( `expected a text content block, got ${ String( first?.type ) }` );
  }
  return JSON.parse( first.text ) as Record<string, unknown>;
}

const PROPOSE = { nodes: [ { type: 'command', label: 'Reserve Stock', subdomain: 'sales' } ] };

beforeEach( () => {
  repoPath = mkdtempSync( join( tmpdir(), 'blueprint-mcp-hosted-wire-' ));
});

afterEach( () => {
  rmSync( repoPath, { recursive: true, force: true });
});

describe( 'blueprint-mcp hosted target over the wire', () => {
  it( 'Given a host that acks propose with { verb, events } when propose is called then one submission reaches the submit route with the session and token, and the seq is rebuilt from the design read and the node ids are minted from the nodes proposed', async () => {
    const host = createFakeHost();
    const client = await connect( host );

    const body = toolBody( await client.callTool({ name: 'propose', arguments: PROPOSE }));

    const submits = host.calls.filter( call => call.route === SUBMIT_ROUTE );
    expect( submits ).toHaveLength( 1 );
    expect( submits[ 0 ] ).toMatchObject({
      method: 'POST',
      authorization: `Bearer ${ TOKEN }`,
      session: SESSION,
      verb: 'propose',
      args: { ...PROPOSE, author: 'ai' }
    });
    expect( typeof submits[ 0 ].submissionId ).toBe( 'string' );
    expect( host.calls.map( call => call.route )).toEqual( [ SUBMIT_ROUTE, API_BLUEPRINT_DESIGN_JSON ] );
    expect( body ).toMatchObject({ ok: true, seq: 1, designSize: { nodes: 1, edges: 0 } });
    expect( body.nodeIds ).toEqual( [ RESERVE ] );

    await client.close();
  });

  it( 'Given a host that acks comment with { verb, events } and mints the ids into the op when comment is called with two entries then the agent is answered the two minted ids, read from the op at the ack\'s seq', async () => {
    const host = createFakeHost({ design: { schemaVersion: 1, comments: [ { id: 'c1', anchor: null, text: 'earlier', author: 'human', ts: new Date( 0 ).toISOString(), resolved: false } ] } });
    const client = await connect( host );

    const body = toolBody( await client.callTool({ name: 'comment', arguments: { entries: [ { text: 'why here?' }, { anchor: { node: PLACE }, text: 'and this?' } ] } }));

    expect( body ).toMatchObject({ ok: true, seq: 1, commentIds: [ 'c2', 'c3' ], totalComments: 3 });
    expect( host.calls.map( call => call.route )).toEqual( [ SUBMIT_ROUTE, API_BLUEPRINT_DESIGN_JSON, CHANGES_ROUTE ] );

    await client.close();
  });

  it( 'Given a host whose first answer to a propose is lost when the retry is acked as already recorded then the agent is answered ok with the seqs it landed at, and the write landed once', async () => {
    const host = createFakeHost();
    let dropped = false;
    const client = await connect({
      fetch: ( async ( input: FetchInput, init?: RequestInit ): Promise<Response> => {
        const response = await host.fetch( input, init );
        if ( !dropped && new URL( String( input )).pathname === SUBMIT_ROUTE ){
          dropped = true;
          throw new TypeError( 'fetch failed' );
        }
        return response;
      }) as typeof globalThis.fetch
    });

    const body = toolBody( await client.callTool({ name: 'propose', arguments: PROPOSE }));

    const submits = host.calls.filter( call => call.route === SUBMIT_ROUTE );
    expect( submits ).toHaveLength( 2 );
    expect( submits[ 1 ].submissionId ).toBe( submits[ 0 ].submissionId );
    expect( host.design.propose?.nodes ).toHaveLength( 1 );
    expect( body ).toEqual({ ok: true, seqs: [ 1 ], replayed: true });

    await client.close();
  });

  it.each( [
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 403, code: 'GRANT_REVOKED' }
  ] )( 'Given a host answering $status $code when a tool is called then it answers RUN_GRANT_ENDED and the next call sends no request', async ( { status, code } ) => {
    const host = createFakeHost({ script: [ { status, body: { ok: false, error: { code, message: 'this grant has ended' } } } ] });
    const client = await connect( host );

    const first = await client.callTool({ name: 'propose', arguments: PROPOSE });
    const sent = host.calls.length;
    const next = toolBody( await client.callTool({ name: 'get_map', arguments: {} }));

    expect( first.isError ).toBe( true );
    expect( toolBody( first )).toMatchObject({ ok: false, error: { code: 'RUN_GRANT_ENDED' } });
    expect( next ).toMatchObject({ ok: false, error: { code: 'RUN_GRANT_ENDED' } });
    expect( sent ).toBe( 1 );
    expect( host.calls ).toHaveLength( sent );

    await client.close();
  });

  it( 'Given a host that answers 5xx and then fails with the token in its reason when a tool is called then every attempt is made and HOST_UNREACHABLE comes back with the token redacted', async () => {
    const host = createFakeHost({ script: [
      { status: 503, body: { ok: false } },
      { status: 502, body: { ok: false } },
      { throws: `connection reset while sending Bearer ${ TOKEN }` }
    ] });
    const client = await connect( host, 3 );

    const body = toolBody( await client.callTool({ name: 'propose', arguments: PROPOSE }));

    expect( host.calls.map( call => call.route )).toEqual( [ SUBMIT_ROUTE, SUBMIT_ROUTE, SUBMIT_ROUTE ] );
    expect( body ).toMatchObject({ ok: false, error: { code: 'HOST_UNREACHABLE', details: { route: SUBMIT_ROUTE, attempts: 3 } } });
    const message = ( body.error as { message: string } ).message;
    expect( message ).toContain( '[redacted]' );
    expect( JSON.stringify( body )).not.toContain( TOKEN );
    expect( host.design.propose ).toBeUndefined();

    await client.close();
  });

  it( 'Given a hosted session when get_map is called then the map is read from the map route and answered with its seq', async () => {
    const host = createFakeHost();
    const client = await connect( host );

    const body = toolBody( await client.callTool({ name: 'get_map', arguments: {} }));

    expect( host.calls.map( call => [ call.method, call.route, call.session ] )).toEqual( [ [ 'GET', MAP_ROUTE, SESSION ] ] );
    expect( body ).toMatchObject({ ok: true, mapSeq: 3, map: { shape: 'impact', grounded: true } });

    await client.close();
  });

  it( 'Given a checkout graph and a session whose design proposes Reserve Stock when get_flow runs then the flow merges the session\'s design onto the graph', async () => {
    mkdirSync( join( repoPath, '.blueprint' ), { recursive: true });
    writeFileSync( join( repoPath, '.blueprint', 'graph.json' ), JSON.stringify( GRAPH ), 'utf-8' );
    const ts = new Date( 0 ).toISOString();
    const host = createFakeHost({ design: {
      schemaVersion: 1,
      propose: {
        nodes: [ { type: 'command', label: 'Reserve Stock', subdomain: 'sales', author: 'ai', ts } ],
        edges: [ { from: SHIPPED, to: RESERVE, kind: 'causes', author: 'ai', ts } ]
      }
    } });
    const client = await connect( host );

    const body = toolBody( await client.callTool({ name: 'get_flow', arguments: { rootCommand: PLACE } }));

    expect( body.ok ).toBe( true );
    expect(( body.nodes as { id: string }[] ).map( node => node.id )).toContain( RESERVE );
    expect( body ).not.toHaveProperty( 'designError' );
    expect( host.calls.map( call => call.route )).toEqual( [ API_BLUEPRINT_DESIGN_JSON ] );

    await client.close();
  });
});
