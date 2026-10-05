import { describe, expect, it } from 'vitest';
import {
  agentBranchOf, AGENT_STEPS, METHOD_MIN_RUNNER_VERSION, normalizeRemoteUrl, RUNNER_JOB_KINDS, RUNNER_JOB_STEPS,
  runnerJobRoute, runnerMeets, SCAFFOLD_EXIT_BLOCKED, SCAFFOLD_EXIT_OK, SERVER_AGENT_STEPS, SIGNAL_TRAILER_KEY_PATTERN,
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

  it( 'agrees on the agent branch, the trailer key form and the scaffold exit codes', () => {
    expect( agentBranchOf( 'PROJ-1-thing' ) ).toBe( 'claude/PROJ-1-thing' );
    expect( [ 'Blueprint-Status', 'X', '-bad', 'a,b' ].map( ( key ) => SIGNAL_TRAILER_KEY_PATTERN.test( key ) ) ).toEqual( [ true, true, false, false ] );
    expect( [ SCAFFOLD_EXIT_OK, SCAFFOLD_EXIT_BLOCKED ] ).toEqual( [ 0, 3 ] );
  } );
} );
