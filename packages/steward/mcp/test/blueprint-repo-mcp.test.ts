import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * blueprint-repo-mcp gives a hosted design agent the repository's git history and nothing else. Each tool runs one
 * git command with a fixed argv: no pager, textconv or external diff, no option reaching git from an argument, and a
 * revision starting with '-' refused. The real binary is booted over stdio, as claude runs it from Steward's
 * --mcp-config.
 */
const BIN = fileURLToPath( new URL( '../bin/blueprint-repo-mcp.mjs', import.meta.url ));

// The fixture owns git: no system or global config reaches these calls, and ambient GIT_* variables are dropped.
const gitEnv = (): Record<string, string> => ( {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
} );

let scratch: string;
let repo: string;
const git = ( ...argv: string[] ): string => execFileSync( 'git', argv, { cwd: repo, env: gitEnv(), encoding: 'utf-8' } );
const commit = ( message: string ): void => { git( '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-am', message ); };

beforeEach( () => {
  scratch = mkdtempSync( join( tmpdir(), 'blueprint-repo-mcp-' ));
  repo = join( scratch, 'repo' );
  mkdirSync( repo );
  git( 'init', '--quiet', '-b', 'main' );
  writeFileSync( join( repo, '.gitattributes' ), '*.bin diff=conv\n' );
  writeFileSync( join( repo, 'notes.txt' ), 'first line\n' );
  writeFileSync( join( repo, 'f.bin' ), 'alpha\n' );
  git( 'add', '-A' );
  commit( 'one: the first commit' );
  writeFileSync( join( repo, 'notes.txt' ), 'first line\n-x marks a dash pattern\n' );
  writeFileSync( join( repo, 'f.bin' ), 'beta\n' );
  commit( 'two: the second commit' );
});

afterEach( () => {
  rmSync( scratch, { recursive: true, force: true });
});

type Answer = { text: string; isError: boolean };

// Boots the repo MCP on `repo` (BLUEPRINT_REPO_PATH, as Steward sets it; cwd is the scratch dir, so a stray file
// would land in one of the two places the tests look) and calls each tool in turn.
const withRepoMcp = async <T>( body: ( call: ( name: string, args: Record<string, unknown> ) => Promise<Answer>, client: Client ) => Promise<T>, env: Record<string, string> = {} ): Promise<T> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ BIN ],
    cwd: scratch,
    env: { ...gitEnv(), NODE_OPTIONS: '', BLUEPRINT_REPO_PATH: repo, ...env },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'repo-mcp-harness', version: '0.0.0' });
  await client.connect( transport );
  try {
    return await body( async ( name, args ) => {
      const result = await client.callTool({ name, arguments: args });
      const [ first ] = 'content' in result && Array.isArray( result.content ) ? result.content : [];
      return { text: first?.type === 'text' ? String( first.text ) : '<no text content>', isError: result.isError === true };
    }, client );
  } finally {
    await client.close().catch( () => undefined );
  }
};

// A config-driven command that, if git ever ran it, would leave `marker` behind.
const markerCommand = ( marker: string ): string => `sh -c 'touch "${ marker }"; cat "$0"'`;

describe( 'blueprint-repo-mcp: read-only git history over stdio', () => {
  // The history tools are mcp__blueprint_repo__git_log, __git_show, __git_grep and __git_diff; Steward registers this
  // server as `blueprint_repo`, so the tools it lists are those four names.
  it( 'Given the repo MCP started when its tools are listed then they are exactly git_diff, git_grep, git_log and git_show', async () => {
    const names = await withRepoMcp( async ( _call, client ) => ( await client.listTools()).tools.map( ( tool ) => tool.name ).sort() );
    expect( names ).toEqual( [ 'git_diff', 'git_grep', 'git_log', 'git_show' ] );
  }, 30_000 );

  it( 'Given a temp git repo when git_log is called with --output=x, and with revision -x then both are refused with the refusal text and no file x exists; a plain revision lists the commits', async () => {
    const [ output, dash, plain ] = await withRepoMcp( async ( call ) => [
      await call( 'git_log', { revision: '--output=x' } ),
      await call( 'git_log', { revision: '-x' } ),
      await call( 'git_log', { revision: 'HEAD' } )
    ] );

    expect( [ output.isError, dash.isError ] ).toEqual( [ true, true ] );
    expect( output.text ).toContain( 'may not start with \'-\'' );
    expect( dash.text ).toContain( 'may not start with \'-\'' );
    expect( [ existsSync( join( repo, 'x' )), existsSync( join( scratch, 'x' )) ] ).toEqual( [ false, false ] );
    // Positive control: the same tool answers a revision it accepts.
    expect( [ plain.isError, plain.text.includes( 'two: the second commit' ), plain.text.includes( 'one: the first commit' ) ] ).toEqual( [ false, true, true ] );
  }, 30_000 );

  it( 'Given a repo whose config has a textconv driver writing a marker when git_show, git_log with patches and git_diff are called then none creates the marker and the diff is shown as stored', async () => {
    const marker = join( scratch, 'textconv-ran' );
    git( 'config', 'diff.conv.textconv', markerCommand( marker ));
    // Positive control: git's own show, log --patch and diff of these commits each run the driver in this fixture.
    const ranOnPlainGit = [ [ 'show', 'HEAD' ], [ 'log', '--patch', '-1' ], [ 'diff', 'HEAD~1', 'HEAD' ] ].map( ( argv ) => {
      git( '--no-pager', ...argv );
      const ran = existsSync( marker );
      rmSync( marker, { force: true });
      return ran;
    });
    expect( ranOnPlainGit ).toEqual( [ true, true, true ] );

    // Each call is followed by a look for the marker, so a failure names the tool that ran the driver.
    const answers = await withRepoMcp( async ( call ) => {
      const calls: [ string, Record<string, unknown> ][] = [
        [ 'git_show', { revision: 'HEAD' } ],
        [ 'git_show', { revision: 'HEAD:f.bin' } ],
        [ 'git_log', { maxCount: 1, patch: true } ],
        [ 'git_diff', { from: 'HEAD~1' } ]
      ];
      const out: ( Answer & { tool: string; ran: boolean })[] = [];
      for ( const [ name, args ] of calls ) {
        const answer = await call( name, args );
        out.push({ ...answer, tool: name, ran: existsSync( marker ) });
        rmSync( marker, { force: true });
      }
      return out;
    });

    expect( answers.map( ( { tool, ran } ) => `${ tool }:${ ran }` )).toEqual( [ 'git_show:false', 'git_show:false', 'git_log:false', 'git_diff:false' ] );
    const [ shownCommit, shownBlob, logged, diffed ] = answers;
    expect( [ shownCommit.isError, shownCommit.text.includes( '+beta' ), shownBlob.isError, shownBlob.text ] ).toEqual( [ false, true, false, 'beta\n' ] );
    expect( [ logged.isError, logged.text.includes( '+beta' ), diffed.isError, diffed.text.includes( '+beta' ) ] ).toEqual( [ false, true, false, true ] );
  }, 30_000 );

  // git_diff's newer side defaults to HEAD, never the working tree: with only `from`, an uncommitted edit is not in
  // the answer.
  it( 'Given an uncommitted edit in the worktree when git_diff is called with only from then the answer is the diff to HEAD without the edit', async () => {
    writeFileSync( join( repo, 'notes.txt' ), 'first line\n-x marks a dash pattern\nan uncommitted dirty line\n' );
    // Positive control: git's own diff from HEAD~1 with no second revision does show the edit in this fixture.
    expect( git( '--no-pager', 'diff', 'HEAD~1' )).toContain( '+an uncommitted dirty line' );

    const diffed = await withRepoMcp( async ( call ) => call( 'git_diff', { from: 'HEAD~1' } ));

    expect( [ diffed.isError, diffed.text.includes( '+-x marks a dash pattern' ), diffed.text.includes( 'uncommitted dirty line' ) ] ).toEqual( [ false, true, false ] );
  }, 30_000 );

  // A commit carrying a gpgsig header, written by hand (no key needed), with log.showSignature on: git log and git show
  // would hand the signature to gpg.program to verify.
  it( 'Given a signed commit and a repo config that verifies signatures through a marker-writing gpg.program when git_log and git_show run then the program never runs', async () => {
    const marker = join( scratch, 'gpg-ran' );
    const gpg = join( scratch, 'gpg.sh' );
    writeFileSync( gpg, `#!/bin/sh\ntouch "${ marker }"\ncat >/dev/null\nexit 1\n`, { mode: 0o755 } );
    const body = join( scratch, 'signed-commit' );
    writeFileSync( body, [
      `tree ${ git( 'rev-parse', 'HEAD^{tree}' ).trim() }`,
      `parent ${ git( 'rev-parse', 'HEAD' ).trim() }`,
      'author t <t@t> 1700000000 +0000',
      'committer t <t@t> 1700000000 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' iQEzBAABCAAdFiEE',
      ' -----END PGP SIGNATURE-----',
      '',
      'three: a signed commit',
      ''
    ].join( '\n' ));
    git( 'update-ref', 'refs/heads/main', git( 'hash-object', '-t', 'commit', '-w', body ).trim());
    git( 'config', 'log.showSignature', 'true' );
    git( 'config', 'gpg.program', gpg );
    // Positive control: git's own log and show of the commit run the program in this fixture.
    const ranOnPlainGit = [ [ 'log', '-1' ], [ 'show', 'HEAD' ] ].map( ( argv ) => {
      git( '--no-pager', ...argv );
      const ran = existsSync( marker );
      rmSync( marker, { force: true });
      return ran;
    });
    expect( ranOnPlainGit ).toEqual( [ true, true ] );

    const answers = await withRepoMcp( async ( call ) => {
      const logged = await call( 'git_log', { maxCount: 1 } );
      const loggedRan = existsSync( marker );
      rmSync( marker, { force: true });
      const shown = await call( 'git_show', { revision: 'HEAD' } );
      return { logged, loggedRan, shown, shownRan: existsSync( marker ) };
    });

    expect( [ answers.loggedRan, answers.shownRan ] ).toEqual( [ false, false ] );
    expect( [ answers.logged.isError, answers.logged.text.includes( 'three: a signed commit' ), answers.shown.isError, answers.shown.text.includes( 'three: a signed commit' ) ] )
      .toEqual( [ false, true, false, true ] );
  }, 30_000 );

  it( 'Given a repo whose config names an external diff writing a marker when git_diff compares two commits then the marker is never created; -O and a dash revision are refused', async () => {
    const marker = join( scratch, 'ext-diff-ran' );
    const external = join( scratch, 'external-diff.sh' );
    writeFileSync( external, `#!/bin/sh\ntouch "${ marker }"\n`, { mode: 0o755 } );
    git( 'config', 'diff.external', external );
    // Positive control: git's own diff of the two commits runs it in this fixture.
    git( '--no-pager', 'diff', 'HEAD~1', 'HEAD' );
    expect( existsSync( marker )).toBe( true );
    rmSync( marker );

    const [ diffed, orderFile, extDiff ] = await withRepoMcp( async ( call ) => [
      await call( 'git_diff', { from: 'HEAD~1', to: 'HEAD' } ),
      await call( 'git_diff', { from: `-O${ join( scratch, 'order' ) }` } ),
      await call( 'git_diff', { from: 'HEAD~1', to: '--ext-diff' } )
    ] );

    expect( existsSync( marker )).toBe( false );
    expect( [ diffed.isError, diffed.text.includes( '+-x marks a dash pattern' ) ] ).toEqual( [ false, true ] );
    expect( [ orderFile.isError, orderFile.text.includes( 'may not start with \'-\'' ), extDiff.isError, extDiff.text.includes( 'may not start with \'-\'' ) ] )
      .toEqual( [ true, true, true, true ] );
  }, 30_000 );

  // git pages only to a terminal and these calls write to a pipe, so this pins that no configured pager ever runs; it
  // cannot tell --no-pager from the pipe alone.
  it( 'Given a repo whose config names a pager writing a marker when git_log and git_show run then the marker is never created', async () => {
    const marker = join( scratch, 'pager-ran' );
    git( 'config', 'core.pager', markerCommand( marker ));
    git( 'config', 'pager.log', markerCommand( marker ));

    const [ logged, shown ] = await withRepoMcp( async ( call ) => [
      await call( 'git_log', { maxCount: 1, patch: true } ),
      await call( 'git_show', { revision: 'HEAD~1' } )
    ] );

    expect( existsSync( marker )).toBe( false );
    expect( [ logged.isError, logged.text.includes( 'two: the second commit' ), shown.isError, shown.text.includes( 'one: the first commit' ) ] ).toEqual( [ false, true, false, true ] );
  }, 30_000 );

  it( 'Given history with a line starting with a dash when git_grep searches for it at a revision then the pattern is read as a pattern, not an option, and a dash revision is refused', async () => {
    const [ found, missing, dashRevision ] = await withRepoMcp( async ( call ) => [
      await call( 'git_grep', { pattern: '-x marks' } ),
      await call( 'git_grep', { pattern: '-x marks', revision: 'HEAD~1' } ),
      await call( 'git_grep', { pattern: 'first', revision: '-x' } )
    ] );

    expect( [ found.isError, found.text ] ).toEqual( [ false, 'HEAD:notes.txt:2:-x marks a dash pattern\n' ] );
    expect( [ missing.isError, missing.text ] ).toEqual( [ false, 'no match' ] );
    expect( [ dashRevision.isError, dashRevision.text.includes( 'may not start with \'-\'' ) ] ).toEqual( [ true, true ] );
  }, 30_000 );

  // A git that never answers stands in for a slow one: the first `git` on the server's PATH sleeps, and the timeout is
  // lowered through BLUEPRINT_REPO_MCP_TIMEOUT_MS so the kill path runs in well under the test's own limit.
  it( 'Given a git that does not answer and a 300 ms timeout when git_log is called then the call is stopped and says so', async () => {
    const bin = join( scratch, 'slow-bin' );
    mkdirSync( bin );
    writeFileSync( join( bin, 'git' ), '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 } );

    const started = Date.now();
    const logged = await withRepoMcp( async ( call ) => call( 'git_log', {} ), { PATH: `${ bin }:${ process.env.PATH ?? '' }`, BLUEPRINT_REPO_MCP_TIMEOUT_MS: '300' } );

    expect( [ logged.isError, logged.text ] ).toEqual( [ true, 'git log passed 0.3 s and was stopped; narrow the query' ] );
    expect( Date.now() - started ).toBeLessThan( 15_000 );
  }, 30_000 );

  it( 'Given a blob larger than the output cap when git_show prints it then the answer is cut at the cap and says so', async () => {
    writeFileSync( join( repo, 'big.txt' ), `${ 'y'.repeat( 99 ) }\n`.repeat( 3_000 ));
    git( 'add', 'big.txt' );
    commit( 'three: a big file' );

    const shown = await withRepoMcp( async ( call ) => call( 'git_show', { revision: 'HEAD:big.txt' } ));

    const [ body, note ] = shown.text.split( '\n[blueprint-repo-mcp: ' );
    expect( [ shown.isError, body.length, note ] ).toEqual( [ false, 100_000, 'output cut at 100000 bytes; narrow the query]' ] );
  }, 30_000 );
} );

/**
 * The git tools live outside blueprint-mcp because blueprint-mcp starts no process. Its sources import no
 * child_process; the repo MCP, which must, is the positive control.
 */
describe( 'blueprint-mcp keeps its no-process property', () => {
  const importsChildProcess = ( path: string ): boolean => readFileSync( path, 'utf-8' )
    .split( '\n' ).filter( ( line ) => !/^\s*(\/\/|\*|\/\*)/.test( line ))
    .some( ( line ) => /from\s+['"](node:)?child_process['"]|import\(\s*['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]/.test( line ));

  it( 'Given blueprint-mcp\'s src tree when each source is read then none imports child_process, while blueprint-repo-mcp.mjs does', () => {
    const src = fileURLToPath( new URL( '../src', import.meta.url ));
    const sources = readdirSync( src, { recursive: true, encoding: 'utf-8' } ).filter( ( name ) => /\.(ts|mts|mjs|js)$/.test( name )).sort();
    expect( sources.length ).toBeGreaterThan( 10 );
    expect( sources.filter( ( name ) => importsChildProcess( join( src, name )) )).toEqual( [] );
    expect( importsChildProcess( BIN )).toBe( true );
  } );
} );
