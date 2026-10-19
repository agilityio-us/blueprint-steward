import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runChild } from '../lib/child.mjs';
import { runScaffoldJob, SCAFFOLD_REPORT } from '../lib/scaffold.mjs';

/**
 * BP-276 epic goal oracle — "Procedural PV3 scaffold: a compiling code skeleton from the design, not test titles".
 * Owned by no child ticket (BP-268, BP-267, BP-269, BP-270); /merge-multi reports it. Written RED at blueprint
 * origin/master 742c07b9, where every `it` below failed, each naming the seam it waits on. Ported here from blueprint
 * branch BP-276-goal-oracle (a693563d) when ADR-138 moved the runner, and with it runScaffoldJob, into Steward.
 *
 * Owner-agreed statement: a change to existing code, shaped like TV2-10, scaffolds in the hosted step to a skeleton
 * that compiles: fragments placed, edge code emitted, test bodies generated, designed fields present.
 *
 * The story is the TV2-10 replay, through the real hosted scaffold step (lib/scaffold.mjs runScaffoldJob, the function
 * Steward's `scaffold` job calls) with the repository's own declared tooling (.blueprint.config.json designTooling:
 * extract `yarn blueprint`, scaffold `pv3 g scaffold`, typecheck `yarn typecheck`). No network, no fakes:
 *
 *   Given origin = a local bare clone of a blueprint checkout (TV2-10 is a blueprint ticket), whose branch TV2-10 is at commit 1 = c8a081a6 (TV2-10's real
 *   documentation commit: design.json, map.json under docs/prs/TV2-10/blueprint) plus one fixture commit that gives
 *   the Dismiss Notification command a designed data shape { notificationId: string, actorId: string } (TV2-10's
 *   design carries none: the design graph had no field vocabulary, BP-270), and the session worktree is a clone of it
 *   carrying a copy-on-write clone of that checkout's node_modules (as a Steward worktree carries its install);
 *   when the hosted scaffold job runs on commit 1 (it re-extracts the graph, since c8a081a6 never committed one);
 *   then (BP-268) the topology fragments are placed into the existing files and none is owed `not-placed`;
 *   then (BP-267) the new projected-to edge NotificationDismissed -> Notifications on the existing read model emits
 *         code into notifications.readmodel.ts, not only a test;
 *   then (BP-269) the generated test cases carry bodies, not bare it.todo titles;
 *   then (BP-270) the emitted DismissNotificationCommandSchema carries the designed fields, not S.shape({});
 *   then (BP-268-F2) the hosted step ran the declared typecheck green, and `yarn typecheck` passes on the commit.
 *
 * At BASE the replay reproduces TV2-10's scaffold commit e05fc917: two created files, both it.todo; six fragments,
 * placed: [], every topology fragment owed not-placed, typecheck: null.
 *
 * Needs: `pv3` on PATH, the published @bett3r-dev/pv3-cli the Steward image installs (the declared scaffold command
 * resolves it there); a blueprint checkout, installed (its node_modules is what gets cloned), at $BLUEPRINT_REPO or
 * else ../blueprint beside this repository; APFS (cp -c) or a reflink filesystem for a cheap clone.
 *
 * Run alone: npx vitest run --config vitest.oracle.config.ts
 */

// ---------------------------------------------------------------------------------------------------------------
// NAMES: every seam this oracle hard-codes. Rename here, nowhere else.
// ---------------------------------------------------------------------------------------------------------------
const NAMES = {
  /** TV2-10's documentation commit (session a015e087 through seq 35); its scaffold commit was e05fc917. */
  docsCommit: 'c8a081a6d5f053912c51ce88345b6a75c3bc0824',
  key: 'TV2-10',
  branch: 'TV2-10',
  design: 'docs/prs/TV2-10/blueprint/design.json',
  report: `docs/prs/TV2-10/${ SCAFFOLD_REPORT }`,
  nodes: {
    command: 'notifications_cmd_dismiss-notification',
    event: 'notifications_evt_notification-dismissed',
    readModel: 'notifications_rm_notifications',
  },
  files: {
    readModel: 'src/services/server/src/modules/notifications/notifications.readmodel.ts',
    types: 'src/packages/shared/blueprint-domain/src/notifications/notifications.types.ts',
  },
  /** BP-268 D11: placed[] entries { node, file, key }; D6 placement.status placed | present | owed. */
  notPlaced: 'not-placed',
  /** BP-267 D3: an edge fragment carries edge { from, to, kind }. */
  edgeKind: 'projected-to',
  /** BP-270 D3: DataShape { fields: DataField[] }, DataField { name, type: { kind } }. */
  dataShape: { fields: [ { name: 'notificationId', type: { kind: 'string' } }, { name: 'actorId', type: { kind: 'string' } } ] },
  schemaConst: 'DismissNotificationCommandSchema',
  /** BP-268-F2: report.typecheck = { command, status: green | red-base | dropped | undeclared, newErrors[] }. */
  typecheckGreen: 'green',
} as const;

const STEWARD = execFileSync( 'git', [ 'rev-parse', '--show-toplevel' ], { cwd: __dirname, encoding: 'utf-8' } ).trim();
const SOURCE = resolve( process.env.BLUEPRINT_REPO ?? join( STEWARD, '..', 'blueprint' ) );
const EMPTY_CONFIG_DIR = mkdtempSync( join( tmpdir(), 'bp276-gitconfig-' ) );
const EMPTY_CONFIG = join( EMPTY_CONFIG_DIR, 'empty' );
writeFileSync( EMPTY_CONFIG, '' );
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Blueprint Runner', GIT_AUTHOR_EMAIL: 'runner@blueprint.local',
  GIT_COMMITTER_NAME: 'Blueprint Runner', GIT_COMMITTER_EMAIL: 'runner@blueprint.local',
};
const ENV = { ...process.env, ...GIT_ENV };
const sh = ( cwd: string, file: string, args: string[] ): string => execFileSync( file, args, { cwd, encoding: 'utf-8', env: ENV, maxBuffer: 64 * 1024 * 1024 } ).trim();
const shell = ( cwd: string, command: string ) => spawnSync( 'sh', [ '-c', command ], { cwd, encoding: 'utf-8', env: ENV, maxBuffer: 64 * 1024 * 1024 } );

type Fragment = { node?: string; file?: string; artifact?: string; code?: string; edge?: { from?: string; to?: string; kind?: string } };
type Report = {
  placed?: unknown[]; stillOwed?: { node?: string; reason?: string; detail?: string }[]; created?: { file: string; node?: string }[];
  typecheck?: { command?: string; status?: string; newErrors?: unknown[] } | null;
  scaffolder?: { fragments?: Fragment[] };
};

const world: {
  tmp?: string; work?: string; sha?: string; commitSha?: string; report?: Report; job?: { ok: boolean; result: string };
  setupError?: string;
} = {};

// The commit's copy of a file, or undefined where the commit has none.
const fileAt = ( commit: string, path: string ): string | undefined => {
  const shown = spawnSync( 'git', [ 'show', `${ commit }:${ path }` ], { cwd: world.work, encoding: 'utf-8', env: ENV, maxBuffer: 64 * 1024 * 1024 } );
  return shown.status === 0 ? shown.stdout : undefined;
};

// Every node_modules this checkout's install made: the root one and each workspace's own (top-most per workspace).
const nodeModulesOf = ( root: string ): string[] => sh( root, 'sh', [ '-c', 'find . -name .git -prune -o -name node_modules -type d -prune -print' ] )
  .split( '\n' ).filter( ( p ) => p !== '' ).map( ( p ) => p.replace( /^\.\//, '' ) );

// A copy-on-write clone (APFS clonefile, or a reflink), never a symlink: workspace links must re-anchor to the clone.
const cowClone = ( from: string, to: string ) => {
  mkdirSync( dirname( to ), { recursive: true } );
  const flags = process.platform === 'darwin' ? [ '-c', '-R' ] : [ '-R', '--reflink=auto' ];
  execFileSync( 'cp', [ ...flags, from, to ] );
};

const requireJob = () => {
  if ( world.setupError !== undefined ) throw new Error( `SETUP (not a seam): ${ world.setupError }` );
  return { work: world.work!, sha: world.sha!, commitSha: world.commitSha!, report: world.report! };
};

beforeAll( async () => {
  try {
    if ( shell( SOURCE, 'command -v pv3' ).status !== 0 ) throw new Error( 'pv3 is not on PATH: the declared scaffold/extract commands need it' );
    if ( !existsSync( join( SOURCE, 'node_modules' ) ) ) throw new Error( `${ SOURCE } has no node_modules to clone (set BLUEPRINT_REPO to an installed blueprint checkout)` );
    sh( SOURCE, 'git', [ 'cat-file', '-e', `${ NAMES.docsCommit }^{commit}` ] );

    const tmp = mkdtempSync( join( tmpdir(), 'bp276-oracle-' ) );
    world.tmp = tmp;
    const origin = join( tmp, 'origin.git' );
    const work = join( tmp, 'work' );
    sh( tmp, 'git', [ 'clone', '--quiet', '--bare', SOURCE, origin ] );
    sh( tmp, 'git', [ 'clone', '--quiet', '--no-checkout', origin, work ] );
    sh( work, 'git', [ 'checkout', '--quiet', '--detach', NAMES.docsCommit ] );

    // Commit 1: TV2-10's documentation commit, plus the designed data shape TV2-10's design could not carry.
    const designPath = join( work, NAMES.design );
    const design = JSON.parse( readFileSync( designPath, 'utf-8' ) );
    const command = design.propose.nodes.find( ( n: { label?: string } ) => n.label === 'Dismiss Notification' );
    if ( command === undefined ) throw new Error( 'TV2-10 design has no Dismiss Notification node' );
    command.dataShape = NAMES.dataShape;
    writeFileSync( designPath, `${ JSON.stringify( design, null, 2 ) }\n` );
    sh( work, 'git', [ 'commit', '--quiet', '-am', 'fixture(BP-276): Dismiss Notification carries a designed data shape' ] );
    const sha = sh( work, 'git', [ 'rev-parse', 'HEAD' ] );
    sh( work, 'git', [ 'push', '--quiet', 'origin', `${ sha }:refs/heads/${ NAMES.branch }` ] );
    world.work = work;
    world.sha = sha;

    // The runner worktree's install: a COW clone of this checkout's node_modules trees.
    for ( const rel of nodeModulesOf( SOURCE ) ) {
      if ( existsSync( join( work, dirname( rel ) ) ) || dirname( rel ) === '.' ) cowClone( join( SOURCE, rel ), join( work, rel ) );
    }

    const job = await runScaffoldJob( {
      dir: work, branch: NAMES.branch, payload: { sha, key: NAMES.key },
      git: ( cwd: string, argv: string[], options: { env?: Record<string, string>; input?: string } = {} ) =>
        runChild( 'git', argv, { cwd, input: options.input, extraEnv: { ...GIT_ENV, ...options.env } } ),
      extract: async ( cwd: string, extractCommand: string ) => {
        const ran = shell( cwd, extractCommand );
        if ( ran.status !== 0 ) throw new Error( `${ extractCommand } exited ${ ran.status }: ${ ( ran.stderr || ran.stdout ).slice( -2000 ) }` );
      },
    } ) as { ok: boolean; result: string };
    world.job = job;
    if ( !job.ok ) throw new Error( `the hosted scaffold job failed: ${ job.result }` );
    const result = JSON.parse( job.result ) as { committed?: boolean; commitSha?: string };
    if ( result.committed !== true || typeof result.commitSha !== 'string' ) throw new Error( `the hosted scaffold job committed nothing: ${ job.result }` );
    world.commitSha = result.commitSha;
    const reportText = fileAt( result.commitSha, NAMES.report );
    if ( reportText === undefined ) throw new Error( `the scaffold commit carries no ${ NAMES.report }` );
    world.report = JSON.parse( reportText ) as Report;
  } catch ( err ) {
    world.setupError = ( err as Error ).message;
  }
}, 600_000 );

afterAll( () => {
  if ( world.tmp !== undefined ) rmSync( world.tmp, { recursive: true, force: true } );
  rmSync( EMPTY_CONFIG_DIR, { recursive: true, force: true } );
} );

describe( 'BP-276 epic goal: a TV2-10-shaped change scaffolds in the hosted step to a compiling skeleton', () => {
  it( '1. BP-268: the topology fragments are placed into the existing files; none is owed not-placed', () => {
    const { report } = requireJob();
    const fragments = report.scaffolder?.fragments ?? [];
    const owedNotPlaced = ( report.stillOwed ?? [] ).filter( ( o ) => o.reason === NAMES.notPlaced );
    expect( report.placed ?? [], `BP-268 placer missing: the hosted step placed 0 of ${ fragments.length } fragments `
      + '(lib/scaffold.mjs hard-codes placed: [], scaffold core has no placeFragments under --write)' ).not.toHaveLength( 0 );
    expect( owedNotPlaced, `BP-268 placer missing: ${ owedNotPlaced.length } fragments still owed not-placed `
      + `(${ owedNotPlaced.map( ( o ) => `${ o.node } -> ${ o.detail }` ).join( ', ' ) })` ).toEqual( [] );
  } );

  it( '2. BP-267: the new projected-to edge on the existing read model emits code into it, not only a test', () => {
    const { sha, commitSha, report } = requireJob();
    const fragments = report.scaffolder?.fragments ?? [];
    const edgeFragments = fragments.filter( ( f ) => f.edge?.kind === NAMES.edgeKind && f.edge?.from === NAMES.nodes.event
      && f.edge?.to === NAMES.nodes.readModel );
    expect( edgeFragments.map( ( f ) => f.file ), 'BP-267 edge units missing: the scaffolder emitted no fragment for the proposed '
      + `edge ${ NAMES.nodes.event } -${ NAMES.edgeKind }-> ${ NAMES.nodes.readModel } (scaffold-core scaffold.ts drops edge units; `
      + `fragment files: ${ [ ...new Set( fragments.map( ( f ) => f.file ) ) ].join( ', ' ) })` ).toContain( NAMES.files.readModel );
    const before = fileAt( sha, NAMES.files.readModel );
    const after = fileAt( commitSha, NAMES.files.readModel );
    expect( after !== before && /NotificationDismissed/.test( after ?? '' ), `BP-267 edge code not in the commit: ${ NAMES.files.readModel } `
      + 'is unchanged by the scaffold commit (no projector or events-map entry for NotificationDismissed)' ).toBe( true );
  } );

  it( '3. BP-269: generated test cases carry bodies, not bare it.todo titles', () => {
    const { commitSha, report } = requireJob();
    const tests = ( report.created ?? [] ).map( ( c ) => c.file ).filter( ( f ) => /\.test\.ts$/.test( f ) );
    expect( tests, 'the scaffold commit created no test file at all' ).not.toHaveLength( 0 );
    const bare = tests.flatMap( ( file ) => ( fileAt( commitSha, file ) ?? '' ).split( '\n' )
      .filter( ( line ) => /\bit\.todo\(\s*(['"`]).*\1\s*\)/.test( line ) ).map( ( line ) => `${ file }: ${ line.trim() }` ) );
    expect( bare, `BP-269 test bodies missing: ${ bare.length } generated cases are bare it.todo titles `
      + '(pv3 emit/tests.ts renders every case bodiless)' ).toEqual( [] );
    const commandTest = tests.find( ( f ) => /dismissNotification\.test\.ts$/.test( f ) );
    const text = commandTest === undefined ? '' : fileAt( commitSha, commandTest ) ?? '';
    expect( /it\.skip\(/.test( text ) && /testCommandHandler\(/.test( text ) && /['"]DismissNotification['"]/.test( text ),
      `BP-269 test bodies missing: ${ commandTest ?? 'the command test' } does not dispatch DismissNotification through testCommandHandler in an it.skip body` ).toBe( true );
  } );

  it( '4. BP-270: the emitted command schema carries the designed fields, not S.shape({})', () => {
    const { commitSha, report } = requireJob();
    const declaration = new RegExp( `${ NAMES.schemaConst }\\s*=\\s*([^;]*);` );
    const inCode = fileAt( commitSha, NAMES.files.types )?.match( declaration )?.[ 1 ];
    const inFragment = ( report.scaffolder?.fragments ?? [] ).map( ( f ) => f.code?.match( declaration )?.[ 1 ] ).find( ( m ) => m !== undefined );
    const emitted = inCode ?? inFragment;
    expect( emitted, `no ${ NAMES.schemaConst } was emitted at all, in the commit or a fragment` ).toBeDefined();
    const missing = NAMES.dataShape.fields.map( ( f ) => f.name ).filter( ( name ) => !new RegExp( `\\b${ name }\\b` ).test( emitted ?? '' ) );
    expect( missing, `BP-270 data shape missing: ${ NAMES.schemaConst } = ${ emitted } lacks designed fields `
      + '(the design graph carries no dataShape; pv3 emit/placeholder.ts renders S.shape({}))' ).toEqual( [] );
    expect( emitted ?? '' ).not.toMatch( /S\.shape\(\s*\{\s*\}\s*\)/ );
  } );

  it( '5. the hosted step typechecks its skeleton green, and the declared typecheck passes on the commit', () => {
    const { work, sha, commitSha, report } = requireJob();
    expect( report.typecheck ?? null, 'BP-268-F2 gate missing: the hosted step ran no typecheck (scaffold.mjs writes typecheck: null; ESAS-326 F15)' )
      .toMatchObject( { command: 'yarn typecheck', status: NAMES.typecheckGreen } );
    const touched = sh( work, 'git', [ 'diff-tree', '--no-commit-id', '-r', '--name-only', sha, commitSha ] ).split( '\n' )
      .filter( ( p ) => p.startsWith( 'src/' ) && !/\.test\.ts$/.test( p ) );
    expect( touched, 'the scaffold commit holds no skeleton code outside tests: a green typecheck would be vacuous' ).not.toHaveLength( 0 );
    const tooling = JSON.parse( fileAt( sha, '.blueprint.config.json' ) ?? '{}' ).designTooling ?? {};
    sh( work, 'git', [ 'checkout', '--quiet', '--force', '--detach', commitSha ] );
    const ran = shell( work, tooling.typecheck );
    expect( ran.status, `${ tooling.typecheck } failed on the scaffold commit:\n${ ( ran.stdout + ran.stderr ).slice( -3000 ) }` ).toBe( 0 );
  }, 600_000 );
} );
