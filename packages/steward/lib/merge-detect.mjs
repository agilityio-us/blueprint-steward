// Host-API merge detection for Steward's merge poller. Ancestry cannot see a squash
// or rebase merge, so the poller asks the git host instead, with the team's own credentials
// (the Blueprint server holds none). No credentials means no adapter: the caller degrades to ancestry-only.
import { runQueued } from './child.mjs';
import { stewardEnv } from './env.mjs';

const hostOf = ( remoteUrl, env ) => {
  if ( env.BLUEPRINT_GIT_HOST ) return env.BLUEPRINT_GIT_HOST;
  if ( /github\.com[:/]/.test( remoteUrl ?? '' ) ) return 'github';
  if ( /bitbucket\.org[:/]/.test( remoteUrl ?? '' ) ) return 'bitbucket';
  return undefined;
};

// GitHub through the team's `gh` (BLUEPRINT_STEWARD_GH overrides the binary). Authenticated iff
// `gh auth status` exits 0, which also honours GH_TOKEN / GITHUB_TOKEN.
// A re-created branch has several merged PRs; neither host documents newest-first, so take the latest.
const newestFirst = ( when ) => ( a, b ) => String( when( b ) ?? '' ).localeCompare( String( when( a ) ?? '' ) );

const github = ( repo, env ) => {
  const gh = stewardEnv( 'GH', env ) ?? 'gh';
  // Async, queued behind the repository's git calls, in childEnv (GH_TOKEN and the like still reach gh).
  const run = async ( argv ) => {
    const result = await runQueued( repo, gh, argv, { cwd: repo } );
    if ( result.status !== 0 ) throw new Error( `gh ${ argv[ 0 ] } failed: ${ result.stderr }` );
    return result.stdout;
  };
  return {
    name: 'github',
    configured: async () => { try { await run( [ 'auth', 'status' ] ); return true; } catch { return false; } },
    findMerge: async ( source, target ) => {
      const prs = JSON.parse( await run( [ 'pr', 'list', '--state', 'merged', '--head', source, '--base', target,
        '--json', 'headRefName,baseRefName,mergeCommit,mergedAt' ] ) || '[]' );
      const pr = prs.filter( ( p ) => p.headRefName === source && p.baseRefName === target )
        .sort( newestFirst( ( p ) => p.mergedAt ) )[ 0 ];
      return pr ? { mergeSha: pr.mergeCommit?.oid, mergedAt: pr.mergedAt } : undefined;
    },
    // Closed-unmerged (gh's `closed` also lists merged PRs, hence the state filter) with no open PR.
    findClosure: async ( source ) => {
      const list = async ( state ) => JSON.parse( await run( [ 'pr', 'list', '--state', state, '--head', source, '--json', 'headRefName,state' ] ) || '[]' )
        .filter( ( p ) => p.headRefName === source );
      if ( !( await list( 'closed' ) ).some( ( p ) => p.state === 'CLOSED' ) ) return false;
      return ( await list( 'open' ) ).length === 0;
    },
  };
};

// Bitbucket Cloud REST, with BITBUCKET_TOKEN (bearer) or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD.
const bitbucket = ( remoteUrl, env ) => {
  const auth = env.BITBUCKET_TOKEN
    ? `Bearer ${ env.BITBUCKET_TOKEN }`
    : env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD
      ? `Basic ${ Buffer.from( `${ env.BITBUCKET_USERNAME }:${ env.BITBUCKET_APP_PASSWORD }` ).toString( 'base64' ) }`
      : undefined;
  const slug = /bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec( remoteUrl ?? '' );
  return {
    name: 'bitbucket',
    configured: () => Boolean( auth && slug ),
    findMerge: async ( source, target ) => {
      const q = encodeURIComponent( `source.branch.name="${ source }" AND destination.branch.name="${ target }"` );
      const url = `https://api.bitbucket.org/2.0/repositories/${ slug[ 1 ] }/${ slug[ 2 ] }/pullrequests?state=MERGED&q=${ q }`;
      const response = await fetch( url, { headers: { Authorization: auth } } );
      if ( !response.ok ) throw new Error( `bitbucket refused (${ response.status })` );
      const pr = [ ...( ( await response.json() ).values ?? [] ) ].sort( newestFirst( ( p ) => p.updated_on ) )[ 0 ];
      return pr ? { mergeSha: pr.merge_commit?.hash, mergedAt: pr.updated_on } : undefined;
    },
    // A DECLINED (closed-unmerged) PR for the branch with no OPEN PR replacing it.
    findClosure: async ( source ) => {
      const list = async ( state ) => {
        const q = encodeURIComponent( `source.branch.name="${ source }"` );
        const url = `https://api.bitbucket.org/2.0/repositories/${ slug[ 1 ] }/${ slug[ 2 ] }/pullrequests?state=${ state }&q=${ q }`;
        const response = await fetch( url, { headers: { Authorization: auth } } );
        if ( !response.ok ) throw new Error( `bitbucket refused (${ response.status })` );
        return ( await response.json() ).values ?? [];
      };
      if ( ( await list( 'DECLINED' ) ).length === 0 ) return false;
      return ( await list( 'OPEN' ) ).length === 0;
    },
  };
};

/** The host adapter for this checkout, or a reason (ancestry-only). It is not yet checked for credentials: see resolveHost. */
export const hostAdapter = ( { repo, remoteUrl, env = process.env } ) => {
  const host = hostOf( remoteUrl, env );
  const adapter = host === 'github' ? github( repo, env ) : host === 'bitbucket' ? bitbucket( remoteUrl, env ) : undefined;
  if ( !adapter ) return { reason: `no supported git host for ${ remoteUrl } (set BLUEPRINT_GIT_HOST=github|bitbucket)` };
  return { adapter };
};

/** hostAdapter, then the adapter's credentials checked (async: `gh auth status` is a child process). */
export const resolveHost = async ( options ) => {
  const host = hostAdapter( options );
  if ( host.adapter && !( await host.adapter.configured() ) ) return { reason: `no ${ host.adapter.name } credentials configured` };
  return host;
};
