import { spawn, execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { METHOD_MIN_RUNNER_VERSION, RUNNER_HEARTBEAT_MAX_SECONDS, runnerMeets } from '@bett3r-dev/blueprint-spec';
import { toolList } from '../lib/tool-list.mjs';
import { INIT_LINE, INIT_LINE_NO_PLUGIN, METHOD, METHOD_ROUTE, METHOD_ZIP, printInit, sha256Of, STREAM_2_1_287, STREAM_2_1_288_SESSION_START_HOOK } from './method-fixture';

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );

type Req = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any };
type Handler = ( req: Req ) => { status?: number; body?: unknown };

// A job heartbeats each step it enters; the request sequences below are pinned without those beats.
// Nor the design job's method download, which the method tests below pin on their own. Nor a design job's
// activity posts, which the activity test below pins.
const unstepped = ( requests: Req[] ) => requests.filter( ( q ) => !( q.url.endsWith( '/heartbeat' ) && q.body?.step !== undefined ) && !METHOD_ROUTE.test( q.url )
  && !q.url.endsWith( '/activity' ) );

const servers: Server[] = [];
afterEach( () => { for ( const s of servers.splice( 0 ) ) s.close(); } );

// A GET on a job's method route is answered with `method` (the zip bytes, or a refusal) before the
// handler sees it; every host serves METHOD_ZIP, whose sha256 is the one METHOD names, unless a test says otherwise.
type MethodAnswer = Buffer | { status: number; body: unknown };
const fakeHost = async ( handler: Handler, { method = METHOD_ZIP }: { method?: MethodAnswer } = {} ) => {
  const requests: Req[] = [];
  const server = createServer( ( req, res ) => {
    let data = '';
    req.on( 'data', ( c ) => { data += c; } );
    req.on( 'end', () => {
      const r: Req = { method: req.method!, url: req.url!, headers: req.headers, body: data ? JSON.parse( data ) : undefined };
      requests.push( r );
      if ( r.method === 'GET' && METHOD_ROUTE.test( r.url ) ) {
        if ( Buffer.isBuffer( method ) ) {
          res.writeHead( 200, { 'Content-Type': 'application/zip', 'Content-Length': String( method.length ) } );
          res.end( method );
        } else {
          res.writeHead( method.status, { 'Content-Type': 'application/json' } );
          res.end( JSON.stringify( method.body ) );
        }
        return;
      }
      const { status = 200, body = {} } = handler( r );
      res.writeHead( status, { 'Content-Type': 'application/json' } );
      res.end( JSON.stringify( body ) );
    } );
  } );
  servers.push( server );
  await new Promise<void>( ( r ) => server.listen( 0, '127.0.0.1', () => r() ) );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${ port }`, requests };
};

const makeRepo = ( extract = 'mkdir -p .blueprint && echo \'{"nodes":[1,2]}\' > .blueprint/graph.json' ) => {
  const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-repo-' ) );
  writeFileSync( join( dir, '.blueprint.config.json' ), JSON.stringify( { designTooling: { extract } } ) );
  writeFileSync( join( dir, '.gitignore' ), '.blueprint/\n' );
  // `feature` carries a commit of its own, so no two branches share a head and a push's commitSha names the
  // branch that was actually checked out.
  execSync( 'git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init'
    + ' && git checkout -q -b feature && echo f > feature.txt && git -c user.email=t@t -c user.name=t add feature.txt'
    + ' && git -c user.email=t@t -c user.name=t commit -qm feature && git checkout -q main', { cwd: dir } );
  const remote = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-remote-' ) );
  execSync( `git init -q --bare ${ remote }` );
  execSync( `git remote add origin ${ remote } && git push -q origin main && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`, { cwd: dir } );
  return dir;
};

// Where Steward keeps a session's worktree, derived from the session id alone
// (worktreeOf in bin/blueprint-steward.mjs): `<repo>.blueprint-worktrees/<sessionId>`, beside the --repo checkout.
const worktreeOf = ( repo: string, sessionId: string ) => join( `${ repo }.blueprint-worktrees`, sessionId );
const realDir = ( dir: string ) => ( existsSync( dir ) ? execSync( 'pwd -P', { cwd: dir, encoding: 'utf-8' } ).trim() : `<no directory ${ dir }>` );

// `stream`: stream-json lines the fake writes after its init line (none by default).
const makeFakeClaude = ( exitCode: number, stream = '' ) => {
  const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
  const record = join( dir, 'record.json' );
  const script = join( dir, 'claude.mjs' );
  writeFileSync( script, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const cfg = argv[argv.indexOf('--mcp-config') + 1];
writeFileSync(${ JSON.stringify( record ) }, JSON.stringify({ argv, cwd: process.cwd(), env: process.env, mcpRaw: readFileSync(cfg, 'utf-8'), mcp: JSON.parse(readFileSync(cfg, 'utf-8')) }));
${ printInit }
process.stdout.write(${ JSON.stringify( stream ) });
console.log('fake agent output');
process.exit(${ exitCode });
` );
  execSync( `chmod +x ${ script }` );
  return { script, record };
};

// The caller's routine variables are scrubbed, so a claim's kinds are the fixture's, not the shell's.
const withoutRoutines = ( env: NodeJS.ProcessEnv ) => Object.fromEntries( Object.entries( env ).filter( ( [ name ] ) => !name.startsWith( 'BLUEPRINT_ROUTINE_' ) ) );
// A variable given as undefined is unset in Steward's environment.
const run = ( args: string[], env: Record<string, string | undefined> = {}, opts: { killWhen?: () => boolean } = {} ) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>( ( res ) => {
    const merged = { ...withoutRoutines( process.env ), BLUEPRINT_STEWARD_TOKEN: '', BLUEPRINT_SESSION_ID: '', BLUEPRINT_JIRA_API_TOKEN: '', BLUEPRINT_STEWARD_AGENT_SESSIONS_DIR: '', ...env };
    const child = spawn( process.execPath, [ BIN, ...args ], { env: Object.fromEntries( Object.entries( merged ).filter( ( [ , value ] ) => value !== undefined ) ) } );
    let stdout = '', stderr = '';
    child.stdout.on( 'data', ( c ) => { stdout += c; } );
    child.stderr.on( 'data', ( c ) => { stderr += c; } );
    const timer = opts.killWhen ? setInterval( () => { if ( opts.killWhen!() ) child.kill(); }, 20 ) : undefined;
    child.on( 'close', ( code ) => { if ( timer ) clearInterval( timer ); res( { code, stdout, stderr } ); } );
  } );

describe( 'blueprint-steward CLI', () => {
  it( 'push sends graph, branch, commitSha and the session header', async () => {
    const host = await fakeHost( () => ( {} ) );
    const repo = makeRepo();
    const r = await run( [ 'push', '--server', host.url, '--token', 'tok', '--repo', repo, '--session', 's1' ] );
    expect( r.code ).toBe( 0 );
    expect( host.requests ).toHaveLength( 1 );
    const [ req ] = host.requests;
    expect( req.url ).toBe( '/api/blueprint/reality' );
    expect( req.headers.authorization ).toBe( 'Bearer tok' );
    expect( req.headers[ 'x-blueprint-session-id' ] ).toBe( 's1' );
    expect( req.body.graph ).toEqual( { nodes: [ 1, 2 ] } );
    expect( req.body.branch ).toBe( 'main' );
    expect( req.body.commitSha ).toBe( execSync( 'git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' } ).trim() );
  } );

  it( 'push sends remoteUrl, baseBranch and overrides so the reality route can bind a repositoryId', async () => {
    const host = await fakeHost( () => ( {} ) );
    const repo = makeRepo();
    writeFileSync( join( repo, '.blueprint.overrides.json' ), JSON.stringify( { schemaVersion: 1, add: { nodes: [] } } ) );
    const r = await run( [ 'push', '--server', host.url, '--token', 'tok', '--repo', repo, '--session', 's1' ] );
    expect( r.code ).toBe( 0 );
    const [ req ] = host.requests;
    expect( req.body.remoteUrl ).toBe( execSync( 'git remote get-url origin', { cwd: repo, encoding: 'utf-8' } ).trim() );
    expect( req.body.baseBranch ).toBe( 'main' );
    expect( req.body.overrides ).toEqual( { schemaVersion: 1, add: { nodes: [] } } );
  } );

  it( 'push omits overrides when no .blueprint.overrides.json is present', async () => {
    const host = await fakeHost( () => ( {} ) );
    const repo = makeRepo();
    const r = await run( [ 'push', '--server', host.url, '--token', 'tok', '--repo', repo, '--session', 's1' ] );
    expect( r.code ).toBe( 0 );
    const [ req ] = host.requests;
    expect( req.body.overrides ).toBeUndefined();
  } );

  it( 'missing server or token exits 1 with usage', async () => {
    const noServer = await run( [ 'push', '--token', 't' ] );
    expect( noServer.code ).toBe( 1 );
    expect( noServer.stderr ).toContain( 'Usage:' );
    const noToken = await run( [ 'push', '--server', 'http://127.0.0.1:1' ] );
    expect( noToken.code ).toBe( 1 );
    expect( noToken.stderr ).toContain( 'Usage:' );
    // Enqueue no longer requires a session; the host picks the repository's own.
    expect( noToken.stderr ).toContain( 'blueprint-steward enqueue --server <url> [--token <t>] [--session <id>] [--branch <b>]' );
  } );

  it( 'enqueue posts a design job with the session header', async () => {
    const host = await fakeHost( () => ( { body: { job: { id: 'j1', sessionId: 's1' } } } ) );
    const r = await run( [ 'enqueue', '--server', host.url, '--token', 'tok', '--session', 's1', '--branch', 'feature', '--prompt', 'hi' ] );
    expect( r.code ).toBe( 0 );
    expect( r.stdout ).toContain( 'queued job j1' );
    const [ req ] = host.requests;
    expect( req.url ).toBe( '/api/blueprint/steward/jobs' );
    expect( req.headers[ 'x-blueprint-session-id' ] ).toBe( 's1' );
    expect( req.body ).toEqual( { kind: 'design', branch: 'feature', prompt: 'hi' } );
  } );

  // With no session named, the host picks the repository's own session from remoteUrl.
  it( 'enqueue with no session sends the origin remoteUrl and no session header', async () => {
    const host = await fakeHost( () => ( { body: { job: { id: 'j1', sessionId: 's-repo' } } } ) );
    const repo = makeRepo();
    const r = await run( [ 'enqueue', '--server', host.url, '--token', 'tok', '--repo', repo, '--prompt', 'hi' ] );
    expect( r.code ).toBe( 0 );
    const [ req ] = host.requests;
    expect( req.headers[ 'x-blueprint-session-id' ] ).toBeUndefined();
    expect( req.body ).toEqual( { kind: 'design', prompt: 'hi', remoteUrl: execSync( 'git remote get-url origin', { cwd: repo, encoding: 'utf-8' } ).trim() } );
  } );

  // A design claim carries the text the hosted turn runs; Steward keeps none.
  const SERVED = { text: 'Served hosted-turn text, version 3.', version: 3, sha256: 'a'.repeat( 64 ) };
  // The tools a design claim carries.
  const TOOLS = { tools: [ 'mcp__blueprint', 'Read', 'Glob', 'Grep' ], disallowedTools: [ 'mcp__blueprint__start_map_session' ] };

  const jobHost = () => fakeHost( ( req ) =>
    req.url === '/api/blueprint/steward/claim'
      ? { body: { job: { id: 'j9', kind: 'design', sessionId: 'sess-9', branch: 'feature', prompt: 'do it', jobKey: 'bpjk_minted-for-j9', instructions: SERVED, method: METHOD, ...TOOLS } } }
      : {} );

  it( 'start --once: posts the job\'s activity (steps and tool names, never inputs) before its report, and logs one line per event', async () => {
    const host = await jobHost();
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const script = join( dir, 'claude.mjs' );
    const toolUse = { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'secret thought' },
      { type: 'tool_use', id: 't1', name: 'mcp__blueprint__read_changes', input: { path: 'src/secret-code.ts' } },
      { type: 'text', text: 'Customer code excerpt' },
    ] } };
    const toolResult = { type: 'user', message: { content: [ { type: 'tool_result', tool_use_id: 't1', content: 'const secret = 1;' } ] } };
    const result = { type: 'result', subtype: 'success', result: 'ok', duration_ms: 1200, num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} };
    writeFileSync( script, `#!/usr/bin/env node
${ printInit }
process.stdout.write(${ JSON.stringify( [ toolUse, toolResult, result ].map( ( e ) => JSON.stringify( e ) ).join( '\n' ) + '\n' ) });
` );
    chmodSync( script, 0o755 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: script } );
    expect( r.code ).toBe( 0 );
    const urls = host.requests.map( ( q ) => q.url );
    const posts = host.requests.filter( ( q ) => q.url === '/api/blueprint/steward/jobs/j9/activity' );
    expect( posts.length ).toBeGreaterThan( 0 );
    expect( urls.lastIndexOf( '/api/blueprint/steward/jobs/j9/activity' ) ).toBeLessThan( urls.lastIndexOf( '/api/blueprint/steward/jobs/j9' ) );
    expect( posts[ 0 ].headers[ 'x-blueprint-session-id' ] ).toBe( 'sess-9' );
    const entries = posts.flatMap( ( q ) => q.body.entries ).map( ( { kind, name } ) => ( name === undefined ? { kind } : { kind, name } ) );
    expect( entries ).toEqual( [
      { kind: 'step', name: 'worktree' }, { kind: 'step', name: 'extract' }, { kind: 'step', name: 'push' }, { kind: 'step', name: 'agent' },
      { kind: 'tool', name: 'mcp__blueprint__read_changes' }, { kind: 'text' }, { kind: 'end', name: 'done' },
    ] );
    const sent = JSON.stringify( posts.map( ( q ) => q.body ) );
    for ( const secret of [ 'secret-code', 'secret thought', 'Customer code', 'const secret' ] ) expect( sent ).not.toContain( secret );
    expect( r.stdout ).toContain( '[j9] → mcp__blueprint__read_changes path=src/secret-code.ts' );
    expect( r.stdout ).toContain( '[j9] ← ok · 17 chars' );
    expect( r.stdout ).toContain( '[j9] ■ success · 1s · 2 turns · $0.01' );
    expect( r.stdout ).not.toContain( '"type":"assistant"' );
  } );

  it( 'start --once against a server that serves only the legacy runner routes: the first steward call answered 404 with no refusal of its own is made again under /api/blueprint/runner, as is every later one', async () => {
    const host = await fakeHost( ( req ) => {
      if ( req.url.startsWith( '/api/blueprint/steward/' ) ) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no route' } } };
      return req.url === '/api/blueprint/runner/claim'
        ? { body: { job: { id: 'j9', kind: 'design', sessionId: 'sess-9', branch: 'feature', prompt: 'do it', jobKey: 'bpjk_minted-for-j9', instructions: SERVED, method: METHOD, ...TOOLS } } }
        : {};
    } );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code, r.stderr ).toBe( 0 );
    expect( unstepped( host.requests ).map( ( q ) => q.url ) ).toEqual( [
      '/api/blueprint/steward/claim', '/api/blueprint/runner/claim', '/api/blueprint/reality', '/api/blueprint/runner/jobs/j9',
    ] );
    expect( host.requests.filter( ( q ) => q.url.startsWith( '/api/blueprint/steward/' ) ) ).toHaveLength( 1 );
    expect( unstepped( host.requests ).at( -1 )?.body.status ).toBe( 'done' );
  } );

  it( 'start --once: claim, worktree, reality, agent in the session\'s worktree with mcp config, report done', async () => {
    const host = await jobHost();
    const repo = makeRepo();
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const requests = unstepped( host.requests );
    expect( requests.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/reality', '/api/blueprint/steward/jobs/j9' ] );
    expect( requests[ 1 ].headers[ 'x-blueprint-session-id' ] ).toBe( 'sess-9' );
    expect( requests[ 1 ].body.branch ).toBe( 'feature' );
    const rec = JSON.parse( readFileSync( claude.record, 'utf-8' ) );
    expect( rec.argv[ 0 ] ).toBe( '-p' );
    expect( rec.argv[ 1 ] ).toBe( `${ SERVED.text }\n\nThe owner asks: do it` );
    expect( rec.argv ).toContain( '--strict-mcp-config' );
    // The agent runs in the session's own worktree, never in the --repo checkout.
    expect( realDir( rec.cwd ) ).toBe( realDir( worktreeOf( repo, 'sess-9' ) ) );
    expect( realDir( rec.mcp.mcpServers.blueprint.env.BLUEPRINT_REPO_PATH ) ).toBe( realDir( worktreeOf( repo, 'sess-9' ) ) );
    expect( rec.mcp.mcpServers.blueprint.env ).toMatchObject( { BLUEPRINT_HOST_URL: host.url, BLUEPRINT_SESSION_ID: 'sess-9', BLUEPRINT_ACCESS_TOKEN: 'bpjk_minted-for-j9' } );
    expect( existsSync( rec.mcp.mcpServers.blueprint.args[ 0 ] ) ).toBe( true );
    const report = requests[ 2 ];
    expect( report.headers[ 'x-blueprint-session-id' ] ).toBe( 'sess-9' );
    expect( report.body.status ).toBe( 'done' );
    expect( report.body.result ).toContain( 'fake agent output' );
  } );

  // The server picks the model and the optional run cap and the claim carries both; Steward passes them to claude
  // as --model and --max-budget-usd (USD, from micros). A job carrying neither adds neither flag.
  const modelHost = ( stamped: Record<string, unknown> ) => fakeHost( ( req ) =>
    req.url === '/api/blueprint/steward/claim'
      ? { body: { job: { id: 'jm', kind: 'design', sessionId: 'sess-m', branch: 'feature', prompt: 'do it', jobKey: 'bpjk_minted-for-jm', instructions: SERVED, method: METHOD, ...TOOLS, ...stamped } } }
      : {} );
  const flagOf = ( argv: string[], flag: string ) => ( argv.includes( flag ) ? argv[ argv.indexOf( flag ) + 1 ] : undefined );

  it( 'start --once: a claimed job carrying model and runCapUsdMicros 2000000 runs claude with --model <id> and --max-budget-usd 2', async () => {
    const host = await modelHost( { model: 'claude-sonnet-5-5', runCapUsdMicros: 2_000_000 } );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const { argv } = JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[] };
    expect( [ flagOf( argv, '--model' ), flagOf( argv, '--max-budget-usd' ) ] ).toEqual( [ 'claude-sonnet-5-5', '2' ] );
    expect( host.requests.at( -1 )!.body.status ).toBe( 'done' );
  } );

  it( 'start --once: a claimed job with a model and no cap passes --model only; one with neither passes neither flag', async () => {
    const uncapped = await modelHost( { model: 'claude-opus-5-5', runCapUsdMicros: null } );
    const bare = await modelHost( { model: null, runCapUsdMicros: null } );
    const first = makeFakeClaude( 0 );
    const second = makeFakeClaude( 0 );
    await run( [ 'start', '--server', uncapped.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: first.script } );
    await run( [ 'start', '--server', bare.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: second.script } );
    const argvOf = ( record: string ) => ( JSON.parse( readFileSync( record, 'utf-8' ) ) as { argv: string[] } ).argv;
    expect( [ flagOf( argvOf( first.record ), '--model' ), argvOf( first.record ).includes( '--max-budget-usd' ) ] ).toEqual( [ 'claude-opus-5-5', false ] );
    expect( [ argvOf( second.record ).includes( '--model' ), argvOf( second.record ).includes( '--max-budget-usd' ) ] ).toEqual( [ false, false ] );
  } );

  it( 'start --once reports failed when the agent exits non-zero', async () => {
    const host = await jobHost();
    const claude = makeFakeClaude( 1 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    expect( host.requests.at( -1 )!.body.status ).toBe( 'failed' );
  } );

  it( 'start --once reports failed when extraction fails, without running the agent', async () => {
    const host = await jobHost();
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo( 'exit 3' ), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const requests = unstepped( host.requests );
    expect( requests.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/steward/jobs/j9' ] );
    expect( requests[ 1 ].body.status ).toBe( 'failed' );
    expect( existsSync( claude.record ) ).toBe( false );
  } );

  // The claim names the checkout's origin, the kinds Steward runs and its version, so the host hands it only its
  // own repository's jobs of those kinds. Steward removes worktrees, so it names drop-worktree; a claim naming no
  // kinds is never handed one. It commits session bundles, so it names flush; it answers observability reads, so it
  // names observability-read. With no BLUEPRINT_ROUTINE_* pair it holds no routine, so it names neither
  // implementation-dispatch nor any alias. It commits the scaffold output, so it names scaffold. It loads the method
  // plugin the host serves with a design claim (METHOD_MIN_RUNNER_VERSION from @bett3r-dev/blueprint-spec). It answers
  // card threads, so it names reply (Blueprint ADR-137), explicitly: a claim naming no kinds counts as running no
  // replies, and its design claims get no agent context. Version 1.4.0 runs reply and design jobs in their agent context.
  // It refreshes a repository's baseline when a merge into its default branch is reported, so it names baseline-refresh.
  it( 'start --once: the claim carries the origin remoteUrl, the kinds design, reply, git-poll, drop-worktree, flush, ticket-branch, pr-ready, scaffold, observability-read and baseline-refresh, and Steward\'s version 1.4.0', async () => {
    const host = await fakeHost( () => ( { body: { job: null } } ) );
    const repo = makeRepo();
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--interval', '60', '--merge-poll', '600' ], {},
      { killWhen: () => host.requests.some( ( q ) => q.url === '/api/blueprint/steward/claim' ) } );
    const claim = host.requests.find( ( q ) => q.url === '/api/blueprint/steward/claim' )!;
    expect( claim.body ).toMatchObject( {
      remoteUrl: execSync( 'git remote get-url origin', { cwd: repo, encoding: 'utf-8' } ).trim(),
      kinds: [ 'design', 'reply', 'git-poll', 'drop-worktree', 'flush', 'ticket-branch', 'pr-ready', 'scaffold', 'observability-read', 'baseline-refresh' ],
    } );
    expect( claim.body.runnerVersion ).toBe( '1.4.0' );
    expect( claim.body.routineAliases ).toBeUndefined();
    // The host hands design jobs only to a version at or above its method minimum: Steward must meet it.
    expect( runnerMeets( claim.body.runnerVersion, METHOD_MIN_RUNNER_VERSION ) ).toBe( true );
  } );

  // With the whole Jira credential in its environment Steward holds the tracker handlers, so its claim names the
  // kinds; the case above, with BLUEPRINT_JIRA_API_TOKEN scrubbed, pins that it does not without one. The same
  // credential runs tracker-transition, tracker-describe and tracker-create.
  it( 'start: with BLUEPRINT_JIRA_BASE_URL, _EMAIL and _API_TOKEN set, the claim\'s kinds are design, reply, git-poll, drop-worktree, flush, ticket-branch, pr-ready, scaffold, observability-read, baseline-refresh, tracker-poll, tracker-comment, tracker-transition, tracker-describe and tracker-create', async () => {
    const host = await fakeHost( () => ( { body: { job: null } } ) );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--interval', '60', '--merge-poll', '600' ], {
      BLUEPRINT_JIRA_BASE_URL: 'https://acme.atlassian.net', BLUEPRINT_JIRA_EMAIL: 'bot@acme.test', BLUEPRINT_JIRA_API_TOKEN: 'jira-token',
    }, { killWhen: () => host.requests.some( ( q ) => q.url === '/api/blueprint/steward/claim' ) } );
    const claim = host.requests.find( ( q ) => q.url === '/api/blueprint/steward/claim' )!;
    expect( claim.body.kinds ).toEqual( [ 'design', 'reply', 'git-poll', 'drop-worktree', 'flush', 'ticket-branch', 'pr-ready', 'scaffold', 'observability-read', 'baseline-refresh', 'tracker-poll', 'tracker-comment', 'tracker-transition', 'tracker-describe', 'tracker-create' ] );
  } );

  // Blueprint ADR-121: a merge into the default branch queues a baseline-refresh on the baseline. Steward brings the
  // baseline's worktree to origin's tip of that branch, extracts there and pushes it to the baseline, and runs no agent.
  // A job naming no branch is refreshed from origin's default branch.
  it.each( [ [ 'main' ], [ null ] ] )( 'start --once: a baseline-refresh job (branch %s) pushes origin\'s merged main, extracted in the baseline\'s worktree, to the baseline, and reports done without claude', async ( jobBranch ) => {
    const host = await fakeHost( ( req ) =>
      req.url === '/api/blueprint/steward/claim' ? { body: { job: { id: 'jr', kind: 'baseline-refresh', sessionId: 'sess-base', branch: jobBranch, prompt: null } } } : {} );
    const repo = makeRepo( 'mkdir -p .blueprint && if [ -f merged.txt ]; then echo \'{"nodes":["merged"]}\'; else echo \'{"nodes":[]}\'; fi > .blueprint/graph.json' );
    // The merge lands on origin's main; the checkout's own main stays at the pre-merge commit.
    execSync( 'git checkout -q -b merging && echo m > merged.txt && git -c user.email=t@t -c user.name=t add merged.txt && git -c user.email=t@t -c user.name=t commit -qm merged'
      + ' && git push -q origin merging:main && git checkout -q main && git branch -q -D merging', { cwd: repo } );
    const mergedSha = execSync( 'git rev-parse origin/main', { cwd: repo, encoding: 'utf-8' } ).trim();
    expect( execSync( 'git rev-parse main', { cwd: repo, encoding: 'utf-8' } ).trim() ).not.toBe( mergedSha );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const requests = unstepped( host.requests );
    expect( requests.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/reality', '/api/blueprint/steward/jobs/jr' ] );
    expect( requests[ 1 ].headers[ 'x-blueprint-session-id' ] ).toBe( 'sess-base' );
    expect( requests[ 1 ].body ).toMatchObject( { branch: 'main', commitSha: mergedSha, graph: { nodes: [ 'merged' ] } } );
    // Extracted in the baseline's worktree, at the merged tip; the --repo checkout never moved.
    expect( [ existsSync( join( worktreeOf( repo, 'sess-base' ), 'merged.txt' ) ), existsSync( join( repo, 'merged.txt' ) ) ] ).toEqual( [ true, false ] );
    expect( requests[ 2 ].body ).toMatchObject( { status: 'done' } );
    expect( existsSync( claude.record ) ).toBe( false );
  } );

  // Blueprint's "Check git now" queues a baseline-refresh on the session it is pressed on, for its bound branch. A
  // refresh at the tip the session's worktree last pushed from extracts nothing and pushes nothing; a new tip does.
  it( 'start --once: a second baseline-refresh at the tip already pushed pushes nothing and reports done, and one after a new commit on origin pushes it', async () => {
    const host = await fakeHost( ( req ) =>
      req.url === '/api/blueprint/steward/claim' ? { body: { job: { id: 'jr', kind: 'baseline-refresh', sessionId: 'sess-x', branch: 'main', prompt: null } } } : {} );
    const repo = makeRepo( 'mkdir -p .blueprint && echo \'{"nodes":[]}\' > .blueprint/graph.json && echo x >> extracted.log' );
    const once = async () => {
      host.requests.length = 0;
      expect( ( await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script } ) ).code ).toBe( 0 );
      return unstepped( host.requests );
    };
    const extractions = () => readFileSync( join( worktreeOf( repo, 'sess-x' ), 'extracted.log' ), 'utf-8' ).trim().split( '\n' ).length;

    expect( ( await once() ).map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/reality', '/api/blueprint/steward/jobs/jr' ] );
    const again = await once();
    expect( again.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/steward/jobs/jr' ] );
    expect( again[ 1 ].body ).toMatchObject( { status: 'done' } );
    expect( extractions() ).toBe( 1 );

    execSync( 'git checkout -q -b moving && echo n > new.txt && git -c user.email=t@t -c user.name=t add new.txt && git -c user.email=t@t -c user.name=t commit -qm new'
      + ' && git push -q origin moving:main && git checkout -q main && git branch -q -D moving', { cwd: repo } );
    const newSha = execSync( 'git rev-parse origin/main', { cwd: repo, encoding: 'utf-8' } ).trim();
    const moved = await once();
    expect( moved.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/reality', '/api/blueprint/steward/jobs/jr' ] );
    expect( moved[ 1 ].body ).toMatchObject( { branch: 'main', commitSha: newSha } );
  } );

  // A fake host that binds a session to the branch of its latest reality push. A job on a session bound to feat/x
  // pushes feat/x, whatever the checkout had out.
  const bindingHost = ( jobBranch: string | null, bound: string | null ) => {
    const state = { binding: bound };
    return fakeHost( ( req ) => {
      if ( req.url === '/api/blueprint/steward/claim' ) return { body: { job: { id: 'jb', kind: 'design', sessionId: 'sess-b', branch: jobBranch, prompt: null, jobKey: 'bpjk_minted-for-jb', instructions: SERVED, method: METHOD, ...TOOLS } } };
      if ( req.url === '/api/blueprint/reality' ) state.binding = req.body.branch;
      return {};
    } ).then( ( host ) => ( { ...host, state } ) );
  };

  it( 'start --once: a press on a session bound to feat/x with Steward\'s checkout on main pushes feat/x and leaves the binding at feat/x', async () => {
    const host = await bindingHost( 'feat/x', 'feat/x' );
    const repo = makeRepo();
    execSync( 'git checkout -q -b feat/x && echo x > x.txt && git -c user.email=t@t -c user.name=t add x.txt && git -c user.email=t@t -c user.name=t commit -qm x && git checkout -q main', { cwd: repo } );
    const featSha = execSync( 'git rev-parse feat/x', { cwd: repo, encoding: 'utf-8' } ).trim();
    expect( featSha ).not.toBe( execSync( 'git rev-parse main', { cwd: repo, encoding: 'utf-8' } ).trim() );
    expect( execSync( 'git rev-parse --abbrev-ref HEAD', { cwd: repo, encoding: 'utf-8' } ).trim() ).toBe( 'main' );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script } );
    expect( r.code ).toBe( 0 );
    const pushed = host.requests.find( ( q ) => q.url === '/api/blueprint/reality' )!;
    expect( pushed.body.branch ).toBe( 'feat/x' );
    expect( pushed.body.commitSha ).toBe( featSha );
    expect( host.state.binding ).toBe( 'feat/x' );
  } );

  it( 'start --once: a job on an unbound session pushes the remote\'s default branch, not the checkout\'s own HEAD', async () => {
    const host = await bindingHost( null, null );
    const repo = makeRepo();
    execSync( 'git checkout -q feature', { cwd: repo } );
    const mainSha = execSync( 'git rev-parse origin/main', { cwd: repo, encoding: 'utf-8' } ).trim();
    expect( execSync( 'git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' } ).trim() ).not.toBe( mainSha );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script } );
    expect( r.code ).toBe( 0 );
    const pushed = host.requests.find( ( q ) => q.url === '/api/blueprint/reality' )!;
    expect( pushed.body.branch ).toBe( 'main' );
    expect( pushed.body.commitSha ).toBe( mainSha );
    expect( host.state.binding ).toBe( 'main' );
  } );

  // The agent's board tool carries the key the claim minted for its job, and Steward's org key reaches neither the
  // MCP config nor the agent's environment, however Steward was given it.
  it( 'start --once: the MCP config carries the claim\'s job key as BLUEPRINT_ACCESS_TOKEN and the org token appears nowhere in the config or the agent\'s env', async () => {
    const ORG_TOKEN = 'org-secret-3f9c1d';
    const host = await jobHost();
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, BLUEPRINT_STEWARD_TOKEN: ORG_TOKEN } );
    expect( r.code ).toBe( 0 );
    expect( host.requests[ 0 ].headers.authorization ).toBe( `Bearer ${ ORG_TOKEN }` );
    const rec = JSON.parse( readFileSync( claude.record, 'utf-8' ) );
    expect( rec.mcp.mcpServers.blueprint.env.BLUEPRINT_ACCESS_TOKEN ).toBe( 'bpjk_minted-for-j9' );
    expect( rec.mcpRaw ).not.toContain( ORG_TOKEN );
    expect( Object.entries( rec.env ).filter( ( [ , value ] ) => String( value ).includes( ORG_TOKEN ) ) ).toEqual( [] );
    expect( rec.env.BLUEPRINT_STEWARD_TOKEN ).toBeUndefined();
    expect( JSON.stringify( rec.argv ) ).not.toContain( ORG_TOKEN );
  } );

  // The scrub removes the org key's own variables and nothing else. A short --token is a substring of
  // many values (HOME here, synthesized to contain it), and those reach the agent untouched.
  it( 'start --once: with a short --token only a variable whose value IS the token is scrubbed; one merely containing it reaches the agent', async () => {
    const host = await jobHost();
    const claude = makeFakeClaude( 0 );
    const home = join( tmpdir(), 'home-of-tok-user' );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], {
      BLUEPRINT_STEWARD_CLAUDE: claude.script, HOME: home, DECOY_CONTAINS_TOKEN: 'x-tok-x', EXACT_ORG_TOKEN: 'tok'
    } );
    expect( r.code ).toBe( 0 );
    const rec = JSON.parse( readFileSync( claude.record, 'utf-8' ) );
    expect( [ rec.env.HOME, rec.env.DECOY_CONTAINS_TOKEN, rec.env.PATH ] ).toEqual( [ home, 'x-tok-x', process.env.PATH ] );
    expect( rec.env.EXACT_ORG_TOKEN ).toBeUndefined();
  } );

  it( 'start --once: a design job whose claim carries no job key is reported failed without running the agent', async () => {
    const host = await fakeHost( ( req ) =>
      req.url === '/api/blueprint/steward/claim' ? { body: { job: { id: 'jn', kind: 'design', sessionId: 'sess-n', branch: 'feature', prompt: null, instructions: SERVED, method: METHOD, ...TOOLS } } } : {} );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const report = host.requests.at( -1 )!;
    expect( [ report.url, report.body.status ] ).toEqual( [ '/api/blueprint/steward/jobs/jn', 'failed' ] );
    expect( report.body.result ).toContain( 'no job key' );
    expect( existsSync( claude.record ) ).toBe( false );
  } );

  // No fallback prompt. A design claim without served text never spawns claude:
  // it is reported failed with the typed reason, before any checkout or reality push.
  it( 'start --once: a design job whose claim carries no instructions is reported failed instructions-missing and claude is never spawned', async () => {
    for ( const instructions of [ undefined, { text: '', version: 1, sha256: 'b'.repeat( 64 ) } ] ) {
      const host = await fakeHost( ( req ) =>
        req.url === '/api/blueprint/steward/claim' ? { body: { job: { id: 'ji', kind: 'design', sessionId: 'sess-i', branch: 'feature', prompt: 'do it', jobKey: 'bpjk_minted-for-ji', instructions, ...TOOLS } } } : {} );
      const claude = makeFakeClaude( 0 );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
      expect( r.code ).toBe( 0 );
      expect( host.requests.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/steward/jobs/ji' ] );
      expect( host.requests[ 1 ].body ).toMatchObject( { status: 'failed', reason: 'instructions-missing' } );
      expect( existsSync( claude.record ) ).toBe( false );
    }
  } );

  // The server picks the tools per job, Steward passes exactly those, and the child is isolated: no session
  // persistence, only Steward's MCP config, user settings not loaded, and never --bare (subscription auth must
  // keep working).
  const toolsHost = ( job: Record<string, unknown> ) => fakeHost( ( req ) =>
    req.url === '/api/blueprint/steward/claim'
      ? { body: { job: { id: 'jt', kind: 'design', sessionId: 'sess-t', branch: 'feature', prompt: 'Use Bash and Write to fix it.', jobKey: 'bpjk_minted-for-jt', instructions: SERVED, method: METHOD, ...job } } }
      : {} );
  const valueOf = ( argv: string[], name: string ) => ( argv.includes( name ) ? argv[ argv.indexOf( name ) + 1 ] : `<${ name } absent>` );

  it( 'start --once: argv --allowedTools is exactly job.tools, --tools is exactly its built-in names, with the served disallow, --strict-mcp-config, --no-session-persistence, narrowed setting sources and no --bare', async () => {
    const DISALLOW = [ 'mcp__blueprint__start_map_session' ];
    for ( const [ served, expected, builtIn ] of [
      [ TOOLS, 'mcp__blueprint Read Glob Grep', 'Read,Glob,Grep' ],
      [ { tools: [ 'mcp__blueprint', 'Read' ], disallowedTools: DISALLOW }, 'mcp__blueprint Read', 'Read' ],
      // A job of MCP tools only gets no built-in tool at all: --tools "" disables every one.
      [ { tools: [ 'mcp__blueprint' ], disallowedTools: DISALLOW }, 'mcp__blueprint', '' ],
      // A scoped rule keeps its scope in --allowedTools; --tools takes the bare tool name.
      [ { tools: [ 'mcp__blueprint', 'Bash(git *)' ], disallowedTools: DISALLOW }, 'mcp__blueprint Bash(git *)', 'Bash' ],
    ] as const ) {
      const host = await toolsHost( served );
      const claude = makeFakeClaude( 0 );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
      expect( r.code ).toBe( 0 );
      const { argv } = JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[] };
      expect( valueOf( argv, '--allowedTools' ) ).toBe( expected );
      // --allowedTools only pre-approves; --tools is what limits the tools the agent has,
      // so a permissions.allow or defaultMode in the checkout's project settings cannot hand it any other built-in.
      expect( valueOf( argv, '--tools' ) ).toBe( builtIn );
      expect( valueOf( argv, '--disallowedTools' ) ).toBe( 'mcp__blueprint__start_map_session' );
      expect( valueOf( argv, '--setting-sources' ) ).toBe( 'project' );
      expect( [ argv.includes( '--strict-mcp-config' ), argv.includes( '--no-session-persistence' ), argv.includes( '--bare' ) ] ).toEqual( [ true, true, false ] );
      // No tool comes from the text: the owner's words name Bash and Write, and neither reaches a tool flag
      // unless the host served it.
      const servedBash = served.tools.some( ( tool ) => tool.startsWith( 'Bash' ) );
      expect( argv.filter( ( a ) => /\b(Bash|Write)\b/.test( a ) && !a.includes( 'The owner asks' ) ) ).toEqual( servedBash ? [ expected, builtIn ] : [] );
      expect( host.requests.at( -1 )!.body.status ).toBe( 'done' );
    }
  } );

  // Blueprint ADR-137 decision 2: a reply or design job whose claim carries an
  // agent context runs in that Claude session, started with --session-id and resumed with --resume, kept on disk instead
  // of dropped by --no-session-persistence. Under --agent-sessions-dir when it is given (claude's CLAUDE_CONFIG_DIR),
  // else under the config dir claude inherits ($CLAUDE_CONFIG_DIR, else ~/.claude), whose login it keeps. A
  // resume whose session file is gone runs the claim's rebuildSessionId on its rebuildPrompt. The report says how the
  // context started and its size.
  const CONTEXT_ID = '11111111-1111-4111-8111-111111111111';
  const REBUILD_ID = '22222222-2222-4222-8222-222222222222';
  const REBUILD_PROMPT = 'Rebuild: the thread so far is c-root "why?" and c-2 "and now?"; answer c-2.';
  const THREAD = { threadRootId: 'c-root', channelKey: 'node:card-1', commentIds: [ 'c-root', 'c-2' ] };
  // Provenance: captured from claude 2.1.301 resuming a session (the manual resume probe, run in an earlier build
  // session of this work item); a later capture from claude 2.1.302 showed the same usage shape. Two turns after the init
  // line, which the fake writes itself. Its first assistant event's usage is input 2 + cache creation 287 + cache read
  // 6941 = 7230, the context the run started at; the result event's usage sums both turns (4 + 440 + 14169), which is no
  // context size.
  const STREAM_2_1_301_RESUMED = readFileSync( join( __dirname, 'fixtures', 'claude-2.1.301-stream-resumed-two-turns.jsonl' ), 'utf-8' );
  const STARTED_TOKENS = 7230;
  const replyHost = ( job: Record<string, unknown> ) => fakeHost( ( req ) =>
    req.url === '/api/blueprint/steward/claim'
      ? { body: { job: { id: 'jr', kind: 'reply', sessionId: 'sess-r', branch: 'feature', prompt: 'reply on the board by m1: and now?', jobKey: 'bpjk_minted-for-jr', instructions: SERVED, method: METHOD, ...TOOLS, payload: THREAD, ...job } } }
      : {} );
  const reportOf = ( host: { requests: Req[] } ) => host.requests.find( ( q ) => q.url === '/api/blueprint/steward/jobs/jr' )!.body;
  // A claude that was never spawned recorded nothing: read as no argv and no env, so the assertions below print what is missing.
  const recordOf = ( record: string ) => ( existsSync( record ) ? JSON.parse( readFileSync( record, 'utf-8' ) ) : { argv: [], env: {} } ) as { argv: string[]; env: Record<string, string> };
  const sessionArgs = ( argv: string[] ) => [ valueOf( argv, '--session-id' ), valueOf( argv, '--resume' ), argv.includes( '--no-session-persistence' ) ];
  // The three places the sessions can be, each owned by the fixture (never the real ~/.claude): a named
  // --agent-sessions-dir, an ambient CLAUDE_CONFIG_DIR, and HOME's .claude with CLAUDE_CONFIG_DIR unset. `configDir` is
  // where the session must be looked up, `childConfigDir` the CLAUDE_CONFIG_DIR claude must see (unset for the last).
  const placements = () => {
    const named = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-sessions-' ) ), 'agent-sessions' );
    const ambient = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-config-' ) ), 'claude-config' );
    const home = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-home-' ) );
    const all = [ named, ambient, join( home, '.claude' ) ];
    return [
      { where: 'named --agent-sessions-dir', args: [ '--agent-sessions-dir', named ], env: { CLAUDE_CONFIG_DIR: ambient, HOME: home }, configDir: named, childConfigDir: named as string | undefined, named, all },
      { where: 'ambient CLAUDE_CONFIG_DIR', args: [], env: { CLAUDE_CONFIG_DIR: ambient, HOME: home }, configDir: ambient, childConfigDir: ambient as string | undefined, named, all },
      { where: 'ambient ~/.claude', args: [], env: { CLAUDE_CONFIG_DIR: undefined, HOME: home }, configDir: join( home, '.claude' ), childConfigDir: undefined as string | undefined, named, all },
    ];
  };
  const ownedConfig = () => placements()[ 1 ].env;

  it( 'Fresh start args: a reply or design job claimed with agentContext { sessionId: S, mode: fresh } spawns claude with --session-id S and no --no-session-persistence, CLAUDE_CONFIG_DIR the --agent-sessions-dir when given and the ambient one when not, and reports context fresh; a job with no agent context keeps today\'s argv', async () => {
    // Slice 3's over-cap claim says `rebuilt` under a newly minted id, which starts the same way and is reported as such.
    const starts = [ [ 'reply', 'fresh', CONTEXT_ID ], [ 'design', 'fresh', CONTEXT_ID ], [ 'reply', 'rebuilt', REBUILD_ID ] ];
    for ( const [ i, [ kind, mode, id ] ] of starts.entries() ) {
      const placement = placements()[ i ];
      const host = await replyHost( { kind, agentContext: { sessionId: id, mode } } );
      const claude = makeFakeClaude( 0, STREAM_2_1_301_RESUMED );
      const repo = makeRepo();
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', ...placement.args ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...placement.env } );
      expect( r.code ).toBe( 0 );
      const { argv, env } = recordOf( claude.record );
      expect( [ placement.where, kind, ...sessionArgs( argv ) ] ).toEqual( [ placement.where, kind, id, '<--resume absent>', false ] );
      // A named dir is the child's CLAUDE_CONFIG_DIR and is created; without one the child's is the ambient one
      // (unset stays unset) and Steward creates no sessions dir of its own.
      expect( [ placement.where, env.CLAUDE_CONFIG_DIR, existsSync( placement.named ), existsSync( `${ repo }.blueprint-agent-sessions` ) ] )
        .toEqual( [ placement.where, placement.childConfigDir, placement.childConfigDir === placement.named, false ] );
      expect( reportOf( host ) ).toMatchObject( { status: 'done', context: { mode, sessionId: id, tokens: STARTED_TOKENS } } );
    }
    // An agent that ran and failed still reports the context it ran in; with no assistant event its size is unknown (null).
    const failed = await replyHost( { agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
    await run( [ 'start', '--server', failed.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 1 ).script, ...ownedConfig() } );
    expect( reportOf( failed ) ).toMatchObject( { status: 'failed', reason: 'agent-error', context: { mode: 'fresh', sessionId: CONTEXT_ID, tokens: null } } );
    // A claude that never started ran no context, so its report names none.
    const missing = await replyHost( { agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
    await run( [ 'start', '--server', missing.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: join( tmpdir(), 'no-such-claude-binary' ), ...ownedConfig() } );
    expect( reportOf( missing ) ).toMatchObject( { status: 'failed', reason: 'claude-missing' } );
    expect( reportOf( missing ) ).not.toHaveProperty( 'context' );
    // Negative half: a design job whose claim carries no agent context (every claim before ADR-137) keeps
    // --no-session-persistence, gets no session id and inherits CLAUDE_CONFIG_DIR as it was, even beside a named
    // --agent-sessions-dir, which it does not create; its report has no context.
    const named = placements()[ 0 ];
    const host = await replyHost( { kind: 'design', payload: undefined } );
    const claude = makeFakeClaude( 0, STREAM_2_1_301_RESUMED );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...named.args ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...named.env } );
    const { argv, env } = recordOf( claude.record );
    expect( sessionArgs( argv ) ).toEqual( [ '<--session-id absent>', '<--resume absent>', true ] );
    expect( [ env.CLAUDE_CONFIG_DIR, existsSync( named.named ) ] ).toEqual( [ named.env.CLAUDE_CONFIG_DIR, false ] );
    expect( reportOf( host ).status ).toBe( 'done' );
    expect( reportOf( host ) ).not.toHaveProperty( 'context' );
  }, 30_000 );

  it( 'an --agent-sessions-dir flag with no directory after it, an empty one, or the next flag exits 1 rather than running', async () => {
    for ( const rest of [ [ '--agent-sessions-dir' ], [ '--agent-sessions-dir', '' ], [ '--agent-sessions-dir', '--once' ] ] ) {
      const host = await replyHost( {} );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...rest ] );
      expect( [ rest, r.code, host.requests.length ] ).toEqual( [ rest, 1, 0 ] );
      expect( r.stderr ).toContain( '--agent-sessions-dir needs a directory' );
    }
  } );

  // The image names the sessions dir in its environment (on its /work volume), so its entrypoint passes no flag; a flag
  // given beside it wins, and an empty variable is none.
  it( 'BLUEPRINT_STEWARD_AGENT_SESSIONS_DIR names the sessions dir as --agent-sessions-dir does, the flag wins over it, and an empty one is none', async () => {
    const placement = placements()[ 0 ];
    const fromEnv = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-sessions-env-' ) ), 'agent-sessions' );
    for ( const [ where, args, value, expected ] of [
      [ 'env', [], fromEnv, fromEnv ],
      [ 'flag over env', placement.args, fromEnv, placement.named ],
      [ 'empty env', [], '', placement.env.CLAUDE_CONFIG_DIR ],
    ] as const ) {
      const host = await replyHost( { agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
      const claude = makeFakeClaude( 0, STREAM_2_1_301_RESUMED );
      await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...args ],
        { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...placement.env, BLUEPRINT_STEWARD_AGENT_SESSIONS_DIR: value } );
      expect( [ where, recordOf( claude.record ).env.CLAUDE_CONFIG_DIR, reportOf( host ).status ] ).toEqual( [ where, expected, 'done' ] );
    }
  }, 30_000 );

  it( 'Reply skips extraction: a reply job runs no extract command and pushes no graph, and the agent still runs; a design job on the same repository extracts', async () => {
    const marker = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-extract-' ) ), 'extracted' );
    const extract = `touch ${ marker } && mkdir -p .blueprint && echo '{"nodes":[1]}' > .blueprint/graph.json`;
    const host = await replyHost( { agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo( extract ), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...ownedConfig() } );
    expect( r.code ).toBe( 0 );
    expect( [ existsSync( marker ), host.requests.some( ( q ) => q.url === '/api/blueprint/reality' ), existsSync( claude.record ) ] ).toEqual( [ false, false, true ] );
    expect( reportOf( host ).status ).toBe( 'done' );
    // Positive control: the marker is written by the extract command, which a design job runs.
    const design = await replyHost( { kind: 'design', agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
    await run( [ 'start', '--server', design.url, '--token', 'tok', '--repo', makeRepo( extract ), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, ...ownedConfig() } );
    expect( [ existsSync( marker ), design.requests.some( ( q ) => q.url === '/api/blueprint/reality' ) ] ).toEqual( [ true, true ] );
  } );

  // A resume claim as the server sends it: the context's session id, and the id and prompt to rebuild under.
  const RESUME = { agentContext: { sessionId: CONTEXT_ID, mode: 'resume', rebuildSessionId: REBUILD_ID, rebuildPrompt: REBUILD_PROMPT } };
  // Where claude 2.1.301 keeps a session under its config dir (seen in the manual probe): projects/<the cwd it started
  // in, with / and . as ->/<session id>.jsonl, and a --resume from another directory appends to that same file.
  const writeSession = ( configDir: string, id: string ) => {
    mkdirSync( join( configDir, 'projects', '-private-tmp-a-worktree' ), { recursive: true } );
    writeFileSync( join( configDir, 'projects', '-private-tmp-a-worktree', `${ id }.jsonl` ), '{}\n' );
  };

  it( 'Follow-up: given a thread\'s session exists on Steward, when a member asks a follow-up, then Steward resumes that session and reports resumed (under a named --agent-sessions-dir, the ambient CLAUDE_CONFIG_DIR, or ~/.claude)', async () => {
    // Each placement gets dirs of its own, so no earlier run's session file is on disk.
    for ( const placement of [ 0, 1, 2 ].map( ( i ) => placements()[ i ] ) ) {
      // The session is only where this Steward must look.
      writeSession( placement.configDir, CONTEXT_ID );
      const host = await replyHost( RESUME );
      const claude = makeFakeClaude( 0, STREAM_2_1_301_RESUMED );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...placement.args ],
        { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...placement.env } );
      expect( r.code ).toBe( 0 );
      const { argv, env } = recordOf( claude.record );
      expect( [ placement.where, ...sessionArgs( argv ), env.CLAUDE_CONFIG_DIR ] ).toEqual( [ placement.where, '<--session-id absent>', CONTEXT_ID, false, placement.childConfigDir ] );
      expect( valueOf( argv, '-p' ) ).not.toContain( REBUILD_PROMPT );
      expect( reportOf( host ) ).toMatchObject( { status: 'done', context: { mode: 'resumed', sessionId: CONTEXT_ID, tokens: STARTED_TOKENS } } );
    }
  }, 30_000 );

  it( 'Lost session: given the thread\'s session file is gone, when a member asks in the thread, then Steward rebuilds from the thread under a newly minted id and reports rebuilt (whichever config dir it reads)', async () => {
    // Each placement gets dirs of its own, so no earlier run's session file is on disk.
    for ( const placement of [ 0, 1, 2 ].map( ( i ) => placements()[ i ] ) ) {
      const repo = makeRepo();
      // Another context's session is where this Steward looks; this thread's is only where it must not look (the other
      // two places, and a <repo>.blueprint-agent-sessions, which Blueprint ruled out).
      writeSession( placement.configDir, '33333333-3333-4333-8333-333333333333' );
      for ( const dir of [ ...placement.all.filter( ( d ) => d !== placement.configDir ), `${ repo }.blueprint-agent-sessions` ] ) writeSession( dir, CONTEXT_ID );
      const host = await replyHost( RESUME );
      const claude = makeFakeClaude( 0, STREAM_2_1_301_RESUMED );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', ...placement.args ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...placement.env } );
      expect( r.code ).toBe( 0 );
      const { argv, env } = recordOf( claude.record );
      expect( [ placement.where, ...sessionArgs( argv ), env.CLAUDE_CONFIG_DIR ] ).toEqual( [ placement.where, REBUILD_ID, '<--resume absent>', false, placement.childConfigDir ] );
      // The served instructions, then the rebuild prompt in place of the job's own (the clipped words it folded).
      expect( valueOf( argv, '-p' ) ).toBe( `${ SERVED.text }\n\n${ REBUILD_PROMPT }` );
      expect( reportOf( host ) ).toMatchObject( { status: 'done', context: { mode: 'rebuilt', sessionId: REBUILD_ID, tokens: STARTED_TOKENS } } );
    }
  }, 30_000 );

  it( 'a resume whose session file is gone and whose claim names nothing to rebuild under (no id, an id that is no UUID, or a blank prompt), an agent context whose session id is no UUID, or one of an unknown mode, is reported failed agent-context-invalid and claude is never spawned', async () => {
    for ( const agentContext of [
      { sessionId: CONTEXT_ID, mode: 'resume' },
      { sessionId: CONTEXT_ID, mode: 'resume', rebuildSessionId: '../other', rebuildPrompt: REBUILD_PROMPT },
      { sessionId: CONTEXT_ID, mode: 'resume', rebuildSessionId: REBUILD_ID, rebuildPrompt: '  ' },
      { sessionId: '../../etc/passwd', mode: 'fresh' },
      { sessionId: CONTEXT_ID, mode: 'resumed' },
    ] ) {
      const host = await replyHost( { agentContext } );
      const claude = makeFakeClaude( 0 );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...ownedConfig() } );
      expect( r.code ).toBe( 0 );
      expect( [ agentContext, reportOf( host ).status, reportOf( host ).reason, existsSync( claude.record ) ] ).toEqual( [ agentContext, 'failed', 'agent-context-invalid', false ] );
      expect( reportOf( host ).result ).toContain( 'agent context' );
    }
  } );

  // Blueprint ADR-137: Steward prunes the session files of the agent contexts the server issued it (the
  // ids its claims named), idle for more than 14 days, at start and daily, in the config dir it looks sessions up in.
  // A session file no claim named is never pruned, whatever its age.
  const DAY_S = 24 * 60 * 60;
  const RECENT_ID = '44444444-4444-4444-8444-444444444444';
  const FOREIGN_ID = '55555555-5555-4555-8555-555555555555';
  const sessionFile = ( configDir: string, id: string ) => join( configDir, 'projects', '-private-tmp-a-worktree', `${ id }.jsonl` );
  const idleFor = ( file: string, days: number ) => {
    const then = Date.now() / 1000 - days * DAY_S;
    utimesSync( file, then, then );
  };

  it( 'Prune: given a session file was last used 15 days ago, when Steward\'s prune runs, then the file is removed and the next run in that thread rebuilds; one used 13 days ago, and an old one no claim named, remain (under a named --agent-sessions-dir, the ambient CLAUDE_CONFIG_DIR, or ~/.claude)', async () => {
    for ( const placement of [ 0, 1, 2 ].map( ( i ) => placements()[ i ] ) ) {
      // GIVEN: two threads' contexts were issued to this Steward (each claim started one), and claude kept their sessions.
      const repo = makeRepo();
      for ( const id of [ CONTEXT_ID, RECENT_ID ] ) {
        const issued = await replyHost( { agentContext: { sessionId: id, mode: 'fresh' } } );
        await run( [ 'start', '--server', issued.url, '--token', 'tok', '--repo', repo, '--once', ...placement.args ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, ...placement.env } );
        expect( [ placement.where, reportOf( issued ).status ] ).toEqual( [ placement.where, 'done' ] );
      }
      for ( const id of [ CONTEXT_ID, RECENT_ID, FOREIGN_ID ] ) writeSession( placement.configDir, id );
      idleFor( sessionFile( placement.configDir, CONTEXT_ID ), 15 );
      idleFor( sessionFile( placement.configDir, RECENT_ID ), 13 );
      // A session of the team's own, as old, that no claim named.
      idleFor( sessionFile( placement.configDir, FOREIGN_ID ), 15 );

      // WHEN: Steward starts (its prune runs before its first claim), and the thread asks again.
      const host = await replyHost( RESUME );
      const claude = makeFakeClaude( 0, STREAM_2_1_301_RESUMED );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', ...placement.args ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...placement.env } );

      // THEN
      expect( r.code ).toBe( 0 );
      expect( [ placement.where, ...[ CONTEXT_ID, RECENT_ID, FOREIGN_ID ].map( ( id ) => existsSync( sessionFile( placement.configDir, id ) ) ) ] )
        .toEqual( [ placement.where, false, true, true ] );
      expect( [ placement.where, ...sessionArgs( recordOf( claude.record ).argv ) ] ).toEqual( [ placement.where, REBUILD_ID, '<--resume absent>', false ] );
      expect( reportOf( host ) ).toMatchObject( { status: 'done', context: { mode: 'rebuilt', sessionId: REBUILD_ID } } );
      // The 13-day-old session is still there to resume.
      const recent = await replyHost( { agentContext: { ...RESUME.agentContext, sessionId: RECENT_ID } } );
      await run( [ 'start', '--server', recent.url, '--token', 'tok', '--repo', repo, '--once', ...placement.args ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, ...placement.env } );
      expect( [ placement.where, reportOf( recent ).context ] ).toEqual( [ placement.where, { mode: 'resumed', sessionId: RECENT_ID, tokens: null } ] );
    }
  }, 60_000 );

  // The long-lived Steward's only bound on the sessions dir is the prune after start, every --session-prune seconds
  // (BLUEPRINT_SESSION_PRUNE_SECONDS; a day by default); it runs in the same process, with no restart.
  it( 'Daily prune: a running Steward removes an issued session file that goes idle past 14 days after its start prune, on its next --session-prune tick (or BLUEPRINT_SESSION_PRUNE_SECONDS), without a restart', async () => {
    for ( const cadence of [ { args: [ '--session-prune', '0.2' ], env: { BLUEPRINT_SESSION_PRUNE_SECONDS: undefined } }, { args: [], env: { BLUEPRINT_SESSION_PRUNE_SECONDS: '0.2' } } ] ) {
      const via = cadence.args.length > 0 ? 'flag' : 'env';
      // GIVEN: a context issued to this Steward, whose session file is fresh when Steward starts.
      const repo = makeRepo();
      const issued = await replyHost( { agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
      await run( [ 'start', '--server', issued.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, ...ownedConfig() } );
      const env = { ...ownedConfig(), ...cadence.env };
      writeSession( env.CLAUDE_CONFIG_DIR!, CONTEXT_ID );
      const file = sessionFile( env.CLAUDE_CONFIG_DIR!, CONTEXT_ID );
      // WHEN: Steward has claimed once (its start prune ran before that claim), the file goes idle past 14 days.
      const host = await fakeHost( ( req ) => ( req.url.startsWith( '/api/blueprint/branches?' ) ? { body: { branches: [] } } : { body: { job: null } } ) );
      const claimed = () => host.requests.some( ( q ) => q.url === '/api/blueprint/steward/claim' );
      let afterStart: boolean | undefined;
      let deadline = Infinity;
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--interval', '600', '--merge-poll', '600', ...cadence.args ], env, {
        killWhen: () => {
          if ( afterStart === undefined && claimed() ) {
            afterStart = existsSync( file );
            idleFor( file, 15 );
            // Ample for a 0.2 s tick on a loaded machine; past it the assertion below prints the file still there.
            deadline = Date.now() + 30_000;
          }
          return afterStart !== undefined && ( !existsSync( file ) || Date.now() > deadline );
        },
      } );
      // THEN: the start prune left the fresh file, and a later tick of the same process removed it once idle.
      expect( [ via, afterStart, existsSync( file ), r.code ] ).toEqual( [ via, true, false, null ] );
    }
  }, 90_000 );

  it( 'a --session-prune or BLUEPRINT_SESSION_PRUNE_SECONDS that is no positive number, or past the longest timer, exits 1 before any request', async () => {
    for ( const [ args, value ] of [ [ [ '--session-prune', '0' ], undefined ], [ [ '--session-prune', 'daily' ], undefined ], [ [ '--session-prune', '2147484' ], undefined ], [ [], '-1' ] ] as const ) {
      const host = await replyHost( {} );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...args ], { ...ownedConfig(), BLUEPRINT_SESSION_PRUNE_SECONDS: value } );
      expect( [ args, value, r.code, host.requests.length ] ).toEqual( [ args, value, 1, 0 ] );
      expect( r.stderr ).toContain( 'needs a positive number of at most 2147483' );
    }
  } );

  // A prune that fails (here the sessions dir's projects is a regular file, so it cannot be listed) is logged, and
  // Steward still claims and reports its job.
  it( 'a prune that fails is logged as agent session prune: and Steward still claims and reports its job', async () => {
    const repo = makeRepo();
    const env = ownedConfig();
    const issued = await replyHost( { agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
    await run( [ 'start', '--server', issued.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, ...env } );
    // The ledger is not empty, so the prune reads the projects dir.
    expect( JSON.parse( readFileSync( join( `${ repo }.blueprint-worktrees`, '.agent-contexts.json' ), 'utf-8' ) ) ).toEqual( [ CONTEXT_ID ] );
    mkdirSync( env.CLAUDE_CONFIG_DIR!, { recursive: true } );
    writeFileSync( join( env.CLAUDE_CONFIG_DIR!, 'projects' ), 'not a directory\n' );
    const host = await replyHost( { agentContext: { sessionId: RECENT_ID, mode: 'fresh' } } );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...env } );
    expect( [ r.code, r.stderr.match( /blueprint-steward: agent session prune: \S+/ )?.[ 0 ], host.requests.find( ( q ) => q.url === '/api/blueprint/steward/jobs/jr' )?.body.status, existsSync( claude.record ) ] )
      .toEqual( [ 0, 'blueprint-steward: agent session prune: ENOTDIR:', 'done', true ] );
  } );

  // A reply shares the session's worktree read-only, so the team's --design-tools grant (which may write) is a
  // design job's alone.
  it( 'a reply job runs on its served tools alone: the team\'s --design-tools grant never reaches it, while a design job beside it gets it', async () => {
    const granted = [ '--design-tools', 'Bash Write Edit' ];
    const replied = await replyHost( { agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
    const replyClaude = makeFakeClaude( 0 );
    await run( [ 'start', '--server', replied.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...granted ], { BLUEPRINT_STEWARD_CLAUDE: replyClaude.script, ...ownedConfig() } );
    const { argv } = recordOf( replyClaude.record );
    expect( [ valueOf( argv, '--allowedTools' ), valueOf( argv, '--tools' ), reportOf( replied ).status ] ).toEqual( [ TOOLS.tools.join( ' ' ), 'Read,Glob,Grep', 'done' ] );
    // Positive control: the same grant reaches a design job.
    const designed = await replyHost( { kind: 'design', agentContext: { sessionId: CONTEXT_ID, mode: 'fresh' } } );
    const designClaude = makeFakeClaude( 0 );
    await run( [ 'start', '--server', designed.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...granted ], { BLUEPRINT_STEWARD_CLAUDE: designClaude.script, ...ownedConfig() } );
    expect( valueOf( recordOf( designClaude.record ).argv, '--tools' ) ).toBe( 'Read,Glob,Grep,Bash,Write,Edit' );
  }, 30_000 );

  it( 'start --once: with no --tool-ceiling Steward is permissive and a job asking for Bash spawns claude with it', async () => {
    const host = await toolsHost( { tools: [ 'mcp__blueprint', 'Read', 'Bash' ] } );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const { argv } = JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[] };
    expect( valueOf( argv, '--allowedTools' ) ).toBe( 'mcp__blueprint Read Bash' );
    expect( valueOf( argv, '--tools' ) ).toBe( 'Read,Bash' );
    expect( host.requests.at( -1 )!.body.status ).toBe( 'done' );
  } );

  it( 'start --once: a job asking for Bash beyond a --tool-ceiling without it fails tools-beyond-ceiling naming the ceiling, and claude is never spawned', async () => {
    const CEILING = 'mcp__blueprint Read Glob Grep';
    const host = await toolsHost( { tools: [ 'mcp__blueprint', 'Read', 'Bash' ] } );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--tool-ceiling', CEILING ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    expect( host.requests.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/steward/jobs/jt' ] );
    const report = host.requests[ 1 ].body;
    expect( report ).toMatchObject( { status: 'failed', reason: 'tools-beyond-ceiling' } );
    expect( report.result ).toContain( CEILING );
    expect( report.result ).toContain( 'Bash' );
    expect( existsSync( claude.record ) ).toBe( false );

    // Positive control: the same ceiling, written comma-separated, admits a job whose tools all lie within it.
    const within = await toolsHost( TOOLS );
    const allowed = makeFakeClaude( 0 );
    await run( [ 'start', '--server', within.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--tool-ceiling', CEILING.replaceAll( ' ', ',' ) ], { BLUEPRINT_STEWARD_CLAUDE: allowed.script } );
    expect( within.requests.at( -1 )!.body.status ).toBe( 'done' );
    expect( existsSync( allowed.record ) ).toBe( true );
  } );

  // A ceiling entry naming an MCP server (mcp__<server>, no further __) admits that server's tools
  // (mcp__<server>__*), as reply jobs ask for them by name; every other entry still matches exactly.
  it( 'start --once: a --tool-ceiling naming the MCP server mcp__blueprint admits a job asking for mcp__blueprint__* tools, and nothing else widens', async () => {
    const CEILING = 'mcp__blueprint Read Glob Grep';
    const within = await toolsHost( { tools: [ 'mcp__blueprint__get_design', 'mcp__blueprint__comment', 'Read' ] } );
    const allowed = makeFakeClaude( 0 );
    await run( [ 'start', '--server', within.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--tool-ceiling', CEILING ], { BLUEPRINT_STEWARD_CLAUDE: allowed.script } );
    expect( [ within.requests.at( -1 )!.body.status, within.requests.at( -1 )!.body.reason, existsSync( allowed.record ) ] ).toEqual( [ 'done', undefined, true ] );
    // Still refused: a tool outside the ceiling; another server whose name only begins with the entry's; a full tool
    // entry is no prefix; a built-in entry admits no scoped rule of it.
    for ( const [ ceiling, beyond ] of [
      [ CEILING, 'Bash' ], [ CEILING, 'mcp__blueprint_repo__log' ], [ CEILING, 'mcp__blueprintx' ],
      [ 'mcp__blueprint__get mcp__blueprint__get_design', 'mcp__blueprint__get__x' ], [ CEILING, 'Read(./src/**)' ],
    ] ) {
      const host = await toolsHost( { tools: [ 'mcp__blueprint__get_design', beyond ] } );
      const claude = makeFakeClaude( 0 );
      await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--tool-ceiling', ceiling ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
      const report = host.requests.at( -1 )!.body;
      expect( [ beyond, report.status, report.reason, report.result.includes( `asks for ${ beyond },` ), existsSync( claude.record ) ] )
        .toEqual( [ beyond, 'failed', 'tools-beyond-ceiling', true, false ] );
    }
  }, 30_000 );

  it( 'a --tool-ceiling flag with no list after it exits 1 rather than running without a ceiling', async () => {
    const host = await toolsHost( { tools: [ 'Bash' ] } );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--once', '--tool-ceiling' ] );
    expect( [ r.code, host.requests.length ] ).toEqual( [ 1, 0 ] );
    expect( r.stderr ).toContain( '--tool-ceiling needs a tool list' );
  } );

  it( 'a --tool-ceiling whose value is empty or is the next flag exits 1 rather than reading it as a ceiling', async () => {
    for ( const rest of [ [ '--tool-ceiling', '' ], [ '--tool-ceiling', '  , ' ], [ '--tool-ceiling', '--once' ] ] ) {
      const host = await toolsHost( { tools: [ 'Bash' ] } );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', ...rest, ...( rest[ 1 ] === '--once' ? [] : [ '--once' ] ) ] );
      expect( [ rest, r.code, host.requests.length ] ).toEqual( [ rest, 1, 0 ] );
      expect( r.stderr ).toContain( '--tool-ceiling needs a tool list' );
    }
  } );

  // A scoped rule names a command with spaces in it, and the ceiling keeps it one entry.
  it( 'a --tool-ceiling "Bash(git log *) Read" parses to [ Bash(git log *), Read ]: a job asking for that rule runs, one asking for a fragment of it is refused', async () => {
    const CEILING = 'Bash(git log *) Read';
    // A split on /[\s,]+/ would shred the rule into three entries, each a tool of its own.
    expect( CEILING.split( /[\s,]+/ ) ).toEqual( [ 'Bash(git', 'log', '*)', 'Read' ] );
    expect( [ toolList( CEILING ), toolList( 'Bash(git log *),Read' ), toolList( ' Read ,, Bash(git log *, git show *)  Glob' ) ] ).toEqual( [
      [ 'Bash(git log *)', 'Read' ], [ 'Bash(git log *)', 'Read' ], [ 'Read', 'Bash(git log *, git show *)', 'Glob' ],
    ] );

    const whole = await toolsHost( { tools: [ 'Bash(git log *)', 'Read' ] } );
    const claude = makeFakeClaude( 0 );
    expect( ( await run( [ 'start', '--server', whole.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--tool-ceiling', CEILING ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } ) ).code ).toBe( 0 );
    expect( whole.requests.at( -1 )!.body ).toMatchObject( { status: 'done' } );
    expect( valueOf( ( JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[] } ).argv, '--allowedTools' ) ).toBe( 'Bash(git log *) Read' );

    for ( const fragment of [ 'log', '*)', 'Bash(git' ] ) {
      const host = await toolsHost( { tools: [ fragment, 'Read' ] } );
      const refused = makeFakeClaude( 0 );
      expect( ( await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--tool-ceiling', CEILING ], { BLUEPRINT_STEWARD_CLAUDE: refused.script } ) ).code ).toBe( 0 );
      expect( [ fragment, host.requests.at( -1 )!.body.reason, existsSync( refused.record ) ] ).toEqual( [ fragment, 'tools-beyond-ceiling', false ] );
    }
  }, 30_000 );

  it( 'start --once: a design job with no tools fails tools-missing, before any reality push, and claude is never spawned', async () => {
    for ( const served of [ { tools: [] }, { tools: undefined }, { tools: [ '' ] } ] ) {
      const host = await toolsHost( served );
      const claude = makeFakeClaude( 0 );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
      expect( r.code ).toBe( 0 );
      expect( host.requests.map( ( q ) => q.url ) ).toEqual( [ '/api/blueprint/steward/claim', '/api/blueprint/steward/jobs/jt' ] );
      expect( host.requests[ 1 ].body ).toMatchObject( { status: 'failed', reason: 'tools-missing' } );
      expect( existsSync( claude.record ) ).toBe( false );
    }
  } );

  it( 'Steward\'s source keeps no prompt of its own and offers no way to supply one', () => {
    const source = readFileSync( BIN, 'utf-8' );
    expect( source ).not.toMatch( /DEFAULT_PROMPT/ );
    expect( source ).not.toMatch( /--instructions/ );
  } );

  // Every environment read Steward makes: `process.env.NAME` by name, `stewardEnv( 'NAME' )` as BLUEPRINT_STEWARD_NAME
  // (lib/env.mjs), or any other touch of `process.env` (a computed index, a destructuring) as `<other>`, except the
  // one pass-through that becomes the agent's env.
  const envReads = ( source: string ): string[] => {
    const code = source.split( '\n' ).filter( ( line ) => !/^\s*\/\//.test( line ) ).join( '\n' )
      .replace( 'Object.entries( process.env )', '' );
    return [ ...code.matchAll( /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*))?|stewardEnv\( '([A-Z]+)'/g ) ]
      .map( ( match ) => ( match[ 2 ] !== undefined ? `BLUEPRINT_STEWARD_${ match[ 2 ] }` : match[ 1 ] ?? '<other>' ) );
  };

  it( 'Steward reads no prompt or instructions from its environment', () => {
    // Negative controls: a named, an indexed and a destructured prompt variable are each caught.
    expect( envReads( 'const p = process.env.BLUEPRINT_PROMPT;' ) ).toEqual( [ 'BLUEPRINT_PROMPT' ] );
    expect( envReads( 'const p = process.env[ name ];\nconst { X } = process.env;' ) ).toEqual( [ '<other>', '<other>' ] );
    expect( envReads( '// const p = process.env.BLUEPRINT_PROMPT;' ) ).toEqual( [] );

    const reads = envReads( readFileSync( BIN, 'utf-8' ) );
    // Positive control: Steward's own reads are found, so an empty prompt set below is the source's.
    expect( reads ).toEqual( expect.arrayContaining( [ 'BLUEPRINT_STEWARD_TOKEN', 'BLUEPRINT_STEWARD_CLAUDE' ] ) );
    expect( reads.filter( ( name ) => name === '<other>' || /PROMPT|INSTRUCTION/i.test( name ) ) ).toEqual( [] );
  } );

  // A fake claude that never exits on its own, so only Steward can end it.
  // It records its pid, which the tests probe after Steward is done to prove the child was killed.
  const makeHangingClaude = () => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const record = join( dir, 'record.json' );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${ JSON.stringify( record ) }, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));
${ printInit }
console.log('still working');
setInterval(() => {}, 1000);
` );
    execSync( `chmod +x ${ script }` );
    const pid = () => ( existsSync( record ) ? ( JSON.parse( readFileSync( record, 'utf-8' ) ) as { pid: number } ).pid : undefined );
    hanging.push( pid );
    return { script, record, pid };
  };
  const hanging: Array<() => number | undefined> = [];
  const alive = ( pid: number | undefined ) => {
    if ( pid === undefined ) return false;
    try { process.kill( pid, 0 ); return true; } catch { return false; }
  };
  // A RED run leaves its fake claude behind; it never outlives the suite.
  afterEach( () => { for ( const pid of hanging.splice( 0 ).map( ( read ) => read() ) ) if ( alive( pid ) ) process.kill( pid!, 'SIGKILL' ); } );
  // Bounds a run Steward never ends (the RED of each scenario below) so it fails by assertion, not by hanging.
  // The stopper kills a still-running fake claude too (it holds Steward's stderr open) and records that it fired,
  // so a run Steward did not end itself is asserted against, never read as Steward's kill.
  const stopAfter = ( ms: number, claude?: { pid: () => number | undefined } ) => {
    const start = Date.now();
    const stop = Object.assign( () => {
      if ( Date.now() - start <= ms ) return false;
      stop.fired = true;
      const pid = claude?.pid();
      if ( alive( pid ) ) process.kill( pid!, 'SIGKILL' );
      return true;
    }, { fired: false } );
    return stop;
  };
  const reports = ( host: { requests: Req[] }, id: string ) => host.requests.filter( ( q ) => q.url === `/api/blueprint/steward/jobs/${ id }` );
  const heartbeats = ( host: { requests: Req[] }, id: string ) => unstepped( host.requests ).filter( ( q ) => q.url === `/api/blueprint/steward/jobs/${ id }/heartbeat` );

  const leaseHost = ( heartbeat: () => { status?: number; body?: unknown } ) => fakeHost( ( req ) => {
    if ( req.url === '/api/blueprint/steward/claim' ) return { body: { job: { id: 'jl', kind: 'design', sessionId: 'sess-l', branch: 'feature', prompt: null, jobKey: 'bpjk_minted-for-jl', instructions: SERVED, method: METHOD, ...TOOLS } } };
    if ( req.url === '/api/blueprint/steward/jobs/jl/heartbeat' && req.body?.step === undefined ) return heartbeat();
    return {};
  } );

  // The host answers a heartbeat for a job whose lease it no longer
  // holds with 404 RUNNER_JOB_NOT_CLAIMED; Steward then kills the child and reports nothing.
  it( 'start --once: a 404 RUNNER_JOB_NOT_CLAIMED heartbeat kills the running claude and posts no report', async () => {
    // Heartbeats are accepted until the child is running; the lease is lost at the next one.
    const claude = makeHangingClaude();
    let refused = 0;
    const host = await leaseHost( () => ( claude.pid() === undefined ? { body: { ok: true } }
      : ( refused += 1, { status: 404, body: { ok: false, error: { code: 'RUNNER_JOB_NOT_CLAIMED', message: 'no claimed job jl with a live lease' } } } ) ) );
    const stop = stopAfter( 8000, claude );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--heartbeat', '0.3' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: stop } );
    const beats = heartbeats( host, 'jl' );
    // One lease, beaten from the claim: the refused beat is its last.
    expect( refused ).toBe( 1 );
    expect( beats.length ).toBeGreaterThanOrEqual( 1 );
    expect( beats[ 0 ].body ).toEqual( { intervalSeconds: 0.3 } );
    expect( beats[ 0 ].headers[ 'x-blueprint-session-id' ] ).toBe( 'sess-l' );
    expect( reports( host, 'jl' ) ).toEqual( [] );
    expect( [ stop.fired, r.code, claude.pid() !== undefined, alive( claude.pid() ) ] ).toEqual( [ false, 0, true, false ] );
  }, 20_000 );

  // BP-290: the lease is beaten from the claim, not from the agent's spawn. An extraction past the 3-beat lease (kixie's
  // worktree reinstalls node_modules and builds its extractor, ~4 min) is beaten through, so the host never reaps it.
  it( 'start --once: an extraction longer than the lease is heartbeaten through, and the job is reported done', async () => {
    const host = await leaseHost( () => ( { body: { ok: true } } ) );
    const claude = makeFakeClaude( 0 );
    const repo = makeRepo( 'sleep 1.5 && mkdir -p .blueprint && echo \'{"nodes":[1,2]}\' > .blueprint/graph.json' );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', '--heartbeat', '0.2' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: stopAfter( 15000 ) } );
    expect( r.code ).toBe( 0 );
    const agentStep = host.requests.findIndex( ( q ) => q.url === '/api/blueprint/steward/jobs/jl/heartbeat' && q.body?.step === 'agent' );
    const extractStep = host.requests.findIndex( ( q ) => q.url === '/api/blueprint/steward/jobs/jl/heartbeat' && q.body?.step === 'extract' );
    const during = host.requests.slice( extractStep, agentStep ).filter( ( q ) => q.url === '/api/blueprint/steward/jobs/jl/heartbeat' && q.body?.step === undefined );
    expect( [ extractStep > -1, agentStep > extractStep ] ).toEqual( [ true, true ] );
    expect( during.length ).toBeGreaterThanOrEqual( 4 );
    expect( reports( host, 'jl' ).map( ( q ) => q.body.status ) ).toEqual( [ 'done' ] );
  }, 30_000 );

  it( 'start --once: a lease lost while the job extracts starts no agent and posts no report', async () => {
    let beat = 0;
    const host = await leaseHost( () => ( ++beat === 1 ? { body: { ok: true } }
      : { status: 404, body: { ok: false, error: { code: 'RUNNER_JOB_NOT_CLAIMED', message: 'no claimed job jl with a live lease' } } } ) );
    const claude = makeFakeClaude( 0 );
    const repo = makeRepo( 'sleep 1.5 && mkdir -p .blueprint && echo \'{"nodes":[1,2]}\' > .blueprint/graph.json' );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', '--heartbeat', '0.2' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: stopAfter( 15000 ) } );
    expect( r.code ).toBe( 0 );
    expect( heartbeats( host, 'jl' ).length ).toBe( 2 );
    expect( existsSync( claude.record ) ).toBe( false );
    expect( reports( host, 'jl' ) ).toEqual( [] );
    expect( r.stderr ).toContain( 'lost its lease; not reported' );
  }, 30_000 );

  it( 'start --once: a heartbeat the host accepts keeps the child running until it exits on its own', async () => {
    const host = await leaseHost( () => ( { body: { ok: true } } ) );
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node\n${ printInit }\nconsole.log('slow agent output');\nsetTimeout(() => process.exit(0), 900);\n` );
    execSync( `chmod +x ${ script }` );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--heartbeat', '0.2' ],
      { BLUEPRINT_STEWARD_CLAUDE: script }, { killWhen: stopAfter( 8000 ) } );
    expect( r.code ).toBe( 0 );
    expect( heartbeats( host, 'jl' ).length ).toBeGreaterThanOrEqual( 2 );
    expect( reports( host, 'jl' ).map( ( q ) => q.body.status ) ).toEqual( [ 'done' ] );
  }, 20_000 );

  // Negative control: only 404 RUNNER_JOB_NOT_CLAIMED stops the agent. A 503, and a 404
  // carrying another code, are logged, the next heartbeat still goes out, and the child runs to its own exit.
  it( 'start --once: a heartbeat refused 503, then 404 with another code, is logged and the child still runs to its own exit and is reported done', async () => {
    let beat = 0;
    const host = await leaseHost( () => {
      beat += 1;
      if ( beat === 1 ) return { status: 503, body: { ok: false, error: { code: 'UNAVAILABLE', message: 'try later' } } };
      if ( beat === 2 ) return { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'no such route' } } };
      return { body: { ok: true } };
    } );
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node\n${ printInit }\nconsole.log('slow agent output');\nsetTimeout(() => process.exit(0), 1200);\n` );
    execSync( `chmod +x ${ script }` );
    const stop = stopAfter( 8000 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--heartbeat', '0.2' ],
      { BLUEPRINT_STEWARD_CLAUDE: script }, { killWhen: stop } );
    expect( [ stop.fired, r.code ] ).toEqual( [ false, 0 ] );
    expect( heartbeats( host, 'jl' ).length ).toBeGreaterThanOrEqual( 3 );
    expect( r.stderr ).toContain( '(503)' );
    expect( r.stderr ).toContain( 'NOT_FOUND' );
    expect( reports( host, 'jl' ).map( ( q ) => q.body.status ) ).toEqual( [ 'done' ] );
  }, 20_000 );

  // --max-run-minutes bounds a child's wall clock.
  it( 'start --once: a claude past --max-run-minutes is killed and the job reported failed limit-wallclock', async () => {
    const host = await leaseHost( () => ( { body: { ok: true } } ) );
    const claude = makeHangingClaude();
    const stop = stopAfter( 8000, claude );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--max-run-minutes', '0.01' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: stop } );
    const sent = reports( host, 'jl' );
    expect( sent.map( ( q ) => [ q.body.status, q.body.reason ] ) ).toEqual( [ [ 'failed', 'limit-wallclock' ] ] );
    expect( sent[ 0 ].body.result ).toContain( '--max-run-minutes' );
    expect( [ stop.fired, r.code, claude.pid() !== undefined, alive( claude.pid() ) ] ).toEqual( [ false, 0, true, false ] );
  }, 20_000 );

  // A stopped agent gets SIGTERM, then SIGKILL once KILL_GRACE_MS (10 s) passes. This
  // fake claude ignores SIGTERM, so only the SIGKILL ends it; the run takes the full grace, about 11 s.
  it( 'start --once: a claude that ignores SIGTERM is SIGKILLed after the 10 s grace and the job still reported limit-wallclock', async () => {
    const host = await leaseHost( () => ( { body: { ok: true } } ) );
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const record = join( dir, 'record.json' );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(${ JSON.stringify( record ) }, JSON.stringify({ pid: process.pid }));
${ printInit }
console.log('ignoring SIGTERM');
setInterval(() => {}, 1000);
` );
    execSync( `chmod +x ${ script }` );
    const pid = () => ( existsSync( record ) ? ( JSON.parse( readFileSync( record, 'utf-8' ) ) as { pid: number } ).pid : undefined );
    hanging.push( pid );
    const stop = stopAfter( 20_000, { pid } );
    const started = Date.now();
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', '--max-run-minutes', '0.01' ],
      { BLUEPRINT_STEWARD_CLAUDE: script }, { killWhen: stop } );
    const elapsed = Date.now() - started;
    expect( reports( host, 'jl' ).map( ( q ) => [ q.body.status, q.body.reason ] ) ).toEqual( [ [ 'failed', 'limit-wallclock' ] ] );
    expect( [ stop.fired, r.code, pid() !== undefined, alive( pid() ) ] ).toEqual( [ false, 0, true, false ] );
    // The 0.6 s wall clock plus the 10 s grace: a SIGKILL sent sooner is not the grace.
    expect( elapsed ).toBeGreaterThanOrEqual( 10_600 );
  }, 40_000 );

  it( 'a --heartbeat or --max-run-minutes that is not a positive number, a heartbeat beyond the host\'s 600 s, or a wall clock past setTimeout\'s 35791 minutes, exits 1', async () => {
    for ( const rest of [ [ '--heartbeat', '0' ], [ '--heartbeat', 'abc' ], [ '--heartbeat', '601' ], [ '--max-run-minutes', '0' ], [ '--max-run-minutes', '-1' ], [ '--max-run-minutes', '35792' ], [ '--heartbeat' ] ] ) {
      const host = await jobHost();
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--once', ...rest ] );
      expect( [ rest, r.code, host.requests.length ] ).toEqual( [ rest, 1, 0 ] );
      expect( r.stderr ).toContain( rest[ 0 ] );
    }
  } );

  // Steward's HEARTBEAT_MAX_SECONDS is RUNNER_HEARTBEAT_MAX_SECONDS from @bett3r-dev/blueprint-spec: its bound is
  // accepted and one past it refused. The --max-run-minutes bound (2^31-1 ms as whole minutes) is accepted too.
  it( 'start accepts --heartbeat at the server\'s RUNNER_HEARTBEAT_MAX_SECONDS and --max-run-minutes 35791, and refuses one past the heartbeat bound', async () => {
    for ( const [ rest, refused ] of [
      [ [ '--heartbeat', String( RUNNER_HEARTBEAT_MAX_SECONDS ) ], false ],
      [ [ '--heartbeat', String( RUNNER_HEARTBEAT_MAX_SECONDS + 1 ) ], true ],
      [ [ '--max-run-minutes', '35791' ], false ],
    ] as const ) {
      const host = await fakeHost( () => ( {} ) );
      // An accepted flag reaches the claim loop and is stopped at its claim (not at the merge poller's request, which
      // can come first); a refused one exits before any request.
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--interval', '0.05', ...rest ], {},
        { killWhen: () => host.requests.some( ( q ) => q.url === '/api/blueprint/steward/claim' ) } );
      const claimed = host.requests.some( ( q ) => q.url === '/api/blueprint/steward/claim' );
      expect( [ rest, r.code === 1, claimed, r.stderr.includes( 'needs a positive number' ) ] ).toEqual( [ rest, refused, !refused, refused ] );
    }
  }, 30_000 );

  // Kinds dispatch through one table; a kind it does not hold is
  // failed kind-unknown and never falls through to the design flow. `constructor` proves the lookup is not a plain
  // object's prototype chain.
  it( 'start --once: a claimed job of an unknown kind reports failed kind-unknown and never runs the design flow', async () => {
    for ( const kind of [ 'mystery', 'constructor', undefined ] ) {
      const host = await fakeHost( ( req ) =>
        req.url === '/api/blueprint/steward/claim' ? { body: { job: { id: 'jm', kind, sessionId: 'sess-m', branch: 'feature', prompt: 'do it', jobKey: 'bpjk_minted-for-jm', instructions: SERVED, method: METHOD, ...TOOLS } } } : {} );
      const claude = makeFakeClaude( 0 );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
      expect( [ kind, r.code ] ).toEqual( [ kind, 0 ] );
      expect( [ kind, host.requests.map( ( q ) => q.url ) ] ).toEqual( [ kind, [ '/api/blueprint/steward/claim', '/api/blueprint/steward/jobs/jm' ] ] );
      expect( host.requests[ 1 ].body ).toMatchObject( { status: 'failed', reason: 'kind-unknown' } );
      expect( existsSync( claude.record ) ).toBe( false );
    }
  } );

  // Usage is read from `claude -p --output-format json`, and only
  // in the shape pinned by fixtures/claude-2.1.284-result.json (CLI JSON varies by version). Anything else is
  // reported with cost_source unreported and the raw output as the result. Both fixtures are live captures of
  // `claude -p --output-format json` from claude 2.1.284 (claude-2.1.284-result.json a successful run;
  // claude-2.1.284-error.json a run on an unknown --model, which exited 1 with is_error true and an empty modelUsage),
  // kept verbatim but for session_id and uuid (placeholder uuids) and every cost and token count (zero). The usage test
  // puts placeholder numbers back into the success capture's shape, so a non-zero usage is read through.
  // Steward reads `--output-format stream-json`, whose last line is that result event, so each stub here
  // writes the 2.1.287 init event listing the method first (`init: false` for an output that carries its own).
  const makeOutputClaude = ( output: string, exitCode: number, { init = true }: { init?: boolean } = {} ) => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const script = join( dir, 'claude.mjs' );
    const record = join( dir, 'record.json' );
    writeFileSync( script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${ JSON.stringify( record ) }, JSON.stringify({ argv: process.argv.slice(2) }));
${ init ? printInit : '' }
process.stdout.write(${ JSON.stringify( output ) });
process.exit(${ exitCode });
` );
    execSync( `chmod +x ${ script }` );
    return { script, record };
  };
  const PINNED = readFileSync( join( __dirname, 'fixtures', 'claude-2.1.284-result.json' ), 'utf-8' );
  const PINNED_ERROR = readFileSync( join( __dirname, 'fixtures', 'claude-2.1.284-error.json' ), 'utf-8' );

  // The success capture with placeholder usage in its own fields.
  const PINNED_WITH_USAGE = ( () => {
    const parsed = JSON.parse( PINNED );
    return JSON.stringify( { ...parsed, total_cost_usd: 0.017034, usage: { ...parsed.usage, input_tokens: 2, output_tokens: 4 } } );
  } )();

  it( 'start --once: the report carries the usage the pinned claude result JSON names, and its result text', async () => {
    const host = await jobHost();
    const claude = makeOutputClaude( PINNED_WITH_USAGE, 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    expect( valueOf( JSON.parse( readFileSync( claude.record, 'utf-8' ) ).argv, '--output-format' ) ).toBe( 'stream-json' );
    const report = reports( host, 'j9' )[ 0 ].body;
    expect( report.status ).toBe( 'done' );
    expect( report.result ).toBe( 'ok' );
    expect( report.usage ).toEqual( { model: 'claude-opus-5-5', input_tokens: 2, output_tokens: 4, cost_usd_micros: 17034, cost_source: 'runner-sdk' } );
  } );

  it( 'start --once: the captured error run (exit 1, is_error, empty modelUsage) reports agent-error with its message and a zero, model-less usage', async () => {
    const host = await jobHost();
    const claude = makeOutputClaude( PINNED_ERROR, 1 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const report = reports( host, 'j9' )[ 0 ].body;
    expect( [ report.status, report.reason ] ).toEqual( [ 'failed', 'agent-error' ] );
    expect( report.result ).toBe( 'There\'s an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.' );
    expect( report.usage ).toEqual( { input_tokens: 0, output_tokens: 0, cost_usd_micros: 0, cost_source: 'runner-sdk' } );
  } );

  // The whole 2.1.287 stream-json capture, init, assistant, rate-limit and
  // result events, reports the result event's text and usage. Expected values read off the capture's result line.
  it( 'start --once: a captured claude 2.1.287 stream-json run reports its result text and the usage its result event names', async () => {
    const host = await jobHost();
    const claude = makeOutputClaude( STREAM_2_1_287, 0, { init: false } );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const report = reports( host, 'j9' )[ 0 ].body;
    expect( [ report.status, report.reason, report.result ] ).toEqual( [ 'done', undefined, 'ok' ] );
    expect( report.usage ).toEqual( { model: 'claude-haiku-4-5-20251001', input_tokens: 0, output_tokens: 0, cost_usd_micros: 0, cost_source: 'runner-sdk' } );
  } );

  it( 'start --once: a claude Steward cannot find is reported failed claude-missing', async () => {
    const host = await jobHost();
    const missing = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) ), 'no-such-claude' );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: missing } );
    expect( r.code ).toBe( 0 );
    const report = reports( host, 'j9' )[ 0 ].body;
    expect( [ report.status, report.reason ] ).toEqual( [ 'failed', 'claude-missing' ] );
    expect( report.result ).toContain( 'ENOENT' );
  } );

  it( 'start --once: output outside the pinned shape reports usage unreported with the raw output; a non-zero exit is agent-error', async () => {
    for ( const [ output, exitCode, status, reason ] of [
      [ 'fake agent output\n', 0, 'done', undefined ],
      [ '{"type":"result","result":"no usage block"}', 0, 'done', undefined ],
      [ 'boom\n', 1, 'failed', 'agent-error' ],
    ] as const ) {
      const host = await jobHost();
      const claude = makeOutputClaude( output, exitCode );
      await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
      const report = reports( host, 'j9' )[ 0 ].body;
      expect( [ output, report.status, report.reason, report.usage ] ).toEqual( [ output, status, reason, { cost_source: 'unreported' } ] );
      expect( report.result ).toContain( output.trim() );
    }
  } );

  it( 'a 401 on claim is logged and the loop keeps polling', async () => {
    const host = await fakeHost( () => ( { status: 401, body: { error: 'nope' } } ) );
    const r = await run( [ 'start', '--server', host.url, '--token', 'bad', '--interval', '0.05', '--once' ], {},
      { killWhen: () => host.requests.length >= 2 } );
    expect( host.requests.length ).toBeGreaterThanOrEqual( 2 );
    expect( host.requests.every( ( q ) => q.url === '/api/blueprint/steward/claim' ) ).toBe( true );
    expect( r.stderr ).toContain( '(401)' );
  } );
} );

// A design claim names the method plugin by sha256; Steward downloads the
// zip on the job's method route before it prepares the worktree, refuses bytes of another sha, caches verified zips by
// sha beside the session worktrees (at most 5, re-hashed on every use), hands the zip to claude with --plugin-dir under
// --output-format stream-json, and stops the agent when claude's init event does not list the plugin. Every refusal
// fails the job with its own reason and spawns no claude, or stops the one it spawned.
describe( 'blueprint-steward start: the method plugin', () => {
  // The served text: the method's entry, then the turn's text.
  const SERVED = { text: '/blueprint-method:turn Served hosted-turn text, version 3.', version: 3, sha256: 'a'.repeat( 64 ) };
  const TOOLS = { tools: [ 'mcp__blueprint', 'Read', 'Glob', 'Grep' ], disallowedTools: [ 'mcp__blueprint__start_map_session' ] };
  const designJob = ( id: string, extra: Record<string, unknown> = {} ) =>
    ( { id, kind: 'design', sessionId: `sess-${ id }`, branch: 'feature', prompt: null, jobKey: `bpjk_minted-for-${ id }`, instructions: SERVED, ...TOOLS, method: METHOD, ...extra } );
  const claimOnly = ( job: Record<string, unknown>, method?: MethodAnswer ) =>
    fakeHost( ( req ) => ( req.url === '/api/blueprint/steward/claim' ? { body: { job } } : {} ), method === undefined ? {} : { method } );
  // Where Steward keeps verified zips: beside the session worktrees, in a directory no session id can name
  // (a session segment starts with a letter or digit), one file per sha256.
  const methodCacheOf = ( repo: string ) => join( `${ repo }.blueprint-worktrees`, '.method' );
  const methodGets = ( host: { requests: Req[] } ) => host.requests.filter( ( q ) => q.method === 'GET' && METHOD_ROUTE.test( q.url ) );
  const reportOf = ( host: { requests: Req[] }, id: string ) => host.requests.filter( ( q ) => q.url === `/api/blueprint/steward/jobs/${ id }` ).map( ( q ) => q.body );
  const argOf = ( argv: string[], name: string ) => ( argv.includes( name ) ? argv[ argv.indexOf( name ) + 1 ] : `<${ name } absent>` );
  const once = ( host: { url: string }, repo: string, script: string, rest: string[] = [] ) =>
    run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', ...rest ], { BLUEPRINT_STEWARD_CLAUDE: script } );

  it( 'a served zip whose sha256 differs from claim.method.sha256 fails the job method-mismatch before any checkout, and claude is never spawned', async () => {
    const other = Buffer.from( 'a different method build\n', 'utf8' );
    expect( sha256Of( other ) ).not.toBe( METHOD.sha256 );
    const host = await claimOnly( designJob( 'jx' ), other );
    const repo = makeRepo();
    const claude = makeFakeClaude( 0 );
    const r = await once( host, repo, claude.script );
    expect( r.code ).toBe( 0 );
    expect( host.requests.map( ( q ) => `${ q.method } ${ q.url }` ) ).toEqual( [
      'POST /api/blueprint/steward/claim', 'GET /api/blueprint/steward/jobs/jx/method', 'POST /api/blueprint/steward/jobs/jx',
    ] );
    expect( methodGets( host )[ 0 ].headers[ 'x-blueprint-session-id' ] ).toBe( 'sess-jx' );
    expect( reportOf( host, 'jx' ) ).toMatchObject( [ { status: 'failed', reason: 'method-mismatch' } ] );
    expect( existsSync( claude.record ) ).toBe( false );
    expect( existsSync( join( methodCacheOf( repo ), `${ METHOD.sha256 }.zip` ) ) ).toBe( false );
  } );

  it( 'a design claim with no method, or one naming no sha256, fails method-missing with no download and no claude', async () => {
    for ( const method of [ undefined, { ...METHOD, sha256: 'not-a-sha' } ] ) {
      const host = await claimOnly( designJob( 'jm', { method } ) );
      const claude = makeFakeClaude( 0 );
      const r = await once( host, makeRepo(), claude.script );
      expect( r.code ).toBe( 0 );
      expect( [ method, host.requests.map( ( q ) => q.url ) ] ).toEqual( [ method, [ '/api/blueprint/steward/claim', '/api/blueprint/steward/jobs/jm' ] ] );
      expect( reportOf( host, 'jm' ) ).toMatchObject( [ { status: 'failed', reason: 'method-missing' } ] );
      expect( existsSync( claude.record ) ).toBe( false );
    }
  }, 20_000 );

  it( 'a method route the host refuses (409 METHOD_SUPERSEDED) fails the job method-unavailable naming the refusal, and claude is never spawned', async () => {
    const host = await claimOnly( designJob( 'ju' ), { status: 409, body: { ok: false, error: { code: 'METHOD_SUPERSEDED', message: 'superseded' } } } );
    const claude = makeFakeClaude( 0 );
    const r = await once( host, makeRepo(), claude.script );
    expect( r.code ).toBe( 0 );
    const [ report ] = reportOf( host, 'ju' );
    expect( [ report.status, report.reason ] ).toEqual( [ 'failed', 'method-unavailable' ] );
    expect( report.result ).toContain( 'METHOD_SUPERSEDED' );
    expect( existsSync( claude.record ) ).toBe( false );
  } );

  it( 'a second design job of the same sha downloads nothing; claude gets --plugin-dir <the cached zip>, stream-json, and the served text unchanged as -p', async () => {
    const repo = makeRepo();
    const first = await claimOnly( designJob( 'j1' ) );
    expect( ( await once( first, repo, makeFakeClaude( 0 ).script ) ).code ).toBe( 0 );
    expect( [ methodGets( first ).length, reportOf( first, 'j1' )[ 0 ]?.status ] ).toEqual( [ 1, 'done' ] );

    const second = await claimOnly( designJob( 'j2' ) );
    const claude = makeFakeClaude( 0 );
    expect( ( await once( second, repo, claude.script ) ).code ).toBe( 0 );
    expect( methodGets( second ) ).toEqual( [] );
    const { argv } = JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[] };
    const cached = join( methodCacheOf( repo ), `${ METHOD.sha256 }.zip` );
    expect( argOf( argv, '--plugin-dir' ) ).toBe( cached );
    expect( sha256Of( readFileSync( cached ) ) ).toBe( METHOD.sha256 );
    // claude refuses stream-json under -p without --verbose (measured on 2.1.287: "requires --verbose").
    expect( [ argOf( argv, '--output-format' ), argv.includes( '--verbose' ) ] ).toEqual( [ 'stream-json', true ] );
    expect( argOf( argv, '-p' ) ).toBe( SERVED.text );
    expect( argOf( argv, '-p' ).startsWith( '/blueprint-method:turn ' ) ).toBe( true );
    expect( reportOf( second, 'j2' )[ 0 ]?.status ).toBe( 'done' );
  }, 30_000 );

  it( 'a cached zip is re-hashed on use: one whose bytes changed is downloaded again and replaced, and the job runs', async () => {
    const repo = makeRepo();
    expect( ( await once( await claimOnly( designJob( 'j1' ) ), repo, makeFakeClaude( 0 ).script ) ).code ).toBe( 0 );
    const cached = join( methodCacheOf( repo ), `${ METHOD.sha256 }.zip` );
    expect( existsSync( cached ) ).toBe( true );
    writeFileSync( cached, 'tampered on disk\n' );

    const host = await claimOnly( designJob( 'j2' ) );
    const claude = makeFakeClaude( 0 );
    expect( ( await once( host, repo, claude.script ) ).code ).toBe( 0 );
    expect( methodGets( host ).length ).toBe( 1 );
    expect( sha256Of( readFileSync( cached ) ) ).toBe( METHOD.sha256 );
    expect( reportOf( host, 'j2' )[ 0 ]?.status ).toBe( 'done' );
    expect( existsSync( claude.record ) ).toBe( true );
  }, 30_000 );

  it( 'the cache keeps at most 5 zips: a sixth sha evicts the least recently used one', async () => {
    const repo = makeRepo();
    const cache = methodCacheOf( repo );
    mkdirSync( cache, { recursive: true } );
    const seeded = [ 1, 2, 3, 4, 5 ].map( ( n ) => {
      const bytes = Buffer.from( `older method build ${ n }\n`, 'utf8' );
      const path = join( cache, `${ sha256Of( bytes ) }.zip` );
      writeFileSync( path, bytes );
      // Build 1 was used longest ago.
      const at = new Date( Date.UTC( 2026, 0, n ) );
      utimesSync( path, at, at );
      return `${ sha256Of( bytes ) }.zip`;
    } );
    const host = await claimOnly( designJob( 'j6' ) );
    expect( ( await once( host, repo, makeFakeClaude( 0 ).script ) ).code ).toBe( 0 );
    expect( reportOf( host, 'j6' )[ 0 ]?.status ).toBe( 'done' );
    expect( readdirSync( cache ).filter( ( name ) => name.endsWith( '.zip' ) ).sort() ).toEqual( [ ...seeded.slice( 1 ), `${ METHOD.sha256 }.zip` ].sort() );
  }, 20_000 );

  // The init event's shape is version-coupled, and a claude whose init does not show the plugin loaded
  // fails the job rather than run a turn without the method.
  it( 'an init event without blueprint-method stops the agent and fails the job method-not-loaded; the captured 2.1.287 init listing it proceeds', async () => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const record = join( dir, 'record.json' );
    const script = join( dir, 'claude.mjs' );
    // Writes the 2.1.287 init of a run without --plugin-dir, then works until it is stopped.
    writeFileSync( script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${ JSON.stringify( record ) }, JSON.stringify({ pid: process.pid }));
process.stdout.write(${ JSON.stringify( `${ INIT_LINE_NO_PLUGIN }\n` ) });
setInterval(() => {}, 1000);
` );
    execSync( `chmod +x ${ script }` );
    const host = await claimOnly( designJob( 'jn' ) );
    const started = Date.now();
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once' ], { BLUEPRINT_STEWARD_CLAUDE: script },
      { killWhen: () => {
        if ( Date.now() - started < 8_000 ) return false;
        // Past the bound the stub is ended too: it holds Steward's stderr, so Steward's close waits on it.
        if ( existsSync( record ) ) try { process.kill( ( JSON.parse( readFileSync( record, 'utf-8' ) ) as { pid: number } ).pid, 'SIGKILL' ); } catch { /* gone */ }
        return true;
      } } );
    const stopped = Date.now() - started < 8_000;
    const [ report ] = reportOf( host, 'jn' );
    expect( [ report?.status, report?.reason ] ).toEqual( [ 'failed', 'method-not-loaded' ] );
    const { pid } = JSON.parse( readFileSync( record, 'utf-8' ) ) as { pid: number };
    const state = ( () => { try { process.kill( pid, 0 ); return 'alive'; } catch { return 'gone'; } } )();
    // A stub Steward failed to stop is stopped here, so a RED leaves no process behind.
    if ( state === 'alive' ) process.kill( pid, 'SIGKILL' );
    expect( [ state, stopped, r.code ] ).toEqual( [ 'gone', true, 0 ] );

    // Positive control: the captured init that lists the plugin lets the same job run to done.
    const loaded = await claimOnly( designJob( 'jl' ) );
    expect( ( await once( loaded, makeRepo(), makeFakeClaude( 0 ).script ) ).code ).toBe( 0 );
    expect( reportOf( loaded, 'jl' ).map( ( b ) => [ b.status, b.reason ] ) ).toEqual( [ [ 'done', undefined ] ] );
  }, 40_000 );

  it( 'a claude whose first output is no init event (a renamed shape, or plain text) is stopped method-not-loaded, not reported done', async () => {
    for ( const first of [ STREAM_2_1_287.split( '\n' )[ 1 ], 'fake agent output' ] ) {
      const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
      const script = join( dir, 'claude.mjs' );
      writeFileSync( script, `#!/usr/bin/env node\nprocess.stdout.write(${ JSON.stringify( `${ first }\n` ) });\nsetTimeout(() => process.exit(0), 300);\n` );
      execSync( `chmod +x ${ script }` );
      const host = await claimOnly( designJob( 'jr' ) );
      expect( ( await once( host, makeRepo(), script ) ).code ).toBe( 0 );
      expect( [ first.slice( 0, 20 ), reportOf( host, 'jr' ).map( ( b ) => [ b.status, b.reason ] ) ] ).toEqual( [ first.slice( 0, 20 ), [ [ 'failed', 'method-not-loaded' ] ] ] );
    }
  }, 30_000 );

  // A stub claude that writes `output` verbatim and exits `code`.
  const writingClaude = ( output: string, code: number ) => {
    const script = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) ), 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node\nprocess.stdout.write(${ JSON.stringify( output ) });\nsetTimeout(() => process.exit(${ code }), 300);\n` );
    execSync( `chmod +x ${ script }` );
    return script;
  };
  const HOOK_LINES = STREAM_2_1_288_SESSION_START_HOOK.split( '\n' );

  // A project with a SessionStart hook makes claude write
  // system/hook_started and system/hook_response before system/init; the init event decides, not the first line.
  it( 'the captured 2.1.288 stream of a project with a SessionStart hook (hook events before the init listing the method) runs to done with its result', async () => {
    expect( HOOK_LINES.slice( 0, 3 ).map( ( line ) => { const e = JSON.parse( line ) as { type: string; subtype: string }; return `${ e.type }/${ e.subtype }`; } ) )
      .toEqual( [ 'system/hook_started', 'system/hook_response', 'system/init' ] );
    const host = await claimOnly( designJob( 'jh' ) );
    expect( ( await once( host, makeRepo(), writingClaude( STREAM_2_1_288_SESSION_START_HOOK, 0 ) ) ).code ).toBe( 0 );
    expect( reportOf( host, 'jh' ).map( ( b ) => [ b.status, b.reason, b.result ] ) ).toEqual( [ [ 'done', undefined, 'ok' ] ] );
  }, 30_000 );

  it( 'after the hook events, an init without the method, a non-system event before any init, or an exit with no init fails method-not-loaded', async () => {
    const hooks = HOOK_LINES.slice( 0, 2 ).map( ( line ) => `${ line }\n` ).join( '' );
    for ( const [ label, output ] of [
      [ 'init without the method', `${ hooks }${ INIT_LINE_NO_PLUGIN }\n` ],
      [ 'assistant before init', `${ hooks }${ HOOK_LINES[ 3 ] }\n${ HOOK_LINES[ 2 ] }\n` ],
      [ 'hooks then exit 0', hooks ],
    ] ) {
      const host = await claimOnly( designJob( 'jx' ) );
      expect( ( await once( host, makeRepo(), writingClaude( output, 0 ) ) ).code ).toBe( 0 );
      expect( [ label, reportOf( host, 'jx' ).map( ( b ) => [ b.status, b.reason ] ) ] ).toEqual( [ label, [ [ 'failed', 'method-not-loaded' ] ] ] );
    }
  }, 40_000 );

  // The close-time branch fails closed on an exit 0 that never completed an init line.
  it( 'a claude exiting 0 with no output, or with one non-init line and no trailing newline, fails method-not-loaded', async () => {
    for ( const [ label, output ] of [ [ 'empty stdout', '' ], [ 'unterminated non-init line', 'fake agent output' ] ] ) {
      const host = await claimOnly( designJob( 'jc' ) );
      expect( ( await once( host, makeRepo(), writingClaude( output, 0 ) ) ).code ).toBe( 0 );
      expect( [ label, reportOf( host, 'jc' ).map( ( b ) => [ b.status, b.reason ] ) ] ).toEqual( [ label, [ [ 'failed', 'method-not-loaded' ] ] ] );
    }
  }, 30_000 );

  // The close-time read of a last line with no newline: an init listing the method there still shows it loaded.
  it( 'a claude exiting 0 whose only output is the init listing the method with no trailing newline runs to done', async () => {
    const host = await claimOnly( designJob( 'jt' ) );
    expect( ( await once( host, makeRepo(), writingClaude( INIT_LINE, 0 ) ) ).code ).toBe( 0 );
    expect( reportOf( host, 'jt' ).map( ( b ) => [ b.status, b.reason ] ) ).toEqual( [ [ 'done', undefined ] ] );
  }, 30_000 );

  // A non-zero exit whose output never decided the init while claude ran (an unterminated line, or only hook events)
  // never showed the method loaded; one that printed nothing is claude's own failure. A complete non-init line is not
  // this case: it stops the agent as it arrives.
  it( 'a claude exiting 1 after an unterminated non-init line, or after only hook events, fails method-not-loaded; one exiting 1 with no output fails agent-error', async () => {
    const hooks = HOOK_LINES.slice( 0, 2 ).map( ( line ) => `${ line }\n` ).join( '' );
    for ( const [ output, reason ] of [ [ 'fake agent output', 'method-not-loaded' ], [ hooks, 'method-not-loaded' ], [ '', 'agent-error' ] ] ) {
      const host = await claimOnly( designJob( 'je' ) );
      expect( ( await once( host, makeRepo(), writingClaude( output, 1 ) ) ).code ).toBe( 0 );
      expect( [ output.slice( 0, 30 ), reportOf( host, 'je' ).map( ( b ) => [ b.status, b.reason ] ) ] ).toEqual( [ output.slice( 0, 30 ), [ [ 'failed', reason ] ] ] );
    }
  }, 30_000 );
} );

// Blueprint ADR-136: a repository declares its design plugins in .blueprint.config.json designTooling.designPlugins,
// each a git source pinned to a commit sha. Steward reads them from the session's worktree (else the remote default
// branch's config), fetches each source at its sha into <repo>.blueprint-worktrees/.plugins, adds one --plugin-dir per
// plugin after the method's, and fails the job method-not-loaded when claude's init does not list them all.
describe( 'blueprint-steward start: the repository\'s design plugins', () => {
  const SERVED = { text: '/blueprint-method:turn Served hosted-turn text.', version: 3, sha256: 'a'.repeat( 64 ) };
  const designJob = ( id: string ) => ( {
    id, kind: 'design', sessionId: `sess-${ id }`, branch: 'feature', prompt: null, jobKey: `bpjk_minted-for-${ id }`, instructions: SERVED, method: METHOD,
    tools: [ 'mcp__blueprint', 'Read', 'Glob', 'Grep' ],
  } );
  const commit = ( cwd: string, message: string ) => execSync( `git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm ${ JSON.stringify( message ) }`, { cwd } );
  // A marketplace repository listing the plugin `ddd` at ./plugins/ddd, and its head sha.
  const makeMarketplace = () => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-marketplace-' ) );
    mkdirSync( join( dir, '.claude-plugin' ) );
    writeFileSync( join( dir, '.claude-plugin', 'marketplace.json' ), JSON.stringify( { name: 'marketplace', plugins: [ { name: 'ddd', source: './plugins/ddd' } ] } ) );
    mkdirSync( join( dir, 'plugins', 'ddd', '.claude-plugin' ), { recursive: true } );
    writeFileSync( join( dir, 'plugins', 'ddd', '.claude-plugin', 'plugin.json' ), JSON.stringify( { name: 'ddd', version: '0.2.0' } ) );
    execSync( 'git init -q -b master', { cwd: dir } );
    commit( dir, 'marketplace' );
    return { source: dir, ref: execSync( 'git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' } ).trim() };
  };
  // A repo whose `feature` branch (the job's) declares `designPlugins`, or, with onMain, whose origin main alone does.
  const repoDeclaring = ( designPlugins: unknown, { onMain = false } = {} ) => {
    const repo = makeRepo();
    const extract = ( JSON.parse( readFileSync( join( repo, '.blueprint.config.json' ), 'utf-8' ) ) as { designTooling: { extract: string } } ).designTooling.extract;
    const config = JSON.stringify( { designTooling: { extract, designPlugins } } );
    if ( onMain ) {
      writeFileSync( join( repo, '.blueprint.config.json' ), config );
      commit( repo, 'declare design plugins' );
      execSync( 'git push -q origin main', { cwd: repo } );
    } else {
      execSync( 'git checkout -q feature', { cwd: repo } );
      writeFileSync( join( repo, '.blueprint.config.json' ), config );
      commit( repo, 'declare design plugins' );
      execSync( 'git checkout -q main', { cwd: repo } );
    }
    return repo;
  };
  // The captured 2.1.287 init with `names` added to its plugins.
  const initListing = ( ...names: string[] ) => {
    const init = JSON.parse( INIT_LINE ) as { plugins: { name: string }[] };
    return JSON.stringify( { ...init, plugins: [ ...init.plugins, ...names.map( ( name ) => ( { name, path: `/inline/${ name }`, source: `${ name }@inline` } ) ) ] } );
  };
  const claudeWriting = ( init: string ) => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const record = join( dir, 'record.json' );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${ JSON.stringify( record ) }, JSON.stringify({ argv: process.argv.slice(2) }));
process.stdout.write(${ JSON.stringify( `${ init }\n` ) });
setTimeout(() => process.exit(0), 300);
` );
    execSync( `chmod +x ${ script }` );
    return { script, record };
  };
  const runOn = async ( repo: string, id: string, init: string ) => {
    const host = await fakeHost( ( req ) => ( req.url === '/api/blueprint/steward/claim' ? { body: { job: designJob( id ) } } : {} ) );
    const claude = claudeWriting( init );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const argv = existsSync( claude.record ) ? ( JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[] } ).argv : undefined;
    const pluginDirs = argv?.flatMap( ( arg, i ) => ( arg === '--plugin-dir' ? [ argv[ i + 1 ] ] : [] ) );
    const report = host.requests.filter( ( q ) => q.url === `/api/blueprint/steward/jobs/${ id }` ).map( ( q ) => q.body );
    return { pluginDirs, report, stderr: r.stderr };
  };

  it( 'a declared plugin is fetched at its sha and handed to claude as a second --plugin-dir; an init listing both runs to done, one listing only the method fails method-not-loaded', async () => {
    const { source, ref } = makeMarketplace();
    const repo = repoDeclaring( [ { source, ref, plugin: 'ddd' } ] );
    const loaded = await runOn( repo, 'jd', initListing( 'ddd' ) );
    const fetched = join( `${ repo }.blueprint-worktrees`, '.plugins', `${ sha256Of( Buffer.from( source ) ).slice( 0, 16 ) }-${ ref }` );
    expect( [ loaded.pluginDirs?.length, loaded.pluginDirs?.[ 1 ], loaded.report.map( ( b ) => [ b.status, b.reason ] ) ] )
      .toEqual( [ 2, join( fetched, 'plugins', 'ddd' ), [ [ 'done', undefined ] ] ] );
    expect( execSync( 'git rev-parse HEAD', { cwd: fetched, encoding: 'utf-8' } ).trim() ).toBe( ref );

    const missing = await runOn( repo, 'jn', INIT_LINE );
    expect( missing.report.map( ( b ) => [ b.status, b.reason ] ) ).toEqual( [ [ 'failed', 'method-not-loaded' ] ] );
    expect( missing.report[ 0 ].result ).toContain( 'blueprint-method, ddd' );
  }, 40_000 );

  it( 'a session branch whose config has no designPlugins key takes the remote default branch\'s', async () => {
    const { source, ref } = makeMarketplace();
    const { pluginDirs, report } = await runOn( repoDeclaring( [ { source, ref, plugin: 'ddd' } ], { onMain: true } ), 'jm', initListing( 'ddd' ) );
    expect( [ pluginDirs?.length, report.map( ( b ) => [ b.status, b.reason ] ) ] ).toEqual( [ 2, [ [ 'done', undefined ] ] ] );
  }, 30_000 );

  it( 'a ref that is no full sha fails config-invalid, an unreachable source or an unknown plugin fails method-unavailable; none spawns claude', async () => {
    const { source, ref } = makeMarketplace();
    for ( const [ declared, reason ] of [
      [ [ { source, ref: 'master', plugin: 'ddd' } ], 'config-invalid' ],
      [ [ { source: join( tmpdir(), 'no-such-marketplace' ), ref, plugin: 'ddd' } ], 'method-unavailable' ],
      [ [ { source, ref, plugin: 'coil' } ], 'method-unavailable' ],
    ] as const ) {
      const { pluginDirs, report } = await runOn( repoDeclaring( declared ), 'jr', initListing( 'ddd' ) );
      expect( [ declared[ 0 ].plugin, declared[ 0 ].ref.length, pluginDirs, report.map( ( b ) => [ b.status, b.reason ] ) ] )
        .toEqual( [ declared[ 0 ].plugin, declared[ 0 ].ref.length, undefined, [ [ 'failed', reason ] ] ] );
    }
  }, 60_000 );

  it( 'a repository declaring none runs the method alone', async () => {
    const { pluginDirs, report } = await runOn( makeRepo(), 'j0', INIT_LINE );
    expect( [ pluginDirs?.length, report.map( ( b ) => [ b.status, b.reason ] ) ] ).toEqual( [ 1, [ [ 'done', undefined ] ] ] );
  }, 30_000 );
} );

// A design claim names mcp__blueprint_repo as an optional tool. Steward
// starts blueprint-repo-mcp (MCP server `blueprint_repo`, so its tools are the entry contract's
// mcp__blueprint_repo__git_*) only when its --tool-ceiling admits it, and otherwise runs the job without it.
describe( 'blueprint-steward start: the optional repo history tool', () => {
  const SERVED = { text: '/blueprint-method:turn Served hosted-turn text.', version: 3, sha256: 'a'.repeat( 64 ) };
  const designJob = ( id: string, extra: Record<string, unknown> = {} ) => ( {
    id, kind: 'design', sessionId: `sess-${ id }`, branch: 'feature', prompt: null, jobKey: `bpjk_minted-for-${ id }`, instructions: SERVED, method: METHOD,
    tools: [ 'mcp__blueprint', 'Read', 'Glob', 'Grep' ], disallowedTools: [ 'mcp__blueprint__start_map_session' ], optionalTools: [ 'mcp__blueprint_repo' ], ...extra,
  } );
  const runWith = async ( job: Record<string, unknown>, rest: string[] = [] ) => {
    const host = await fakeHost( ( req ) => ( req.url === '/api/blueprint/steward/claim' ? { body: { job } } : {} ) );
    const repo = makeRepo();
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', ...rest ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    expect( r.code ).toBe( 0 );
    const rec = JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[]; mcp: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } };
    const argOf = ( name: string ) => ( rec.argv.includes( name ) ? rec.argv[ rec.argv.indexOf( name ) + 1 ] : `<${ name } absent>` );
    const report = host.requests.filter( ( q ) => q.url === `/api/blueprint/steward/jobs/${ job.id }` ).map( ( q ) => [ q.body.status, q.body.reason ] );
    return { repo, rec, servers: Object.keys( rec.mcp.mcpServers ).sort(), allowed: argOf( '--allowedTools' ), builtIn: argOf( '--tools' ), report };
  };

  it( 'Steward pinned to --tool-ceiling "mcp__blueprint Read Glob Grep" runs a claim naming mcp__blueprint_repo without it: no repo server in --mcp-config, and the job is done', async () => {
    const pinned = await runWith( designJob( 'jp' ), [ '--tool-ceiling', 'mcp__blueprint Read Glob Grep' ] );
    expect( [ pinned.servers, pinned.allowed, pinned.builtIn, pinned.report ] ).toEqual( [
      [ 'blueprint' ], 'mcp__blueprint Read Glob Grep', 'Read,Glob,Grep', [ [ 'done', undefined ] ],
    ] );
  }, 30_000 );

  it( 'with no ceiling, or a ceiling naming it, the repo server joins blueprint in --mcp-config on the session\'s worktree and mcp__blueprint_repo is allowed; blueprint-mcp\'s own entry is unchanged', async () => {
    for ( const rest of [ [], [ '--tool-ceiling', 'mcp__blueprint mcp__blueprint_repo Read Glob Grep' ] ] ) {
      const run1 = await runWith( designJob( 'ju' ), rest );
      expect( [ rest, run1.servers, run1.allowed, run1.builtIn, run1.report ] ).toEqual( [
        rest, [ 'blueprint', 'blueprint_repo' ], 'mcp__blueprint Read Glob Grep mcp__blueprint_repo', 'Read,Glob,Grep', [ [ 'done', undefined ] ],
      ] );
      const { blueprint, blueprint_repo: repoServer } = run1.rec.mcp.mcpServers;
      expect( repoServer.command ).toBe( process.execPath );
      expect( [ repoServer.args.length, repoServer.args[ 0 ].endsWith( '/mcp/bin/blueprint-repo-mcp.mjs' ), existsSync( repoServer.args[ 0 ] ) ] ).toEqual( [ 1, true, true ] );
      expect( Object.keys( repoServer.env ) ).toEqual( [ 'BLUEPRINT_REPO_PATH' ] );
      expect( realDir( repoServer.env.BLUEPRINT_REPO_PATH ) ).toBe( realDir( worktreeOf( run1.repo, 'sess-ju' ) ) );
      expect( [ blueprint.args.length, blueprint.args[ 0 ].endsWith( '/mcp/bin/blueprint-mcp.mjs' ) ] ).toEqual( [ 1, true ] );
    }
  }, 40_000 );

  it( 'a claim naming no optional tool, or only one Steward has no server for, gets no repo server and runs to done', async () => {
    for ( const optionalTools of [ undefined, [ 'mcp__unknown_history' ] ] ) {
      const plain = await runWith( designJob( 'jn', { optionalTools } ) );
      expect( [ optionalTools, plain.servers, plain.allowed, plain.report ] ).toEqual( [ optionalTools, [ 'blueprint' ], 'mcp__blueprint Read Glob Grep', [ [ 'done', undefined ] ] ] );
    }
  }, 40_000 );
} );

// Blueprint ADR-135: the team grants every design job tools beyond the served ones with --design-tools (or
// $BLUEPRINT_STEWARD_DESIGN_TOOLS), held to --tool-ceiling and to --design-writes at startup, and Steward logs what the
// agent left in the session's worktree.
describe( 'blueprint-steward start: the team\'s design tools (Blueprint ADR-135)', () => {
  const SERVED = { text: '/blueprint-method:turn Served hosted-turn text.', version: 3, sha256: 'a'.repeat( 64 ) };
  const designJob = ( id: string ) => ( {
    id, kind: 'design', sessionId: `sess-${ id }`, branch: 'feature', prompt: null, jobKey: `bpjk_minted-for-${ id }`, instructions: SERVED, method: METHOD,
    tools: [ 'mcp__blueprint', 'Read', 'Glob', 'Grep' ], disallowedTools: [ 'mcp__blueprint__start_map_session' ], optionalTools: [ 'mcp__blueprint_repo' ],
  } );
  // A fake claude that, like makeFakeClaude's, records its argv; `leave` names a file it writes into its cwd first.
  const makeClaude = ( leave?: string ) => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const record = join( dir, 'record.json' );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${ JSON.stringify( record ) }, JSON.stringify({ argv: process.argv.slice(2) }));
${ leave ? `writeFileSync(${ JSON.stringify( leave ) }, 'scratch');` : '' }
${ printInit }
console.log('fake agent output');
` );
    chmodSync( script, 0o755 );
    return { script, record };
  };
  const runWith = async ( rest: string[], { env = {}, leave }: { env?: Record<string, string>; leave?: string } = {} ) => {
    const job = designJob( 'jd' );
    const host = await fakeHost( ( req ) => ( req.url === '/api/blueprint/steward/claim' ? { body: { job } } : {} ) );
    const claude = makeClaude( leave );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), '--once', ...rest ], { BLUEPRINT_STEWARD_CLAUDE: claude.script, ...env } );
    const argv = existsSync( claude.record ) ? ( JSON.parse( readFileSync( claude.record, 'utf-8' ) ) as { argv: string[] } ).argv : undefined;
    const argOf = ( name: string ) => ( argv?.includes( name ) ? argv[ argv.indexOf( name ) + 1 ] : `<${ name } absent>` );
    const report = host.requests.filter( ( q ) => q.url === '/api/blueprint/steward/jobs/jd' ).map( ( q ) => q.body.status );
    return { r, spawned: argv !== undefined, allowed: argOf( '--allowedTools' ), builtIn: argOf( '--tools' ), report, requests: host.requests.length };
  };

  it( 'with no grant a design job runs on the served tools alone, as before', async () => {
    const plain = await runWith( [] );
    expect( [ plain.allowed, plain.builtIn, plain.report ] ).toEqual( [ 'mcp__blueprint Read Glob Grep mcp__blueprint_repo', 'Read,Glob,Grep', [ 'done' ] ] );
  }, 30_000 );

  it( '--design-tools "Bash Skill", or the same list in $BLUEPRINT_STEWARD_DESIGN_TOOLS, joins the served tools once each: pre-approved and available as built-ins', async () => {
    for ( const [ rest, env ] of [ [ [ '--design-tools', 'Bash Skill Read' ], {} ], [ [], { BLUEPRINT_STEWARD_DESIGN_TOOLS: 'Bash,Skill,Read' } ] ] as const ) {
      const granted = await runWith( [ ...rest ], { env } );
      expect( [ rest, granted.allowed, granted.builtIn, granted.report ] ).toEqual( [
        rest, 'mcp__blueprint Read Glob Grep mcp__blueprint_repo Bash Skill', 'Read,Glob,Grep,Bash,Skill', [ 'done' ],
      ] );
    }
  }, 40_000 );

  it( 'the flag wins over the environment, and an empty environment variable is no grant', async () => {
    const flagged = await runWith( [ '--design-tools', 'Skill' ], { env: { BLUEPRINT_STEWARD_DESIGN_TOOLS: 'Bash' } } );
    expect( flagged.builtIn ).toBe( 'Read,Glob,Grep,Skill' );
    const blank = await runWith( [], { env: { BLUEPRINT_STEWARD_DESIGN_TOOLS: '' } } );
    expect( [ blank.builtIn, blank.report ] ).toEqual( [ 'Read,Glob,Grep', [ 'done' ] ] );
  }, 40_000 );

  it( 'a grant beyond --tool-ceiling exits 1 before any claim; one within it runs', async () => {
    const beyond = await runWith( [ '--tool-ceiling', 'mcp__blueprint Read Glob Grep', '--design-tools', 'Bash' ] );
    expect( [ beyond.r.code, beyond.requests, beyond.spawned ] ).toEqual( [ 1, 0, false ] );
    expect( beyond.r.stderr ).toContain( '--design-tools grants Bash, beyond this Steward\'s --tool-ceiling' );
    const within = await runWith( [ '--tool-ceiling', 'mcp__blueprint Read Glob Grep Bash', '--design-tools', 'Bash' ] );
    expect( [ within.r.code, within.builtIn, within.report ] ).toEqual( [ 0, 'Read,Glob,Grep,Bash', [ 'done' ] ] );
  }, 40_000 );

  // The startup check holds the grant to the ceiling as a job's tools are (withinCeiling): an MCP server entry
  // admits that server's tools, and no other server's.
  it( 'a grant of an MCP server\'s tool under a --tool-ceiling naming that server runs; one of another server exits 1', async () => {
    const within = await runWith( [ '--tool-ceiling', 'mcp__blueprint Read Glob Grep', '--design-tools', 'mcp__blueprint__get_design' ] );
    expect( [ within.r.code, within.report, within.allowed.split( ' ' ).includes( 'mcp__blueprint__get_design' ) ] ).toEqual( [ 0, [ 'done' ], true ] );
    const other = await runWith( [ '--tool-ceiling', 'mcp__blueprint Read Glob Grep', '--design-tools', 'mcp__blueprint_repo__git_log' ] );
    expect( [ other.r.code, other.requests ] ).toEqual( [ 1, 0 ] );
    expect( other.r.stderr ).toContain( '--design-tools grants mcp__blueprint_repo__git_log, beyond this Steward\'s --tool-ceiling' );
  }, 40_000 );

  it( '--design-writes forbid exits 1 on a granted tool that writes, scoped or bare, and runs a grant that does not', async () => {
    for ( const tool of [ 'Bash', 'Bash(git *)', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit' ] ) {
      const refused = await runWith( [ '--design-writes', 'forbid', '--design-tools', `Skill ${ tool }` ] );
      expect( [ tool, refused.r.code, refused.requests ] ).toEqual( [ tool, 1, 0 ] );
      expect( refused.r.stderr ).toContain( `--design-writes forbid, but --design-tools grants ${ tool }` );
    }
    const readOnly = await runWith( [ '--design-writes', 'forbid', '--design-tools', 'Skill' ], { env: { BLUEPRINT_STEWARD_DESIGN_WRITES: 'allow' } } );
    expect( [ readOnly.r.code, readOnly.builtIn, readOnly.report ] ).toEqual( [ 0, 'Read,Glob,Grep,Skill', [ 'done' ] ] );
    // The environment sets it when the flag does not.
    const fromEnv = await runWith( [ '--design-tools', 'Bash' ], { env: { BLUEPRINT_STEWARD_DESIGN_WRITES: 'forbid' } } );
    expect( fromEnv.r.code ).toBe( 1 );
  }, 60_000 );

  it( 'an empty --design-tools, or a --design-writes other than allow or forbid, exits 1 before any claim', async () => {
    for ( const rest of [ [ '--design-tools', '' ], [ '--design-tools', ' , ' ], [ '--design-tools', '--once' ], [ '--design-writes', 'maybe' ] ] ) {
      const refused = await runWith( rest );
      expect( [ rest, refused.r.code, refused.requests ] ).toEqual( [ rest, 1, 0 ] );
    }
    const envBlankList = await runWith( [], { env: { BLUEPRINT_STEWARD_DESIGN_TOOLS: ' , ' } } );
    expect( [ envBlankList.r.code, envBlankList.r.stderr.includes( '--design-tools needs a tool list' ) ] ).toEqual( [ 1, true ] );
  }, 40_000 );

  it( 'what the agent leaves in the session\'s worktree is logged with its path, and a clean run logs nothing', async () => {
    const dirty = await runWith( [ '--design-tools', 'Write' ], { leave: 'scratch-notes.md' } );
    expect( dirty.report ).toEqual( [ 'done' ] );
    expect( dirty.r.stdout ).toMatch( /the agent left 1 changed path in .*sess-jd; the session's next job discards tracked changes, untracked files stay:\n {2}\?\? scratch-notes\.md/ );
    const clean = await runWith( [ '--design-tools', 'Write' ] );
    expect( clean.r.stdout ).not.toContain( 'the agent left' );
  }, 40_000 );
} );

// Steward works up to --concurrency
// sessions at once, each in its own git worktree of the job's branch, leaving the --repo checkout untouched; a
// drop-worktree job removes a session's worktree, never while an agent runs in it, and the next job recreates it.
describe( 'blueprint-steward start: per-session worktrees', () => {
  const SERVED = { text: 'Served hosted-turn text.', version: 1, sha256: 'c'.repeat( 64 ) };
  const TOOLS = { tools: [ 'mcp__blueprint', 'Read' ], disallowedTools: [ 'mcp__blueprint__start_map_session' ] };
  const design = ( id: string, sessionId: string, branch: string | null ) =>
    ( { id, kind: 'design', sessionId, branch, prompt: null, jobKey: `bpjk_minted-for-${ id }`, instructions: SERVED, method: METHOD, ...TOOLS } );
  const drop = ( id: string, sessionId: string ) => ( { id, kind: 'drop-worktree', sessionId, branch: null, prompt: null } );
  const sh = ( cmd: string, cwd: string ) => execSync( cmd, { cwd, encoding: 'utf-8' } ).trim();
  // Bounds a run Steward does not end on its own (these start without --once), so a RED fails by assertion.
  const deadline = ( ms: number ) => {
    const start = Date.now();
    return () => Date.now() - start > ms;
  };

  type Report = { id: string; body: any; at: number; worktreeExists: Record<string, boolean> };
  // Hands out `queue` one job per claim, then no job. Like the host, a claim is handed only a job of a kind it names
  // (Steward's reads-only claim names observability-read alone). Every report is recorded with, at the
  // moment it arrived, whether each watched worktree existed.
  const queueHost = async ( queue: Array<Record<string, unknown>>, watch: Record<string, string> = {} ) => {
    const reported: Report[] = [];
    const claimed: Array<{ id: string; at: number }> = [];
    const host = await fakeHost( ( req ) => {
      if ( req.url === '/api/blueprint/steward/claim' ) {
        const kinds: unknown[] | undefined = req.body?.kinds;
        const at = queue.findIndex( ( queued ) => kinds === undefined || kinds.includes( queued.kind ) );
        // Git is async now, so a job that needs an earlier job's worktree waits (`waitFor`) until it exists.
        const waitFor = queue[ at ]?.waitFor;
        const job = at < 0 || ( typeof waitFor === 'string' && !existsSync( waitFor ) ) ? null : queue.splice( at, 1 )[ 0 ];
        if ( job ) claimed.push( { id: String( job.id ), at: Date.now() } );
        return { body: { job } };
      }
      const report = req.url.match( /^\/api\/blueprint\/steward\/jobs\/([^/]+)$/ );
      if ( report ) {
        reported.push( { id: report[ 1 ], body: req.body, at: Date.now(), worktreeExists: Object.fromEntries( Object.entries( watch ).map( ( [ name, dir ] ) => [ name, existsSync( dir ) ] ) ) } );
      }
      return {};
    } );
    return { ...host, reported, claimed };
  };

  type AgentRecord = { session: string; cwd: string; head: string; repoPath: string; pid: number; start: number; end: number; sawOther: boolean };
  // A fake claude that records where it ran and when. `meet`: it waits (up to waitMs) for another session's agent
  // to be running at the same time, so two runs overlap only if Steward started them concurrently. `release`: it
  // runs until the named file exists (up to waitMs).
  const makeSessionClaude = ( mode: { meet: number } | { release: string; waitMs: number } ) => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const records = join( dir, 'records' );
    const running = join( dir, 'running' );
    mkdirSync( records );
    mkdirSync( running );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const env = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf-8')).mcpServers.blueprint.env;
const session = env.BLUEPRINT_SESSION_ID;
${ printInit }
const mode = ${ JSON.stringify( mode ) };
const start = Date.now();
const mark = join(${ JSON.stringify( running ) }, session);
writeFileSync(mark, '');
let sawOther = false;
const done = () => {
  rmSync(mark, { force: true });
  writeFileSync(join(${ JSON.stringify( records ) }, session + '-' + start + '-' + process.pid + '.json'), JSON.stringify({
    session, cwd: process.cwd(), head: execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(), repoPath: env.BLUEPRINT_REPO_PATH,
    pid: process.pid, start, end: Date.now(), sawOther }));
  console.log('agent ' + session + ' done');
  process.exit(0);
};
const tick = () => {
  if ('meet' in mode) {
    if (readdirSync(${ JSON.stringify( running ) }).some((name) => name !== session)) { sawOther = true; setTimeout(done, 300); return; }
    if (Date.now() - start > mode.meet) { done(); return; }
  } else {
    if (existsSync(mode.release) || Date.now() - start > mode.waitMs) { done(); return; }
  }
  setTimeout(tick, 25);
};
tick();
` );
    execSync( `chmod +x ${ script }` );
    const read = (): AgentRecord[] => readdirSync( records ).map( ( name ) => JSON.parse( readFileSync( join( records, name ), 'utf-8' ) ) as AgentRecord )
      .sort( ( a, b ) => a.start - b.start );
    return { script, read };
  };

  const headOf = ( repo: string ) => ( { ref: sh( 'git symbolic-ref HEAD', repo ), sha: sh( 'git rev-parse HEAD', repo ), status: sh( 'git status --porcelain', repo ) } );
  const worktreesOf = ( repo: string ) => sh( 'git worktree list --porcelain', repo ).split( '\n' )
    .filter( ( line ) => line.startsWith( 'worktree ' ) ).map( ( line ) => realDir( line.slice( 'worktree '.length ) ) );

  it( 'with --concurrency 2 and session A\'s agent running, B is claimed into its own worktree while A runs, and the --repo HEAD is unchanged', async () => {
    // GIVEN
    const repo = makeRepo();
    const before = headOf( repo );
    const host = await queueHost( [ design( 'ja', 'sess-a', 'feature' ), design( 'jb', 'sess-b', 'main' ) ] );
    const claude = makeSessionClaude( { meet: 4000 } );

    // WHEN
    const stop = deadline( 15_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '2', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => host.reported.length >= 2 || stop() } );

    // THEN
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ).sort() ).toEqual( [ [ 'ja', 'done' ], [ 'jb', 'done' ] ] );
    // Picked by session: with both running at once, B's agent may start before A's.
    const records = claude.read();
    const a = records.find( ( r ) => r.session === 'sess-a' )!;
    const b = records.find( ( r ) => r.session === 'sess-b' )!;
    expect( records.map( ( r ) => r.session ).sort() ).toEqual( [ 'sess-a', 'sess-b' ] );
    // Each agent ran in its own session's worktree, at its job's branch.
    expect( [ realDir( a.cwd ), realDir( b.cwd ) ] ).toEqual( [ realDir( worktreeOf( repo, 'sess-a' ) ), realDir( worktreeOf( repo, 'sess-b' ) ) ] );
    expect( [ realDir( a.repoPath ), realDir( b.repoPath ) ] ).toEqual( [ realDir( a.cwd ), realDir( b.cwd ) ] );
    expect( [ a.head, b.head ] ).toEqual( [ sh( 'git rev-parse feature', repo ), sh( 'git rev-parse origin/main', repo ) ] );
    // The two agents ran at the same time: each saw the other running, and each started before the other ended.
    expect( [ a.sawOther, b.sawOther, b.start < a.end, a.start < b.end ] ).toEqual( [ true, true, true, true ] );
    // The operator's checkout never moved, and both worktrees are registered with it.
    expect( headOf( repo ) ).toEqual( before );
    expect( worktreesOf( repo ) ).toEqual( [ realDir( repo ), realDir( worktreeOf( repo, 'sess-a' ) ), realDir( worktreeOf( repo, 'sess-b' ) ) ] );
    // No install ran: this extraction needs none, so the worktree has no node_modules.
    expect( existsSync( join( worktreeOf( repo, 'sess-a' ), 'node_modules' ) ) ).toBe( false );
  }, 30_000 );

  it( 'with --concurrency 1 the second session waits for the first: the two agents never overlap (the control for the test above)', async () => {
    const repo = makeRepo();
    const host = await queueHost( [ design( 'ja', 'sess-a', 'feature' ), design( 'jb', 'sess-b', 'main' ) ] );
    const claude = makeSessionClaude( { meet: 1200 } );
    const stop = deadline( 15_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '1', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => host.reported.length >= 2 || stop() } );
    const [ a, b ] = claude.read();
    expect( [ a.sawOther, b.start >= a.end ] ).toEqual( [ false, true ] );
  }, 30_000 );

  // The --concurrency usage line: "Two design jobs of one session never run at once: the later one waits for the
  // earlier." Both jobs are handed out back to back while the first agent is still held, so only Steward's own
  // per-session wait keeps them apart.
  it( 'with --concurrency 2, a session\'s second design job, claimed while its first agent runs, starts only after that agent ends', async () => {
    const repo = makeRepo();
    const host = await queueHost( [ design( 'j1', 'sess-a', 'feature' ), design( 'j2', 'sess-a', 'feature' ) ] );
    // Nothing writes the release file: each agent is held for its whole 1500 ms.
    const claude = makeSessionClaude( { release: join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-release-' ) ), 'never' ), waitMs: 1500 } );
    const stop = deadline( 15_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '2', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => host.reported.length >= 2 || stop() } );
    const [ first, second ] = claude.read();
    // Both jobs were claimed before the first agent ended: Steward held the second, not the host.
    expect( [ host.claimed.map( ( c ) => c.id ), host.claimed.every( ( c ) => c.at < first.end ) ] ).toEqual( [ [ 'j1', 'j2' ], true ] );
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ).sort() ).toEqual( [ [ 'j1', 'done' ], [ 'j2', 'done' ] ] );
    // The later agent started only once the earlier one had ended.
    expect( [ first.session, second.session, second.start >= first.end ] ).toEqual( [ 'sess-a', 'sess-a', true ] );
  }, 30_000 );

  // Reads do not wait behind the cap. With the one slot held by a design agent Steward still claims,
  // naming observability-read alone, and the read of that same session runs outside its lane and is reported while
  // the agent still runs.
  it( 'with --concurrency 1 and the slot held by a design agent, a queued observability-read job of that session is claimed by a reads-only claim and reported while the agent still runs', async () => {
    // GIVEN
    const repo = makeRepo();
    const read = { id: 'jr', kind: 'observability-read', sessionId: 'sess-a', branch: null, prompt: null, payload: { op: 'search', text: 'checkout' } };
    const host = await queueHost( [ design( 'ja', 'sess-a', 'feature' ), read ] );
    const release = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-release-' ) ), 'release' );
    const claude = makeSessionClaude( { release, waitMs: 10_000 } );
    const stop = deadline( 20_000 );

    // WHEN: the agent is released only once the read is reported (or at its own 10 s bound).
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '1', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => {
        if ( host.reported.some( ( r ) => r.id === 'jr' ) && !existsSync( release ) ) writeFileSync( release, '' );
        return host.reported.length >= 2 || stop();
      } } );

    // THEN
    const [ agent ] = claude.read();
    const readReport = host.reported.find( ( r ) => r.id === 'jr' );
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ) ).toEqual( [ [ 'jr', 'done' ], [ 'ja', 'done' ] ] );
    expect( JSON.parse( readReport!.body.result ) ).toEqual( { status: 'not-declared' } );
    expect( readReport!.at < agent.end ).toBe( true );
    const claims = host.requests.filter( ( q ) => q.url === '/api/blueprint/steward/claim' );
    expect( claims[ 1 ].body.kinds ).toEqual( [ 'observability-read' ] );
  }, 40_000 );

  it( 'the default concurrency is 4: four sessions\' agents run at once', async () => {
    const repo = makeRepo();
    const sessions = [ 'sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-5' ];
    const host = await queueHost( sessions.map( ( session, i ) => design( `j${ i }`, session, 'main' ) ) );
    const claude = makeSessionClaude( { meet: 1500 } );
    const stop = deadline( 20_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => host.reported.length >= 5 || stop() } );
    const records = claude.read();
    // The first four start before any of them ends; the fifth only after one of them ended.
    const firstEnd = Math.min( ...records.slice( 0, 4 ).map( ( r ) => r.end ) );
    expect( [ records.length, records.slice( 0, 4 ).every( ( r ) => r.start < firstEnd ), records[ 4 ].start >= firstEnd ] ).toEqual( [ 5, true, true ] );
  }, 40_000 );

  it( 'a drop-worktree job removes the idle session\'s worktree and the next job recreates it', async () => {
    // GIVEN: session A's first job leaves its worktree behind.
    const repo = makeRepo();
    const wt = worktreeOf( repo, 'sess-a' );
    const host = await queueHost( [ design( 'j1', 'sess-a', 'feature' ), drop( 'jd', 'sess-a' ), design( 'j2', 'sess-a', 'feature' ) ], { a: wt } );
    const claude = makeSessionClaude( { meet: 0 } );

    // WHEN
    const stop = deadline( 15_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '1', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => host.reported.length >= 3 || stop() } );

    // THEN
    expect( host.reported.map( ( r ) => [ r.id, r.body.status, r.worktreeExists.a ] ) ).toEqual( [ [ 'j1', 'done', true ], [ 'jd', 'done', false ], [ 'j2', 'done', true ] ] );
    // The drop unregistered the worktree too, and the next job's agent ran in the recreated one.
    const [ first, second ] = claude.read();
    expect( [ realDir( first.cwd ), realDir( second.cwd ) ] ).toEqual( [ realDir( wt ), realDir( wt ) ] );
    expect( worktreesOf( repo ) ).toEqual( [ realDir( repo ), realDir( wt ) ] );
  }, 30_000 );

  it( 'a drop-worktree job for a session with no worktree reports done and touches nothing', async () => {
    const repo = makeRepo();
    const before = headOf( repo );
    const host = await queueHost( [ drop( 'jd', 'sess-none' ) ] );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ] );
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ) ).toEqual( [ [ 'jd', 'done' ] ] );
    expect( host.reported[ 0 ].body.result ).toContain( 'no worktree' );
    expect( [ headOf( repo ), worktreesOf( repo ) ] ).toEqual( [ before, [ realDir( repo ) ] ] );
  } );

  it( 'a drop-worktree job for a session whose agent is running leaves its worktree, and the agent runs to its own exit', async () => {
    // GIVEN: session A's agent runs until released.
    const repo = makeRepo();
    const wt = worktreeOf( repo, 'sess-a' );
    const release = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-release-' ) ), 'go' );
    const host = await queueHost( [ design( 'j1', 'sess-a', 'feature' ), { ...drop( 'jd', 'sess-a' ), waitFor: wt } ], { a: wt } );
    const claude = makeSessionClaude( { release, waitMs: 10_000 } );

    // WHEN: the drop is claimed while the agent runs; the agent is released only once the drop was reported.
    const stop = deadline( 20_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '2', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => {
        if ( host.reported.some( ( r ) => r.id === 'jd' ) && !existsSync( release ) ) writeFileSync( release, '' );
        return host.reported.length >= 2 || stop();
      } } );

    // THEN
    expect( host.reported.map( ( r ) => [ r.id, r.body.status, r.worktreeExists.a ] ) ).toEqual( [ [ 'jd', 'done', true ], [ 'j1', 'done', true ] ] );
    expect( host.reported[ 0 ].body.result ).toContain( 'in use' );
    const [ agent ] = claude.read();
    // The agent ended after the drop was reported: it was running, in the worktree, when the drop came.
    expect( [ realDir( agent.cwd ), agent.end > host.reported[ 0 ].at ] ).toEqual( [ realDir( wt ), true ] );
    expect( existsSync( wt ) ).toBe( true );
  }, 30_000 );

  it( 'a job whose branch cannot be checked out reports failed checkout-failed, never runs the agent, and leaves the --repo HEAD alone', async () => {
    // Unique per run: a directory left in the OS tmpdir by an earlier run can never satisfy, or fail, this one.
    const escape = `escape-${ process.pid }-${ Date.now() }`;
    for ( const [ job, why ] of [
      [ design( 'jx', 'sess-x', 'no-such-branch' ), 'no-such-branch' ],
      // A session id that is not one path segment never names a directory outside the worktree root.
      [ design( 'jy', `../${ escape }`, 'main' ), `../${ escape }` ],
    ] as const ) {
      const repo = makeRepo();
      const before = headOf( repo );
      const host = await queueHost( [ job ] );
      const claude = makeFakeClaude( 0 );
      await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
      expect( [ why, host.reported.map( ( r ) => [ r.body.status, r.body.reason ] ) ] ).toEqual( [ why, [ [ 'failed', 'checkout-failed' ] ] ] );
      expect( host.requests.some( ( q ) => q.url === '/api/blueprint/reality' ) ).toBe( false );
      expect( existsSync( claude.record ) ).toBe( false );
      expect( [ headOf( repo ), worktreesOf( repo ) ] ).toEqual( [ before, [ realDir( repo ) ] ] );
      expect( existsSync( join( repo, '..', escape ) ) ).toBe( false );
    }
  } );

  it( 'a reused worktree is moved to the job\'s branch as the remote now has it', async () => {
    const repo = makeRepo();
    const wt = worktreeOf( repo, 'sess-a' );
    const host = await queueHost( [ design( 'j1', 'sess-a', 'main' ) ] );
    const claude = makeSessionClaude( { meet: 0 } );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    // main moves on at the remote (another clone pushes), then the session's next job runs.
    const other = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-clone-' ) );
    sh( `git clone -q -b main ${ sh( 'git remote get-url origin', repo ) } ${ other }`, tmpdir() );
    sh( 'echo n > next.txt && git -c user.email=t@t -c user.name=t add next.txt && git -c user.email=t@t -c user.name=t commit -qm next && git push -q origin main', other );
    const host2 = await queueHost( [ design( 'j2', 'sess-a', 'main' ) ] );
    await run( [ 'start', '--server', host2.url, '--token', 'tok', '--repo', repo, '--once' ], { BLUEPRINT_STEWARD_CLAUDE: claude.script } );
    const [ first, second ] = claude.read();
    expect( [ realDir( first.cwd ), realDir( second.cwd ) ] ).toEqual( [ realDir( wt ), realDir( wt ) ] );
    expect( second.head ).toBe( sh( 'git rev-parse HEAD', other ) );
    expect( first.head ).not.toBe( second.head );
    expect( sh( 'git rev-parse main', repo ) ).toBe( first.head );
  } );

  // No install unless extraction cannot run without one. A yarn project whose
  // extraction fails in a worktree with no node_modules gets one `yarn install --immutable --mode=skip-build` there,
  // and the extraction is retried; the yarn on PATH is a fake that records its calls.
  it( 'an extraction that fails in a yarn worktree without node_modules installs once (skip-build) and is retried; one that runs needs none', async () => {
    const G = '-c user.email=t@t -c user.name=t';
    const fakeYarn = () => {
      const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-yarn-' ) );
      const calls = join( dir, 'calls.log' );
      writeFileSync( join( dir, 'yarn' ), `#!/bin/sh\necho "$(pwd -P) $*" >> ${ calls }\nmkdir -p node_modules\n` );
      execSync( `chmod +x ${ join( dir, 'yarn' ) }` );
      return { dir, calls: () => ( existsSync( calls ) ? readFileSync( calls, 'utf-8' ).trim().split( '\n' ) : [] ) };
    };
    for ( const [ extract, installs ] of [
      [ 'test -d node_modules && mkdir -p .blueprint && echo \'{"nodes":[]}\' > .blueprint/graph.json', 1 ],
      [ 'mkdir -p .blueprint && echo \'{"nodes":[]}\' > .blueprint/graph.json', 0 ],
    ] as const ) {
      const repo = makeRepo( extract );
      sh( `touch yarn.lock && git ${ G } add yarn.lock && git ${ G } commit -qm lock && git push -q origin main`, repo );
      const yarn = fakeYarn();
      const host = await queueHost( [ design( 'j1', 'sess-y', 'main' ) ] );
      await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ],
        { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, PATH: `${ yarn.dir }:${ process.env.PATH }` } );
      const wt = realDir( worktreeOf( repo, 'sess-y' ) );
      expect( [ installs, host.reported.map( ( r ) => r.body.status ) ] ).toEqual( [ installs, [ 'done' ] ] );
      expect( yarn.calls() ).toEqual( installs === 1 ? [ `${ wt } install --immutable --mode=skip-build` ] : [] );
    }
  } );

  // The same for a pnpm project: a pnpm-lock.yaml selects
  // `pnpm install --frozen-lockfile --ignore-scripts`; the pnpm on PATH is a fake that records its calls.
  it( 'an extraction that fails in a pnpm worktree without node_modules installs once (ignore-scripts) and is retried', async () => {
    const G = '-c user.email=t@t -c user.name=t';
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-pnpm-' ) );
    const calls = join( dir, 'calls.log' );
    writeFileSync( join( dir, 'pnpm' ), `#!/bin/sh\necho "$(pwd -P) $*" >> ${ calls }\nmkdir -p node_modules\n` );
    execSync( `chmod +x ${ join( dir, 'pnpm' ) }` );
    const repo = makeRepo( 'test -d node_modules && mkdir -p .blueprint && echo \'{"nodes":[]}\' > .blueprint/graph.json' );
    sh( `touch pnpm-lock.yaml && git ${ G } add pnpm-lock.yaml && git ${ G } commit -qm lock && git push -q origin main`, repo );
    const host = await queueHost( [ design( 'j1', 'sess-p', 'main' ) ] );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ],
      { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, PATH: `${ dir }:${ process.env.PATH }` } );
    const wt = realDir( worktreeOf( repo, 'sess-p' ) );
    expect( host.reported.map( ( r ) => r.body.status ) ).toEqual( [ 'done' ] );
    expect( readFileSync( calls, 'utf-8' ).trim().split( '\n' ) ).toEqual( [ `${ wt } install --frozen-lockfile --ignore-scripts` ] );
  } );

  // A worktree's node_modules outlives the lockfile it was installed from: the branch moves under it between jobs.
  // One installed from another lockfile, or by no install of the runner's (no stamp), is installed again before
  // extracting; one installed from the lockfile it now holds is not.
  it( 'a pnpm worktree whose node_modules was installed from another lockfile, or carries no stamp, installs again before extracting', async () => {
    const G = '-c user.email=t@t -c user.name=t';
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-pnpm-' ) );
    const calls = join( dir, 'calls.log' );
    writeFileSync( join( dir, 'pnpm' ), `#!/bin/sh\necho "$(pwd -P) $*" >> ${ calls }\nmkdir -p node_modules\n` );
    execSync( `chmod +x ${ join( dir, 'pnpm' ) }` );
    const callsSoFar = () => ( existsSync( calls ) ? readFileSync( calls, 'utf-8' ).trim().split( '\n' ) : [] );
    const repo = makeRepo( 'mkdir -p .blueprint && echo \'{"nodes":[]}\' > .blueprint/graph.json' );
    sh( `echo v1 > pnpm-lock.yaml && git ${ G } add pnpm-lock.yaml && git ${ G } commit -qm lock && git push -q origin main`, repo );
    const env = { BLUEPRINT_STEWARD_CLAUDE: makeFakeClaude( 0 ).script, PATH: `${ dir }:${ process.env.PATH }` };
    const runJob = async ( id: string ) => {
      const host = await queueHost( [ design( id, 'sess-l', 'main' ) ] );
      await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], env );
      return host.reported.map( ( r ) => r.body.status );
    };

    // The first job extracts without an install; the runner then finds a node_modules no install of its own made.
    expect( await runJob( 'j1' ) ).toEqual( [ 'done' ] );
    expect( callsSoFar() ).toEqual( [] );
    const wt = realDir( worktreeOf( repo, 'sess-l' ) );
    mkdirSync( join( wt, 'node_modules' ) );
    expect( await runJob( 'j2' ) ).toEqual( [ 'done' ] );
    expect( callsSoFar() ).toEqual( [ `${ wt } install --frozen-lockfile --ignore-scripts` ] );

    // Installed from the lockfile it holds: no install.
    expect( await runJob( 'j3' ) ).toEqual( [ 'done' ] );
    expect( callsSoFar() ).toHaveLength( 1 );

    // The branch moves to a new lockfile: one install.
    sh( `echo v2 > pnpm-lock.yaml && git ${ G } commit -qam lock2 && git push -q origin main`, repo );
    expect( await runJob( 'j4' ) ).toEqual( [ 'done' ] );
    expect( callsSoFar() ).toEqual( [ `${ wt } install --frozen-lockfile --ignore-scripts`, `${ wt } install --frozen-lockfile --ignore-scripts` ] );
  } );

  // Blueprint ADR-137: a session's worktree lock. A design round's checkout and extraction hold it exclusively;
  // reply jobs, and the round's agent once its extraction is pushed, hold it shared; a flush holds it exclusively.
  // All of it within --concurrency.
  const reply = ( id: string, sessionId: string, branch: string | null ) => ( { ...design( id, sessionId, branch ), kind: 'reply' } );
  type JobRecord = { job: string; cwd: string; head: string; start: number; end: number; sawOther: boolean };
  // A fake claude that records, per job (read off its job key), where it ran, when, and whether it saw the job it
  // waits for running. Each job's `hold`: it runs until the `release` file exists, or until `meet` (another job id) has
  // been seen running, or for `waitMs` at most. A job with no entry ends at once.
  const makeJobClaude = ( hold: Record<string, { release?: string; meet?: string; waitMs: number }> ) => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-claude-' ) );
    const records = join( dir, 'records' );
    const running = join( dir, 'running' );
    mkdirSync( records );
    mkdirSync( running );
    const script = join( dir, 'claude.mjs' );
    writeFileSync( script, `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const env = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf-8')).mcpServers.blueprint.env;
const job = env.BLUEPRINT_ACCESS_TOKEN.replace('bpjk_minted-for-', '');
${ printInit }
const hold = ${ JSON.stringify( hold ) }[job] ?? { waitMs: 0 };
const start = Date.now();
writeFileSync(join(${ JSON.stringify( running ) }, job), '');
let sawOther = false;
const done = () => {
  rmSync(join(${ JSON.stringify( running ) }, job), { force: true });
  writeFileSync(join(${ JSON.stringify( records ) }, job + '.json'), JSON.stringify({
    job, cwd: process.cwd(), head: execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(), start, end: Date.now(), sawOther }));
  console.log('agent ' + job + ' done');
  process.exit(0);
};
const tick = () => {
  if (hold.meet && existsSync(join(${ JSON.stringify( running ) }, hold.meet))) sawOther = true;
  if (sawOther || (hold.release && existsSync(hold.release)) || Date.now() - start >= hold.waitMs) { setTimeout(done, sawOther ? 300 : 0); return; }
  setTimeout(tick, 25);
};
tick();
` );
    chmodSync( script, 0o755 );
    const read = ( job: string ): JobRecord | undefined => ( existsSync( join( records, `${ job }.json` ) ) ? JSON.parse( readFileSync( join( records, `${ job }.json` ), 'utf-8' ) ) : undefined );
    return { script, read, runningMark: ( job: string ) => join( running, job ) };
  };

  it( 'Parallel: given a design round is past its extraction, when two reply jobs are claimed for the session, then both agents run while the round runs', async () => {
    // GIVEN: the round's agent runs until released; both replies are handed out only once it runs.
    const repo = makeRepo();
    const release = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-release-' ) ), 'go' );
    const claude = makeJobClaude( { jd: { release, waitMs: 20_000 }, jr1: { meet: 'jr2', waitMs: 6000 }, jr2: { meet: 'jr1', waitMs: 6000 } } );
    const host = await queueHost( [
      design( 'jd', 'sess-a', 'feature' ),
      { ...reply( 'jr1', 'sess-a', 'feature' ), waitFor: claude.runningMark( 'jd' ) },
      { ...reply( 'jr2', 'sess-a', 'feature' ), waitFor: claude.runningMark( 'jd' ) },
      // gate: a drop-worktree claimed while the replies hold the session leaves the worktree.
      { ...drop( 'jx', 'sess-a' ), waitFor: claude.runningMark( 'jr1' ) },
    ] );

    // WHEN: the round's agent is released once both replies were reported (or at its own 20 s bound).
    const stop = deadline( 40_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '4', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => {
        if ( [ 'jr1', 'jr2' ].every( ( id ) => host.reported.some( ( r ) => r.id === id ) ) && !existsSync( release ) ) writeFileSync( release, '' );
        return host.reported.length >= 4 || stop();
      } } );

    // THEN
    const [ jd, jr1, jr2 ] = [ claude.read( 'jd' )!, claude.read( 'jr1' )!, claude.read( 'jr2' )! ];
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ).sort() ).toEqual( [ [ 'jd', 'done' ], [ 'jr1', 'done' ], [ 'jr2', 'done' ], [ 'jx', 'done' ] ] );
    // The two replies ran at once: each saw the other running, and each started before the other ended.
    expect( [ jr1.sawOther, jr2.sawOther, jr1.start < jr2.end, jr2.start < jr1.end ] ).toEqual( [ true, true, true, true ] );
    // Both ran while the round's agent ran, in the session's one worktree, and were reported before it.
    expect( [ jd.start < jr1.start, jd.start < jr2.start, jr1.end < jd.end, jr2.end < jd.end ] ).toEqual( [ true, true, true, true ] );
    expect( [ jd.cwd, jr1.cwd, jr2.cwd ].map( realDir ) ).toEqual( Array( 3 ).fill( realDir( worktreeOf( repo, 'sess-a' ) ) ) );
    expect( host.reported.at( -1 )!.id ).toBe( 'jd' );
    const dropped = host.reported.find( ( r ) => r.id === 'jx' )!;
    expect( [ dropped.body.result.includes( 'in use' ), existsSync( worktreeOf( repo, 'sess-a' ) ) ] ).toEqual( [ true, true ] );
  }, 60_000 );

  it( 'Extraction: given a design round is checking out and extracting, when a reply job is claimed, then the reply waits until the extraction ends', async () => {
    // GIVEN: the round's extraction marks that it began, then blocks on a gate file, then stamps when it ended.
    const marks = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-extract-' ) );
    const [ began, gate, ended ] = [ 'began', 'gate', 'ended' ].map( ( name ) => join( marks, name ) );
    const extract = `touch ${ began } && while [ ! -f ${ gate } ]; do sleep 0.05; done && "${ process.execPath }" -e "require('fs').writeFileSync('${ ended }', String(Date.now()))"`
      + ' && mkdir -p .blueprint && echo \'{"nodes":[1]}\' > .blueprint/graph.json';
    const repo = makeRepo( extract );
    const claude = makeJobClaude( {} );
    const host = await queueHost( [ design( 'jd', 'sess-a', 'feature' ), { ...reply( 'jr', 'sess-a', 'feature' ), waitFor: began } ] );

    // WHEN: the gate opens once the reply's agent started (a reply that did not wait), or 3 s after it was claimed.
    const stop = deadline( 40_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '2', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => {
        const claimed = host.claimed.find( ( c ) => c.id === 'jr' );
        if ( claimed && !existsSync( gate ) && ( claude.read( 'jr' ) !== undefined || Date.now() - claimed.at > 3000 ) ) writeFileSync( gate, '' );
        return host.reported.length >= 2 || stop();
      } } );

    // THEN
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ).sort() ).toEqual( [ [ 'jd', 'done' ], [ 'jr', 'done' ] ] );
    const extractionEnd = Number( readFileSync( ended, 'utf-8' ) );
    const jr = claude.read( 'jr' )!;
    // The reply was claimed while the round extracted, and its agent started only after the extraction ended.
    expect( [ host.claimed.find( ( c ) => c.id === 'jr' )!.at < extractionEnd, jr.start >= extractionEnd ] ).toEqual( [ true, true ] );
  }, 60_000 );

  it( 'a reply claimed while a design round waits for the worktree behind another reply waits its turn: it never starts beside the first reply', async () => {
    // GIVEN: reply 1 runs until released; the round is claimed while it runs (and waits to check out), then reply 2.
    const repo = makeRepo();
    const release = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-release-' ) ), 'go' );
    const claude = makeJobClaude( { jr1: { release, waitMs: 20_000 } } );
    const host = await queueHost( [
      reply( 'jr1', 'sess-a', 'feature' ),
      { ...design( 'jd', 'sess-a', 'feature' ), waitFor: claude.runningMark( 'jr1' ) },
      { ...reply( 'jr2', 'sess-a', 'feature' ), waitFor: claude.runningMark( 'jr1' ) },
    ] );
    // WHEN: reply 1 is released once reply 2's agent started (a reply that jumped the round), or 3 s after it was claimed.
    const stop = deadline( 40_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '3', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => {
        const claimed = host.claimed.find( ( c ) => c.id === 'jr2' );
        if ( claimed && !existsSync( release ) && ( claude.read( 'jr2' ) !== undefined || existsSync( claude.runningMark( 'jr2' ) ) || Date.now() - claimed.at > 3000 ) ) writeFileSync( release, '' );
        return host.reported.length >= 3 || stop();
      } } );
    // THEN
    const [ jr1, jd, jr2 ] = [ claude.read( 'jr1' )!, claude.read( 'jd' )!, claude.read( 'jr2' )! ];
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ).sort() ).toEqual( [ [ 'jd', 'done' ], [ 'jr1', 'done' ], [ 'jr2', 'done' ] ] );
    expect( [ host.claimed.map( ( c ) => c.id ), host.claimed.every( ( c ) => c.at < jr1.end ), jd.start >= jr1.end, jr2.start >= jr1.end ] )
      .toEqual( [ [ 'jr1', 'jd', 'jr2' ], true, true, true ] );
  }, 60_000 );

  it( 'a reply whose session worktree is at another branch\'s tip waits for the worktree exclusively and moves it to its own branch', async () => {
    const repo = makeRepo();
    const claude = makeJobClaude( {} );
    const host = await queueHost( [ design( 'jd', 'sess-a', 'main' ), { ...reply( 'jr', 'sess-a', 'feature' ), waitFor: join( worktreeOf( repo, 'sess-a' ), '.blueprint', 'graph.json' ) } ] );
    const stop = deadline( 30_000 );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '1', '--interval', '0.05', '--merge-poll', '600' ],
      { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => host.reported.length >= 2 || stop() } );
    expect( host.reported.map( ( r ) => [ r.id, r.body.status ] ) ).toEqual( [ [ 'jd', 'done' ], [ 'jr', 'done' ] ] );
    expect( [ claude.read( 'jd' )!.head, claude.read( 'jr' )!.head ] ).toEqual( [ sh( 'git rev-parse origin/main', repo ), sh( 'git rev-parse feature', repo ) ] );
  }, 40_000 );

  it( 'gate: a flush or a scaffold claimed while a reply of its session runs waits for the reply to end (each holds the worktree exclusively)', async () => {
    for ( const kind of [ 'flush', 'scaffold' ] ) {
      const repo = makeRepo();
      const release = join( mkdtempSync( join( tmpdir(), 'blueprint-steward-test-release-' ) ), 'go' );
      const claude = makeJobClaude( { jr: { release, waitMs: 20_000 } } );
      const exclusive = { id: 'jx', kind, sessionId: 'sess-a', branch: 'feature', prompt: null, payload: {}, waitFor: claude.runningMark( 'jr' ) };
      const host = await queueHost( [ reply( 'jr', 'sess-a', 'feature' ), exclusive ] );
      // The reply is released once the job was reported (one that did not wait), or 3 s after it was claimed.
      const stop = deadline( 40_000 );
      await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--concurrency', '2', '--interval', '0.05', '--merge-poll', '600' ],
        { BLUEPRINT_STEWARD_CLAUDE: claude.script }, { killWhen: () => {
          const claimed = host.claimed.find( ( c ) => c.id === 'jx' );
          if ( claimed && !existsSync( release ) && ( host.reported.some( ( r ) => r.id === 'jx' ) || Date.now() - claimed.at > 3000 ) ) writeFileSync( release, '' );
          return host.reported.length >= 2 || stop();
        } } );
      const jr = claude.read( 'jr' )!;
      const reported = host.reported.find( ( r ) => r.id === 'jx' )!;
      expect( [ kind, host.reported.map( ( r ) => r.id ), host.claimed.find( ( c ) => c.id === 'jx' )!.at < jr.end, reported.at >= jr.end ] ).toEqual( [ kind, [ 'jr', 'jx' ], true, true ] );
    }
  }, 90_000 );

  it( 'a --concurrency that is not a positive whole number exits 1', async () => {
    for ( const value of [ '0', '-1', '1.5', 'abc' ] ) {
      const host = await queueHost( [] );
      const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--once', '--interval', '0.05', '--concurrency', value ], {},
        { killWhen: () => host.requests.length > 0 } );
      expect( [ value, r.code, host.requests.length ] ).toEqual( [ value, 1, 0 ] );
      expect( r.stderr ).toContain( '--concurrency' );
    }
  } );
} );

describe( 'blueprint-steward start: merge poller', () => {
  const G = '-c user.email=t@t -c user.name=t';
  const sh = ( cmd: string, cwd: string ) => execSync( cmd, { cwd, encoding: 'utf-8' } ).trim();

  // A repo whose origin holds `feat/x` (one commit ahead of main) plus whatever `land` does to main.
  const mergeRepo = ( land: 'merge-commit' | 'fast-forward' | 'squash' | 'none' ) => {
    const repo = makeRepo();
    sh( `git checkout -q -b feat/x && echo x > x.txt && git ${ G } add x.txt && git ${ G } commit -qm x && git push -q origin feat/x && git checkout -q main`, repo );
    if ( land === 'merge-commit' ) sh( `git ${ G } merge -q --no-ff feat/x -m merge`, repo );
    if ( land === 'fast-forward' ) sh( 'git merge -q --ff-only feat/x', repo );
    if ( land === 'squash' ) sh( `git merge -q --squash feat/x && git ${ G } commit -qm squashed`, repo );
    sh( 'git push -q origin main', repo );
    return repo;
  };

  const branchHost = ( branches: Array<{ branch: string; baseBranch?: string }> ) => fakeHost( ( req ) =>
    req.url.startsWith( '/api/blueprint/branches?' ) ? { body: { branches } } : {} );

  // Stands in for `gh`: records every invocation; `auth status` succeeds iff authed.
  // `byState` answers `pr list --state <s>` per state; otherwise every list returns `prs`.
  const makeFakeGh = ( { authed, prs = [], byState }: { authed: boolean; prs?: unknown[]; byState?: Record<string, unknown[]> } ) => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-gh-' ) );
    const record = join( dir, 'calls.log' );
    const script = join( dir, 'gh.mjs' );
    writeFileSync( script, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${ JSON.stringify( record ) }, argv.join(' ') + '\\n');
if (argv[0] === 'auth') process.exit(${ authed ? 0 : 1 });
const byState = ${ JSON.stringify( byState ?? null ) };
const state = argv[argv.indexOf('--state') + 1];
if (argv[0] === 'pr' && argv[1] === 'list') { console.log(JSON.stringify(byState ? (byState[state] ?? []) : ${ JSON.stringify( prs ) })); process.exit(0); }
process.exit(2);
` );
    execSync( `chmod +x ${ script }` );
    const calls = () => existsSync( record ) ? readFileSync( record, 'utf-8' ).trim().split( '\n' ) : [];
    return { script, calls };
  };

  const ambient = { GH_TOKEN: '', GITHUB_TOKEN: '', BITBUCKET_USERNAME: '', BITBUCKET_APP_PASSWORD: '', BITBUCKET_TOKEN: '', BLUEPRINT_MERGE_POLL_SECONDS: '' };
  // --poll-once runs one merge-poll tick and exits; a claim means the job loop ran instead, so stop.
  const pollOnce = ( host: { url: string; requests: Req[] }, repo: string, gh: { script: string } ) =>
    run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--poll-once' ],
      { ...ambient, BLUEPRINT_GIT_HOST: 'github', BLUEPRINT_STEWARD_GH: gh.script },
      { killWhen: () => host.requests.some( ( q ) => q.url === '/api/blueprint/steward/claim' ) } );
  const merged = ( host: { requests: Req[] } ) => host.requests.filter( ( q ) => q.url === '/api/blueprint/branches/merged' );

  it( 'a merge commit is detected by ancestry, without calling the host adapter', async () => {
    const repo = mergeRepo( 'merge-commit' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true } );
    const r = await pollOnce( host, repo, gh );
    const reports = merged( host );
    expect( reports ).toHaveLength( 1 );
    expect( r.code ).toBe( 0 );
    expect( reports[ 0 ].body ).toMatchObject( {
      remoteUrl: sh( 'git remote get-url origin', repo ), source: 'feat/x', target: 'main', via: 'ancestry',
      mergeSha: sh( 'git rev-parse main', repo ),
    } );
    expect( host.requests[ 0 ].url ).toBe( `/api/blueprint/branches?remoteUrl=${ encodeURIComponent( sh( 'git remote get-url origin', repo ) ) }` );
    expect( gh.calls() ).toEqual( [] );
  } );

  it( 'a fast-forward is detected by ancestry, without calling the host adapter', async () => {
    const repo = mergeRepo( 'fast-forward' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true } );
    const r = await pollOnce( host, repo, gh );
    const reports = merged( host );
    expect( reports ).toHaveLength( 1 );
    expect( r.code ).toBe( 0 );
    expect( reports[ 0 ].body ).toMatchObject( { source: 'feat/x', target: 'main', via: 'ancestry', mergeSha: sh( 'git rev-parse feat/x', repo ) } );
    expect( gh.calls() ).toEqual( [] );
  } );

  it( 'a branch cut from main\'s tip with no commits of its own is never reported merged', async () => {
    const repo = mergeRepo( 'none' );
    sh( 'git checkout -q -b feat/x2 && git push -q origin feat/x2 && git checkout -q main', repo );
    const host = await branchHost( [ { branch: 'feat/x2', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true } );
    const r = await pollOnce( host, repo, gh );
    expect( r.code ).toBe( 0 );
    expect( merged( host ) ).toHaveLength( 0 );
  } );

  it( 'a squash merge is detected through the host adapter', async () => {
    const repo = mergeRepo( 'squash' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true, prs: [ { headRefName: 'feat/x', baseRefName: 'main', mergeCommit: { oid: 'sq1' }, mergedAt: '2026-09-27T00:00:00Z' } ] } );
    const r = await pollOnce( host, repo, gh );
    const reports = merged( host );
    expect( reports ).toHaveLength( 1 );
    expect( r.code ).toBe( 0 );
    expect( reports[ 0 ].body ).toMatchObject( { source: 'feat/x', target: 'main', via: 'host-api', mergeSha: 'sq1', mergedAt: '2026-09-27T00:00:00Z' } );
    expect( gh.calls().some( ( c ) => c.startsWith( 'pr list' ) ) ).toBe( true );
  } );

  it( 'a second tick against unchanged state sends the same report again', async () => {
    const repo = mergeRepo( 'merge-commit' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true } );
    const first = await pollOnce( host, repo, gh );
    const second = await pollOnce( host, repo, gh );
    const reports = merged( host );
    expect( reports ).toHaveLength( 2 );
    expect( [ first.code, second.code ] ).toEqual( [ 0, 0 ] );
    expect( reports[ 1 ].body ).toEqual( reports[ 0 ].body );
  } );

  it( 'a branch removed by --prune is reported deleted', async () => {
    const repo = mergeRepo( 'none' );
    sh( 'git checkout -q -b feat/y && git push -q origin feat/y && git checkout -q main', repo );
    sh( 'git fetch -q origin', repo );
    sh( `git --git-dir=${ sh( 'git remote get-url origin', repo ) } branch -D feat/y`, repo );
    const host = await branchHost( [ { branch: 'feat/y', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true } );
    const r = await pollOnce( host, repo, gh );
    const deleted = host.requests.filter( ( q ) => q.url === '/api/blueprint/branches/deleted' );
    expect( deleted.map( ( q ) => q.body ) ).toEqual( [ { remoteUrl: sh( 'git remote get-url origin', repo ), branch: 'feat/y' } ] );
    expect( r.code ).toBe( 0 );
  } );

  it( 'without host credentials a squash merge is invisible, one warning is logged, and the tick exits 0', async () => {
    const repo = mergeRepo( 'squash' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' }, { branch: 'feat/z', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: false } );
    const r = await pollOnce( host, repo, gh );
    expect( r.stderr.split( '\n' ).filter( ( l ) => /warning/i.test( l ) && !l.includes( '--token' ) ) ).toHaveLength( 1 );
    expect( merged( host ) ).toHaveLength( 0 );
    expect( r.code ).toBe( 0 );
    expect( gh.calls().some( ( c ) => c.startsWith( 'pr list' ) ) ).toBe( false );
  } );

  it( 'a missing/short reflog on the target does not hide a real merge: it falls through to the host adapter, with a warning', async () => {
    const repo = mergeRepo( 'merge-commit' );
    // Simulate a freshly (re-)provisioned Steward: origin/main's reflog carries no pre-merge history.
    sh( 'git reflog expire --expire=now --all', repo );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const mergeSha = sh( 'git rev-parse main', repo );
    const gh = makeFakeGh( { authed: true, prs: [ { headRefName: 'feat/x', baseRefName: 'main', mergeCommit: { oid: mergeSha }, mergedAt: '2026-09-27T00:00:00Z' } ] } );
    const r = await pollOnce( host, repo, gh );
    const reports = merged( host );
    expect( reports ).toHaveLength( 1 );
    expect( r.code ).toBe( 0 );
    expect( reports[ 0 ].body ).toMatchObject( { source: 'feat/x', target: 'main', via: 'host-api', mergeSha } );
    expect( r.stderr.split( '\n' ).filter( ( l ) => /warning/i.test( l ) && !l.includes( '--token' ) ) ).toHaveLength( 1 );
    expect( gh.calls().some( ( c ) => c.startsWith( 'pr list' ) ) ).toBe( true );
  } );

  // A closed-unmerged PR freezes the branch's sessions only when no open PR replaces it.
  const closedReports = ( host: { requests: Req[] } ) => host.requests.filter( ( q ) => q.url === '/api/blueprint/branches/closed' );
  const closedPr = { headRefName: 'feat/x', baseRefName: 'main', state: 'CLOSED' };

  it( 'a closed-unmerged PR with an open replacement PR is not reported closed', async () => {
    // Given branch feat/x has a closed-unmerged PR and a second, currently open PR
    const repo = mergeRepo( 'none' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true, byState: { closed: [ closedPr ], open: [ { headRefName: 'feat/x', baseRefName: 'main', state: 'OPEN' } ] } } );
    // When Steward ticks its merge-poll job
    const r = await pollOnce( host, repo, gh );
    // Then no /branches/closed report is made for feat/x
    expect( r.code ).toBe( 0 );
    expect( closedReports( host ) ).toHaveLength( 0 );
    expect( merged( host ) ).toHaveLength( 0 );
    expect( gh.calls().some( ( c ) => c.startsWith( 'pr list --state open' ) ) ).toBe( true );
  } );

  it( 'a closed-unmerged PR with no open replacement is reported closed exactly once', async () => {
    // Given branch feat/x has only closed-unmerged PRs, none open
    const repo = mergeRepo( 'none' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true, byState: { closed: [ closedPr ], open: [] } } );
    // When Steward ticks its merge-poll job
    const r = await pollOnce( host, repo, gh );
    // Then exactly one /branches/closed report is made for feat/x
    expect( r.code ).toBe( 0 );
    expect( closedReports( host ).map( ( q ) => q.body ) ).toEqual( [ { remoteUrl: sh( 'git remote get-url origin', repo ), source: 'feat/x' } ] );
    expect( merged( host ) ).toHaveLength( 0 );
  } );

  it( 'a MERGED entry in the closed list is not reported closed', async () => {
    // Given gh's closed list holds only a MERGED PR for feat/x, none open
    const repo = mergeRepo( 'none' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: true, byState: { closed: [ { ...closedPr, state: 'MERGED' } ], open: [] } } );
    // When Steward ticks its merge-poll job
    const r = await pollOnce( host, repo, gh );
    // Then no /branches/closed report is made
    expect( r.code ).toBe( 0 );
    expect( closedReports( host ) ).toHaveLength( 0 );
  } );

  it( 'without host credentials a closed PR is invisible and the tick still exits 0', async () => {
    const repo = mergeRepo( 'none' );
    const host = await branchHost( [ { branch: 'feat/x', baseBranch: 'main' } ] );
    const gh = makeFakeGh( { authed: false, byState: { closed: [ closedPr ], open: [] } } );
    const r = await pollOnce( host, repo, gh );
    expect( r.code ).toBe( 0 );
    expect( closedReports( host ) ).toHaveLength( 0 );
    expect( gh.calls().some( ( c ) => c.startsWith( 'pr list' ) ) ).toBe( false );
  } );

  const countWhile = async ( argv: string[], env: Record<string, string>, until: ( h: { requests: Req[] } ) => boolean ) => {
    const host = await fakeHost( ( req ) => req.url.startsWith( '/api/blueprint/branches?' ) ? { body: { branches: [] } } : {} );
    await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', makeRepo(), ...argv ], { ...ambient, ...env }, { killWhen: () => until( host ) } );
    const polls = host.requests.filter( ( q ) => q.url.startsWith( '/api/blueprint/branches?' ) ).length;
    const claims = host.requests.filter( ( q ) => q.url === '/api/blueprint/steward/claim' ).length;
    return { polls, claims };
  };

  // "Check git now" queues a git-poll job; Steward answers it with one merge-poll
  // tick (no checkout, no reality push, no agent) and reports the job done.
  it( 'a claimed git-poll job runs one merge-poll tick instead of the push + agent flow, then reports done', async () => {
    const repo = mergeRepo( 'merge-commit' );
    const host = await fakeHost( ( req ) =>
      req.url === '/api/blueprint/steward/claim' ? { body: { job: { id: 'jg', kind: 'git-poll', sessionId: 'sess-g', branch: null, prompt: null } } }
        : req.url.startsWith( '/api/blueprint/branches?' ) ? { body: { branches: [ { branch: 'feat/x', baseBranch: 'main' } ] } }
          : {} );
    const claude = makeFakeClaude( 0 );
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ],
      { ...ambient, BLUEPRINT_STEWARD_CLAUDE: claude.script, BLUEPRINT_GIT_HOST: 'github', BLUEPRINT_STEWARD_GH: makeFakeGh( { authed: true } ).script } );
    expect( r.code ).toBe( 0 );
    expect( host.requests.map( ( q ) => q.url.split( '?' )[ 0 ] ) ).toEqual( [
      '/api/blueprint/steward/claim', '/api/blueprint/branches', '/api/blueprint/branches/merged', '/api/blueprint/steward/jobs/jg'
    ] );
    expect( host.requests[ 3 ].body.status ).toBe( 'done' );
    expect( existsSync( claude.record ) ).toBe( false );
  } );

  it( 'the job-claim interval and the merge-poll interval are independent cadences', async () => {
    const fastClaims = await countWhile( [ '--interval', '0.02', '--merge-poll', '60' ], {},
      ( h ) => h.requests.filter( ( q ) => q.url === '/api/blueprint/steward/claim' ).length >= 10 );
    expect( fastClaims.claims ).toBeGreaterThanOrEqual( 10 );
    expect( fastClaims.polls ).toBe( 1 );
    const fastPolls = await countWhile( [ '--interval', '60', '--merge-poll', '0.02' ], {},
      ( h ) => h.requests.filter( ( q ) => q.url.startsWith( '/api/blueprint/branches?' ) ).length >= 5 );
    expect( fastPolls.polls ).toBeGreaterThanOrEqual( 5 );
    expect( fastPolls.claims ).toBe( 1 );
    const fromEnv = await countWhile( [ '--interval', '60' ], { BLUEPRINT_MERGE_POLL_SECONDS: '0.02' },
      ( h ) => h.requests.filter( ( q ) => q.url.startsWith( '/api/blueprint/branches?' ) ).length >= 5 );
    expect( fromEnv.polls ).toBeGreaterThanOrEqual( 5 );
    expect( fromEnv.claims ).toBe( 1 );
  } );
} );

// Every git / gh call is async and serialised per repository, bounded by
// --git-timeout, no child Steward starts holds the org key, and a push that landed and then exited
// non-zero reports done. The git under test is a PATH shim (a node script) that logs every call with its env and
// timestamps, and can slow, hang or fail a call by env switch; it runs the real git otherwise.
describe( 'blueprint-steward: async git, childEnv, timeout', () => {
  const SERVED = { text: 'Served hosted-turn text.', version: 1, sha256: 'c'.repeat( 64 ) };
  const design = ( id: string, sessionId: string, extra: Record<string, unknown> = {} ) => ( {
    id, kind: 'design', sessionId, branch: 'main', prompt: null, jobKey: `bpjk_${ id }`, instructions: SERVED, method: METHOD,
    tools: [ 'mcp__blueprint', 'Read' ], disallowedTools: [], ...extra,
  } );
  const REAL_GIT = execSync( 'command -v git', { encoding: 'utf-8' } ).trim();
  const wait = ( ms: number ) => new Promise( ( r ) => setTimeout( r, ms ) );

  const makeShim = () => {
    const dir = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-shim-' ) );
    const script = join( dir, 'git' );
    const sleep = 'Atomics.wait( new Int32Array( new SharedArrayBuffer( 4 ) ), 0, 0, ';
    writeFileSync( script, `#!${ process.execPath }
const { spawnSync } = require( 'node:child_process' );
const fs = require( 'node:fs' );
const args = process.argv.slice( 2 );
const e = process.env;
const log = ( ev, extra ) => fs.appendFileSync( e.SHIM_LOG, JSON.stringify( { ev, pid: process.pid, args, cwd: process.cwd(), t: Date.now(), ...extra } ) + '\\n' );
log( 'start', { env: e } );
const quiet = args[ 0 ] === 'fetch' && args.includes( '--quiet' );
let n = 0;
if ( quiet ) { n = ( fs.existsSync( e.SHIM_COUNT ) ? Number( fs.readFileSync( e.SHIM_COUNT, 'utf8' ) ) : 0 ) + 1; fs.writeFileSync( e.SHIM_COUNT, String( n ) ); }
if ( quiet && e.SHIM_HANG_FETCH ) ${ sleep }60000 );
if ( quiet && Number( e.SHIM_SLOW_NTH ) === n ) ${ sleep }Number( e.SHIM_SLOW_MS ) );
const r = spawnSync( e.SHIM_REAL_GIT, args, { stdio: 'inherit' } );
let code = r.status ?? 1;
if ( args[ 0 ] === 'push' && e.SHIM_PUSH_EXIT1 && code === 0 ) code = 1;
log( 'end', { code } );
process.exit( code );
` );
    chmodSync( script, 0o755 );
    const log = join( dir, 'log.jsonl' );
    const read = (): Array<{ ev: string; pid: number; args: string[]; cwd: string; t: number; env?: Record<string, string>; code?: number }> =>
      ( existsSync( log ) ? readFileSync( log, 'utf-8' ).split( '\n' ).filter( Boolean ).map( ( l ) => JSON.parse( l ) ) : [] );
    const env = { PATH: `${ dir }:${ process.env.PATH }`, SHIM_LOG: log, SHIM_COUNT: join( dir, 'count' ), SHIM_REAL_GIT: REAL_GIT,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    return { dir, env, read };
  };

  // Hands out `queue` one job per claim (an entry with `waitFor` waits until that file exists), records claims,
  // heartbeats and reports, serves `bundle` and `branches`.
  const host = async ( queue: Array<Record<string, any>>, more: { bundle?: unknown; branches?: unknown[] } = {} ) => {
    const claims: number[] = [];
    const heartbeats: Array<{ id: string; t: number }> = [];
    const reported: Array<{ id: string; body: any; t: number }> = [];
    const h = await fakeHost( ( req ) => {
      if ( req.url === '/api/blueprint/steward/claim' ) {
        claims.push( Date.now() );
        const waitFor = queue[ 0 ]?.waitFor;
        return { body: { job: typeof waitFor === 'string' && !existsSync( waitFor ) ? null : queue.shift() ?? null } };
      }
      const hb = req.url.match( /^\/api\/blueprint\/steward\/jobs\/([^/]+)\/heartbeat$/ );
      if ( hb ) { heartbeats.push( { id: hb[ 1 ], t: Date.now() } ); return {}; }
      if ( req.url.endsWith( '/bundle' ) ) return { body: more.bundle };
      if ( req.url.startsWith( '/api/blueprint/branches?' ) ) return { body: { branches: more.branches ?? [] } };
      const report = req.url.match( /^\/api\/blueprint\/steward\/jobs\/([^/]+)$/ );
      if ( report ) reported.push( { id: report[ 1 ], body: req.body, t: Date.now() } );
      return {};
    } );
    return { ...h, claims, heartbeats, reported };
  };

  it( 'while another job\'s fetch takes 4 s, a running job keeps heartbeating at its interval, and no two git processes overlap', async () => {
    const repo = makeRepo();
    const shim = makeShim();
    const marker = join( shim.dir, 'started-sess-a' );
    const claude = join( shim.dir, 'claude.cjs' );
    writeFileSync( claude, `#!${ process.execPath }
const fs = require( 'node:fs' );
const a = process.argv.slice( 2 );
const s = JSON.parse( fs.readFileSync( a[ a.indexOf( '--mcp-config' ) + 1 ], 'utf8' ) ).mcpServers.blueprint.env.BLUEPRINT_SESSION_ID;
fs.writeFileSync( ${ JSON.stringify( shim.dir ) } + '/started-' + s, '' );
${ printInit }
if ( s === 'sess-a' ) Atomics.wait( new Int32Array( new SharedArrayBuffer( 4 ) ), 0, 0, 6000 );
console.log( 'ok' );
` );
    chmodSync( claude, 0o755 );
    // sess-b is claimed only once sess-a's agent runs, so b's prepare fetch (the 2nd) lands in a's agent's life.
    const h = await host( [ design( 'ja', 'sess-a' ), { ...design( 'jb', 'sess-b' ), waitFor: marker } ] );
    let over = false;
    setTimeout( () => { over = true; }, 40_000 );
    await run( [ 'start', '--server', h.url, '--token', 'tok', '--repo', repo, '--concurrency', '2', '--heartbeat', '0.25', '--interval', '0.05', '--merge-poll', '600' ],
      { ...shim.env, SHIM_SLOW_NTH: '2', SHIM_SLOW_MS: '4000', BLUEPRINT_STEWARD_CLAUDE: claude },
      { killWhen: () => h.reported.length >= 2 || over } );
    const calls = shim.read();
    const slow = calls.filter( ( c ) => c.ev === 'end' ).map( ( end ) => ( { end, start: calls.find( ( c ) => c.ev === 'start' && c.pid === end.pid )! } ) )
      .find( ( c ) => c.start.args[ 0 ] === 'fetch' && c.end.t - c.start.t >= 3900 );
    expect( slow, 'the shim slowed no fetch' ).toBeDefined();
    const beats = h.heartbeats.filter( ( b ) => b.id === 'ja' ).map( ( b ) => b.t );
    const gaps = beats.slice( 1 ).map( ( t, i ) => t - beats[ i ] );
    expect( beats.filter( ( t ) => t > slow!.start.t && t < slow!.end.t ).length ).toBeGreaterThanOrEqual( 8 );
    expect( Math.max( ...gaps ) ).toBeLessThan( 750 );
    expect( h.reported.map( ( r ) => [ r.id, r.body.status ] ).sort() ).toEqual( [ [ 'ja', 'done' ], [ 'jb', 'done' ] ] );
    // Every git process ran alone.
    const spans = calls.filter( ( c ) => c.ev === 'end' ).map( ( end ) => [ calls.find( ( c ) => c.ev === 'start' && c.pid === end.pid )!.t, end.t ] )
      .sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
    expect( spans.length ).toBeGreaterThan( 5 );
    expect( spans.filter( ( s, i ) => i > 0 && s[ 0 ] < spans[ i - 1 ][ 1 ] ) ).toEqual( [] );
  }, 60_000 );

  it( 'a fetch past --git-timeout 1 fails the job checkout-failed "timed out", claude is never spawned, and Steward claims again', async () => {
    const repo = makeRepo();
    const shim = makeShim();
    const claude = makeFakeClaude( 0 );
    const h = await host( [ design( 'jt', 'sess-t' ) ] );
    let over = false;
    setTimeout( () => { over = true; }, 30_000 );
    await run( [ 'start', '--server', h.url, '--token', 'tok', '--repo', repo, '--git-timeout', '1', '--interval', '0.05', '--merge-poll', '600' ],
      { ...shim.env, SHIM_HANG_FETCH: '1', BLUEPRINT_STEWARD_CLAUDE: claude.script },
      { killWhen: () => ( h.reported.length >= 1 && h.claims.length >= 3 ) || over } );
    expect( h.reported.map( ( r ) => [ r.id, r.body.status, r.body.reason ] ) ).toEqual( [ [ 'jt', 'failed', 'checkout-failed' ] ] );
    expect( h.reported[ 0 ].body.result ).toContain( 'timed out' );
    expect( existsSync( claude.record ) ).toBe( false );
    expect( h.claims.length ).toBeGreaterThanOrEqual( 3 );
  }, 40_000 );

  it( 'the extractor, git, gh and claude env hold neither the name nor the value of the org key, whichever way Steward got it', async () => {
    const out = mkdtempSync( join( tmpdir(), 'blueprint-steward-test-env-' ) );
    const repo = makeRepo( `mkdir -p .blueprint && echo '{"nodes":[1]}' > .blueprint/graph.json && env > ${ out }/extractor.env` );
    const shim = makeShim();
    const claude = makeFakeClaude( 0 );
    const gh = join( out, 'gh.cjs' );
    writeFileSync( gh, `#!${ process.execPath }
require( 'node:fs' ).writeFileSync( ${ JSON.stringify( join( out, 'gh.json' ) ) }, JSON.stringify( process.env ) );
console.log( '[]' );
` );
    chmodSync( gh, 0o755 );
    const h = await host( [ design( 'jk', 'sess-k' ) ], { branches: [ { branch: 'feat/none', baseBranch: 'main' } ] } );
    let over = false;
    setTimeout( () => { over = true; }, 30_000 );
    // The key comes in argv (--token) AND the registry variable; each is also copied into a decoy under another name.
    await run( [ 'start', '--server', h.url, '--token', 'org-secret-argv', '--repo', repo, '--interval', '0.05', '--merge-poll', '600' ],
      { ...shim.env, BLUEPRINT_STEWARD_TOKEN: 'org-secret-env', DECOY_ENV: 'org-secret-env', DECOY_ARGV: 'org-secret-argv', KEEP_ME: 'kept',
        BLUEPRINT_STEWARD_CLAUDE: claude.script, BLUEPRINT_GIT_HOST: 'github', BLUEPRINT_STEWARD_GH: gh },
      { killWhen: () => ( h.reported.length >= 1 && existsSync( join( out, 'gh.json' ) ) ) || over } );
    const envs: Record<string, Record<string, string>> = {
      extractor: Object.fromEntries( readFileSync( join( out, 'extractor.env' ), 'utf-8' ).split( '\n' ).filter( Boolean ).map( ( l ) => [ l.slice( 0, l.indexOf( '=' ) ), l.slice( l.indexOf( '=' ) + 1 ) ] ) ),
      git: shim.read().find( ( c ) => c.ev === 'start' )!.env!,
      gh: JSON.parse( readFileSync( join( out, 'gh.json' ), 'utf-8' ) ),
      claude: JSON.parse( readFileSync( claude.record, 'utf-8' ) ).env,
    };
    for ( const [ who, env ] of Object.entries( envs ) ) {
      expect( env.KEEP_ME, `${ who } lost an ordinary variable` ).toBe( 'kept' );
      expect( Object.keys( env ), who ).not.toContain( 'BLUEPRINT_STEWARD_TOKEN' );
      expect( JSON.stringify( env ), who ).not.toContain( 'org-secret' );
    }
  }, 40_000 );

  it( '--token prints one argv warning; the environment variable path prints none', async () => {
    const enqueue = async ( args: string[], env: Record<string, string> ) => {
      const h = await fakeHost( () => ( { body: { job: { id: 'j', sessionId: 's' } } } ) );
      return run( [ 'enqueue', '--server', h.url, '--session', 's', ...args ], env );
    };
    const viaArgv = await enqueue( [ '--token', 'tok' ], {} );
    const viaEnv = await enqueue( [], { BLUEPRINT_STEWARD_TOKEN: 'tok' } );
    expect( viaArgv.stderr.split( '\n' ).filter( ( l ) => l.includes( '--token' ) && /warning/i.test( l ) ) ).toHaveLength( 1 );
    expect( viaEnv.stderr ).not.toMatch( /warning/i );
    expect( [ viaArgv.code, viaEnv.code ] ).toEqual( [ 0, 0 ] );
  } );

  it( 'a flush whose push lands and then exits 1 reports done, not diverged or push-rejected', async () => {
    const repo = makeRepo();
    const shim = makeShim();
    const remoteUrl = execSync( 'git remote get-url origin', { cwd: repo, encoding: 'utf-8' } ).trim();
    const files = { 'manifest.json': '{"sessionId":"sess-f","name":"F"}', 'ops.jsonl': '', 'design.json': '{}', 'board.json': '{}', 'map.json': '{}' };
    const bundle = { files, expect: {}, branch: 'main', remoteUrl, key: 'PROJ-268', headSeq: 1 };
    const h = await host( [ { id: 'jf', kind: 'flush', sessionId: 'sess-f', branch: null, prompt: null } ], { bundle } );
    let over = false;
    setTimeout( () => { over = true; }, 30_000 );
    await run( [ 'start', '--server', h.url, '--token', 'tok', '--repo', repo, '--interval', '0.05', '--merge-poll', '600' ],
      { ...shim.env, SHIM_PUSH_EXIT1: '1' }, { killWhen: () => h.reported.length >= 1 || over } );
    const tip = execSync( 'git rev-parse main', { cwd: remoteUrl, encoding: 'utf-8' } ).trim();
    expect( h.reported.map( ( r ) => [ r.id, r.body.status, r.body.reason ] ) ).toEqual( [ [ 'jf', 'done', undefined ] ] );
    expect( JSON.parse( h.reported[ 0 ].body.result ).commitSha ).toBe( tip );
    expect( shim.read().some( ( c ) => c.ev === 'end' && c.args[ 0 ] === 'push' && c.code === 1 ) ).toBe( true );
  }, 40_000 );

  it( 'structural: no Steward source starts a child outside lib/child.mjs (comments excluded)', () => {
    const root = resolve( __dirname, '..' );
    const files = [ 'bin/blueprint-steward.mjs', ...readdirSync( join( root, 'lib' ) ).map( ( f ) => `lib/${ f }` ) ];
    const code = ( text: string ) => text.replace( /\/\*[\s\S]*?\*\//g, '' ).split( '\n' ).filter( ( l ) => !/^\s*\/\//.test( l ) ).join( '\n' );
    const banned = /\b(spawnSync|execSync|execFileSync|execFile|spawn)\s*\(|from 'node:child_process'/;
    // Positive control: the pattern sees each banned form, and a comment-only mention is stripped before it looks.
    for ( const sample of [ 'spawnSync( "git" )', 'execSync( "x" )', 'execFileSync( "x" )', "import { a } from 'node:child_process';" ] ) expect( banned.test( sample ) ).toBe( true );
    expect( banned.test( code( '// spawnSync( "git" )\n/* execSync( "x" ) */' ) ) ).toBe( false );
    expect( files.length ).toBeGreaterThanOrEqual( 5 );
    const offenders = files.filter( ( f ) => f !== 'lib/child.mjs' && banned.test( code( readFileSync( join( root, f ), 'utf-8' ) ) ) );
    expect( offenders ).toEqual( [] );
    expect( banned.test( code( readFileSync( join( root, 'lib/child.mjs' ), 'utf-8' ) ) ) ).toBe( true );
  } );
} );
