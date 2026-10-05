import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { childEnv } from '../lib/child.mjs';
import { stewardEnv, STEWARD_ENV_NAMES } from '../lib/env.mjs';

const BIN = resolve( __dirname, '../bin/blueprint-steward.mjs' );

describe( 'Steward environment names', () => {
  afterEach( () => { vi.restoreAllMocks(); } );

  it( 'reads BLUEPRINT_STEWARD_<NAME> over its old name, and the old name alone with one deprecation line', () => {
    const warn = vi.spyOn( console, 'error' ).mockImplementation( () => undefined );
    expect( stewardEnv( 'CLAUDE', { BLUEPRINT_STEWARD_CLAUDE: '/new', BLUEPRINT_RUNNER_CLAUDE: '/old' } ) ).toBe( '/new' );
    expect( warn ).not.toHaveBeenCalled();
    expect( stewardEnv( 'CLAUDE', { BLUEPRINT_RUNNER_CLAUDE: '/old' } ) ).toBe( '/old' );
    expect( stewardEnv( 'CLAUDE', { BLUEPRINT_RUNNER_CLAUDE: '/old' } ) ).toBe( '/old' );
    expect( warn.mock.calls.map( ( [ line ] ) => line ) ).toEqual( [
      'blueprint-steward: BLUEPRINT_RUNNER_CLAUDE is deprecated; set BLUEPRINT_STEWARD_CLAUDE instead',
    ] );
    expect( stewardEnv( 'GH', { BLUEPRINT_STEWARD_GH: '' } ) ).toBeUndefined();
  } );

  it( 'covers exactly the names that moved, and refuses any other', () => {
    expect( [ ...STEWARD_ENV_NAMES ] ).toEqual( [ 'TOKEN', 'CLAUDE', 'GH', 'REF', 'WORK', 'IMAGE' ] );
    expect( () => stewardEnv( 'JIRA_API_TOKEN', {} ) ).toThrow( /not one of Steward's variables/ );
  } );

  it( 'keeps the org key from every child under either name', () => {
    const env = childEnv( { BLUEPRINT_STEWARD_TOKEN: 'k1', BLUEPRINT_RUNNER_TOKEN: 'k2', PATH: '/bin' } );
    expect( env ).toEqual( { PATH: '/bin' } );
  } );

  it( 'the CLI takes the org key from BLUEPRINT_RUNNER_TOKEN, saying it is deprecated', () => {
    const run = ( env: Record<string, string> ) => spawnSync( process.execPath, [ BIN, 'enqueue', '--server', 'http://127.0.0.1:9', '--session', 's' ], {
      encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 20_000,
    } );
    const none = run( {} );
    expect( none.status ).toBe( 1 );
    expect( none.stderr ).toContain( 'a token (--token or BLUEPRINT_STEWARD_TOKEN) are required' );
    const legacy = run( { BLUEPRINT_RUNNER_TOKEN: 'org-key' } );
    expect( legacy.stderr ).toContain( 'BLUEPRINT_RUNNER_TOKEN is deprecated; set BLUEPRINT_STEWARD_TOKEN instead' );
    expect( legacy.stderr ).not.toContain( 'are required' );
    expect( legacy.stderr ).not.toContain( 'org-key' );
  } );
} );
