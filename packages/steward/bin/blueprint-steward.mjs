#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRANCH_CLOSED_ROUTE, BRANCH_DELETED_ROUTE, BRANCH_MERGED_ROUTE, BRANCHES_ROUTE, legacyRouteOf, REALITY_PUSH_ROUTE,
  RUNNER_HEARTBEAT_MAX_SECONDS, RUNNER_JOB_ACTIVITY_SEGMENT, RUNNER_JOB_BUNDLE_SEGMENT, RUNNER_JOB_HEARTBEAT_SEGMENT,
  RUNNER_JOB_KINDS, RUNNER_JOB_METHOD_SEGMENT, RUNNER_JOB_NOT_CLAIMED, STEWARD_CLAIM_ROUTE, STEWARD_JOBS_ROUTE, STEWARD_SIGNALS_ROUTE,
  stewardJobRoute,
} from '@bett3r-dev/blueprint-spec';
import { activityOf, createActivityRelay, lineSplitter, logLinesOf } from '../lib/activity.mjs';
import { holdSecret, runQueued, setChildTimeout, spawnChild } from '../lib/child.mjs';
import {
  AGENT_BRANCH_PREFIX, latestSignal, parseSignals, SIGNAL_DONE, SIGNAL_NEEDS_HUMAN, SIGNALS_ROUTE, signalLogArgv, trailerKeyOf,
} from '../lib/commit-signals.mjs';
import { stewardEnv } from '../lib/env.mjs';
import { flushBundle } from '../lib/flush.mjs';
import { resolveHost } from '../lib/merge-detect.mjs';
import { OBSERVABILITY_READ_JOB_KIND, runObservabilityRead } from '../lib/observability-read.mjs';
import { PR_READY_JOB_KIND, runPrReady } from '../lib/pr-ready.mjs';
import { IMPLEMENTATION_DISPATCH_JOB_KIND, routineAliases, routineJobHandlers } from '../lib/routine.mjs';
import { runScaffoldJob, SCAFFOLD_JOB_KIND } from '../lib/scaffold.mjs';
import { toolList } from '../lib/tool-list.mjs';
import { trackerJobHandlers } from '../lib/tracker.mjs';

const USAGE = `Usage:
  blueprint-steward push    --server <url> [--token <t>] [--repo <path>] [--session <id>] [--no-extract]
  blueprint-steward start   --server <url> [--token <t>] [--repo <path>] [--session <id>] [--interval <s>] [--once]
                      [--merge-poll <s>] [--poll-once] [--tool-ceiling <tools>] [--heartbeat <s>] [--max-run-minutes <m>]
                      [--concurrency <n>] [--git-timeout <s>]
  blueprint-steward enqueue --server <url> [--token <t>] [--session <id>] [--branch <b>] [--prompt <text>]

Steward is the part of Blueprint you run beside your own codebase, with your own keys. Only the graph, diagnostics,
design ops and the answers to jobs the server composes (a tracker poll's tickets, an observability read's output from
your declared reader) ever leave this machine; source never does. The server never connects in: Steward polls out.

  push      Extract the design graph next to the code and push ONLY the graph and diagnostics.
  start     Poll the host for jobs. Per job: bring its session's own git worktree to the job's branch, extract
            and push from it, then run \`claude -p\` in that worktree on the instructions the host serves with
            the job, with blueprint-mcp pointed at the host session. Steward keeps no prompt of its own.
            A design job's method plugin is downloaded from the host, checked against the sha256 its claim names,
            kept (at most 5) in <repo>.blueprint-worktrees/.method and loaded with claude --plugin-dir; a job whose
            plugin is missing, unavailable, of another sha256 or not loaded by claude fails rather than run without it.
            Up to --concurrency jobs run at once; with every slot full it still claims observability reads, which
            run the repository's declared observability.read command (30 s each). The --repo checkout's HEAD and
            working tree are never changed.
  enqueue   Queue a design job for the host's session (what the board's "design" does).

  --server    The Blueprint server's base URL, e.g. https://blueprint.example.com
  --token     Your organization's Blueprint API key (default: $BLUEPRINT_STEWARD_TOKEN). The server reads the
              org off the key: Steward only ever sees its own organization's jobs and sessions.
              A local server with no identity configured still accepts its shared token here.
  --repo      The checkout of the repository Steward serves (default: current directory). \`start\` gives each
              session a worktree of it at <repo>.blueprint-worktrees/<session id>, reused by the session's next
              job and removed when the host sends a drop-worktree job for an idle session.
  --session   Session to push to, enqueue for, or claim from (default: $BLUEPRINT_SESSION_ID;
              start with none claims any session's job)
  --no-extract  Push the existing .blueprint/graph.json without running the extractor
  --interval    start: seconds between job claims (default 5)
  --merge-poll  start: seconds between merge polls, a separate timer from --interval
                (default: $BLUEPRINT_MERGE_POLL_SECONDS or 300). Each poll fetches with --prune and
                reports the server's branches that merged (by ancestry, else through the git host's
                API with your own gh / Bitbucket credentials) or that the remote deleted.
  --poll-once   start: run one merge poll and exit instead of starting either loop
  --once        start: exit after the first claimed job; starts no merge poller
  --tool-ceiling  start: the most tools you allow the agent, space- or comma-separated, e.g. "mcp__blueprint Read Glob Grep".
                The host picks each job's tools; a job asking for any tool not named here is failed before
                the agent starts. Matching is exact: a "Bash(git *)" entry admits a job's "Bash(git *)", not its
                "Bash"; a separator inside parentheses is part of the rule, so "Bash(git log *)" is one entry.
                Unset (the default), any tools the host picks are allowed. An empty value is refused.
                The agent is started with only the job's built-in tools available (claude --tools), so the
                checkout's own .claude/settings.json cannot give it any other.
                A tool the host offers as optional is used only when named here (or with no ceiling); otherwise
                the job runs without it. Today that is mcp__blueprint_repo, read-only git history: a second MCP
                server beside blueprint-mcp that runs only git log, show, grep and diff on the job's worktree.
  --heartbeat   start: seconds between the heartbeats that hold a running job's lease (default 60, at most 600).
                When the host answers that it no longer holds the job, the agent is stopped and nothing is reported.
  --git-timeout start: the longest any one git or gh call Steward makes may take (default 600). Those calls run
                one at a time per repository and never stop Steward's heartbeats; one past the bound fails its job.
  --max-run-minutes  start: the longest an agent may run (default 30, at most 35791); past it the agent is stopped
                and the job reported failed with reason limit-wallclock.
  --concurrency start: the most jobs run at once, each session in its own worktree (default 4). Two design jobs of
                one session never run at once: the later one waits for the earlier.

Environment (start):
  BLUEPRINT_ROUTINE_<ALIAS>_URL    The /fire endpoint of the Claude routine an implementation-dispatch job for
  BLUEPRINT_ROUTINE_<ALIAS>_TOKEN  <alias> fires (lowercased: BLUEPRINT_ROUTINE_TEAM_A_* is the alias team_a), and its
                                   bearer token. Steward holding at least one whole pair runs implementation-dispatch
                                   jobs, and its claim names the aliases it holds. Neither value leaves Steward:
                                   no claim, report or log carries it, and no child process inherits it.

Every BLUEPRINT_STEWARD_* variable is still read under its former name, BLUEPRINT_RUNNER_*, with a deprecation line.`;

const COMMANDS = [ 'push', 'start', 'enqueue' ];

// What a claim tells the host about Steward: its version, and (from JOB_HANDLERS below) the kinds it
// runs. The host hands it only jobs of those kinds, bound to the repository of its checkout's origin (or to none).
// 1.1.0 runs observability-read jobs. 1.2.0 runs implementation-dispatch jobs, firing routines with the beta header
// lib/routine.mjs pins, and, with the Jira credential, tracker-transition and tracker-describe jobs, and scaffold jobs
// (lib/scaffold.mjs); and it loads the method plugin a design claim names. 1.3.0 speaks specification v1: it calls the
// steward routes (the legacy runner ones when the server serves no other), reports each signal with its commit's body,
// always commits a scaffold under the Blueprint-Scaffold trailer, merges the agent branch only when its latest signal
// is done, and posts the item's pull-request.md as the pull request's body. The server hands design jobs to no Steward
// below METHOD_MIN_RUNNER_VERSION (from @bett3r-dev/blueprint-spec).
const STEWARD_VERSION = '1.3.0';
const args = process.argv.slice( 2 );
const command = args[ 0 ];
const flag = ( name ) => {
  const i = args.indexOf( name );
  return i >= 0 ? args[ i + 1 ] : undefined;
};

if ( !COMMANDS.includes( command ) || args.includes( '-h' ) || args.includes( '--help' ) ) {
  console.log( USAGE );
  process.exit( COMMANDS.includes( command ) ? 0 : 1 );
}

const server = flag( '--server' );
const token = flag( '--token' ) ?? stewardEnv( 'TOKEN' );
const sessionFlag = flag( '--session' ) ?? process.env.BLUEPRINT_SESSION_ID;
const repo = resolve( flag( '--repo' ) ?? process.cwd() );
// The team's ceiling on the tools a job may ask for. Unset is permissive.
// A value that is missing, lists no tool, or is the next flag is refused rather than read as a ceiling.
const ceilingValue = flag( '--tool-ceiling' );
const toolCeiling = ceilingValue === undefined || ceilingValue.startsWith( '--' ) || toolList( ceilingValue ).length === 0
  ? undefined
  : toolList( ceilingValue );
if ( args.includes( '--tool-ceiling' ) && toolCeiling === undefined ) {
  console.error( 'blueprint-steward: --tool-ceiling needs a tool list; an empty flag is refused rather than read as no ceiling\n' );
  console.error( USAGE );
  process.exit( 1 );
}
// The heartbeat cadence and the agent's wall-clock limit. The host refuses a heartbeat interval above 600 s
// (RUNNER_HEARTBEAT_MAX_SECONDS, from @bett3r-dev/blueprint-spec), so a larger value is refused here rather than at
// the first heartbeat. The wall
// clock is one setTimeout, whose delay is at most 2^31-1 ms (a larger one fires after 1 ms), so at most 35791 minutes.
// A flag given with no positive number, or one past its bound, is refused.
const HEARTBEAT_MAX_SECONDS = RUNNER_HEARTBEAT_MAX_SECONDS;
const MAX_RUN_MINUTES_MAX = Math.floor( ( 2 ** 31 - 1 ) / 60_000 );
const positiveFlag = ( name, fallback, max = Infinity ) => {
  if ( !args.includes( name ) ) return fallback;
  const value = Number( flag( name ) );
  return Number.isFinite( value ) && value > 0 && value <= max ? value : undefined;
};
const heartbeatSeconds = positiveFlag( '--heartbeat', 60, HEARTBEAT_MAX_SECONDS );
// How many jobs run at once, a whole number.
const concurrencyFlag = positiveFlag( '--concurrency', 4 );
const concurrency = Number.isInteger( concurrencyFlag ) ? concurrencyFlag : undefined;
if ( concurrency === undefined ) {
  console.error( 'blueprint-steward: --concurrency needs a positive whole number\n' );
  console.error( USAGE );
  process.exit( 1 );
}
const maxRunMinutes = positiveFlag( '--max-run-minutes', 30, MAX_RUN_MINUTES_MAX );
const gitTimeoutSeconds = positiveFlag( '--git-timeout', 600, 2 ** 31 / 1000 - 1 );
for ( const [ name, value, limit ] of [ [ '--heartbeat', heartbeatSeconds, HEARTBEAT_MAX_SECONDS ], [ '--max-run-minutes', maxRunMinutes, MAX_RUN_MINUTES_MAX ], [ '--git-timeout', gitTimeoutSeconds, 2 ** 31 / 1000 - 1 ] ] ) {
  if ( value !== undefined ) continue;
  console.error( `blueprint-steward: ${ name } needs a positive number of at most ${ limit }\n` );
  console.error( USAGE );
  process.exit( 1 );
}
if ( !server || !token ) {
  console.error( 'blueprint-steward: --server and a token (--token or BLUEPRINT_STEWARD_TOKEN) are required\n' );
  console.error( USAGE );
  process.exit( 1 );
}

// The org key is a secret every child is stripped of (lib/child.mjs childEnv). Passing it
// in argv leaves it visible to other users of the host, so that path warns once; the environment variable does not.
holdSecret( token );
setChildTimeout( gitTimeoutSeconds );
if ( flag( '--token' ) !== undefined ) {
  console.error( 'blueprint-steward: warning: --token puts the org key in this process\'s argv, where other users of this host can read it; set BLUEPRINT_STEWARD_TOKEN instead' );
}

// Every git call is async and queued behind the repository's others (one at a time per repository).
const runGit = ( cwd, argv ) => runQueued( repo, 'git', argv, { cwd } );
const gitIn = async ( cwd, cmd ) => {
  const result = await runGit( cwd, cmd.split( ' ' ) );
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const git = ( cmd ) => gitIn( repo, cmd );

// The job, claim and signal routes are spelled under /api/blueprint/steward. A server that answers the claim, the
// enqueue or a signal report 404 with no refusal of its own serves only their legacy /api/blueprint/runner spelling,
// which is called from then on, that call first. A job's own routes are reached only after its claim settled the
// spelling, so their 404s are the server's answers about the job.
const ROUTE_REFUSALS = new Set( [ RUNNER_JOB_NOT_CLAIMED, 'SESSION_NOT_FOUND' ] );
const SPELLING_ROUTES = new Set( [ STEWARD_CLAIM_ROUTE, STEWARD_JOBS_ROUTE, STEWARD_SIGNALS_ROUTE ] );
let legacyRoutes = false;
const spelled = ( route ) => ( legacyRoutes ? legacyRouteOf( route ) ?? route : route );
const call = async ( stewardRoute, body, { method = 'POST', sessionId } = {} ) => {
  const route = spelled( stewardRoute );
  const response = await fetch( new URL( route, server ), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ token }`,
      ...( sessionId ? { 'x-blueprint-session-id': sessionId } : {} ),
    },
    ...( body === undefined ? {} : { body: JSON.stringify( body ) } ),
  } );
  const text = await response.text();
  if ( !response.ok ) {
    // The host's refusal code ({ error: { code } }), when its body carries one, so a caller can tell refusals apart.
    let code;
    try { code = JSON.parse( text )?.error?.code; } catch { code = undefined; }
    if ( response.status === 404 && !ROUTE_REFUSALS.has( code ) && route === stewardRoute && SPELLING_ROUTES.has( route ) ) {
      legacyRoutes = true;
      console.error( `blueprint-steward: the server does not serve ${ route }; calling ${ legacyRouteOf( route ) } from now on` );
      return call( stewardRoute, body, { method, sessionId } );
    }
    throw Object.assign( new Error( `${ method } ${ route } refused (${ response.status }): ${ text }` ), { status: response.status, code } );
  }
  return text === '' ? {} : JSON.parse( text );
};

// The branch origin/HEAD names, which is what a job on a session bound to no branch works on.
const remoteDefaultBranch = async () => ( await git( 'symbolic-ref refs/remotes/origin/HEAD' ) )?.replace( /^refs\/remotes\/origin\//, '' );

// Runs a child to its exit without blocking the event loop, so the other jobs' agents and heartbeats carry on.
const exec = ( file, argv, options ) => new Promise( ( resolvePromise, reject ) => {
  const child = spawnChild( file, argv, { stdio: [ 'ignore', 'inherit', 'inherit' ], ...options } );
  child.on( 'error', reject );
  child.on( 'close', ( code ) => {
    if ( code === 0 ) resolvePromise();
    else reject( new Error( `${ options.shell ? file : [ file, ...argv ].join( ' ' ) } exited ${ code } in ${ options.cwd }` ) );
  } );
} );

// A worktree has no node_modules. An extractor may run without them, yet an extraction
// run through the package manager may not: yarn 4 refuses any script (\`yarn blueprint\`) in a project it has not
// installed, even one whose extractor needs no package (measured with yarn 4.12). So when an
// extraction fails in a worktree of a yarn or pnpm project with no node_modules, the worktree gets one install that
// runs no package's build scripts, and the extraction is tried again; an extraction that runs as it is gets no install.
const installWithoutScripts = ( dir ) => {
  if ( existsSync( join( dir, 'pnpm-lock.yaml' ) ) ) return [ 'pnpm', [ 'install', '--frozen-lockfile', '--ignore-scripts' ] ];
  if ( existsSync( join( dir, 'yarn.lock' ) ) ) return [ 'yarn', [ 'install', '--immutable', '--mode=skip-build' ] ];
  return undefined;
};
const extractIn = async ( dir, command, { worktree } ) => {
  try {
    await exec( command, [], { cwd: dir, shell: true } );
  } catch ( err ) {
    const install = installWithoutScripts( dir );
    if ( !worktree || existsSync( join( dir, 'node_modules' ) ) || !install ) throw err;
    console.error( `blueprint-steward: ${ err.message }; installing without build scripts in ${ dir } and extracting again` );
    await exec( ...install, { cwd: dir } );
    await exec( command, [], { cwd: dir, shell: true } );
  }
};

// `branch` is the branch the push binds the session to: a job's branch, or the remote's default for a job with
// none. Only when the caller passes no branch (a bare `push`) is it read from the checkout's HEAD. `dir` is where
// the graph is extracted and whose commit is pushed: the --repo checkout, or a session's worktree.
const push = async ( { extract, sessionId, branch, dir = repo, worktree = false, onStep = async () => undefined } ) => {
  if ( extract ) {
    await onStep( 'extract' );
    const configPath = join( dir, '.blueprint.config.json' );
    const command = existsSync( configPath )
      ? JSON.parse( readFileSync( configPath, 'utf-8' ) ).designTooling?.extract
      : undefined;
    if ( !command ) throw new Error( `no designTooling.extract in ${ configPath }; pass --no-extract to push an existing graph` );
    console.error( `blueprint-steward: extracting with \`${ command }\` in ${ dir }` );
    await extractIn( dir, command, { worktree } );
  }
  const read = ( name ) => {
    const path = join( dir, '.blueprint', name );
    return existsSync( path ) ? JSON.parse( readFileSync( path, 'utf-8' ) ) : undefined;
  };
  const graph = read( 'graph.json' );
  if ( graph === undefined ) throw new Error( `${ join( dir, '.blueprint', 'graph.json' ) } does not exist after extraction` );
  const overridesPath = join( dir, '.blueprint.overrides.json' );
  const payload = {
    graph,
    diagnostics: read( 'diagnostics.json' ),
    branch: branch ?? await git( 'rev-parse --abbrev-ref HEAD' ),
    commitSha: await gitIn( dir, 'rev-parse HEAD' ),
    remoteUrl: await git( 'remote get-url origin' ),
    baseBranch: ( await git( 'symbolic-ref refs/remotes/origin/HEAD' ) )?.replace( /^refs\/remotes\/origin\//, '' ),
    overrides: existsSync( overridesPath ) ? JSON.parse( readFileSync( overridesPath, 'utf-8' ) ) : undefined,
  };
  await onStep( 'push' );
  await call( REALITY_PUSH_ROUTE, payload, { sessionId } );
  const nodes = Array.isArray( graph.nodes ) ? graph.nodes.length : '?';
  console.log( `blueprint-steward: pushed ${ nodes } nodes from ${ payload.branch }@${ payload.commitSha?.slice( 0, 8 ) } to ${ server }` );
};

// One merge-poll tick. Git is the only source of truth: fetch --prune, then for each
// live branch the branches route lists for this repository, look for its merge into its base branch.
let hostWarned = false;
let reflogWarned = false;
// The tip of each branch whose commits the poll has read for signals, in this process. A branch seen
// for the first time is read from where it left its base (its baseBranch, else origin's default branch), so a restart
// reads its commits again and may report a sha twice.
const signalTips = new Map();
// The tip of each ticket branch's agent branch the poll has finished with, in this process: its signals reported, or
// it merged into the ticket branch. A restart reads it again and may report a sha twice.
const agentTips = new Map();
const mergePollTick = async () => {
  const remoteUrl = await git( 'remote get-url origin' );
  const fetched = await runGit( repo, [ 'fetch', '--prune', 'origin' ] );
  if ( fetched.status !== 0 ) throw new Error( `git fetch --prune failed: ${ fetched.stderr.trim() }` );
  const pruned = new Set( [ ...`${ fetched.stdout }\n${ fetched.stderr }`.matchAll( /\[deleted\].*->\s*origin\/(\S+)/g ) ].map( ( m ) => m[ 1 ] ) );
  const { branches = [] } = await call( `${ BRANCHES_ROUTE }?remoteUrl=${ encodeURIComponent( remoteUrl ?? '' ) }`, undefined, { method: 'GET' } );
  const defaultBranch = ( await git( 'symbolic-ref refs/remotes/origin/HEAD' ) )?.replace( /^refs\/remotes\/origin\//, '' );
  const isAncestorSha = async ( a, b ) => ( await runGit( repo, [ 'merge-base', '--is-ancestor', a, b ] ) ).status === 0;
  const isAncestor = ( tip, target ) => isAncestorSha( tip, `origin/${ target }` );
  // Ancestry alone is not a merge signal: a branch cut from its target's own tip, with no commits
  // of its own, is trivially an "ancestor" of that target from the moment it exists, without ever
  // having been merged. A real merge requires a genuine transition: the tip must at some point
  // have been UNREACHABLE from the target and only later have become reachable. The target's own
  // remote-tracking ref carries that history in its reflog, so we walk it looking for a point that
  // did not yet contain the tip; finding one is the "it actually diverged, then came back" proof.
  const warnReflog = () => {
    if ( reflogWarned ) return;
    reflogWarned = true;
    console.error( 'blueprint-steward: warning: reflog for origin/<target> is missing or empty; cannot prove divergence from ancestry alone, falling back to the host adapter' );
  };
  const everDiverged = async ( tip, target ) => {
    const log = await runGit( repo, [ 'reflog', 'show', '--format=%H', `refs/remotes/origin/${ target }` ] );
    if ( log.status !== 0 ) { warnReflog(); return false; } // no reflog to consult: cannot prove divergence, don't trust ancestry alone
    const points = log.stdout.trim().split( '\n' ).filter( Boolean );
    if ( points.length === 0 ) { warnReflog(); return false; } // empty reflog: same "can't prove it" case
    for ( const sha of points ) if ( !( await isAncestorSha( tip, sha ) ) ) return true;
    return false;
  };
  // The trailer the entry names (lib/commit-signals.mjs) on the commits `source` gained since the tip
  // last read, reported oldest first. The base is always excluded, so commits main gained and a merge or rebase brought
  // in are never this branch's signals; a tip no longer on the branch (a force-push) excludes nothing, so the branch is
  // read again from its base. A tip already read reads nothing; a report the server refuses leaves the tip unread, so
  // the next tick sends it again, and never stops the merge detection below.
  const reportSignals = async ( entry, source, tip ) => {
    const key = trailerKeyOf( entry );
    if ( !tip || key === undefined || signalTips.get( source ) === tip ) return;
    const seen = signalTips.get( source );
    const base = entry.baseBranch || defaultBranch;
    const baseTip = base && base !== source ? await git( `rev-parse --verify --quiet refs/remotes/origin/${ base }` ) : undefined;
    const exclude = [ baseTip, seen !== undefined && await isAncestorSha( seen, tip ) ? seen : undefined ].filter( Boolean );
    if ( exclude.length === 0 ) { signalTips.set( source, tip ); return; }
    const logged = await runGit( repo, signalLogArgv( key, [ tip, ...exclude.map( ( sha ) => `^${ sha }` ) ] ) );
    if ( logged.status !== 0 ) { console.error( `blueprint-steward: signals of ${ source }: ${ gitFailure( logged ) }` ); return; }
    const signals = parseSignals( logged.stdout, key );
    if ( signals.length > 0 ) {
      try {
        await call( SIGNALS_ROUTE, { remoteUrl, branch: source, signals } );
      } catch ( err ) {
        console.error( `blueprint-steward: signals of ${ source }: ${ err.message }` );
        return;
      }
      console.error( `blueprint-steward: reported ${ signals.length } signal(s) on ${ source }` );
    }
    signalTips.set( source, tip );
  };
  // A ticket branch's agent branch (AGENT_BRANCH_PREFIX + the ticket branch), where an implementation routine pushes:
  // its own commits, those neither the ticket branch nor the base holds, are read under the ticket branch's key. The
  // latest value is the agent branch's state: a done merges it into the ticket branch on origin, by fast-forward or by a
  // merge commit made with plumbing (merge-tree, commit-tree) so the checkout never moves, and the ticket branch's own
  // read below then reports it. Any other latest value is reported, with the signals before it, for the ticket branch
  // unmerged; an agent branch that does not merge cleanly is reported needs-human on its tip. A push origin refuses
  // (the ticket branch moved) or a report the server refuses is tried again next tick.
  const mergeAgentBranch = async ( entry, source, tip ) => {
    const key = trailerKeyOf( entry );
    const agent = `${ AGENT_BRANCH_PREFIX }${ source }`;
    if ( !tip || key === undefined || source.startsWith( AGENT_BRANCH_PREFIX ) ) return;
    const agentTip = await git( `rev-parse --verify --quiet refs/remotes/origin/${ agent }` );
    if ( !agentTip || agentTips.get( source ) === agentTip || await isAncestorSha( agentTip, tip ) ) return;
    const base = entry.baseBranch || defaultBranch;
    const baseTip = base && base !== source ? await git( `rev-parse --verify --quiet refs/remotes/origin/${ base }` ) : undefined;
    const logged = await runGit( repo, signalLogArgv( key, [ agentTip, `^${ tip }`, ...( baseTip ? [ `^${ baseTip }` ] : [] ) ] ) );
    if ( logged.status !== 0 ) { console.error( `blueprint-steward: signals of ${ agent }: ${ gitFailure( logged ) }` ); return; }
    const signals = parseSignals( logged.stdout, key );
    const report = async ( reported ) => {
      try {
        await call( SIGNALS_ROUTE, { remoteUrl, branch: source, signals: reported } );
      } catch ( err ) {
        console.error( `blueprint-steward: signals of ${ agent }: ${ err.message }` );
        return false;
      }
      console.error( `blueprint-steward: reported ${ reported.length } signal(s) on ${ agent } for ${ source }` );
      return true;
    };
    if ( latestSignal( signals )?.value !== SIGNAL_DONE ) {
      if ( signals.length === 0 || await report( signals ) ) agentTips.set( source, agentTip );
      return;
    }
    let head = agentTip;
    if ( !await isAncestorSha( tip, agentTip ) ) {
      const merged = await runGit( repo, [ 'merge-tree', '--write-tree', tip, agentTip ] );
      if ( merged.status === 1 ) {
        const conflict = { sha: agentTip, key, value: SIGNAL_NEEDS_HUMAN, subject: `${ agent } does not merge cleanly into ${ source }` };
        if ( await report( [ conflict ] ) ) agentTips.set( source, agentTip );
        return;
      }
      if ( merged.status !== 0 ) { console.error( `blueprint-steward: merging ${ agent } into ${ source }: ${ gitFailure( merged ) }` ); return; }
      const committed = await runGit( repo, [ 'commit-tree', merged.stdout.split( '\n' )[ 0 ].trim(), '-p', tip, '-p', agentTip, '-m', `Merge ${ agent } into ${ source }` ] );
      if ( committed.status !== 0 ) { console.error( `blueprint-steward: merging ${ agent } into ${ source }: ${ gitFailure( committed ) }` ); return; }
      head = committed.stdout.trim();
    }
    const pushed = await runGit( repo, [ 'push', '--quiet', 'origin', `${ head }:refs/heads/${ source }` ] );
    if ( pushed.status !== 0 ) { console.error( `blueprint-steward: pushing ${ agent } into ${ source }: ${ gitFailure( pushed ) }` ); return; }
    await runGit( repo, [ 'update-ref', `refs/remotes/origin/${ source }`, head ] );
    agentTips.set( source, agentTip );
    console.error( `blueprint-steward: merged ${ agent } into ${ source }` );
  };
  let host;
  for ( const entry of branches ) {
    const { branch: source, baseBranch } = entry;
    if ( pruned.has( source ) ) {
      await call( BRANCH_DELETED_ROUTE, { remoteUrl, branch: source } );
      console.error( `blueprint-steward: reported ${ source } deleted` );
    }
    await mergeAgentBranch( entry, source, await git( `rev-parse --verify --quiet refs/remotes/origin/${ source }` ) );
    const tip = await git( `rev-parse --verify --quiet refs/remotes/origin/${ source }` );
    await reportSignals( entry, source, tip );
    const targets = [ ...new Set( [ baseBranch, defaultBranch ] ) ].filter( ( t ) => t && t !== source );
    let reportedMerged = false;
    for ( const target of targets ) {
      let found;
      if ( tip && await isAncestor( tip, target ) && await everDiverged( tip, target ) ) {
        // The merge commit that brought the tip in, or the tip itself for a fast-forward.
        const mergeSha = ( await git( `rev-list --ancestry-path --merges --reverse ${ tip }..origin/${ target }` ) )?.split( '\n' )[ 0 ] || tip;
        found = { mergeSha, mergedAt: await git( `show -s --format=%cI ${ mergeSha }` ), via: 'ancestry' };
      } else {
        if ( host === undefined ) {
          host = await resolveHost( { repo, remoteUrl } );
          if ( !host.adapter && !hostWarned ) {
            hostWarned = true;
            console.error( `blueprint-steward: warning: ${ host.reason }; merge detection is ancestry-only, squash and rebase merges stay invisible` );
          }
        }
        const merge = host.adapter ? await host.adapter.findMerge( source, target ) : undefined;
        if ( merge ) found = { ...merge, via: 'host-api' };
      }
      if ( found ) {
        await call( BRANCH_MERGED_ROUTE, { remoteUrl, source, target, mergeSha: found.mergeSha, via: found.via, mergedAt: found.mergedAt } );
        console.error( `blueprint-steward: reported ${ source } merged into ${ target } (${ found.via })` );
        reportedMerged = true;
        break;
      }
    }
    // An abandoned PR (closed unmerged, none open) freezes the branch's sessions. Host-only;
    // no credentials leaves `host` without an adapter, and the check is skipped like squash detection.
    if ( !reportedMerged && host?.adapter && await host.adapter.findClosure( source ) ) {
      await call( BRANCH_CLOSED_ROUTE, { remoteUrl, source } );
      console.error( `blueprint-steward: reported ${ source } closed without merge` );
    }
  }
};

const blueprintMcpBin = resolve( dirname( fileURLToPath( import.meta.url ) ), '../mcp/bin/blueprint-mcp.mjs' );
// The optional tools Steward can provide, each an MCP server of its own beside blueprint-mcp.
// The key is the tool a claim's optionalTools names; `server` is its --mcp-config entry name, so claude calls its
// tools mcp__<server>__<tool> (mcp__blueprint_repo__git_log and kin, the method's entry contract).
const OPTIONAL_TOOL_SERVERS = {
  mcp__blueprint_repo: { server: 'blueprint_repo', bin: resolve( dirname( fileURLToPath( import.meta.url ) ), '../mcp/bin/blueprint-repo-mcp.mjs' ) },
};

// The usage a report carries, read from claude's result event only in the shape
// pinned by test/fixtures/claude-2.1.284-{result,error}.json, captured from claude 2.1.284 (the CLI's JSON
// varies by version). Any other output yields undefined, and the report says its usage is unreported. The model is
// the modelUsage entry that cost the most (none when modelUsage is empty, as in the error capture); tokens are the
// result's own usage.input_tokens and usage.output_tokens.
// claude runs with --output-format stream-json, one JSON event per line, and the result event is the last
// line that parses as one (test/fixtures/claude-2.1.287-stream.jsonl, captured from claude 2.1.287).
const tokenCount = ( value ) => Number.isSafeInteger( value ) && value >= 0;
const eventOf = ( line ) => {
  try { return JSON.parse( line ); } catch { return undefined; }
};
const pinnedResult = ( out ) => {
  const parsed = out.trim().split( '\n' ).reverse().map( eventOf ).find( ( event ) => event?.type === 'result' );
  if ( parsed === undefined || typeof parsed.result !== 'string' ) return undefined;
  const { usage, modelUsage, total_cost_usd: cost } = parsed;
  if ( !tokenCount( usage?.input_tokens ) || !tokenCount( usage?.output_tokens ) || typeof cost !== 'number' || !( cost >= 0 ) ) return undefined;
  if ( typeof modelUsage !== 'object' || modelUsage === null ) return undefined;
  const [ model ] = Object.entries( modelUsage )
    .filter( ( [ , entry ] ) => typeof entry?.costUSD === 'number' )
    .sort( ( [ , a ], [ , b ] ) => b.costUSD - a.costUSD )
    .map( ( [ name ] ) => name );
  return {
    result: parsed.result,
    usage: { ...( model ? { model } : {} ), input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd_micros: Math.round( cost * 1e6 ), cost_source: 'runner-sdk' },
  };
};

// How long a stopped agent gets to exit on SIGTERM before it is sent SIGKILL.
const KILL_GRACE_MS = 10_000;

// A job heartbeats the step it enters (the spec's RUNNER_JOB_STEPS: branch, worktree, extract, push, agent), so the
// board follows it. RUNNER_JOB_STEPS is the shared AGENT_STEPS less `intake`, which Steward never beats;
// test/ticket-branch.test.ts holds the beats equal to it. A step beat is awaited before the step starts; one the host
// refuses is logged and the step runs all the same (the lease is the periodic beat's to lose).
const beatStep = async ( job, step ) => {
  await call( stewardJobRoute( job.id, RUNNER_JOB_HEARTBEAT_SEGMENT ), { intervalSeconds: heartbeatSeconds, step }, { sessionId: job.sessionId } )
    .catch( ( err ) => { console.error( `blueprint-steward: step heartbeat (${ step }): ${ err.message }` ); } );
};

// claude's system/init event lists the plugins it loaded
// (fixtures/claude-2.1.287-stream.jsonl). It is not always the first line: in a project with a SessionStart hook claude
// first writes that hook's system/hook_started and system/hook_response events
// (fixtures/claude-2.1.288-stream-session-start-hook.jsonl). So any other system event before the init is passed
// over, and the first line that is not one decides: true for an init listing the method; false for an init without
// it, or for any other line (a non-system event, plain text, an init with no plugins list), which means the method
// did not load. undefined for a line that does not decide; an init renamed to another system subtype is passed over
// too, and the next line or the exit then fails the job.
const methodLoadedBy = ( line, name ) => {
  const event = eventOf( line );
  if ( event?.type === 'system' && event.subtype !== 'init' ) return undefined;
  return event?.type === 'system' && event.subtype === 'init' && Array.isArray( event.plugins ) && event.plugins.some( ( plugin ) => plugin?.name === name );
};

const runAgent = ( job, sessionId, worktree, method, optionalTools = [], onActivity = () => undefined ) => new Promise( ( resolvePromise ) => {
  // The board tool writes with the key the host minted for this job alone, never the org key. A
  // claim with none (a host from before job keys) is failed rather than handing the agent the org key.
  if ( typeof job.jobKey !== 'string' || job.jobKey === '' ) {
    resolvePromise( { ok: false, result: 'the claim carried no job key, and the agent is never handed the org key' } );
    return;
  }
  const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-' ) );
  const mcpConfig = join( dir, 'mcp.json' );
  writeFileSync( mcpConfig, JSON.stringify( {
    mcpServers: {
      blueprint: {
        command: process.execPath,
        args: [ blueprintMcpBin ],
        env: { BLUEPRINT_HOST_URL: server, BLUEPRINT_ACCESS_TOKEN: job.jobKey, BLUEPRINT_SESSION_ID: sessionId, BLUEPRINT_REPO_PATH: worktree },
      },
      // An admitted optional tool's server is configured with the session's worktree alone, never the job key.
      ...Object.fromEntries( optionalTools.map( ( tool ) => [ OPTIONAL_TOOL_SERVERS[ tool ].server, {
        command: process.execPath,
        args: [ OPTIONAL_TOOL_SERVERS[ tool ].bin ],
        env: { BLUEPRINT_REPO_PATH: worktree },
      } ] ) ),
    },
  } ) );
  const { text } = job.instructions;
  const prompt = job.prompt ? `${ text }\n\nThe owner asks: ${ job.prompt }` : text;
  const claude = stewardEnv( 'CLAUDE' ) ?? 'claude';
  // The tools are exactly the ones the host served with the job, never read from the text.
  // --allowedTools only pre-approves them; --tools limits the built-in tools the agent has at all to the job's
  // (a scoped rule such as "Bash(git *)" contributes its bare name; "" leaves none), so a permissions.allow or
  // defaultMode in the checkout's project settings cannot add another. MCP tools are not built-ins: they come
  // only from this MCP config (--strict-mcp-config) and stay out of --tools. The child keeps no session on disk, loads only this MCP config and the worktree's project settings (not the operator's
  // user or local settings, where user hooks live), and is never --bare: --bare drops the OAuth and keychain login
  // a subscription runs on.
  const builtIn = [ ...new Set( job.tools.filter( ( tool ) => !tool.startsWith( 'mcp__' ) ).map( ( tool ) => tool.replace( /\(.*$/, '' ) ) ) ];
  const disallowed = Array.isArray( job.disallowedTools ) ? job.disallowedTools.filter( ( tool ) => typeof tool === 'string' && tool !== '' ) : [];
  // The host picks the model and the optional per-run cap (USD micros) and the claim carries both; claude
  // enforces the cap itself. A claim with neither (an older server) runs claude's own default, uncapped.
  const model = typeof job.model === 'string' && job.model !== '' ? [ '--model', job.model ] : [];
  const cap = Number.isSafeInteger( job.runCapUsdMicros ) && job.runCapUsdMicros > 0 ? [ '--max-budget-usd', String( job.runCapUsdMicros / 1e6 ) ] : [];
  const child = spawnChild( claude, [
    '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', job.tools.join( ' ' ),
    '--tools', builtIn.join( ',' ),
    ...( disallowed.length > 0 ? [ '--disallowedTools', disallowed.join( ' ' ) ] : [] ),
    '--no-session-persistence',
    '--setting-sources', 'project',
    // The verified method zip, loaded for this run alone; stream-json (which -p accepts only with --verbose)
    // so the init event shows whether claude loaded it.
    '--plugin-dir', method.path,
    '--output-format', 'stream-json', '--verbose',
    ...model,
    ...cap,
  ], { cwd: worktree, stdio: [ 'ignore', 'pipe', 'inherit' ] } );
  // The operator reads one line per event, tagged with the job (lib/activity.mjs); the stream as claude wrote it is kept
  // whole in the job's temporary directory, and the board is relayed the tool names alone.
  const tag = `[${ job.id.slice( 0, 8 ) }]`;
  const rawLog = join( dir, 'stream.jsonl' );
  console.log( `${ tag } agent started for session ${ sessionId }; raw stream in ${ rawLog }` );
  const lines = lineSplitter();
  const readLines = ( complete ) => {
    for ( const line of complete ) {
      for ( const logged of logLinesOf( line, tag ) ) console.log( logged );
      onActivity( ...activityOf( line ) );
    }
  };
  let out = '';
  let exited = false;
  // Why Steward stopped the agent: 'lease-lost', 'wallclock' or 'method-not-loaded'; undefined while it runs on its own.
  let stopped;
  // Whether claude's init showed the method loaded; undefined until a complete line decides it
  // (methodLoadedBy), and `scanned` is how far into `out` the lines have been read.
  let loaded;
  let scanned = 0;
  const scanLines = () => {
    let end;
    while ( loaded === undefined && ( end = out.indexOf( '\n', scanned ) ) !== -1 ) {
      loaded = methodLoadedBy( out.slice( scanned, end ), method.name );
      scanned = end + 1;
    }
  };
  const timers = [];
  const stop = ( why ) => {
    if ( exited || stopped !== undefined ) return;
    stopped = why;
    child.kill( 'SIGTERM' );
    timers.push( setTimeout( () => { if ( !exited ) child.kill( 'SIGKILL' ); }, KILL_GRACE_MS ) );
  };
  // Every --heartbeat seconds Steward extends the job's lease. A 404
  // RUNNER_JOB_NOT_CLAIMED means the host no longer holds the job as claimed with a live lease (the lease expired or
  // was reaped as worker-lost, or the job was reported): the agent is stopped and no report is posted. Any other refusal or network error is logged and
  // the next heartbeat still goes out.
  const beat = () => call( stewardJobRoute( job.id, RUNNER_JOB_HEARTBEAT_SEGMENT ), { intervalSeconds: heartbeatSeconds }, { sessionId } ).then(
    () => { schedule(); },
    ( err ) => {
      if ( err.status === 404 && err.code === RUNNER_JOB_NOT_CLAIMED ) {
        console.error( `blueprint-steward: the host no longer holds job ${ job.id }; stopping the agent, no report` );
        stop( 'lease-lost' );
      } else {
        console.error( `blueprint-steward: heartbeat: ${ err.message }` );
        schedule();
      }
    } );
  const schedule = () => { if ( !exited && stopped === undefined ) timers.push( setTimeout( beat, heartbeatSeconds * 1000 ) ); };
  schedule();
  // Past --max-run-minutes the agent is stopped and the job fails limit-wallclock.
  timers.push( setTimeout( () => { stop( 'wallclock' ); }, maxRunMinutes * 60_000 ) );
  const finish = ( outcome ) => {
    exited = true;
    for ( const timer of timers ) clearTimeout( timer );
    resolvePromise( outcome );
  };
  child.stdout.on( 'data', ( chunk ) => {
    out += chunk;
    try { appendFileSync( rawLog, chunk ); } catch { /* the raw log is a convenience; the agent runs without it */ }
    readLines( lines.push( String( chunk ) ) );
    if ( loaded !== undefined ) return;
    scanLines();
    if ( loaded === false ) {
      console.error( `blueprint-steward: the agent's init event does not list the ${ method.name } plugin; stopping the agent of job ${ job.id }` );
      stop( 'method-not-loaded' );
    }
  } );
  // A claude that is not on PATH (or not at BLUEPRINT_STEWARD_CLAUDE) fails the spawn with ENOENT: claude-missing.
  child.on( 'error', ( err ) => {
    finish( { ok: false, ...( err.code === 'ENOENT' ? { reason: 'claude-missing' } : {} ), result: `could not start ${ claude }: ${ err.message }` } );
  } );
  child.on( 'close', ( code ) => {
    readLines( lines.rest() );
    if ( stopped === 'lease-lost' ) {
      finish( { ok: false, lost: true, result: out.slice( -4000 ) } );
      return;
    }
    if ( stopped === 'wallclock' ) {
      finish( { ok: false, reason: 'limit-wallclock', result: `the agent was stopped after --max-run-minutes ${ maxRunMinutes }\n${ out.slice( -4000 ) }`, usage: { cost_source: 'unreported' } } );
      return;
    }
    // Fails closed. An agent whose init did not list the method was stopped; one that exited with no init
    // line (the last line read even without its newline) never showed it loaded either. A non-zero exit with no
    // output is claude's own failure.
    if ( loaded === undefined ) {
      scanLines();
      if ( loaded === undefined && scanned < out.length ) loaded = methodLoadedBy( out.slice( scanned ), method.name );
    }
    if ( stopped === 'method-not-loaded' || ( !loaded && ( code === 0 || out !== '' ) ) ) {
      finish( { ok: false, reason: 'method-not-loaded', result: `the agent did not show the ${ method.name } plugin (sha256 ${ method.sha256 }) loaded at init; the turn was not run on it\n${ out.slice( -4000 ) }`, usage: { cost_source: 'unreported' } } );
      return;
    }
    const pinned = pinnedResult( out );
    finish( {
      ok: code === 0,
      ...( code === 0 ? {} : { reason: 'agent-error' } ),
      result: ( pinned?.result ?? out ).slice( -4000 ),
      usage: pinned?.usage ?? { cost_source: 'unreported' },
    } );
  } );
} );

// "Check git now" on the board queues a `git-poll` job. It is answered by one merge-poll
// tick, not by the design flow: no checkout, no reality push, no agent.
const GIT_POLL_JOB_KIND = 'git-poll';

const runGitPoll = async () => {
  await mergePollTick();
  return { ok: true, result: 'merge poll tick ran' };
};

// Each session works in its own worktree of --repo, at a path derived from the
// session id alone, beside the checkout: <repo>.blueprint-worktrees/<session id>. A session id that is not one
// plain path segment names no worktree, so no job can reach a directory outside that root.
const WORKTREE_ROOT = `${ repo }.blueprint-worktrees`;
const SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const worktreeOf = ( sessionId ) => ( typeof sessionId === 'string' && SESSION_SEGMENT.test( sessionId ) ? join( WORKTREE_ROOT, sessionId ) : undefined );

// A design claim names the method plugin by sha256; the zip is fetched on the
// job's method route and kept by that sha beside the worktrees, in a directory no session id can name (a session
// segment starts with a letter or digit). At most METHOD_CACHE_SIZE zips are kept, the least recently used dropped,
// and a kept zip is hashed again every time it is used: one whose bytes no longer match is fetched again.
const METHOD_CACHE = join( WORKTREE_ROOT, '.method' );
const METHOD_CACHE_SIZE = 5;
const SHA256 = /^[0-9a-f]{64}$/;
const sha256Of = ( bytes ) => createHash( 'sha256' ).update( bytes ).digest( 'hex' );
const methodRefused = ( reason, result ) => ( { refused: { ok: false, reason, result } } );
let methodWrites = 0;
const pruneMethodCache = () => {
  const zips = readdirSync( METHOD_CACHE ).filter( ( name ) => /^[0-9a-f]{64}\.zip$/.test( name ) )
    .map( ( name ) => ( { path: join( METHOD_CACHE, name ), usedAt: statSync( join( METHOD_CACHE, name ) ).mtimeMs } ) )
    .sort( ( a, b ) => b.usedAt - a.usedAt );
  for ( const { path } of zips.slice( METHOD_CACHE_SIZE ) ) rmSync( path, { force: true } );
};
// The verified zip's path and the plugin's name, or `refused`: the outcome the job fails with before any checkout.
const METHOD_DOWNLOAD_TIMEOUT_MS = 60_000;
const METHOD_MAX_BYTES = 32 * 1024 * 1024;

const methodFor = async ( job ) => {
  const { method } = job;
  if ( typeof method?.name !== 'string' || method.name === '' || typeof method.sha256 !== 'string' || !SHA256.test( method.sha256 ) ) {
    return methodRefused( 'method-missing', 'the design claim named no method plugin (a name and a sha256), and Steward runs no turn without the served method' );
  }
  const path = join( METHOD_CACHE, `${ method.sha256 }.zip` );
  if ( existsSync( path ) ) {
    if ( sha256Of( readFileSync( path ) ) === method.sha256 ) {
      const now = new Date();
      utimesSync( path, now, now );
      return { path, name: method.name, sha256: method.sha256 };
    }
    console.error( `blueprint-steward: the cached method plugin ${ path } no longer has its sha256; fetching it again` );
    rmSync( path, { force: true } );
  }
  let bytes;
  try {
    const response = await fetch( new URL( spelled( stewardJobRoute( job.id, RUNNER_JOB_METHOD_SEGMENT ) ), server ), {
      headers: { Authorization: `Bearer ${ token }`, ...( job.sessionId ? { 'x-blueprint-session-id': job.sessionId } : {} ) },
      signal: AbortSignal.timeout( METHOD_DOWNLOAD_TIMEOUT_MS ),
    } );
    if ( !response.ok ) throw new Error( `refused (${ response.status }): ${ await response.text() }` );
    if ( Number( response.headers.get( 'content-length' ) ) > METHOD_MAX_BYTES ) throw new Error( `the method plugin is larger than ${ METHOD_MAX_BYTES } bytes` );
    bytes = Buffer.from( await response.arrayBuffer() );
    if ( bytes.length > METHOD_MAX_BYTES ) throw new Error( `the method plugin is larger than ${ METHOD_MAX_BYTES } bytes` );
  } catch ( err ) {
    return methodRefused( 'method-unavailable', `the method plugin of job ${ job.id } could not be downloaded: ${ err.message }` );
  }
  const served = sha256Of( bytes );
  if ( served !== method.sha256 ) {
    return methodRefused( 'method-mismatch', `the method plugin served for job ${ job.id } has sha256 ${ served }, not the ${ method.sha256 } its claim names; it was not run` );
  }
  mkdirSync( METHOD_CACHE, { recursive: true } );
  // Written whole under another name and renamed, so a job reading the cache never sees part of a zip.
  const partial = `${ path }.${ process.pid }-${ methodWrites += 1 }.partial`;
  writeFileSync( partial, bytes );
  renameSync( partial, path );
  pruneMethodCache();
  return { path, name: method.name, sha256: method.sha256 };
};
const gitFailure = ( result ) => ( result.stderr || result.error?.message || `exit ${ result.status }` ).trim();
const commonDirOf = async ( cwd ) => {
  const out = await runGit( cwd, [ 'rev-parse', '--git-common-dir' ] );
  return out.status === 0 ? realpathSync( resolve( cwd, out.stdout.trim() ) ) : undefined;
};
// A directory that is a worktree of --repo's repository, as opposed to a leftover directory or another repository.
const isWorktreeOfRepo = async ( dir ) => {
  if ( !existsSync( join( dir, '.git' ) ) ) return false;
  const here = await commonDirOf( dir );
  return here !== undefined && here === await commonDirOf( repo );
};

// Brings the session's worktree to the tip of `branch` as origin has it after a fetch (a branch origin lacks is
// taken from the checkout's own), or to the checkout's HEAD commit when there is no branch. The worktree is
// detached, so any number of sessions, and the checkout itself, may be on one branch; the push names the branch.
// A new worktree is added; an existing one is reused and moved. Every git call here is async and queued (lib/child.mjs),
// so Steward never runs two of its own git commands against the repository at once and never stops its heartbeats. Any failure throws with reason checkout-failed.
const checkoutFailed = ( message ) => Object.assign( new Error( message ), { reason: 'checkout-failed' } );
const prepareWorktree = async ( sessionId, branch, onStep = async () => undefined ) => {
  await onStep( 'worktree' );
  const dir = worktreeOf( sessionId );
  if ( dir === undefined ) throw checkoutFailed( `session id ${ JSON.stringify( sessionId ) } is not one plain path segment, so it names no worktree` );
  if ( await git( 'remote get-url origin' ) !== undefined ) {
    const fetched = await runGit( repo, [ 'fetch', '--quiet', 'origin' ] );
    if ( fetched.status !== 0 ) throw checkoutFailed( `git fetch origin failed: ${ gitFailure( fetched ) }` );
  }
  const refs = branch === undefined ? [ 'HEAD' ] : [ `refs/remotes/origin/${ branch }`, `refs/heads/${ branch }` ];
  let sha;
  for ( const ref of refs ) {
    const found = await runGit( repo, [ 'rev-parse', '--verify', '--quiet', `${ ref }^{commit}` ] );
    if ( found.status === 0 ) { sha = found.stdout.trim(); break; }
  }
  if ( sha === undefined ) throw checkoutFailed( `branch ${ branch } is neither on origin nor in ${ repo }` );
  if ( await isWorktreeOfRepo( dir ) ) {
    console.error( `blueprint-steward: moving the worktree of session ${ sessionId } to ${ branch ?? 'HEAD' } (${ sha.slice( 0, 8 ) })` );
    const moved = await runGit( dir, [ 'checkout', '--quiet', '--force', '--detach', sha ] );
    if ( moved.status !== 0 ) throw checkoutFailed( `git checkout in ${ dir } failed: ${ gitFailure( moved ) }` );
    return dir;
  }
  // A leftover directory that is no worktree of this repository (an interrupted add or remove) is replaced.
  if ( existsSync( dir ) ) await rm( dir, { recursive: true, force: true } );
  await runGit( repo, [ 'worktree', 'prune' ] );
  mkdirSync( WORKTREE_ROOT, { recursive: true } );
  console.error( `blueprint-steward: adding a worktree for session ${ sessionId } at ${ branch ?? 'HEAD' } (${ sha.slice( 0, 8 ) }) in ${ dir }` );
  const added = await runGit( repo, [ 'worktree', 'add', '--quiet', '--detach', dir, sha ] );
  if ( added.status !== 0 ) throw checkoutFailed( `git worktree add ${ dir } failed: ${ gitFailure( added ) }` );
  return dir;
};

// The sessions with a design job claimed and not yet finished here, counted, and
// the tail of each one's jobs. A session's jobs run one after another, so two never share its worktree at once, and
// a drop-worktree job never removes a worktree a job holds: from before its checkout until its agent has exited.
const sessionJobs = new Map();
const sessionTails = new Map();
const inSession = ( sessionId, work ) => {
  sessionJobs.set( sessionId, ( sessionJobs.get( sessionId ) ?? 0 ) + 1 );
  const ran = ( sessionTails.get( sessionId ) ?? Promise.resolve() ).then( work );
  const tail = ran.catch( () => undefined ).finally( () => {
    const left = sessionJobs.get( sessionId ) - 1;
    if ( left === 0 ) sessionJobs.delete( sessionId );
    else sessionJobs.set( sessionId, left );
    if ( sessionTails.get( sessionId ) === tail ) sessionTails.delete( sessionId );
  } );
  sessionTails.set( sessionId, tail );
  return ran;
};

// The host queues a drop-worktree job for a session that went quiet. Its worktree is removed and
// unregistered; the session's next job adds it again. A session with a job here keeps its worktree, and the
// drop is still done: a later quiet spell queues another.
const dropWorktree = async ( sessionId ) => {
  const dir = worktreeOf( sessionId );
  // A job holding the session (even one still preparing its worktree) keeps it: checked before the directory exists.
  if ( sessionJobs.has( sessionId ) ) return { ok: true, result: `the worktree of session ${ sessionId } is in use by a running job; not removed` };
  if ( dir === undefined || !existsSync( dir ) ) {
    await runGit( repo, [ 'worktree', 'prune' ] );
    return { ok: true, result: `no worktree for session ${ sessionId } to remove` };
  }
  const removed = await runGit( repo, [ 'worktree', 'remove', '--force', dir ] );
  // A directory git does not know as a worktree (or failed to remove) is deleted, and git forgets any record of it.
  if ( existsSync( dir ) ) await rm( dir, { recursive: true, force: true } );
  await runGit( repo, [ 'worktree', 'prune' ] );
  console.error( `blueprint-steward: removed the worktree of session ${ sessionId }${ removed.status === 0 ? '' : ` (git: ${ gitFailure( removed ) })` }` );
  return { ok: true, result: `removed the worktree of session ${ sessionId }` };
};

// The job carries its session's branch; a session bound to none works on the remote's default
// branch. Only when neither is known does the worktree take the checkout's HEAD commit and the push its branch,
// binding a session that had no branch to bind away from.
// The host serves the text a hosted turn runs, and Steward keeps no prompt of
// its own. A design claim without it is failed before any checkout, push or agent.
const runJob = async ( job, sessionId ) => {
  if ( typeof job.instructions?.text !== 'string' || job.instructions.text.trim() === '' ) {
    return { ok: false, reason: 'instructions-missing', result: 'the claim carried no hosted-turn instructions, and Steward keeps no prompt of its own' };
  }
  // The host picks the tools; Steward only holds them to the team's ceiling, before any
  // checkout, push or agent. A claim naming no tools is failed rather than given a default of Steward's.
  const tools = Array.isArray( job.tools ) ? job.tools.filter( ( tool ) => typeof tool === 'string' && tool !== '' ) : [];
  if ( tools.length === 0 ) {
    return { ok: false, reason: 'tools-missing', result: 'the claim carried no tools, and Steward picks none of its own' };
  }
  const beyond = toolCeiling === undefined ? [] : tools.filter( ( tool ) => !toolCeiling.includes( tool ) );
  if ( beyond.length > 0 ) {
    return { ok: false, reason: 'tools-beyond-ceiling', result: `the job asks for ${ beyond.join( ' ' ) }, beyond this Steward's --tool-ceiling "${ toolCeiling.join( ' ' ) }"` };
  }
  // An optional tool is one the job runs without when it cannot have it. One Steward has no
  // server for, or one its --tool-ceiling does not name, is dropped (logged on stderr) and its server never started;
  // the agent then has none of its tools. An admitted one is pre-approved beside the job's tools.
  const optionalTools = [ ...new Set( Array.isArray( job.optionalTools ) ? job.optionalTools.filter( ( tool ) => typeof tool === 'string' && tool !== '' ) : [] ) ]
    .filter( ( tool ) => {
      const why = !Object.hasOwn( OPTIONAL_TOOL_SERVERS, tool ) ? 'this Steward has no server for it'
        : toolCeiling !== undefined && !toolCeiling.includes( tool ) ? `the --tool-ceiling "${ toolCeiling.join( ' ' ) }" does not name it`
          : undefined;
      if ( why !== undefined ) console.error( `blueprint-steward: job ${ job.id } runs without its optional tool ${ tool }: ${ why }` );
      return why === undefined;
    } );
  // The method is fetched and verified before any checkout, push or agent.
  const method = await methodFor( job );
  if ( method.refused ) return method.refused;
  const branch = job.branch || await remoteDefaultBranch() || undefined;
  // The board's live view of the job: each step it enters, each tool the agent calls, and how it ended, posted in
  // batches (lib/activity.mjs). The last batch is posted before the job is reported.
  const relay = createActivityRelay( {
    post: ( entries ) => call( stewardJobRoute( job.id, RUNNER_JOB_ACTIVITY_SEGMENT ), { entries }, { sessionId } ),
    onError: ( err ) => { console.error( `blueprint-steward: activity of job ${ job.id }: ${ err.message }` ); },
  } );
  const onStep = async ( step ) => {
    relay.push( { at: new Date().toISOString(), kind: 'step', name: step } );
    await beatStep( job, step );
  };
  const steps = async () => {
    let dir;
    try {
      dir = await prepareWorktree( sessionId, branch, onStep );
    } catch ( err ) {
      return { ok: false, reason: err.reason ?? 'checkout-failed', result: err.message };
    }
    await push( { extract: true, sessionId, branch: branch ?? await git( 'rev-parse --abbrev-ref HEAD' ), dir, worktree: true, onStep } );
    // The agent's step is beaten before claude is spawned.
    await onStep( 'agent' );
    return runAgent( { ...job, tools: [ ...tools, ...optionalTools.filter( ( tool ) => !tools.includes( tool ) ) ] }, sessionId, dir, method, optionalTools, relay.push );
  };
  // A step that throws (an extraction that fails) fails the job all the same; its end is posted before the report.
  let outcome = { ok: false };
  try {
    outcome = await steps();
  } finally {
    relay.push( { at: new Date().toISOString(), kind: 'end', name: outcome.ok ? 'done' : 'failed' } );
    await relay.close();
    console.log( `[${ job.id.slice( 0, 8 ) }] ${ outcome.ok ? 'done' : `failed${ outcome.reason ? ` (${ outcome.reason })` : '' }` }` );
  }
  return outcome;
};

// A flush job has the host's session bundle committed to origin's branch by
// plumbing (lib/flush.mjs), from the session's worktree when it has one and else from the --repo checkout. Neither's
// HEAD, index or files change, so the worktree is used as it stands and never checked out. It runs in the session's
// lane, so a drop-worktree never removes the worktree under it.
// The session's worktree when it has one, else the --repo checkout; used as it stands, never checked out.
const checkoutOf = async ( sessionId ) => {
  const dir = worktreeOf( sessionId );
  return dir !== undefined && await isWorktreeOfRepo( dir ) ? dir : repo;
};
const runFlush = async ( job ) => {
  const bundle = await call( stewardJobRoute( job.id, RUNNER_JOB_BUNDLE_SEGMENT ), undefined, { method: 'GET', sessionId: job.sessionId } );
  return flushBundle( { dir: await checkoutOf( job.sessionId ), bundle, sessionId: job.sessionId, git: ( cwd, argv, options = {} ) => runQueued( repo, 'git', argv, { cwd, input: options.input, extraEnv: options.env } ) } );
};

// A scaffold job commits the repository's scaffold output on the payload's sha (lib/scaffold.mjs), in
// the session's worktree, which it brings to the job's branch first and then to that sha. It runs in the
// session's lane, so a drop-worktree never removes the worktree under it.
const runScaffold = async ( job ) => {
  const payload = job.payload ?? {};
  const branch = typeof payload.branch === 'string' && payload.branch !== '' ? payload.branch : job.branch;
  const onStep = ( step ) => beatStep( job, step );
  let dir;
  try {
    dir = await prepareWorktree( job.sessionId, branch || undefined, onStep );
  } catch ( err ) {
    return { ok: false, reason: err.reason ?? 'checkout-failed', result: err.message };
  }
  return runScaffoldJob( {
    dir, branch, payload,
    git: ( cwd, argv, options = {} ) => runQueued( repo, 'git', argv, { cwd, input: options.input, extraEnv: options.env } ),
    extract: async ( cwd, command ) => {
      await onStep( 'extract' );
      await extractIn( cwd, command, { worktree: true } );
    },
  } );
};

// A ticket-branch job has origin carry the branch the job names for a ticket. The branch is
// created only where origin lacks it: a push with --force-with-lease=<ref>: (an empty expected value, so git refuses
// the push if the ref exists), from the tip of origin's `base` (its default branch when the job names none). A branch
// origin already has, or gains between the check and the push, is left where it is and reported `exists`. With
// `draftPr`, the branch created is one empty commit on that tip, named for the ticket and made by plumbing (commit-tree) so the checkout's HEAD, index and files never move, because GitHub opens no PR with no
// commits between base and head; the draft PR is then opened through Steward's own gh (BLUEPRINT_STEWARD_GH overrides
// the binary). A gh that is missing leaves no PR; one that refuses leaves none either and its words are reported as
// `prFailed`, never failing the job, whose branch stands. The result is JSON:
// { branch, state: 'created' | 'exists', pr?, prFailed? }.
const runTicketBranch = async ( job ) => {
  const payload = job.payload ?? {};
  const { branch } = payload;
  if ( typeof branch !== 'string' || branch === '' || typeof payload.key !== 'string' ) {
    return { ok: false, result: 'the ticket-branch job carried no branch or ticket key; Steward names none of its own' };
  }
  await beatStep( job, 'branch' );
  const ref = `refs/heads/${ branch }`;
  const onOrigin = async () => {
    const listed = await runGit( repo, [ 'ls-remote', '--heads', 'origin', ref ] );
    if ( listed.status !== 0 ) throw new Error( `git ls-remote origin failed: ${ gitFailure( listed ) }` );
    return listed.stdout.trim() !== '';
  };
  let state = 'exists';
  const base = typeof payload.base === 'string' && payload.base !== '' ? payload.base : await remoteDefaultBranch();
  if ( !await onOrigin() ) {
    const fetched = await runGit( repo, [ 'fetch', '--quiet', 'origin' ] );
    if ( fetched.status !== 0 ) return { ok: false, result: `git fetch origin failed: ${ gitFailure( fetched ) }` };
    const tip = base === undefined ? undefined : await git( `rev-parse --verify --quiet refs/remotes/origin/${ base }^{commit}` );
    if ( tip === undefined ) return { ok: false, result: `the base branch ${ base ?? '(none)' } is not on origin` };
    let head = tip;
    if ( payload.draftPr === true ) {
      const committed = await runGit( repo, [ 'commit-tree', `${ tip }^{tree}`, '-p', tip, '-m', `${ payload.key }: open the design branch` ] );
      if ( committed.status !== 0 ) return { ok: false, result: `git commit-tree for ${ branch } failed: ${ gitFailure( committed ) }` };
      head = committed.stdout.trim();
    }
    const pushed = await runGit( repo, [ 'push', '--quiet', `--force-with-lease=${ ref }:`, 'origin', `${ head }:${ ref }` ] );
    if ( pushed.status === 0 ) state = 'created';
    else if ( !await onOrigin() ) return { ok: false, result: `git push of ${ branch } failed: ${ gitFailure( pushed ) }` };
  }
  console.error( `blueprint-steward: ticket branch ${ branch } ${ state } on origin` );
  let pr;
  let prFailed;
  if ( payload.draftPr === true && base !== undefined ) {
    const title = typeof payload.title === 'string' && payload.title !== '' ? `${ payload.key }: ${ payload.title }` : payload.key;
    const opened = await runQueued( repo, stewardEnv( 'GH' ) ?? 'gh', [
      'pr', 'create', '--draft', '--head', branch, '--base', base, '--title', title, '--body', `Design of ${ payload.key }, opened by Blueprint Steward.`,
    ], { cwd: repo } );
    const url = opened.status === 0 ? opened.stdout.trim().split( '\n' ).pop() : undefined;
    if ( url ) pr = url;
    else {
      console.error( `blueprint-steward: no draft PR for ${ branch }: ${ gitFailure( opened ) }` );
      // A gh that is not installed means no gh (no PR, nothing to report); any other refusal is reported.
      if ( opened.error?.code !== 'ENOENT' ) prFailed = gitFailure( opened );
    }
  }
  return { ok: true, result: JSON.stringify( { branch, state, ...( pr === undefined ? {} : { pr } ), ...( prFailed === undefined ? {} : { prFailed } ) } ) };
};

// The one place a job kind meets its handler, and where a new kind extends dispatch. Every kind here must be in the
// spec's RUNNER_JOB_KINDS, or Steward refuses to start (below). A claim asks for exactly these kinds. A claimed job of
// any other kind is failed kind-unknown: it never falls through to the design flow. A Map, so a kind such as
// "constructor" finds no handler on a prototype.
// Origin's heads and default branch, which a tracker-poll report carries.
const listOrigin = async () => {
  const listed = await runGit( repo, [ 'ls-remote', '--heads', 'origin' ] );
  if ( listed.status !== 0 ) throw new Error( `git ls-remote origin failed: ${ gitFailure( listed ) }` );
  const heads = listed.stdout.split( '\n' ).map( ( line ) => line.split( '\t' )[ 1 ]?.replace( /^refs\/heads\//, '' ) ).filter( Boolean );
  return { heads, defaultBranch: await remoteDefaultBranch() };
};
const JOB_HANDLERS = new Map( [
  [ 'design', ( job ) => inSession( job.sessionId, () => runJob( job, job.sessionId ) ) ],
  [ GIT_POLL_JOB_KIND, () => runGitPoll() ],
  [ 'drop-worktree', ( job ) => dropWorktree( job.sessionId ) ],
  [ 'flush', ( job ) => inSession( job.sessionId, () => runFlush( job ) ) ],
  [ 'ticket-branch', ( job ) => runTicketBranch( job ) ],
  // pr-ready takes the ticket branch's draft PR out of draft, GitHub only (lib/pr-ready.mjs).
  [ PR_READY_JOB_KIND, async ( job ) => runPrReady( job, { repo, remoteUrl: await git( 'remote get-url origin' ) } ) ],
  [ SCAFFOLD_JOB_KIND, ( job ) => inSession( job.sessionId, () => runScaffold( job ) ) ],
  // A read for the hosted agent's KPI lookup, outside the session's lane (inSession), so it never
  // waits behind the session's own running design job; in the session's worktree, else the --repo checkout.
  [ OBSERVABILITY_READ_JOB_KIND, async ( job ) => runObservabilityRead( job, { dir: await checkoutOf( job.sessionId ) } ) ],
  // The tracker kinds, only with the whole Jira credential in the environment (lib/tracker.mjs).
  ...trackerJobHandlers( {
    baseUrl: process.env.BLUEPRINT_JIRA_BASE_URL, email: process.env.BLUEPRINT_JIRA_EMAIL, apiToken: process.env.BLUEPRINT_JIRA_API_TOKEN,
  }, { origin: listOrigin } ),
  // implementation-dispatch, only with at least one whole BLUEPRINT_ROUTINE_<ALIAS>_URL / _TOKEN pair,
  // which lib/routine.mjs reads from process.env itself (this file reads the environment only by name).
  ...routineJobHandlers(),
] );
// The aliases Steward holds a routine for, by name only, which the claim declares so the server hands
// a dispatch only where its alias is held. Never the URL or the token.
const ROUTINE_ALIASES = routineAliases();
// A handler for a kind the server does not know would make every claim a 400 RUNNER_KIND_UNKNOWN; refuse to start.
const unlisted = [ ...JOB_HANDLERS.keys() ].filter( ( kind ) => !RUNNER_JOB_KINDS.includes( kind ) );
if ( unlisted.length > 0 ) throw new Error( `blueprint-steward: job kinds ${ unlisted.join( ', ' ) } have handlers but are not in RUNNER_JOB_KINDS` );
const runKind = ( job ) => {
  const handler = JOB_HANDLERS.get( job.kind );
  if ( handler === undefined ) {
    return { ok: false, reason: 'kind-unknown', result: `this Steward has no handler for job kind ${ JSON.stringify( job.kind ) }; it runs ${ [ ...JOB_HANDLERS.keys() ].join( ', ' ) }` };
  }
  return handler( job );
};

try {
  if ( command === 'push' ) {
    await push( { extract: !args.includes( '--no-extract' ), sessionId: sessionFlag } );
  } else if ( command === 'enqueue' ) {
    // With no session named, the host picks this repository's own session from its origin remote.
    const remoteUrl = sessionFlag ? undefined : await git( 'remote get-url origin' );
    const { job } = await call( STEWARD_JOBS_ROUTE, { kind: 'design', branch: flag( '--branch' ), prompt: flag( '--prompt' ), remoteUrl }, { sessionId: sessionFlag } );
    console.log( `blueprint-steward: queued job ${ job.id } for session ${ job.sessionId }` );
  } else if ( args.includes( '--poll-once' ) ) {
    await mergePollTick();
  } else {
    const intervalMs = Number( flag( '--interval' ) ?? 5 ) * 1000;
    // The merge poller is its own timer, never the job-claim cadence: a tick every --merge-poll seconds.
    // --once is the single-job mode and keeps its old request sequence, so it starts no poller.
    const mergePollMs = Number( flag( '--merge-poll' ) || process.env.BLUEPRINT_MERGE_POLL_SECONDS || 300 ) * 1000;
    const mergePoll = async () => {
      await mergePollTick().catch( ( err ) => { console.error( `blueprint-steward: merge poll: ${ err.message }` ); } );
      setTimeout( mergePoll, mergePollMs );
    };
    if ( !args.includes( '--once' ) ) mergePoll();
    console.error( `blueprint-steward: polling ${ server } every ${ intervalMs / 1000 }s against ${ repo }, up to ${ concurrency } jobs at once` );
    const runAndReport = async ( job ) => {
      console.error( `blueprint-steward: claimed job ${ job.id } (${ job.kind })` );
      let outcome;
      try {
        outcome = await runKind( job );
      } catch ( err ) {
        outcome = { ok: false, result: err.message };
      }
      // A job whose lease the host gave up is no longer Steward's to report.
      if ( outcome.lost ) {
        console.error( `blueprint-steward: job ${ job.id } lost its lease; not reported` );
        return;
      }
      await call( stewardJobRoute( job.id ), {
        status: outcome.ok ? 'done' : 'failed', result: outcome.result,
        ...( outcome.reason ? { reason: outcome.reason } : {} ), ...( outcome.usage ? { usage: outcome.usage } : {} ),
      }, { sessionId: job.sessionId } )
        .catch( ( err ) => { console.error( `blueprint-steward: report failed: ${ err.message }` ); } );
      console.error( `blueprint-steward: job ${ job.id } ${ outcome.ok ? 'done' : 'failed' }` );
    };
    // Up to --concurrency jobs run at once. With a slot free Steward claims again straight after a
    // job; otherwise it waits --interval, or until a running job ends.
    // With every slot full it still claims, for the kinds that run no agent and are bounded (one per
    // session per kind by the host's claim, each under its own timeout): observability reads.
    const running = new Set();
    const readsOnly = [ OBSERVABILITY_READ_JOB_KIND ].filter( ( kind ) => JOB_HANDLERS.has( kind ) );
    for ( ;; ) {
      let job;
      const kinds = running.size < concurrency ? [ ...JOB_HANDLERS.keys() ] : readsOnly;
      if ( kinds.length > 0 ) {
        try {
          ( { job } = await call( STEWARD_CLAIM_ROUTE, {
            remoteUrl: await git( 'remote get-url origin' ), kinds, runnerVersion: STEWARD_VERSION,
            ...( kinds.includes( IMPLEMENTATION_DISPATCH_JOB_KIND ) ? { routineAliases: ROUTINE_ALIASES } : {} ),
          }, { sessionId: sessionFlag } ) );
        } catch ( err ) {
          console.error( `blueprint-steward: ${ err.message }` );
        }
      }
      if ( job ) {
        const work = runAndReport( job ).finally( () => { running.delete( work ); } );
        running.add( work );
        if ( args.includes( '--once' ) ) {
          await work;
          break;
        }
        if ( running.size < concurrency ) continue;
      }
      await Promise.race( [ new Promise( ( r ) => setTimeout( r, intervalMs ) ), ...running ] );
    }
  }
} catch ( err ) {
  console.error( `blueprint-steward: ${ err.message }` );
  process.exit( 1 );
}
