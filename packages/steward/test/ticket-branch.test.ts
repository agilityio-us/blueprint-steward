import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RUNNER_JOB_STEPS } from '@bett3r-dev/blueprint-spec';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrackerPoll } from '../lib/tracker.mjs';
import { METHOD, METHOD_ROUTE, METHOD_ZIP, printInit } from './method-fixture';

/**
 * Steward's ticket-branch job and its step beats, driven through `start --once` against a fake host and a bare git
 * remote. A ticket-branch job creates the branch only when origin lacks it (create-only push with force-with-lease)
 * and reports `created`, or reports `exists` for a branch already there.
 * Every job heartbeats a step at each boundary, the agent's before it is spawned.
 */

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );

type Req = { url: string; body: any; claudeRan: boolean };

const servers: Server[] = [];
afterEach( () => { for ( const s of servers.splice( 0 ) ) s.close(); } );

const fakeHost = async ( job: Record<string, unknown>, claudeRecord?: string ) => {
  const requests: Req[] = [];
  let claimed = false;
  const server = createServer( ( req, res ) => {
    let data = '';
    req.on( 'data', ( c ) => { data += c; } );
    req.on( 'end', () => {
      requests.push( { url: req.url!, body: data ? JSON.parse( data ) : undefined, claudeRan: claudeRecord !== undefined && existsSync( claudeRecord ) } );
      // A design job's method plugin, whose sha256 is the one METHOD names.
      if ( req.method === 'GET' && METHOD_ROUTE.test( req.url! ) ) {
        res.writeHead( 200, { 'Content-Type': 'application/zip' } );
        res.end( METHOD_ZIP );
        return;
      }
      const body = req.url === '/api/blueprint/runner/claim' && !claimed ? ( claimed = true, { job } ) : {};
      res.writeHead( 200, { 'Content-Type': 'application/json' } );
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
  const dir = mkdtempSync( join( tmpdir(), 'blueprint-ticket-branch-repo-' ) );
  writeFileSync( join( dir, '.blueprint.config.json' ), JSON.stringify( { designTooling: { extract: 'mkdir -p .blueprint && echo \'{"nodes":[]}\' > .blueprint/graph.json' } } ) );
  writeFileSync( join( dir, '.gitignore' ), '.blueprint/\n' );
  // Steward's checkout carries Steward's own git identity, as the host's operator configures it.
  execSync( `git init -q -b main && git config user.email steward@example.com && git config user.name Steward && ${ G } add -A && ${ G } commit -qm init`, { cwd: dir } );
  const remote = mkdtempSync( join( tmpdir(), 'blueprint-ticket-branch-remote-' ) );
  execSync( `git init -q --bare ${ remote }` );
  execSync( `git remote add origin ${ remote } && git push -q origin main && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`, { cwd: dir } );
  return { dir, remote };
};
const sha = ( cwd: string, ref: string ) => execSync( `git rev-parse ${ ref }`, { cwd, encoding: 'utf-8' } ).trim();
const remoteHead = ( remote: string, branch: string ) =>
  execSync( `git for-each-ref '--format=%(objectname)' refs/heads/${ branch }`, { cwd: remote, encoding: 'utf-8' } ).trim();

const run = ( args: string[], env: Record<string, string> = {} ) =>
  new Promise<{ code: number | null; stderr: string }>( ( res ) => {
    const child = spawn( process.execPath, [ BIN, ...args ], { env: { ...process.env, BLUEPRINT_STEWARD_TOKEN: '', BLUEPRINT_SESSION_ID: '', BLUEPRINT_JIRA_API_TOKEN: '', ...env } } );
    let stderr = '';
    child.stderr.on( 'data', ( c ) => { stderr += c; } );
    child.on( 'close', ( code ) => { res( { code, stderr } ); } );
  } );

// The fixture owns git's ambient config: no global or system file, so the operator's identity or hooks never decide a
// verdict; Steward's identity is the checkout's own (makeRepo).
const EMPTY_GIT_CONFIG = join( mkdtempSync( join( tmpdir(), 'blueprint-ticket-branch-gitconfig-' ) ), 'config' );
writeFileSync( EMPTY_GIT_CONFIG, '' );
const startOnce = ( host: { url: string }, repo: string, env: Record<string, string> = {} ) =>
  run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', repo, '--once' ], {
    BLUEPRINT_STEWARD_GH: join( tmpdir(), 'no-such-gh-binary' ), GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1', ...env
  } );

// A gh that, like GitHub, refuses a pull request with no commits between its base and its head on origin, and else
// records its argv and prints the PR's URL.
const fakeGh = () => {
  const ghDir = mkdtempSync( join( tmpdir(), 'blueprint-ticket-branch-gh-' ) );
  const record = join( ghDir, 'argv.json' );
  const gh = join( ghDir, 'gh.mjs' );
  writeFileSync( gh, [
    '#!/usr/bin/env node',
    'const { execFileSync } = await import(\'node:child_process\');',
    'const argv = process.argv.slice(2);',
    'const at = (flag) => argv[argv.indexOf(flag) + 1];',
    'execFileSync(\'git\', [\'fetch\', \'-q\', \'origin\']);',
    'const ahead = Number(execFileSync(\'git\', [\'rev-list\', \'--count\', `origin/${at(\'--base\')}..origin/${at(\'--head\')}`], { encoding: \'utf-8\' }).trim());',
    'if (ahead === 0) { console.error(`pull request create failed: GraphQL: No commits between ${at(\'--base\')} and ${at(\'--head\')} (createPullRequest)`); process.exit(1); }',
    `(await import('node:fs')).writeFileSync(${ JSON.stringify( record ) }, JSON.stringify(argv));`,
    'console.log(\'https://github.example/o/r/pull/7\');',
    '',
  ].join( '\n' ) );
  execSync( `chmod +x ${ gh }` );
  return { gh, record };
};

const ticketBranchJob = ( payload: Record<string, unknown> = {} ) => ( {
  id: 'jt', kind: 'ticket-branch', sessionId: 'sess-t',
  payload: { key: 'P-1', title: 'Add a thing', branch: 'P-1-add-a-thing', base: 'main', create: true, draftPr: true, prompt: 'Design ticket P-1', ...payload },
} );
const reportOf = ( host: { requests: Req[] }, id: string ) => host.requests.find( ( q ) => q.url === `/api/blueprint/runner/jobs/${ id }` );
const stepsOf = ( host: { requests: Req[] }, id: string ) =>
  host.requests.filter( ( q ) => q.url === `/api/blueprint/runner/jobs/${ id }/heartbeat` && q.body?.step !== undefined ).map( ( q ) => q.body.step );

describe( 'blueprint-steward: ticket-branch job', () => {
  it( 'a branch origin lacks is created on the base\'s tip and reported created: at the tip itself without draftPr, one empty commit on it with', async () => {
    const { dir, remote } = makeRepo();
    const bare = await fakeHost( ticketBranchJob( { draftPr: false, branch: 'P-1-bare' } ) );
    expect( ( await startOnce( bare, dir ) ).code ).toBe( 0 );
    expect( remoteHead( remote, 'P-1-bare' ) ).toBe( sha( dir, 'main' ) );
    const host = await fakeHost( ticketBranchJob() );
    const r = await startOnce( host, dir );
    expect( r.code, r.stderr ).toBe( 0 );
    expect( sha( remote, `${ remoteHead( remote, 'P-1-add-a-thing' ) }^` ) ).toBe( sha( dir, 'main' ) );
    const report = reportOf( host, 'jt' );
    expect( report?.body.status ).toBe( 'done' );
    expect( JSON.parse( report?.body.result ) ).toEqual( { branch: 'P-1-add-a-thing', state: 'created' } );
    expect( stepsOf( host, 'jt' ) ).toEqual( [ 'branch' ] );
  } );

  it( 'a branch already on origin is left where it is and reported exists', async () => {
    const { dir, remote } = makeRepo();
    execSync( `git checkout -q -b P-1-add-a-thing && echo x > x.txt && ${ G } add x.txt && ${ G } commit -qm x && git push -q origin P-1-add-a-thing && git checkout -q main`, { cwd: dir } );
    const theirs = sha( dir, 'P-1-add-a-thing' );
    const host = await fakeHost( ticketBranchJob( { create: true } ) );
    const r = await startOnce( host, dir );
    expect( r.code, r.stderr ).toBe( 0 );
    expect( remoteHead( remote, 'P-1-add-a-thing' ) ).toBe( theirs );
    const report = reportOf( host, 'jt' );
    expect( report?.body.status ).toBe( 'done' );
    expect( JSON.parse( report?.body.result ) ).toEqual( { branch: 'P-1-add-a-thing', state: 'exists' } );
  } );

  it( 'a branch origin gains between Steward\'s check and its push is left where it is and reported exists (the create-only push loses the race)', async () => {
    const { dir, remote } = makeRepo();
    // Someone else's commit, already on origin under another name, which the race points the ticket's branch at.
    execSync( `git checkout -q -b other && echo y > y.txt && ${ G } add y.txt && ${ G } commit -qm y && git push -q origin other && git checkout -q main`, { cwd: dir } );
    const theirs = sha( dir, 'other' );
    // A git in front of the real one: once Steward has listed origin for the branch and found none, its next fetch
    // is when the other party's push lands, so the ref exists by the time Steward pushes.
    const wrapDir = mkdtempSync( join( tmpdir(), 'blueprint-ticket-branch-git-' ) );
    const realGit = execSync( 'command -v git', { encoding: 'utf-8' } ).trim();
    const listed = join( wrapDir, 'listed' );
    const raced = join( wrapDir, 'raced' );
    writeFileSync( join( wrapDir, 'git' ), [
      '#!/bin/sh',
      `case "$*" in *"ls-remote --heads origin refs/heads/P-1-add-a-thing"*) touch ${ JSON.stringify( listed ) } ;; esac`,
      `if [ "$1" = fetch ] && [ -f ${ JSON.stringify( listed ) } ] && [ ! -f ${ JSON.stringify( raced ) } ]; then`,
      `  touch ${ JSON.stringify( raced ) }; ${ JSON.stringify( realGit ) } --git-dir=${ JSON.stringify( remote ) } update-ref refs/heads/P-1-add-a-thing ${ theirs }`,
      'fi',
      `exec ${ JSON.stringify( realGit ) } "$@"`,
      '',
    ].join( '\n' ) );
    execSync( `chmod +x ${ join( wrapDir, 'git' ) }` );
    const host = await fakeHost( ticketBranchJob() );
    const r = await startOnce( host, dir, { PATH: `${ wrapDir }:${ process.env.PATH }` } );
    expect( r.code, r.stderr ).toBe( 0 );
    expect( existsSync( raced ) ).toBe( true );
    expect( remoteHead( remote, 'P-1-add-a-thing' ) ).toBe( theirs );
    const report = reportOf( host, 'jt' );
    expect( report?.body.status ).toBe( 'done' );
    expect( JSON.parse( report?.body.result ) ).toEqual( { branch: 'P-1-add-a-thing', state: 'exists' } );
  } );

  it( 'with gh configured a draft PR is opened for the branch against the base; its URL is in the report', async () => {
    const { dir, remote } = makeRepo();
    const { gh, record } = fakeGh();
    const host = await fakeHost( ticketBranchJob() );
    const r = await startOnce( host, dir, { BLUEPRINT_STEWARD_GH: gh } );
    expect( r.code, r.stderr ).toBe( 0 );
    const argv = ( existsSync( record ) ? JSON.parse( readFileSync( record, 'utf-8' ) ) : [] ) as string[];
    expect( argv.slice( 0, 3 ) ).toEqual( [ 'pr', 'create', '--draft' ] );
    expect( argv[ argv.indexOf( '--head' ) + 1 ] ).toBe( 'P-1-add-a-thing' );
    expect( argv[ argv.indexOf( '--base' ) + 1 ] ).toBe( 'main' );
    expect( JSON.parse( reportOf( host, 'jt' )?.body.result ) ).toEqual( { branch: 'P-1-add-a-thing', state: 'created', pr: 'https://github.example/o/r/pull/7' } );
    // The branch is one empty commit on the base's tip, named for the ticket; the checkout's own HEAD never moves.
    const tip = remoteHead( remote, 'P-1-add-a-thing' );
    expect( sha( remote, `${ tip }^` ) ).toBe( sha( dir, 'main' ) );
    expect( sha( remote, `${ tip }^{tree}` ) ).toBe( sha( dir, 'main^{tree}' ) );
    expect( execSync( `git log -1 --format=%s ${ tip }`, { cwd: remote, encoding: 'utf-8' } ).trim() ).toContain( 'P-1' );
    expect( execSync( 'git symbolic-ref HEAD', { cwd: dir, encoding: 'utf-8' } ).trim() ).toBe( 'refs/heads/main' );
  } );

  it( 'a gh that refuses the draft PR leaves the branch created and the job done, and the report carries gh\'s refusal', async () => {
    const { dir, remote } = makeRepo();
    const ghDir = mkdtempSync( join( tmpdir(), 'blueprint-ticket-branch-gh-' ) );
    const gh = join( ghDir, 'gh.mjs' );
    writeFileSync( gh, '#!/usr/bin/env node\nconsole.error(\'HTTP 403: Resource not accessible by integration\');\nprocess.exit(1);\n' );
    execSync( `chmod +x ${ gh }` );
    const host = await fakeHost( ticketBranchJob() );
    const r = await startOnce( host, dir, { BLUEPRINT_STEWARD_GH: gh } );
    expect( r.code, r.stderr ).toBe( 0 );
    expect( remoteHead( remote, 'P-1-add-a-thing' ) ).not.toBe( '' );
    const report = reportOf( host, 'jt' );
    expect( report?.body.status ).toBe( 'done' );
    expect( JSON.parse( report?.body.result ) ).toEqual( {
      branch: 'P-1-add-a-thing', state: 'created', prFailed: 'HTTP 403: Resource not accessible by integration'
    } );
  } );
} );

describe( 'blueprint-steward: step beats', () => {
  it( 'a design job beats worktree, extract, push, agent in that order, the agent\'s before claude is spawned', async () => {
    const { dir } = makeRepo();
    const claudeDir = mkdtempSync( join( tmpdir(), 'blueprint-ticket-branch-claude-' ) );
    const record = join( claudeDir, 'ran' );
    const claude = join( claudeDir, 'claude.mjs' );
    writeFileSync( claude, `#!/usr/bin/env node\n(await import('node:fs')).writeFileSync(${ JSON.stringify( record ) }, 'x');\n${ printInit }\nconsole.log('ok');\n` );
    execSync( `chmod +x ${ claude }` );
    const host = await fakeHost( {
      id: 'jd', kind: 'design', sessionId: 'sess-d', branch: 'main', jobKey: 'bpjk_d',
      instructions: { text: 'Served text.', version: 1, sha256: 'a'.repeat( 64 ) }, tools: [ 'mcp__blueprint', 'Read' ], method: METHOD,
    }, record );
    const r = await startOnce( host, dir, { BLUEPRINT_STEWARD_CLAUDE: claude } );
    expect( r.code, r.stderr ).toBe( 0 );
    expect( stepsOf( host, 'jd' ) ).toEqual( [ 'worktree', 'extract', 'push', 'agent' ] );
    // Steward has no step list of its own; its beats, the ticket-branch job's
    // `branch` (above) then these, are exactly the shared RUNNER_JOB_STEPS, and never `intake`.
    expect( [ 'branch', ...stepsOf( host, 'jd' ) ] ).toEqual( [ ...RUNNER_JOB_STEPS ] );
    const agentBeat = host.requests.find( ( q ) => q.body?.step === 'agent' );
    expect( agentBeat?.claudeRan ).toBe( false );
    expect( existsSync( record ) ).toBe( true );
  } );
} );

describe( 'blueprint-steward: tracker-poll reports origin\'s heads', () => {
  it( 'the report carries the heads named with a found ticket\'s key and origin\'s default branch', async () => {
    const client = {
      search: async () => ( { issues: [ { key: 'P-1', fields: {} } ], complete: true } ),
      changelog: async () => ( { entries: [], complete: true } ),
    };
    const origin = async () => ( { heads: [ 'main', 'P-1-add-a-thing', 'feature/p-1', 'P-10-other', 'unrelated' ], defaultBranch: 'main' } );
    const outcome = await runTrackerPoll( { payload: { boardId: 'b1', jql: 'project = P', fields: [ 'summary' ] } }, client, { origin } );
    expect( outcome.ok ).toBe( true );
    const report = JSON.parse( outcome.result );
    expect( report.heads ).toEqual( [ 'P-1-add-a-thing', 'feature/p-1' ] );
    expect( report.defaultBranch ).toBe( 'main' );
  } );
} );
