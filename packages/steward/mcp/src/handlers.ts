import type {
  BlueprintStatusResult,
  CommentBatchInput,
  CommentResult,
  DesignUndoInput,
  DesignUndoResult,
  MapChooseInput,
  MapCoverInput,
  MapGroundInput,
  MapLinkInput,
  MapPostForkInput,
  MapPostInput,
  MapPostNodeInput,
  MapPostObservationInput,
  MapPostResult,
  MapPostScenarioInput,
  MapReadResult,
  MapStrikeInput,
  MapStrikeResult,
  MapUncoverResult,
  MapUndoInput,
  MapUndoResult,
  MapVerbResult,
  MarkSyncedResult,
  ModifyEntryInput,
  ModifyInput,
  OpAuthorFilter,
  OpClassFilter,
  PendingByAuthor,
  ProposeEdgeInput,
  ProposeInput,
  ProposeNodeInput,
  ProposeResult,
  ReadChangesInput,
  ReadChangesResult,
  ReclassifiedEntry,
  ReclassifyInput,
  ReclassifyResult,
  ReclassifyTarget,
  RemoveEntryInput,
  RemoveInput,
  ResolveBatchInput,
  SyncWarning,
  VerbResult
} from '@bett3r-dev/blueprint-spec';
import type {
  CommentAnchor,
  CoverageReport,
  DesignFile,
  DesignValidationIssue,
  EdgeKind,
  ExamplesTable,
  ForkScenarioProposal,
  ForkScenarioReport,
  GherkinStep,
  KpiDefinition,
  KpiDirection,
  KpiEventSide,
  KpiExpectation,
  KpiKind,
  KpiMode,
  KpiSource,
  KpiSourceKind,
  MapLinkReport,
  MapChannelCard,
  MapChannelResolution,
  MapObservation,
  MapScenario,
  ObservationKpi,
  Op,
  RottedHandlerScope,
  SpecFile,
  SpecPostOpPayload,
  SpecStrikeOpPayload,
  StrandingFailure,
  StrandingReport
} from '@bett3r-dev/blueprint-schema';
import { BLUEPRINT_OVERRIDES_FILENAME, cardsForChannel, joinForkScenarios, strandingFailure, withExampleArrays } from '@bett3r-dev/blueprint-schema';

import type { BoardMark, BoardMarksRead } from './board-marks.js';
import { capabilitiesAdvertisement, type CapabilitiesAdvertisement } from './capabilities.js';
import { BlueprintMcpError, isBlueprintMcpError } from './errors.js';
import { flowView, type FlowScope, type FlowView } from './flow.js';
import { isAlreadyRecorded, isHostRefusal } from './hosted-target.js';
import { assertBlueprintDir, readMergedGraph, type MergedGraph } from './merged-graph.js';
import { blueprintPaths } from './paths.js';
import {
  toolFailure,
  type ToolFailure,
  type ToolOutcome,
  type ToolSuccess,
  type WriteOutcome
} from './tool-result.js';
import { FALLBACK_NOTES, type NoteKey } from './tool-text.js';

/**
 * The hosted session a design agent works against: every read and write goes to the Blueprint server, over the
 * routes the spec package names. The checkout itself holds only the extracted graph (.blueprint/graph.json), which
 * get_flow and get_design merge the session's design onto.
 */
export type BlueprintTarget = {
  readDesign(): Promise<DesignFile>;
  readChanges( input?: ReadChangesInput ): Promise<ReadChangesResult>;
  markSynced( seq: number ): Promise<MarkSyncedResult>;
  status(): Promise<BlueprintStatusResult>;
  propose( input: ProposeInput ): Promise<ProposeResult>;
  modify( input: ModifyInput ): Promise<VerbResult>;
  remove( input: RemoveInput ): Promise<VerbResult>;
  comment( input: CommentBatchInput ): Promise<CommentResult>;
  resolve( input: ResolveBatchInput ): Promise<VerbResult>;
  reclassify( input: ReclassifyInput ): Promise<ReclassifyResult>;
  undo( input?: DesignUndoInput ): Promise<DesignUndoResult>;
  undo( input: MapUndoInput ): Promise<MapUndoResult>;
  mapGround( input: MapGroundInput ): Promise<MapVerbResult>;
  mapPost( input: MapPostInput ): Promise<MapPostResult>;
  mapStrike( input: MapStrikeInput ): Promise<MapStrikeResult>;
  mapChoose( input: MapChooseInput ): Promise<MapVerbResult>;
  mapLink( input: MapLinkInput ): Promise<MapVerbResult>;
  mapUnlink( input: MapLinkInput ): Promise<MapVerbResult>;
  mapCover( input: MapCoverInput ): Promise<MapVerbResult>;
  mapUncover( input: MapCoverInput ): Promise<MapUncoverResult>;
  readMap(): Promise<MapReadResult>;
  readMapLinks(): Promise<MapLinkReport>;
  readCoverage(): Promise<CoverageReport>;
  /** What humans painted on the session's board; boardPath names the route it was read from. */
  readBoardMarks: () => Promise<BoardMarksRead & { boardPath: string }>;
  /** A KPI lookup: the server's observability read route, answered through Steward. Nothing runs in this process. */
  kpiLookup: ( request: KpiLookupRequest ) => Promise<KpiLookupAnswer>;
  /** The design spec, read and written on the session. */
  readSpec: () => Promise<SpecRead>;
  specPost: ( input: SpecPostOpPayload ) => Promise<SpecRead>;
  specStrike: ( input: SpecStrikeOpPayload ) => Promise<SpecRead>;
};

/** The spec as the spec route answers it, with the feed seq it reflects. */
export type SpecRead = { seq: number; spec: SpecFile };

export type KpiLookupRequest = { op: 'search'; text: string } | { op: 'resolve'; ref: string };

/** A search entry as the read contract prints it: a panel carries a ref, a metric only its name. */
export type KpiLookupEntry = { kind: 'panel'; ref: string; title: string } | { kind: 'metric'; name: string };

/** What the observability read route answers; never "not found". */
export type KpiLookupAnswer =
  | { status: 'ok'; op: 'search'; entries: KpiLookupEntry[]; count: number }
  | { status: 'ok'; op: 'resolve'; verdict: 'found' | 'missing' }
  | { status: 'unreachable'; op: KpiLookupRequest[ 'op' ]; reason: string };

/** repoPath is the checkout the extracted graph is read from; target is the hosted session. */
export type HandlerContext = {
  repoPath: string;
  target: BlueprintTarget;
  /** The served text of a note a result carries; the fallback when absent. */
  note?: ( key: NoteKey ) => string;
};

function targetOf( context: HandlerContext ): BlueprintTarget {
  return context.target;
}

export type ProposeArgs = {
  nodes?: ProposeNodeInput[];
  edges?: ProposeEdgeInput[];
};

export type ModifyArgs = {
  entries: ModifyEntryInput[];
};

export type RemoveArgs = {
  entries: RemoveEntryInput[];
};

export type DesignSize = {
  proposedNodes: number;
  proposedEdges: number;
  modified: number;
  removed: number;
  comments: number;
  openComments: number;
};

export type ProposeToolResult = StrandingWarning & DesignFindings & {
  seq: number;
  nodeIds: string[];
  designSize: { nodes: number; edges: number };
};

export type VerbToolResult = StrandingWarning & DesignFindings & {
  seq: number;
  designSize: DesignSize;
};

export type DesignFindings = {
  findings?: DesignValidationIssue[];
};

export type StrandingWarning = {
  strandedProposals?: StrandingReport;
  strandingError?: StrandingFailure;
};

function designSize( design: DesignFile ): DesignSize {
  const comments = design.comments ?? [];
  return {
    proposedNodes: design.propose?.nodes?.length ?? 0,
    proposedEdges: design.propose?.edges?.length ?? 0,
    modified: design.modify?.length ?? 0,
    removed: design.remove?.length ?? 0,
    comments: comments.length,
    openComments: comments.filter( comment => comment.resolved !== true ).length
  };
}

export type GetMarksToolResult = {
  boardPath: string;
  boardPresent: boolean;
  count: number;
  marks: BoardMark[];
};

async function runTool<Result>(
  body: () => Promise<ToolOutcome<Result>>
): Promise<ToolOutcome<Result>> {
  try {
    return await body();
  } catch ( cause ){
    return failureOf( cause );
  }
}

function failureOf( cause: unknown ): ToolFailure {
  if ( isHostRefusal( cause )){
    return toolFailure( cause.code, cause.message, cause.details );
  }
  if ( isBlueprintMcpError( cause )){
    return toolFailure( cause.code, cause.message, cause.details );
  }
  const message = cause instanceof Error ? cause.message : String( cause );
  return toolFailure( 'INTERNAL_ERROR', `blueprint-mcp failed to handle the call: ${ message }` );
}

async function runWrite<Result>(
  body: () => Promise<ToolSuccess<Result>>
): Promise<WriteOutcome<Result>> {
  try {
    return await body();
  } catch ( cause ){
    if ( isAlreadyRecorded( cause )){
      return { ok: true, seqs: cause.seqs, replayed: true, ...( cause.id !== undefined ? { id: cause.id } : {}) };
    }
    return failureOf( cause );
  }
}

export async function proposeHandler(
  context: HandlerContext,
  args: ProposeArgs
): Promise<WriteOutcome<ProposeToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, design, nodeIds, strandedProposals, strandingError, findings } = await store.propose({
      ...( args.nodes !== undefined ? { nodes: args.nodes } : {}),
      ...( args.edges !== undefined ? { edges: args.edges } : {}),
      author: 'ai'
    });
    return {
      ok: true,
      seq,
      nodeIds,
      designSize: {
        nodes: design.propose?.nodes?.length ?? 0,
        edges: design.propose?.edges?.length ?? 0
      },
      ...( strandedProposals !== undefined ? { strandedProposals } : {}),
      ...( strandingError !== undefined ? { strandingError } : {}),
      ...( findings !== undefined ? { findings } : {})
    };
  });
}

export async function modifyHandler(
  context: HandlerContext,
  args: ModifyArgs
): Promise<WriteOutcome<VerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, design, findings } = await store.modify({
      entries: args.entries ?? [],
      author: 'ai'
    });
    return {
      ok: true,
      seq,
      designSize: designSize( design ),
      ...( findings !== undefined ? { findings } : {})
    };
  });
}

export async function removeHandler(
  context: HandlerContext,
  args: RemoveArgs
): Promise<WriteOutcome<VerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, design, strandedProposals, strandingError, findings } = await store.remove({
      entries: args.entries ?? [],
      author: 'ai'
    });
    return {
      ok: true,
      seq,
      designSize: designSize( design ),
      ...( strandedProposals !== undefined ? { strandedProposals } : {}),
      ...( strandingError !== undefined ? { strandingError } : {}),
      ...( findings !== undefined ? { findings } : {})
    };
  });
}

export type CommentAnchorArg =
  | { node: string }
  | { edge: { from: string; to: string; kind: EdgeKind } }
  | { commentId: string };

export type CommentArg = {
  anchor?: CommentAnchorArg;
  text: string;
  note?: string;
};

export type CommentArgs = {
  entries: CommentArg[];
};

export type ResolveArgs = {
  entries: { id: string; resolved?: boolean }[];
};

export type CommentToolResult = DesignFindings & {
  seq: number;
  commentIds: string[];
  openComments: number;
  totalComments: number;
};

export type ResolveToolResult = Omit<CommentToolResult, 'commentIds'>;

function toCommentAnchor( anchor: CommentAnchorArg | undefined ): CommentAnchor {
  if ( anchor === undefined ) return null;
  if ( 'node' in anchor ) return anchor.node;
  if ( 'commentId' in anchor ) return { commentId: anchor.commentId };
  return anchor.edge;
}

export async function commentHandler(
  context: HandlerContext,
  args: CommentArgs
): Promise<WriteOutcome<CommentToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, design, commentIds, findings } = await store.comment({
      entries: ( args.entries ?? []).map( entry => ({
        anchor: toCommentAnchor( entry.anchor ),
        text: entry.text,
        ...( entry.note !== undefined ? { note: entry.note } : {})
      })),
      author: 'ai'
    });
    const size = designSize( design );
    return {
      ok: true,
      seq,
      commentIds,
      openComments: size.openComments,
      totalComments: size.comments,
      ...( findings !== undefined ? { findings } : {})
    };
  });
}

export async function resolveHandler(
  context: HandlerContext,
  args: ResolveArgs
): Promise<WriteOutcome<ResolveToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, design } = await store.resolve({
      entries: args.entries ?? [],
      author: 'ai'
    });
    const size = designSize( design );
    return { ok: true, seq, openComments: size.openComments, totalComments: size.comments };
  });
}

export type UndoArgs = Record<string, never>;

export type UndoToolResult = DesignFindings & {
  seq: number;
  undoes: number;
  undoneVerb: string;
  designSize: DesignSize;
};

export async function undoHandler(
  context: HandlerContext,
  _args: UndoArgs
): Promise<WriteOutcome<UndoToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, design, undoes, undoneVerb, findings } = await store.undo({
      author: 'ai'
    });
    return {
      ok: true,
      seq,
      undoes,
      undoneVerb,
      designSize: designSize( design ),
      ...( findings !== undefined ? { findings } : {})
    };
  });
}

export type ReclassifyArgs = {
  entries: ReclassifyTarget[];
};

export type WorkingTreeNote = {
  dirty: boolean;
  path: string;
  note: string;
};

export type ReclassifyToolResult = {
  designSeq?: number;
  overridesSeq?: number;
  moved: ReclassifiedEntry[];
  alreadyPresent: ReclassifyTarget[];
  designSize: DesignSize;
  workingTree: WorkingTreeNote;
};

function workingTreeNote( context: HandlerContext, dirty: boolean ): WorkingTreeNote {
  const key = dirty ? 'reclassify.workingTree.changed' : 'reclassify.workingTree.unchanged';
  return { dirty, path: BLUEPRINT_OVERRIDES_FILENAME, note: context.note?.( key ) ?? FALLBACK_NOTES[ key ] };
}

export async function reclassifyHandler(
  context: HandlerContext,
  args: ReclassifyArgs
): Promise<ToolOutcome<ReclassifyToolResult>> {
  return runTool( async () => {
    const store = targetOf( context );
    const result = await store.reclassify({
      entries: args.entries ?? [],
      author: 'ai'
    });
    return {
      ok: true,
      ...( result.designSeq !== undefined ? { designSeq: result.designSeq } : {}),
      ...( result.overridesSeq !== undefined ? { overridesSeq: result.overridesSeq } : {}),
      moved: result.moved,
      alreadyPresent: result.alreadyPresent,
      designSize: designSize( result.design ),
      workingTree: workingTreeNote( context, result.overridesChanged )
    };
  });
}

export type ReadChangesArgs = {
  sinceSeq?: number;
  class?: OpClassFilter;
  author?: OpAuthorFilter;
};

export type ReadChangesToolResult = {
  sinceSeq: number;
  cursorSeq: number;
  lastSeq: number;
  count: number;
  ops: Op[];
  pendingByAuthor: PendingByAuthor;
  warnings: SyncWarning[];
};

export type MarkSyncedArgs = {
  seq: number;
};

export type MarkSyncedToolResult = {
  seq: number;
  byteOffset: number;
  previousSeq: number;
  lastSeq: number;
};

export async function readChangesHandler(
  context: HandlerContext,
  args: ReadChangesArgs
): Promise<ToolOutcome<ReadChangesToolResult>> {
  return runTool( async () => {
    const store = targetOf( context );
    const changes = await store.readChanges({
      ...( args.sinceSeq !== undefined ? { sinceSeq: args.sinceSeq } : {}),
      ...( args.class !== undefined ? { class: args.class } : {}),
      ...( args.author !== undefined ? { author: args.author } : {})
    });
    return { ok: true, ...changes, count: changes.ops.length };
  });
}

export async function markSyncedHandler(
  context: HandlerContext,
  args: MarkSyncedArgs
): Promise<ToolOutcome<MarkSyncedToolResult>> {
  return runTool( async () => {
    const store = targetOf( context );
    const { cursor, previousSeq, lastSeq } = await store.markSynced( args.seq );
    return { ok: true, seq: cursor.seq, byteOffset: cursor.byteOffset, previousSeq, lastSeq };
  });
}

export type StatusToolResult = BlueprintStatusResult & { capabilities: CapabilitiesAdvertisement };

export async function statusHandler(
  context: HandlerContext
): Promise<ToolOutcome<StatusToolResult>> {
  const capabilities = capabilitiesAdvertisement();
  const outcome = await runTool( async () => {
    const store = targetOf( context );
    return { ok: true as const, ...( await store.status() ), capabilities };
  });
  return outcome.ok ? outcome : { ...outcome, capabilities };
}

export type KpiLookupArgs = {
  op: KpiLookupRequest[ 'op' ];
  text?: string;
  ref?: string;
};

export type KpiLookupToolResult = KpiLookupAnswer;

// Relays the lookup and answers what the host answered, an unreachable reason included, as is.
export async function kpiLookupHandler(
  context: HandlerContext,
  args: KpiLookupArgs
): Promise<ToolOutcome<KpiLookupToolResult>> {
  return runTool<KpiLookupToolResult>( async () => {
    const request: KpiLookupRequest = args.op === 'search' ? { op: 'search', text: args.text ?? '' } : { op: 'resolve', ref: args.ref ?? '' };
    return { ok: true, ...await targetOf( context ).kpiLookup( request ) };
  });
}

export type MapGroundArgs = Omit<MapGroundInput, 'author'>;

export type MapPostArgs = {
  level: MapPostNodeInput[ 'level' ] | 'fork';
  id: string;
  title: string;
  parents?: string[];
  card?: MapPostForkInput[ 'card' ];
  anchor?: string;
  restsOn?: string[];
  testable?: false;
  byFork?: string;
};

export type MapStrikeArgs = Omit<MapStrikeInput, 'author'>;

export type MapChooseArgs = Omit<MapChooseInput, 'author'>;

export type MapLinkArgs = Omit<MapLinkInput, 'author'>;

export type MapVerbToolResult = MapVerbResult;

export type MapStrikeToolResult = MapStrikeResult;

export type MapUndoToolResult = MapUndoResult;

// A decided fork's virtual proposals, each marked derived, and the review judgement of every
// stored derived scenario (joinForkScenarios, computed here on every read).
export type GetMapToolResult = MapReadResult & {
  forkScenarios: Omit<ForkScenarioReport, 'proposals'> & { proposals: Array<ForkScenarioProposal & { derived: true }> };
};

export type GetMapLinksToolResult = MapLinkReport;

export type MapCoverArgs = Omit<MapCoverInput, 'author'>;

export type MapUncoverToolResult = MapVerbResult & { removed: MapUncoverResult[ 'removed' ] };

export type GetCoverageToolResult = CoverageReport;

export async function mapGroundHandler(
  context: HandlerContext,
  args: MapGroundArgs
): Promise<WriteOutcome<MapVerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, map } = await store.mapGround({ shape: args.shape, author: 'ai' });
    return { ok: true, seq, map };
  });
}

export async function mapPostHandler(
  context: HandlerContext,
  args: MapPostArgs
): Promise<WriteOutcome<MapVerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, map } = await store.mapPost( mapPostInput( args ));
    return { ok: true, seq, map };
  });
}

function mapPostInput( args: MapPostArgs ): MapPostNodeInput | MapPostForkInput {
  const forwarded = {
    level: args.level,
    id: args.id,
    title: args.title,
    ...( args.parents !== undefined ? { parents: args.parents } : {}),
    ...( args.card !== undefined ? { card: args.card } : {}),
    ...( args.anchor !== undefined ? { anchor: args.anchor } : {}),
    ...( args.restsOn !== undefined ? { restsOn: args.restsOn } : {}),
    ...( args.testable !== undefined ? { testable: args.testable } : {}),
    ...( args.byFork !== undefined ? { byFork: args.byFork } : {}),
    author: 'ai' as const
  };
  return forwarded as MapPostNodeInput | MapPostForkInput;
}

// The card-chat scenario tools. One entry per call, thin over map-post (level scenario): a propose names no id and
// the host mints one; a modify names the id and carries the full body. The host judges every status rule; the tool
// never reads status to choose what it sends.
export type ScenarioBodyArgs = {
  title: string;
  anchors?: string[];
  covers?: string[];
  given: GherkinStep[];
  when: GherkinStep[];
  then: GherkinStep[];
  examples?: ExamplesTable;
  supersedes?: string;
};

export type MapProposeScenarioArgs = ScenarioBodyArgs;

export type MapModifyScenarioArgs = ScenarioBodyArgs & { id: string };

export type MapScenarioToolResult = {
  seq: number;
  id?: string;
  scenario?: MapScenario;
};

function scenarioInput( args: ScenarioBodyArgs & { id?: string } ): MapPostScenarioInput {
  return {
    level: 'scenario',
    ...( args.id !== undefined ? { id: args.id } : {}),
    title: args.title,
    anchors: args.anchors ?? [],
    given: args.given,
    when: args.when,
    then: args.then,
    ...( args.examples !== undefined ? { examples: args.examples } : {}),
    ...( args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    ...( args.covers !== undefined ? { covers: args.covers } : {}),
    author: 'ai'
  };
}

async function postScenario(
  context: HandlerContext,
  args: ScenarioBodyArgs & { id?: string },
): Promise<WriteOutcome<MapScenarioToolResult>> {
  return runWrite<MapScenarioToolResult>( async () => {
    const { seq, map, id } = await targetOf( context ).mapPost( scenarioInput( args ));
    const scenario = typeof id === 'string' ? map?.scenarios?.find( entry => entry.id === id ) : undefined;
    return {
      ok: true,
      seq,
      ...( typeof id === 'string' ? { id } : {}),
      ...( scenario !== undefined ? { scenario } : {})
    };
  });
}

export async function mapProposeScenarioHandler(
  context: HandlerContext,
  args: MapProposeScenarioArgs
): Promise<WriteOutcome<MapScenarioToolResult>> {
  return postScenario( context, args );
}

export async function mapModifyScenarioHandler(
  context: HandlerContext,
  args: MapModifyScenarioArgs
): Promise<WriteOutcome<MapScenarioToolResult>> {
  return postScenario( context, args );
}

// The card-chat observation tools, thin over map-post (level observation) like the scenario tools. The kpi
// either defines a KPI or references one the APM already tracks by an opaque ref, plus the expected effect. The input
// shape is one object per kpi and per source, so the closed sets read as enums; which fields a mode or source kind
// takes is narrowed here into blueprint-schema's union, and a field foreign to the variant is refused, never forwarded or dropped.
export type KpiEventSideArgs = KpiEventSide;

export type KpiSourceArgs = {
  kind: KpiSourceKind;
  numerator?: KpiEventSideArgs;
  denominator?: KpiEventSideArgs;
  datasource?: string;
  expr?: string;
};

export type KpiDefinitionArgs = {
  kind: KpiKind;
  unit: string;
  percentile?: number;
  source: KpiSourceArgs;
};

export type ObservationKpiArgs = {
  mode: KpiMode;
  definition?: KpiDefinitionArgs;
  ref?: string;
  label?: string;
};

export type KpiExpectationArgs = {
  direction: KpiDirection;
  target: number;
  baseline?: number;
  window: string;
};

export type ObservationBodyArgs = {
  title: string;
  anchors: string[];
  kpi: ObservationKpiArgs;
  expect: KpiExpectationArgs;
  supersedes?: string;
};

export type MapProposeObservationArgs = ObservationBodyArgs;

export type MapModifyObservationArgs = ObservationBodyArgs & { id: string };

export type MapObservationToolResult = {
  seq: number;
  id?: string;
  observation?: MapObservation;
};

function refuseForeign( fields: Record<string, unknown>, path: string, variant: string ): void {
  const foreign = Object.entries( fields ).filter(([ , value ]) => value !== undefined ).map(([ field ]) => `${ path }.${ field }` );
  if ( foreign.length > 0 ){
    throw new BlueprintMcpError(
      'MAP_ENTRY_INVALID',
      `${ variant } does not take ${ foreign.join( ', ' ) }; nothing was written. Re-send the call without it`,
      { fields: foreign }
    );
  }
}

function required<Value>( value: Value | undefined, field: string, variant: string ): Value {
  if ( value === undefined ){
    throw new BlueprintMcpError( 'MAP_ENTRY_INVALID', `${ variant } needs ${ field }; nothing was written`, { fields: [ field ] });
  }
  return value;
}

function kpiSourceOf( source: KpiSourceArgs ): KpiSource {
  const path = 'kpi.definition.source';
  const variant = `a KPI source of kind ${ source.kind }`;
  if ( source.kind === 'query' ){
    refuseForeign({ numerator: source.numerator, denominator: source.denominator }, path, variant );
    return {
      kind: 'query',
      datasource: required( source.datasource, `${ path }.datasource`, variant ),
      expr: required( source.expr, `${ path }.expr`, variant )
    };
  }
  refuseForeign({ datasource: source.datasource, expr: source.expr }, path, variant );
  return {
    kind: 'events',
    numerator: required( source.numerator, `${ path }.numerator`, variant ),
    ...( source.denominator !== undefined ? { denominator: source.denominator } : {})
  };
}

function kpiDefinitionOf( definition: KpiDefinitionArgs ): KpiDefinition {
  return {
    kind: definition.kind,
    unit: definition.unit,
    ...( definition.percentile !== undefined ? { percentile: definition.percentile } : {}),
    source: kpiSourceOf( definition.source )
  };
}

function observationKpiOf( kpi: ObservationKpiArgs ): ObservationKpi {
  const variant = `a kpi of mode ${ kpi.mode }`;
  if ( kpi.mode === 'reference' ){
    refuseForeign({ definition: kpi.definition }, 'kpi', variant );
    return {
      mode: 'reference',
      ref: required( kpi.ref, 'kpi.ref', variant ),
      ...( kpi.label !== undefined ? { label: kpi.label } : {})
    };
  }
  refuseForeign({ ref: kpi.ref, label: kpi.label }, 'kpi', variant );
  return { mode: 'define', definition: kpiDefinitionOf( required( kpi.definition, 'kpi.definition', variant )) };
}

function observationInput( args: ObservationBodyArgs & { id?: string } ): MapPostObservationInput {
  return {
    level: 'observation',
    ...( args.id !== undefined ? { id: args.id } : {}),
    title: args.title,
    anchors: args.anchors,
    kpi: observationKpiOf( args.kpi ),
    expect: {
      direction: args.expect.direction,
      target: args.expect.target,
      ...( args.expect.baseline !== undefined ? { baseline: args.expect.baseline } : {}),
      window: args.expect.window
    },
    ...( args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    author: 'ai'
  };
}

async function postObservation(
  context: HandlerContext,
  args: ObservationBodyArgs & { id?: string },
): Promise<WriteOutcome<MapObservationToolResult>> {
  return runWrite<MapObservationToolResult>( async () => {
    const { seq, map, id } = await targetOf( context ).mapPost( observationInput( args ));
    const observation = typeof id === 'string' ? map?.observations?.find( entry => entry.id === id ) : undefined;
    return {
      ok: true,
      seq,
      ...( typeof id === 'string' ? { id } : {}),
      ...( observation !== undefined ? { observation } : {})
    };
  });
}

export async function mapProposeObservationHandler(
  context: HandlerContext,
  args: MapProposeObservationArgs
): Promise<WriteOutcome<MapObservationToolResult>> {
  return postObservation( context, args );
}

export async function mapModifyObservationHandler(
  context: HandlerContext,
  args: MapModifyObservationArgs
): Promise<WriteOutcome<MapObservationToolResult>> {
  return postObservation( context, args );
}

export async function mapStrikeHandler(
  context: HandlerContext,
  args: MapStrikeArgs
): Promise<WriteOutcome<MapStrikeToolResult>> {
  return runWrite<MapStrikeToolResult>( async () => {
    const store = targetOf( context );
    const { seq, map, orphaned } = await store.mapStrike({ id: args.id, reason: args.reason, ...( args.byFork !== undefined ? { byFork: args.byFork } : {}), author: 'ai' });
    return { ok: true, seq, map, ...( orphaned !== undefined ? { orphaned } : {}) };
  });
}

export async function mapChooseHandler(
  context: HandlerContext,
  args: MapChooseArgs
): Promise<WriteOutcome<MapVerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, map } = await store.mapChoose({
      fork: args.fork,
      option: args.option,
      seenSeq: args.seenSeq,
      ...( args.settledBy !== undefined ? { settledBy: args.settledBy } : {}),
      author: 'ai'
    });
    return { ok: true, seq, map };
  });
}

export async function mapUndoHandler(
  context: HandlerContext,
  _args: UndoArgs
): Promise<ToolOutcome<MapUndoToolResult>> {
  return runTool<MapUndoToolResult>( async () => {
    const store = targetOf( context );
    return { ok: true, ...( await store.undo({ fold: 'map', author: 'ai' }) ) };
  });
}

export type SpecPostArgs = SpecPostOpPayload;

export type SpecStrikeArgs = SpecStrikeOpPayload;

export type SpecToolResult = SpecRead;

// A batch upsert by the caller's ids. The host judges the batch (SPEC_ENTRY_INVALID, CONFLICT_PENDING_SYNC,
// SESSION_FROZEN).
export async function specPostHandler(
  context: HandlerContext,
  args: SpecPostArgs
): Promise<WriteOutcome<SpecToolResult>> {
  return runWrite( async () => ({ ok: true, ...await targetOf( context ).specPost({ entries: args.entries }) }));
}

export async function specStrikeHandler(
  context: HandlerContext,
  args: SpecStrikeArgs
): Promise<WriteOutcome<SpecToolResult>> {
  return runWrite( async () => ({ ok: true, ...await targetOf( context ).specStrike({ entries: args.entries }) }));
}

export async function getSpecHandler(
  context: HandlerContext
): Promise<ToolOutcome<SpecToolResult>> {
  return runTool<SpecToolResult>( async () => ({ ok: true, ...await targetOf( context ).readSpec() }));
}

export async function getMapHandler(
  context: HandlerContext
): Promise<WriteOutcome<GetMapToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const read = await store.readMap();
    const { proposals, derived } = joinForkScenarios( withExampleArrays( read.map ));
    return { ok: true, ...read, forkScenarios: { proposals: proposals.map( proposal => ({ derived: true as const, ...proposal })), derived } };
  });
}

export type GetCardArgs = {
  key: string;
};

// A scenario as get_card shows it: the stored entry plus the eventstorming ids its coverage pairs name,
// the covers a map_modify_scenario re-sends.
export type CardScenario = MapScenario & { covers: string[] };

export type CardWithExamples = MapChannelCard & {
  scenarios: CardScenario[];
  observations: MapObservation[];
};

export type GetCardToolResult = {
  key: string;
  channel: MapChannelResolution[ 'channel' ];
  cards: CardWithExamples[];
  // The scenarios whose coverage names the key: what an eventstorming artifact's own channel holds.
  coveringScenarios: CardScenario[];
  mapSeq: number;
};

// Resolve a channel key to its card or cards, through the rule the board shares
// (blueprint-schema cardsForChannel), each with the examples anchored on it in every status. Computed from
// readMap alone.
export async function getCardHandler(
  context: HandlerContext,
  args: GetCardArgs
): Promise<ToolOutcome<GetCardToolResult>> {
  return runTool( async () => {
    const { map, mapSeq } = await targetOf( context ).readMap();
    const scenarios = map.scenarios ?? [];
    const observations = map.observations ?? [];
    const coverage = map.coverage ?? [];
    const withCovers = ( scenario: MapScenario ): CardScenario => ( {
      ...scenario,
      covers: coverage.filter( pair => pair.scenarioId === scenario.id ).map( pair => pair.esId )
    });
    const resolution = cardsForChannel( map, args.key );
    const cards = resolution.cards.map(( card ): CardWithExamples => {
      const id = card.kind === 'node' ? card.node.id : card.fork.id;
      return {
        ...card,
        scenarios: scenarios.filter( scenario => scenario.anchors.includes( id )).map( withCovers ),
        observations: observations.filter( observation => observation.anchors.includes( id ))
      };
    });
    const coveringScenarios = resolution.channel === 'map-general'
      ? []
      : scenarios.filter( scenario => coverage.some( pair => pair.scenarioId === scenario.id && pair.esId === args.key )).map( withCovers );
    return { ok: true, key: args.key, channel: resolution.channel, cards, coveringScenarios, mapSeq };
  });
}

export async function mapLinkHandler(
  context: HandlerContext,
  args: MapLinkArgs
): Promise<WriteOutcome<MapVerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, map } = await store.mapLink({ esId: args.esId, deliverableId: args.deliverableId, author: 'ai' });
    return { ok: true, seq, map };
  });
}

export async function mapUnlinkHandler(
  context: HandlerContext,
  args: MapLinkArgs
): Promise<WriteOutcome<MapVerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, map } = await store.mapUnlink({ esId: args.esId, deliverableId: args.deliverableId, author: 'ai' });
    return { ok: true, seq, map };
  });
}

export async function getMapLinksHandler(
  context: HandlerContext
): Promise<ToolOutcome<GetMapLinksToolResult>> {
  return runTool( async () => {
    const store = targetOf( context );
    return { ok: true, ...( await store.readMapLinks() ) };
  });
}

// One coverage pair per call, the map_link shape.
export async function mapCoverHandler(
  context: HandlerContext,
  args: MapCoverArgs
): Promise<WriteOutcome<MapVerbToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, map } = await store.mapCover({ esId: args.esId, scenarioId: args.scenarioId, author: 'ai' });
    return { ok: true, seq, map };
  });
}

export async function mapUncoverHandler(
  context: HandlerContext,
  args: MapCoverArgs
): Promise<WriteOutcome<MapUncoverToolResult>> {
  return runWrite( async () => {
    const store = targetOf( context );
    const { seq, map, removed } = await store.mapUncover({ esId: args.esId, scenarioId: args.scenarioId, author: 'ai' });
    return { ok: true, seq, map, removed };
  });
}

export async function getCoverageHandler(
  context: HandlerContext
): Promise<ToolOutcome<GetCoverageToolResult>> {
  return runTool( async () => {
    const store = targetOf( context );
    return { ok: true, ...( await store.readCoverage() ) };
  });
}

export type GetFlowArgs = {
  rootCommand: string;
  scope?: FlowScope;
};

export type GetFlowToolResult = FlowView & {
  designError?: string;
  handlerScopeRejections?: RottedHandlerScope[];
  strandedProposals?: StrandingReport;
};

export type GetDesignToolResult = {
  design: DesignFile;
  designSize: DesignSize;
  strandedProposals?: StrandingReport;
  realityError?: StrandingFailure;
};

export async function getFlowHandler(
  context: HandlerContext,
  args: GetFlowArgs
): Promise<ToolOutcome<GetFlowToolResult>> {
  return runTool( async () => {
    const merged = await readMergedGraph( blueprintPaths( context.repoPath ), () => targetOf( context ).readDesign());
    return {
      ok: true,
      ...flowView( merged.graph, args.rootCommand, args.scope ),
      ...( merged.designError !== undefined ? { designError: merged.designError } : {}),
      ...( merged.handlerScopeRejections !== undefined
        ? { handlerScopeRejections: merged.handlerScopeRejections }
        : {}),
      ...( merged.strandedProposals !== undefined
        ? { strandedProposals: merged.strandedProposals }
        : {})
    };
  });
}

export async function getDesignHandler(
  context: HandlerContext
): Promise<ToolOutcome<GetDesignToolResult>> {
  return runTool( async () => {
    const store = targetOf( context );
    await assertBlueprintDir( blueprintPaths( context.repoPath ));
    const design = await store.readDesign();
    let merged: MergedGraph | undefined;
    let realityError: StrandingFailure | undefined;
    try {
      merged = await readMergedGraph( blueprintPaths( context.repoPath ), async () => design );
    } catch ( cause ){
      const failure = strandingFailure( cause );
      realityError = {
        code: failure.code,
        message: `${ failure.message } — reporting the design document without a stranding report`
      };
    }
    return {
      ok: true,
      design,
      designSize: designSize( design ),
      ...( merged?.strandedProposals !== undefined
        ? { strandedProposals: merged.strandedProposals }
        : {}),
      ...( realityError !== undefined ? { realityError } : {})
    };
  });
}

export async function getMarksHandler(
  context: HandlerContext
): Promise<ToolOutcome<GetMarksToolResult>> {
  return runTool( async () => {
    const { boardPath, present, marks } = await targetOf( context ).readBoardMarks();
    return {
      ok: true,
      boardPath,
      boardPresent: present,
      count: marks.length,
      marks
    };
  });
}
