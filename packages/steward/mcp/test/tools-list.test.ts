import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { BLUEPRINT_MCP_CAPABILITIES, UNFAMILIED_TOOLS } from '../src/capabilities.js';

/**
 * The real binary booted over stdio, as Steward starts it for a design agent: the tools it lists are exactly the
 * verb families and the unfamilied tools, and nothing else.
 */
const BIN = fileURLToPath( new URL( '../bin/blueprint-mcp.mjs', import.meta.url ));

describe( 'blueprint-mcp tools over stdio', () => {
  it( 'Given the binary booted on a hosted session when its tools are listed then there are exactly 34, start_map_session is not among them, and they are the families and the unfamilied tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ BIN ],
      cwd: fileURLToPath( new URL( '..', import.meta.url )),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NODE_OPTIONS: '',
        BLUEPRINT_HOST_URL: 'https://host.invalid',
        BLUEPRINT_ACCESS_TOKEN: 'run-token-value',
        BLUEPRINT_SESSION_ID: 'session-abc'
      },
      stderr: 'pipe'
    });
    const client = new Client({ name: 'tools-list-harness', version: '0.0.0' });
    await client.connect( transport );

    try {
      const names = ( await client.listTools()).tools.map( tool => tool.name ).sort();
      const classified = [ ...Object.values( BLUEPRINT_MCP_CAPABILITIES.families ).flat(), ...UNFAMILIED_TOOLS ].sort();

      expect( names ).toHaveLength( 34 );
      expect( names ).not.toContain( 'start_map_session' );
      expect( names ).toEqual( classified );
    } finally {
      await client.close().catch( () => undefined );
    }
  }, 30_000 );
});
