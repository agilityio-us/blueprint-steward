import { execSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Steward claims a `scaffold` job, brings the session's
 * worktree to the job's sha, cleans it (git clean -fd), extracts, deletes the untouched stubs the committed
 * <root>/<KEY>/scaffold.json lists and extracts again, runs the repository's designTooling.scaffold with --write --json
 * --design --map on the bundle, removes a stale stub's barrel lines, and commits the files it wrote, its barrel edits
 * and the new scaffold.json by plumbing, fast-forward only. Driven through the real Steward process against a fixture
 * host and a bare origin, with real git, a fake extractor whose graph holds the nodes whose code files exist, and a fake
 * scaffolder that keeps the scaffolder's rules: a node in the extracted graph is satisfied and gets nothing, and an
 * existing file is skipped `exists`, never rewritten.
 */

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );
const SESSION = 'sess-scaffold';
const BRANCH = 'PROJ-42-checkout';
const KEY = 'PROJ-42';
const DOCS = `docs/prs/${ KEY }`;
const BUNDLE = `${ DOCS }/blueprint`;
const REPORT = `${ DOCS }/scaffold.json`;
const ZERO = '0'.repeat( 40 );
// The base commit's bundle files: none of them may ride in the scaffold commit.
const DOC_PATHS = [ 'manifest.json', 'ops.jsonl', 'design.json', 'board.json', 'map.json' ].map( ( name ) => `${ BUNDLE }/${ name }` )
  .concat( [ `${ DOCS }/blueprint.md`, `${ DOCS }/decisions.md` ] );

const PLACED = 'src/orders/OrderPlaced.event.ts';
const SUBMITTED = 'src/orders/OrderSubmitted.event.ts';
const PLACED_TEST = 'src/orders/__tests__/OrderPlaced.event.test.ts';
const BARREL = 'src/orders/index.ts';
// The extractor's registry: the code files it reads as design nodes. The renamed event keeps the design's node id, so
// OrderPlaced.event.ts on disk still reads as e1 (the node a rename re-labels).
const EXTRACTS: Record<string, string> = { [ PLACED ]: 'e1', [ SUBMITTED ]: 'e1' };

const EMPTY_CONFIG = join( mkdtempSync( join( tmpdir(), 'scaffold-gitconfig-' ) ), 'empty' );
writeFileSync( EMPTY_CONFIG, '' );
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const IDENTITY = '-c user.email=dev@example.com -c user.name=Dev';
const sh = ( cwd: string, cmd: string ): string => execSync( cmd, { cwd, encoding: 'utf-8', env: GIT_ENV } ).trim();
const blobOf = ( content: string ): string => execSync( 'git hash-object --stdin', { input: content, encoding: 'utf-8', env: GIT_ENV } ).trim();

type Body = { kinds?: string[]; status?: string; reason?: string; result?: string };
type Req = { method: string; url: string; body: Body | undefined };
type Job = { id: string; kind: string; sessionId: string; branch: string; payload: Record<string, unknown> };

const servers: Server[] = [];
afterEach( () => { for ( const s of servers.splice( 0 ) ) s.close(); } );

const fixtureHost = async ( job: Job ) => {
  const requests: Req[] = [];
  const server = createServer( ( req, res ) => {
    let data = '';
    req.on( 'data', ( c ) => { data += c; } );
    req.on( 'end', () => {
      requests.push( { method: req.method!, url: req.url!, body: data ? JSON.parse( data ) as Body : undefined } );
      res.writeHead( 200, { 'Content-Type': 'application/json' } );
      res.end( JSON.stringify( req.url === '/api/blueprint/steward/claim' ? { job } : {} ) );
    } );
  } );
  servers.push( server );
  await new Promise<void>( ( r ) => server.listen( 0, '127.0.0.1', () => r() ) );
  const { port } = server.address() as { port: number };
  const reports = () => requests.filter( ( q ) => q.url === `/api/blueprint/steward/jobs/${ job.id }` && q.method === 'POST' );
  return { url: `http://127.0.0.1:${ port }`, requests, reports };
};

// The fake scaffolder: the scaffolder's CLI contract reduced to what this job reads. It logs its flags, needs the
// extracted graph and the named design and map, and plans by node: a node the extracted graph holds is satisfied and
// gets nothing; a node with any planned file already on disk is skipped `exists`,
// never rewritten; any other node gets its files (`wx`) and each barrel line its barrel lacks, which is all the report
// lists as appended. It runs the plan's `during` shell command, if any, then prints the --json
// report and exits as told.
const FAKE_SCAFFOLDER = `import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [ planPath, ...flags ] = process.argv.slice( 2 );
appendFileSync( planPath + '.argv.log', JSON.stringify( flags ) + '\\n' );
const value = ( flag ) => flags.includes( flag ) ? flags[ flags.indexOf( flag ) + 1 ] : undefined;
for ( const needed of [ '.blueprint/graph.json', value( '--design' ), value( '--map' ) ] ) {
  if ( !needed || !existsSync( needed ) ) { process.stderr.write( 'not found: ' + needed + '\\n' ); process.exit( 1 ); }
}
const graph = new Set( JSON.parse( readFileSync( '.blueprint/graph.json', 'utf-8' ) ).nodes.map( ( n ) => n.id ) );
const plan = JSON.parse( readFileSync( planPath, 'utf-8' ) );
const files = [];
const skipped = [ ...( plan.skipped ?? [] ) ];
const appends = [];
const nodes = [ ...new Set( [ ...( plan.files ?? [] ), ...( plan.appends ?? [] ) ].map( ( x ) => x.node ) ) ];
for ( const node of nodes ) {
  if ( graph.has( node ) ) continue;
  const own = ( plan.files ?? [] ).filter( ( f ) => f.node === node );
  const clash = own.find( ( f ) => existsSync( f.file ) );
  if ( clash ) { skipped.push( { node, reason: 'exists', detail: clash.file + ' already exists' } ); continue; }
  for ( const f of own ) {
    mkdirSync( dirname( f.file ), { recursive: true } );
    writeFileSync( f.file, f.content, { flag: 'wx' } );
    files.push( { kind: f.kind ?? 'code', file: f.file, node: f.node, content: f.content } );
  }
  for ( const a of ( plan.appends ?? [] ).filter( ( x ) => x.node === node ) ) {
    if ( readFileSync( a.file, 'utf-8' ).split( '\\n' ).includes( a.code ) ) continue;
    appendFileSync( a.file, a.code + '\\n' );
    appends.push( { kind: 'barrel', ...a } );
  }
}
if ( plan.during ) execSync( plan.during, { stdio: 'ignore' } );
process.stdout.write( JSON.stringify( { files, fragments: [], appends, hosted: [], skipped, deferred: plan.deferred ?? [], dropped: [],
  held: plan.held ?? [], testPlan: { configured: true, suites: [], undecided: [] }, scenarioTests: plan.scenarioTests ?? [], unplaced: [],
  scenariosExcluded: [], written: flags.includes( '--write' ) }, null, 2 ) + '\\n' );
process.exit( plan.exit ?? 0 );
`;
// The fake extractor: the graph holds the node of each code file in its registry (tools/extracts.json, file -> node)
// that is on disk now. A test file is no node, as the extractor reads code, not tests.
const FAKE_EXTRACT = ( registry: string ) => `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const registry = JSON.parse( readFileSync( ${ JSON.stringify( registry ) }, 'utf-8' ) );
const nodes = [ ...new Set( Object.entries( registry ).filter( ( [ file ] ) => existsSync( file ) ).map( ( [ , id ] ) => id ) ) ].sort().map( ( id ) => ( { id } ) );
mkdirSync( '.blueprint', { recursive: true } );
writeFileSync( '.blueprint/graph.json', JSON.stringify( { nodes, edges: [] } ) + '\\n' );
`;

type PlannedFile = { file: string; node: string; content: string; kind?: string };
type Plan = { exit?: number; files?: PlannedFile[]; appends?: { file: string; node: string; code: string }[]; skipped?: unknown[]; held?: unknown[]; deferred?: unknown[]; scenarioTests?: unknown[]; during?: string };

const UPDATE_HOOK = ( marker: string ) => `#!/bin/sh
ref="$1"; old="$2"; new="$3"
if [ "$old" != "${ ZERO }" ] && [ "$new" != "${ ZERO }" ] && ! git merge-base --is-ancestor "$old" "$new"; then
  echo "$ref $old $new" >> ${ JSON.stringify( marker ) }
  exit 1
fi
exit 0
`;

type Fixture = { root: string; origin: string; repo: string; dev: string; worktree: string; plan: string; forceMarker: string };

const designJson = ( label: string ) => `${ JSON.stringify( { schemaVersion: 1, propose: { nodes: [ { id: 'e1', type: 'event', label } ], edges: [] } }, null, 2 ) }\n`;

const makeFixture = ( { scaffold = true }: { scaffold?: boolean } = {} ): Fixture => {
  const root = mkdtempSync( join( tmpdir(), 'blueprint-scaffold-' ) );
  const tools = join( root, 'tools' );
  mkdirSync( tools );
  writeFileSync( join( tools, 'scaffold.mjs' ), FAKE_SCAFFOLDER );
  writeFileSync( join( tools, 'extracts.json' ), JSON.stringify( EXTRACTS ) );
  writeFileSync( join( tools, 'extract.mjs' ), FAKE_EXTRACT( join( tools, 'extracts.json' ) ) );
  const plan = join( root, 'plan.json' );
  const origin = join( root, 'origin.git' );
  sh( root, `git init -q --bare -b main ${ origin }` );
  const forceMarker = join( root, 'forced-updates.log' );
  writeFileSync( join( origin, 'hooks', 'update' ), UPDATE_HOOK( forceMarker ) );
  chmodSync( join( origin, 'hooks', 'update' ), 0o755 );
  const dev = join( root, 'dev' );
  sh( root, `git clone -q ${ origin } ${ dev }` );
  const designTooling = {
    extract: `node ${ join( tools, 'extract.mjs' ) }`,
    ...( scaffold ? { scaffold: `node ${ join( tools, 'scaffold.mjs' ) } ${ plan }` } : {} ),
  };
  writeFileSync( join( dev, '.blueprint.config.json' ), `${ JSON.stringify( { designTooling }, null, 2 ) }\n` );
  writeFileSync( join( dev, '.gitignore' ), '.blueprint/\n' );
  mkdirSync( join( dev, 'src', 'orders' ), { recursive: true } );
  writeFileSync( join( dev, BARREL ), 'export {};\n' );
  sh( dev, `git symbolic-ref HEAD refs/heads/main && git add -A && git ${ IDENTITY } commit -qm init && git push -q origin main` );
  // The base commit: the bundle and the two docs.
  sh( dev, `git checkout -q -b ${ BRANCH }` );
  mkdirSync( join( dev, BUNDLE ), { recursive: true } );
  for ( const name of [ 'manifest.json', 'ops.jsonl', 'board.json' ] ) writeFileSync( join( dev, BUNDLE, name ), `${ name }\n` );
  writeFileSync( join( dev, BUNDLE, 'design.json' ), designJson( 'Order Placed' ) );
  writeFileSync( join( dev, BUNDLE, 'map.json' ), '{"scenarios":[]}\n' );
  writeFileSync( join( dev, DOCS, 'blueprint.md' ), '# PROJ-42\n' );
  writeFileSync( join( dev, DOCS, 'decisions.md' ), '# decisions\n' );
  sh( dev, `git add -A && git ${ IDENTITY } commit -qm "design(${ KEY }): docs" && git push -q origin ${ BRANCH }` );
  const repo = join( root, 'repo' );
  sh( root, `git clone -q ${ origin } ${ repo }` );
  sh( repo, 'git config user.email steward@example.com && git config user.name "Blueprint Steward"' );
  const worktree = join( `${ repo }.blueprint-worktrees`, SESSION );
  return { root, origin, repo, dev, worktree, plan, forceMarker };
};

const writePlan = ( fx: Fixture, plan: Plan ) => writeFileSync( fx.plan, JSON.stringify( plan ) );
const argvLog = ( fx: Fixture ): string[][] => existsSync( `${ fx.plan }.argv.log` )
  ? readFileSync( `${ fx.plan }.argv.log`, 'utf-8' ).trim().split( '\n' ).map( ( line ) => JSON.parse( line ) as string[] )
  : [];
const originTip = ( fx: Fixture ): string => sh( fx.origin, `git rev-parse refs/heads/${ BRANCH }` );
const showAt = ( fx: Fixture, rev: string, path: string ): string | undefined => {
  const out = spawnSync( 'git', [ 'show', `${ rev }:${ path }` ], { cwd: fx.origin, encoding: 'utf-8', env: GIT_ENV } );
  return out.status === 0 ? out.stdout : undefined;
};
// The commit's changes against its parent, as `<status>\t<path>` lines, sorted by path.
const changesOf = ( fx: Fixture, commit: string ): string[] =>
  sh( fx.origin, `git diff-tree --no-commit-id -r --name-status ${ commit }^ ${ commit }` ).split( '\n' ).filter( Boolean )
    .sort( ( a, b ) => ( a.split( '\t' )[ 1 ] < b.split( '\t' )[ 1 ] ? -1 : 1 ) );
// The developer pushes a commit on top of origin's tip (the next base commit, or an edit to a stub).
const devCommit = ( fx: Fixture, files: Record<string, string>, message: string ): string => {
  sh( fx.dev, `git fetch -q origin && git checkout -q --detach origin/${ BRANCH }` );
  for ( const [ path, content ] of Object.entries( files ) ) {
    mkdirSync( dirname( join( fx.dev, path ) ), { recursive: true } );
    writeFileSync( join( fx.dev, path ), content );
  }
  sh( fx.dev, `git add -A && git ${ IDENTITY } commit -qm "${ message }" && git push -q origin HEAD:refs/heads/${ BRANCH }` );
  return originTip( fx );
};

const run = ( args: string[] ) =>
  new Promise<{ code: number | null; stderr: string }>( ( res ) => {
    const child = spawn( process.execPath, [ BIN, ...args ], { env: { ...GIT_ENV, BLUEPRINT_STEWARD_TOKEN: '', BLUEPRINT_SESSION_ID: '' } } );
    let stderr = '';
    child.stdout.on( 'data', () => undefined );
    child.stderr.on( 'data', ( c ) => { stderr += c; } );
    child.on( 'close', ( code ) => { res( { code, stderr } ); } );
  } );

const scaffoldJob = ( sha: string, id = 'js' ): Job => ( { id, kind: 'scaffold', sessionId: SESSION, branch: BRANCH, payload: { sha, key: KEY } } );
const scaffoldAt = async ( fx: Fixture, sha: string ) => {
  const host = await fixtureHost( scaffoldJob( sha ) );
  const ran = await run( [ 'start', '--server', host.url, '--token', 'tok', '--repo', fx.repo, '--once' ] );
  const [ report ] = host.reports();
  let result: unknown = report?.body?.result;
  try { result = JSON.parse( String( result ) ); } catch { /* kept as text, so an assertion prints it */ }
  return { status: report?.body?.status, reason: report?.body?.reason, result: result as Record<string, unknown>, stderr: ran.stderr, host };
};
const reportAt = ( fx: Fixture, rev: string ) => JSON.parse( showAt( fx, rev, REPORT ) ?? 'null' ) as Record<string, unknown> | null;

const EVENT_STUB = ( name: string ) => `// scaffolded\nexport const ${ name } = 'TODO';\n`;
const TODO_TEST = `import { describe, it } from 'vitest';\n\ndescribe( 'OrderPlaced', () => {\n  it.todo( 'SC-1: an order is placed' );\n} );\n`;
const PLACED_LINE = 'export * from \'./OrderPlaced.event\';';
const SUBMITTED_LINE = 'export * from \'./OrderSubmitted.event\';';
// The scenario test is its own node (the scenario's), so an edited event stub never holds it back.
const FIRST_PLAN: Plan = {
  files: [
    { file: PLACED, node: 'e1', content: EVENT_STUB( 'OrderPlaced' ) },
    { file: PLACED_TEST, node: 't1', content: TODO_TEST, kind: 'test' },
  ],
  appends: [ { file: BARREL, node: 'e1', code: PLACED_LINE } ],
};
// A file the scaffolder plans under the bundle's <root>/<KEY>/ folder: written, never committed.
const DOC_NOTE = `${ DOCS }/scaffold-notes.md`;

describe( 'blueprint-steward scaffold job', () => {
  it( 'Given the base commit and a leftover untracked file in the worktree, when a scaffold job runs, then one fast-forward commit holds the stubs, the it.todo test, the barrel line and scaffold.json, and nothing else', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    sh( fx.repo, `git fetch -q origin && git worktree add -q --detach ${ fx.worktree } origin/${ BRANCH }` );
    writeFileSync( join( fx.worktree, 'stray.txt' ), 'left over by an earlier job\n' );
    writeFileSync( join( fx.worktree, 'src', 'orders', 'Stray.ts' ), 'export const stray = 1;\n' );
    writePlan( fx, { ...FIRST_PLAN, files: [ ...FIRST_PLAN.files!, { file: DOC_NOTE, node: 'n1', content: '# notes\n' } ] } );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    // The scaffolder ran once with --write --json and the bundle's design and map.
    expect( argvLog( fx ) ).toEqual( [ [ '--write', '--json', '--design', `${ BUNDLE }/design.json`, '--map', `${ BUNDLE }/map.json` ] ] );
    const tip = originTip( fx );
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha } )
      .toEqual( { status: 'done', outcome: 'done', committed: true, commitSha: tip } );
    expect( sh( fx.origin, `git rev-parse ${ tip }^` ) ).toBe( sha1 );
    expect( changesOf( fx, tip ) ).toEqual( [ `A\t${ REPORT }`, `A\t${ PLACED }`, `A\t${ PLACED_TEST }`, `M\t${ BARREL }` ] );
    expect( changesOf( fx, tip ).filter( ( line ) => DOC_PATHS.some( ( doc ) => line.endsWith( `\t${ doc }` ) ) ) ).toEqual( [] );
    // The planned file under <root>/<KEY>/ is reported ignored and is absent from the commit.
    expect( { ignored: outcome.result?.ignored, atTip: showAt( fx, tip, DOC_NOTE ) } ).toEqual( { ignored: [ DOC_NOTE ], atTip: undefined } );
    expect( showAt( fx, tip, PLACED_TEST ) ).toContain( 'it.todo( \'SC-1: an order is placed\' )' );
    expect( showAt( fx, tip, BARREL ) ).toBe( `export {};\n${ PLACED_LINE }\n` );
    // git clean -fd ran before the extract: the leftovers are gone from the worktree and from the commit.
    expect( [ existsSync( join( fx.worktree, 'stray.txt' ) ), existsSync( join( fx.worktree, 'src', 'orders', 'Stray.ts' ) ) ] ).toEqual( [ false, false ] );
    // The report, mode hosted-cli: the manifest's blobs are the created files' git blob shas.
    const report = reportAt( fx, tip );
    expect( report ).toMatchObject( {
      version: 1, mode: 'hosted-cli', ticket: KEY, baseSha: sha1,
      created: [ { file: DOC_NOTE, node: 'n1' }, { file: PLACED, node: 'e1' }, { file: PLACED_TEST, node: 't1' } ],
      appended: [ { kind: 'barrel', file: BARREL, node: 'e1', code: PLACED_LINE } ],
      manifest: [ { file: PLACED, node: 'e1', blob: blobOf( EVENT_STUB( 'OrderPlaced' ) ) }, { file: PLACED_TEST, node: 't1', blob: blobOf( TODO_TEST ) } ],
      edited: [], stale: [], asked: [],
    } );
  }, 120_000 );

  it( 'Given the prior scaffold.json lists OrderPlaced.event.ts still blob-identical and its barrel line, and the design renamed it OrderSubmitted, when the scaffold job runs, then the commit deletes OrderPlaced.event.ts and its barrel line, adds OrderSubmitted.event.ts and its line, and rewrites scaffold.json', async () => {
    // GIVEN
    const fx = makeFixture();
    writePlan( fx, { files: [ FIRST_PLAN.files![ 0 ] ], appends: FIRST_PLAN.appends } );
    const first = await scaffoldAt( fx, originTip( fx ) );
    expect( first.status ).toBe( 'done' );
    const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Submitted' ) }, `design(${ KEY }): rename` );
    writePlan( fx, { files: [ { file: SUBMITTED, node: 'e1', content: EVENT_STUB( 'OrderSubmitted' ) } ], appends: [ { file: BARREL, node: 'e1', code: SUBMITTED_LINE } ] } );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    const tip = originTip( fx );
    expect( { status: outcome.status, committed: outcome.result?.committed, parent: sh( fx.origin, `git rev-parse ${ tip }^` ) } )
      .toEqual( { status: 'done', committed: true, parent: sha1 } );
    expect( changesOf( fx, tip ) ).toEqual( [ `M\t${ REPORT }`, `D\t${ PLACED }`, `A\t${ SUBMITTED }`, `M\t${ BARREL }` ] );
    // The barrel no longer names the deleted file, so the branch still compiles.
    expect( showAt( fx, tip, BARREL ) ).toBe( `export {};\n${ SUBMITTED_LINE }\n` );
    expect( reportAt( fx, tip ) ).toMatchObject( {
      baseSha: sha1, created: [ { file: SUBMITTED, node: 'e1' } ], manifest: [ { file: SUBMITTED, node: 'e1', blob: blobOf( EVENT_STUB( 'OrderSubmitted' ) ) } ],
      appended: [ { kind: 'barrel', file: BARREL, node: 'e1', code: SUBMITTED_LINE } ],
      stale: [ { file: PLACED, node: 'e1', barrel: [ { file: BARREL, code: PLACED_LINE } ] } ], edited: [],
    } );
  }, 120_000 );

  it( 'Given the prior scaffold.json lists a stub the implementation agent edited, when the scaffold job runs, then the stub is kept and scaffold.json lists it as edited', async () => {
    // GIVEN
    const fx = makeFixture();
    writePlan( fx, FIRST_PLAN );
    expect( ( await scaffoldAt( fx, originTip( fx ) ) ).status ).toBe( 'done' );
    const edited = 'export const OrderPlaced = { type: \'OrderPlaced\' };\n';
    devCommit( fx, { [ PLACED ]: edited }, 'feat: implement OrderPlaced' );
    const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    const tip = originTip( fx );
    expect( { status: outcome.status, committed: outcome.result?.committed, edited: outcome.result?.edited } ).toEqual( { status: 'done', committed: true, edited: [ PLACED ] } );
    expect( showAt( fx, tip, PLACED ) ).toBe( edited );
    // The untouched test stub was deleted and written again byte for byte, so only the report changes.
    expect( changesOf( fx, tip ) ).toEqual( [ `M\t${ REPORT }` ] );
    expect( reportAt( fx, tip ) ).toMatchObject( {
      edited: [ { file: PLACED, node: 'e1' } ],
      appended: [ { kind: 'barrel', file: BARREL, node: 'e1', code: PLACED_LINE } ],
      manifest: [ { file: PLACED, node: 'e1', blob: blobOf( EVENT_STUB( 'OrderPlaced' ) ) }, { file: PLACED_TEST, node: 't1', blob: blobOf( TODO_TEST ) } ],
    } );
  }, 120_000 );

  it( 'Given an unchanged design, when the scaffold job runs again at the next base commit, then nothing is committed and origin\'s tip is unmoved', async () => {
    // GIVEN
    const fx = makeFixture();
    writePlan( fx, FIRST_PLAN );
    expect( ( await scaffoldAt( fx, originTip( fx ) ) ).status ).toBe( 'done' );
    const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, tip: originTip( fx ) } )
      .toEqual( { status: 'done', outcome: 'done', committed: false, commitSha: sha1, tip: sha1 } );
  }, 120_000 );

  it( 'Given a scaffolder that writes nothing on a branch with no scaffold.json, when the job runs, then nothing is committed', async () => {
    const fx = makeFixture();
    const sha1 = originTip( fx );
    writePlan( fx, {} );

    const outcome = await scaffoldAt( fx, sha1 );

    expect( { status: outcome.status, committed: outcome.result?.committed, tip: originTip( fx ) } ).toEqual( { status: 'done', committed: false, tip: sha1 } );
  }, 120_000 );

  it( 'Given the fake scaffolder writes files and exits 3, when the job runs, then the files are committed and the report says blocked', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    const question = { code: 'decision', question: 'which aggregate hosts OrderPlaced?', needed: 'the host aggregate' };
    writePlan( fx, { ...FIRST_PLAN, exit: 3, skipped: [ { node: 'p1', reason: 'blocked', detail: 'needs a decision', decisions: [ question ] } ] } );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    const tip = originTip( fx );
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha } )
      .toEqual( { status: 'done', outcome: 'blocked', committed: true, commitSha: tip } );
    expect( changesOf( fx, tip ) ).toEqual( [ `A\t${ REPORT }`, `A\t${ PLACED }`, `A\t${ PLACED_TEST }`, `M\t${ BARREL }` ] );
    expect( reportAt( fx, tip ) ).toMatchObject( { asked: [ { node: 'p1', question: question.question } ] } );
  }, 120_000 );

  it( 'Given the scaffolder exits 1, when the job runs, then the job fails and origin\'s tip is unmoved', async () => {
    const fx = makeFixture();
    const sha1 = originTip( fx );
    writePlan( fx, { exit: 1 } );

    const outcome = await scaffoldAt( fx, sha1 );

    expect( { status: outcome.status, tip: originTip( fx ) } ).toEqual( { status: 'failed', tip: sha1 } );
    expect( outcome.result ).toMatchObject( { error: 'scaffold-failed', exitCode: 1 } );
  }, 120_000 );

  it( 'Given .blueprint.config.json has no designTooling.scaffold, when the job runs, then it reports skipped and the branch tip is unmoved', async () => {
    const fx = makeFixture( { scaffold: false } );
    const sha1 = originTip( fx );
    writePlan( fx, FIRST_PLAN );

    const outcome = await scaffoldAt( fx, sha1 );

    expect( { status: outcome.status, outcome: outcome.result?.outcome, tip: originTip( fx ), ran: argvLog( fx ) } )
      .toEqual( { status: 'done', outcome: 'skipped', tip: sha1, ran: [] } );
  }, 120_000 );

  it( 'Given the developer pushed onto the branch after the base commit, when the scaffold job for it runs, then it fails non-ff, never runs the scaffolder and leaves origin\'s tip where the developer put it', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    const moved = devCommit( fx, { 'src/orders/notes.ts': 'export const notes = 1;\n' }, 'feat: the developer moves on' );
    writePlan( fx, FIRST_PLAN );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    expect( { status: outcome.status, reason: outcome.reason, error: outcome.result?.error, tip: originTip( fx ), ran: argvLog( fx ), forced: existsSync( fx.forceMarker ) } )
      .toEqual( { status: 'failed', reason: 'non-ff', error: 'non-ff', tip: moved, ran: [], forced: false } );
  }, 120_000 );

  it( 'Given the branch moves while the scaffolder runs, when the scaffold commit is pushed, then the push is fast-forward only: the job fails non-ff and origin keeps the developer\'s commit, with no forced update attempted', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    sh( fx.dev, `git fetch -q origin && git checkout -q --detach origin/${ BRANCH }` );
    const race = `git -C ${ JSON.stringify( fx.dev ) } ${ IDENTITY } -c commit.gpgsign=false commit -q --allow-empty -m race && git -C ${ JSON.stringify( fx.dev ) } push -q origin HEAD:refs/heads/${ BRANCH }`;
    writePlan( fx, { ...FIRST_PLAN, during: race } );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    const raced = sh( fx.dev, 'git rev-parse HEAD' );
    expect( { status: outcome.status, reason: outcome.reason, tip: originTip( fx ), forced: existsSync( fx.forceMarker ) } )
      .toEqual( { status: 'failed', reason: 'non-ff', tip: raced, forced: false } );
    expect( raced ).not.toBe( sha1 );
  }, 120_000 );

  it( 'Given the scaffold commit for the base commit already landed on origin (Steward died before reporting), when the job runs again for it, then it reports done with that commit and runs nothing', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    writePlan( fx, FIRST_PLAN );
    expect( ( await scaffoldAt( fx, sha1 ) ).status ).toBe( 'done' );
    const landed = originTip( fx );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, resumed: outcome.result?.resumed, tip: originTip( fx ), runs: argvLog( fx ).length } )
      .toEqual( { status: 'done', outcome: 'done', committed: true, commitSha: landed, resumed: true, tip: landed, runs: 1 } );
    expect( landed ).not.toBe( sha1 );
  }, 120_000 );

  it( 'Given the scaffold commit for the base commit landed and the developer then pushed a commit on top of it, when the job runs again for it, then it fails non-ff rather than resuming the developer\'s commit, and leaves origin\'s tip where the developer put it', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    writePlan( fx, FIRST_PLAN );
    expect( ( await scaffoldAt( fx, sha1 ) ).status ).toBe( 'done' );
    const moved = devCommit( fx, { 'src/orders/notes.ts': 'export const notes = 1;\n' }, 'feat: the developer moves on' );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    expect( { status: outcome.status, reason: outcome.reason, error: outcome.result?.error, resumed: outcome.result?.resumed, tip: originTip( fx ), runs: argvLog( fx ).length } )
      .toEqual( { status: 'failed', reason: 'non-ff', error: 'non-ff', resumed: undefined, tip: moved, runs: 1 } );
  }, 120_000 );

  it( 'Given a scaffold landed, the developer pushed base commit 2 and then a commit on top of it, when the job runs for base commit 2, then it fails non-ff: the developer\'s commit carries the older scaffold.json, whose baseSha is not base commit 2', async () => {
    // GIVEN
    const fx = makeFixture();
    writePlan( fx, FIRST_PLAN );
    expect( ( await scaffoldAt( fx, originTip( fx ) ) ).status ).toBe( 'done' );
    const sha2 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
    const moved = devCommit( fx, { 'src/orders/notes.ts': 'export const notes = 1;\n' }, 'feat: the developer moves on' );
    expect( reportAt( fx, moved )?.baseSha ).not.toBe( sha2 );

    // WHEN
    const outcome = await scaffoldAt( fx, sha2 );

    // THEN
    expect( { status: outcome.status, reason: outcome.reason, error: outcome.result?.error, resumed: outcome.result?.resumed, tip: originTip( fx ), runs: argvLog( fx ).length } )
      .toEqual( { status: 'failed', reason: 'non-ff', error: 'non-ff', resumed: undefined, tip: moved, runs: 1 } );
  }, 120_000 );

  it( 'Given a scaffold that exited 3 already landed on origin, when the job runs again for the base commit, then the resumed report still says blocked', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    const question = { code: 'decision', question: 'which aggregate hosts OrderPlaced?', needed: 'the host aggregate' };
    writePlan( fx, { ...FIRST_PLAN, exit: 3, skipped: [ { node: 'p1', reason: 'blocked', detail: 'needs a decision', decisions: [ question ] } ] } );
    expect( ( await scaffoldAt( fx, sha1 ) ).result?.outcome ).toBe( 'blocked' );
    const landed = originTip( fx );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, resumed: outcome.result?.resumed, runs: argvLog( fx ).length } )
      .toEqual( { status: 'done', outcome: 'blocked', committed: true, commitSha: landed, resumed: true, runs: 1 } );
  }, 120_000 );
} );
