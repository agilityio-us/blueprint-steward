import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath( new URL( '../bin/blueprint-mcp.mjs', import.meta.url ) );

type BootResult = {
  code: number | null;
  stderr: string;
  exited: boolean;
};

async function boot( blueprintEnv: Record<string, string>, waitMs = 15_000 ): Promise<BootResult> {
  const child = spawn( process.execPath, [ BIN ], {
    cwd: fileURLToPath( new URL( '..', import.meta.url ) ),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_OPTIONS: '',
      ...blueprintEnv
    },
    stdio: [ 'pipe', 'pipe', 'pipe' ]
  });

  let stderr = '';
  child.stderr.setEncoding( 'utf-8' );
  child.stderr.on( 'data', ( chunk: string ) => { stderr += chunk; });

  return await new Promise<BootResult>( ( resolve ) => {
    const timer = setTimeout( () => {
      child.kill( 'SIGKILL' );
      resolve({ code: null, stderr, exited: false });
    }, waitMs );
    child.on( 'exit', ( code ) => {
      clearTimeout( timer );
      setTimeout( () => resolve({ code, stderr, exited: true }), 50 );
    });
  });
}

function lines( stderr: string ): string[] {
  return stderr.split( '\n' ).map( ( line ) => line.trim() ).filter( ( line ) => line.length > 0 );
}

describe( 'blueprint-mcp hosted boot', () => {
  it( 'Given BLUEPRINT_HOST_URL alone when blueprint-mcp boots then it exits naming both missing variables on one stderr line', async () => {
    const result = await boot({ BLUEPRINT_HOST_URL: 'https://host.invalid' });

    expect( result.exited ).toBe( true );
    expect( result.code ).toBe( 1 );
    expect( lines( result.stderr ) ).toHaveLength( 1 );
    expect( lines( result.stderr )[ 0 ] ).toContain( 'BLUEPRINT_ACCESS_TOKEN' );
    expect( lines( result.stderr )[ 0 ] ).toContain( 'BLUEPRINT_SESSION_ID' );
  }, 30_000 );

  it( 'Given BLUEPRINT_HOST_URL and a token but no session id when blueprint-mcp boots then it exits naming BLUEPRINT_SESSION_ID only', async () => {
    const result = await boot({
      BLUEPRINT_HOST_URL: 'https://host.invalid',
      BLUEPRINT_ACCESS_TOKEN: 'run-token-value'
    });

    expect( result.exited ).toBe( true );
    expect( result.code ).toBe( 1 );
    expect( lines( result.stderr ) ).toHaveLength( 1 );
    expect( lines( result.stderr )[ 0 ] ).toContain( 'BLUEPRINT_SESSION_ID' );
    expect( lines( result.stderr )[ 0 ] ).not.toContain( 'BLUEPRINT_ACCESS_TOKEN' );
    expect( result.stderr ).not.toContain( 'run-token-value' );
  }, 30_000 );

  it( 'Given BLUEPRINT_HOST_URL and a session id but no token when blueprint-mcp boots then it exits naming BLUEPRINT_ACCESS_TOKEN only', async () => {
    const result = await boot({
      BLUEPRINT_HOST_URL: 'https://host.invalid',
      BLUEPRINT_SESSION_ID: 'session-abc'
    });

    expect( result.exited ).toBe( true );
    expect( result.code ).toBe( 1 );
    expect( lines( result.stderr ) ).toHaveLength( 1 );
    expect( lines( result.stderr )[ 0 ] ).toContain( 'BLUEPRINT_ACCESS_TOKEN' );
    expect( lines( result.stderr )[ 0 ] ).not.toContain( 'BLUEPRINT_SESSION_ID' );
  }, 30_000 );

  it( 'Given BLUEPRINT_HOST_URL with both credentials when blueprint-mcp boots then it stays up', async () => {
    const result = await boot({
      BLUEPRINT_HOST_URL: 'https://host.invalid',
      BLUEPRINT_ACCESS_TOKEN: 'run-token-value',
      BLUEPRINT_SESSION_ID: 'session-abc'
    }, 8_000 );

    expect( result.exited ).toBe( false );
  }, 30_000 );

  it( 'Given no BLUEPRINT_ variable when blueprint-mcp boots then it exits 1 naming all three on one stderr line, in order', async () => {
    const result = await boot({});

    expect( result.exited ).toBe( true );
    expect( result.code ).toBe( 1 );
    expect( lines( result.stderr ) ).toHaveLength( 1 );
    expect( lines( result.stderr )[ 0 ] ).toContain( 'BLUEPRINT_HOST_URL, BLUEPRINT_ACCESS_TOKEN, BLUEPRINT_SESSION_ID' );
  }, 30_000 );
});
