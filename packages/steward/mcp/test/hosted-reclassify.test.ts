import { describe, expect, it } from 'vitest';

import { API_BLUEPRINT_DESIGN_JSON, CHANGES_ROUTE, SUBMIT_ROUTE } from '@bett3r-dev/blueprint-spec';

import { createHostedTarget } from '../src/hosted-target.js';

/**
 * The hosted target's `reclassify` dispatches the verb through the same submit path as every other verb
 * (hosted-target.ts `submit`) rather than refusing it.
 */

type Recorded = { route: string; body: Record<string, unknown> };

const jsonResponse = ( status: number, body: unknown ): Response =>
  new Response( JSON.stringify( body ), { status, headers: { 'content-type': 'application/json' } } );

const fakeHost = () => {
  const calls: Recorded[] = [];
  const fetchImpl = ( async ( input: Parameters<typeof globalThis.fetch>[ 0 ], init?: RequestInit ): Promise<Response> => {
    const url = new URL( String( input ));
    const body = init?.body === undefined ? {} : JSON.parse( String( init.body )) as Record<string, unknown>;
    calls.push( { route: url.pathname, body } );
    if ( url.pathname === API_BLUEPRINT_DESIGN_JSON )
      return jsonResponse( 200, { schemaVersion: 1 } );
    if ( url.pathname === SUBMIT_ROUTE )
      return jsonResponse( 200, {
        ok: true,
        submissionId: body.submissionId,
        seqs: [ 7 ],
        replayed: false,
        result: { verb: 'reclassify', events: [ 'ElementReclassified' ] }
      } );
    if ( url.pathname === CHANGES_ROUTE )
      return jsonResponse( 200, {
        sinceSeq: 6,
        cursorSeq: 6,
        lastSeq: 7,
        ops: [ {
          seq: 7,
          ts: new Date( 0 ).toISOString(),
          author: 'ai',
          class: 'semantic',
          verb: 'reclassify',
          payload: {
            moved: [ { operation: 'add-node', node: { id: 'stock/command/reserve-stock', type: 'command', label: 'Reserve Stock', subdomain: 'stock' } } ],
            alreadyPresent: []
          },
          writerSha: 'sha', writerId: 'writer'
        } ],
        pendingByAuthor: {},
        warnings: []
      } );
    return jsonResponse( 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } } );
  } ) as typeof globalThis.fetch;
  return { calls, fetch: fetchImpl };
};

const target = ( host: ReturnType<typeof fakeHost> ) => createHostedTarget( {
  hostUrl: 'https://host.invalid',
  accessToken: 'run-token-value',
  sessionId: 'session-abc',
  fetch: host.fetch,
  baseDelayMs: 0
} );

describe( 'the hosted blueprint-mcp target dispatches reclassify instead of refusing it', () => {
  it( 'Given a hosted target when reclassify is invoked then it POSTs the reclassify verb to the submit route', async () => {
    const host = fakeHost();
    const entries = [ { kind: 'proposed-node' as const, id: 'stock/command/reserve-stock' } ];

    const result = await target( host ).reclassify( { entries } ) as Record<string, unknown>;

    const submits = host.calls.filter( call => call.route === SUBMIT_ROUTE );
    expect( submits ).toHaveLength( 1 );
    expect( submits[ 0 ]!.body ).toMatchObject( { verb: 'reclassify', args: { entries } } );
    expect( typeof submits[ 0 ]!.body.submissionId ).toBe( 'string' );
    // The tool-level fields `handlers.ts`' reclassifyHandler actually reads off the result.
    expect( result.moved ).toEqual( [ { operation: 'add-node', node: { id: 'stock/command/reserve-stock', type: 'command', label: 'Reserve Stock', subdomain: 'stock' } } ] );
    expect( result.alreadyPresent ).toEqual( [] );
    expect( result.overridesChanged ).toBe( true );
  } );

  it( 'Given a hosted reclassify when the host acks { verb, events } then the target rebuilds the result the handler reads, with the post-write design AND the moved/alreadyPresent/overridesChanged fields ReclassifyResult requires', async () => {
    const host = fakeHost();

    const result = await target( host ).reclassify( { entries: [ { kind: 'proposed-node', id: 'stock/command/reserve-stock' } ] } ) as Record<string, unknown>;

    expect( result ).toMatchObject( {
      seq: 7,
      design: { schemaVersion: 1 },
      alreadyPresent: [],
      overridesChanged: true
    } );
    expect( result.moved ).toHaveLength( 1 );
    expect( host.calls.map( call => call.route )).toContain( API_BLUEPRINT_DESIGN_JSON );
    expect( host.calls.map( call => call.route )).toContain( CHANGES_ROUTE );
  } );
} );
