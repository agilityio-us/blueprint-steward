#!/usr/bin/env node
// Bundles Steward into <out> (default dist/) at the layout the bin resolves at runtime: bin/blueprint-steward.mjs,
// mcp/bin/blueprint-mcp.mjs and mcp/bin/blueprint-repo-mcp.mjs, each one file holding what it imports, so <out> runs
// on plain Node with no node_modules. The image ships exactly this.
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const out = resolve( process.cwd(), process.argv[ 2 ] ?? resolve( root, 'dist' ) );
rmSync( out, { recursive: true, force: true } );

// Bundled CommonJS dependencies need a require in an ES module.
const banner = { js: "import { createRequire } from 'node:module'; const require = createRequire( import.meta.url );" };
const entries = [
  [ 'bin/blueprint-steward.mjs', 'bin/blueprint-steward.mjs' ],
  [ 'mcp/src/main.ts', 'mcp/bin/blueprint-mcp.mjs' ],
  [ 'mcp/bin/blueprint-repo-mcp.mjs', 'mcp/bin/blueprint-repo-mcp.mjs' ],
];
for ( const [ from, to ] of entries ) {
  await build( {
    entryPoints: [ resolve( root, from ) ],
    outfile: resolve( out, to ),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    legalComments: 'none',
    banner,
    logLevel: 'warning',
  } );
}
console.log( `bundled Steward into ${ out }` );
