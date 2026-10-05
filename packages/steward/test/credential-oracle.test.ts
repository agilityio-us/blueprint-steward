import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv, holdSecret, runChild, runQueued, spawnChild } from '../lib/child.mjs';

/**
 * Credential oracle: with BLUEPRINT_JIRA_API_TOKEN set in Steward's env, neither the variable name nor its value
 * reaches the env of any child Steward starts (extractor, git, gh, agent). Each child is a fake binary that dumps its
 * own env to a file, started through Steward's real spawn path.
 */
const NAME = 'BLUEPRINT_JIRA_API_TOKEN';
const VALUE = 'jira-secret-3f9c1e7a-distinctive';
const runnerEnv = { ...process.env, [ NAME ]: VALUE, RENAMED_COPY: VALUE, PATH: process.env.PATH ?? '' };

const dir = mkdtempSync( join( tmpdir(), 'cred-oracle-' ) );
const fake = ( name: string ) => {
  const bin = join( dir, name );
  const out = join( dir, `${ name }.env` );
  writeFileSync( bin, `#!/bin/sh\nenv > "${ out }"\n` );
  chmodSync( bin, 0o755 );
  return { bin, read: () => readFileSync( out, 'utf8' ) };
};
const expectClean = ( dump: string ) => {
  expect( dump ).not.toContain( NAME );
  expect( dump ).not.toContain( VALUE );
  expect( dump ).toContain( 'PATH=' );
};

describe( 'credential oracle', () => {
  it( 'Given the Jira token in Steward\'s env when childEnv builds a child env then neither name nor value is in it', () => {
    const env = childEnv( runnerEnv );
    expect( Object.keys( env ) ).not.toContain( NAME );
    expect( Object.values( env ) ).not.toContain( VALUE );
  } );

  it( 'Given the token when the extractor runs through runChild then its env is clean', async () => {
    const f = fake( 'extractor' );
    await runChild( f.bin, [], { env: runnerEnv } );
    expectClean( f.read() );
  } );

  it( 'Given the token when git and gh run through runQueued then their env is clean', async () => {
    const git = fake( 'git' );
    const gh = fake( 'gh' );
    await runQueued( 'repo', git.bin, [], { env: runnerEnv } );
    await runQueued( 'repo', gh.bin, [], { env: runnerEnv } );
    expectClean( git.read() );
    expectClean( gh.read() );
  } );

  it( 'Given the token when the agent (claude) is spawned through spawnChild then its env is clean', async () => {
    const claude = fake( 'claude' );
    await new Promise( ( done ) => spawnChild( claude.bin, [], { env: runnerEnv, stdio: 'ignore' } ).on( 'close', done ) );
    expectClean( claude.read() );
  } );

  it( 'Given a held secret value under another name when a child starts then the value is dropped too', async () => {
    holdSecret( 'held-value-77' );
    const f = fake( 'held' );
    await runChild( f.bin, [], { env: { PATH: process.env.PATH, SNEAKY: 'held-value-77' } } );
    expect( f.read() ).not.toContain( 'held-value-77' );
  } );
} );
