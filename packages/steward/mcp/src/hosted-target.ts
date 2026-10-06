import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  applyDesign,
  emptyDesign,
  joinCoverageLinks,
  joinMapLinks,
  proposedNodeId,
  type DesignFile,
  type BlueprintGraph,
  type CoverageLink,
  type CoverageReport,
  type MapLinkReport
} from '@bett3r-dev/blueprint-schema';
import {
  API_BOARD_JSON,
  API_BLUEPRINT_DESIGN_JSON,
  API_BLUEPRINT_GRAPH_JSON,
  CHANGES_ROUTE,
  MAP_ROUTE,
  MARK_SYNCED_ROUTE,
  observabilityReadRoute,
  SESSION_HEADER,
  SPEC_ROUTE,
  SUBMIT_ROUTE,
  SYNC_STATUS_ROUTE,
  type MapReadResult,
  type ProposeNodeInput,
  type ReclassifiedEntry,
  type ReclassifyTarget
} from '@bett3r-dev/blueprint-spec';
import type { Op } from '@bett3r-dev/blueprint-schema';

import { marksFromAnnotations } from './board-marks.js';
import { BlueprintMcpError } from './errors.js';
import type { BlueprintTarget, KpiLookupAnswer, SpecRead } from './handlers.js';

export type HostedTargetOptions = {
  hostUrl: string;
  accessToken: string;
  sessionId: string;
  fetch?: typeof globalThis.fetch;
  attempts?: number;
  baseDelayMs?: number;
};

export class HostRefusal extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor( code: string, message: string, details?: unknown ){
    super( message );
    this.name = 'HostRefusal';
    this.code = code;
    this.details = details;
  }
}

export function isHostRefusal( value: unknown ): value is HostRefusal {
  return value instanceof HostRefusal;
}

/** The server had already recorded this submission: the seqs it landed at, and a map-post's id when the feed shows it. */
export class AlreadyRecorded extends Error {
  readonly seqs: number[];
  readonly id: string | undefined;

  constructor( seqs: number[], id?: string ){
    super( 'the host had already recorded this submission' );
    this.name = 'AlreadyRecorded';
    this.seqs = seqs;
    this.id = id;
  }
}

export function isAlreadyRecorded( value: unknown ): value is AlreadyRecorded {
  return value instanceof AlreadyRecorded;
}

type SubmitAnswer = {
  ok?: boolean;
  submissionId?: string;
  // The id a map-post's entry landed under.
  id?: unknown;
  seqs?: number[];
  seq?: number;
  replayed?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
};

type HostedVerb =
  | 'propose' | 'modify' | 'remove' | 'comment' | 'resolve' | 'reclassify' | 'undo'
  | 'map-ground' | 'map-post' | 'map-strike' | 'map-choose'
  | 'map-link' | 'map-unlink' | 'map-cover' | 'map-uncover' | 'map-undo'
  | 'spec-post' | 'spec-strike';

function redactor( token: string ): ( text: string ) => string {
  return ( text ) => ( token === '' ? text : text.split( token ).join( '[redacted]' ) );
}

const sleep = ( ms: number ): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise( resolve => setTimeout( resolve, ms ));

export function createHostedTarget( options: HostedTargetOptions ): BlueprintTarget {
  const doFetch = options.fetch ?? globalThis.fetch;
  const attempts = Math.max( 1, options.attempts ?? 3 );
  const baseDelayMs = options.baseDelayMs ?? 250;
  const redact = redactor( options.accessToken );
  const origin = options.hostUrl.replace( /\/+$/, '' );

  let grantEnded = false;

  function request( route: string, init?: RequestInit ): [ string, RequestInit ] {
    return [ `${ origin }${ route }`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${ options.accessToken }`,
        [ SESSION_HEADER ]: options.sessionId,
        ...( init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init?.headers
      }
    } ];
  }

  async function send( route: string, init?: RequestInit ): Promise<Response> {
    if ( grantEnded ){
      throw new BlueprintMcpError(
        'RUN_GRANT_ENDED',
        'this run\'s grant has ended; no further request is sent to the host'
      );
    }

    let lastReason = 'the host did not answer';
    for ( let attempt = 0; attempt < attempts; attempt += 1 ){
      if ( attempt > 0 ) await sleep( baseDelayMs * 2 ** ( attempt - 1 ));
      let response: Response;
      try {
        response = await doFetch( ...request( route, init ));
      } catch ( cause ){
        lastReason = redact( cause instanceof Error ? cause.message : String( cause ));
        continue;
      }
      if ( response.status >= 500 ){
        lastReason = `the host answered ${ response.status }`;
        continue;
      }
      return response;
    }

    throw new BlueprintMcpError(
      'HOST_UNREACHABLE',
      `the host at ${ origin } did not answer ${ route } after ${ attempts } attempts: ${ lastReason }`,
      { route, attempts }
    );
  }

  async function bodyOf( response: Response, route: string ): Promise<unknown> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse( text );
    } catch {
      throw new HostRefusal(
        'HOST_ANSWER_UNREADABLE',
        redact( `the host answered ${ route } with a body that is not JSON` )
      );
    }
    if ( response.ok ) return parsed;

    const error = ( parsed as { error?: { code?: string; message?: string; details?: unknown } } | undefined )?.error;
    const code = error?.code ?? `HOST_${ response.status }`;
    if ( response.status === 401 || code.startsWith( 'GRANT_' ) ){
      grantEnded = true;
      throw new BlueprintMcpError(
        'RUN_GRANT_ENDED',
        redact( error?.message ?? 'the host ended this run\'s grant' ),
        error?.details
      );
    }
    throw new HostRefusal(
      code,
      redact( error?.message ?? `the host refused ${ route } with ${ response.status }` ),
      error?.details
    );
  }

  async function read<Result>( route: string, fallback?: () => Result ): Promise<Result> {
    const response = await send( route );
    if ( response.status === 404 && fallback !== undefined ){
      return fallback();
    }
    return await bodyOf( response, route ) as Result;
  }

  async function submit<Result>( verb: HostedVerb, args: unknown, expectTarget?: unknown ): Promise<Result> {
    const init: RequestInit = {
      method: 'POST',
      body: JSON.stringify({
        submissionId: randomUUID(),
        author: 'ai',
        verb,
        args,
        ...( expectTarget !== undefined ? { expectTarget } : {})
      })
    };
    const answer = await bodyOf( await send( SUBMIT_ROUTE, init ), SUBMIT_ROUTE ) as SubmitAnswer;
    if ( answer.replayed === true ){
      throw new AlreadyRecorded( answer.seqs ?? [], verb === 'map-post' ? await recordedPostId( args, answer ) : undefined );
    }
    if ( answer.result === undefined ){
      throw new HostRefusal(
        'HOST_ANSWER_INCOMPLETE',
        `the host acked ${ verb } without the verb's result and without replayed:true`,
        { verb, seqs: answer.seqs }
      );
    }
    const result = answer.result as Record<string, unknown>;
    if ( Array.isArray( result.events ) && !( 'design' in result ) && !( 'map' in result )){
      const posted = verb === 'map-post' && typeof answer.id === 'string' ? { id: answer.id } : {};
      return { ...await rebuiltResult( verb, args, answer.seqs ?? [], result ), ...posted } as Result;
    }
    return answer.result as Result;
  }

  // A verb's ack is { verb, events }. From it and the session's reads come what the handlers read: the seq, the
  // post-write design or map, and the ids the write carried. A proposed node's id is derived from its subdomain, type
  // and label. The ack carries no findings, so they are reported empty.
  async function rebuiltResult( verb: HostedVerb, args: unknown, seqs: number[], acked: Record<string, unknown> ): Promise<Record<string, unknown>> {
    const input = ( args ?? {}) as { nodes?: ProposeNodeInput[]; entries?: { id?: unknown }[] };
    const idsOf = ( items: { id?: unknown }[] | undefined ): string[] =>
      ( items ?? []).map( item => item.id ).filter(( id ): id is string => typeof id === 'string' );
    const seq = seqs.length > 0 ? Math.max( ...seqs ) : 0;
    const base = { ...acked, seq, findings: [], strandedProposals: [], orphaned: [] };
    if ( verb === 'map-uncover' ){
      const { map } = await read<MapReadResult>( MAP_ROUTE );
      return { ...base, map, removed: await uncoveredPairsFor( seq ) };
    }
    // A spec write answers the spec route's read after it.
    if ( verb.startsWith( 'spec-' )){
      const { spec } = await read<SpecRead>( SPEC_ROUTE );
      return { ...base, spec };
    }
    if ( verb.startsWith( 'map-' )){
      const { map } = await read<MapReadResult>( MAP_ROUTE );
      return { ...base, map };
    }
    const design = await read<DesignFile>( API_BLUEPRINT_DESIGN_JSON, emptyDesign );
    if ( verb === 'reclassify' ){
      const { moved, alreadyPresent } = await reclassifiedEntriesFor( seq );
      return { ...base, design, moved, alreadyPresent, overridesChanged: moved.length > 0 };
    }
    const commentIds = verb === 'comment' ? await commentIdsFor( seq ) : idsOf( input.entries );
    return { ...base, design, nodeIds: ( input.nodes ?? []).map( proposedNodeId ), commentIds };
  }

  // A comment's ack is { verb, events }, and the host mints each entry's id into the comment op's payload, so the ids
  // are read from the op at the ack's seq on the changes route, in the order the entries were sent.
  async function commentIdsFor( seq: number ): Promise<string[]> {
    if ( seq <= 0 ) return [];
    const { ops } = await read<{ ops: Op[] }>( `${ CHANGES_ROUTE }?sinceSeq=${ seq - 1 }`, () => ({ ops: [] }) );
    const op = ops.find( candidate => candidate.seq === seq && candidate.verb === 'comment' );
    const entries = ( op?.payload as { entries?: unknown } | undefined )?.entries;
    return ( Array.isArray( entries ) ? entries as { id?: unknown }[] : [])
      .map( entry => entry?.id ).filter(( id ): id is string => typeof id === 'string' );
  }

  // An ack of a write already recorded carries no event, so a map-post's id is read back from the feed by seq: the
  // recorded seqs where the server names them, else the ack's seq. The op found there is taken only if it is an ai
  // map-post carrying every field this request sent, as sent, so a later write landing between the two answers yields
  // no id rather than another entry's. The write already landed, so a feed that cannot be read yields no id too.
  async function recordedPostId( args: unknown, answer: SubmitAnswer ): Promise<string | undefined> {
    const seqs = answer.seqs ?? [];
    const seq = seqs.length > 0 ? Math.max( ...seqs ) : answer.seq;
    if ( typeof seq !== 'number' || seq <= 0 ) return undefined;
    let ops: Op[];
    try {
      ops = ( await read<{ ops: Op[] }>( `${ CHANGES_ROUTE }?sinceSeq=${ seq - 1 }&class=all`, () => ({ ops: [] }) )).ops;
    } catch {
      return undefined;
    }
    const op = ops.find( candidate => candidate.seq === seq && candidate.verb === 'map-post' );
    if ( op?.author !== 'ai' ) return undefined;
    const landed = ( op.payload ?? {}) as Record<string, unknown>;
    const asked = ( args ?? {}) as Record<string, unknown>;
    const same = Object.entries( asked )
      .every(([ field, value ]) => field === 'author' || isDeepStrictEqual( landed[ field ], value ));
    return same && typeof landed.id === 'string' ? landed.id : undefined;
  }

  // The ack of this verb carries no `moved` / `alreadyPresent` split; the verb's own op payload does, and the changes
  // route is the one that hands it back, so the op at the verb's seq is read.
  async function reclassifiedEntriesFor( seq: number ): Promise<{ moved: ReclassifiedEntry[]; alreadyPresent: ReclassifyTarget[] }> {
    const empty = { moved: [] as ReclassifiedEntry[], alreadyPresent: [] as ReclassifyTarget[] };
    if ( seq <= 0 ) return empty;
    const { ops } = await read<{ ops: Op[] }>( `${ CHANGES_ROUTE }?sinceSeq=${ seq - 1 }`, () => ({ ops: [] }) );
    const op = ops.find( candidate => candidate.seq === seq && candidate.verb === 'reclassify' );
    const payload = ( op?.payload ?? {}) as { moved?: unknown; alreadyPresent?: unknown };
    return {
      moved: Array.isArray( payload.moved ) ? payload.moved as ReclassifiedEntry[] : [],
      alreadyPresent: Array.isArray( payload.alreadyPresent ) ? payload.alreadyPresent as ReclassifyTarget[] : []
    };
  }

  // The same for map-uncover: the pairs it removed, which can be more than the pair asked, are in its own op's
  // payload.
  async function uncoveredPairsFor( seq: number ): Promise<CoverageLink[]> {
    if ( seq <= 0 ) return [];
    const { ops } = await read<{ ops: Op[] }>( `${ CHANGES_ROUTE }?sinceSeq=${ seq - 1 }`, () => ({ ops: [] }) );
    const op = ops.find( candidate => candidate.seq === seq && candidate.verb === 'map-uncover' );
    const removed = ( op?.payload as { removed?: unknown } | undefined )?.removed;
    return Array.isArray( removed ) ? removed as CoverageLink[] : [];
  }

  return {
    readDesign: () => read<DesignFile>( API_BLUEPRINT_DESIGN_JSON, emptyDesign ),
    readChanges: ( input = {}) => read( `${ CHANGES_ROUTE }?${ new URLSearchParams(
      Object.entries( input )
        .filter( ( [ , value ] ) => value !== undefined )
        .map( ( [ key, value ] ): [ string, string ] => [ key, String( value ) ] )
    ).toString() }` ),
    markSynced: async ( seq ) => await bodyOf(
      await send( MARK_SYNCED_ROUTE, { method: 'POST', body: JSON.stringify({ seq }) }),
      MARK_SYNCED_ROUTE
    ) as Awaited<ReturnType<BlueprintTarget[ 'markSynced' ]>>,
    status: () => read( SYNC_STATUS_ROUTE ),

    propose: ( input ) => submit( 'propose', input ),
    modify: ( input ) => submit( 'modify', input ),
    remove: ( input ) => submit( 'remove', input ),
    comment: ( input ) => submit( 'comment', input ),
    resolve: ( input ) => submit( 'resolve', input ),

    reclassify: ( input ) => submit( 'reclassify', input ),

    undo: ( ( input?: { fold?: string } ) =>
      input?.fold === 'map'
        ? submit( 'map-undo', input )
        : submit( 'undo', input ) ) as BlueprintTarget[ 'undo' ],

    mapGround: ( input ) => submit( 'map-ground', input ),
    mapPost: ( input ) => submit( 'map-post', input ),
    mapStrike: ( input ) => submit( 'map-strike', input ),
    mapChoose: ( input ) => submit( 'map-choose', input ),
    mapLink: ( input ) => submit( 'map-link', input ),
    mapUnlink: ( input ) => submit( 'map-unlink', input ),
    mapCover: ( input ) => submit( 'map-cover', input ),
    mapUncover: ( input ) => submit( 'map-uncover', input ),

    readMap: () => read<MapReadResult>( MAP_ROUTE ),

    // The spec verbs go through the same submit as every other verb; the read is the spec route.
    specPost: async ( input ) => {
      const { seq, spec } = await submit<SpecRead>( 'spec-post', input );
      return { seq, spec };
    },
    specStrike: async ( input ) => {
      const { seq, spec } = await submit<SpecRead>( 'spec-strike', input );
      return { seq, spec };
    },
    readSpec: async () => {
      const { seq, spec } = await read<SpecRead>( SPEC_ROUTE );
      return { seq, spec };
    },

    readBoardMarks: async () => {
      const board = await read<{ annotations?: unknown } | null>( API_BOARD_JSON, () => null );
      return { boardPath: API_BOARD_JSON, present: board !== null, marks: marksFromAnnotations( board?.annotations ) };
    },

    readMapLinks: async (): Promise<MapLinkReport> => {
      const graph = await read<BlueprintGraph>( API_BLUEPRINT_GRAPH_JSON );
      const design = await read<DesignFile>( API_BLUEPRINT_DESIGN_JSON, emptyDesign );
      const { map } = await read<MapReadResult>( MAP_ROUTE );
      return joinMapLinks( applyDesign( graph, design ).graph, design, map );
    },

    // Coverage joined over the design applied to the session's raw graph (no overrides here, so a pair can be
    // judged differently than on the board). A map read across the
    // wire is a read boundary: absent scenarios or coverage are read as none.
    readCoverage: async (): Promise<CoverageReport> => {
      const graph = await read<BlueprintGraph>( API_BLUEPRINT_GRAPH_JSON );
      const design = await read<DesignFile>( API_BLUEPRINT_DESIGN_JSON, emptyDesign );
      const { map } = await read<MapReadResult>( MAP_ROUTE );
      return joinCoverageLinks( applyDesign( graph, design ).graph, {
        scenarios: map.scenarios ?? [],
        coverage: map.coverage ?? []
      });
    },

    // One POST to the observability read route, answered ok or unreachable with a reason; both come back as sent.
    kpiLookup: async ( request ) => {
      const route = observabilityReadRoute( options.sessionId );
      return await bodyOf( await send( route, { method: 'POST', body: JSON.stringify( request ) }), route ) as KpiLookupAnswer;
    }
  };
}

export { observabilityReadRoute };
