import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createHostedTarget } from './hosted-target.js';
import { createBlueprintMcpServer } from './server.js';
import { fetchToolText } from './tool-text.js';

// Steward starts this server for a design job with the session's server URL, the job's own key, the session and the
// job's worktree. It designs against that hosted session only; there is no local mode.
const REQUIRED = [ 'BLUEPRINT_HOST_URL', 'BLUEPRINT_ACCESS_TOKEN', 'BLUEPRINT_SESSION_ID' ] as const;
const missing = REQUIRED.filter( ( name ) => process.env[ name ] === undefined || process.env[ name ] === '' );
if ( missing.length > 0 ){
  process.stderr.write( `[blueprint-mcp] designs against a hosted session and needs ${ missing.join( ', ' ) }; not set\n` );
  process.exit( 1 );
}

const repoPath = process.env.BLUEPRINT_REPO_PATH ?? process.cwd();
const host = {
  hostUrl: process.env.BLUEPRINT_HOST_URL ?? '',
  accessToken: process.env.BLUEPRINT_ACCESS_TOKEN ?? '',
  sessionId: process.env.BLUEPRINT_SESSION_ID ?? ''
};
const target = createHostedTarget( host );
// The tools' descriptions are the server's; on any failure to read them the tools run on their fallbacks.
const toolText = await fetchToolText( host );

const server = createBlueprintMcpServer({ repoPath, target, ...( toolText !== undefined ? { toolText } : {}) });
await server.connect( new StdioServerTransport() );

process.stderr.write( `[blueprint-mcp] ready: session ${ process.env.BLUEPRINT_SESSION_ID } on ${ new URL( process.env.BLUEPRINT_HOST_URL ?? '' ).origin }, graph from ${ repoPath }\n` );
