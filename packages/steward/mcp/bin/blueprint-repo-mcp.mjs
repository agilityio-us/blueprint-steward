#!/usr/bin/env node
// blueprint-repo-mcp, the read-only git history a hosted design agent may read. Steward
// starts it beside blueprint-mcp, as MCP server `blueprint_repo`, only when the design claim's optionalTools name
// mcp__blueprint_repo and Steward's --tool-ceiling admits it; the agent then sees mcp__blueprint_repo__git_log,
// __git_show, __git_grep and __git_diff. It is a process of its own so blueprint-mcp keeps starting none.
//
// Each tool runs one git command through execFile (no shell) with a fixed argv. What the caller supplies reaches git
// only as a revision, a pathspec after `--`, a grep pattern after `-e` or a message filter inside `--grep=`; a revision
// starting with '-' is refused, so --output, -O, --ext-diff and every other option stay out, and --end-of-options
// stands behind that check. Config that runs a command is switched off per call: every call passes --no-pager and
// -c log.showSignature=false; git_log, git_show and git_diff pass --no-textconv and --no-ext-diff; git_log and git_show
// pass --no-show-signature (with the -c, belt and braces), so no gpg.program runs; git_grep passes --no-textconv. The
// -c core.fsmonitor=false and GIT_OPTIONAL_LOCKS=0 are belt and braces too: none of the four commands, on commits
// and trees, consults the fsmonitor. Every call reads commits and trees, never the working tree, so no clean filter
// runs; the one exception is a `:path` revision (no commit before the colon), which names the index's copy of path.
// Output is cut at OUTPUT_CAP_BYTES and a call at GIT_TIMEOUT_MS (BLUEPRINT_REPO_MCP_TIMEOUT_MS, a positive whole
// number of milliseconds, overrides it) is killed.
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const repoPath = process.env.BLUEPRINT_REPO_PATH || process.cwd();
const OUTPUT_CAP_BYTES = 100_000;
const GIT_TIMEOUT_MS = /^[1-9][0-9]*$/.test( process.env.BLUEPRINT_REPO_MCP_TIMEOUT_MS ?? '' ) ? Number( process.env.BLUEPRINT_REPO_MCP_TIMEOUT_MS ) : 30_000;
const MAX_COUNT_DEFAULT = 50;
const MAX_COUNT_LIMIT = 1_000;

// Before every subcommand: no pager, and no config-named command that a read could start.
const GIT_PREFIX = [ '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false' ];
const gitEnv = () => {
  const env = { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_EXTERNAL_DIFF;
  return env;
};

class Refused extends Error {}

// A revision (or rev:path object name) as git reads one: not empty, not an option, no control characters.
const revision = ( value, field ) => {
  if ( typeof value !== 'string' || value === '' ) throw new Refused( `${ field } is empty` );
  if ( value.startsWith( '-' ) ) throw new Refused( `${ field } "${ value }" may not start with '-': only a revision is read here, never an option` );
  if ( value.length > 512 || /[\u0000-\u001f\u007f]/.test( value ) ) throw new Refused( `${ field } is not a revision` );
  return value;
};
// Pathspecs go after `--`, where git reads none as an option.
const pathspecs = ( values = [] ) => {
  for ( const path of values ) {
    if ( path === '' || path.length > 1024 || /[\u0000-\u001f\u007f]/.test( path ) ) throw new Refused( `path "${ path }" is not a path` );
  }
  return [ '--', ...values ];
};

const text = ( value, isError = false ) => ( { content: [ { type: 'text', text: value } ], ...( isError ? { isError: true } : {} ) } );
// git's output past OUTPUT_CAP_BYTES is dropped (execFile stops reading at maxBuffer) and the answer says so.
const cut = ( out ) => `${ Buffer.from( out, 'utf8' ).subarray( 0, OUTPUT_CAP_BYTES ).toString( 'utf8' ) }\n[blueprint-repo-mcp: output cut at ${ OUTPUT_CAP_BYTES } bytes; narrow the query]`;

// Runs `git <argv>` in the repository. `noMatch` is the answer for exit 1 where git means "nothing found" (grep).
const run = ( build, { noMatch } = {} ) => async ( args ) => {
  let argv;
  try {
    argv = build( args );
  } catch ( err ) {
    if ( err instanceof Refused ) return text( `refused: ${ err.message }`, true );
    throw err;
  }
  return new Promise( ( resolve ) => {
    execFile( 'git', [ ...GIT_PREFIX, ...argv ], { cwd: repoPath, env: gitEnv(), encoding: 'utf8', maxBuffer: OUTPUT_CAP_BYTES, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }, ( err, stdout, stderr ) => {
      if ( err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ) return resolve( text( cut( stdout ) ) );
      if ( err && err.killed ) return resolve( text( `git ${ argv[ 0 ] } passed ${ GIT_TIMEOUT_MS / 1000 } s and was stopped; narrow the query`, true ) );
      if ( err && err.code === 1 && noMatch !== undefined && stderr === '' ) return resolve( text( noMatch ) );
      if ( err ) return resolve( text( `git ${ argv[ 0 ] } failed: ${ ( stderr || err.message ).trim() }`, true ) );
      resolve( text( stdout ) );
    } );
  } );
};

const server = new McpServer( { name: 'blueprint-repo-mcp', version: '0.1.0' }, {
  instructions: 'Read-only git history of the repository the design job runs in: commits, the changes they made, and '
    + 'text at any revision. Nothing here reads or changes the working tree.'
} );
const pathsField = z.array( z.string() ).optional().describe( 'Limit to these paths (git pathspecs)' );

server.registerTool( 'git_log', {
  title: 'git log',
  description: 'List commits, newest first: hash, author, date and message. Optionally from one revision or range '
    + `(e.g. HEAD, main, a1b2c3..HEAD), touching given paths, with messages matching a text, and with each commit's patch. At most ${ MAX_COUNT_LIMIT } commits (default ${ MAX_COUNT_DEFAULT }).`,
  inputSchema: {
    revision: z.string().optional().describe( 'A revision or range; default HEAD' ),
    paths: pathsField,
    maxCount: z.number().int().min( 1 ).max( MAX_COUNT_LIMIT ).optional(),
    grep: z.string().optional().describe( 'Only commits whose message matches this regular expression' ),
    patch: z.boolean().optional().describe( 'Include each commit\'s diff' )
  }
}, run( ( args ) => [
  'log', '--no-color', '--no-textconv', '--no-ext-diff', '--no-show-signature', '--date=iso-strict',
  `--max-count=${ args.maxCount ?? MAX_COUNT_DEFAULT }`,
  ...( args.grep === undefined ? [] : [ `--grep=${ args.grep }` ] ),
  ...( args.patch === true ? [ '--patch' ] : [] ),
  '--end-of-options', revision( args.revision ?? 'HEAD', 'revision' ),
  ...pathspecs( args.paths )
] ) );

server.registerTool( 'git_show', {
  title: 'git show',
  description: 'Show one commit with its diff, or a file as stored at a revision (e.g. HEAD~3:src/index.ts).',
  inputSchema: {
    revision: z.string().describe( 'A commit (e.g. a1b2c3, HEAD~2) or revision:path' ),
    paths: pathsField
  }
}, run( ( args ) => [
  'show', '--no-color', '--no-textconv', '--no-ext-diff', '--no-show-signature', '--date=iso-strict',
  '--end-of-options', revision( args.revision, 'revision' ),
  ...pathspecs( args.paths )
] ) );

server.registerTool( 'git_diff', {
  title: 'git diff',
  description: 'The changes between two revisions (default to: HEAD). Never the working tree.',
  inputSchema: {
    from: z.string().describe( 'The older revision' ),
    to: z.string().optional().describe( 'The newer revision; default HEAD' ),
    paths: pathsField,
    stat: z.boolean().optional().describe( 'Only the changed files and line counts' )
  }
}, run( ( args ) => [
  'diff', '--no-color', '--no-textconv', '--no-ext-diff',
  ...( args.stat === true ? [ '--stat' ] : [] ),
  '--end-of-options', revision( args.from, 'from' ), revision( args.to ?? 'HEAD', 'to' ),
  ...pathspecs( args.paths )
] ) );

server.registerTool( 'git_grep', {
  title: 'git grep',
  description: 'Search the files as stored at a revision (default HEAD) for a regular expression; answers '
    + 'revision:path:line:text per match, or "no match".',
  inputSchema: {
    pattern: z.string().min( 1 ).describe( 'A basic regular expression, as git grep reads one' ),
    revision: z.string().optional().describe( 'Where to search; default HEAD' ),
    paths: pathsField,
    ignoreCase: z.boolean().optional()
  }
}, run( ( args ) => [
  'grep', '--no-color', '--no-textconv', '-n', '-I',
  ...( args.ignoreCase === true ? [ '-i' ] : [] ),
  '-e', args.pattern,
  '--end-of-options', revision( args.revision ?? 'HEAD', 'revision' ),
  ...pathspecs( args.paths )
], { noMatch: 'no match' } ) );

await server.connect( new StdioServerTransport() );
process.stderr.write( `[blueprint-repo-mcp] ready: reading git history of ${ repoPath }\n` );
