import { describe, expect, it } from 'vitest';
import {
  agentBranchOf, AGENT_STEPS, BRANCHES_ROUTE, DOCS_ROOT_DEFAULT, itemDocsPathOf, legacyRouteOf, METHOD_MIN_RUNNER_VERSION,
  normalizeRemoteUrl, PULL_REQUEST_FILE, RUNNER_CLAIM_ROUTE, RUNNER_JOB_KINDS, RUNNER_JOB_STEPS, RUNNER_JOBS_ROUTE,
  RUNNER_SIGNALS_ROUTE, runnerJobRoute, runnerMeets, SCAFFOLD_EXIT_BLOCKED, SCAFFOLD_EXIT_OK, SCAFFOLD_STATUSES,
  SCAFFOLD_TRAILER, SERVER_AGENT_STEPS, SIGNAL_DONE, SIGNAL_FAILED, SIGNAL_NEEDS_HUMAN, SIGNAL_REJECTED,
  SIGNAL_TRAILER_KEY_PATTERN, SIGNAL_VALUES, SIGNAL_WORKING, SPECIFICATION_VERSION, STEWARD_CLAIM_ROUTE,
  STEWARD_JOBS_ROUTE, STEWARD_SIGNALS_ROUTE, stewardJobRoute,
} from '../src/index.js';

describe( '@bett3r-dev/blueprint-spec', () => {
  it( 'the steps Steward heartbeats are the agent steps less the server\'s, in order', () => {
    expect( [ ...RUNNER_JOB_STEPS ] ).toEqual( AGENT_STEPS.filter( ( step ) => !( SERVER_AGENT_STEPS as readonly string[] ).includes( step ) ) );
    expect( [ ...RUNNER_JOB_STEPS ] ).toEqual( [ 'branch', 'worktree', 'extract', 'push', 'agent' ] );
  } );

  it( 'lists each job kind once', () => {
    expect( new Set( RUNNER_JOB_KINDS ).size ).toBe( RUNNER_JOB_KINDS.length );
  } );

  it( 'compares x.y.z versions, and an absent or malformed one meets nothing', () => {
    expect( [ '1.2.0', '1.10.0', '2.0.0' ].map( ( v ) => runnerMeets( v, METHOD_MIN_RUNNER_VERSION ) ) ).toEqual( [ true, true, true ] );
    expect( [ '1.1.9', '0.9.0', undefined, '1.2', 'v1.2.0' ].map( ( v ) => runnerMeets( v, '1.2.0' ) ) ).toEqual( [ false, false, false, false, false ] );
  } );

  it( 'names a job\'s routes with its id encoded', () => {
    expect( runnerJobRoute( 'a/b' ) ).toBe( '/api/blueprint/runner/jobs/a%2Fb' );
    expect( runnerJobRoute( 'j1', 'heartbeat' ) ).toBe( '/api/blueprint/runner/jobs/j1/heartbeat' );
  } );

  it( 'keys every transport spelling of one repository alike', () => {
    expect( new Set( [ 'git@github.com:Acme/Shop.git', 'https://github.com/acme/shop', 'ssh://git@github.com:22/acme/shop.git' ].map( normalizeRemoteUrl ) ) )
      .toEqual( new Set( [ 'github.com/acme/shop' ] ) );
  } );

  it( 'serves the job, claim and signal routes under steward, each with its legacy runner spelling', () => {
    expect( [ STEWARD_JOBS_ROUTE, STEWARD_CLAIM_ROUTE, STEWARD_SIGNALS_ROUTE ].map( legacyRouteOf ) )
      .toEqual( [ RUNNER_JOBS_ROUTE, RUNNER_CLAIM_ROUTE, RUNNER_SIGNALS_ROUTE ] );
    expect( stewardJobRoute( 'a/b', 'heartbeat' ) ).toBe( '/api/blueprint/steward/jobs/a%2Fb/heartbeat' );
    expect( legacyRouteOf( stewardJobRoute( 'j1', 'bundle' ) ) ).toBe( runnerJobRoute( 'j1', 'bundle' ) );
    expect( legacyRouteOf( '/api/blueprint/steward?x=1' ) ).toBe( '/api/blueprint/runner?x=1' );
    expect( [ '/api/blueprint/stewardship', BRANCHES_ROUTE, RUNNER_JOBS_ROUTE ].map( legacyRouteOf ) ).toEqual( [ undefined, undefined, undefined ] );
  } );

  it( 'names the five signal values, the scaffold statuses and the item\'s files', () => {
    expect( [ ...SIGNAL_VALUES ] ).toEqual( [ SIGNAL_WORKING, SIGNAL_DONE, SIGNAL_NEEDS_HUMAN, SIGNAL_REJECTED, SIGNAL_FAILED ] );
    expect( [ ...SIGNAL_VALUES ] ).toEqual( [ 'working', 'done', 'needs-human', 'rejected', 'failed' ] );
    expect( [ ...SCAFFOLD_STATUSES ] ).toEqual( [ 'done', 'blocked', 'skipped' ] );
    expect( [ SPECIFICATION_VERSION, SCAFFOLD_TRAILER, DOCS_ROOT_DEFAULT ] ).toEqual( [ 1, 'Blueprint-Scaffold', 'docs/prs' ] );
    expect( itemDocsPathOf( DOCS_ROOT_DEFAULT, 'PROJ-1', PULL_REQUEST_FILE ) ).toBe( 'docs/prs/PROJ-1/pull-request.md' );
    expect( itemDocsPathOf( 'docs', 'PROJ-1' ) ).toBe( 'docs/PROJ-1' );
  } );

  it( 'agrees on the agent branch, the trailer key form and the scaffold exit codes', () => {
    expect( agentBranchOf( 'PROJ-1-thing' ) ).toBe( 'claude/PROJ-1-thing' );
    expect( [ 'Blueprint-Status', 'X', '-bad', 'a,b' ].map( ( key ) => SIGNAL_TRAILER_KEY_PATTERN.test( key ) ) ).toEqual( [ true, true, false, false ] );
    expect( [ SCAFFOLD_EXIT_OK, SCAFFOLD_EXIT_BLOCKED ] ).toEqual( [ 0, 3 ] );
  } );
} );
