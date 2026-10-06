import { execSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRemoteUrl } from '../lib/flush.mjs';

/**
 * Steward, declaring `flush`, claims a flush job, fetches the
 * session bundle from the host, and lands exactly the five bundle files, and the two docs it may carry, on
 * origin's branch by plumbing, fast-forward only, never touching the session worktree's HEAD, index or files. Driven
 * through the real Steward process against a fixture host and a bare origin, with real git.
 *
 * The fixture host fixes the bundle response of GET RUNNER_JOBS_ROUTE/:id/bundle as
 * { files, expect, branch, remoteUrl, key, headSeq }: `files` and `expect` are keyed by the bundle file's name.
 */

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );
const SESSION = 'sess-flush';
const BRANCH = 'PROJ-210-design';
const KEY = 'PROJ-210';
const OWNED_DIR = `docs/prs/${ KEY }/blueprint`;
const OWNED = [ 'board.json', 'design.json', 'manifest.json', 'map.json', 'ops.jsonl' ].map( ( name ) => `${ OWNED_DIR }/${ name }` );
const ZERO = '0'.repeat( 40 );

// The fixture owns git's ambient config: no global or system file, so the operator's hooksPath, identity or
// rewrite rules cannot reach Steward or the fixture's own git calls.
const EMPTY_CONFIG = join( mkdtempSync( join( tmpdir(), 'flush-gitconfig-' ) ), 'empty' );
writeFileSync( EMPTY_CONFIG, '' );
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const IDENTITY = '-c user.email=dev@example.com -c user.name=Dev';

const sh = ( cwd: string, cmd: string ): string => execSync( cmd, { cwd, encoding: 'utf-8', env: GIT_ENV } ).trim();
const blobOf = ( content: string ): string => execSync( 'git hash-object --stdin', { input: content, encoding: 'utf-8', env: GIT_ENV } ).trim();

// What Steward posts: a claim's kinds, or a report's status, reason and result text.
type Body = { kinds?: string[]; status?: string; reason?: string; result?: string };
type Req = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Body | undefined };

const servers: Server[] = [];
afterEach( () => { for ( const s of servers.splice( 0 ) ) s.close(); } );

const OPS = [
  { seq: 1, ts: '2026-09-29T10:00:00Z', author: 'human', class: 'design', verb: 'propose', payload: {}, writerSha: 'w', writerId: 'x', principal: 'alice@example.com' },
  { seq: 2, ts: '2026-09-29T10:01:00Z', author: 'ai', class: 'design', verb: 'modify', payload: {}, writerSha: 'w', writerId: 'x', principal: 'job-1', onBehalfOf: 'alice@example.com' },
  { seq: 3, ts: '2026-09-29T10:02:00Z', author: 'human', class: 'design', verb: 'comment', payload: {}, writerSha: 'w', writerId: 'x', principal: 'bob@example.com' },
];

const bundleFiles = ( head = 3 ): Record<string, string> => ( {
  'manifest.json': `${ JSON.stringify( { format: 'blueprint-session-bundle', version: 1, sessionId: SESSION, name: 'checkout redesign', ticketRefs: [ KEY ], branch: BRANCH, head, tipHash: 'f'.repeat( 64 ), producer: 'blueprint-server' }, null, 2 ) }\n`,
  'ops.jsonl': OPS.map( ( op ) => JSON.stringify( op ) ).join( '\n' ) + '\n',
  'design.json': `${ JSON.stringify( { nodes: [ { id: 'n1' } ], edges: [] }, null, 2 ) }\n`,
  'board.json': `${ JSON.stringify( { positions: { n1: { x: 1, y: 2 } } }, null, 2 ) }\n`,
  'map.json': `${ JSON.stringify( { nodes: [ { id: 'n1', x: 1, y: 2 } ] }, null, 2 ) }\n`,
} );

// The two docs a bundle carries while a completion is at `bundle`.
const DOC_FILES = {
  'blueprint.md': '# PROJ-42 blueprint\n\nThe design as built.\n',
  'decisions.md': '# PROJ-42 decisions\n\n- D1: keep the flush plumbing-only.\n',
};

type Bundle = { files: Record<string, string>; expect: Record<string, string | null> | null; branch: string; remoteUrl: string; key: string; headSeq: number };

const fixtureHost = async ( bundle: Bundle, job = { id: 'jf', kind: 'flush', sessionId: SESSION, branch: bundle.branch } ) => {
  const requests: Req[] = [];
  const server = createServer( ( req, res ) => {
    let data = '';
    req.on( 'data', ( c ) => { data += c; } );
    req.on( 'end', () => {
      const r: Req = { method: req.method!, url: req.url!, headers: req.headers, body: data ? JSON.parse( data ) as Body : undefined };
      requests.push( r );
      const body = r.url === '/api/blueprint/steward/claim' ? { job }
        : r.url === `/api/blueprint/steward/jobs/${ job.id }/bundle` && r.method === 'GET' ? { ok: true, ...bundle }
          : {};
      res.writeHead( 200, { 'Content-Type': 'application/json' } );
      res.end( JSON.stringify( body ) );
    } );
  } );
  servers.push( server );
  await new Promise<void>( ( r ) => server.listen( 0, '127.0.0.1', () => r() ) );
  const { port } = server.address() as { port: number };
  const reports = () => requests.filter( ( q ) => q.url === `/api/blueprint/steward/jobs/${ job.id }` && q.method === 'POST' );
  return { url: `http://127.0.0.1:${ port }`, requests, reports };
};

// A remote `update` hook that refuses, and records, any update of a branch to a commit its old tip is not an
// ancestor of: the only updates that reach it are forced ones, since git refuses a plain non-fast-forward push itself.
const UPDATE_HOOK = ( marker: string ) => `#!/bin/sh
ref="$1"; old="$2"; new="$3"
if [ "$old" != "${ ZERO }" ] && [ "$new" != "${ ZERO }" ] && ! git merge-base --is-ancestor "$old" "$new"; then
  echo "$ref $old $new" >> ${ JSON.stringify( marker ) }
  echo "forced update of $ref refused" >&2
  exit 1
fi
exit 0
`;

type Fixture = { origin: string; repo: string; worktree: string; dev: string; forceMarker: string; remoteUrl: string };

const makeFixture = (): Fixture => {
  const root = mkdtempSync( join( tmpdir(), 'blueprint-flush-' ) );
  const origin = join( root, 'origin.git' );
  sh( root, `git init -q --bare -b main ${ origin }` );
  const forceMarker = join( root, 'forced-updates.log' );
  writeFileSync( join( origin, 'hooks', 'update' ), UPDATE_HOOK( forceMarker ) );
  chmodSync( join( origin, 'hooks', 'update' ), 0o755 );
  // The developer's clone: main, and the ticket branch with a commit of its own.
  const dev = join( root, 'dev' );
  sh( root, `git clone -q ${ origin } ${ dev }` );
  mkdirSync( join( dev, 'src' ) );
  writeFileSync( join( dev, 'src', 'x.ts' ), 'export const x = 1;\n' );
  writeFileSync( join( dev, 'README.md' ), 'shop\n' );
  sh( dev, `git symbolic-ref HEAD refs/heads/main && git add -A && git ${ IDENTITY } commit -qm init && git push -q origin main` );
  sh( dev, `git checkout -q -b ${ BRANCH } && echo 'export const y = 2;' > src/y.ts && git add -A && git ${ IDENTITY } commit -qm branch-work && git push -q origin ${ BRANCH }` );
  // Steward's checkout, on main, with Steward's own git identity, and the session's worktree at the branch
  // as Steward's own checkout step leaves it (detached, at <repo>.blueprint-worktrees/<session id>).
  const repo = join( root, 'repo' );
  sh( root, `git clone -q ${ origin } ${ repo }` );
  sh( repo, 'git config user.email steward@example.com && git config user.name "Blueprint Steward"' );
  const worktree = join( `${ repo }.blueprint-worktrees`, SESSION );
  sh( repo, `git worktree add -q --detach ${ worktree } origin/${ BRANCH }` );
  // Extract output and an untracked file, present and not ignored, in both the worktree and the checkout.
  for ( const dir of [ worktree, repo ] ) {
    mkdirSync( join( dir, '.blueprint' ), { recursive: true } );
    writeFileSync( join( dir, '.blueprint', 'graph.json' ), '{"nodes":[1]}\n' );
    writeFileSync( join( dir, '.blueprint', 'diagnostics.json' ), '{"diagnostics":[]}\n' );
    writeFileSync( join( dir, 'notes.txt' ), 'scratch\n' );
  }
  return { origin, repo, worktree, dev, forceMarker, remoteUrl: sh( repo, 'git remote get-url origin' ) };
};

// The race lands before git reads origin's refs for the push: the developer first pushes a commit, so Steward's
// fetch moves its tracking ref, and a `reference-transaction` hook in Steward's repository then pushes another
// developer commit to src/x.ts as each committed update of refs/remotes/origin/<branch> lands, for the first `races`
// of them. Steward's commit is built on the tip it fetched, which origin no longer holds when the push reads its
// refs, so a plain push is refused as non-fast-forward and only a forced one reaches origin's update hook.
const raceDeveloperPushes = ( fx: Fixture, races: number ) => {
  sh( fx.dev, `echo '// dev 0' >> src/x.ts && git ${ IDENTITY } commit -qam "dev 0" && git push -q origin ${ BRANCH }` );
  const log = join( fx.dev, '..', 'tracking-updates.log' );
  const hook = join( fx.repo, '.git', 'hooks', 'reference-transaction' );
  writeFileSync( hook, `#!/bin/sh
[ "$1" = committed ] || { cat > /dev/null; exit 0; }
grep -q ' refs/remotes/origin/${ BRANCH }$' || exit 0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH
echo update >> ${ JSON.stringify( log ) }
n=$(wc -l < ${ JSON.stringify( log ) } | tr -d ' ')
if [ "$n" -le ${ races } ]; then
  cd ${ JSON.stringify( fx.dev ) } || exit 0
  git fetch -q origin && git merge -q --ff-only origin/${ BRANCH }
  echo "// dev $n" >> src/x.ts
  git ${ IDENTITY } commit -qam "dev $n" && git push -q origin HEAD:refs/heads/${ BRANCH }
fi
exit 0
` );
  chmodSync( hook, 0o755 );
};

const run = ( args: string[] ) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>( ( res ) => {
    const child = spawn( process.execPath, [ BIN, ...args ], { env: { ...GIT_ENV, BLUEPRINT_STEWARD_TOKEN: '', BLUEPRINT_SESSION_ID: '' } } );
    let stdout = '', stderr = '';
    child.stdout.on( 'data', ( c ) => { stdout += c; } );
    child.stderr.on( 'data', ( c ) => { stderr += c; } );
    child.on( 'close', ( code ) => { res( { code, stdout, stderr } ); } );
  } );

const flush = ( host: { url: string }, fx: Fixture ) => run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', fx.repo, '--once' ] );

const sha256 = ( bytes: Buffer ): string => createHash( 'sha256' ).update( bytes ).digest( 'hex' );
const filesUnder = ( dir: string, root = dir ): Record<string, string> => Object.fromEntries( readdirSync( dir ).flatMap( ( name ) => {
  const path = join( dir, name );
  if ( name === '.git' ) return [];
  return statSync( path ).isDirectory() ? Object.entries( filesUnder( path, root ) ) : [ [ relative( root, path ), sha256( readFileSync( path ) ) ] ];
} ) );
// HEAD, the index's bytes and every file's bytes. The index is read first and no command that refreshes it runs.
const snapshot = ( dir: string ) => {
  const index = resolve( dir, sh( dir, 'git rev-parse --git-path index' ) );
  return { index: existsSync( index ) ? sha256( readFileSync( index ) ) : 'absent', head: sh( dir, 'git rev-parse HEAD' ), files: filesUnder( dir ) };
};
const originTip = ( fx: Fixture, branch = BRANCH ): string | undefined => {
  const out = spawnSync( 'git', [ 'rev-parse', '--verify', '--quiet', `refs/heads/${ branch }` ], { cwd: fx.origin, encoding: 'utf-8', env: GIT_ENV } );
  return out.status === 0 ? out.stdout.trim() : undefined;
};
const originRefs = ( fx: Fixture ): string => sh( fx.origin, 'git for-each-ref --format="%(refname) %(objectname)"' );
// A flush report's result is JSON; any other result is kept as its text, so an assertion prints what was reported.
const parsed = ( text: string ): unknown => {
  try { return JSON.parse( text ); } catch { return text; }
};
const resultOf = ( host: { reports: () => Req[] } ) => {
  const [ report ] = host.reports();
  return { status: report?.body?.status, reason: report?.body?.reason, result: report?.body?.result === undefined ? undefined : parsed( report.body.result ) };
};
const bundleFor = ( fx: Fixture, overrides: Partial<Bundle> = {} ): Bundle =>
  ( { files: bundleFiles(), expect: null, branch: BRANCH, remoteUrl: fx.remoteUrl, key: KEY, headSeq: 3, ...overrides } );

// Each test spawns Steward and a dozen git processes; the budget is for a loaded machine, not for the flush.
describe( 'blueprint-steward flush', { timeout: 30_000 }, () => {
  // The wrong-repo check compares origin with the job's repository, both keyed by the spec's normalizeRemoteUrl.
  it( 'normalizes a remote URL to the key the server resolves a claim by', () => {
    expect( [
      'git@github.com:Acme/Shop.git', 'https://github.com/acme/shop', 'ssh://git@github.example.com:8443/acme/repo.git',
      'https://user:token@bitbucket.org/Team/Repo.git/', 'git+ssh://git@host//a//b.git', '/tmp/origin.git', '  file:///srv/x.git  ',
    ].map( ( url ) => normalizeRemoteUrl( url ) ) ).toEqual( [
      'github.com/acme/shop', 'github.com/acme/shop', 'github.example.com/acme/repo',
      'bitbucket.org/team/repo.git', 'host/a/b', '/tmp/origin', '/srv/x',
    ] );
  } );

  it( 'Steward declares flush among the kinds it claims', async () => {
    const fx = makeFixture();
    const host = await fixtureHost( bundleFor( fx ) );
    await flush( host, fx );
    const claim = host.requests.find( ( q ) => q.url === '/api/blueprint/steward/claim' )!;
    expect( claim.body?.kinds ).toContain( 'flush' );
  } );

  it( 'Given a session worktree at the branch and a queued flush of five files when Steward claims and runs it then origin gains one commit on the prior tip and the worktree is byte-unchanged', async () => {
    // GIVEN
    const fx = makeFixture();
    const prior = originTip( fx );
    const before = { worktree: snapshot( fx.worktree ), repo: snapshot( fx.repo ) };
    const host = await fixtureHost( bundleFor( fx ) );

    // WHEN
    const r = await flush( host, fx );

    // THEN
    expect( r.code ).toBe( 0 );
    const tip = originTip( fx )!;
    expect( tip ).not.toBe( prior );
    expect( sh( fx.origin, `git rev-list --parents -n 1 ${ tip }` ).split( ' ' ) ).toEqual( [ tip, prior ] );
    for ( const [ name, content ] of Object.entries( bundleFiles() ) ) {
      expect( [ name, sh( fx.origin, `git cat-file blob ${ tip }:${ OWNED_DIR }/${ name }` ) ] ).toEqual( [ name, content.trim() ] );
    }
    expect( { worktree: snapshot( fx.worktree ), repo: snapshot( fx.repo ) } ).toEqual( before );
    // The report: the commit, the head it carries, and each file's blob as committed.
    expect( host.requests.map( ( q ) => `${ q.method } ${ q.url }` ) ).toEqual( [
      'POST /api/blueprint/steward/claim', 'GET /api/blueprint/steward/jobs/jf/bundle', 'POST /api/blueprint/steward/jobs/jf',
    ] );
    expect( host.requests[ 1 ].headers[ 'x-blueprint-session-id' ] ).toBe( SESSION );
    expect( resultOf( host ) ).toEqual( {
      status: 'done', reason: undefined,
      result: { commitSha: tip, headSeq: 3, blobShas: Object.fromEntries( Object.entries( bundleFiles() ).map( ( [ name, content ] ) => [ name, blobOf( content ) ] ) ) },
    } );
    // The message and trailers.
    expect( sh( fx.origin, `git log -1 --format=%s ${ tip }` ) ).toBe( `design(${ KEY }): session checkout redesign through seq 3` );
    const trailer = ( key: string ) => sh( fx.origin, `git log -1 --format="%(trailers:key=${ key },valueonly)" ${ tip }` );
    expect( [ trailer( 'Blueprint-Session' ), trailer( 'Blueprint-Seq' ), trailer( 'Blueprint-Actors' ) ] )
      .toEqual( [ SESSION, '3', 'alice@example.com, bob@example.com, job-1' ] );
    expect( sh( fx.origin, `git log -1 --format="%an <%ae>" ${ tip }` ) ).toBe( 'Blueprint Steward <steward@example.com>' );
  } );

  it( 'Given a flush bundle for PROJ-42 whose files carry map.json, blueprint.md and decisions.md when Steward flushes it then one commit holds the five bundle files and the two docs one level up, and blobShas carries all seven', async () => {
    // GIVEN
    const fx = makeFixture();
    const prior = originTip( fx );
    const files = { ...bundleFiles(), ...DOC_FILES };
    const host = await fixtureHost( bundleFor( fx, { key: 'PROJ-42', files } ) );

    // WHEN
    await flush( host, fx );

    // THEN: <root>/<KEY>/blueprint/map.json, and <root>/<KEY>/blueprint.md and decisions.md.
    const tip = originTip( fx )!;
    const pathOf = ( name: string ) => ( name in DOC_FILES ? `docs/prs/PROJ-42/${ name }` : `docs/prs/PROJ-42/blueprint/${ name }` );
    expect( sh( fx.origin, `git rev-list --parents -n 1 ${ tip }` ).split( ' ' ) ).toEqual( [ tip, prior ] );
    expect( sh( fx.origin, `git diff-tree --no-commit-id --name-only -r ${ tip }^ ${ tip }` ).split( '\n' ).sort() ).toEqual( [
      'docs/prs/PROJ-42/blueprint.md', 'docs/prs/PROJ-42/blueprint/board.json', 'docs/prs/PROJ-42/blueprint/design.json',
      'docs/prs/PROJ-42/blueprint/manifest.json', 'docs/prs/PROJ-42/blueprint/map.json', 'docs/prs/PROJ-42/blueprint/ops.jsonl',
      'docs/prs/PROJ-42/decisions.md',
    ] );
    for ( const [ name, content ] of Object.entries( files ) ) {
      expect( [ name, sh( fx.origin, `git cat-file blob ${ tip }:${ pathOf( name ) }` ) ] ).toEqual( [ name, content.trim() ] );
    }
    expect( resultOf( host ) ).toEqual( {
      status: 'done', reason: undefined,
      result: { commitSha: tip, headSeq: 3, blobShas: Object.fromEntries( Object.entries( files ).map( ( [ name, content ] ) => [ name, blobOf( content ) ] ) ) },
    } );
    // No map.html, here or anywhere the flush wrote.
    expect( sh( fx.origin, `git ls-tree -r --name-only ${ tip }` ).split( '\n' ).filter( ( path ) => path.endsWith( 'map.html' ) ) ).toEqual( [] );
  } );

  it( 'Given a flush bundle without the two docs when Steward flushes it then no doc path is in the tree and blobShas names only the five bundle files', async () => {
    // GIVEN
    const fx = makeFixture();
    const host = await fixtureHost( bundleFor( fx ) );

    // WHEN
    await flush( host, fx );

    // THEN
    const tip = originTip( fx )!;
    expect( sh( fx.origin, `git ls-tree -r --name-only ${ tip }` ).split( '\n' ).filter( ( path ) => path.startsWith( `docs/prs/${ KEY }/` ) ).sort() ).toEqual( OWNED );
    expect( Object.keys( ( resultOf( host ).result as { blobShas: Record<string, string> } ).blobShas ).sort() )
      .toEqual( [ 'board.json', 'design.json', 'manifest.json', 'map.json', 'ops.jsonl' ] );
  } );

  it( 'Given decisions.md on the branch differs from the job\'s expect when a bundle carrying the docs is flushed then it reports diverged with the doc\'s path, and origin\'s tip is unchanged', async () => {
    // GIVEN: the branch already carries a hand-written decisions.md where the flush would put the bundle's.
    const fx = makeFixture();
    const hand = '# hand-written decisions\n';
    sh( fx.dev, `git checkout -q ${ BRANCH } && mkdir -p docs/prs/${ KEY }` );
    writeFileSync( join( fx.dev, 'docs', 'prs', KEY, 'decisions.md' ), hand );
    sh( fx.dev, `git add -A && git ${ IDENTITY } commit -qm hand-decisions && git push -q origin ${ BRANCH }` );
    const prior = originTip( fx );
    const host = await fixtureHost( bundleFor( fx, { files: { ...bundleFiles(), ...DOC_FILES } } ) );

    // WHEN
    await flush( host, fx );

    // THEN
    expect( resultOf( host ) ).toEqual( {
      status: 'failed', reason: 'diverged',
      result: { diverged: [ { path: `docs/prs/${ KEY }/decisions.md`, expected: null, found: blobOf( hand ) } ] },
    } );
    expect( originTip( fx ) ).toBe( prior );
  } );

  it( 'Given extract output and an untracked file present and not ignored when the flush commits then its diff against its parent is exactly the five owned paths', async () => {
    // GIVEN
    const fx = makeFixture();
    const host = await fixtureHost( bundleFor( fx ) );

    // WHEN
    await flush( host, fx );

    // THEN
    const tip = originTip( fx )!;
    expect( sh( fx.origin, `git diff-tree --no-commit-id --name-only -r ${ tip }^ ${ tip }` ).split( '\n' ).sort() ).toEqual( OWNED );
    expect( sh( fx.origin, `git ls-tree -r --name-only ${ tip }` ).split( '\n' ).filter( ( path ) => path.startsWith( '.blueprint' ) || path === 'notes.txt' ) ).toEqual( [] );
  } );

  it( 'the update hook refuses and records a forced update (positive control for the no-force assertions)', () => {
    const fx = makeFixture();
    const tip = originTip( fx );
    const forced = spawnSync( 'git', [ 'push', '-q', '--force', 'origin', `${ BRANCH }~1:refs/heads/${ BRANCH }` ], { cwd: fx.dev, encoding: 'utf-8', env: GIT_ENV } );
    expect( forced.status ).not.toBe( 0 );
    expect( existsSync( fx.forceMarker ) ).toBe( true );
    expect( originTip( fx ) ).toBe( tip );
  } );

  it( 'Given a developer commit to src/x.ts lands on origin between the fetch and the push, and a hook refuses forced updates, when the push is rejected then the flush retries from the fetch, the developer\'s commit is an ancestor of the final head, and no forced update is attempted', async () => {
    // GIVEN
    const fx = makeFixture();
    raceDeveloperPushes( fx, 1 );
    const host = await fixtureHost( bundleFor( fx ) );

    // WHEN
    await flush( host, fx );

    // THEN
    const tip = originTip( fx )!;
    const developer = sh( fx.dev, 'git rev-parse HEAD' );
    expect( sh( fx.dev, 'git log -1 --format=%s' ) ).toBe( 'dev 1' );
    expect( spawnSync( 'git', [ 'merge-base', '--is-ancestor', developer, tip ], { cwd: fx.origin, env: GIT_ENV } ).status ).toBe( 0 );
    expect( sh( fx.origin, `git rev-list --parents -n 1 ${ tip }` ).split( ' ' ) ).toEqual( [ tip, developer ] );
    expect( sh( fx.origin, `git cat-file blob ${ tip }:src/x.ts` ) ).toBe( 'export const x = 1;\n// dev 0\n// dev 1' );
    expect( sh( fx.origin, `git diff-tree --no-commit-id --name-only -r ${ tip }^ ${ tip }` ).split( '\n' ).sort() ).toEqual( OWNED );
    expect( existsSync( fx.forceMarker ) ).toBe( false );
    expect( resultOf( host ) ).toMatchObject( { status: 'done', result: { commitSha: tip, headSeq: 3 } } );
  } );

  it( 'Given every push loses a race to a developer push when the flush has retried three times then it reports failed non-ff, never forcing', async () => {
    // GIVEN
    const fx = makeFixture();
    raceDeveloperPushes( fx, 99 );
    const host = await fixtureHost( bundleFor( fx ) );

    // WHEN
    await flush( host, fx );

    // THEN: the first fetch and three retries, each raced by a developer push; origin ends on the developer's last commit.
    expect( sh( fx.dev, 'git log -1 --format=%s' ) ).toBe( 'dev 4' );
    expect( originTip( fx ) ).toBe( sh( fx.dev, 'git rev-parse HEAD' ) );
    expect( existsSync( fx.forceMarker ) ).toBe( false );
    expect( resultOf( host ) ).toMatchObject( { status: 'failed', reason: 'non-ff', result: { error: 'non-ff' } } );
  } );

  it( 'Given design.json on the branch differs from both the job\'s expect blob and absent when the flush runs then it reports diverged with path, expected and found, and origin\'s tip is unchanged', async () => {
    // GIVEN: a first flush landed the bundle; the developer then edited design.json on the branch.
    const fx = makeFixture();
    const committed = Object.fromEntries( Object.entries( bundleFiles() ).map( ( [ name, content ] ) => [ name, blobOf( content ) ] ) );
    sh( fx.dev, `git checkout -q ${ BRANCH } && mkdir -p ${ OWNED_DIR }` );
    for ( const [ name, content ] of Object.entries( bundleFiles() ) ) writeFileSync( join( fx.dev, OWNED_DIR, name ), content );
    sh( fx.dev, `git add -A && git ${ IDENTITY } commit -qm first-flush && git push -q origin ${ BRANCH }` );
    const edited = '{ "nodes": [ { "id": "hand-edited" } ] }\n';
    writeFileSync( join( fx.dev, OWNED_DIR, 'design.json' ), edited );
    sh( fx.dev, `git ${ IDENTITY } commit -qam hand-edit && git push -q origin ${ BRANCH }` );
    const prior = originTip( fx );
    const host = await fixtureHost( bundleFor( fx, { files: bundleFiles( 4 ), headSeq: 4, expect: committed } ) );

    // WHEN
    await flush( host, fx );

    // THEN
    expect( resultOf( host ) ).toEqual( {
      status: 'failed', reason: 'diverged',
      result: { diverged: [ { path: `${ OWNED_DIR }/design.json`, expected: committed[ 'design.json' ], found: blobOf( edited ) } ] },
    } );
    expect( originTip( fx ) ).toBe( prior );
  } );

  it( 'Given design.json was deleted on the branch after a first flush when the flush runs with that flush\'s blobs expected then it reports diverged with found null, and origin\'s tip is unchanged', async () => {
    // GIVEN: absence is allowed only before the first commit (expect null); this job expects the first flush's blobs.
    const fx = makeFixture();
    const first = await fixtureHost( bundleFor( fx ) );
    await flush( first, fx );
    const committed = ( resultOf( first ).result as { blobShas: Record<string, string> } ).blobShas;
    sh( fx.dev, `git fetch -q origin && git checkout -q ${ BRANCH } && git merge -q --ff-only origin/${ BRANCH } && git rm -q ${ OWNED_DIR }/design.json && git ${ IDENTITY } commit -qm drop-design && git push -q origin ${ BRANCH }` );
    const prior = originTip( fx );
    const host = await fixtureHost( bundleFor( fx, { files: bundleFiles( 4 ), headSeq: 4, expect: committed } ) );

    // WHEN
    await flush( host, fx );

    // THEN
    expect( resultOf( host ) ).toEqual( {
      status: 'failed', reason: 'diverged',
      result: { diverged: [ { path: `${ OWNED_DIR }/design.json`, expected: committed[ 'design.json' ], found: null } ] },
    } );
    expect( originTip( fx ) ).toBe( prior );
  } );

  it( 'Given a branch that already holds the bundle as served when the same bundle is flushed again with the first flush\'s blobs expected then origin\'s tip is unchanged and the report names it', async () => {
    // GIVEN
    const fx = makeFixture();
    const first = await fixtureHost( bundleFor( fx ) );
    await flush( first, fx );
    const prior = originTip( fx )!;
    const again = await fixtureHost( bundleFor( fx, { expect: ( resultOf( first ).result as { blobShas: Record<string, string> } ).blobShas } ) );

    // WHEN
    await flush( again, fx );

    // THEN: no empty commit is pushed.
    expect( originTip( fx ) ).toBe( prior );
    expect( resultOf( again ) ).toMatchObject( { status: 'done', result: { commitSha: prior, headSeq: 3 } } );
  } );

  it( 'Given a branch that already carries the files the job expects when the flush runs then it fast-forwards over them', async () => {
    const fx = makeFixture();
    const first = await fixtureHost( bundleFor( fx ) );
    await flush( first, fx );
    const prior = originTip( fx );
    const second = await fixtureHost( bundleFor( fx, { files: bundleFiles( 4 ), headSeq: 4, expect: ( resultOf( first ).result as { blobShas: Record<string, string> } ).blobShas } ) );
    await flush( second, fx );
    const tip = originTip( fx )!;
    expect( sh( fx.origin, `git rev-list --parents -n 1 ${ tip }` ).split( ' ' ) ).toEqual( [ tip, prior ] );
    expect( sh( fx.origin, `git diff-tree --no-commit-id --name-only -r ${ tip }^ ${ tip }` ) ).toBe( `${ OWNED_DIR }/manifest.json` );
    expect( resultOf( second ) ).toMatchObject( { status: 'done', result: { commitSha: tip, headSeq: 4 } } );
  } );

  it( 'Given origin is not the job\'s repository when the flush runs then it reports failed wrong-repo and origin is unchanged', async () => {
    const fx = makeFixture();
    const refs = originRefs( fx );
    const host = await fixtureHost( bundleFor( fx, { remoteUrl: 'git@github.com:someone-else/other-repo.git' } ) );
    await flush( host, fx );
    expect( resultOf( host ) ).toMatchObject( { status: 'failed', reason: 'wrong-repo', result: { error: 'wrong-repo' } } );
    expect( originRefs( fx ) ).toBe( refs );
  } );

  it( 'Given the branch is absent on origin when the flush runs then it reports failed branch-missing and no branch is created', async () => {
    const fx = makeFixture();
    const refs = originRefs( fx );
    const host = await fixtureHost( bundleFor( fx, { branch: 'PROJ-210-gone' } ) );
    await flush( host, fx );
    expect( resultOf( host ) ).toMatchObject( { status: 'failed', reason: 'branch-missing', result: { error: 'branch-missing' } } );
    expect( originRefs( fx ) ).toBe( refs );
    expect( originTip( fx, 'PROJ-210-gone' ) ).toBeUndefined();
  } );

  it( 'Given origin refuses every update of the branch, as a protected branch does, when the flush pushes then it reports failed push-rejected with git\'s words', async () => {
    const fx = makeFixture();
    writeFileSync( join( fx.origin, 'hooks', 'pre-receive' ), '#!/bin/sh\necho "branch is protected" >&2\nexit 1\n' );
    chmodSync( join( fx.origin, 'hooks', 'pre-receive' ), 0o755 );
    const prior = originTip( fx );
    const host = await fixtureHost( bundleFor( fx ) );
    await flush( host, fx );
    const { status, reason, result } = resultOf( host ) as { status: string; reason: string; result: { error: string; detail: string } };
    expect( [ status, reason, result.error ] ).toEqual( [ 'failed', 'push-rejected', 'push-rejected' ] );
    expect( result.detail ).toContain( 'branch is protected' );
    expect( originTip( fx ) ).toBe( prior );
  } );

  it( 'Given the branch\'s workflow config names workDocsRoot when the flush commits then the files land under it; an invalid one fails config-invalid and writes nothing', async () => {
    const withConfig = ( workDocsRoot: string ) => {
      const fx = makeFixture();
      mkdirSync( join( fx.dev, '.claude' ) );
      writeFileSync( join( fx.dev, '.claude', 'bett3r-ai-workflow.json' ), JSON.stringify( { workDocsRoot } ) );
      sh( fx.dev, `git add -A && git ${ IDENTITY } commit -qm workflow && git push -q origin ${ BRANCH }` );
      return fx;
    };
    const valid = withConfig( 'work/items/' );
    const host = await fixtureHost( bundleFor( valid ) );
    await flush( host, valid );
    const tip = originTip( valid )!;
    expect( sh( valid.origin, `git diff-tree --no-commit-id --name-only -r ${ tip }^ ${ tip }` ).split( '\n' ).sort() )
      .toEqual( [ 'board.json', 'design.json', 'manifest.json', 'map.json', 'ops.jsonl' ].map( ( name ) => `work/items/${ KEY }/blueprint/${ name }` ) );

    const invalid = withConfig( '../outside' );
    const prior = originTip( invalid );
    const refused = await fixtureHost( bundleFor( invalid ) );
    await flush( refused, invalid );
    expect( resultOf( refused ) ).toMatchObject( { status: 'failed', reason: 'config-invalid', result: { error: 'config-invalid' } } );
    expect( originTip( invalid ) ).toBe( prior );
  } );
} );
