import { execSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnv } from '../lib/child.mjs';

/**
 * Steward fires a Claude routine for an implementation-dispatch job, with the alias's URL and token read from its own
 * environment, and reports the routine's session URL. Driven through `start --once` against a fake host and a fake
 * routine /fire over real HTTP, so the request the routine receives is the bytes a real one would.
 */

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );
// The routine API's beta header, per code.claude.com/docs/en/routines.
const BETA = 'experimental-cc-routine-2026-04-01';

type Req = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any };

const servers: Server[] = [];
afterEach( () => { for ( const s of servers.splice( 0 ) ) s.close(); } );

/** An HTTP server answering `answer( req )`; every request it receives is recorded with its body as JSON. */
const fakeServer = async ( answer: ( req: Req ) => { status?: number; body?: unknown } ) => {
  const requests: Req[] = [];
  const server = createServer( ( req, res ) => {
    let data = '';
    req.on( 'data', ( c ) => { data += c; } );
    req.on( 'end', () => {
      const r: Req = { method: req.method!, url: req.url!, headers: req.headers, body: data ? JSON.parse( data ) : undefined };
      requests.push( r );
      const { status = 200, body = {} } = answer( r );
      res.writeHead( status, { 'Content-Type': 'application/json' } );
      res.end( JSON.stringify( body ) );
    } );
  } );
  servers.push( server );
  await new Promise<void>( ( r ) => server.listen( 0, '127.0.0.1', () => r() ) );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${ port }`, requests };
};

/** A host that hands out `job` on the first claim and nothing after. */
const fakeHost = ( job: Record<string, unknown> ) => {
  let claimed = false;
  return fakeServer( ( req ) => ( req.url === '/api/blueprint/runner/claim' && !claimed ? ( claimed = true, { body: { job } } ) : {} ) );
};

const makeRepo = () => {
  const dir = mkdtempSync( join( tmpdir(), 'blueprint-routine-dispatch-repo-' ) );
  execSync( 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir } );
  return dir;
};

// The fixture owns the routine and Jira variables: whatever the caller's shell holds is scrubbed, then set per case.
const scrubbed = () => Object.fromEntries( Object.entries( process.env )
  .filter( ( [ name ] ) => !name.startsWith( 'BLUEPRINT_ROUTINE_' ) && !name.startsWith( 'BLUEPRINT_JIRA_' ) && name !== 'BLUEPRINT_STEWARD_TOKEN' && name !== 'BLUEPRINT_SESSION_ID' ) );

const runOnce = ( hostUrl: string, env: Record<string, string> ) => new Promise<{ code: number | null; stderr: string }>( ( res ) => {
  const child = spawn( process.execPath, [ BIN, 'start', '--server', hostUrl, '--token', 'tok', '--repo', makeRepo(), '--once' ], { env: { ...scrubbed(), ...env } } );
  let stderr = '';
  child.stderr.on( 'data', ( c ) => { stderr += c; } );
  child.on( 'close', ( code ) => res( { code, stderr } ) );
} );

const dispatch = ( alias: string ) => ( { id: 'jd', kind: 'implementation-dispatch', sessionId: null, branch: null, prompt: null, payload: { alias, text: 'Implement PROJ-42' } } );
const claimOf = ( host: { requests: Req[] } ) => host.requests.find( ( q ) => q.url === '/api/blueprint/runner/claim' )!;
const reportOf = ( host: { requests: Req[] } ) => host.requests.find( ( q ) => q.url === '/api/blueprint/runner/jobs/jd' )?.body;

const SESSION_URL = 'https://claude.ai/code/session_01PROJ42';

describe( 'blueprint-steward implementation-dispatch', () => {
  it( 'Given a BLUEPRINT_ROUTINE_*_URL and _TOKEN and a job naming it when Steward runs it then the routine /fire receives one POST with the Bearer token, the beta header and {text}, and Steward reports done with the session URL', async () => {
    // GIVEN
    const routine = await fakeServer( () => ( { body: { type: 'routine_fire', claude_code_session_id: 'session_01PROJ42', claude_code_session_url: SESSION_URL } } ) );
    const fire = `${ routine.url }/v1/claude_code/routines/trig_01/fire`;
    const host = await fakeHost( dispatch( 'alpha' ) );

    // WHEN
    const r = await runOnce( host.url, { BLUEPRINT_ROUTINE_ALPHA_URL: fire, BLUEPRINT_ROUTINE_ALPHA_TOKEN: 't0k' } );

    // THEN
    expect( r.code ).toBe( 0 );
    expect( routine.requests.map( ( q ) => [ q.method, q.url, q.headers.authorization, q.headers[ 'anthropic-beta' ], q.body ] ) )
      .toEqual( [ [ 'POST', '/v1/claude_code/routines/trig_01/fire', 'Bearer t0k', BETA, { text: 'Implement PROJ-42' } ] ] );
    const report = reportOf( host );
    expect( report?.status ).toBe( 'done' );
    expect( JSON.parse( report.result ).claude_code_session_url ).toBe( SESSION_URL );
    // The claim declares the kind and the alias it holds, by name; no routine URL or token leaves in a claim, report or log.
    const claim = claimOf( host );
    expect( claim.body.kinds ).toContain( 'implementation-dispatch' );
    expect( claim.body.routineAliases ).toEqual( [ 'alpha' ] );
    for ( const text of [ JSON.stringify( claim.body ), JSON.stringify( report ), r.stderr ] ) {
      expect( [ text.includes( fire ), text.includes( routine.url ), text.includes( 't0k' ) ] ).toEqual( [ false, false, false ] );
    }
  } );

  it( 'Given a routine answering 401 when Steward runs the dispatch then it reports failed with the status and the body', async () => {
    // GIVEN
    const routine = await fakeServer( () => ( { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } } } ) );
    const host = await fakeHost( dispatch( 'alpha' ) );

    // WHEN
    await runOnce( host.url, { BLUEPRINT_ROUTINE_ALPHA_URL: `${ routine.url }/fire`, BLUEPRINT_ROUTINE_ALPHA_TOKEN: 't0k' } );

    // THEN
    expect( routine.requests ).toHaveLength( 1 );
    const report = reportOf( host );
    expect( report?.status ).toBe( 'failed' );
    // Exactly alias, status and body: a non-2xx is reported as the routine answered it, not as a missing session URL.
    expect( JSON.parse( report.result ) ).toEqual( {
      alias: 'alpha', status: 401, body: JSON.stringify( { type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } } ),
    } );
  } );

  it( 'Given a routine answering 200 with no claude_code_session_url when Steward runs the dispatch then it reports failed with the status and the body', async () => {
    // GIVEN
    const routine = await fakeServer( () => ( { status: 200, body: { type: 'routine_fire' } } ) );
    const host = await fakeHost( dispatch( 'alpha' ) );

    // WHEN
    await runOnce( host.url, { BLUEPRINT_ROUTINE_ALPHA_URL: `${ routine.url }/fire`, BLUEPRINT_ROUTINE_ALPHA_TOKEN: 't0k' } );

    // THEN
    expect( routine.requests ).toHaveLength( 1 );
    const report = reportOf( host );
    expect( report?.status ).toBe( 'failed' );
    const failed = JSON.parse( report.result );
    expect( [ failed.alias, failed.status, failed.body, failed.claude_code_session_url ] ).toEqual( [ 'alpha', 200, JSON.stringify( { type: 'routine_fire' } ), undefined ] );
  } );

  // fetch's own message for an unparsable URL quotes the URL, so a report or log built from it would carry the URL out.
  it.each( [
    [ 'unparsable, carrying a marker', async () => 'not a url/SECRET-MARK' ],
    [ 'pointing at an unreachable port', async () => {
      // A port that was just listened on and closed: nothing answers it.
      const gone = await fakeServer( () => ( {} ) );
      const s = servers.pop()!;
      await new Promise<void>( ( r ) => s.close( () => r() ) );
      return `${ gone.url }/fire?SECRET-MARK`;
    } ],
  ] )( 'Given a BLUEPRINT_ROUTINE_*_URL %s when Steward runs the dispatch then it reports failed naming the alias, and neither the report nor stderr carries the URL, the marker or the token', async ( _, makeUrl ) => {
    // GIVEN
    const fire = await makeUrl();
    const host = await fakeHost( dispatch( 'alpha' ) );

    // WHEN
    const r = await runOnce( host.url, { BLUEPRINT_ROUTINE_ALPHA_URL: fire, BLUEPRINT_ROUTINE_ALPHA_TOKEN: 'TOKEN-MARK' } );

    // THEN
    const report = reportOf( host );
    expect( report?.status ).toBe( 'failed' );
    expect( JSON.parse( report.result ).alias ).toBe( 'alpha' );
    for ( const text of [ JSON.stringify( report ), r.stderr ] ) {
      expect( [ text.includes( fire ), text.includes( 'SECRET-MARK' ), text.includes( 'TOKEN-MARK' ) ] ).toEqual( [ false, false, false ] );
    }
  } );

  it( 'Given a BLUEPRINT_ROUTINE_*_URL with no _TOKEN when Steward runs a job naming it then it reports failed naming the alias and sends no request', async () => {
    // GIVEN: a whole pair for another alias, so Steward runs the kind at all; this one holds only the URL half.
    const routine = await fakeServer( () => ( { body: { claude_code_session_url: SESSION_URL } } ) );
    const host = await fakeHost( dispatch( 'alpha' ) );

    // WHEN
    await runOnce( host.url, {
      BLUEPRINT_ROUTINE_ALPHA_URL: `${ routine.url }/fire`,
      BLUEPRINT_ROUTINE_BETA_URL: `${ routine.url }/beta`, BLUEPRINT_ROUTINE_BETA_TOKEN: 't0k',
    } );

    // THEN
    expect( claimOf( host ).body.routineAliases ).toEqual( [ 'beta' ] );
    const report = reportOf( host );
    expect( report?.status ).toBe( 'failed' );
    expect( JSON.parse( report.result ).alias ).toBe( 'alpha' );
    expect( report.result ).toContain( 'holds no routine for alias alpha' );
    expect( routine.requests ).toEqual( [] );
  } );

  it( 'Given Steward with no BLUEPRINT_ROUTINE_* pair for an alias and a job naming it when it runs the job then it reports failed naming the alias and sends no request', async () => {
    // GIVEN
    const routine = await fakeServer( () => ( {} ) );
    const host = await fakeHost( dispatch( 'beta' ) );

    // WHEN
    await runOnce( host.url, { BLUEPRINT_ROUTINE_ALPHA_URL: `${ routine.url }/fire`, BLUEPRINT_ROUTINE_ALPHA_TOKEN: 't0k' } );

    // THEN
    const report = reportOf( host );
    expect( report?.status ).toBe( 'failed' );
    expect( report.result ).toContain( 'beta' );
    expect( routine.requests ).toEqual( [] );
  } );

  it( 'Given an environment holding a BLUEPRINT_ROUTINE_*_URL and _TOKEN when a child environment is made then it holds no BLUEPRINT_ROUTINE_* variable and keeps the others', () => {
    // GIVEN
    const env = { PATH: '/usr/bin', BLUEPRINT_ROUTINE_ALPHA_URL: 'https://api.example/fire', BLUEPRINT_ROUTINE_ALPHA_TOKEN: 't0k', BLUEPRINT_ROUTINEX: 'kept' };

    // WHEN
    const child = childEnv( env );

    // THEN
    expect( Object.keys( child ).filter( ( name ) => name.startsWith( 'BLUEPRINT_ROUTINE_' ) ) ).toEqual( [] );
    expect( child ).toEqual( { PATH: '/usr/bin', BLUEPRINT_ROUTINEX: 'kept' } );
  } );
} );
