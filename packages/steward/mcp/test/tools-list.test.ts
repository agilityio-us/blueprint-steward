import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOL_TEXT_VERSION, type ToolText } from '@bett3r-dev/blueprint-spec';

import { BLUEPRINT_MCP_CAPABILITIES, UNFAMILIED_TOOLS } from '../src/capabilities.js';
import type { BlueprintTarget } from '../src/handlers.js';
import { createBlueprintMcpServer } from '../src/server.js';

/**
 * The real binary booted over stdio, as Steward starts it for a design agent: the tools it lists are exactly the
 * verb families and the unfamilied tools, and nothing else.
 */
const BIN = fileURLToPath( new URL( '../bin/blueprint-mcp.mjs', import.meta.url ));

const connectBinary = async (): Promise<Client> => {
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
  return client;
};

// The blueprint server's served text for the two shape fields, keyed by the paths its tool-text.json uses
// (blueprint src/services/server/method/tool-text.json, fields.propose / fields.modify).
const SERVED_SHAPE_TEXT: ToolText = {
  version: TOOL_TEXT_VERSION,
  tools: {},
  fields: {
    propose: { 'nodes[].dataShape': 'Served propose shape.' },
    modify: { 'entries[].set.dataShape': 'Served modify shape.' }
  },
  recovery: {},
  notes: {}
};

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

  it( 'Given the binary booted on a hosted session when its tools are listed then propose lists dataShape on a node and modify lists dataShape on set, each an object (BP-270 D13)', async () => {
    const client = await connectBinary();

    try {
      const schemas = Object.fromEntries(( await client.listTools()).tools.map( tool => [ tool.name, tool.inputSchema as Record<string, any> ] ));

      expect( schemas.propose.properties.nodes.items.properties.dataShape ).toMatchObject({ type: 'object' });
      expect( schemas.propose.properties.nodes.items.required ).not.toContain( 'dataShape' );
      expect( schemas.modify.properties.entries.items.properties.set.properties.dataShape ).toMatchObject({ type: 'object' });
    } finally {
      await client.close().catch( () => undefined );
    }
  }, 30_000 );

  it( 'Given the blueprint server serves text for nodes[].dataShape and entries[].set.dataShape when the tools are listed then each lands on its dataShape field', async () => {
    const server = createBlueprintMcpServer({ repoPath: '.', target: {} as BlueprintTarget, toolText: SERVED_SHAPE_TEXT });
    const [ serverSide, clientSide ] = InMemoryTransport.createLinkedPair();
    await server.connect( serverSide );
    const client = new Client({ name: 'tools-list-harness', version: '0.0.0' });
    await client.connect( clientSide );

    try {
      const schemas = Object.fromEntries(( await client.listTools()).tools.map( tool => [ tool.name, tool.inputSchema as Record<string, any> ] ));

      expect( schemas.propose.properties.nodes.items.properties.dataShape?.description ).toBe( 'Served propose shape.' );
      expect( schemas.modify.properties.entries.items.properties.set.properties.dataShape?.description ).toBe( 'Served modify shape.' );
    } finally {
      await client.close().catch( () => undefined );
    }
  });
});
