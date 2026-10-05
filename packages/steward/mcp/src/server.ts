import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { EdgeKind, EdgeKindSource, NodeType } from '@bett3r-dev/blueprint-schema';
import {
  EDGE_KIND_SOURCES,
  EDGE_KINDS,
  KPI_DIRECTIONS,
  KPI_FILTER_OUTCOMES,
  KPI_KINDS,
  KPI_MODES,
  KPI_SOURCE_KINDS,
  MAP_ID_PATTERN,
  MAP_NODE_LEVELS,
  MAP_SHAPES,
  NODE_TYPES,
  SPEC_SECTION_IDS,
  WALK_KINDS
} from '@bett3r-dev/blueprint-schema';
import type { ProposeEdgeInput, ToolText } from '@bett3r-dev/blueprint-spec';

import {
  commentHandler,
  getCoverageHandler,
  getDesignHandler,
  getFlowHandler,
  getCardHandler,
  getMapHandler,
  getMapLinksHandler,
  getMarksHandler,
  getSpecHandler,
  kpiLookupHandler,
  mapChooseHandler,
  mapCoverHandler,
  mapGroundHandler,
  mapLinkHandler,
  mapModifyObservationHandler,
  mapModifyScenarioHandler,
  mapPostHandler,
  mapProposeObservationHandler,
  mapProposeScenarioHandler,
  mapStrikeHandler,
  mapUncoverHandler,
  mapUndoHandler,
  mapUnlinkHandler,
  markSyncedHandler,
  modifyHandler,
  proposeHandler,
  readChangesHandler,
  reclassifyHandler,
  removeHandler,
  resolveHandler,
  specPostHandler,
  specStrikeHandler,
  undoHandler,
  statusHandler,
  type BlueprintTarget,
  type HandlerContext
} from './handlers.js';
import { toCallToolResult, toolFailure, type CallToolResult, type ToolOutcome } from './tool-result.js';
import { describeInput, type InputShape } from './field-text.js';
import { resolveToolText, type ToolName } from './tool-text.js';

const NODE_TYPE_VALUES = [
  'aggregate',
  'system',
  'command',
  'event',
  'policy',
  'read-model',
  'external-system',
  'datastore',
  'cache',
  'ui',
  'postgres-view',
  'invariant'
] as const;
const _everyToolNodeTypeIsReal: readonly NodeType[] = NODE_TYPE_VALUES;
const _everyRealNodeTypeIsOffered: readonly ( typeof NODE_TYPE_VALUES )[ number ][] = NODE_TYPES;

const EDGE_KIND_VALUES = [
  'handled-by',
  'produces',
  'emits',
  'triggers',
  'issues',
  'projected-to',
  'reads-from',
  'transactionally-writes-to',
  'writes-to',
  'calls',
  'uses-cache',
  'causes',
  'invokes',
  'subscribes-to',
  'guarded-by'
] as const;
const _everyToolEdgeKindIsReal: readonly EdgeKind[] = EDGE_KIND_VALUES;
const _everyRealEdgeKindIsOffered: readonly ( typeof EDGE_KIND_VALUES )[ number ][] = EDGE_KINDS;

const EDGE_KIND_SOURCES_VALUES = [ 'chosen', 'guessed' ] as const;
const _everyToolKindSourceIsReal: readonly EdgeKindSource[] = EDGE_KIND_SOURCES_VALUES;
const _everyRealKindSourceIsOffered: readonly ( typeof EDGE_KIND_SOURCES_VALUES )[ number ][] =
  EDGE_KIND_SOURCES;

const proposeEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum( EDGE_KIND_VALUES ),
  kindSource: z.enum( EDGE_KIND_SOURCES_VALUES ).optional(),
  handlers: z.array( z.string() ).optional(),
  note: z.string().optional()
});

type ProposeEdgeShapeKey = keyof z.infer<typeof proposeEdgeSchema>;
const _everyStoreEdgeFieldIsOffered: readonly ProposeEdgeShapeKey[] =
  [] as readonly ( keyof ProposeEdgeInput )[];
const _everyOfferedEdgeFieldIsReal: readonly ( keyof ProposeEdgeInput )[] =
  [] as readonly ProposeEdgeShapeKey[];

const querySchema = z.object({
  route: z.string(),
  source: z.object({
    file: z.string(),
    line: z.number()
  })
});

const proposeInputShape = {
  nodes: z.array( z.object({
    type: z.enum( NODE_TYPE_VALUES ),
    label: z.string(),
    subdomain: z.string(),
    resourceKey: z.string().optional(),
    queries: z.array( querySchema ).optional(),
    note: z.string().optional()
  })).optional(),
  edges: z.array( proposeEdgeSchema ).optional()
};

const modifyInputShape = {
  entries: z.array( z.object({
    id: z.string(),
    set: z.object({
      label: z.string().optional(),
      subdomain: z.string().optional(),
      resourceKey: z.string().optional(),
      queries: z.array( querySchema ).optional()
    }).passthrough(),
    note: z.string().optional()
  }))
};

const removeInputShape = {
  entries: z.array( z.discriminatedUnion( 'kind', [
    z.object({
      kind: z.literal( 'node' ),
      id: z.string(),
      note: z.string().optional()
    }),
    z.object({
      kind: z.literal( 'edge' ),
      from: z.string(),
      to: z.string(),
      edgeKind: z.enum( EDGE_KIND_VALUES ),
      note: z.string().optional()
    })
  ] ))
};

const reclassifyInputShape = {
  entries: z.array( z.discriminatedUnion( 'kind', [
    z.object({
      kind: z.literal( 'proposed-node' ),
      id: z.string()
    }),
    z.object({
      kind: z.literal( 'proposed-edge' ),
      from: z.string(),
      to: z.string(),
      edgeKind: z.enum( EDGE_KIND_VALUES )
    }),
    z.object({
      kind: z.literal( 'modified-node' ),
      id: z.string()
    })
  ] ))
};

const commentInputShape = {
  entries: z.array( z.object({
    anchor: z.union( [
      z.object({
        node: z.string()
      }),
      z.object({
        edge: z.object({
          from: z.string(),
          to: z.string(),
          kind: z.enum( EDGE_KIND_VALUES )
        })
      }),
      z.object({
        commentId: z.string()
      })
    ] ).optional(),
    text: z.string(),
    note: z.string().optional()
  }))
};

const resolveInputShape = {
  entries: z.array( z.object({
    id: z.string(),
    resolved: z.boolean().optional()
  }))
};

const getFlowInputShape = {
  rootCommand: z.string(),
  scope: z.object({
    boundary: z.enum([ 'subdomain', 'end-to-end' ]).optional(),
    subdomains: z.array( z.string()).optional()
  }).optional()
};

const readChangesInputShape = {
  sinceSeq: z.number().int().min( 0 ).optional(),
  class: z.enum([ 'semantic', 'layout', 'operational', 'all' ]).optional(),
  author: z.enum([ 'human', 'ai', 'system', 'all' ]).optional()
};

const kpiLookupInputShape = {
  op: z.enum([ 'search', 'resolve' ]),
  text: z.string().min( 1 ).max( 512 ).optional(),
  ref: z.string().min( 1 ).max( 512 ).optional()
};

const markSyncedInputShape = {
  seq: z.number().int().min( 0 )
};

function vocabulary<Value extends string>( values: readonly Value[] ): [ Value, ...Value[] ] {
  const [ first, ...rest ] = values;
  if ( first === undefined ) throw new Error( 'blueprint-mcp: a map vocabulary list is empty' );
  return [ first, ...rest ];
}

const mapIdSchema = z.string().regex( MAP_ID_PATTERN );

const mapGroundInputShape = {
  shape: z.enum( vocabulary( MAP_SHAPES ))
};

const mapOptionSchema = z.object({
  id: mapIdSchema,
  label: z.string(),
  // A fork's walks; without these keys zod would strip them before the post is sent.
  walks: z.array( z.object({
    scenario: z.string(),
    text: z.string(),
    kind: z.enum( vocabulary( WALK_KINDS )).optional(),
    given: z.string().optional(),
    when: z.string().optional(),
    then: z.string().optional()
  })),
  rejectedBecause: z.string().optional(),
  evidence: z.array( z.string() ).optional()
});

const mapForkCardSchema = z.object({
  problem: z.string(),
  useCases: z.array( z.string() ),
  options: z.array( mapOptionSchema ),
  recommendation: z.object({ option: mapIdSchema, why: z.string() }),
  ifOverturned: z.string()
});

const mapPostInputShape = {
  level: z.enum([ ...vocabulary( MAP_NODE_LEVELS ), 'fork' ]),
  id: mapIdSchema,
  title: z.string(),
  parents: z.array( mapIdSchema ).optional(),
  card: mapForkCardSchema.optional(),
  anchor: mapIdSchema.optional(),
  restsOn: z.array( mapIdSchema ).optional(),
  testable: z.literal( false ).optional(),
  byFork: mapIdSchema.optional()
};

const mapStrikeInputShape = {
  id: mapIdSchema,
  reason: z.string(),
  byFork: mapIdSchema.optional()
};

// One spec entry, upserted by its id; an entry the server cannot take is refused SPEC_ENTRY_INVALID.
const specEntrySchema = z.object({
  id: z.string().min( 1 ),
  section: z.enum( SPEC_SECTION_IDS ),
  kind: z.string().min( 1 ),
  title: z.string().optional(),
  body: z.string(),
  refs: z.array( z.string() ).optional(),
  fields: z.record( z.string(), z.string() ).optional()
});

const specPostInputShape = {
  entries: z.array( specEntrySchema ).min( 1 )
};

const specStrikeInputShape = {
  entries: z.array( z.object({
    id: z.string().min( 1 ),
    reason: z.string().min( 1 )
  }) ).min( 1 )
};

const mapChooseInputShape = {
  fork: mapIdSchema,
  option: mapIdSchema,
  seenSeq: z.number().int().min( 0 ),
  settledBy: z.enum( [ 'code' ] ).optional()
};

const mapLinkInputShape = {
  esId: z.string().min( 1 ),
  deliverableId: mapIdSchema
};

const mapCoverInputShape = {
  esId: z.string().min( 1 ),
  scenarioId: mapIdSchema
};

// The card-chat scenario body. Every object is passthrough so the SDK's parse keeps an unknown
// key for unknownKeysOf to refuse (MAP_ENTRY_INVALID) instead of stripping it (zod's default).
const gherkinStepSchema = z.object({ text: z.string() }).passthrough();

const scenarioBodyShape = {
  title: z.string(),
  anchors: z.array( mapIdSchema ).optional(),
  covers: z.array( z.string().min( 1 )).optional(),
  given: z.array( gherkinStepSchema ),
  when: z.array( gherkinStepSchema ),
  then: z.array( gherkinStepSchema ),
  examples: z.object({
    columns: z.array( z.string() ),
    rows: z.array( z.array( z.string() ))
  }).passthrough().optional(),
  supersedes: mapIdSchema.optional()
};

const mapProposeScenarioInputSchema = z.object( scenarioBodyShape ).passthrough();

const mapModifyScenarioInputSchema = z.object({
  id: mapIdSchema,
  ...scenarioBodyShape
}).passthrough();

// The card-chat observation body, blueprint-schema's ObservationKpi, KpiDefinition and KpiExpectation, with every
// closed set read from blueprint-schema's vocabularies. A kpi
// and a source are each one object whose mode or kind says which of its fields apply; the handler refuses
// a field foreign to the variant. Passthrough throughout, for unknownKeysOf, as the scenario body.
const kpiEventSideSchema = z.object({
  esIds: z.array( z.string().min( 1 )),
  filters: z.object({
    outcome: z.enum( vocabulary( KPI_FILTER_OUTCOMES )).optional(),
    errorCode: z.string().optional()
  }).passthrough().optional()
}).passthrough();

const kpiDefinitionSchema = z.object({
  kind: z.enum( vocabulary( KPI_KINDS )),
  unit: z.string(),
  percentile: z.number().optional(),
  source: z.object({
    kind: z.enum( vocabulary( KPI_SOURCE_KINDS )),
    numerator: kpiEventSideSchema.optional(),
    denominator: kpiEventSideSchema.optional(),
    datasource: z.string().optional(),
    expr: z.string().optional()
  }).passthrough()
}).passthrough();

const observationBodyShape = {
  title: z.string(),
  anchors: z.array( mapIdSchema ),
  kpi: z.object({
    mode: z.enum( vocabulary( KPI_MODES )),
    definition: kpiDefinitionSchema.optional(),
    ref: z.string().optional(),
    label: z.string().optional()
  }).passthrough(),
  expect: z.object({
    direction: z.enum( vocabulary( KPI_DIRECTIONS )),
    target: z.number(),
    baseline: z.number().optional(),
    window: z.string()
  }).passthrough(),
  supersedes: mapIdSchema.optional()
};

const mapProposeObservationInputSchema = z.object( observationBodyShape ).passthrough();

const mapModifyObservationInputSchema = z.object({
  id: mapIdSchema,
  ...observationBodyShape
}).passthrough();

const getCardInputShape = {
  key: z.string().min( 1 )
};

// The keys a value carries that its schema does not declare, as dotted paths, at any depth.
function unknownKeysOf( schema: z.ZodTypeAny, value: unknown, path: string[] = [] ): string[] {
  if ( schema instanceof z.ZodOptional || schema instanceof z.ZodNullable ){
    return unknownKeysOf( schema.unwrap() as z.ZodTypeAny, value, path );
  }
  if ( schema instanceof z.ZodArray ){
    return Array.isArray( value )
      ? value.flatMap(( item, index ) => unknownKeysOf( schema.element as z.ZodTypeAny, item, [ ...path, String( index ) ] ))
      : [];
  }
  if ( schema instanceof z.ZodObject && typeof value === 'object' && value !== null && !Array.isArray( value )){
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return Object.entries( value as Record<string, unknown> ).flatMap(([ key, item ]) =>
      key in shape ? unknownKeysOf( shape[ key ], item, [ ...path, key ] ) : [ [ ...path, key ].join( '.' ) ] );
  }
  return [];
}

function strictInputRefusal( tool: string, schema: z.ZodTypeAny, args: unknown ): ToolOutcome<never> | undefined {
  const fields = unknownKeysOf( schema, args );
  return fields.length === 0
    ? undefined
    : toolFailure(
      'MAP_ENTRY_INVALID',
      `${ tool } does not take ${ fields.join( ', ' ) }; nothing was written. Re-send the call without it`,
      { fields }
    );
}

export type BlueprintMcpServerOptions = {
  repoPath: string;
  target: BlueprintTarget;
  /** The tool text the session's server served; absent, every tool is registered with its fallback. */
  toolText?: ToolText;
};

export function createBlueprintMcpServer( options: BlueprintMcpServerOptions ): McpServer {
  const text = resolveToolText( options.toolText );
  const context: HandlerContext = { repoPath: options.repoPath, target: options.target, note: text.note };
  const describe = ( tool: ToolName ): string => text.describe( tool );
  const input = <Input extends InputShape | z.ZodTypeAny>( tool: ToolName, schema: Input ): Input =>
    describeInput( schema, ( path ) => text.field( tool, path ));

  const answer = async ( tool: ToolName, outcome: ToolOutcome<unknown> ): Promise<CallToolResult> =>
    toCallToolResult( text.withRecovery( tool, outcome ));

  const server = new McpServer({
    name: 'blueprint-mcp',
    version: '0.1.0'
  }, {
    instructions: text.instructions
  });

  server.registerTool( 'propose', {
    title: 'Propose design elements',
    description: describe( 'propose' ),
    inputSchema: input( 'propose', proposeInputShape )
  }, async ( args ) => answer( 'propose', await proposeHandler( context, args )) );

  server.registerTool( 'modify', {
    title: 'Modify existing design elements',
    description: describe( 'modify' ),
    inputSchema: input( 'modify', modifyInputShape )
  }, async ( args ) => answer( 'modify', await modifyHandler( context, args )) );

  server.registerTool( 'remove', {
    title: 'Remove design elements',
    description: describe( 'remove' ),
    inputSchema: input( 'remove', removeInputShape )
  }, async ( args ) => answer( 'remove', await removeHandler( context, args )) );

  server.registerTool( 'comment', {
    title: 'Comment on the design',
    description: describe( 'comment' ),
    inputSchema: input( 'comment', commentInputShape )
  }, async ( args ) => answer( 'comment', await commentHandler( context, args )) );

  server.registerTool( 'resolve', {
    title: 'Close or re-open a comment',
    description: describe( 'resolve' ),
    inputSchema: input( 'resolve', resolveInputShape )
  }, async ( args ) => answer( 'resolve', await resolveHandler( context, args )) );

  server.registerTool( 'undo', {
    title: 'Undo your own last design gesture',
    description: describe( 'undo' ),
    inputSchema: {}
  }, async ( args ) => answer( 'undo', await undoHandler( context, args )) );

  server.registerTool( 'reclassify', {
    title: 'Move a design entry into the overrides layer',
    description: describe( 'reclassify' ),
    inputSchema: input( 'reclassify', reclassifyInputShape )
  }, async ( args ) => answer( 'reclassify', await reclassifyHandler( context, args )) );

  server.registerTool( 'get_flow', {
    title: 'Read one command flow',
    description: describe( 'get_flow' ),
    inputSchema: input( 'get_flow', getFlowInputShape )
  }, async ( args ) => answer( 'get_flow', await getFlowHandler( context, args )) );

  server.registerTool( 'get_design', {
    title: 'Read the design layer',
    description: describe( 'get_design' ),
    inputSchema: {}
  }, async () => answer( 'get_design', await getDesignHandler( context )) );

  server.registerTool( 'get_marks', {
    title: 'Read what the human drew on the board',
    description: describe( 'get_marks' ),
    inputSchema: {}
  }, async () => answer( 'get_marks', await getMarksHandler( context )) );

  server.registerTool( 'read_changes', {
    title: 'Read what changed on the board',
    description: describe( 'read_changes' ),
    inputSchema: input( 'read_changes', readChangesInputShape )
  }, async ( args ) => answer( 'read_changes', await readChangesHandler( context, args )) );

  server.registerTool( 'mark_synced', {
    title: 'Record how far the feed has been reconciled',
    description: describe( 'mark_synced' ),
    inputSchema: input( 'mark_synced', markSyncedInputShape )
  }, async ( args ) => answer( 'mark_synced', await markSyncedHandler( context, args )) );

  server.registerTool( 'status', {
    title: 'Read the design session status',
    description: describe( 'status' ),
    inputSchema: {}
  }, async () => answer( 'status', await statusHandler( context )) );

  server.registerTool( 'kpi_lookup', {
    title: 'Look a KPI up in the repository\'s observability',
    description: describe( 'kpi_lookup' ),
    inputSchema: input( 'kpi_lookup', kpiLookupInputShape )
  }, async ( args ) => answer( 'kpi_lookup', await kpiLookupHandler( context, args )) );

  server.registerTool( 'map_ground', {
    title: 'Ground the map',
    description: describe( 'map_ground' ),
    inputSchema: input( 'map_ground', mapGroundInputShape )
  }, async ( args ) => answer( 'map_ground', await mapGroundHandler( context, args )) );

  server.registerTool( 'map_post', {
    title: 'Post a map node or fork',
    description: describe( 'map_post' ),
    inputSchema: input( 'map_post', mapPostInputShape )
  }, async ( args ) => answer( 'map_post', await mapPostHandler( context, args )) );

  server.registerTool( 'map_propose_scenario', {
    title: 'Propose a scenario on a card or an ES artifact',
    description: describe( 'map_propose_scenario' ),
    inputSchema: input( 'map_propose_scenario', mapProposeScenarioInputSchema )
  }, async ( args ) => answer( 'map_propose_scenario',
    strictInputRefusal( 'map_propose_scenario', mapProposeScenarioInputSchema, args )
      ?? await mapProposeScenarioHandler( context, args )
  ));

  server.registerTool( 'map_modify_scenario', {
    title: 'Edit a proposed scenario in place',
    description: describe( 'map_modify_scenario' ),
    inputSchema: input( 'map_modify_scenario', mapModifyScenarioInputSchema )
  }, async ( args ) => answer( 'map_modify_scenario',
    strictInputRefusal( 'map_modify_scenario', mapModifyScenarioInputSchema, args )
      ?? await mapModifyScenarioHandler( context, args )
  ));

  server.registerTool( 'map_propose_observation', {
    title: 'Propose an observation on a card',
    description: describe( 'map_propose_observation' ),
    inputSchema: input( 'map_propose_observation', mapProposeObservationInputSchema )
  }, async ( args ) => answer( 'map_propose_observation',
    strictInputRefusal( 'map_propose_observation', mapProposeObservationInputSchema, args )
      ?? await mapProposeObservationHandler( context, args )
  ));

  server.registerTool( 'map_modify_observation', {
    title: 'Edit a proposed observation in place',
    description: describe( 'map_modify_observation' ),
    inputSchema: input( 'map_modify_observation', mapModifyObservationInputSchema )
  }, async ( args ) => answer( 'map_modify_observation',
    strictInputRefusal( 'map_modify_observation', mapModifyObservationInputSchema, args )
      ?? await mapModifyObservationHandler( context, args )
  ));

  server.registerTool( 'map_strike', {
    title: 'Strike a map node or make a fork moot',
    description: describe( 'map_strike' ),
    inputSchema: input( 'map_strike', mapStrikeInputShape )
  }, async ( args ) => answer( 'map_strike', await mapStrikeHandler( context, args )) );

  server.registerTool( 'map_choose', {
    title: 'Answer a fork with its recommended option',
    description: describe( 'map_choose' ),
    inputSchema: input( 'map_choose', mapChooseInputShape )
  }, async ( args ) => answer( 'map_choose', await mapChooseHandler( context, args )) );

  server.registerTool( 'map_link', {
    title: 'Link an ES node to a map deliverable',
    description: describe( 'map_link' ),
    inputSchema: input( 'map_link', mapLinkInputShape )
  }, async ( args ) => answer( 'map_link', await mapLinkHandler( context, args )) );

  server.registerTool( 'map_unlink', {
    title: 'Remove a link between an ES node and a map deliverable',
    description: describe( 'map_unlink' ),
    inputSchema: input( 'map_unlink', mapLinkInputShape )
  }, async ( args ) => answer( 'map_unlink', await mapUnlinkHandler( context, args )) );

  server.registerTool( 'map_cover', {
    title: 'Record that a scenario covers an ES element',
    description: describe( 'map_cover' ),
    inputSchema: input( 'map_cover', mapCoverInputShape )
  }, async ( args ) => answer( 'map_cover', await mapCoverHandler( context, args )) );

  server.registerTool( 'map_uncover', {
    title: 'Remove a coverage pair',
    description: describe( 'map_uncover' ),
    inputSchema: input( 'map_uncover', mapCoverInputShape )
  }, async ( args ) => answer( 'map_uncover', await mapUncoverHandler( context, args )) );

  server.registerTool( 'map_undo', {
    title: 'Undo your own last map post or choose',
    description: describe( 'map_undo' ),
    inputSchema: {}
  }, async ( args ) => answer( 'map_undo', await mapUndoHandler( context, args )) );

  server.registerTool( 'get_map', {
    title: 'Read the map',
    description: describe( 'get_map' ),
    inputSchema: {}
  }, async () => answer( 'get_map', await getMapHandler( context )) );

  server.registerTool( 'get_card', {
    title: 'Read the card or cards a channel is about',
    description: describe( 'get_card' ),
    inputSchema: input( 'get_card', getCardInputShape )
  }, async ( args ) => answer( 'get_card', await getCardHandler( context, args )) );

  server.registerTool( 'get_map_links', {
    title: 'Read the map-link report',
    description: describe( 'get_map_links' ),
    inputSchema: {}
  }, async () => answer( 'get_map_links', await getMapLinksHandler( context )) );

  server.registerTool( 'get_coverage', {
    title: 'Read the coverage report',
    description: describe( 'get_coverage' ),
    inputSchema: {}
  }, async () => answer( 'get_coverage', await getCoverageHandler( context )) );

  // The design spec family.
  server.registerTool( 'spec_post', {
    title: 'Post design spec entries',
    description: describe( 'spec_post' ),
    inputSchema: input( 'spec_post', specPostInputShape )
  }, async ( args ) => answer( 'spec_post', await specPostHandler( context, args )) );

  server.registerTool( 'spec_strike', {
    title: 'Strike design spec entries',
    description: describe( 'spec_strike' ),
    inputSchema: input( 'spec_strike', specStrikeInputShape )
  }, async ( args ) => answer( 'spec_strike', await specStrikeHandler( context, args )) );

  server.registerTool( 'get_spec', {
    title: 'Read the design spec',
    description: describe( 'get_spec' ),
    inputSchema: {}
  }, async () => answer( 'get_spec', await getSpecHandler( context )) );

  return server;
}
