import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createJiraClient, runTrackerPoll, trackerJobHandlers } from '../lib/tracker.mjs';

/**
 * Steward's tracker side. Steward with the whole Jira credential declares tracker-poll and
 * runs the query the job carries; without it, it declares nothing. The Jira client is driven against a fixture
 * Jira over real HTTP, so its paths, query and credential are the bytes a real Jira would receive.
 */

type Seen = { method: string; path: string; query: Record<string, string>; authorization: string | undefined };

const servers: Server[] = [];
afterEach( async () => {
  await Promise.all( servers.splice( 0 ).map( server => new Promise( resolve => server.close( resolve ))));
} );

/** A fixture Jira answering `answer( path, query )` as JSON; every request it receives is recorded in `seen`. */
const fixtureJira = async ( answer: ( path: string, query: Record<string, string>, method: string ) => { status?: number; body: unknown } ) => {
  const seen: Seen[] = [];
  // Each request's body, as the bytes arrived, beside `seen`: only a comment carries one.
  const bodies: { contentType: string | undefined; text: string }[] = [];
  const server = createServer(( req: IncomingMessage, res ) => {
    const url = new URL( req.url ?? '/', 'http://jira.invalid' );
    const query = Object.fromEntries( url.searchParams );
    seen.push( { method: req.method ?? '', path: url.pathname, query, authorization: req.headers.authorization } );
    const chunks: Buffer[] = [];
    req.on( 'data', ( chunk: Buffer ) => { chunks.push( chunk ); } );
    req.on( 'end', () => {
      bodies.push( { contentType: req.headers[ 'content-type' ], text: Buffer.concat( chunks ).toString( 'utf8' ) } );
      const { status = 200, body } = answer( url.pathname, query, req.method ?? '' );
      res.writeHead( status, { 'content-type': 'application/json' } );
      res.end( JSON.stringify( body ));
    } );
  } );
  servers.push( server );
  await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ));
  return { baseUrl: `http://127.0.0.1:${ ( server.address() as AddressInfo ).port }`, seen, bodies };
};

const POLL = {
  id: 'job-1', kind: 'tracker-poll', sessionId: 'session-r',
  payload: { boardId: 'board-1', projectKey: 'P', designStatusId: '10001', jql: 'project = "P" AND updated >= -15m ORDER BY updated ASC', fields: [ 'summary', 'status' ] }
};

const CREDENTIAL = { email: 'bot@example.com', apiToken: 'jira-token' };

describe( 'blueprint-steward tracker kinds', () => {
  it( 'Given a Jira credential whole and missing a part when the tracker handlers are built then only the whole credential declares tracker-poll, tracker-comment, tracker-transition and tracker-describe', () => {
    const full = { baseUrl: 'https://acme.atlassian.net', ...CREDENTIAL };

    expect( trackerJobHandlers( full ).map(( [ kind ] ) => kind )).toEqual( [ 'tracker-poll', 'tracker-comment', 'tracker-transition', 'tracker-describe' ] );
    expect( trackerJobHandlers( {} )).toEqual( [] );
    expect( trackerJobHandlers( { ...full, apiToken: '' } )).toEqual( [] );
    expect( trackerJobHandlers( { ...full, baseUrl: undefined } )).toEqual( [] );
  } );

  it( 'Given a tracker-poll job and a Jira holding P-1 with a two-page changelog when the handler runs then it searches the payload\'s query with basic auth and reports P-1 with its whole raw changelog', async () => {
    // GIVEN
    const history = ( id: number ) => ( { id: String( id ), items: [ { field: 'status', from: '1', to: '10001' } ] } );
    const firstPage = Array.from( { length: 100 }, ( _, index ) => history( index ));
    const jira = await fixtureJira(( path, query ) => {
      if ( path === '/rest/api/3/search/jql' ) return { body: { issues: [ { key: 'P-1', fields: { summary: 'Checkout' } } ], isLast: true } };
      if ( path === '/rest/api/3/issue/P-1/changelog' )
        return { body: query.startAt === '0' ? { values: firstPage, isLast: false } : { values: [ history( 100 ) ], isLast: true } };
      return { status: 404, body: {} };
    } );
    const [ [ , handler ] ] = trackerJobHandlers( { baseUrl: jira.baseUrl, ...CREDENTIAL } );

    // WHEN
    const outcome = await handler( POLL );

    // THEN
    expect( outcome.ok ).toBe( true );
    const reported = JSON.parse( outcome.result );
    expect( { boardId: reported.boardId, complete: reported.complete } ).toEqual( { boardId: 'board-1', complete: true } );
    expect( reported.issues.map(( issue: { key: string; fields: unknown; changelog: unknown[]; changelogComplete: boolean } ) => [ issue.key, issue.fields, issue.changelog.length, issue.changelogComplete ] ))
      .toEqual( [ [ 'P-1', { summary: 'Checkout' }, 101, true ] ] );
    expect( jira.seen[ 0 ] ).toEqual( {
      method: 'GET', path: '/rest/api/3/search/jql',
      query: { jql: 'project = "P" AND updated >= -15m ORDER BY updated ASC', fields: 'summary,status', maxResults: '100' },
      authorization: `Basic ${ Buffer.from( 'bot@example.com:jira-token' ).toString( 'base64' ) }`
    } );
    expect( jira.seen.slice( 1 ).map( request => [ request.path, request.query.startAt ] )).toEqual( [
      [ '/rest/api/3/issue/P-1/changelog', '0' ], [ '/rest/api/3/issue/P-1/changelog', '100' ]
    ] );
  } );

  it( 'Given a search answering two pages, the first with a nextPageToken, when the handler runs then it reads both pages by the token and reports every ticket, complete', async () => {
    // GIVEN
    const jira = await fixtureJira(( path, query ) => {
      if ( path === '/rest/api/3/search/jql' )
        return { body: query.nextPageToken === undefined
          ? { issues: [ { key: 'P-2', fields: {} } ], nextPageToken: 'page-2', isLast: false }
          : { issues: [ { key: 'P-1', fields: {} } ], isLast: true } };
      return { body: { values: [], isLast: true } };
    } );

    // WHEN
    const outcome = await runTrackerPoll( POLL, createJiraClient( { baseUrl: jira.baseUrl, ...CREDENTIAL } ));

    // THEN
    const reported = JSON.parse( outcome.result );
    expect( { complete: reported.complete, keys: reported.issues.map(( issue: { key: string } ) => issue.key ) } ).toEqual( { complete: true, keys: [ 'P-2', 'P-1' ] } );
    expect( jira.seen.filter( request => request.path === '/rest/api/3/search/jql' ).map( request => request.query.nextPageToken )).toEqual( [ undefined, 'page-2' ] );
  } );

  it( 'Given a search that always offers another page when the handler runs then it stops at 20 pages and reports the tickets read as not complete', async () => {
    // GIVEN
    let page = 0;
    const jira = await fixtureJira(( path ) => {
      if ( path === '/rest/api/3/search/jql' ) {
        page += 1;
        return { body: { issues: [ { key: `P-${ page }`, fields: {} } ], nextPageToken: `page-${ page + 1 }`, isLast: false } };
      }
      return { body: { values: [], isLast: true } };
    } );

    // WHEN
    const outcome = await runTrackerPoll( POLL, createJiraClient( { baseUrl: jira.baseUrl, ...CREDENTIAL } ));

    // THEN
    const reported = JSON.parse( outcome.result );
    expect( { ok: outcome.ok, complete: reported.complete, read: reported.issues.length } ).toEqual( { ok: true, complete: false, read: 20 } );
    expect( jira.seen.filter( request => request.path === '/rest/api/3/search/jql' ).length ).toBe( 20 );
  } );

  it( 'Given a ticket with 750 changes and a job with no changelogSince when the handler runs then it reads the newest 500, newest page first, the tail its newest move is in, and reports that changelog as not complete', async () => {
    // GIVEN
    const history = ( id: number ) => ( { id: String( id ), items: [ { field: 'summary', from: null, to: null } ] } );
    const jira = await fixtureJira(( path, query ) => {
      if ( path === '/rest/api/3/search/jql' ) return { body: { issues: [ { key: 'P-1', fields: {} } ], isLast: true } };
      const startAt = Number( query.startAt );
      const values = Array.from( { length: Math.max( 0, Math.min( 100, 750 - startAt )) }, ( _, index ) => history( startAt + index ));
      return { body: { startAt, maxResults: 100, total: 750, isLast: startAt + values.length >= 750, values } };
    } );

    // WHEN
    const outcome = await runTrackerPoll( POLL, createJiraClient( { baseUrl: jira.baseUrl, ...CREDENTIAL } ));

    // THEN
    const [ issue ] = JSON.parse( outcome.result ).issues as { changelog: { id: string }[]; changelogComplete: boolean }[];
    expect( { read: issue?.changelog.length, oldest: issue?.changelog[ 0 ]?.id, newest: issue?.changelog.at( -1 )?.id, complete: issue?.changelogComplete } )
      .toEqual( { read: 500, oldest: '250', newest: '749', complete: false } );
    expect( jira.seen.filter( request => request.path.endsWith( '/changelog' )).map( request => request.query.startAt )).toEqual( [ '0', '650', '550', '450', '350', '250' ] );
  } );

  // The job says where a poll resumes and how far back a changelog is read; Steward passes both through as paging
  // bounds.
  it( 'Given a job carrying a nextPageToken and a search that always offers another page when the handler runs then its first request resumes at that token, and the report names the token it stopped at', async () => {
    // GIVEN
    let page = 0;
    const jira = await fixtureJira(( path ) => {
      if ( path === '/rest/api/3/search/jql' ) {
        page += 1;
        return { body: { issues: [ { key: `P-${ page }`, fields: {} } ], nextPageToken: `page-${ page + 21 }`, isLast: false } };
      }
      return { body: { values: [], isLast: true } };
    } );

    // WHEN
    const outcome = await runTrackerPoll( { ...POLL, payload: { ...POLL.payload, nextPageToken: 'page-21' } }, createJiraClient( { baseUrl: jira.baseUrl, ...CREDENTIAL } ));

    // THEN
    const reported = JSON.parse( outcome.result );
    expect( { complete: reported.complete, nextPageToken: reported.nextPageToken } ).toEqual( { complete: false, nextPageToken: 'page-41' } );
    expect( jira.seen.find( request => request.path === '/rest/api/3/search/jql' )?.query.nextPageToken ).toBe( 'page-21' );
  } );

  it( 'Given a job carrying changelogSince and a ticket with 750 changes, one a minute, the oldest 50 before it, when the handler runs then it reads back from the newest page until a change before changelogSince, and reports the changelog whole', async () => {
    // GIVEN
    const origin = Date.parse( '2026-09-10T00:00:00.000Z' );
    const history = ( id: number ) => ( { id: String( id ), created: new Date( origin + id * 60_000 ).toISOString(), items: [ { field: 'summary', from: null, to: null } ] } );
    const jira = await fixtureJira(( path, query ) => {
      if ( path === '/rest/api/3/search/jql' ) return { body: { issues: [ { key: 'P-1', fields: {} } ], isLast: true } };
      const startAt = Number( query.startAt );
      const size = Number( query.maxResults );
      const values = Array.from( { length: Math.max( 0, Math.min( size, 750 - startAt )) }, ( _, index ) => history( startAt + index ));
      return { body: { startAt, maxResults: size, total: 750, isLast: startAt + values.length >= 750, values } };
    } );
    const since = new Date( origin + 50 * 60_000 ).toISOString();

    // WHEN
    const outcome = await runTrackerPoll( { ...POLL, payload: { ...POLL.payload, changelogSince: since } }, createJiraClient( { baseUrl: jira.baseUrl, ...CREDENTIAL } ));

    // THEN
    const [ issue ] = JSON.parse( outcome.result ).issues as { changelog: { id: string }[]; changelogComplete: boolean }[];
    expect( { read: issue?.changelog.length, oldest: issue?.changelog[ 0 ]?.id, newest: issue?.changelog.at( -1 )?.id, complete: issue?.changelogComplete } )
      .toEqual( { read: 750, oldest: '0', newest: '749', complete: true } );
  } );

  it( 'Given a Jira that refuses the credential when the handler runs then the job fails auth-failed, and a job with no query fails before Jira is called', async () => {
    const jira = await fixtureJira(() => ( { status: 401, body: {} } ));
    const client = createJiraClient( { baseUrl: jira.baseUrl, email: 'bot@example.com', apiToken: 'wrong' } );

    expect( await runTrackerPoll( POLL, client )).toMatchObject( { ok: false, reason: 'auth-failed' } );
    const asked = jira.seen.length;
    expect( await runTrackerPoll( { ...POLL, payload: {} }, client )).toMatchObject( { ok: false } );
    expect( jira.seen.length ).toBe( asked );
  } );

  // A tracker-comment's body is posted as it is, through the client.
  const COMMENT = {
    id: 'job-2', kind: 'tracker-comment', sessionId: 'session-p1',
    payload: { issueKey: 'P-1', body: 'Blueprint is preparing a design session for P-1: https://blueprint.example/s/s-1. (Open it with your Blueprint account.)' }
  };

  /** A Jira client that only records: the tracker handlers' interface, with no Jira behind it. */
  const fakeJira = () => {
    const posted: [ string, string ][] = [];
    return {
      posted,
      client: {
        search: async () => { throw new Error( 'a comment job searches nothing' ); },
        changelog: async () => { throw new Error( 'a comment job reads no changelog' ); },
        comment: async ( issueKey: string, body: string ) => { posted.push( [ issueKey, body ] ); return { id: '10500' }; }
      }
    };
  };

  it( 'Given a tracker-comment job and a fake Jira client when the tracker-comment handler runs then it posts the payload\'s body on the payload\'s ticket, once, and reports done', async () => {
    // GIVEN
    const jira = fakeJira();
    const handler = new Map( trackerJobHandlers( { baseUrl: 'https://acme.atlassian.net', ...CREDENTIAL }, { createClient: () => jira.client } )).get( 'tracker-comment' );

    // WHEN
    const outcome = await handler!( COMMENT );

    // THEN
    expect( jira.posted ).toEqual( [ [ 'P-1', COMMENT.payload.body ] ] );
    expect( outcome.ok ).toBe( true );
  } );

  it( 'Given a tracker-comment job with no ticket or no body when the handler runs then it fails before Jira is called; a Jira refusing the credential fails it auth-failed', async () => {
    // GIVEN
    const jira = fakeJira();
    const handler = new Map( trackerJobHandlers( { baseUrl: 'https://acme.atlassian.net', ...CREDENTIAL }, { createClient: () => jira.client } )).get( 'tracker-comment' );
    const refusing = await fixtureJira(() => ( { status: 401, body: {} } ));
    const refused = new Map( trackerJobHandlers( { baseUrl: refusing.baseUrl, ...CREDENTIAL } )).get( 'tracker-comment' );

    // WHEN
    const outcomes = [
      await handler!( { ...COMMENT, payload: { body: COMMENT.payload.body } } ),
      await handler!( { ...COMMENT, payload: { issueKey: 'P-1', body: '' } } ),
      await refused!( COMMENT )
    ];

    // THEN
    expect( jira.posted ).toEqual( [] );
    expect( outcomes.map( outcome => [ outcome.ok, outcome.reason ] )).toEqual( [ [ false, undefined ], [ false, undefined ], [ false, 'auth-failed' ] ] );
  } );

  it( 'Given a fixture Jira when the client comments on P-1 then it POSTs the text as the comment body to the ticket\'s comment resource, with basic auth', async () => {
    // GIVEN
    const jira = await fixtureJira(() => ( { status: 201, body: { id: '10500' } } ));

    // WHEN
    await createJiraClient( { baseUrl: jira.baseUrl, ...CREDENTIAL } ).comment( 'P-1', COMMENT.payload.body );

    // THEN
    expect( jira.seen ).toEqual( [ {
      method: 'POST', path: '/rest/api/2/issue/P-1/comment', query: {},
      authorization: `Basic ${ Buffer.from( 'bot@example.com:jira-token' ).toString( 'base64' ) }`
    } ] );
    expect( { contentType: jira.bodies[ 0 ]?.contentType, body: JSON.parse( jira.bodies[ 0 ]?.text ?? 'null' ) } )
      .toEqual( { contentType: 'application/json', body: { body: COMMENT.payload.body } } );
  } );

  it( 'Given a base URL with a path, as the API gateway a service account\'s token needs, when the client searches, reads a changelog and comments then every request keeps that path', async () => {
    // GIVEN
    const jira = await fixtureJira(( path ) => ( path.endsWith( '/comment' ) ? { status: 201, body: { id: '1' } } : { body: { issues: [], values: [], isLast: true } } ));
    const client = createJiraClient( { baseUrl: `${ jira.baseUrl }/ex/jira/cloud-1/`, ...CREDENTIAL } );

    // WHEN
    await client.search( 'project = P', [ 'summary' ] );
    await client.changelog( 'P-1' );
    await client.comment( 'P-1', 'hello' );

    // THEN
    expect( jira.seen.map( seen => seen.path )).toEqual( [
      '/ex/jira/cloud-1/rest/api/3/search/jql', '/ex/jira/cloud-1/rest/api/3/issue/P-1/changelog', '/ex/jira/cloud-1/rest/api/2/issue/P-1/comment'
    ] );
  } );
  // A tracker-transition job names the status, never a transition id, which differs per workflow; Steward reads the
  // ticket's status first, so a retried move posts nothing.
  const TRANSITION = { id: 'job-3', kind: 'tracker-transition', sessionId: 'session-p42', payload: { issueKey: 'PROJ-42', toStatusId: '10002' } };
  const BASIC = `Basic ${ Buffer.from( 'bot@example.com:jira-token' ).toString( 'base64' ) }`;

  /** A fixture Jira holding PROJ-42 in `statusId`, offering `transitions`; a POST of a transition answers 204. */
  const workflowJira = ( statusId: string, transitions: { id: string; name: string; to: { id: string; name: string } }[] ) => fixtureJira(( path, _query, method ) => {
    if ( path === '/rest/api/3/issue/PROJ-42' ) return { body: { key: 'PROJ-42', fields: { status: { id: statusId, name: 'Current' } } } };
    if ( path === '/rest/api/3/issue/PROJ-42/transitions' ) return method === 'POST' ? { status: 204, body: null } : { body: { transitions } };
    return { status: 404, body: {} };
  } );
  /** The handler Steward dispatches `kind` to; a kind it holds none for fails kind-unknown, as JOB_HANDLERS' caller does. */
  type Outcome = { ok: boolean; reason?: string; result?: string };
  const handlerFor = ( baseUrl: string, kind: string ): ( ( job: unknown ) => Promise<Outcome> ) =>
    new Map( trackerJobHandlers( { baseUrl, ...CREDENTIAL } )).get( kind ) ?? ( async () => ( { ok: false, reason: 'kind-unknown', result: JSON.stringify( { kind } ) } ));
  const transitionHandler = ( baseUrl: string ) => handlerFor( baseUrl, 'tracker-transition' );

  it( 'Given PROJ-42 in status 10001 offering transition 31 to 10002 when a tracker-transition {PROJ-42, 10002} job runs then Steward POSTs transition 31, with basic auth, and reports done', async () => {
    // GIVEN
    const jira = await workflowJira( '10001', [
      { id: '21', name: 'Back to do', to: { id: '10000', name: 'To Do' } },
      { id: '31', name: 'Review', to: { id: '10002', name: 'In Review' } }
    ] );

    // WHEN
    const outcome = await transitionHandler( jira.baseUrl )( TRANSITION );

    // THEN
    const posts = jira.seen.flatMap(( request, index ) => ( request.method === 'POST' ? [ { ...request, body: JSON.parse( jira.bodies[ index ]?.text ?? 'null' ) } ] : [] ));
    expect( posts ).toEqual( [ { method: 'POST', path: '/rest/api/3/issue/PROJ-42/transitions', query: {}, authorization: BASIC, body: { transition: { id: '31' } } } ] );
    expect( { ok: outcome.ok, reason: outcome.reason, result: JSON.parse( outcome.result ?? 'null' ) } )
      .toEqual( { ok: true, reason: undefined, result: { issueKey: 'PROJ-42', toStatusId: '10002', transitionId: '31' } } );
  } );

  it( 'Given PROJ-42 already in status 10002 when a tracker-transition {PROJ-42, 10002} job runs then Steward posts nothing and reports done', async () => {
    // GIVEN
    const jira = await workflowJira( '10002', [ { id: '31', name: 'Review', to: { id: '10002', name: 'In Review' } } ] );

    // WHEN
    const outcome = await transitionHandler( jira.baseUrl )( TRANSITION );

    // THEN
    expect( jira.seen.filter( request => request.method === 'POST' )).toEqual( [] );
    expect( { ok: outcome.ok, result: JSON.parse( outcome.result ?? 'null' ) } )
      .toEqual( { ok: true, result: { issueKey: 'PROJ-42', toStatusId: '10002', alreadyThere: true } } );
  } );

  it( 'Given no transition of PROJ-42 reaches 10002 when the job runs then it fails no-transition, posts nothing, and its result lists the reachable target ids', async () => {
    // GIVEN
    const jira = await workflowJira( '10001', [
      { id: '21', name: 'Back to do', to: { id: '10000', name: 'To Do' } },
      { id: '41', name: 'Ship', to: { id: '10003', name: 'Done' } }
    ] );

    // WHEN
    const outcome = await transitionHandler( jira.baseUrl )( TRANSITION );

    // THEN
    expect( jira.seen.filter( request => request.method === 'POST' )).toEqual( [] );
    expect( { ok: outcome.ok, reason: outcome.reason, result: JSON.parse( outcome.result ?? 'null' ) } ).toEqual( {
      ok: false, reason: 'no-transition',
      result: { issueKey: 'PROJ-42', toStatusId: '10002', failure: 'no-transition', reachable: [ { id: '10000', name: 'To Do' }, { id: '10003', name: 'Done' } ] }
    } );
  } );

  it( 'Given a tracker-transition job with no ticket or no status when it runs then it fails before Jira is called; a Jira refusing the credential fails it auth-failed', async () => {
    // GIVEN
    const jira = await workflowJira( '10001', [] );
    const refusing = await fixtureJira(() => ( { status: 401, body: {} } ));

    // WHEN
    const outcomes = [
      await transitionHandler( jira.baseUrl )( { ...TRANSITION, payload: { issueKey: 'PROJ-42' } } ),
      await transitionHandler( jira.baseUrl )( { ...TRANSITION, payload: { issueKey: '', toStatusId: '10002' } } ),
      await transitionHandler( refusing.baseUrl )( TRANSITION )
    ];

    // THEN
    expect( jira.seen ).toEqual( [] );
    expect( outcomes.map( outcome => [ outcome.ok, outcome.reason ] )).toEqual( [ [ false, undefined ], [ false, undefined ], [ false, 'auth-failed' ] ] );
    expect( outcomes[ 2 ]?.result ).not.toContain( 'jira-token' );
  } );

  // Steward answers a project's work types and the statuses each one's workflow holds, ids and names, from Jira's
  // per-project statuses resource.
  it( 'Given project PROJ with work types Story and Bug when a tracker-describe {PROJ} job runs then it reports each work type\'s id and name with its statuses\' ids and names', async () => {
    // GIVEN
    const jira = await fixtureJira(( path ) => ( path === '/rest/api/3/project/PROJ/statuses'
      ? { body: [
        { id: '10001', name: 'Story', subtask: false, self: 'https://acme.atlassian.net/rest/api/3/issuetype/10001', statuses: [
          { id: '10000', name: 'To Do', statusCategory: { key: 'new' } }, { id: '10002', name: 'In Review', statusCategory: { key: 'indeterminate' } }
        ] },
        { id: '10004', name: 'Bug', subtask: false, statuses: [ { id: '10000', name: 'To Do' }, { id: '10003', name: 'Done' } ] }
      ] }
      : { status: 404, body: {} } ));
    const handler = handlerFor( jira.baseUrl, 'tracker-describe' );

    // WHEN
    const outcome = await handler( { id: 'job-4', kind: 'tracker-describe', sessionId: 'session-r', payload: { projectKey: 'PROJ' } } );

    // THEN
    expect( { ok: outcome.ok, result: JSON.parse( outcome.result ?? 'null' ) } ).toEqual( { ok: true, result: { projectKey: 'PROJ', workTypes: [
      { id: '10001', name: 'Story', statuses: [ { id: '10000', name: 'To Do' }, { id: '10002', name: 'In Review' } ] },
      { id: '10004', name: 'Bug', statuses: [ { id: '10000', name: 'To Do' }, { id: '10003', name: 'Done' } ] }
    ] } } );
    expect( jira.seen.map( request => [ request.method, request.path, request.authorization ] )).toEqual( [ [ 'GET', '/rest/api/3/project/PROJ/statuses', BASIC ] ] );
  } );

  // Jira translates `name` into Steward's account's language when a status carries a translation; `untranslatedName`
  // is the name the admin set, so the board reads the same whoever Steward signs in as.
  it( 'Given PROJ\'s statuses translated for Steward\'s account when a tracker-describe {PROJ} job runs then it reports each status\'s untranslated name, and `name` where Jira sends none', async () => {
    // GIVEN
    const jira = await fixtureJira(( path ) => ( path === '/rest/api/3/project/PROJ/statuses'
      ? { body: [
        { id: '10001', name: 'Story', statuses: [
          { id: '3', name: '正在进行', untranslatedName: 'In Progress' }, { id: '10320', name: '已完成', untranslatedName: 'Done' },
          { id: '10318', name: 'Needs A Human' }, { id: '10319', name: 'Ready For Review', untranslatedName: '' }
        ] }
      ] }
      : { status: 404, body: {} } ));
    const handler = handlerFor( jira.baseUrl, 'tracker-describe' );

    // WHEN
    const outcome = await handler( { id: 'job-5', kind: 'tracker-describe', sessionId: 'session-r', payload: { projectKey: 'PROJ' } } );

    // THEN
    expect( { ok: outcome.ok, result: JSON.parse( outcome.result ?? 'null' ) } ).toEqual( { ok: true, result: { projectKey: 'PROJ', workTypes: [
      { id: '10001', name: 'Story', statuses: [
        { id: '3', name: 'In Progress' }, { id: '10320', name: 'Done' }, { id: '10318', name: 'Needs A Human' }, { id: '10319', name: 'Ready For Review' }
      ] }
    ] } } );
  } );

  it( 'Given a tracker-describe job with no project when it runs then it fails before Jira is called; a Jira refusing the credential fails it auth-failed', async () => {
    // GIVEN
    const jira = await fixtureJira(() => ( { body: [] } ));
    const refusing = await fixtureJira(() => ( { status: 403, body: {} } ));
    const describeWith = ( baseUrl: string ) => handlerFor( baseUrl, 'tracker-describe' );

    // WHEN
    const outcomes = [
      await describeWith( jira.baseUrl )( { id: 'job-5', kind: 'tracker-describe', payload: {} } ),
      await describeWith( refusing.baseUrl )( { id: 'job-6', kind: 'tracker-describe', payload: { projectKey: 'PROJ' } } )
    ];

    // THEN
    expect( jira.seen ).toEqual( [] );
    expect( outcomes.map( outcome => [ outcome.ok, outcome.reason ] )).toEqual( [ [ false, undefined ], [ false, 'auth-failed' ] ] );
  } );
} );
