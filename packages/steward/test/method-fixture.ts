import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What Steward's tests serve as a design claim's method plugin. The stub claudes never open the zip, so its bytes are
 * plain text; what Steward checks is that their sha256 is the one the claim names.
 */
export const METHOD_ZIP = Buffer.from( 'stub blueprint-method zip: Steward verifies its sha256, the stub claude never opens it\n', 'utf8' );

export const sha256Of = ( bytes: Buffer ): string => createHash( 'sha256' ).update( bytes ).digest( 'hex' );

/** The `method` a design claim carries: the plugin's name, version label, sha256, entry. */
export const METHOD = { name: 'blueprint-method', version: '0.1.0', sha256: sha256Of( METHOD_ZIP ), entry: 'turn' };

/** The job-scoped route Steward downloads the zip from (RUNNER_JOB_METHOD_SEGMENT beneath RUNNER_JOBS_ROUTE). */
export const METHOD_ROUTE = /^\/api\/blueprint\/runner\/jobs\/[^/]+\/method$/;

/**
 * Live captures of `claude -p --output-format stream-json --verbose` from Claude Code 2.1.287 (macOS, 2026-10-03,
 * claude-haiku-4-5-20251001, the design job's flags with an MCP config of no servers), kept verbatim but for these
 * scrubs: session_id and uuid (placeholder uuids), cwd, memory_paths.auto, messaging_socket_path, the plugin's temporary
 * path (`inline-0-method`), every cost and token count (zero), timestamps (one placeholder), and slash_commands and
 * skills (a short neutral list, plus the method's own command).
 * claude-2.1.287-stream.jsonl ran with `--plugin-dir <the bundled method zip>` and the prompt
 * `/blueprint-method:turn Reply with exactly the word ok and nothing else.`; claude-2.1.287-stream-no-plugin.jsonl
 * ran the same flags and prompt text without --plugin-dir and without the slash command.
 */
const FIXTURES = join( __dirname, 'fixtures' );
export const STREAM_2_1_287 = readFileSync( join( FIXTURES, 'claude-2.1.287-stream.jsonl' ), 'utf-8' );
export const STREAM_2_1_287_NO_PLUGIN = readFileSync( join( FIXTURES, 'claude-2.1.287-stream-no-plugin.jsonl' ), 'utf-8' );

/** The captured init event that lists blueprint-method among its plugins, one line. */
export const INIT_LINE = STREAM_2_1_287.split( '\n' )[ 0 ];
/** The captured init event of the run without --plugin-dir: its plugins are only claude's builtin ones. */
export const INIT_LINE_NO_PLUGIN = STREAM_2_1_287_NO_PLUGIN.split( '\n' )[ 0 ];

/** A statement for a stub claude's script that writes the init event listing the method, as claude does first. */
export const printInit = `process.stdout.write(${ JSON.stringify( `${ INIT_LINE }\n` ) });`;

/**
 * A live capture of the same flags from Claude Code 2.1.288 (macOS, 2026-10-03, claude-haiku-4-5-20251001, --plugin-dir
 * a zip of the bundled method, the same prompt) in a throwaway repository whose .claude/settings.json declares a
 * SessionStart hook (`echo session-start-hook-ran`), as a real repository may: claude writes the hook's system/hook_started
 * and system/hook_response events before its system/init. Scrubbed as the 2.1.287 captures are, and its hook_id
 * a placeholder uuid.
 */
export const STREAM_2_1_288_SESSION_START_HOOK = readFileSync( join( FIXTURES, 'claude-2.1.288-stream-session-start-hook.jsonl' ), 'utf-8' );
