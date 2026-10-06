import type {
  BlueprintOverrides,
  CommentAnchor,
  CoverageLink,
  DesignAuthor,
  DesignFile,
  DesignUndoableOpVerb,
  DesignValidationIssue,
  EdgeKind,
  EdgeKindSource,
  ExampleStatusRestore,
  ManualEdge,
  ManualNode,
  MapEntryId,
  MapFile,
  MapLink,
  MapPostForkEntry,
  MapPostNodeEntry,
  MapPostObservationEntry,
  MapPostScenarioEntry,
  MapShape,
  MapStatusRestore,
  MapStrikeOpPayload,
  MapWithdrawal,
  ModifiableNodeFields,
  NodePatch,
  NodeType,
  Op,
  OpClass,
  ReadModelQuery,
  StrandingFailure,
  StrandingReport,
  UndoFold
} from '@bett3r-dev/blueprint-schema';

// --- Sessions ---

export declare const SESSION_HEADER: 'x-blueprint-session-id';
export declare const SUBMIT_ROUTE: '/api/blueprint/submit';
export declare const CHANGES_ROUTE: '/api/blueprint/changes';
export declare const MARK_SYNCED_ROUTE: '/api/blueprint/mark-synced';
export declare const SYNC_STATUS_ROUTE: '/api/blueprint/sync-status';
export declare const MAP_ROUTE: '/api/blueprint/map';
export declare const SPEC_ROUTE: '/api/blueprint/spec';
export declare const API_BLUEPRINT_GRAPH_JSON: '/api/.blueprint/graph.json';
export declare const API_BLUEPRINT_DESIGN_JSON: '/api/.blueprint/design.json';
export declare const API_BOARD_JSON: '/api/board.json';
export declare const TOOL_TEXT_ROUTE: '/api/blueprint/tool-text';
export declare const TOOL_TEXT_VERSION: 1;
export declare function observabilityReadRoute( sessionId: string ): string;

/**
 * What TOOL_TEXT_ROUTE answers: the MCP's instructions; each tool's description by tool name; by tool name and field
 * path, an input field's description; by tool name and error code, the recovery a refusal carries; and by key, the
 * text of a note a result carries. A field path joins property names with `.`, marks an array's element with `[]` and
 * a discriminated union's variant with its discriminator value: `nodes[].label`, `entries[].edge.from`. The MCP
 * overlays what it knows and ignores any other key.
 */
export type ToolText = {
  version: typeof TOOL_TEXT_VERSION;
  instructions?: string;
  tools?: Record<string, string>;
  fields?: Record<string, Record<string, string>>;
  recovery?: Record<string, Record<string, string>>;
  notes?: Record<string, string>;
};

// --- Steward ---

export declare const REALITY_PUSH_ROUTE: '/api/blueprint/reality';
export declare const STEWARD_ROUTE_PREFIX: '/api/blueprint/steward';
export declare const LEGACY_STEWARD_ROUTE_PREFIX: '/api/blueprint/runner';
export declare const STEWARD_JOBS_ROUTE: '/api/blueprint/steward/jobs';
export declare const STEWARD_CLAIM_ROUTE: '/api/blueprint/steward/claim';
export declare const STEWARD_SIGNALS_ROUTE: '/api/blueprint/steward/signals';
export declare function legacyRouteOf( route: string ): string | undefined;
export declare const RUNNER_JOBS_ROUTE: '/api/blueprint/runner/jobs';
export declare const RUNNER_CLAIM_ROUTE: '/api/blueprint/runner/claim';
export declare const RUNNER_SIGNALS_ROUTE: '/api/blueprint/runner/signals';
export declare const BRANCHES_ROUTE: '/api/blueprint/branches';
export declare const BRANCH_MERGED_ROUTE: '/api/blueprint/branches/merged';
export declare const BRANCH_DELETED_ROUTE: '/api/blueprint/branches/deleted';
export declare const BRANCH_CLOSED_ROUTE: '/api/blueprint/branches/closed';
export declare const RUNNER_JOB_HEARTBEAT_SEGMENT: 'heartbeat';
export declare const RUNNER_JOB_BUNDLE_SEGMENT: 'bundle';
export declare const RUNNER_JOB_METHOD_SEGMENT: 'method';
export declare const RUNNER_JOB_ACTIVITY_SEGMENT: 'activity';
export declare function stewardJobRoute( jobId: string, segment?: string ): string;
export declare function runnerJobRoute( jobId: string, segment?: string ): string;
export declare const RUNNER_JOB_NOT_CLAIMED: 'RUNNER_JOB_NOT_CLAIMED';

// --- Jobs ---

export declare const RUNNER_JOB_KINDS: readonly [
  'design', 'git-poll', 'drop-worktree', 'flush', 'tracker-poll', 'tracker-comment', 'ticket-branch', 'observability-read',
  'implementation-dispatch', 'tracker-transition', 'tracker-describe', 'scaffold', 'pr-ready'
];
export type RunnerJobKind = typeof RUNNER_JOB_KINDS[ number ];

export declare const AGENT_STEPS: readonly [ 'intake', 'branch', 'worktree', 'extract', 'push', 'agent' ];
export type AgentStep = typeof AGENT_STEPS[ number ];
export declare const SERVER_AGENT_STEPS: readonly [ 'intake' ];
export type RunnerJobStep = Exclude<AgentStep, typeof SERVER_AGENT_STEPS[ number ]>;
export declare const RUNNER_JOB_STEPS: readonly RunnerJobStep[];

export declare const RUNNER_REPORT_REASONS: readonly [
  'agent-error', 'limit-wallclock', 'auth-failed', 'claude-not-logged-in', 'rate-limited', 'claude-missing',
  'checkout-failed', 'instructions-missing', 'tools-missing', 'tools-beyond-ceiling', 'kind-unknown', 'wrong-repo',
  'non-ff', 'branch-missing', 'push-rejected', 'diverged', 'config-invalid',
  'method-missing', 'method-unavailable', 'method-mismatch', 'method-not-loaded'
];
export type RunnerReportReason = typeof RUNNER_REPORT_REASONS[ number ];

/** One thing a design job did, as the board shows it. It never carries a tool's input or result, nor text. */
export type ActivityEntry =
  | { at: string; kind: 'step'; name: string }
  | { at: string; kind: 'tool'; name: string }
  | { at: string; kind: 'text' }
  | { at: string; kind: 'end'; name: 'done' | 'failed' };
export declare const ACTIVITY_BATCH_MAX: 50;

export declare const RUNNER_HEARTBEAT_MAX_SECONDS: 600;
export declare const METHOD_MIN_RUNNER_VERSION: string;
export declare function runnerMeets( version: string | undefined, minimum: string ): boolean;

// --- Repositories ---

export declare function normalizeRemoteUrl( remoteUrl: string ): string;

// --- Implementation ---

export declare const AGENT_BRANCH_PREFIX: 'claude/';
export declare function agentBranchOf( ticketBranch: string ): string;
export declare const SIGNAL_TRAILER_KEY_DEFAULT: 'Blueprint-Status';
export declare const SIGNAL_TRAILER_KEY_PATTERN: RegExp;
export declare const SIGNAL_WORKING: 'working';
export declare const SIGNAL_DONE: 'done';
export declare const SIGNAL_NEEDS_HUMAN: 'needs-human';
export declare const SIGNAL_REJECTED: 'rejected';
export declare const SIGNAL_FAILED: 'failed';
export type SignalValue = 'working' | 'done' | 'needs-human' | 'rejected' | 'failed';
export declare const SIGNAL_VALUES: readonly SignalValue[];

/**
 * A signal as Steward reports it to STEWARD_SIGNALS_ROUTE: the commit's sha, the trailer key it was read under, the
 * value, the commit's subject, and its body without the trailer block (absent from a Steward older than 1.3.0).
 */
export type CommitSignal = { sha: string; key: string; value: string; subject: string; body?: string };

// --- Specification v1 ---

export declare const SPECIFICATION_VERSION: 1;
export declare const DESIGN_SESSION_TRAILER: 'Blueprint-Session';
export declare const DESIGN_SEQ_TRAILER: 'Blueprint-Seq';
export declare const DESIGN_ACTORS_TRAILER: 'Blueprint-Actors';
export declare const SCAFFOLD_TRAILER: 'Blueprint-Scaffold';
export type ScaffoldStatus = 'done' | 'blocked' | 'skipped';
export declare const SCAFFOLD_STATUSES: readonly ScaffoldStatus[];
export declare const SCAFFOLD_GAP_MARKER: 'TODO(scaffold)';
export declare const BLUEPRINT_CONFIG_FILE: '.blueprint.config.json';
export declare const DOCS_ROOT_DEFAULT: 'docs/prs';
export declare const DESIGN_FILE: 'blueprint.md';
export declare const SCAFFOLD_REPORT_FILE: 'scaffold.json';
export declare const PULL_REQUEST_FILE: 'pull-request.md';
export declare function itemDocsPathOf( docsRoot: string, key: string, file?: string ): string;

/**
 * The text an implementation agent's routine is fired with, one JSON object. `branch` is the ticket branch and
 * `agentBranch` the only branch the agent pushes; `design` is the path of the item's blueprint.md on `branch`; `signal`
 * the trailer key the agent signals under; `answer` the reply to the agent's last needs-human, null for none; `options`
 * what the agent's settings name, passed through untouched.
 */
export type FirePayload = {
  specification: typeof SPECIFICATION_VERSION;
  key: string;
  title: string | null;
  branch: string;
  agentBranch: string;
  pullRequest: string | null;
  design: string;
  signal: string;
  answer: string | null;
  options: Record<string, unknown>;
};

// --- Scaffold ---

export declare const SCAFFOLD_EXIT_OK: 0;
export declare const SCAFFOLD_EXIT_ERROR: 1;
export declare const SCAFFOLD_EXIT_USAGE: 2;
export declare const SCAFFOLD_EXIT_BLOCKED: 3;

// --- The session wire: what a verb posted to SUBMIT_ROUTE takes, and what a read answers ---

export type OpClassFilter = OpClass | 'all';
export type OpAuthorFilter = DesignAuthor | 'system' | 'all';

/** What a session's feed holds that its cursor has not reached, by who wrote it. */
export type PendingByAuthor = {
  human: number;
  ai: number;
};

export type SyncWarning =
  | { code: 'FOREIGN_AI_OPS'; message: string; writerIds: string[]; seqs: number[] }
  | { code: 'FOREIGN_CURSOR'; message: string; writerId: string; cursorSeq: number }
  | { code: 'MIXED_WRITER_VERSIONS'; message: string; writerShas: string[] }
  | { code: 'BROKEN_OP_CHAIN'; message: string; firstBrokenSeq: number; opsAfterBreak: number };

export type ProposeNodeInput = {
  type: NodeType;
  label: string;
  subdomain: string;
  resourceKey?: string;
  queries?: ReadModelQuery[];
  rule?: string;
  errorCodes?: string[];
  generic?: boolean;
  note?: string;
};

export type ProposeEdgeInput = {
  from: string;
  to: string;
  kind: EdgeKind;
  kindSource?: EdgeKindSource;
  handlers?: string[];
  note?: string;
};

export type ProposeInput = { nodes?: ProposeNodeInput[]; edges?: ProposeEdgeInput[]; author?: DesignAuthor };

export type ModifyEntryInput = { id: string; set: Partial<ModifiableNodeFields>; note?: string };
export type ModifyInput = { entries: ModifyEntryInput[]; author?: DesignAuthor };

export type RemoveEntryInput =
  | { kind: 'node'; id: string; note?: string }
  | { kind: 'edge'; from: string; to: string; edgeKind: EdgeKind; note?: string };
export type RemoveInput = { entries: RemoveEntryInput[]; author?: DesignAuthor };

export type CommentInput = { anchor: CommentAnchor; text: string; note?: string };
export type CommentBatchInput = { entries: CommentInput[]; author?: DesignAuthor };

export type ResolveEntryInput = { id: string; resolved?: boolean };
export type ResolveBatchInput = { entries: ResolveEntryInput[]; author?: DesignAuthor };

/** A design entry a reclassify verb moves into the repository's overrides. */
export type ReclassifyTarget =
  | { kind: 'proposed-node'; id: string }
  | { kind: 'proposed-edge'; from: string; to: string; edgeKind: EdgeKind }
  | { kind: 'modified-node'; id: string };
export type ReclassifiedEntry =
  | { operation: 'add-node'; node: ManualNode }
  | { operation: 'add-edge'; edge: ManualEdge }
  | { operation: 'patch-node'; patch: NodePatch };
export type ReclassifyInput = { entries: ReclassifyTarget[]; author?: DesignAuthor };

export type VerbResult = {
  seq: number;
  design: DesignFile;
  strandedProposals?: StrandingReport;
  strandingError?: StrandingFailure;
  findings?: DesignValidationIssue[];
};
export type ProposeResult = VerbResult & { nodeIds: string[] };
export type CommentResult = VerbResult & { commentIds: string[] };
export type ReclassifyResult = {
  designSeq?: number;
  overridesSeq?: number;
  design: DesignFile;
  overrides?: BlueprintOverrides;
  moved: ReclassifiedEntry[];
  alreadyPresent: ReclassifyTarget[];
  overridesChanged: boolean;
  overridesPath?: string;
};

export type ReadChangesInput = { sinceSeq?: number; class?: OpClassFilter; author?: OpAuthorFilter };
export type ReadChangesResult = {
  sinceSeq: number;
  cursorSeq: number;
  lastSeq: number;
  ops: Op[];
  pendingByAuthor: PendingByAuthor;
  warnings: SyncWarning[];
};
export type MarkSyncedResult = {
  cursor: { seq: number; byteOffset: number; writerId?: string; ts?: string };
  previousSeq: number;
  lastSeq: number;
};
export type BlueprintStatusResult = {
  repoPath?: string;
  gitSha: string;
  lastSeq: number;
  cursorSeq: number;
  pendingByAuthor: PendingByAuthor;
  lockState: { held: false } | { held: true; owner?: unknown; heldForMs: number; stale: boolean };
  warnings: SyncWarning[];
};

export type UndoInput = { author?: DesignAuthor; fold?: UndoFold };
export type DesignUndoInput = UndoInput & { fold?: 'design' };
export type MapUndoInput = UndoInput & { fold: 'map' };
export type DesignUndoResult = VerbResult & { fold: 'design'; undoes: number; undoneVerb: DesignUndoableOpVerb };

export type MapVerbResult = { seq: number; map: MapFile };
export type MapPostResult = MapVerbResult & { id: MapEntryId };
export type MapUndoResult = MapVerbResult & { fold: 'map'; undoes: number } & (
  | { undoneVerb: 'map-post'; withdrawal: MapWithdrawal }
  | { undoneVerb: 'map-choose'; restore: MapStatusRestore }
  | { undoneVerb: 'map-agree'; restore: ExampleStatusRestore[] }
  | { undoneVerb: 'map-link' | 'map-unlink'; link: MapLink; changed: boolean }
  | { undoneVerb: 'map-cover' | 'map-uncover'; pairs: CoverageLink[] }
);
export type UndoResult = DesignUndoResult | MapUndoResult;
export type MapStrikeResult = MapVerbResult & { orphaned?: string[] };
export type MapUncoverResult = MapVerbResult & { removed: CoverageLink[] };
/** A map read: the map and the seq of the feed it folded. */
export type MapReadResult = { map: MapFile; mapSeq: number };

export type MapGroundInput = { shape: MapShape; author?: DesignAuthor };
export type MapPostNodeInput = Omit<MapPostNodeEntry, 'parents'> & { parents?: MapEntryId[]; author?: DesignAuthor };
export type MapPostForkInput = Omit<MapPostForkEntry, 'restsOn'> & { restsOn?: MapEntryId[]; author?: DesignAuthor };
export type MapPostScenarioInput = MapPostScenarioEntry & { author?: DesignAuthor };
export type MapPostObservationInput = MapPostObservationEntry & { author?: DesignAuthor };
export type MapPostInput = MapPostNodeInput | MapPostForkInput | MapPostScenarioInput | MapPostObservationInput;
export type MapStrikeInput = MapStrikeOpPayload & { author?: DesignAuthor };
export type MapChooseInput = { fork: string; option: string; seenSeq: number; author?: DesignAuthor; settledBy?: 'code' };
export type MapLinkInput = { esId: string; deliverableId: string; author?: DesignAuthor };
export type MapCoverInput = { esId: string; scenarioId: string; author?: DesignAuthor };
