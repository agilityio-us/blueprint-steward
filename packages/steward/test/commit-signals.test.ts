import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Signals in the merge poll, and pr-ready: the merge poll reads the trailer the
 * branch list names off each listed branch's commits new since the tip it last saw, and POSTs them to
 * /api/blueprint/runner/signals; a pr-ready job takes the ticket branch's draft PR out of draft through gh, GitHub only,
 * skipped when the branch has no open PR. Driven through the Steward binary against a fake host, a bare git remote and a
 * fake gh.
 */

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );
const SIGNALS_ROUTE = '/api/blueprint/runner/signals';
const BRANCHES_ROUTE = '/api/blueprint/branches';

type Req = { method: string; url: string; body: unknown };
type Report = { status?: string; result: string };

const servers: Server[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach( () => {
  for ( const s of servers.splice( 0 ) ) s.close();
  for ( const c of children.splice( 0 ) ) c.kill( 'SIGKILL' );
} );

/** A host answering `answer( req )` (default `{}`) with HTTP `statusOf( req )` (default 200); every request is recorded, its body parsed as JSON. */
const fakeHost = async ( answer: ( req: Req, requests: Req[] ) => unknown = () => ( {} ), statusOf: ( req: Req, requests: Req[] ) => number = () => 200 ) => {
  const requests: Req[] = [];
  const server = createServer( ( req, res ) => {
    let data = '';
    req.on( 'data', ( c ) => { data += c; } );
    req.on( 'end', () => {
      const r: Req = { method: req.method!, url: req.url!, body: data ? JSON.parse( data ) : undefined };
      requests.push( r );
      const body = answer( r, requests ) ?? {};
      res.writeHead( statusOf( r, requests ), { 'Content-Type': 'application/json' } );
      res.end( JSON.stringify( body ) );
    } );
  } );
  servers.push( server );
  await new Promise<void>( ( r ) => server.listen( 0, '127.0.0.1', () => r() ) );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${ port }`, requests };
};

const G = 'git -c user.email=t@t -c user.name=t';
const makeRepo = () => {
  const dir = mkdtempSync( join( tmpdir(), 'blueprint-signals-repo-' ) );
  writeFileSync( join( dir, 'README.md' ), 'r\n' );
  execSync( `git init -q -b main && ${ G } add -A && ${ G } commit -qm init`, { cwd: dir } );
  const remote = mkdtempSync( join( tmpdir(), 'blueprint-signals-remote-' ) );
  execSync( `git init -q --bare ${ remote }` );
  execSync( `git remote add origin ${ remote } && git push -q origin main && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`, { cwd: dir } );
  return { dir, remote };
};
/** One commit on `branch` (created from main when absent) with `message`, pushed to origin; its sha. */
const commitOn = ( dir: string, branch: string, message: string ) => {
  const file = join( dir, `${ Math.random().toString( 36 ).slice( 2 ) }.txt` );
  writeFileSync( file, 'x\n' );
  const msgFile = join( mkdtempSync( join( tmpdir(), 'blueprint-signals-msg-' ) ), 'msg' );
  writeFileSync( msgFile, message );
  execSync( `git checkout -q ${ branch } 2>/dev/null || git checkout -q -b ${ branch } main`, { cwd: dir, shell: '/bin/sh' } );
  execSync( `${ G } add -A && ${ G } commit -q -F ${ msgFile } && git push -q origin ${ branch } && git checkout -q main`, { cwd: dir } );
  return execSync( `git rev-parse ${ branch }`, { cwd: dir, encoding: 'utf-8' } ).trim();
};
/** Runs `steps` on `branch` checked out, then force-pushes it to origin; its new tip. */
const rewrite = ( dir: string, branch: string, steps: string ) => {
  execSync( `git checkout -q ${ branch } && ${ steps } && git push -q -f origin ${ branch } && git checkout -q main`, { cwd: dir } );
  return execSync( `git rev-parse ${ branch }`, { cwd: dir, encoding: 'utf-8' } ).trim();
};
const messageFile = ( message: string ) => {
  const msgFile = join( mkdtempSync( join( tmpdir(), 'blueprint-signals-msg-' ) ), 'msg' );
  writeFileSync( msgFile, message );
  return msgFile;
};

// The fixture owns git's ambient config and the git host: no global or system git config, no git host named and no gh,
// so merge detection stays ancestry-only whoever runs this.
const EMPTY_GIT_CONFIG = join( mkdtempSync( join( tmpdir(), 'blueprint-signals-gitconfig-' ) ), 'config' );
writeFileSync( EMPTY_GIT_CONFIG, '' );
const ambient = ( env: Record<string, string> ) => ( {
  ...process.env, BLUEPRINT_STEWARD_TOKEN: '', BLUEPRINT_SESSION_ID: '', BLUEPRINT_JIRA_API_TOKEN: '', BLUEPRINT_GIT_HOST: '',
  GH_TOKEN: '', GITHUB_TOKEN: '', BLUEPRINT_STEWARD_GH: join( tmpdir(), 'no-such-gh-binary' ), GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1', ...env,
} );
const run = ( args: string[], env: Record<string, string> = {} ) =>
  new Promise<{ code: number | null; stderr: string }>( ( res ) => {
    const child = spawn( process.execPath, [ BIN, ...args ], { env: ambient( env ) } );
    let stderr = '';
    child.stderr.on( 'data', ( c ) => { stderr += c; } );
    child.on( 'close', ( code ) => { res( { code, stderr } ); } );
  } );

const branchList = ( branches: Record<string, unknown>[] ) => ( req: Req ) =>
  ( req.method === 'GET' && req.url.startsWith( `${ BRANCHES_ROUTE }?` ) ? { branches } : { ok: true } );
const signalPosts = ( host: { requests: Req[] } ) => host.requests.filter( ( q ) => q.method === 'POST' && q.url === SIGNALS_ROUTE ).map( ( q ) => q.body );
const listCount = ( requests: Req[] ) => requests.filter( ( q ) => q.method === 'GET' && q.url.startsWith( `${ BRANCHES_ROUTE }?` ) ).length;
/** A host listing `branches` that runs `onList( n )` while it answers its n-th branch list, so the change lands for tick n + 1. */
const tickingHost = ( branches: Record<string, unknown>[], onList: ( n: number ) => void, statusOf?: ( req: Req, requests: Req[] ) => number ) =>
  fakeHost( ( req, requests ) => {
    if ( req.method === 'GET' && req.url.startsWith( `${ BRANCHES_ROUTE }?` ) ) onList( listCount( requests ) );
    return branchList( branches )( req );
  }, statusOf );
/** One Steward process polling every 0.2 s until the host has answered `ticks` branch lists; its stderr. */
const pollTicks = async ( host: { url: string; requests: Req[] }, dir: string, ticks: number ) => {
  const child = spawn( process.execPath, [ BIN, 'start', '--server', host.url, '--token', 'tok', '--repo', dir, '--merge-poll', '0.2', '--interval', '600' ], { env: ambient( {} ) } );
  children.push( child );
  let stderr = '';
  child.stderr!.on( 'data', ( c ) => { stderr += c; } );
  const deadline = Date.now() + 60_000;
  while ( listCount( host.requests ) < ticks && Date.now() < deadline ) await new Promise( ( r ) => setTimeout( r, 50 ) );
  child.kill( 'SIGKILL' );
  expect( listCount( host.requests ), stderr ).toBeGreaterThanOrEqual( ticks );
  return stderr;
};
const P = ( sha: string, value: string, subject: string ) => ( { sha, key: 'Blueprint-Status', value, subject } );

describe( 'blueprint-steward: commit signals in the merge poll', () => {
  it( 'Given a ticket branch that gained one commit ending with the trailer "Blueprint-Status: done" and a branch list naming key Blueprint-Status, when the merge poll ticks, then Steward reports one signal {sha of that commit, value done}', async () => {
    // GIVEN
    const { dir, remote } = makeRepo();
    commitOn( dir, 'P-1-checkout', 'chore: scaffold\n' );
    const done = commitOn( dir, 'P-1-checkout', 'feat: one-step checkout\n\nPays in one step.\n\nBlueprint-Status: done\n' );
    const host = await fakeHost( branchList( [ { branch: 'P-1-checkout', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ] ) );

    // WHEN
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', dir, '--poll-once' ] );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( signalPosts( host ) ).toEqual( [ {
      remoteUrl: remote, branch: 'P-1-checkout',
      signals: [ { sha: done, key: 'Blueprint-Status', value: 'done', subject: 'feat: one-step checkout' } ],
    } ] );
  } );

  it( 'Given a branch whose tip the poll already saw, when it ticks again, then it reports nothing; a commit pushed later is reported alone', async () => {
    // GIVEN: one Steward process ticking every 0.2 s; while the host answers the second branch list, a second trailer
    // commit lands on origin, so the third tick's fetch is the first to see it.
    const { dir, remote } = makeRepo();
    const first = commitOn( dir, 'P-2-cart', 'feat: cart\n\nBlueprint-Status: done\n' );
    let second: string | undefined;
    const lists = ( requests: Req[] ) => requests.filter( ( q ) => q.method === 'GET' && q.url.startsWith( `${ BRANCHES_ROUTE }?` ) ).length;
    const host = await fakeHost( ( req, requests ) => {
      if ( req.method === 'GET' && req.url.startsWith( `${ BRANCHES_ROUTE }?` ) && lists( requests ) === 2 ) {
        second = commitOn( dir, 'P-2-cart', 'fix: cart total\n\nBlueprint-Status: blocked\n' );
      }
      return branchList( [ { branch: 'P-2-cart', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ] )( req );
    } );

    // WHEN
    const child = spawn( process.execPath, [ BIN, 'start', '--server', host.url, '--token', 'tok', '--repo', dir, '--merge-poll', '0.2', '--interval', '600' ], { env: ambient( {} ) } );
    children.push( child );
    let stderr = '';
    child.stderr!.on( 'data', ( c ) => { stderr += c; } );
    const deadline = Date.now() + 60_000;
    while ( lists( host.requests ) < 6 && Date.now() < deadline ) await new Promise( ( r ) => setTimeout( r, 50 ) );
    child.kill( 'SIGKILL' );

    // THEN
    expect( lists( host.requests ), stderr ).toBeGreaterThanOrEqual( 6 );
    expect( signalPosts( host ) ).toEqual( [
      { remoteUrl: remote, branch: 'P-2-cart', signals: [ { sha: first, key: 'Blueprint-Status', value: 'done', subject: 'feat: cart' } ] },
      { remoteUrl: remote, branch: 'P-2-cart', signals: [ { sha: second, key: 'Blueprint-Status', value: 'blocked', subject: 'fix: cart total' } ] },
    ] );
  }, 90_000 );

  it( 'Given branch lists naming another key, naming none, and refusing an unsafe one, when the poll ticks, then each branch reads the key it names, Blueprint-Status by default, and an unsafe key reads nothing', async () => {
    // GIVEN
    const { dir, remote } = makeRepo();
    commitOn( dir, 'P-3-named', 'feat: a\n\nBlueprint-Status: done\n' );
    const named = commitOn( dir, 'P-3-named', 'feat: b\n\nBlueprint-Signal: done\n' );
    const unnamed = commitOn( dir, 'P-4-unnamed', 'feat: c\n\nBlueprint-Status: done\n' );
    commitOn( dir, 'P-5-unsafe', 'feat: d\n\nBlueprint-Status: done\n' );
    const host = await fakeHost( branchList( [
      { branch: 'P-3-named', baseBranch: 'main', signalTrailerKey: 'Blueprint-Signal' },
      { branch: 'P-4-unnamed', baseBranch: 'main' },
      { branch: 'P-5-unsafe', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status,valueonly)%H' },
    ] ) );

    // WHEN
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', dir, '--poll-once' ] );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( signalPosts( host ) ).toEqual( [
      { remoteUrl: remote, branch: 'P-3-named', signals: [ { sha: named, key: 'Blueprint-Signal', value: 'done', subject: 'feat: b' } ] },
      { remoteUrl: remote, branch: 'P-4-unnamed', signals: [ { sha: unnamed, key: 'Blueprint-Status', value: 'done', subject: 'feat: c' } ] },
    ] );
  } );
} );

describe( 'blueprint-steward: commit signals read only the branch\'s own commits, every one, once delivered', () => {
  it( 'Given a ticket branch the poll already read, when main gains another ticket\'s "Blueprint-Status: done" and is merged into the branch, then only the branch\'s own new commit is reported, never main\'s', async () => {
    // GIVEN: tick 1 reads P-6's own commit (no trailer); while the host answers list 2, main gains another ticket's done
    // commit, main is merged into P-6, and P-6 gains its own done commit.
    const { dir, remote } = makeRepo();
    commitOn( dir, 'P-6-mine', 'feat: mine\n' );
    let mine: string | undefined;
    const host = await tickingHost( [ { branch: 'P-6-mine', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ], ( n ) => {
      if ( n !== 2 ) return;
      commitOn( dir, 'main', 'feat: other ticket\n\nBlueprint-Status: done\n' );
      rewrite( dir, 'P-6-mine', `${ G } merge -q --no-ff -m "Merge main into P-6-mine" main` );
      mine = commitOn( dir, 'P-6-mine', 'feat: mine finished\n\nBlueprint-Status: done\n' );
    } );

    // WHEN
    await pollTicks( host, dir, 5 );

    // THEN
    expect( signalPosts( host ) ).toEqual( [ { remoteUrl: remote, branch: 'P-6-mine', signals: [ P( mine!, 'done', 'feat: mine finished' ) ] } ] );
  }, 90_000 );

  it( 'Given a ticket branch the poll already read, when it is rebased onto a main that gained another ticket\'s "Blueprint-Status: done" and force-pushed, then the rebased commit is reported and main\'s is not', async () => {
    // GIVEN
    const { dir, remote } = makeRepo();
    const before = commitOn( dir, 'P-7-rebased', 'feat: seven\n\nBlueprint-Status: needs-human\n' );
    let after: string | undefined;
    const host = await tickingHost( [ { branch: 'P-7-rebased', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ], ( n ) => {
      if ( n !== 2 ) return;
      commitOn( dir, 'main', 'feat: other ticket\n\nBlueprint-Status: done\n' );
      after = rewrite( dir, 'P-7-rebased', `${ G } rebase -q main` );
    } );

    // WHEN
    await pollTicks( host, dir, 5 );

    // THEN
    expect( after ).not.toBe( before );
    expect( signalPosts( host ) ).toEqual( [
      { remoteUrl: remote, branch: 'P-7-rebased', signals: [ P( before, 'needs-human', 'feat: seven' ) ] },
      { remoteUrl: remote, branch: 'P-7-rebased', signals: [ P( after!, 'needs-human', 'feat: seven' ) ] },
    ] );
  }, 90_000 );

  it( 'Given a ticket branch the poll already read, when its last commit is amended and force-pushed, then the branch is read again from its base: the kept commit and the amended one are reported', async () => {
    // GIVEN: the tip the poll saw (wip) is no longer on the branch once it is amended.
    const { dir, remote } = makeRepo();
    const kept = commitOn( dir, 'P-8-amended', 'feat: eight\n\nBlueprint-Status: needs-human\n' );
    commitOn( dir, 'P-8-amended', 'chore: wip\n' );
    let amended: string | undefined;
    const host = await tickingHost( [ { branch: 'P-8-amended', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ], ( n ) => {
      if ( n === 2 ) amended = rewrite( dir, 'P-8-amended', `${ G } commit -q --amend -F ${ messageFile( 'feat: eight finished\n\nBlueprint-Status: done\n' ) }` );
    } );

    // WHEN
    await pollTicks( host, dir, 5 );

    // THEN
    expect( signalPosts( host ) ).toEqual( [
      { remoteUrl: remote, branch: 'P-8-amended', signals: [ P( kept, 'needs-human', 'feat: eight' ) ] },
      { remoteUrl: remote, branch: 'P-8-amended', signals: [ P( kept, 'needs-human', 'feat: eight' ), P( amended!, 'done', 'feat: eight finished' ) ] },
    ] );
  }, 90_000 );

  it( 'Given a host that refuses the first signal report with a 500, when the poll ticks again, then the same signal is sent again, and not after the host accepts it', async () => {
    // GIVEN
    const { dir, remote } = makeRepo();
    const done = commitOn( dir, 'P-9-retried', 'feat: nine\n\nBlueprint-Status: done\n' );
    const host = await tickingHost( [ { branch: 'P-9-retried', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ], () => {}, ( req, requests ) =>
      ( req.url === SIGNALS_ROUTE && requests.filter( ( q ) => q.url === SIGNALS_ROUTE ).length === 1 ? 500 : 200 ) );

    // WHEN
    await pollTicks( host, dir, 5 );

    // THEN
    const report = { remoteUrl: remote, branch: 'P-9-retried', signals: [ P( done, 'done', 'feat: nine' ) ] };
    expect( signalPosts( host ) ).toEqual( [ report, report ] );
  }, 90_000 );

  it( 'Given two trailer commits new in one tick, when the poll ticks, then one report carries both, oldest first', async () => {
    // GIVEN
    const { dir, remote } = makeRepo();
    const older = commitOn( dir, 'P-10-ordered', 'feat: ten\n\nBlueprint-Status: needs-human\n' );
    const newer = commitOn( dir, 'P-10-ordered', 'feat: ten finished\n\nBlueprint-Status: done\n' );
    const host = await fakeHost( branchList( [ { branch: 'P-10-ordered', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ] ) );

    // WHEN
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', dir, '--poll-once' ] );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( signalPosts( host ) ).toEqual( [ {
      remoteUrl: remote, branch: 'P-10-ordered', signals: [ P( older, 'needs-human', 'feat: ten' ), P( newer, 'done', 'feat: ten finished' ) ],
    } ] );
  } );

  it( 'Given a commit carrying the trailer twice, when the poll ticks, then each value is its own signal, in the order written', async () => {
    // GIVEN
    const { dir, remote } = makeRepo();
    const both = commitOn( dir, 'P-11-twice', 'feat: eleven\n\nBlueprint-Status: blocked\nBlueprint-Status: done\n' );
    const host = await fakeHost( branchList( [ { branch: 'P-11-twice', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ] ) );

    // WHEN
    const r = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', dir, '--poll-once' ] );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( signalPosts( host ) ).toEqual( [ {
      remoteUrl: remote, branch: 'P-11-twice', signals: [ P( both, 'blocked', 'feat: eleven' ), P( both, 'done', 'feat: eleven' ) ],
    } ] );
  } );
} );

/**
 * A cloud routine cannot push to a ticket branch, so it works on claude/<ticket branch>, cut from it. The merge poll reads that agent branch's own commits under the ticket
 * branch's trailer key: a done merges it into the ticket branch on origin, by fast-forward when it can and by a merge
 * commit made with plumbing otherwise, so the ticket branch's own read reports the done; any other signal is reported
 * for the ticket branch without merging; an agent branch that does not merge cleanly is reported needs-human.
 */
describe( 'blueprint-steward: the agent branch claude/<ticket branch> (implementation routines)', () => {
  /** A repo whose origin holds ticket branch P-1 (one commit on main) and whose checkout can make merge commits. */
  const ticketRepo = () => {
    const repo = makeRepo();
    execSync( 'git config user.email steward@example.com && git config user.name Steward', { cwd: repo.dir } );
    const ticketTip = commitOn( repo.dir, 'P-1', 'P-1: open the design branch\n' );
    return { ...repo, ticketTip };
  };
  /** One commit writing `file` on `branch`, cut from `from` when absent, pushed to origin; its sha. */
  const writeOn = ( dir: string, branch: string, from: string, file: string, content: string, message: string ) => {
    execSync( `git checkout -q ${ branch } 2>/dev/null || git checkout -q -b ${ branch } ${ from }`, { cwd: dir, shell: '/bin/sh' } );
    writeFileSync( join( dir, file ), content );
    execSync( `${ G } add -A && ${ G } commit -q -F ${ messageFile( message ) } && git push -q origin ${ branch } && git checkout -q main`, { cwd: dir } );
    return execSync( `git rev-parse ${ branch }`, { cwd: dir, encoding: 'utf-8' } ).trim();
  };
  const originTip = ( remote: string, branch: string ) => execSync( `git rev-parse ${ branch }`, { cwd: remote, encoding: 'utf-8' } ).trim();
  const parentsOf = ( remote: string, sha: string ) => execSync( `git log -1 --format=%P ${ sha }`, { cwd: remote, encoding: 'utf-8' } ).trim().split( ' ' );
  const TICKET = [ { branch: 'P-1', baseBranch: 'main', signalTrailerKey: 'Blueprint-Status' } ];
  const pollOnce = ( host: { url: string }, dir: string ) => run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', dir, '--poll-once' ] );

  it( 'Given claude/P-1 cut from P-1 whose last commit ends "Blueprint-Status: done", when the poll ticks, then origin\'s P-1 is fast-forwarded to it and the done is reported for P-1', async () => {
    // GIVEN
    const { dir, remote } = ticketRepo();
    writeOn( dir, 'claude/P-1', 'P-1', 'a.txt', 'a\n', 'feat: build it\n' );
    const done = writeOn( dir, 'claude/P-1', 'P-1', 'b.txt', 'b\n', 'feat: finish it\n\nBlueprint-Status: done\n' );
    const host = await fakeHost( branchList( TICKET ) );

    // WHEN
    const r = await pollOnce( host, dir );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( originTip( remote, 'P-1' )).toBe( done );
    expect( signalPosts( host )).toEqual( [ { remoteUrl: remote, branch: 'P-1', signals: [ P( done, 'done', 'feat: finish it' ) ] } ] );
  } );

  it( 'Given P-1 gained a commit after claude/P-1 was cut from it, when claude/P-1 says done, then origin\'s P-1 becomes a merge commit of both tips and the done is reported for P-1', async () => {
    // GIVEN
    const { dir, remote } = ticketRepo();
    const done = writeOn( dir, 'claude/P-1', 'P-1', 'a.txt', 'a\n', 'feat: build it\n\nBlueprint-Status: done\n' );
    const moved = writeOn( dir, 'P-1', 'main', 'design.md', 'flushed\n', 'P-1: flush the design\n' );
    const host = await fakeHost( branchList( TICKET ) );

    // WHEN
    const r = await pollOnce( host, dir );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    const merged = originTip( remote, 'P-1' );
    expect( parentsOf( remote, merged )).toEqual( [ moved, done ] );
    expect( execSync( `git log -1 --format=%s ${ merged }`, { cwd: remote, encoding: 'utf-8' } ).trim()).toBe( 'Merge claude/P-1 into P-1' );
    expect( execSync( `git ls-tree --name-only ${ merged }`, { cwd: remote, encoding: 'utf-8' } ).split( '\n' )).toEqual( expect.arrayContaining( [ 'a.txt', 'design.md' ] ));
    expect( signalPosts( host )).toEqual( [ { remoteUrl: remote, branch: 'P-1', signals: [ P( done, 'done', 'feat: build it' ) ] } ] );
  } );

  it( 'Given claude/P-1 whose commit ends "Blueprint-Status: needs-human", when the poll ticks, then P-1 is left where it is and the needs-human is reported for P-1', async () => {
    // GIVEN
    const { dir, remote, ticketTip } = ticketRepo();
    const stuck = writeOn( dir, 'claude/P-1', 'P-1', 'a.txt', 'a\n', 'The design names no endpoint\n\nBlueprint-Status: needs-human\n' );
    const host = await fakeHost( branchList( TICKET ) );

    // WHEN
    const r = await pollOnce( host, dir );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( originTip( remote, 'P-1' )).toBe( ticketTip );
    expect( signalPosts( host )).toEqual( [ { remoteUrl: remote, branch: 'P-1', signals: [ P( stuck, 'needs-human', 'The design names no endpoint' ) ] } ] );
  } );

  it( 'Given claude/P-1 says done but conflicts with a later commit on P-1, when the poll ticks, then P-1 is left where it is and a needs-human naming the conflict is reported for P-1', async () => {
    // GIVEN
    const { dir, remote } = ticketRepo();
    const done = writeOn( dir, 'claude/P-1', 'P-1', 'same.txt', 'agent\n', 'feat: build it\n\nBlueprint-Status: done\n' );
    const moved = writeOn( dir, 'P-1', 'main', 'same.txt', 'human\n', 'P-1: edit the same file\n' );
    const host = await fakeHost( branchList( TICKET ) );

    // WHEN
    const r = await pollOnce( host, dir );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( originTip( remote, 'P-1' )).toBe( moved );
    expect( signalPosts( host )).toEqual( [ {
      remoteUrl: remote, branch: 'P-1', signals: [ P( done, 'needs-human', 'claude/P-1 does not merge cleanly into P-1' ) ],
    } ] );
  } );

  it( 'Given claude/P-1 with no trailer, or a claude/ branch for a branch the list gives no key, when the poll ticks, then nothing is merged and nothing is reported', async () => {
    // GIVEN
    const { dir, remote, ticketTip } = ticketRepo();
    writeOn( dir, 'claude/P-1', 'P-1', 'a.txt', 'a\n', 'feat: still going\n' );
    const other = commitOn( dir, 'feat/x', 'feat: x\n' );
    writeOn( dir, 'claude/feat/x', 'feat/x', 'b.txt', 'b\n', 'feat: done elsewhere\n\nBlueprint-Status: done\n' );
    const host = await fakeHost( branchList( [ ...TICKET, { branch: 'feat/x', baseBranch: 'main', signalTrailerKey: null } ] ));

    // WHEN
    const r = await pollOnce( host, dir );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( originTip( remote, 'P-1' )).toBe( ticketTip );
    expect( originTip( remote, 'feat/x' )).toBe( other );
    expect( signalPosts( host )).toEqual( [] );
  } );
} );

/** A gh that appends each argv to a record and answers `pr list` with `prs`. */
const fakeGh = ( prs: Record<string, unknown>[] ) => {
  const ghDir = mkdtempSync( join( tmpdir(), 'blueprint-pr-ready-gh-' ) );
  const record = join( ghDir, 'calls.jsonl' );
  const gh = join( ghDir, 'gh.mjs' );
  writeFileSync( gh, [
    '#!/usr/bin/env node',
    'const argv = process.argv.slice(2);',
    `(await import('node:fs')).appendFileSync(${ JSON.stringify( record ) }, JSON.stringify(argv) + '\\n');`,
    `if (argv[0] === 'pr' && argv[1] === 'list') console.log(${ JSON.stringify( JSON.stringify( prs ) ) });`,
    'else if (argv[0] === \'pr\' && argv[1] === \'ready\') console.log(`Pull request #${argv[2]} is marked as "ready for review"`);',
    'else { console.error(`unexpected gh ${argv.join(\' \')}`); process.exit(1); }',
    '',
  ].join( '\n' ) );
  execSync( `chmod +x ${ gh }` );
  const calls = () => ( existsSync( record ) ? readFileSync( record, 'utf-8' ).trim().split( '\n' ).map( ( l ) => JSON.parse( l ) as string[] ) : [] );
  return { gh, calls };
};
const prReadyJob = { id: 'jp', kind: 'pr-ready', sessionId: 'sess-p', payload: { branch: 'P-1-checkout' } };
const claimOnce = ( job: Record<string, unknown> ) => {
  let claimed = false;
  return ( req: Req ) => ( req.url === '/api/blueprint/runner/claim' && !claimed ? ( claimed = true, { job } ) : {} );
};
const startOnce = ( host: { url: string }, repo: string, env: Record<string, string> ) =>
  run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], env );
const reportOf = ( host: { requests: Req[] }, id: string ) => host.requests.find( ( q ) => q.url === `/api/blueprint/runner/jobs/${ id }` )?.body as Report | undefined;

describe( 'blueprint-steward: pr-ready job', () => {
  it( 'Given a pr-ready job for a branch with an open draft PR on GitHub, when Steward runs it, then gh pr ready is called on that PR and the job is done', async () => {
    // GIVEN
    const { dir } = makeRepo();
    const { gh, calls } = fakeGh( [ { number: 7, isDraft: true, url: 'https://github.example/o/r/pull/7', headRefName: 'P-1-checkout' } ] );
    const host = await fakeHost( claimOnce( prReadyJob ) );

    // WHEN
    const r = await startOnce( host, dir, { BLUEPRINT_STEWARD_GH: gh, BLUEPRINT_GIT_HOST: 'github' } );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( calls().filter( ( argv ) => argv[ 1 ] === 'ready' ) ).toEqual( [ [ 'pr', 'ready', '7' ] ] );
    const report = reportOf( host, 'jp' );
    expect( report?.status ).toBe( 'done' );
    expect( JSON.parse( report?.result ?? 'null' ) ).toEqual( { branch: 'P-1-checkout', state: 'ready', pr: 'https://github.example/o/r/pull/7' } );
  } );

  it( 'Given a pr-ready job for a branch with no PR, when Steward runs it, then it reports skipped and calls no gh pr ready', async () => {
    // GIVEN: gh lists only another branch's PR, as `--head` would never return it, so Steward's own filter is held too.
    const { dir } = makeRepo();
    const { gh, calls } = fakeGh( [ { number: 9, isDraft: true, url: 'https://github.example/o/r/pull/9', headRefName: 'other' } ] );
    const host = await fakeHost( claimOnce( prReadyJob ) );

    // WHEN
    const r = await startOnce( host, dir, { BLUEPRINT_STEWARD_GH: gh, BLUEPRINT_GIT_HOST: 'github' } );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( calls().filter( ( argv ) => argv[ 1 ] === 'list' ) ).toHaveLength( 1 );
    expect( calls().filter( ( argv ) => argv[ 1 ] === 'ready' ) ).toEqual( [] );
    const report = reportOf( host, 'jp' );
    expect( report?.status ).toBe( 'done' );
    expect( JSON.parse( report?.result ?? 'null' ) ).toMatchObject( { branch: 'P-1-checkout', state: 'skipped' } );
  } );

  it( 'Given a pr-ready job on a repository that is not on GitHub, when Steward runs it, then it reports skipped and never calls gh', async () => {
    // GIVEN
    const { dir } = makeRepo();
    const { gh, calls } = fakeGh( [ { number: 7, isDraft: true, url: 'https://github.example/o/r/pull/7', headRefName: 'P-1-checkout' } ] );
    const host = await fakeHost( claimOnce( prReadyJob ) );

    // WHEN
    const r = await startOnce( host, dir, { BLUEPRINT_STEWARD_GH: gh, BLUEPRINT_GIT_HOST: 'bitbucket' } );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( calls() ).toEqual( [] );
    const report = reportOf( host, 'jp' );
    expect( report?.status ).toBe( 'done' );
    expect( JSON.parse( report?.result ?? 'null' ) ).toMatchObject( { branch: 'P-1-checkout', state: 'skipped' } );
  } );

  it( 'Given a pr-ready job whose PR is already out of draft, when Steward runs it, then it calls no gh pr ready and reports the PR ready', async () => {
    // GIVEN
    const { dir } = makeRepo();
    const { gh, calls } = fakeGh( [ { number: 7, isDraft: false, url: 'https://github.example/o/r/pull/7', headRefName: 'P-1-checkout' } ] );
    const host = await fakeHost( claimOnce( prReadyJob ) );

    // WHEN
    const r = await startOnce( host, dir, { BLUEPRINT_STEWARD_GH: gh, BLUEPRINT_GIT_HOST: 'github' } );

    // THEN
    expect( r.code, r.stderr ).toBe( 0 );
    expect( calls().filter( ( argv ) => argv[ 1 ] === 'ready' ) ).toEqual( [] );
    expect( reportOf( host, 'jp' )?.status ).toBe( 'done' );
    expect( JSON.parse( reportOf( host, 'jp' )?.result ?? 'null' ) ).toEqual( { branch: 'P-1-checkout', state: 'already-ready', pr: 'https://github.example/o/r/pull/7' } );
  } );
} );

