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

// --- Steward: the routes Steward polls and reports on. Their paths still say `runner`, the component's former name. ---

/** Where `push` sends the extracted graph and diagnostics. */
export const REALITY_PUSH_ROUTE = '/api/blueprint/reality';
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
/** The signal values Steward acts on itself; any other value is only reported. */
export const SIGNAL_DONE = 'done';
export const SIGNAL_NEEDS_HUMAN = 'needs-human';

// --- Scaffold: the exit codes of a repository's declared scaffold command ---

export const SCAFFOLD_EXIT_OK = 0;
export const SCAFFOLD_EXIT_ERROR = 1;
export const SCAFFOLD_EXIT_USAGE = 2;
/** The scaffold ran but could not place everything; what it wrote is still committed and the job reports blocked. */
export const SCAFFOLD_EXIT_BLOCKED = 3;
