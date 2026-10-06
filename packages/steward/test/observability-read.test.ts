import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READ_TIMEOUT_MS, runObservabilityRead } from '../lib/observability-read.mjs';

/**
 * Steward answers an observability-read job with the repository's declared reader, driven through `start --once`
 * against a fake host. The reader is `node fake-reader.mjs`, declared as the plain string the `observability.read` key
 * holds; the op and its argument reach it as positional arguments the shell never parses.
 */

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );

type Req = { url: string; body: Record<string, unknown> };

const servers: Server[] = [];
afterEach( () => { for ( const s of servers.splice( 0 ) ) s.close(); } );

/** A host that hands out `job` on the first claim and nothing after; every request is recorded. */
const fakeHost = async ( job: Record<string, unknown> ) => {
  const requests: Req[] = [];
  let claimed = false;
  const server = createServer( ( req, res ) => {
    let data = '';
    req.on( 'data', ( c ) => { data += c; } );
    req.on( 'end', () => {
      requests.push( { url: req.url!, body: data ? JSON.parse( data ) : undefined } );
      const body = req.url === '/api/blueprint/steward/claim' && !claimed ? ( claimed = true, { job } ) : {};
      res.writeHead( 200, { 'Content-Type': 'application/json' } );
      res.end( JSON.stringify( body ) );
    } );
  } );
  servers.push( server );
  await new Promise<void>( ( r ) => server.listen( 0, '127.0.0.1', () => r() ) );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${ port }`, requests };
};

// The default fake reader: records its argv and cwd to seen.json in its cwd, and prints one line per argument.
const ECHO_READER = [
  'import { writeFileSync } from \'node:fs\';',
  'const argv = process.argv.slice(2);',
  'writeFileSync(\'seen.json\', JSON.stringify({ argv, cwd: process.cwd() }));',
  'process.stdout.write(argv.map((a) => \'arg \' + a + \'\\n\').join(\'\'));',
  '',
].join( '\n' );

const G = 'git -c user.email=t@t -c user.name=t';
/** A git checkout holding fake-reader.mjs and a .blueprint.config.json declaring it, or declaring nothing. */
const makeRepo = ( { reader = ECHO_READER, declared = true }: { reader?: string; declared?: boolean } = {} ) => {
  const dir = mkdtempSync( join( tmpdir(), 'blueprint-observability-read-repo-' ) );
  writeFileSync( join( dir, '.blueprint.config.json' ), JSON.stringify( declared ? { observability: { read: 'node fake-reader.mjs' } } : { designTooling: {} } ) );
  writeFileSync( join( dir, 'fake-reader.mjs' ), reader );
  writeFileSync( join( dir, '.gitignore' ), 'seen.json\n' );
  execSync( `git init -q -b main && ${ G } add -A && ${ G } commit -qm init`, { cwd: dir } );
  return dir;
};

const run = ( args: string[] ) =>
  new Promise<{ code: number | null; stderr: string }>( ( res ) => {
    const child = spawn( process.execPath, [ BIN, ...args ], { env: { ...process.env, BLUEPRINT_STEWARD_TOKEN: '', BLUEPRINT_SESSION_ID: '', BLUEPRINT_JIRA_API_TOKEN: '' } } );
    let stderr = '';
    child.stderr.on( 'data', ( c ) => { stderr += c; } );
    child.on( 'close', ( code ) => { res( { code, stderr } ); } );
  } );

const readJob = ( payload: Record<string, unknown> ) => ( { id: 'jr', kind: 'observability-read', sessionId: 'sess-o', branch: null, prompt: null, payload } );

/** Runs one observability-read job through `start --once` and answers its report: status, parsed result, reason. */
const handle = async ( repo: string, payload: Record<string, unknown>, flags: string[] = [] ) => {
  const host = await fakeHost( readJob( payload ) );
  const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once', ...flags ] );
  const report = host.requests.find( ( q ) => q.url === '/api/blueprint/steward/jobs/jr' );
  return { code: r.code, stderr: r.stderr, status: report?.body.status, reason: report?.body.reason, result: report === undefined ? undefined : parsed( report.body.result as string ) };
};

// A result that is not JSON (a kind-unknown failure's sentence) is kept as its text, so an assertion prints it.
const parsed = ( text: string ) => {
  try { return JSON.parse( text ); } catch { return text; }
};

const seen = ( dir: string ) => ( existsSync( join( dir, 'seen.json' ) ) ? JSON.parse( readFileSync( join( dir, 'seen.json' ), 'utf-8' ) ) : undefined );

describe( 'blueprint-steward: observability-read job', () => {
  const INJECTION = 'first response"; touch PWNED; "';

  it( 'Given a declared reader that echoes its argv when Steward handles {op: search, text: <shell text>} then the reader saw exactly [search, that text], no PWNED file exists, and the result is ok with its stdout', async () => {
    // GIVEN: the control, that this text run through the shell does create PWNED.
    const scratch = mkdtempSync( join( tmpdir(), 'blueprint-observability-read-control-' ) );
    spawnSync( 'sh', [ '-c', `echo "${ INJECTION }"` ], { cwd: scratch } );
    expect( existsSync( join( scratch, 'PWNED' ) ) ).toBe( true );
    const repo = makeRepo();

    // WHEN
    const answer = await handle( repo, { op: 'search', text: INJECTION } );

    // THEN
    expect( seen( repo )?.argv ).toEqual( [ 'search', INJECTION ] );
    expect( existsSync( join( repo, 'PWNED' ) ) ).toBe( false );
    expect( { status: answer.status, result: answer.result } ).toEqual( { status: 'done', result: { status: 'ok', stdout: `arg search\narg ${ INJECTION }\n` } } );
  } );

  it( 'Given a reader that exits 3 with a message on stderr when the job runs then the result is unreachable with exitCode 3, not timed out, carrying the message', async () => {
    const repo = makeRepo( { reader: 'process.stderr.write(\'grafana said 401\\n\'); process.exit(3);\n' } );

    const answer = await handle( repo, { op: 'resolve', ref: 'abc/1' } );

    expect( { status: answer.status, result: answer.result } ).toEqual( {
      status: 'done', result: { status: 'unreachable', exitCode: 3, timedOut: false, stderr: 'grafana said 401\n' }
    } );
  } );

  it( 'Given a .blueprint.config.json without observability.read when the job runs then the result is not-declared and no reader runs', async () => {
    const repo = makeRepo( { declared: false } );

    const answer = await handle( repo, { op: 'search', text: 'checkout' } );

    expect( { status: answer.status, result: answer.result } ).toEqual( { status: 'done', result: { status: 'not-declared' } } );
    expect( seen( repo ) ).toBeUndefined();
  } );

  it( 'Given a reader whose stdout is 256 kB, then one byte more, when the job runs then the first is ok and the second too-large', async () => {
    const atCap = makeRepo( { reader: `process.stdout.write('x'.repeat(${ 256 * 1024 }));\n` } );
    const over = makeRepo( { reader: `process.stdout.write('x'.repeat(${ 256 * 1024 + 1 }));\n` } );

    const ok = await handle( atCap, { op: 'search', text: 'checkout' } );
    const large = await handle( over, { op: 'search', text: 'checkout' } );

    expect( [ ok.result?.status, ok.result?.stdout?.length ] ).toEqual( [ 'ok', 262_144 ] );
    expect( { status: large.status, result: large.result } ).toEqual( { status: 'done', result: { status: 'too-large', bytes: 262_145 } } );
  } );

  it( 'Given a text or ref of 513 characters when the job runs then it is refused and no reader runs; 512 characters are read', async () => {
    const repo = makeRepo();

    const text = await handle( repo, { op: 'search', text: 'x'.repeat( 513 ) } );
    const ref = await handle( repo, { op: 'resolve', ref: 'x'.repeat( 513 ) } );
    const unseen = seen( repo );
    const atCap = await handle( repo, { op: 'search', text: 'x'.repeat( 512 ) } );

    expect( [ text.status, text.result.status, ref.status, ref.result.status, unseen ] ).toEqual( [ 'failed', 'refused', 'failed', 'refused', undefined ] );
    expect( [ atCap.result.status, seen( repo )?.argv ] ).toEqual( [ 'ok', [ 'search', 'x'.repeat( 512 ) ] ] );
  } );

  it( 'Given a payload whose op is neither search nor resolve when the job runs then it is refused and no reader runs', async () => {
    const repo = makeRepo();

    const answer = await handle( repo, { op: 'write', text: 'checkout' } );

    expect( [ answer.status, answer.result.status, seen( repo ) ] ).toEqual( [ 'failed', 'refused', undefined ] );
  } );

  it( 'Given an empty text or an empty ref when the job runs then it is refused and no reader runs', async () => {
    const repo = makeRepo();

    const text = await handle( repo, { op: 'search', text: '' } );
    const ref = await handle( repo, { op: 'resolve', ref: '' } );

    expect( [ text.status, text.result.status, ref.status, ref.result.status, seen( repo ) ] ).toEqual( [ 'failed', 'refused', 'failed', 'refused', undefined ] );
  } );

  it( 'Given a failing reader writing 5000 characters to stderr when the job runs then the result carries only its last 2048', async () => {
    const written = `${ 'a'.repeat( 4000 ) }${ 'b'.repeat( 996 ) }TAIL`;
    const repo = makeRepo( { reader: `process.stderr.write(${ JSON.stringify( written ) }); process.exit(1);\n` } );

    const answer = await handle( repo, { op: 'search', text: 'checkout' } );

    expect( answer.result ).toEqual( { status: 'unreachable', exitCode: 1, timedOut: false, stderr: written.slice( -2048 ) } );
    expect( answer.result.stderr.length ).toBe( 2048 );
  } );

  it( 'Given the session has a worktree of the --repo checkout when the job runs then the reader runs in the worktree; without one, in the --repo checkout', async () => {
    const repo = makeRepo();
    const without = await handle( repo, { op: 'search', text: 'checkout' } );
    expect( [ without.result.status, seen( repo )?.cwd ] ).toEqual( [ 'ok', realpathSync( repo ) ] );

    const worktree = join( `${ repo }.blueprint-worktrees`, 'sess-o' );
    mkdirSync( `${ repo }.blueprint-worktrees` );
    execSync( `git worktree add -q --detach ${ worktree }`, { cwd: repo } );

    const within = await handle( repo, { op: 'search', text: 'checkout' } );

    expect( [ within.result.status, seen( worktree )?.cwd ] ).toEqual( [ 'ok', realpathSync( worktree ) ] );
  } );

  it( 'Given a reader that sleeps past the per-call timeout when the handler runs then the result is unreachable with timedOut true; Steward\'s per-call bound is 30 s', async () => {
    const repo = makeRepo( { reader: 'setTimeout(() => process.exit(0), 5000);\n' } );

    const outcome = await runObservabilityRead( readJob( { op: 'search', text: 'checkout' } ), { dir: repo, timeoutMs: 300 } );

    expect( outcome.ok ).toBe( true );
    expect( JSON.parse( outcome.result ) ).toMatchObject( { status: 'unreachable', exitCode: null, timedOut: true } );
    expect( READ_TIMEOUT_MS ).toBe( 30_000 );
  } );

  it( 'Given --git-timeout 1 and a reader that takes 2 s when Steward handles the job then the result is ok: the read is bounded by its own 30 s, not by the git timeout', async () => {
    const repo = makeRepo( { reader: 'setTimeout(() => { process.stdout.write(\'late\'); process.exit(0); }, 2000);\n' } );

    const answer = await handle( repo, { op: 'search', text: 'checkout' }, [ '--git-timeout', '1' ] );

    expect( { status: answer.status, result: answer.result } ).toEqual( { status: 'done', result: { status: 'ok', stdout: 'late' } } );
  } );
} );
