import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { emptyMap } from '@bett3r-dev/blueprint-schema';
import { MAP_ROUTE, SUBMIT_ROUTE, type ToolText } from '@bett3r-dev/blueprint-spec';

import { createHostedTarget, observabilityReadRoute } from '../src/hosted-target.js';
import { createBlueprintMcpServer } from '../src/server.js';

/**
 * BP-230: a query KPI's language over Steward's door. The language is read from the vocabulary (promql alone); a value
 * outside it is refused by the handler, naming the vocabulary, before anything reaches the host. An absent language
 * stays allowed (absent reads as promql, D12). The host's kpi lookup answer's apm comes back as the host sent it.
 */

const SESSION = 'session-kpi-language';
const OBSERVATION_ID = 'OBS-0000000A';
const APM = 'grafana';

type HostCall = { route: string; verb?: string; args?: Record<string, any> };

// A fixture host: a map-post is acked as the host acks it, { verb, events } with the minted id; the map route reads
// back an empty grounded map; the observability read route answers ok with the repo's apm.
function createFixtureHost() {
  const calls: HostCall[] = [];
  const fetchImpl = ( async ( input: Parameters<typeof globalThis.fetch>[ 0 ], init?: RequestInit ): Promise<Response> => {
    const url = new URL( String( input ));
    const body = init?.body === undefined ? undefined : JSON.parse( String( init.body )) as { submissionId?: string; verb?: string; args?: Record<string, any> };
    calls.push({ route: url.pathname, ...( body?.verb !== undefined ? { verb: body.verb, args: body.args } : {}) });
    const json = ( status: number, payload: unknown ) => new Response( JSON.stringify( payload ), { status, headers: { 'content-type': 'application/json' } });
    if ( url.pathname === SUBMIT_ROUTE && body?.verb === 'map-post' ){
      return json( 200, { ok: true, submissionId: body.submissionId, seqs: [ 1 ], seq: 1, replayed: false, id: OBSERVATION_ID, result: { verb: 'map-post', events: [ 'MapEntryPosted' ] } });
    }
    if ( url.pathname === MAP_ROUTE ) return json( 200, { ok: true, map: { ...emptyMap(), shape: 'impact', grounded: true }, mapSeq: 1 });
    if ( url.pathname === observabilityReadRoute( SESSION )) return json( 200, { status: 'ok', op: 'resolve', verdict: 'found', apm: APM });
    return json( 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

async function connect( host: { fetch: typeof globalThis.fetch }, toolText?: ToolText ): Promise<Client> {
  const target = createHostedTarget({ hostUrl: 'https://host.invalid', accessToken: 'run-token', sessionId: SESSION, fetch: host.fetch, attempts: 1, baseDelayMs: 0 });
  const server = createBlueprintMcpServer({ repoPath: '.', target, ...( toolText !== undefined ? { toolText } : {}) });
  const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kpi-language-harness', version: '0.0.0' });
  await Promise.all( [ server.connect( serverTransport ), client.connect( clientTransport ) ] );
  return client;
}

async function call( client: Client, name: string, args: Record<string, unknown> ): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  const [ first ] = result.content as { type: string; text: string }[];
  return JSON.parse( first.text ) as Record<string, any>;
}

const observation = ( source: Record<string, unknown> ) => ({
  title: 'Fewer checkouts are declined',
  anchors: [ 'DEL-0000000A' ],
  kpi: { mode: 'define', definition: { kind: 'ratio', unit: 'percent', source } },
  expect: { direction: 'down', target: 2, window: '7d' }
});

const QUERY = { kind: 'query', datasource: 'payments', expr: 'sum(rate(declined_total[5m]))' };

const mapPosts = ( calls: HostCall[] ) => calls.filter( entry => entry.route === SUBMIT_ROUTE && entry.verb === 'map-post' );

describe( 'a query KPI\'s language over Steward\'s MCP', () => {
  it( 'Given a Steward MCP over a fixture host when the agent proposes a query KPI with language promql then the host receives the observation with source.language promql and the answer is ok', async () => {
    const host = createFixtureHost();
    const client = await connect( host );

    const answer = await call( client, 'map_propose_observation', observation({ ...QUERY, language: 'promql' }));

    expect( answer ).toMatchObject({ ok: true, id: OBSERVATION_ID });
    expect( mapPosts( host.calls )).toHaveLength( 1 );
    expect( mapPosts( host.calls )[ 0 ].args?.kpi.definition.source ).toEqual({ ...QUERY, language: 'promql' });
    await client.close();
  });

  it( 'Given a Steward MCP over a fixture host when the agent proposes a query KPI with language datadog then the answer is refused MAP_ENTRY_INVALID naming the vocabulary, and the host saw no write', async () => {
    const host = createFixtureHost();
    const client = await connect( host );

    const answer = await call( client, 'map_propose_observation', observation({ ...QUERY, language: 'datadog' }));

    expect( answer.ok ).toBe( false );
    expect( answer.error.code ).toBe( 'MAP_ENTRY_INVALID' );
    expect( answer.error.message ).toContain( 'kpi.definition.source.language is one of promql; got "datadog"' );
    expect( answer.error.details ).toEqual({ fields: [ 'kpi.definition.source.language' ], allowed: [ 'promql' ] });
    expect( host.calls.filter( entry => entry.route === SUBMIT_ROUTE )).toEqual( [] );
    await client.close();
  });

  it( 'Given a query KPI with no language when it is proposed then it lands with no language key (absent reads as promql)', async () => {
    const host = createFixtureHost();
    const client = await connect( host );

    const answer = await call( client, 'map_propose_observation', observation( QUERY ));

    expect( answer.ok ).toBe( true );
    expect( mapPosts( host.calls )[ 0 ].args?.kpi.definition.source ).toEqual( QUERY );
    await client.close();
  });

  it( 'Given an events KPI carrying a language when it is modified then the language is refused as foreign to the variant and the host saw no write', async () => {
    const host = createFixtureHost();
    const client = await connect( host );

    const answer = await call( client, 'map_modify_observation', {
      id: OBSERVATION_ID,
      ...observation({ kind: 'events', numerator: { esIds: [ 'sales_evt_order_declined' ] }, language: 'promql' })
    });

    expect( answer ).toMatchObject({ ok: false, error: { code: 'MAP_ENTRY_INVALID', details: { fields: [ 'kpi.definition.source.language' ] } } });
    expect( host.calls.filter( entry => entry.route === SUBMIT_ROUTE )).toEqual( [] );
    await client.close();
  });

  it( 'Given a served description for kpi.definition.source.language when the tools are listed then it is on that field of both observation tools', async () => {
    const served = 'query only: the language expr is written in, one of promql; promql when omitted. It must match the repo\'s APM language';
    const client = await connect( createFixtureHost(), {
      version: 1,
      fields: {
        map_propose_observation: { 'kpi.definition.source.language': served },
        map_modify_observation: { 'kpi.definition.source.language': served }
      }
    });

    const tools = ( await client.listTools()).tools;
    const languageOf = ( name: string ) => ( tools.find( tool => tool.name === name )?.inputSchema as Record<string, any> )
      .properties.kpi.properties.definition.properties.source.properties.language;

    expect( languageOf( 'map_propose_observation' )).toEqual({ type: 'string', description: served });
    expect( languageOf( 'map_modify_observation' )).toEqual({ type: 'string', description: served });
    await client.close();
  });

  it( 'Given no served text when the tools are listed then both observation tools\' fallback descriptions say a query KPI\'s language must match the repo\'s APM language', async () => {
    const client = await connect( createFixtureHost());

    const tools = ( await client.listTools()).tools;
    const describedBy = ( name: string ) => tools.find( tool => tool.name === name )?.description;

    expect( describedBy( 'map_propose_observation' )).toContain( 'A query KPI\'s language must match the repo\'s APM.' );
    expect( describedBy( 'map_modify_observation' )).toContain( 'A query KPI\'s language must match the repo\'s APM.' );
    await client.close();
  });

  it( 'Given a host whose kpi lookup answer carries the repo\'s apm when kpi_lookup is called then the apm comes back as the host sent it', async () => {
    const client = await connect( createFixtureHost());

    const answer = await call( client, 'kpi_lookup', { op: 'resolve', ref: 'panel-1' });

    expect( answer ).toEqual({ ok: true, status: 'ok', op: 'resolve', verdict: 'found', apm: APM });
    await client.close();
  });
});
