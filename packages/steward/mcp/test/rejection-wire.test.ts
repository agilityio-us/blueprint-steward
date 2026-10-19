import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { MapFile } from '@bett3r-dev/blueprint-schema';
import { emptyMap } from '@bett3r-dev/blueprint-schema';
import { MAP_ROUTE, SUBMIT_ROUTE } from '@bett3r-dev/blueprint-spec';

import { createHostedTarget } from '../src/hosted-target.js';
import { createBlueprintMcpServer } from '../src/server.js';

/**
 * BP-229 slice 4, the steward fork's half: a scenario's and a walk's declared rejection marker reach the host on the
 * map-post the agent's call sends, and come back on get_map. The fake host keeps what it is posted, as the session's
 * map would; the store's own judging of the marker is pinned in blueprint-store, not here.
 */

const SESSION = 'session-rejection';

type Posted = { verb: string; args: Record<string, unknown> };

type FakeHost = {
  fetch: typeof globalThis.fetch;
  posted: Posted[];
};

function jsonResponse( status: number, body: unknown ): Response {
  return new Response( JSON.stringify( body ), { status, headers: { 'content-type': 'application/json' } });
}

function createFakeHost(): FakeHost {
  const posted: Posted[] = [];
  const map: MapFile = { ...emptyMap(), shape: 'decision', grounded: true };
  let seq = 0;
  const fetchImpl = ( async ( input: Parameters<typeof globalThis.fetch>[ 0 ], init?: RequestInit ): Promise<Response> => {
    const url = new URL( String( input ));
    if ( url.pathname === MAP_ROUTE ) return jsonResponse( 200, { ok: true, map, mapSeq: seq });
    if ( url.pathname === SUBMIT_ROUTE ){
      const body = JSON.parse( String( init?.body )) as { submissionId: string; verb: string; args: Record<string, unknown> };
      posted.push({ verb: body.verb, args: body.args });
      seq += 1;
      const { author: _author, ...entry } = body.args;
      let id: string | undefined;
      if ( entry.level === 'scenario' ){
        id = typeof entry.id === 'string' ? entry.id : `SCN-${ String( seq ).padStart( 8, '0' ) }`;
        const { level: _level, ...stored } = entry;
        const scenario = { ...stored, id, status: { kind: 'proposed' }, proposedBy: 'ai' } as unknown as NonNullable<MapFile[ 'scenarios' ]>[ number ];
        map.scenarios = [ ...( map.scenarios ?? []).filter( existing => existing.id !== id ), scenario ];
      }
      if ( entry.level === 'fork' ){
        const { level: _level, ...stored } = entry;
        const fork = { restsOn: [], ...stored, status: { kind: 'open' } } as unknown as MapFile[ 'forks' ][ number ];
        map.forks = [ ...map.forks.filter( existing => existing.id !== fork.id ), fork ];
      }
      return jsonResponse( 200, {
        ok: true,
        submissionId: body.submissionId,
        seqs: [ seq ],
        seq,
        replayed: false,
        ...( id !== undefined ? { id } : {}),
        result: { verb: body.verb, events: [ 'MapEntryPosted' ] }
      });
    }
    return jsonResponse( 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, posted };
}

let repoPath: string;

async function connect( host: FakeHost ): Promise<Client> {
  const target = createHostedTarget({
    hostUrl: 'https://host.invalid',
    accessToken: 'run-token',
    sessionId: SESSION,
    fetch: host.fetch,
    attempts: 1,
    baseDelayMs: 0
  });
  const server = createBlueprintMcpServer({ repoPath, target });
  const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-harness', version: '0.0.0' });
  await Promise.all( [ server.connect( serverTransport ), client.connect( clientTransport ) ] );
  return client;
}

async function call( client: Client, name: string, args: Record<string, unknown> ): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  if ( !( 'content' in result ) || !Array.isArray( result.content )) throw new Error( 'the tool result carried no content block' );
  const [ first ] = result.content;
  if ( first?.type !== 'text' ) throw new Error( `expected a text content block, got ${ String( first?.type ) }` );
  return JSON.parse( first.text ) as Record<string, any>;
}

const REFUSAL_BODY = {
  title: 'An unpaid retainer is refused',
  anchors: [ 'where' ],
  given: [ { text: 'a client whose retainer is unpaid' } ],
  when: [ { text: 'work is booked' } ],
  then: [ { text: 'the booking is refused' } ]
};

const REJECTION_WALK = {
  scenario: 'Paying with an expired card',
  text: 'the expired card is refused',
  kind: 'behavioral',
  given: 'a buyer with an expired card',
  when: 'the buyer pays',
  then: 'the payment is refused',
  rejection: { code: 'CARD_EXPIRED' }
};

beforeEach( () => {
  repoPath = mkdtempSync( join( tmpdir(), 'steward-mcp-rejection-' ));
});

afterEach( () => {
  rmSync( repoPath, { recursive: true, force: true });
});

describe( 'steward mcp — the rejection marker on the wire (BP-229 slice 4)', () => {
  it( 'Given a map_propose_scenario call with rejection { code } when get_map is read then the scenario carries the rejection', async () => {
    // GIVEN
    const host = createFakeHost();
    const client = await connect( host );
    const answer = await call( client, 'map_propose_scenario', { ...REFUSAL_BODY, rejection: { code: 'RETAINER_NOT_PAID' } });
    expect( answer ).toMatchObject({ ok: true });
    expect( host.posted.map( post => [ post.verb, post.args.rejection ] )).toEqual( [ [ 'map-post', { code: 'RETAINER_NOT_PAID' } ] ] );

    // WHEN
    const read = await call( client, 'get_map', {});

    // THEN
    const scenario = ( read.map as MapFile ).scenarios?.find( entry => entry.id === answer.id ) as { rejection?: unknown } | undefined;
    expect( scenario?.rejection ).toEqual({ code: 'RETAINER_NOT_PAID' });
    await client.close();
  });

  it( 'Given a proposed scenario when map_modify_scenario sends rejection {} then the modify carries the marker with no code', async () => {
    const host = createFakeHost();
    const client = await connect( host );
    const answer = await call( client, 'map_propose_scenario', REFUSAL_BODY );
    expect( answer, 'the given: an unmarked proposal' ).toMatchObject({ ok: true });
    expect( host.posted[ 0 ]?.args, 'the given: no marker sent' ).not.toHaveProperty( 'rejection' );

    const modified = await call( client, 'map_modify_scenario', { id: answer.id, ...REFUSAL_BODY, rejection: {} });

    expect( modified ).toMatchObject({ ok: true });
    expect( host.posted[ 1 ]?.args ).toMatchObject({ id: answer.id, rejection: {} });
    await client.close();
  });

  it( 'Given a rejection carrying a key other than code when map_propose_scenario is called then MAP_ENTRY_INVALID names rejection.reason and nothing is sent', async () => {
    const host = createFakeHost();
    const client = await connect( host );

    const answer = await call( client, 'map_propose_scenario', { ...REFUSAL_BODY, rejection: { code: 'RETAINER_NOT_PAID', reason: 'unpaid' } });

    expect( answer ).toMatchObject({ ok: false, error: { code: 'MAP_ENTRY_INVALID', details: { fields: [ 'rejection.reason' ] } } });
    expect( host.posted ).toEqual( [] );
    await client.close();
  });

  it( 'Given a fork option posted through map_post with a walk carrying rejection { code } when get_map is read then the walk carries the rejection', async () => {
    // GIVEN
    const host = createFakeHost();
    const client = await connect( host );
    const card = {
      problem: 'How does a buyer pay?',
      useCases: [ 'checkout' ],
      options: [ { id: 'C', label: 'Saved cards', walks: [ REJECTION_WALK ] }, { id: 'B', label: 'Invoices', walks: [] } ],
      recommendation: { option: 'C', why: 'fewer steps' },
      ifOverturned: 'invoice everyone'
    };
    expect( await call( client, 'map_post', { level: 'fork', id: 'F1', title: 'Payment', card })).toMatchObject({ ok: true });
    expect(( host.posted[ 0 ]?.args.card as typeof card ).options[ 0 ]?.walks[ 0 ]?.rejection ).toEqual({ code: 'CARD_EXPIRED' });

    // WHEN
    const map = ( await call( client, 'get_map', {})).map as MapFile;

    // THEN
    const walk = map.forks.find( fork => fork.id === 'F1' )?.card?.options[ 0 ]?.walks[ 0 ] as { rejection?: unknown } | undefined;
    expect( walk?.rejection ).toEqual({ code: 'CARD_EXPIRED' });
    await client.close();
  });
});
