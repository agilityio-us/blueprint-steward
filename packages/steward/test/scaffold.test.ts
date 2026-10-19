import { execSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
// An existing file the placer inserts into, and a registration fragment's file.
const AGGREGATE = 'src/orders/Orders.aggregate.ts';
const AGGREGATE_CODE = 'export const Orders = {\n  PlaceOrder: 1,\n};\n';
const SERVER = 'src/server.ts';
// The extractor's registry: the code files it reads as design nodes. The renamed event keeps the design's node id, so
// OrderPlaced.event.ts on disk still reads as e1 (the node a rename re-labels). A `file#text` entry is a node declared
// inside an existing file: in the graph while that file holds the text (the placed command c1, read by its
// declaration, so code that only names DismissOrder is no declaration of it).
const EXTRACTS: Record<string, string> = { [ PLACED ]: 'e1', [ SUBMITTED ]: 'e1', [ `${ AGGREGATE }#const DismissOrder` ]: 'c1' };

const EMPTY_CONFIG = join( mkdtempSync( join( tmpdir(), 'scaffold-gitconfig-' ) ), 'empty' );
writeFileSync( EMPTY_CONFIG, '' );
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const IDENTITY = '-c user.email=dev@example.com -c user.name=Dev';
const sh = ( cwd: string, cmd: string ): string => execSync( cmd, { cwd, encoding: 'utf-8', env: GIT_ENV } ).trim();
const blobOf = ( content: string ): string => execSync( 'git hash-object --stdin', { input: content, encoding: 'utf-8', env: GIT_ENV } ).trim();
// A placed[] entry's binding to the file it placed into: that file's blob and the sha256 of its text (Blueprint ADR-128).
const boundTo = ( content: string ) => ( { blob: blobOf( content ), digest: `sha256:${ createHash( 'sha256' ).update( content ).digest( 'hex' ) }` } );

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
// lists as appended. Unless run with --no-place, it then places as the scaffolder's placer does: inserts each of the
// plan's `edits` whose node the extracted graph does not hold into its existing file, in order, at its `offset` or else
// at the end, and reports the plan's fragments with their `placement`; with --no-place it edits nothing and reports the fragments without one. It runs the plan's `during` shell command, if any, then prints
// the --json report and exits as told (with --no-place, as `noPlaceExit` tells, when the plan names it).
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
const place = !flags.includes( '--no-place' );
if ( place ) for ( const e of plan.edits ?? [] ) {
  if ( graph.has( e.node ) ) continue;
  const text = readFileSync( e.file, 'utf-8' );
  const at = e.offset ?? text.length;
  writeFileSync( e.file, text.slice( 0, at ) + e.code + text.slice( at ) );
}
const fragments = ( plan.fragments ?? [] ).map( ( { placement, ...rest } ) => ( place && placement ? { ...rest, placement } : rest ) );
if ( plan.during ) execSync( plan.during, { stdio: 'ignore' } );
process.stdout.write( JSON.stringify( { files, fragments, appends, hosted: [], skipped, deferred: plan.deferred ?? [], dropped: [],
  held: plan.held ?? [], testPlan: { configured: true, suites: [], undecided: [] }, scenarioTests: plan.scenarioTests ?? [], unplaced: [],
  scenariosExcluded: [], written: flags.includes( '--write' ), ...( plan.shapeOwed ? { shapeOwed: plan.shapeOwed } : {} ) }, null, 2 ) + '\\n' );
process.exit( !place && plan.noPlaceExit !== undefined ? plan.noPlaceExit : plan.exit ?? 0 );
`;
// The fake extractor: the graph holds the node of each code file in its registry (tools/extracts.json, file -> node)
// that is on disk now. A test file is no node, as the extractor reads code, not tests.
const FAKE_EXTRACT = ( registry: string ) => `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const registry = JSON.parse( readFileSync( ${ JSON.stringify( registry ) }, 'utf-8' ) );
const holds = ( entry ) => { const [ file, text ] = entry.split( '#' ); return existsSync( file ) && ( text === undefined || readFileSync( file, 'utf-8' ).includes( text ) ); };
const nodes = [ ...new Set( Object.entries( registry ).filter( ( [ entry ] ) => holds( entry ) ).map( ( [ , id ] ) => id ) ) ].sort().map( ( id ) => ( { id } ) );
mkdirSync( '.blueprint', { recursive: true } );
writeFileSync( '.blueprint/graph.json', JSON.stringify( { nodes, edges: [] } ) + '\\n' );
`;

// The fake typecheck (designTooling.typecheck): logs each run, prints each of the plan's `typecheck` lines whose `when`
// file holds its text (and whose `unless` file does not), and exits 2 when it printed any, as tsc does; with the plan's
// `exitIf`, it exits 2 when that file holds its text and 0 otherwise, whatever it printed (a chained command's exit).
const FAKE_TYPECHECK = `import { appendFileSync, readFileSync } from 'node:fs';
const planPath = process.argv[ 2 ];
appendFileSync( planPath + '.typecheck.log', 'ran\\n' );
const holds = ( rule ) => readFileSync( rule.file, 'utf-8' ).includes( rule.includes );
const plan = JSON.parse( readFileSync( planPath, 'utf-8' ) );
const lines = ( plan.typecheck ?? [] ).filter( ( r ) => ( !r.when || holds( r.when ) ) && ( !r.unless || !holds( r.unless ) ) ).map( ( r ) => r.line );
for ( const line of lines ) process.stdout.write( line + '\\n' );
process.exit( ( plan.exitIf ? holds( plan.exitIf ) : lines.length > 0 ) ? 2 : 0 );
`;

type PlannedFile = { file: string; node: string; content: string; kind?: string };
type Holds = { file: string; includes: string };
type Plan = {
  exit?: number; files?: PlannedFile[]; appends?: { file: string; node: string; code: string }[]; skipped?: unknown[]; held?: unknown[]; deferred?: unknown[]; scenarioTests?: unknown[]; during?: string;
  noPlaceExit?: number; fragments?: Record<string, unknown>[]; edits?: { file: string; code: string; node?: string; offset?: number }[]; typecheck?: { line: string; when?: Holds; unless?: Holds }[]; exitIf?: Holds;
  shapeOwed?: { node: string; artifact: string; line: string }[];
};

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

const makeFixture = ( { scaffold = true, typecheck = false }: { scaffold?: boolean; typecheck?: boolean } = {} ): Fixture => {
  const root = mkdtempSync( join( tmpdir(), 'blueprint-scaffold-' ) );
  const tools = join( root, 'tools' );
  mkdirSync( tools );
  writeFileSync( join( tools, 'scaffold.mjs' ), FAKE_SCAFFOLDER );
  writeFileSync( join( tools, 'extracts.json' ), JSON.stringify( EXTRACTS ) );
  writeFileSync( join( tools, 'extract.mjs' ), FAKE_EXTRACT( join( tools, 'extracts.json' ) ) );
  writeFileSync( join( tools, 'typecheck.mjs' ), FAKE_TYPECHECK );
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
    ...( typecheck ? { typecheck: typecheckCommand( root ) } : {} ),
  };
  writeFileSync( join( dev, '.blueprint.config.json' ), `${ JSON.stringify( { designTooling }, null, 2 ) }\n` );
  writeFileSync( join( dev, '.gitignore' ), '.blueprint/\n' );
  mkdirSync( join( dev, 'src', 'orders' ), { recursive: true } );
  writeFileSync( join( dev, BARREL ), 'export {};\n' );
  writeFileSync( join( dev, AGGREGATE ), AGGREGATE_CODE );
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

const typecheckCommand = ( root: string ): string => `node ${ join( root, 'tools', 'typecheck.mjs' ) } ${ join( root, 'plan.json' ) }`;
const typecheckRuns = ( fx: Fixture ): number => existsSync( `${ fx.plan }.typecheck.log` ) ? readFileSync( `${ fx.plan }.typecheck.log`, 'utf-8' ).trim().split( '\n' ).length : 0;
const writePlan = ( fx: Fixture, plan: Plan ) => writeFileSync( fx.plan, JSON.stringify( plan ) );
const argvLog = ( fx: Fixture ): string[][] => existsSync( `${ fx.plan }.argv.log` )
  ? readFileSync( `${ fx.plan }.argv.log`, 'utf-8' ).trim().split( '\n' ).map( ( line ) => JSON.parse( line ) as string[] )
  : [];
const originTip = ( fx: Fixture ): string => sh( fx.origin, `git rev-parse refs/heads/${ BRANCH }` );
const showAt = ( fx: Fixture, rev: string, path: string ): string | undefined => {
  const out = spawnSync( 'git', [ 'show', `${ rev }:${ path }` ], { cwd: fx.origin, encoding: 'utf-8', env: GIT_ENV } );
  return out.status === 0 ? out.stdout : undefined;
};
// The file's bytes at `rev`, undecoded, for a file that is not UTF-8.
const bytesAt = ( fx: Fixture, rev: string, path: string ): Buffer | undefined => {
  const out = spawnSync( 'git', [ 'show', `${ rev }:${ path }` ], { cwd: fx.origin, env: GIT_ENV } );
  return out.status === 0 ? out.stdout : undefined;
};
// The commit's changes against its parent, as `<status>\t<path>` lines, sorted by path.
const changesOf = ( fx: Fixture, commit: string ): string[] =>
  sh( fx.origin, `git diff-tree --no-commit-id -r --name-status ${ commit }^ ${ commit }` ).split( '\n' ).filter( Boolean )
    .sort( ( a, b ) => ( a.split( '\t' )[ 1 ] < b.split( '\t' )[ 1 ] ? -1 : 1 ) );
// The developer pushes a commit on top of origin's tip (the next base commit, or an edit to a stub).
const devCommit = ( fx: Fixture, files: Record<string, string | Buffer>, message: string ): string => {
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
const messageOf = ( fx: Fixture, rev: string ) => sh( fx.origin, `git log -1 --format=%B ${ rev }` ).trim();
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
    expect( messageOf( fx, tip ) ).toBe( `chore(${ KEY }): scaffold the agreed design\n\nBlueprint-Scaffold: ${ KEY }` );
    expect( report ).toMatchObject( {
      version: 1, status: 'done', mode: 'hosted-cli', ticket: KEY, baseSha: sha1,
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

  it( 'Given an unchanged design, when the scaffold job runs again at the next base commit, then a scaffold commit lands anyway, changing only scaffold.json, so the latest scaffold commit is the one in force', async () => {
    // GIVEN
    const fx = makeFixture();
    writePlan( fx, FIRST_PLAN );
    expect( ( await scaffoldAt( fx, originTip( fx ) ) ).status ).toBe( 'done' );
    const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    const tip = originTip( fx );
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, parent: sh( fx.origin, `git rev-parse ${ tip }^` ) } )
      .toEqual( { status: 'done', outcome: 'done', committed: true, commitSha: tip, parent: sha1 } );
    expect( changesOf( fx, tip ) ).toEqual( [ `M\t${ REPORT }` ] );
    expect( [ messageOf( fx, tip ), reportAt( fx, tip )?.baseSha ] ).toEqual( [ `chore(${ KEY }): scaffold the agreed design\n\nBlueprint-Scaffold: ${ KEY }`, sha1 ] );
  }, 120_000 );

  it( 'Given a scaffolder that writes nothing on a branch with no scaffold.json, when the job runs, then the scaffold commit holds scaffold.json alone, status done', async () => {
    const fx = makeFixture();
    const sha1 = originTip( fx );
    writePlan( fx, {} );

    const outcome = await scaffoldAt( fx, sha1 );

    const tip = originTip( fx );
    expect( { status: outcome.status, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha } ).toEqual( { status: 'done', committed: true, commitSha: tip } );
    expect( changesOf( fx, tip ) ).toEqual( [ `A\t${ REPORT }` ] );
    expect( reportAt( fx, tip ) ).toMatchObject( { status: 'done', baseSha: sha1 } );
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
    expect( reportAt( fx, tip ) ).toMatchObject( { status: 'blocked', asked: [ { node: 'p1', question: question.question } ] } );
  }, 120_000 );

  it( 'Given the fake scaffolder exits 3 only on units with no template, when the job runs, then they are still owed and the report says done', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    const noTemplate = { code: 'no-template', question: 'node type \'ui\' has no template', needed: 'hand-authoring, or a new template' };
    writePlan( fx, { ...FIRST_PLAN, exit: 3, skipped: [ { node: 'ui1', reason: 'blocked', detail: 'node type \'ui\' has no template', decisions: [ noTemplate ] } ] } );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    const tip = originTip( fx );
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, asked: outcome.result?.asked } )
      .toEqual( { status: 'done', outcome: 'done', committed: true, commitSha: tip, asked: [] } );
    expect( outcome.result?.stillOwed ).toContainEqual( { node: 'ui1', reason: 'no-template', detail: 'node type \'ui\' has no template' } );
    expect( reportAt( fx, tip ) ).toMatchObject( { status: 'done' } );
  }, 120_000 );

  // The scaffolder's still-owed data-shape lines reach the report and the job result as owed.
  it( 'Given a scaffolder that reports two shapeOwed lines for a command in code, when the job runs, then stillOwed owes each as shape-not-written with the line as its detail, in the scaffolder\'s order', async () => {
    // GIVEN
    const fx = makeFixture();
    const sha1 = originTip( fx );
    const CHANGED = '`orderId` of Place Order (c1) is changed by the design (orderId is string, designed integer); the scaffold never rewrites an existing field: change it in the code\'s schema';
    const REMOVED = '`note` of Place Order (c1) is no longer in its designed data shape; the scaffold never deletes code: remove it from the code\'s schema if it should go';
    writePlan( fx, { ...FIRST_PLAN, shapeOwed: [ { node: 'c1', artifact: 'command', line: REMOVED }, { node: 'c1', artifact: 'command', line: CHANGED } ], deferred: [ { node: 'a1', waitsOn: [ 'c9' ] } ] } );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    const tip = originTip( fx );
    const owed = [
      { node: 'a1', reason: 'deferred', detail: 'c9' },
      { node: 'c1', reason: 'shape-not-written', detail: REMOVED },
      { node: 'c1', reason: 'shape-not-written', detail: CHANGED },
    ];
    expect( { status: outcome.status, committed: outcome.result?.committed, stillOwed: outcome.result?.stillOwed } ).toEqual( { status: 'done', committed: true, stillOwed: owed } );
    expect( reportAt( fx, tip ) ).toMatchObject( { stillOwed: owed, worklist: [] } );
  }, 120_000 );

  it( 'Given the scaffolder exits 1, when the job runs, then the job fails and origin\'s tip is unmoved', async () => {
    const fx = makeFixture();
    const sha1 = originTip( fx );
    writePlan( fx, { exit: 1 } );

    const outcome = await scaffoldAt( fx, sha1 );

    expect( { status: outcome.status, tip: originTip( fx ) } ).toEqual( { status: 'failed', tip: sha1 } );
    expect( outcome.result ).toMatchObject( { error: 'scaffold-failed', exitCode: 1 } );
  }, 120_000 );

  it( 'Given .blueprint.config.json has no designTooling.scaffold, when the job runs, then nothing runs and the scaffold commit holds a scaffold.json whose status is skipped; run again, it resumes that commit', async () => {
    const fx = makeFixture( { scaffold: false } );
    const sha1 = originTip( fx );
    writePlan( fx, FIRST_PLAN );

    const outcome = await scaffoldAt( fx, sha1 );

    const tip = originTip( fx );
    expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, ran: argvLog( fx ) } )
      .toEqual( { status: 'done', outcome: 'skipped', committed: true, commitSha: tip, ran: [] } );
    expect( sh( fx.origin, `git rev-parse ${ tip }^` ) ).toBe( sha1 );
    expect( changesOf( fx, tip ) ).toEqual( [ `A\t${ REPORT }` ] );
    expect( messageOf( fx, tip ) ).toBe( `chore(${ KEY }): scaffold the agreed design\n\nBlueprint-Scaffold: ${ KEY }` );
    expect( reportAt( fx, tip ) ).toMatchObject( { version: 1, status: 'skipped', ticket: KEY, baseSha: sha1 } );

    const again = await scaffoldAt( fx, sha1 );
    expect( { outcome: again.result?.outcome, commitSha: again.result?.commitSha, resumed: again.result?.resumed, tip: originTip( fx ) } )
      .toEqual( { outcome: 'skipped', commitSha: tip, resumed: true, tip } );
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

  it( 'Given a landed scaffold whose report says blocked only on no-template units, when the job runs again for the base commit, then the resumed report says done', async () => {
    // GIVEN: the scaffold commit an older Steward landed on the base commit, its report stating blocked for a no-template unit alone
    const fx = makeFixture();
    const sha1 = originTip( fx );
    const noTemplate = { code: 'no-template', question: 'node type \'ui\' has no template', needed: 'hand-authoring, or a new template' };
    const scaffolder = { files: [], appends: [], skipped: [ { node: 'ui1', reason: 'blocked', detail: 'node type \'ui\' has no template', decisions: [ noTemplate ] } ] };
    const landed = devCommit( fx, { [ REPORT ]: `${ JSON.stringify( { version: 1, status: 'blocked', mode: 'hosted-cli', ticket: KEY, baseSha: sha1, scaffolder } ) }\n` }, `scaffold(${ KEY }): stubs` );

    // WHEN
    const outcome = await scaffoldAt( fx, sha1 );

    // THEN
    expect( { status: outcome.status, outcome: outcome.result?.outcome, commitSha: outcome.result?.commitSha, resumed: outcome.result?.resumed } )
      .toEqual( { status: 'done', outcome: 'done', commitSha: landed, resumed: true } );
  }, 120_000 );

  // The scaffolder places fragments into existing files; the job commits what it placed, lists it in placed[], owes
  // only what is still owed, and gates the placements on the declared typecheck (Blueprint ADR-128).
  describe( 'placements', () => {
    const DISMISS = 'export const DismissOrder = 2;\n';
    const GUARD = 'export const guardDismiss = Orders.PlaceOrder;\n';
    const fragment = ( node: string, artifact: string, file: string, extra: Record<string, unknown> = {} ) =>
      ( { file, anchor: `the ${ node } anchor`, imports: [], code: `// ${ node }`, todo: [], node, artifact, ...extra } );
    // i1 and c1 placed (i1 declares nothing: its key ends in an empty declares; listed first, while placed[] is
    // sorted by key), e2 already present, c3 owed with no anchor found, r1 a registration owed no-anchor.
    const PLACING_FRAGMENTS = [
      fragment( 'i1', 'invariant', AGGREGATE, { at: { kind: 'top-level' }, placement: { status: 'placed', inserted: [ { offset: AGGREGATE_CODE.length + DISMISS.length, text: GUARD } ] } } ),
      fragment( 'c1', 'command', AGGREGATE, { at: { kind: 'top-level' }, declares: 'DismissOrder', placement: { status: 'placed', inserted: [ { offset: AGGREGATE_CODE.length, text: DISMISS } ] } } ),
      fragment( 'e2', 'event', AGGREGATE, { at: { kind: 'top-level' }, declares: 'Orders', placement: { status: 'present' } } ),
      fragment( 'c3', 'command', AGGREGATE, { at: { kind: 'object-property', container: { variable: 'Missing' } }, declares: 'ShipOrder', placement: { status: 'owed', reason: 'anchor-not-found' } } ),
      fragment( 'r1', 'registration', SERVER, { placement: { status: 'owed', reason: 'no-anchor' } } ),
    ];
    const PLACING_PLAN: Plan = { ...FIRST_PLAN, fragments: PLACING_FRAGMENTS, edits: [ { file: AGGREGATE, code: DISMISS }, { file: AGGREGATE, code: GUARD } ] };
    const PLACED_AGGREGATE = `${ AGGREGATE_CODE }${ DISMISS }${ GUARD }`;
    // Each entry names the blob of the file the commit holds and the digest of its text, which its offsets index.
    const PLACED_ENTRIES = [
      { node: 'c1', file: AGGREGATE, key: `c1|${ AGGREGATE }|top-level|DismissOrder`, inserted: [ { offset: AGGREGATE_CODE.length, text: DISMISS } ], ...boundTo( PLACED_AGGREGATE ) },
      { node: 'i1', file: AGGREGATE, key: `i1|${ AGGREGATE }|top-level|`, inserted: [ { offset: AGGREGATE_CODE.length + DISMISS.length, text: GUARD } ], ...boundTo( PLACED_AGGREGATE ) },
    ];
    const STILL_OWED = [ { node: 'c3', reason: 'not-placed', detail: AGGREGATE }, { node: 'r1', reason: 'registration', detail: SERVER } ];
    // A tsc error the placement adds (its line and column, which the comparison sets aside, ADR-015) ...
    const PLACED_ERROR = `${ AGGREGATE }(4,14): error TS2322: Type 'string' is not assignable to type 'number'.`;
    // ... and a base error, in tsc's pretty form, that the placement only moves down the file (and tsc colours).
    const BASE_ERROR_AT = ( line: number ) => `src/orders/Broken.ts:${ line }:1 - error TS2304: Cannot find name 'x'.`;
    const COLOURED_BASE_ERROR_AT = ( line: number ) => `\u001b[96msrc/orders/Broken.ts\u001b[0m:${ line }:1 - \u001b[91merror\u001b[0m TS2304: Cannot find name 'x'.`;
    const BASE_ERROR_KEY = 'src/orders/Broken.ts - error TS2304: Cannot find name \'x\'.';

    it( 'Given a scaffolder that places two fragments into an existing file and a typecheck that exits 0, when the job runs, then the commit holds the edit, placed[] lists them, stillOwed owes only the owed ones and typecheck is green', async () => {
      // GIVEN
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      // A second fragment with c1's key (node|file|at.kind|declares): one placed[] entry per key.
      writePlan( fx, { ...PLACING_PLAN, fragments: [ ...PLACING_FRAGMENTS, PLACING_FRAGMENTS[ 1 ] ] } );

      // WHEN
      const outcome = await scaffoldAt( fx, sha1 );

      // THEN
      const tip = originTip( fx );
      expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, stillOwed: outcome.result?.stillOwed } )
        .toEqual( { status: 'done', outcome: 'done', committed: true, stillOwed: STILL_OWED } );
      expect( changesOf( fx, tip ) ).toEqual( [ `A\t${ REPORT }`, `A\t${ PLACED }`, `M\t${ AGGREGATE }`, `A\t${ PLACED_TEST }`, `M\t${ BARREL }` ] );
      expect( showAt( fx, tip, AGGREGATE ) ).toBe( PLACED_AGGREGATE );
      const report = reportAt( fx, tip );
      expect( { placed: report?.placed, stillOwed: report?.stillOwed, typecheck: report?.typecheck } ).toEqual( {
        placed: PLACED_ENTRIES, stillOwed: STILL_OWED, typecheck: { command: typecheckCommand( fx.root ), status: 'green', newErrors: [] },
      } );
      // The residue a placing agent would take: the owed topology fragment only.
      expect( ( report?.worklist as { node: string }[] ).map( ( f ) => f.node ) ).toEqual( [ 'c3' ] );
      // Green on the first typecheck: the scaffolder ran once, never with --no-place.
      expect( { runs: argvLog( fx ), typechecks: typecheckRuns( fx ) } ).toEqual( {
        runs: [ [ '--write', '--json', '--design', `${ BUNDLE }/design.json`, '--map', `${ BUNDLE }/map.json` ] ], typechecks: 1,
      } );
    }, 120_000 );

    // An edge stub carries the edge and its subject's artifact (here a read model, which TOPOLOGY does not name); its
    // registration fragment carries no edge. The host file's name is immaterial to Steward.
    const PROJECTION = { from: 'e9', to: 'rm1', kind: 'projected-to' };
    const PROJECTOR = { call: 'withProjector', arg: 'returned-object' };
    const EVENTS_MAP = { variable: 'ORDER_EVENTS' };

    it( 'Given an owed read-model fragment carrying an edge and its owed registration fragment, when the job runs, then the edge fragment is topology (on the worklist, owed not-placed) and the registration is not (owed registration)', async () => {
      // GIVEN
      const fx = makeFixture();
      const sha1 = originTip( fx );
      const STUB = fragment( 'rm1', 'read-model', AGGREGATE, { edge: PROJECTION, at: { kind: 'object-property', container: PROJECTOR }, declares: 'OrderShipped', placement: { status: 'owed', reason: 'anchor-not-found' } } );
      const REGISTRATION = fragment( 'rm1', 'read-model', SERVER, { placement: { status: 'owed', reason: 'no-anchor' } } );
      writePlan( fx, { ...FIRST_PLAN, fragments: [ STUB, REGISTRATION ] } );

      // WHEN
      const outcome = await scaffoldAt( fx, sha1 );

      // THEN
      const report = reportAt( fx, originTip( fx ) );
      expect( { status: outcome.status, worklist: report?.worklist, stillOwed: report?.stillOwed } ).toEqual( {
        status: 'done', worklist: [ STUB ],
        stillOwed: [ { node: 'rm1', reason: 'not-placed', detail: AGGREGATE }, { node: 'rm1', reason: 'registration', detail: SERVER } ],
      } );
    }, 120_000 );

    it( 'Given the two placed fragments of one projected-to edge (its events-map entry and its projector stub: same node, file, at.kind, declares and edge), when the job runs, then placed[] holds one entry per fragment, keyed with the edge and the container', async () => {
      // GIVEN
      const fx = makeFixture();
      const sha1 = originTip( fx );
      const ENTRY = 'OrderShipped: OrderEvents.OrderShipped,\n';
      const HANDLER = 'OrderShipped: async () => {},\n';
      const edgeFragment = ( container: Record<string, string>, offset: number, text: string ) => fragment( 'rm1', 'read-model', AGGREGATE, {
        edge: PROJECTION, at: { kind: 'object-property', container }, declares: 'OrderShipped', placement: { status: 'placed', inserted: [ { offset, text } ] },
      } );
      writePlan( fx, {
        ...FIRST_PLAN,
        fragments: [ edgeFragment( PROJECTOR, AGGREGATE_CODE.length + ENTRY.length, HANDLER ), edgeFragment( EVENTS_MAP, AGGREGATE_CODE.length, ENTRY ) ],
        edits: [ { file: AGGREGATE, code: ENTRY }, { file: AGGREGATE, code: HANDLER } ],
      } );

      // WHEN
      const outcome = await scaffoldAt( fx, sha1 );

      // THEN
      // An edge stub's entry is bound like any other placement, its spans and the placed file's blob and digest, so a
      // re-press can take an untouched one out byte-exact.
      const base = `rm1|${ AGGREGATE }|object-property|OrderShipped|edge:e9|rm1|projected-to`;
      const bound = boundTo( `${ AGGREGATE_CODE }${ ENTRY }${ HANDLER }` );
      expect( { status: outcome.status, placed: reportAt( fx, originTip( fx ) )?.placed } ).toEqual( {
        status: 'done',
        placed: [
          { node: 'rm1', file: AGGREGATE, key: `${ base }|ORDER_EVENTS`, inserted: [ { offset: AGGREGATE_CODE.length, text: ENTRY } ], ...bound },
          { node: 'rm1', file: AGGREGATE, key: `${ base }|withProjector(returned-object)`, inserted: [ { offset: AGGREGATE_CODE.length + ENTRY.length, text: HANDLER } ], ...bound },
        ],
      } );
    }, 120_000 );

    it( 'Given a typecheck that prints an error only when the placement is present, when the job runs, then the --no-place tree is committed, the placed fragments are owed placed-but-red and typecheck is dropped with that error', async () => {
      // GIVEN
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...PLACING_PLAN, typecheck: [ { line: PLACED_ERROR, when: { file: AGGREGATE, includes: 'DismissOrder' } } ] } );

      // WHEN
      const outcome = await scaffoldAt( fx, sha1 );

      // THEN
      const tip = originTip( fx );
      const owed = [
        { node: 'c1', reason: 'placed-but-red', detail: AGGREGATE }, ...STILL_OWED.slice( 0, 1 ),
        { node: 'i1', reason: 'placed-but-red', detail: AGGREGATE }, ...STILL_OWED.slice( 1 ),
      ];
      // Never held: the step is done, its commit the one without placements.
      expect( { status: outcome.status, outcome: outcome.result?.outcome, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, stillOwed: outcome.result?.stillOwed } )
        .toEqual( { status: 'done', outcome: 'done', committed: true, commitSha: tip, stillOwed: owed } );
      expect( changesOf( fx, tip ) ).toEqual( [ `A\t${ REPORT }`, `A\t${ PLACED }`, `A\t${ PLACED_TEST }`, `M\t${ BARREL }` ] );
      expect( showAt( fx, tip, AGGREGATE ) ).toBe( AGGREGATE_CODE );
      const report = reportAt( fx, tip );
      expect( { placed: report?.placed, stillOwed: report?.stillOwed, typecheck: report?.typecheck } ).toEqual( {
        placed: [], stillOwed: owed,
        typecheck: { command: typecheckCommand( fx.root ), status: 'dropped', newErrors: [ `${ AGGREGATE }: error TS2322: Type 'string' is not assignable to type 'number'.` ] },
      } );
      expect( ( report?.scaffolder as { fragments: { placement?: unknown }[] } ).fragments.filter( ( f ) => f.placement !== undefined ) ).toEqual( [] );
      // The rebuild ran the scaffolder again with --no-place, and typechecked both trees.
      expect( { runs: argvLog( fx ).map( ( argv ) => argv.includes( '--no-place' ) ), typechecks: typecheckRuns( fx ) } ).toEqual( { runs: [ false, true ], typechecks: 2 } );
    }, 120_000 );

    it( 'Given a typecheck that prints the same error with and without the placement (at another line), when the job runs, then the placements are committed and typecheck is red-base', async () => {
      // GIVEN
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...PLACING_PLAN, typecheck: [
        { line: COLOURED_BASE_ERROR_AT( 9 ), when: { file: AGGREGATE, includes: 'DismissOrder' } },
        { line: BASE_ERROR_AT( 1 ), unless: { file: AGGREGATE, includes: 'DismissOrder' } },
      ] } );

      // WHEN
      const outcome = await scaffoldAt( fx, sha1 );

      // THEN
      const tip = originTip( fx );
      expect( { status: outcome.status, committed: outcome.result?.committed, stillOwed: outcome.result?.stillOwed } ).toEqual( { status: 'done', committed: true, stillOwed: STILL_OWED } );
      expect( changesOf( fx, tip ) ).toEqual( [ `A\t${ REPORT }`, `A\t${ PLACED }`, `M\t${ AGGREGATE }`, `A\t${ PLACED_TEST }`, `M\t${ BARREL }` ] );
      expect( showAt( fx, tip, AGGREGATE ) ).toBe( PLACED_AGGREGATE );
      const report = reportAt( fx, tip );
      expect( { placed: report?.placed, typecheck: report?.typecheck } ).toEqual( {
        placed: PLACED_ENTRIES, typecheck: { command: typecheckCommand( fx.root ), status: 'red-base', newErrors: [] },
      } );
      expect( argvLog( fx ).map( ( argv ) => argv.includes( '--no-place' ) ) ).toEqual( [ false, true ] );
    }, 120_000 );

    it( 'Given a typecheck that prints the same error with and without the placement but exits 0 without it, when the job runs, then the base is not red and the placements are dropped', async () => {
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...PLACING_PLAN, typecheck: [ { line: BASE_ERROR_AT( 1 ) } ], exitIf: { file: AGGREGATE, includes: 'DismissOrder' } } );

      const outcome = await scaffoldAt( fx, sha1 );

      // A base that exits 0 is not red, refused before the error sets are compared (scaffold-commit.py judge_red): nothing
      // is listed, and the set did not grow.
      const tip = originTip( fx );
      expect( { status: outcome.status, aggregate: showAt( fx, tip, AGGREGATE ), placed: reportAt( fx, tip )?.placed, typecheck: reportAt( fx, tip )?.typecheck } ).toEqual( {
        status: 'done', aggregate: AGGREGATE_CODE, placed: [], typecheck: { command: typecheckCommand( fx.root ), status: 'dropped', newErrors: [] },
      } );
    }, 120_000 );

    it( 'Given a scaffolder that placed nothing (fragments present or owed) and a red typecheck, when the job runs, then typecheck is red-base and the scaffolder is not run again', async () => {
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...FIRST_PLAN, fragments: PLACING_FRAGMENTS.slice( 2 ), typecheck: [ { line: BASE_ERROR_AT( 1 ) } ] } );

      const outcome = await scaffoldAt( fx, sha1 );

      const report = reportAt( fx, originTip( fx ) );
      expect( { status: outcome.status, committed: outcome.result?.committed, placed: report?.placed, typecheck: report?.typecheck, runs: argvLog( fx ).length, typechecks: typecheckRuns( fx ) } ).toEqual( {
        status: 'done', committed: true, placed: [], typecheck: { command: typecheckCommand( fx.root ), status: 'red-base', newErrors: [] }, runs: 1, typechecks: 1,
      } );
    }, 120_000 );

    it( 'Given a typecheck red with and without the placement but printing no `error TS<n>` line, when the job runs, then the placements are dropped (fail-safe, ADR-015)', async () => {
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...PLACING_PLAN, typecheck: [ { line: 'Build failed: see above.' } ] } );

      const outcome = await scaffoldAt( fx, sha1 );

      const tip = originTip( fx );
      expect( { status: outcome.status, aggregate: showAt( fx, tip, AGGREGATE ), typecheck: reportAt( fx, tip )?.typecheck } ).toEqual( {
        status: 'done', aggregate: AGGREGATE_CODE, typecheck: { command: typecheckCommand( fx.root ), status: 'dropped', newErrors: [] },
      } );
    }, 120_000 );

    it( 'Given a base error the placement prints a second time, when the job runs, then the second copy is a new error and the placements are dropped', async () => {
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...PLACING_PLAN, typecheck: [ { line: BASE_ERROR_AT( 1 ) }, { line: BASE_ERROR_AT( 7 ), when: { file: AGGREGATE, includes: 'DismissOrder' } } ] } );

      const outcome = await scaffoldAt( fx, sha1 );

      const tip = originTip( fx );
      expect( { status: outcome.status, aggregate: showAt( fx, tip, AGGREGATE ), typecheck: reportAt( fx, tip )?.typecheck } ).toEqual( {
        status: 'done', aggregate: AGGREGATE_CODE, typecheck: { command: typecheckCommand( fx.root ), status: 'dropped', newErrors: [ BASE_ERROR_KEY ] },
      } );
    }, 120_000 );

    it( 'Given red placements and a scaffolder that fails when rebuilt with --no-place, when the job runs, then the job fails scaffold-failed and origin\'s tip is unmoved', async () => {
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...PLACING_PLAN, noPlaceExit: 1, typecheck: [ { line: PLACED_ERROR, when: { file: AGGREGATE, includes: 'DismissOrder' } } ] } );

      const outcome = await scaffoldAt( fx, sha1 );

      expect( { status: outcome.status, error: outcome.result?.error, exitCode: outcome.result?.exitCode, tip: originTip( fx ), runs: argvLog( fx ).length } )
        .toEqual( { status: 'failed', error: 'scaffold-failed', exitCode: 1, tip: sha1, runs: 2 } );
    }, 120_000 );

    it( 'Given a scaffolder that reports a fragment placed into a file outside the repository, when the job runs, then the job fails scaffold-output-invalid and origin\'s tip is unmoved', async () => {
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      writePlan( fx, { ...FIRST_PLAN, fragments: [ fragment( 'c1', 'command', '../outside.ts', { at: { kind: 'top-level' }, placement: { status: 'placed' } } ) ] } );

      const outcome = await scaffoldAt( fx, sha1 );

      expect( { status: outcome.status, error: outcome.result?.error, tip: originTip( fx ), typechecks: typecheckRuns( fx ) } )
        .toEqual( { status: 'failed', error: 'scaffold-output-invalid', tip: sha1, typechecks: 0 } );
    }, 120_000 );

    it( 'Given designTooling declares scaffold but no typecheck, when the job runs, then the placements are committed and typecheck is undeclared', async () => {
      // GIVEN
      const fx = makeFixture();
      const sha1 = originTip( fx );
      writePlan( fx, PLACING_PLAN );

      // WHEN
      const outcome = await scaffoldAt( fx, sha1 );

      // THEN
      const tip = originTip( fx );
      expect( { status: outcome.status, committed: outcome.result?.committed } ).toEqual( { status: 'done', committed: true } );
      expect( showAt( fx, tip, AGGREGATE ) ).toBe( PLACED_AGGREGATE );
      const report = reportAt( fx, tip );
      expect( { placed: report?.placed, typecheck: report?.typecheck } ).toEqual( { placed: PLACED_ENTRIES, typecheck: { command: null, status: 'undeclared', newErrors: [] } } );
      expect( argvLog( fx ).length ).toBe( 1 );
    }, 120_000 );

    it( 'Given a scaffolder whose fragments carry no placement field and a declared typecheck that is red, when the job runs, then scaffold.json is the report Steward wrote before it committed placements: worklist, stillOwed not-placed, placed [], typecheck null, and no typecheck runs', async () => {
      // GIVEN
      const fx = makeFixture( { typecheck: true } );
      const sha1 = originTip( fx );
      const OLD_FRAGMENTS = [
        fragment( 'c1', 'command', AGGREGATE ),
        fragment( 'r1', 'registration', SERVER ),
        fragment( 's1', 'command', 'unplaced:SC-1' ),
      ];
      writePlan( fx, { ...FIRST_PLAN, fragments: OLD_FRAGMENTS, typecheck: [ { line: BASE_ERROR_AT( 1 ) } ] } );

      // WHEN
      const outcome = await scaffoldAt( fx, sha1 );

      // THEN
      const tip = originTip( fx );
      expect( { status: outcome.status, committed: outcome.result?.committed, runs: argvLog( fx ).length, typechecks: typecheckRuns( fx ) } )
        .toEqual( { status: 'done', committed: true, runs: 1, typechecks: 0 } );
      const sha256 = ( text: string ) => `sha256:${ createHash( 'sha256' ).update( text ).digest( 'hex' ) }`;
      // The report Steward wrote before it committed placements, for this run, written out by hand.
      expect( reportAt( fx, tip ) ).toEqual( {
        version: 1, status: 'done', mode: 'hosted-cli', ticket: KEY, baseSha: sha1,
        inputs: { maps: [ { file: `${ BUNDLE }/map.json`, digest: sha256( '{"scenarios":[]}\n' ) } ], design: sha256( designJson( 'Order Placed' ) ), graph: expect.stringMatching( /^sha256:[0-9a-f]{64}$/ ) },
        created: [ { file: PLACED, node: 'e1' }, { file: PLACED_TEST, node: 't1' } ],
        appended: [ { kind: 'barrel', file: BARREL, node: 'e1', code: PLACED_LINE } ],
        manifest: [ { file: PLACED, node: 'e1', blob: blobOf( EVENT_STUB( 'OrderPlaced' ) ) }, { file: PLACED_TEST, node: 't1', blob: blobOf( TODO_TEST ) } ],
        worklist: [ OLD_FRAGMENTS[ 0 ] ], placed: [], held: [], asked: [],
        stillOwed: [ { node: 'c1', reason: 'not-placed', detail: AGGREGATE }, { node: 'r1', reason: 'registration', detail: SERVER }, { node: 's1', reason: 'registration', detail: 'unplaced:SC-1' } ],
        stale: [], edited: [], observe: null, typecheck: null, scenarioTests: [], unplaced: [], scenariosExcluded: [],
        scaffolder: {
          files: [ { kind: 'code', file: PLACED, node: 'e1', content: EVENT_STUB( 'OrderPlaced' ) }, { kind: 'test', file: PLACED_TEST, node: 't1', content: TODO_TEST } ],
          fragments: OLD_FRAGMENTS, appends: [ { kind: 'barrel', file: BARREL, node: 'e1', code: PLACED_LINE } ], hosted: [], skipped: [], deferred: [], dropped: [],
          held: [], testPlan: { configured: true, suites: [], undecided: [] }, scenarioTests: [], unplaced: [], scenariosExcluded: [], written: true,
        },
      } );
    }, 120_000 );

    // On the next press the job first takes out each earlier placement whose inserted text is still verbatim in its
    // file, as it deletes untouched stubs; an edited one stays and is reported edited (Blueprint ADR-128). The fake
    // scaffolder inserts its edits whatever the file holds, so a placement left in would be placed a second time.
    describe( 'a re-press', () => {
      const RENAMED = 'export const CancelOrder = 2;\n';
      const commandPlan = ( code: string, declares: string ): Plan => ( {
        fragments: [ fragment( 'c1', 'command', AGGREGATE, { at: { kind: 'top-level' }, declares, placement: { status: 'placed', inserted: [ { offset: AGGREGATE_CODE.length, text: code } ] } } ) ],
        edits: [ { file: AGGREGATE, code, node: 'c1' } ],
      } );
      const entryOf = ( code: string, declares: string ) => ( {
        node: 'c1', file: AGGREGATE, key: `c1|${ AGGREGATE }|top-level|${ declares }`, inserted: [ { offset: AGGREGATE_CODE.length, text: code } ], ...boundTo( `${ AGGREGATE_CODE }${ code }` ),
      } );

      it( 'Given a first press placed a command nobody edited, when Design done is pressed again with the same design, then the command is removed, placed again verbatim and the scaffold commit changes only scaffold.json', async () => {
        // GIVEN
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );

        // WHEN
        const outcome = await scaffoldAt( fx, sha1 );

        // THEN
        // Steward commits on every press (the latest scaffold commit is the one in force): here only scaffold.json changes.
        const tip = originTip( fx );
        expect( { status: outcome.status, committed: outcome.result?.committed, commitSha: outcome.result?.commitSha, parent: sh( fx.origin, `git rev-parse ${ tip }^` ), changes: changesOf( fx, tip ), edited: outcome.result?.edited } )
          .toEqual( { status: 'done', committed: true, commitSha: tip, parent: sha1, changes: [ `M\t${ REPORT }` ], edited: [] } );
        // The scaffolder ran on the press, against a graph extracted with the command taken out (removed before
        // re-extracting, so c1 is not satisfied), and the command is in the worktree once.
        const graphNodes = ( JSON.parse( readFileSync( join( fx.worktree, '.blueprint', 'graph.json' ), 'utf-8' ) ) as { nodes: { id: string }[] } ).nodes.map( ( n ) => n.id );
        expect( { runs: argvLog( fx ).length, graphNodes, aggregate: readFileSync( join( fx.worktree, AGGREGATE ), 'utf-8' ) } )
          .toEqual( { runs: 2, graphNodes: [], aggregate: `${ AGGREGATE_CODE }${ DISMISS }` } );
      }, 120_000 );

      it( 'Given a first press placed DismissOrder, untouched, when the design renames it CancelOrder and the job runs, then the old declaration is removed and the renamed one is placed', async () => {
        // GIVEN
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Cancelled' ) }, `design(${ KEY }): rename` );
        writePlan( fx, commandPlan( RENAMED, 'CancelOrder' ) );

        // WHEN
        const outcome = await scaffoldAt( fx, sha1 );

        // THEN
        const tip = originTip( fx );
        expect( { status: outcome.status, committed: outcome.result?.committed, parent: sh( fx.origin, `git rev-parse ${ tip }^` ) } )
          .toEqual( { status: 'done', committed: true, parent: sha1 } );
        expect( showAt( fx, tip, AGGREGATE ) ).toBe( `${ AGGREGATE_CODE }${ RENAMED }` );
        expect( changesOf( fx, tip ) ).toEqual( [ `M\t${ REPORT }`, `M\t${ AGGREGATE }` ] );
        const report = reportAt( fx, tip );
        expect( { placed: report?.placed, edited: report?.edited } ).toEqual( { placed: [ entryOf( RENAMED, 'CancelOrder' ) ], edited: [] } );
      }, 120_000 );

      it( 'Given a placed command whose body was edited, when the job runs again, then the command is kept, listed as edited in scaffold.json and still listed in placed[]', async () => {
        // GIVEN
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const edited = `${ AGGREGATE_CODE }export const DismissOrder = 3;\n`;
        devCommit( fx, { [ AGGREGATE ]: edited }, 'feat: implement DismissOrder' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        // The scaffolder finds DismissOrder declared and places nothing (present).
        writePlan( fx, { fragments: [ fragment( 'c1', 'command', AGGREGATE, { at: { kind: 'top-level' }, declares: 'DismissOrder', placement: { status: 'present' } } ) ] } );

        // WHEN
        const outcome = await scaffoldAt( fx, sha1 );

        // THEN
        const tip = originTip( fx );
        expect( { status: outcome.status, committed: outcome.result?.committed, edited: outcome.result?.edited } ).toEqual( { status: 'done', committed: true, edited: [ AGGREGATE ] } );
        expect( showAt( fx, tip, AGGREGATE ) ).toBe( edited );
        expect( changesOf( fx, tip ) ).toEqual( [ `M\t${ REPORT }` ] );
        const report = reportAt( fx, tip );
        // A re-press never shrinks placed[]: the kept placement stays listed, with the text it inserted and no blob or
        // digest, so no later press reads its spans.
        const { blob: _blob, digest: _digest, ...unbound } = entryOf( DISMISS, 'DismissOrder' );
        expect( { placed: report?.placed, edited: report?.edited } ).toEqual( {
          placed: [ unbound ], edited: [ { file: AGGREGATE, node: 'c1', key: `c1|${ AGGREGATE }|top-level|DismissOrder` } ],
        } );
      }, 120_000 );

      it( 'Given a first press placed a command the design has since dropped, when the job runs, then the file is committed without it and placed[] is empty', async () => {
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop the command` );
        writePlan( fx, {} );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { committed: outcome.result?.committed, written: outcome.result?.written, aggregate: showAt( fx, tip, AGGREGATE ), placed: reportAt( fx, tip )?.placed } )
          .toEqual( { committed: true, written: [ AGGREGATE ], aggregate: AGGREGATE_CODE, placed: [] } );
      }, 120_000 );

      // What the core placer reports for a command merged into an existing import (a span that starts and ends mid-line)
      // and used on a line below it, at offsets into the file it wrote.
      type Span = { offset: number; text: string };
      const IMPORTS = 'import { Orders } from \'./orders.aggregate\';\n';
      const AFTER_ORDERS = 'import { Orders'.length;
      const PRESENT = [ fragment( 'c1', 'command', AGGREGATE, { at: { kind: 'top-level' }, declares: 'DismissOrder', placement: { status: 'present' } } ) ];
      const EDITED_ENTRY = { file: AGGREGATE, node: 'c1', key: `c1|${ AGGREGATE }|top-level|DismissOrder` };
      const spansPlan = ( declares: string, spans: Span[] ): Plan => ( {
        fragments: [ fragment( 'c1', 'command', AGGREGATE, { at: { kind: 'top-level' }, declares, placement: { status: 'placed', inserted: spans } } ) ],
        edits: spans.map( ( span ) => ( { file: AGGREGATE, node: 'c1', offset: span.offset, code: span.text } ) ),
      } );
      const merged = ( name: string, use: string, shift = 0 ): Span[] => [
        { offset: shift + AFTER_ORDERS, text: `, ${ name }` },
        { offset: shift + IMPORTS.length + `, ${ name }`.length, text: use },
      ];

      it( 'Given an untouched placement merged into an import line and hand-written lines added above it since, when the design renames the command, then the old specifier and line are removed and only the renamed ones are placed', async () => {
        // GIVEN
        const fx = makeFixture();
        devCommit( fx, { [ AGGREGATE ]: IMPORTS }, 'feat: the orders import' );
        writePlan( fx, spansPlan( 'DismissOrder', merged( 'DismissOrder', 'export const dismiss = DismissOrder;\n' ) ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const HEADER = '// orders\nimport { Clock } from \'./clock\';\n';
        devCommit( fx, { [ AGGREGATE ]: `${ HEADER }import { Orders, DismissOrder } from './orders.aggregate';\nexport const dismiss = DismissOrder;\n` }, 'feat: a header' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Cancelled' ) }, `design(${ KEY }): rename` );
        const renamed = merged( 'CancelOrder', 'export const cancel = CancelOrder;\n', HEADER.length );
        writePlan( fx, spansPlan( 'CancelOrder', renamed ) );

        // WHEN
        const outcome = await scaffoldAt( fx, sha1 );

        // THEN
        const tip = originTip( fx );
        const aggregate = `${ HEADER }import { Orders, CancelOrder } from './orders.aggregate';\nexport const cancel = CancelOrder;\n`;
        expect( { committed: outcome.result?.committed, edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ) } ).toEqual( { committed: true, edited: [], aggregate } );
        expect( reportAt( fx, tip )?.placed ).toEqual( [ { node: 'c1', file: AGGREGATE, key: `c1|${ AGGREGATE }|top-level|CancelOrder`, inserted: renamed, ...boundTo( aggregate ) } ] );
      }, 120_000 );

      // Placed again at the offset its anchor now gives, in another file: the code is unchanged and scaffold.json records
      // the new offset and blob.
      it( 'Given hand-written code added above an untouched placement (its offset moved), when the job runs, then it is removed and placed again and only scaffold.json is committed', async () => {
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const HEADER = '// orders\n';
        const handWritten = `${ HEADER }${ AGGREGATE_CODE }${ DISMISS }`;
        devCommit( fx, { [ AGGREGATE ]: handWritten }, 'docs: a header' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        const moved = { offset: HEADER.length + AGGREGATE_CODE.length, text: DISMISS };
        writePlan( fx, spansPlan( 'DismissOrder', [ moved ] ) );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { committed: outcome.result?.committed, edited: outcome.result?.edited, changes: changesOf( fx, tip ), aggregate: showAt( fx, tip, AGGREGATE ), placed: reportAt( fx, tip )?.placed } ).toEqual( {
          committed: true, edited: [], changes: [ `M\t${ REPORT }` ], aggregate: handWritten,
          placed: [ { node: 'c1', file: AGGREGATE, key: `c1|${ AGGREGATE }|top-level|DismissOrder`, inserted: [ moved ], ...boundTo( handWritten ) } ],
        } );
      }, 120_000 );

      // A declaration inserted after the closing `};` (just before its newline, or where the file ends with no newline),
      // or below a header comment, at the core placer's offsets; the developer's commit then moves it.
      const LEADING = '\n\nexport const DismissOrder = 2;';
      const DECLARED = 'export const DismissOrder = 2;\n';
      it.each( [
        [ 'opens with a newline and closes before one, moved by a header added above it', AGGREGATE_CODE, { offset: AGGREGATE_CODE.length - 1, text: LEADING }, `// orders\n${ AGGREGATE_CODE.slice( 0, -1 ) }${ LEADING }\n`, `// orders\n${ AGGREGATE_CODE }` ],
        [ 'opens with a newline and closes the file, moved by a header added above it', AGGREGATE_CODE.slice( 0, -1 ), { offset: AGGREGATE_CODE.length - 1, text: LEADING }, `// orders\n${ AGGREGATE_CODE.slice( 0, -1 ) }${ LEADING }`, `// orders\n${ AGGREGATE_CODE.slice( 0, -1 ) }` ],
        [ 'opens the file once the header above it was deleted', `// orders\n${ AGGREGATE_CODE }`, { offset: '// orders\n'.length, text: DECLARED }, `${ DECLARED }${ AGGREGATE_CODE }`, AGGREGATE_CODE ],
      ] )( 'Given an untouched placement whose span %s, and a design that has since dropped it, when the job runs, then it is taken out', async ( _how, base, span, handWritten, left ) => {
        const fx = makeFixture();
        if ( base !== AGGREGATE_CODE ) devCommit( fx, { [ AGGREGATE ]: base }, 'feat: the aggregate' );
        writePlan( fx, spansPlan( 'DismissOrder', [ span ] ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        devCommit( fx, { [ AGGREGATE ]: handWritten }, 'docs: the developer moves the placement' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop the command` );
        writePlan( fx, {} );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), placed: reportAt( fx, tip )?.placed } )
          .toEqual( { edited: [], aggregate: left, placed: [] } );
      }, 120_000 );

      it( 'Given a placement whose span covers several lines and a hand-written line the developer added inside it, when the job runs, then it is kept and reported edited', async () => {
        const fx = makeFixture();
        writePlan( fx, spansPlan( 'DismissOrder', [ { offset: AGGREGATE_CODE.length - 1, text: LEADING } ] ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const commented = `${ AGGREGATE_CODE.slice( 0, -1 ) }\n\n// why\n${ DECLARED }`;
        devCommit( fx, { [ AGGREGATE ]: commented }, 'docs: explain DismissOrder' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        writePlan( fx, { fragments: PRESENT } );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { edited: [ AGGREGATE ], aggregate: commented, reportEdited: [ EDITED_ENTRY ] } );
      }, 120_000 );

      it( 'Given an untouched placement the developer moved above the code it followed (its text unchanged, its lines deleted and added again), when the job runs, then it is kept and reported edited', async () => {
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const moved = `${ DISMISS }${ AGGREGATE_CODE }`;
        devCommit( fx, { [ AGGREGATE ]: moved }, 'refactor: move' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { edited: [ AGGREGATE ], aggregate: moved, reportEdited: [ EDITED_ENTRY ] } );
      }, 120_000 );

      // The developer's import: sorted, so the line holding `, DismissOrder` changed (with a hand-written line naming
      // DismissOrderReason, or passing DismissOrder, below it), or the merged specifier edited in place.
      it.each( [
        [ 'sorted the import and hand-wrote a line naming DismissOrderReason', AFTER_ORDERS, ', DismissOrder', 'import { DismissOrder, Orders } from \'./orders.aggregate\';\nexport const dismiss = DismissOrder;\nexport const why = describe( Orders, DismissOrderReason );\n' ],
        [ 'sorted the import and hand-wrote a call passing DismissOrder after Orders', AFTER_ORDERS, ', DismissOrder', 'import { DismissOrder, Orders } from \'./orders.aggregate\';\nexport const dismiss = DismissOrder;\nexport const why = describe( Orders, DismissOrder );\n' ],
        [ 'renamed the merged import to DismissOrderReason in place', AFTER_ORDERS, ', DismissOrder', 'import { Orders, DismissOrderReason } from \'./orders.aggregate\';\nexport const dismiss = DismissOrder;\n' ],
        [ 'renamed the merged import to ReDismissOrder in place (and dropped the brace\'s space)', 'import { '.length, 'DismissOrder, ', 'import{ReDismissOrder, Orders } from \'./orders.aggregate\';\nexport const dismiss = DismissOrder;\n' ],
      ] )( 'Given a placement merged into an import and a developer who %s, when the job runs, then no hand-written code is cut: the placement is kept and reported edited', async ( _how, offset, text, handWritten ) => {
        const fx = makeFixture();
        devCommit( fx, { [ AGGREGATE ]: IMPORTS }, 'feat: the orders import' );
        writePlan( fx, spansPlan( 'DismissOrder', [ { offset, text }, { offset: IMPORTS.length + text.length, text: 'export const dismiss = DismissOrder;\n' } ] ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        devCommit( fx, { [ AGGREGATE ]: handWritten }, 'feat: the developer edits the import' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        writePlan( fx, { fragments: PRESENT } );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { status: outcome.status, aggregate: showAt( fx, tip, AGGREGATE ), written: outcome.result?.written, reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { status: 'done', aggregate: handWritten, written: [], reportEdited: [ EDITED_ENTRY ] } );
      }, 120_000 );

      // A kept placement's offsets index the file of the press that placed it, not the commit that kept it: here
      // `, DismissOrder` still reads at its offset in that commit, as the head of the developer's `, DismissOrderReason`.
      it( 'Given a placement a press already kept as edited, when the job runs again with nothing changed since, then it is still kept and reported edited', async () => {
        const fx = makeFixture();
        devCommit( fx, { [ AGGREGATE ]: IMPORTS }, 'feat: the orders import' );
        writePlan( fx, spansPlan( 'DismissOrder', [ { offset: AFTER_ORDERS, text: ', DismissOrder' } ] ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const renamedInPlace = 'import { Orders, DismissOrderReason } from \'./orders.aggregate\';\n';
        devCommit( fx, { [ AGGREGATE ]: renamedInPlace }, 'feat: the developer renames the import' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        writePlan( fx, { fragments: PRESENT } );
        expect( ( await scaffoldAt( fx, sha1 ) ).result?.edited ).toEqual( [ AGGREGATE ] );
        const sha2 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":5}\n' }, `design(${ KEY }): docs a third time` );

        const outcome = await scaffoldAt( fx, sha2 );

        const tip = originTip( fx );
        expect( { committed: outcome.result?.committed, edited: outcome.result?.edited, parent: sh( fx.origin, `git rev-parse ${ tip }^` ), changes: changesOf( fx, tip ), aggregate: readFileSync( join( fx.worktree, AGGREGATE ), 'utf-8' ) } )
          .toEqual( { committed: true, edited: [ AGGREGATE ], parent: sha2, changes: [ `M\t${ REPORT }` ], aggregate: renamedInPlace } );
      }, 120_000 );

      // The scaffold commit is the last one to change scaffold.json, and only when its parent is the report's baseSha.
      it( 'Given the developer rewrote scaffold.json after the scaffold commit, when the job runs, then the placement it lists is kept and reported edited, as its offsets cannot be resolved', async () => {
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        devCommit( fx, { [ REPORT ]: `${ JSON.stringify( reportAt( fx, originTip( fx ) ) ) }\n` }, 'chore: compact the report' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { edited: [ AGGREGATE ], aggregate: `${ AGGREGATE_CODE }${ DISMISS }`, reportEdited: [ EDITED_ENTRY ] } );
      }, 120_000 );

      // Blueprint ADR-128 Consequences: a re-press leaves the code as it was only when no hand-written code follows the
      // placement in its container. The fake places at the file's end, as an anchor with no after/before neighbour does.
      it( 'Given an untouched top-level placement and hand-written code the developer added after it that names it, when the job runs, then the placement moves below that code, the typecheck drop removes it and the commit holds the code without it', async () => {
        const fx = makeFixture( { typecheck: true } );
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const HANDLERS = 'export const handlers = [ DismissOrder ];\n';
        devCommit( fx, { [ AGGREGATE ]: `${ AGGREGATE_CODE }${ DISMISS }${ HANDLERS }` }, 'feat: register the handlers' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        const usedBefore = `${ AGGREGATE }(5,27): error TS2448: Block-scoped variable 'DismissOrder' used before its declaration.`;
        writePlan( fx, { ...commandPlan( DISMISS, 'DismissOrder' ), typecheck: [ { line: usedBefore, when: { file: AGGREGATE, includes: `${ HANDLERS }${ DISMISS }` } } ] } );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        const report = reportAt( fx, tip );
        expect( { committed: outcome.result?.committed, aggregate: showAt( fx, tip, AGGREGATE ), typecheck: report?.typecheck, placed: report?.placed } ).toEqual( {
          committed: true, aggregate: `${ AGGREGATE_CODE }${ HANDLERS }`, placed: [],
          typecheck: { command: typecheckCommand( fx.root ), status: 'dropped', newErrors: [ `${ AGGREGATE }: error TS2448: Block-scoped variable 'DismissOrder' used before its declaration.` ] },
        } );
      }, 120_000 );

      it( 'Given two earlier placements recording the same span (one insertion), when the job runs, then the span is removed once and the second placement is reported edited', async () => {
        const fx = makeFixture();
        const span = { status: 'placed', inserted: [ { offset: AGGREGATE_CODE.length, text: DISMISS } ] };
        const plan: Plan = {
          fragments: [ 'c1', 'c2' ].map( ( node ) => fragment( node, 'command', AGGREGATE, { at: { kind: 'top-level' }, declares: 'DismissOrder', placement: span } ) ),
          edits: [ { file: AGGREGATE, code: DISMISS, node: 'c1' } ],
        };
        writePlan( fx, plan );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );

        const outcome = await scaffoldAt( fx, sha1 );

        // c1's removal took the text; c2's span overlaps it, so c2 is edited, and the scaffolder placed DismissOrder once.
        const tip = originTip( fx );
        expect( { edited: reportAt( fx, tip )?.edited, aggregate: showAt( fx, tip, AGGREGATE ), committed: outcome.result?.committed } )
          .toEqual( { edited: [ { file: AGGREGATE, node: 'c2', key: `c2|${ AGGREGATE }|top-level|DismissOrder` } ], aggregate: `${ AGGREGATE_CODE }${ DISMISS }`, committed: true } );
      }, 120_000 );

      // Git's diff pairs the unchanged lines, so the copy it reads as added is the developer's.
      it( 'Given an untouched placement whose text the developer also copied above the code it follows, when the job runs, then the scaffolder\'s original is removed and the developer\'s copy is kept', async () => {
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        devCommit( fx, { [ AGGREGATE ]: `// a copy\n${ DISMISS }${ AGGREGATE_CODE }${ DISMISS }` }, 'refactor: copy' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        writePlan( fx, { fragments: PRESENT } );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { edited: [], aggregate: `// a copy\n${ DISMISS }${ AGGREGATE_CODE }`, reportEdited: [] } );
      }, 120_000 );

      // A hand-written line git counts as inserted strictly inside a multi-line placement. The placement
      // is a blank line and a declaration, placed above the developer's `tail`; the developer then wrote a comment and
      // pasted the declaration again, right below the placement. Git's diff aligns that as the declaration and the comment
      // inserted between the placement's blank line and its declaration (`@@ -4,0 +5,2 @@`, inside the span's lines 4-5)
      // while the span's text still reads verbatim at its offset. A cut there takes the scaffolder's text and reshuffles
      // what the developer typed; a span a hunk lands inside is edited, whatever the hunk adds or removes.
      it( 'Given a multi-line placement and a hand-written line git counts as inserted strictly inside it, when the job runs, then nothing is cut: the file is untouched and the placement is reported edited', async () => {
        const fx = makeFixture();
        const TAIL = 'export const tail = 3;\n';
        devCommit( fx, { [ AGGREGATE ]: `${ AGGREGATE_CODE }${ TAIL }` }, 'feat: the tail' );
        writePlan( fx, spansPlan( 'DismissOrder', [ { offset: AGGREGATE_CODE.length, text: `\n${ DECLARED }` } ] ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const pasted = `${ AGGREGATE_CODE }\n${ DECLARED }// hand-written\n${ DECLARED }${ TAIL }`;
        devCommit( fx, { [ AGGREGATE ]: pasted }, 'feat: note and paste DismissOrder again' );
        // The shape the oracle rests on: git reports the developer's lines as one pure insertion strictly inside the span.
        expect( sh( fx.dev, `git diff --unified=0 --no-color HEAD~1 HEAD -- ${ AGGREGATE }` ) ).toContain( '@@ -4,0 +5,2 @@' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        writePlan( fx, { fragments: PRESENT } );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { edited: [ AGGREGATE ], aggregate: pasted, reportEdited: [ EDITED_ENTRY ] } );
      }, 120_000 );

      // A byte the developer wrote that is not UTF-8 (a latin-1 é in a comment) must survive a press
      // untouched, wherever it is in a placed file: Steward leaves such a file alone, placements and all, rather than
      // read and write it as UTF-8 and turn the byte into U+FFFD.
      it( 'Given a non-UTF-8 byte the developer wrote above an untouched placement, when the design drops the command, then the file is left alone byte for byte and the placement is reported edited', async () => {
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const latin1 = Buffer.concat( [ Buffer.from( '// caf' ), Buffer.from( [ 0xe9 ] ), Buffer.from( `\n${ AGGREGATE_CODE }${ DISMISS }` ) ] );
        devCommit( fx, { [ AGGREGATE ]: latin1 }, 'docs: a latin-1 header' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop the command` );
        writePlan( fx, {} );

        const outcome = await scaffoldAt( fx, sha1 );

        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, bytes: bytesAt( fx, tip, AGGREGATE )?.toString( 'hex' ), reportEdited: reportAt( fx, tip )?.edited, placed: reportAt( fx, tip )?.placed?.length } )
          .toEqual( { edited: [ AGGREGATE ], bytes: latin1.toString( 'hex' ), reportEdited: [ EDITED_ENTRY ], placed: 1 } );
      }, 120_000 );

      // A placed[] entry's offsets index the file its press committed: a scaffold commit amended afterwards holds another
      // file, where the same offsets can fall on hand-written text (here the head of `, DismissOrderReason`).
      it( 'Given the developer amended the scaffold commit, adding a line above a placement as long as the hand-written import there, and moved the branch to it, when the design drops the command, then no hand-written code is cut: the placement is kept and reported edited', async () => {
        // GIVEN
        const fx = makeFixture();
        const REASONS = 'import { Orders, DismissOrderReason } from \'./reasons\';\n';
        devCommit( fx, { [ AGGREGATE ]: `${ REASONS }${ IMPORTS }` }, 'feat: the imports' );
        writePlan( fx, spansPlan( 'DismissOrder', [ { offset: REASONS.length + AFTER_ORDERS, text: ', DismissOrder' } ] ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const header = `// ${ '-'.repeat( REASONS.length - 4 ) }\n`;
        const amended = `${ header }${ REASONS }import { Orders, DismissOrder } from './orders.aggregate';\n`;
        sh( fx.dev, `git fetch -q origin && git checkout -q --detach origin/${ BRANCH }` );
        writeFileSync( join( fx.dev, AGGREGATE ), amended );
        sh( fx.dev, `git add -A && git ${ IDENTITY } commit -q --amend --no-edit && git push -q origin HEAD:refs/heads/amended` );
        sh( fx.origin, `git update-ref refs/heads/${ BRANCH } refs/heads/amended` );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop the command` );
        writePlan( fx, {} );

        // WHEN
        const outcome = await scaffoldAt( fx, sha1 );

        // THEN
        const tip = originTip( fx );
        expect( { header: header.length, edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { header: REASONS.length, edited: [ AGGREGATE ], aggregate: amended, reportEdited: [ EDITED_ENTRY ] } );
      }, 120_000 );

      // The placer's offsets index the working file, as the checkout wrote it; git stores it with LF line ends.
      it( 'Given a repository that checks .ts files out with CRLF line ends and an untouched placement, when the design renames the command, then the old declaration is removed and only the renamed one is placed', async () => {
        // GIVEN
        const fx = makeFixture();
        devCommit( fx, { '.gitattributes': '*.ts text eol=crlf\n' }, 'chore: CRLF checkouts' );
        const crlf = ( text: string ) => text.replace( /\n/g, '\r\n' );
        const at = crlf( AGGREGATE_CODE ).length;
        writePlan( fx, spansPlan( 'DismissOrder', [ { offset: at, text: crlf( DISMISS ) } ] ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Cancelled' ) }, `design(${ KEY }): rename` );
        writePlan( fx, spansPlan( 'CancelOrder', [ { offset: at, text: crlf( RENAMED ) } ] ) );

        // WHEN
        const outcome = await scaffoldAt( fx, sha1 );

        // THEN
        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), worktree: readFileSync( join( fx.worktree, AGGREGATE ), 'utf-8' ) } )
          .toEqual( { edited: [], aggregate: `${ AGGREGATE_CODE }${ RENAMED }`, worktree: crlf( `${ AGGREGATE_CODE }${ RENAMED }` ) } );
      }, 120_000 );

      // With -diff, git diff prints "Binary files differ" and no hunk unless told the file is text.
      it( 'Given a repository that marks .ts files -diff and hand-written lines added above an untouched placement, when the design renames the command, then the old declaration is removed and only the renamed one is placed', async () => {
        // GIVEN
        const fx = makeFixture();
        devCommit( fx, { '.gitattributes': '*.ts -diff\n' }, 'chore: no diffs of .ts' );
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        devCommit( fx, { [ AGGREGATE ]: `// orders\n${ AGGREGATE_CODE }${ DISMISS }` }, 'docs: a header' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Cancelled' ) }, `design(${ KEY }): rename` );
        writePlan( fx, commandPlan( RENAMED, 'CancelOrder' ) );

        // WHEN
        const outcome = await scaffoldAt( fx, sha1 );

        // THEN
        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ) } ).toEqual( { edited: [], aggregate: `// orders\n${ AGGREGATE_CODE }${ RENAMED }` } );
      }, 120_000 );

      // The prior scaffold commit does not hold the file: the press that made it ran while the developer had deleted it.
      it( 'Given the developer deleted the file holding an untouched placement, a press then committed without it, and the developer wrote the file again with the same text, when the design drops the command, then the text is kept as the developer\'s and reported edited', async () => {
        // GIVEN
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        sh( fx.dev, `git fetch -q origin && git checkout -q --detach origin/${ BRANCH } && git rm -q ${ AGGREGATE } && git ${ IDENTITY } commit -qm "refactor: drop the aggregate" && git push -q origin HEAD:refs/heads/${ BRANCH }` );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        writePlan( fx, FIRST_PLAN );
        expect( ( await scaffoldAt( fx, sha1 ) ).result?.committed ).toBe( true );
        const again = `${ AGGREGATE_CODE }${ DISMISS }`;
        devCommit( fx, { [ AGGREGATE ]: again }, 'feat: the aggregate again' );
        const sha2 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop the command` );

        // WHEN
        const outcome = await scaffoldAt( fx, sha2 );

        // THEN
        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), reportEdited: reportAt( fx, tip )?.edited } )
          .toEqual( { edited: [ AGGREGATE ], aggregate: again, reportEdited: [ EDITED_ENTRY ] } );
      }, 120_000 );

      // A press that kept an edited placement and placed its node again lists the key in edited[] and the new spans in
      // placed[]: those spans are the scaffolder's own, in the file that press committed.
      it( 'Given a press kept an edited placement and placed the command again, when the design renames the command, then the placement it made is removed, the edited one stays and the renamed one is placed', async () => {
        // GIVEN
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const LEGACY = 'export const LegacyDismiss = 2;\n';
        devCommit( fx, { [ AGGREGATE ]: `${ AGGREGATE_CODE }${ LEGACY }` }, 'refactor: rename it LegacyDismiss' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        const end = `${ AGGREGATE_CODE }${ LEGACY }`.length;
        writePlan( fx, spansPlan( 'DismissOrder', [ { offset: end, text: DISMISS } ] ) );
        expect( ( await scaffoldAt( fx, sha1 ) ).result?.edited ).toEqual( [ AGGREGATE ] );
        const sha2 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Cancelled' ) }, `design(${ KEY }): rename` );
        writePlan( fx, spansPlan( 'CancelOrder', [ { offset: end, text: RENAMED } ] ) );

        // WHEN
        const outcome = await scaffoldAt( fx, sha2 );

        // THEN
        const tip = originTip( fx );
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ) } )
          .toEqual( { edited: [], aggregate: `${ AGGREGATE_CODE }${ LEGACY }${ RENAMED }` } );
      }, 120_000 );

      // The placer's offsets index the barrel before Steward took the stale stub's line out of it, so the file the
      // commit holds is not the one they index, and 37 characters past the placed `, Foo` stands the developer's own.
      it( 'Given a press that placed into a barrel and took a stale stub\'s line out of it above the placement, when a later press drops the command, then the developer\'s own `, Foo` is not cut and the placement is reported edited', async () => {
        // GIVEN
        const fx = makeFixture();
        writePlan( fx, { files: [ FIRST_PLAN.files![ 0 ] ], appends: FIRST_PLAN.appends } );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        const IMPORT = 'import { Orders } from \'./orders\';\n';
        const HAND_WRITTEN = 'export { Bar, Foo };\n';
        devCommit( fx, { [ BARREL ]: `export {};\n${ PLACED_LINE }\n${ IMPORT }${ HAND_WRITTEN }` }, 'feat: the barrel re-exports Foo' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Submitted' ) }, `design(${ KEY }): rename, add Foo` );
        const span = { offset: `export {};\n${ PLACED_LINE }\nimport { Orders`.length, text: ', Foo' };
        const submitted: Plan = { files: [ { file: SUBMITTED, node: 'e1', content: EVENT_STUB( 'OrderSubmitted' ) } ], appends: [ { file: BARREL, node: 'e1', code: SUBMITTED_LINE } ] };
        writePlan( fx, {
          ...submitted,
          fragments: [ fragment( 'c1', 'command', BARREL, { at: { kind: 'top-level' }, declares: 'Foo', placement: { status: 'placed', inserted: [ span ] } } ) ],
          edits: [ { file: BARREL, node: 'c1', offset: span.offset, code: span.text } ],
        } );
        const pressed = await scaffoldAt( fx, sha1 );
        const barrel = `export {};\nimport { Orders, Foo } from './orders';\n${ HAND_WRITTEN }${ SUBMITTED_LINE }\n`;
        // The fixture's premise: the commit holds the barrel without the stale line, where the offset reads the
        // developer's `, Foo`.
        expect( { committed: pressed.result?.committed, barrel: showAt( fx, originTip( fx ), BARREL ), atOffset: barrel.slice( span.offset, span.offset + span.text.length ) } )
          .toEqual( { committed: true, barrel, atOffset: ', Foo' } );
        const sha2 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Submitted, no Foo' ) }, `design(${ KEY }): drop Foo` );
        writePlan( fx, submitted );

        // WHEN
        const outcome = await scaffoldAt( fx, sha2 );

        // THEN
        expect( { edited: outcome.result?.edited, barrel: readFileSync( join( fx.worktree, BARREL ), 'utf-8' ) } ).toEqual( { edited: [ BARREL ], barrel } );
      }, 120_000 );

      // A kept placement's spans index the file of the press that placed it; the developer writing that file again,
      // word for word, does not make them the scaffolder's.
      it( 'Given a press kept an edited placement and the developer then wrote the scaffolder\'s text back by hand, which a later press committed, when the design drops the command, then the developer\'s text is not cut', async () => {
        // GIVEN
        const fx = makeFixture();
        writePlan( fx, commandPlan( DISMISS, 'DismissOrder' ) );
        expect( ( await scaffoldAt( fx, originTip( fx ) ) ).result?.committed ).toBe( true );
        devCommit( fx, { [ AGGREGATE ]: `${ AGGREGATE_CODE }export const DismissOrder = 3;\n` }, 'feat: implement DismissOrder' );
        const sha1 = devCommit( fx, { [ `${ BUNDLE }/ops.jsonl` ]: 'ops.jsonl\n{"seq":4}\n' }, `design(${ KEY }): docs again` );
        writePlan( fx, { fragments: PRESENT } );
        expect( ( await scaffoldAt( fx, sha1 ) ).result?.edited ).toEqual( [ AGGREGATE ] );
        const again = `${ AGGREGATE_CODE }${ DISMISS }`;
        devCommit( fx, { [ AGGREGATE ]: again }, 'fix: DismissOrder is 2 after all' );
        const sha2 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed, again' ) }, `design(${ KEY }): reword` );
        const kept = await scaffoldAt( fx, sha2 );
        // The fixture's premise: that press committed the developer's file, the first press's file word for word.
        expect( { committed: kept.result?.committed, edited: kept.result?.edited, aggregate: showAt( fx, originTip( fx ), AGGREGATE ) } )
          .toEqual( { committed: true, edited: [ AGGREGATE ], aggregate: again } );
        const sha3 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop the command` );
        writePlan( fx, {} );

        // WHEN
        const outcome = await scaffoldAt( fx, sha3 );

        // THEN
        expect( { edited: outcome.result?.edited, aggregate: readFileSync( join( fx.worktree, AGGREGATE ), 'utf-8' ) } ).toEqual( { edited: [ AGGREGATE ], aggregate: again } );
      }, 120_000 );

      // A .gitattributes added after the press makes a checkout of the press's file CRLF, which its offsets do not
      // index: ten lines down, the CR each adds moves the offset back onto the developer's own `, Foo`.
      it( 'Given a press placed `, Foo` after a hand-written `, Foo` and a .gitattributes eol=crlf came in after it, when the design drops the command, then the developer\'s `, Foo` is not cut and the placement is reported edited', async () => {
        // GIVEN
        const fx = makeFixture();
        const HEAD10 = '//\n'.repeat( 10 );
        devCommit( fx, { [ AGGREGATE ]: `${ HEAD10 }f(x, Foo, yyy);\n` }, 'feat: hand-written f(x, Foo, yyy)' );
        const span = { offset: `${ HEAD10 }f(x, Foo, yyy`.length, text: ', Foo' };
        writePlan( fx, spansPlan( 'Foo', [ span ] ) );
        const first = await scaffoldAt( fx, originTip( fx ) );
        const placedText = `${ HEAD10 }f(x, Foo, yyy, Foo);\n`;
        // The fixture's premise: the press committed the placement and bound it to the file it committed.
        expect( { committed: first.result?.committed, aggregate: showAt( fx, originTip( fx ), AGGREGATE ), blob: ( reportAt( fx, originTip( fx ) )?.placed as { blob?: string }[] )?.[ 0 ]?.blob !== undefined } )
          .toEqual( { committed: true, aggregate: placedText, blob: true } );
        devCommit( fx, { '.gitattributes': '*.ts text eol=crlf\n' }, 'chore: CRLF checkouts' );
        const sha2 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop Foo` );
        writePlan( fx, {} );

        // WHEN
        const outcome = await scaffoldAt( fx, sha2 );

        // THEN
        const tip = originTip( fx );
        // Line ends aside (the worktree checks the file out CRLF now), both `, Foo`s stand, in the worktree and at the tip.
        expect( { edited: outcome.result?.edited, aggregate: showAt( fx, tip, AGGREGATE ), worktree: readFileSync( join( fx.worktree, AGGREGATE ), 'utf-8' ).replaceAll( '\r\n', '\n' ) } )
          .toEqual( { edited: [ AGGREGATE ], aggregate: placedText, worktree: placedText } );
      }, 120_000 );

      // A filter whose checkout writes a line the repository does not hold (a header) leaves git's diff of the file
      // one line off the text the offsets index; diffed as the two texts stand, the developer's edit lands on the span.
      it( 'Given a smudge filter that writes a header above the file and a developer who edited the line of an untouched placement, when the design drops the command, then the edited line is kept whole and the placement is reported edited', async () => {
        // GIVEN
        const fx = makeFixture();
        const HEADER = '// generated\n';
        writeFileSync( join( fx.root, 'tools', 'smudge.sh' ), `printf '${ HEADER.replace( '\n', '\\n' ) }'; cat\n` );
        sh( fx.repo, `git config filter.header.smudge "sh ${ join( fx.root, 'tools', 'smudge.sh' ) }" && git config filter.header.clean "sed 1d"` );
        devCommit( fx, { '.gitattributes': `${ AGGREGATE } filter=header\n`, [ AGGREGATE ]: 'a();\nf(x, yyy);\n' }, 'feat: hand-written f(x, yyy)' );
        const span = { offset: `${ HEADER }a();\nf(x, yyy`.length, text: ', Foo' };
        writePlan( fx, spansPlan( 'Foo', [ span ] ) );
        const first = await scaffoldAt( fx, originTip( fx ) );
        // The fixture's premise: the commit holds the file without the header, and the placement is bound to it.
        expect( { committed: first.result?.committed, aggregate: showAt( fx, originTip( fx ), AGGREGATE ), placed: ( reportAt( fx, originTip( fx ) )?.placed as { digest?: string }[] )?.[ 0 ]?.digest } )
          .toEqual( { committed: true, aggregate: 'a();\nf(x, yyy, Foo);\n', placed: boundTo( `${ HEADER }a();\nf(x, yyy, Foo);\n` ).digest } );
        devCommit( fx, { [ AGGREGATE ]: 'a();\nf(x, yyy, Foo, z);\n' }, 'feat: f takes z' );
        const sha2 = devCommit( fx, { [ `${ BUNDLE }/design.json` ]: designJson( 'Order Placed only' ) }, `design(${ KEY }): drop Foo` );
        writePlan( fx, {} );

        // WHEN
        const outcome = await scaffoldAt( fx, sha2 );

        // THEN
        expect( { edited: outcome.result?.edited, worktree: readFileSync( join( fx.worktree, AGGREGATE ), 'utf-8' ) } )
          .toEqual( { edited: [ AGGREGATE ], worktree: `${ HEADER }a();\nf(x, yyy, Foo, z);\n` } );
      }, 120_000 );
    } );
  } );
} );
