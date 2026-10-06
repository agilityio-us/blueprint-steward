// What the Blueprint server and Steward must agree on: the routes Steward calls, the jobs it is handed, how it reports
// them, the signals it reads off commits and the exit codes it acts on. Values only; no behaviour of either side.
// Every export is mirrored in index.d.ts.

// --- Sessions: the routes a design agent's MCP server reads and writes a hosted session through ---

/** The header naming the session a request addresses. */
export const SESSION_HEADER = 'x-blueprint-session-id';

export const SUBMIT_ROUTE = '/api/blueprint/submit';
export const CHANGES_ROUTE = '/api/blueprint/changes';
export const MARK_SYNCED_ROUTE = '/api/blueprint/mark-synced';
export const SYNC_STATUS_ROUTE = '/api/blueprint/sync-status';
export const MAP_ROUTE = '/api/blueprint/map';
/** The session's design spec as its feed folds it: `{ ok, seq, spec }`. */
export const SPEC_ROUTE = '/api/blueprint/spec';
export const API_BLUEPRINT_GRAPH_JSON = '/api/.blueprint/graph.json';
export const API_BLUEPRINT_DESIGN_JSON = '/api/.blueprint/design.json';
export const API_BOARD_JSON = '/api/board.json';
/** The design MCP's model-facing text, read once at its start with the job key; answers a ToolText document. */
export const TOOL_TEXT_ROUTE = '/api/blueprint/tool-text';
/** The ToolText version this MCP reads; a document of any other version is not overlaid. */
export const TOOL_TEXT_VERSION = 1;

/** The route a KPI lookup posts to; the server holds it open while Steward answers an observability-read job. */
export const observabilityReadRoute = ( sessionId ) => `/api/blueprint/sessions/${ encodeURIComponent( sessionId ) }/observability/read`;

// --- Steward: the routes Steward polls and reports on ---

/** Where `push` sends the extracted graph and diagnostics. */
export const REALITY_PUSH_ROUTE = '/api/blueprint/reality';
/** The prefix of the job, claim and signal routes. */
export const STEWARD_ROUTE_PREFIX = '/api/blueprint/steward';
/** The same routes under the component's former name, which a server still serves, and the only ones an older one does. */
export const LEGACY_STEWARD_ROUTE_PREFIX = '/api/blueprint/runner';
export const STEWARD_JOBS_ROUTE = `${ STEWARD_ROUTE_PREFIX }/jobs`;
export const STEWARD_CLAIM_ROUTE = `${ STEWARD_ROUTE_PREFIX }/claim`;
export const STEWARD_SIGNALS_ROUTE = `${ STEWARD_ROUTE_PREFIX }/signals`;
/** A route under STEWARD_ROUTE_PREFIX spelled under LEGACY_STEWARD_ROUTE_PREFIX; undefined for any other route. */
export const legacyRouteOf = ( route ) => ( /^\/api\/blueprint\/steward(?=$|[/?])/.test( route )
  ? `${ LEGACY_STEWARD_ROUTE_PREFIX }${ route.slice( STEWARD_ROUTE_PREFIX.length ) }`
  : undefined );
/** The legacy spellings of STEWARD_JOBS_ROUTE, STEWARD_CLAIM_ROUTE and STEWARD_SIGNALS_ROUTE. */
export const RUNNER_JOBS_ROUTE = '/api/blueprint/runner/jobs';
export const RUNNER_CLAIM_ROUTE = '/api/blueprint/runner/claim';
export const RUNNER_SIGNALS_ROUTE = '/api/blueprint/runner/signals';
/** The live branches the server holds for a repository, `?remoteUrl=`. */
export const BRANCHES_ROUTE = '/api/blueprint/branches';
export const BRANCH_MERGED_ROUTE = '/api/blueprint/branches/merged';
export const BRANCH_DELETED_ROUTE = '/api/blueprint/branches/deleted';
export const BRANCH_CLOSED_ROUTE = '/api/blueprint/branches/closed';

/** Sub-routes of a claimed job, `${ RUNNER_JOBS_ROUTE }/:id/<segment>`. */
export const RUNNER_JOB_HEARTBEAT_SEGMENT = 'heartbeat';
export const RUNNER_JOB_BUNDLE_SEGMENT = 'bundle';
export const RUNNER_JOB_METHOD_SEGMENT = 'method';
export const RUNNER_JOB_ACTIVITY_SEGMENT = 'activity';

/** The route of a claimed job, or of one of its sub-routes. */
export const stewardJobRoute = ( jobId, segment ) => `${ STEWARD_JOBS_ROUTE }/${ encodeURIComponent( jobId ) }${ segment === undefined ? '' : `/${ segment }` }`;
/** stewardJobRoute's legacy spelling. */
export const runnerJobRoute = ( jobId, segment ) => `${ RUNNER_JOBS_ROUTE }/${ encodeURIComponent( jobId ) }${ segment === undefined ? '' : `/${ segment }` }`;

/** The refusal code of a heartbeat for a job the server no longer holds as claimed with a live lease. */
export const RUNNER_JOB_NOT_CLAIMED = 'RUNNER_JOB_NOT_CLAIMED';

// --- Jobs ---

/** Every kind of job the server hands Steward. A claim naming any other kind is refused. */
export const RUNNER_JOB_KINDS = Object.freeze( [
  'design', 'git-poll', 'drop-worktree', 'flush', 'tracker-poll', 'tracker-comment', 'ticket-branch', 'observability-read',
  'implementation-dispatch', 'tracker-transition', 'tracker-describe', 'scaffold', 'pr-ready',
] );

/** The steps of a design intake, in order: the server's own `intake`, then the steps Steward heartbeats. */
export const AGENT_STEPS = Object.freeze( [ 'intake', 'branch', 'worktree', 'extract', 'push', 'agent' ] );
/** The steps the server takes itself, which Steward never reports. */
export const SERVER_AGENT_STEPS = Object.freeze( [ 'intake' ] );
/** The steps a heartbeat may name: every agent step but the server's, in the same order. */
export const RUNNER_JOB_STEPS = Object.freeze( AGENT_STEPS.filter( ( step ) => !SERVER_AGENT_STEPS.includes( step ) ) );

/** The failure reasons Steward may report. The server stores any other as `agent-error`. */
export const RUNNER_REPORT_REASONS = Object.freeze( [
  'agent-error', 'limit-wallclock', 'auth-failed', 'claude-not-logged-in', 'rate-limited', 'claude-missing',
  'checkout-failed', 'instructions-missing', 'tools-missing', 'tools-beyond-ceiling', 'kind-unknown', 'wrong-repo',
  'non-ff', 'branch-missing', 'push-rejected', 'diverged', 'config-invalid',
  'method-missing', 'method-unavailable', 'method-mismatch', 'method-not-loaded',
] );

/** The most activity entries one post carries. */
export const ACTIVITY_BATCH_MAX = 50;

/** The longest heartbeat interval the server accepts, in seconds. */
export const RUNNER_HEARTBEAT_MAX_SECONDS = 600;

/** The lowest Steward version the server hands a design job to: the first to load the method plugin a claim names. */
export const METHOD_MIN_RUNNER_VERSION = '1.2.0';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/** Whether `version` is at least `minimum`. A version that is absent or not x.y.z is not. */
export const runnerMeets = ( version, minimum ) => {
  const have = VERSION.exec( version ?? '' );
  const need = VERSION.exec( minimum ?? '' );
  if ( have === null || need === null ) return false;
  for ( let i = 1; i <= 3; i += 1 ) if ( Number( have[ i ] ) !== Number( need[ i ] ) ) return Number( have[ i ] ) > Number( need[ i ] );
  return true;
};

// --- Repositories ---

/**
 * A git remote URL as the server keys a repository: `host/owner/name`, lowercase. The scheme, userinfo, a numeric
 * port and `.git` are dropped, and an scp-style `:` becomes `/`, so every transport spelling of one repository is
 * one key.
 */
export const normalizeRemoteUrl = ( remoteUrl ) => {
  const schemeless = remoteUrl.trim().replace( /^[a-z][a-z0-9+.-]*:\/\//i, '' );
  const userless = schemeless.replace( /^[^/@]*@/, '' );
  const [ hostPart, ...rest ] = userless.split( '/' );
  const host = ( hostPart ?? '' ).replace( /:\d+$/, '' ).replace( ':', '/' );
  return [ host, ...rest ].join( '/' ).replace( /\.git$/i, '' ).replace( /\/+$/, '' ).replace( /\/{2,}/g, '/' ).toLowerCase();
};

// --- Implementation: the branch a cloud agent works on and the signals it leaves ---

/**
 * A ticket branch's agent branch is this prefix and the ticket branch. A cloud session's push to a branch holding
 * another author's commits is refused unless its name starts with it.
 */
export const AGENT_BRANCH_PREFIX = 'claude/';
export const agentBranchOf = ( ticketBranch ) => `${ AGENT_BRANCH_PREFIX }${ ticketBranch }`;

/** The commit trailer a branch's signals are read from, when the server's branch list names none. */
export const SIGNAL_TRAILER_KEY_DEFAULT = 'Blueprint-Status';
/** The form a trailer key takes; a key outside it is never read. */
export const SIGNAL_TRAILER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/**
 * The signal values. The latest value on the agent branch is the item's state: `working` is a heartbeat; `done` has the
 * agent branch merged and the pull request readied; `needs-human` asks, in its commit's subject, a question a tracker
 * comment answers; `rejected` says, in its commit's body, why the design or scaffold cannot be delivered as given;
 * `failed` says there why the agent could not run. Any other value is recorded and moves nothing.
 */
export const SIGNAL_WORKING = 'working';
export const SIGNAL_DONE = 'done';
export const SIGNAL_NEEDS_HUMAN = 'needs-human';
export const SIGNAL_REJECTED = 'rejected';
export const SIGNAL_FAILED = 'failed';
export const SIGNAL_VALUES = Object.freeze( [ SIGNAL_WORKING, SIGNAL_DONE, SIGNAL_NEEDS_HUMAN, SIGNAL_REJECTED, SIGNAL_FAILED ] );

// --- Specification v1: the fire an implementation agent starts from, and the files and trailers it works by ---

/** The version of the contract a fire payload's `specification` names. */
export const SPECIFICATION_VERSION = 1;
/** The trailers of a design commit on the ticket branch. */
export const DESIGN_SESSION_TRAILER = 'Blueprint-Session';
export const DESIGN_SEQ_TRAILER = 'Blueprint-Seq';
export const DESIGN_ACTORS_TRAILER = 'Blueprint-Actors';
/** The trailer of a scaffold commit, valued with the item's key; the latest such commit on the ticket branch is in force. */
export const SCAFFOLD_TRAILER = 'Blueprint-Scaffold';
/** What scaffold.json's `status` says: the scaffold placed everything, could not place some of it, or did not run. */
export const SCAFFOLD_STATUSES = Object.freeze( [ 'done', 'blocked', 'skipped' ] );
/** The marker of a line the scaffold left for the agent to fill; every other line it added is the design's. */
export const SCAFFOLD_GAP_MARKER = 'TODO(scaffold)';
/** The repository's Blueprint config, and the docs root when it names none. */
export const BLUEPRINT_CONFIG_FILE = '.blueprint.config.json';
export const DOCS_ROOT_DEFAULT = 'docs/prs';
/** The files of an item's folder, <docsRoot>/<KEY>/. */
export const DESIGN_FILE = 'blueprint.md';
export const SCAFFOLD_REPORT_FILE = 'scaffold.json';
export const PULL_REQUEST_FILE = 'pull-request.md';
/** An item's folder under a docs root, or one of its files. */
export const itemDocsPathOf = ( docsRoot, key, file ) => `${ docsRoot }/${ key }${ file === undefined ? '' : `/${ file }` }`;

// --- Scaffold: the exit codes of a repository's declared scaffold command ---

export const SCAFFOLD_EXIT_OK = 0;
export const SCAFFOLD_EXIT_ERROR = 1;
export const SCAFFOLD_EXIT_USAGE = 2;
/** The scaffold ran but could not place everything; what it wrote is still committed and the job reports blocked. */
export const SCAFFOLD_EXIT_BLOCKED = 3;
