// Steward's tracker side. A tracker-poll job carries
// a query (payload { boardId, projectKey, designStatusId, jql, fields }), and Steward runs it with the team's own
// Jira credential and reports what Jira answered, each ticket with its raw changelog, judging none of it.
//
// Jira is reached only through a client with this interface, so a handler can be driven by a fake one:
//   search( jql, fields, { nextPageToken } ) -> { issues: [ { key, fields } ], complete, nextPageToken }
//                                             the query's tickets from the token (the first page without one), to the
//                                             last page or the cap; past the cap, the token the next page starts at
//   changelog( issueKey, { since } ) -> { entries: [ raw history entry ], complete }
//                                             the ticket's changelog, oldest first, as Jira sends it, or, past the cap,
//                                             its newest entries back to a change older than `since`
//   comment( issueKey, body ) -> { id }                                   posts `body` on the ticket as it is
//   status( issueKey ) -> statusId | undefined                            the id of the ticket's current status
//   transitions( issueKey ) -> [ { id, to: { id, name } } ]               the transitions the ticket offers now
//   transition( issueKey, transitionId ) -> undefined                     performs that transition on the ticket
//   projectStatuses( projectKey ) -> [ { id, name, statuses: [ { id, name } ] } ]
//                                             the project's work types, each with the statuses of its workflow
//
// A tracker-comment job carries { issueKey, body }; Steward posts the body as it is.
//
// A tracker-transition job carries { issueKey, toStatusId }; Steward picks the transition leading there, since
// transition ids differ per workflow and work type. A tracker-describe job carries { projectKey }; Steward answers the
// project's work types and statuses.

export const TRACKER_POLL_JOB_KIND = 'tracker-poll';
export const TRACKER_COMMENT_JOB_KIND = 'tracker-comment';
export const TRACKER_TRANSITION_JOB_KIND = 'tracker-transition';
export const TRACKER_DESCRIBE_JOB_KIND = 'tracker-describe';

// A search is read page by page, by Jira's nextPageToken, to its last page or SEARCH_PAGE_LIMIT pages, and the report
// says whether it reached the last and, if not, the token it stopped at; a later job's nextPageToken says where to
// resume, so Steward never decides to read further. A changelog longer than
// CHANGELOG_PAGE_LIMIT pages of 100 is read from its newest page back, to a change older than the job's
// changelogSince or to its first entry, at most CHANGELOG_READ_BACK_LIMIT pages;
// with no changelogSince, CHANGELOG_PAGE_LIMIT pages. Reported as complete only when read to its first entry. A Jira
// answering no `total` is read oldest first to the cap, and reported as not complete when the cap stops it.
const SEARCH_PAGE_SIZE = 100;
const SEARCH_PAGE_LIMIT = 20;
const CHANGELOG_PAGE_SIZE = 100;
const CHANGELOG_PAGE_LIMIT = 5;
const CHANGELOG_READ_BACK_LIMIT = 50;

const jiraFailure = ( message, status ) => Object.assign( new Error( message ), { status } );

/**
 * The Jira Cloud REST client over an API token (basic auth of email and token against the site's base URL). A failure
 * names the method, the path without its query (which carries the JQL) and the status, never the credential.
 */
export const createJiraClient = ( { baseUrl, email, apiToken } ) => {
  const authorization = `Basic ${ Buffer.from( `${ email }:${ apiToken }` ).toString( 'base64' ) }`;
  // The path is appended to the base URL, never resolved against it: a service account's scoped token reaches Jira only
  // through the API gateway, https://api.atlassian.com/ex/jira/<cloudId>, whose path `new URL( '/rest/...', base )` drops.
  const at = ( path ) => new URL( `${ baseUrl.replace( /\/+$/, '' ) }${ path }` );
  const get = async ( path, query ) => {
    const response = await fetch( at( `${ path }?${ new URLSearchParams( query ) }` ), {
      headers: { authorization, accept: 'application/json' },
    } );
    if ( !response.ok ) throw jiraFailure( `GET ${ path } failed: ${ response.status }`, response.status );
    return response.json();
  };
  return {
    // /rest/api/2/issue/{key}/comment, whose body is a plain string: v3 would need the text as an Atlassian Document,
    // and Steward would then be reshaping the job's text.
    comment: async ( issueKey, body ) => {
      const path = `/rest/api/2/issue/${ encodeURIComponent( issueKey ) }/comment`;
      const response = await fetch( at( path ), {
        method: 'POST',
        headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify( { body } ),
      } );
      if ( !response.ok ) throw jiraFailure( `POST ${ path } failed: ${ response.status }`, response.status );
      const created = await response.json();
      return { id: typeof created?.id === 'string' ? created.id : undefined };
    },
    status: async ( issueKey ) => {
      const body = await get( `/rest/api/3/issue/${ encodeURIComponent( issueKey ) }`, { fields: 'status' } );
      const id = body?.fields?.status?.id;
      return typeof id === 'string' ? id : undefined;
    },
    transitions: async ( issueKey ) => {
      const body = await get( `/rest/api/3/issue/${ encodeURIComponent( issueKey ) }/transitions`, {} );
      return ( Array.isArray( body?.transitions ) ? body.transitions : [] )
        .filter( ( offered ) => typeof offered?.id === 'string' && typeof offered?.to?.id === 'string' )
        .map( ( offered ) => ( { id: offered.id, to: { id: offered.to.id, name: typeof offered.to.name === 'string' ? offered.to.name : undefined } } ) );
    },
    // Jira answers a performed transition 204 with no body.
    transition: async ( issueKey, transitionId ) => {
      const path = `/rest/api/3/issue/${ encodeURIComponent( issueKey ) }/transitions`;
      const response = await fetch( at( path ), {
        method: 'POST',
        headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify( { transition: { id: transitionId } } ),
      } );
      if ( !response.ok ) throw jiraFailure( `POST ${ path } failed: ${ response.status }`, response.status );
    },
    // /rest/api/3/project/{key}/statuses: one entry per work type (Jira's issue type), each with its workflow's statuses.
    // A status's `name` is translated into Steward's account language; `untranslatedName` is the one the admin set.
    projectStatuses: async ( projectKey ) => {
      const body = await get( `/rest/api/3/project/${ encodeURIComponent( projectKey ) }/statuses`, {} );
      const named = ( item ) => typeof item?.id === 'string' && typeof item?.name === 'string';
      return ( Array.isArray( body ) ? body : [] ).filter( named ).map( ( type ) => ( {
        id: type.id, name: type.name,
        statuses: ( Array.isArray( type.statuses ) ? type.statuses : [] ).filter( named ).map( ( status ) => ( {
          id: status.id, name: typeof status.untranslatedName === 'string' && status.untranslatedName !== '' ? status.untranslatedName : status.name,
        } ) ),
      } ) );
    },
    // /rest/api/3/search/jql, the endpoint Jira Cloud replaced /rest/api/3/search with, paged by nextPageToken, never
    // startAt. A page with no token (absent or empty) is the last.
    search: async ( jql, fields, { nextPageToken: resumeAt } = {} ) => {
      const issues = [];
      let nextPageToken = typeof resumeAt === 'string' && resumeAt !== '' ? resumeAt : undefined;
      for ( let page = 0; page < SEARCH_PAGE_LIMIT; page += 1 ) {
        const body = await get( '/rest/api/3/search/jql', {
          jql, fields: fields.join( ',' ), maxResults: String( SEARCH_PAGE_SIZE ), ...( nextPageToken === undefined ? {} : { nextPageToken } ),
        } );
        issues.push( ...( Array.isArray( body?.issues ) ? body.issues : [] )
          .filter( ( issue ) => typeof issue?.key === 'string' )
          .map( ( issue ) => ( { key: issue.key, fields: issue.fields ?? {} } ) ) );
        if ( typeof body?.nextPageToken !== 'string' || body.nextPageToken === '' ) return { issues, complete: true };
        nextPageToken = body.nextPageToken;
      }
      return { issues, complete: false, nextPageToken };
    },
    changelog: async ( issueKey, { since } = {} ) => {
      const path = `/rest/api/3/issue/${ encodeURIComponent( issueKey ) }/changelog`;
      const pageAt = ( startAt, size = CHANGELOG_PAGE_SIZE ) => get( path, { startAt: String( startAt ), maxResults: String( size ) } );
      const valuesOf = ( body ) => ( Array.isArray( body?.values ) ? body.values : [] );
      const first = await pageAt( 0 );
      if ( !( typeof first?.total === 'number' && first.total > CHANGELOG_PAGE_LIMIT * CHANGELOG_PAGE_SIZE ) ) {
        const entries = [ ...valuesOf( first ) ];
        let body = first;
        for ( let page = 1; page < CHANGELOG_PAGE_LIMIT; page += 1 ) {
          if ( body?.isLast === true || valuesOf( body ).length < CHANGELOG_PAGE_SIZE ) return { entries, complete: true };
          body = await pageAt( page * CHANGELOG_PAGE_SIZE );
          entries.push( ...valuesOf( body ) );
        }
        return { entries, complete: body?.isLast === true || valuesOf( body ).length < CHANGELOG_PAGE_SIZE };
      }
      // Past the cap, the first page only told how long the changelog is: the read starts over at its newest page and
      // goes back a page at a time, to the job's changelogSince, never past a page limit.
      const floor = typeof since === 'string' ? Date.parse( since ) : Number.NaN;
      const limit = Number.isNaN( floor ) ? CHANGELOG_PAGE_LIMIT : CHANGELOG_READ_BACK_LIMIT;
      const pages = [];
      let startAt = first.total;
      for ( let page = 0; page < limit && startAt > 0; page += 1 ) {
        const end = startAt;
        startAt = Math.max( 0, startAt - CHANGELOG_PAGE_SIZE );
        const values = valuesOf( await pageAt( startAt, end - startAt ) );
        pages.unshift( values );
        if ( values.some( ( entry ) => Date.parse( entry?.created ) < floor ) ) break;
      }
      return { entries: pages.flat(), complete: startAt === 0 };
    },
  };
};

/**
 * Runs a tracker-poll job's query through `client` and answers the report: whether the search reached its last page,
 * and each ticket the search found, with its changelog and whether that changelog was read whole. A job whose payload
 * names no query is failed before Jira is called; a credential Jira refuses fails auth-failed.
 */
// A head is named for a ticket when the key stands in it as a whole token:
// not preceded by a letter or digit, not followed by a digit, case-insensitive.
const escaped = ( text ) => text.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
const namedFor = ( key, head ) => new RegExp( `(?:^|[^A-Za-z0-9])${ escaped( key ) }(?![0-9])`, 'i' ).test( head );

export const runTrackerPoll = async ( job, client, { origin } = {} ) => {
  const payload = job?.payload;
  if ( typeof payload?.jql !== 'string' || payload.jql === '' || !Array.isArray( payload.fields ) ) {
    return { ok: false, result: 'the tracker-poll job carried no query; Steward composes none of its own' };
  }
  try {
    // Where the search resumes and how far back a changelog is read come from the job's payload.
    const found = await client.search( payload.jql, payload.fields, { nextPageToken: payload.nextPageToken } );
    const issues = [];
    for ( const issue of found.issues ) {
      const { entries, complete } = await client.changelog( issue.key, { since: payload.changelogSince } );
      issues.push( { ...issue, changelog: entries, changelogComplete: complete } );
    }
    // Origin's heads named for a found ticket, and its default branch, reported with the tickets.
    // `origin()` answers { heads, defaultBranch }; if Steward cannot list origin, it reports neither.
    const listed = origin === undefined ? undefined : await origin().catch( () => undefined );
    const heads = listed?.heads?.filter( ( head ) => issues.some( ( issue ) => namedFor( issue.key, head ) ) );
    return { ok: true, result: JSON.stringify( {
      boardId: payload.boardId, complete: found.complete, ...( found.complete ? {} : { nextPageToken: found.nextPageToken } ), issues,
      ...( heads === undefined ? {} : { heads } ), ...( listed?.defaultBranch ? { defaultBranch: listed.defaultBranch } : {} ),
    } ) };
  } catch ( err ) {
    return { ok: false, ...( err.status === 401 || err.status === 403 ? { reason: 'auth-failed' } : {} ), result: err.message };
  }
};

/**
 * Posts a tracker-comment job's body on its ticket through `client`, as the server composed it. A job whose payload
 * names no ticket or no body is failed before Jira is called; a credential Jira refuses fails auth-failed.
 */
export const runTrackerComment = async ( job, client ) => {
  const payload = job?.payload;
  if ( typeof payload?.issueKey !== 'string' || payload.issueKey === '' || typeof payload?.body !== 'string' || payload.body === '' ) {
    return { ok: false, result: 'the tracker-comment job carried no ticket or no text; Steward composes none of its own' };
  }
  try {
    const posted = await client.comment( payload.issueKey, payload.body );
    return { ok: true, ...( posted?.id === undefined ? {} : { result: JSON.stringify( { commentId: posted.id } ) } ) };
  } catch ( err ) {
    return { ok: false, ...( err.status === 401 || err.status === 403 ? { reason: 'auth-failed' } : {} ), result: err.message };
  }
};

const failed = ( err ) => ( { ok: false, ...( err.status === 401 || err.status === 403 ? { reason: 'auth-failed' } : {} ), result: err.message } );

/**
 * Moves a tracker-transition job's ticket to its status through `client`. A ticket already in that status
 * is done with nothing posted, so a retried job is idempotent; otherwise the transition whose target is that status is
 * posted, and a ticket offering none fails no-transition with the targets it does offer. A job whose payload names no
 * ticket or no status is failed before Jira is called; a credential Jira refuses fails auth-failed.
 */
export const runTrackerTransition = async ( job, client ) => {
  const payload = job?.payload;
  if ( typeof payload?.issueKey !== 'string' || payload.issueKey === '' || typeof payload?.toStatusId !== 'string' || payload.toStatusId === '' ) {
    return { ok: false, result: 'the tracker-transition job carried no ticket or no status; Steward picks none of its own' };
  }
  const { issueKey, toStatusId } = payload;
  try {
    if ( await client.status( issueKey ) === toStatusId ) {
      return { ok: true, result: JSON.stringify( { issueKey, toStatusId, alreadyThere: true } ) };
    }
    const offered = await client.transitions( issueKey );
    const leading = offered.find( ( candidate ) => candidate.to.id === toStatusId );
    if ( leading === undefined ) {
      return { ok: false, reason: 'no-transition', result: JSON.stringify( {
        issueKey, toStatusId, failure: 'no-transition', reachable: offered.map( ( candidate ) => ( { id: candidate.to.id, name: candidate.to.name } ) ),
      } ) };
    }
    await client.transition( issueKey, leading.id );
    return { ok: true, result: JSON.stringify( { issueKey, toStatusId, transitionId: leading.id } ) };
  } catch ( err ) {
    return failed( err );
  }
};

/**
 * Answers a tracker-describe job with its project's work types, each one's id and name and the id and
 * name of every status its workflow holds. A job whose payload names no project is failed before Jira is called; a
 * credential Jira refuses fails auth-failed.
 */
export const runTrackerDescribe = async ( job, client ) => {
  const projectKey = job?.payload?.projectKey;
  if ( typeof projectKey !== 'string' || projectKey === '' ) {
    return { ok: false, result: 'the tracker-describe job carried no project' };
  }
  try {
    return { ok: true, result: JSON.stringify( { projectKey, workTypes: await client.projectStatuses( projectKey ) } ) };
  } catch ( err ) {
    return failed( err );
  }
};

/**
 * The dispatch entries (kind, handler) for the tracker kinds, which bin/blueprint-steward.mjs spreads into its
 * JOB_HANDLERS, passing the credential BLUEPRINT_JIRA_BASE_URL, BLUEPRINT_JIRA_EMAIL and BLUEPRINT_JIRA_API_TOKEN carry.
 * A credential missing any of the three gives none, so Steward's claim then never declares the tracker kinds.
 */
export const trackerJobHandlers = ( { baseUrl, email, apiToken }, { createClient = createJiraClient, origin } = {} ) => {
  const credential = { baseUrl, email, apiToken };
  if ( Object.values( credential ).some( ( value ) => typeof value !== 'string' || value.trim() === '' ) ) return [];
  const client = createClient( credential );
  return [
    [ TRACKER_POLL_JOB_KIND, ( job ) => runTrackerPoll( job, client, { origin } ) ],
    [ TRACKER_COMMENT_JOB_KIND, ( job ) => runTrackerComment( job, client ) ],
    [ TRACKER_TRANSITION_JOB_KIND, ( job ) => runTrackerTransition( job, client ) ],
    [ TRACKER_DESCRIBE_JOB_KIND, ( job ) => runTrackerDescribe( job, client ) ],
  ];
};
