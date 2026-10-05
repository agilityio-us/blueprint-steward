import { BLUEPRINT_OVERRIDES_FILENAME } from '@bett3r-dev/blueprint-schema';
import { SESSION_HEADER, TOOL_TEXT_ROUTE, TOOL_TEXT_VERSION, type ToolText } from '@bett3r-dev/blueprint-spec';

import type { ToolOutcome } from './tool-result.js';

// The text a model reads about these tools is served by the session's server (TOOL_TEXT_ROUTE) and overlaid at start:
// the instructions, each tool's description, its input fields' descriptions, the recovery a refusal carries and the
// notes a result carries. What stays here is a terse, mechanical fallback for the instructions, descriptions and notes,
// which the MCP runs on when the served text cannot be read; without it, input fields carry no description.

export const FALLBACK_INSTRUCTIONS = 'Design tools for a hosted Blueprint session.';

export const FALLBACK_DESCRIPTIONS = {
  propose: 'Propose design nodes and edges in one batch; answers the derived node ids.',
  modify: 'Change the label, subdomain, resourceKey or queries of existing elements by id, in one batch.',
  remove: 'Remove nodes and edges from the design, in one batch.',
  comment: 'Leave comments on nodes, edges, other comments or the design, in one batch; answers the comment ids.',
  resolve: 'Set or clear the resolved flag of comments by id, in one batch.',
  undo: 'Undo your own last design write. Takes no arguments.',
  reclassify: 'Move design entries into the repository\'s overrides file.',
  get_flow: 'Read the flow rooted at one command over the merged graph.',
  get_design: 'Read the session\'s design document.',
  get_marks: 'Read the marks drawn on the board, with the node ids each encloses.',
  read_changes: 'Read the ops written since the sync cursor.',
  mark_synced: 'Move the sync cursor to a seq.',
  status: 'Read the session\'s status: seqs, unread ops, lock state, git sha and capabilities.',
  kpi_lookup: 'Search for or resolve a KPI in the repository\'s observability, through the host.',
  map_ground: 'Set the map\'s shape, once per session.',
  map_post: 'Create or replace one map node or fork by id.',
  map_propose_scenario: 'Propose one scenario; answers its minted id.',
  map_modify_scenario: 'Replace the body of one proposed scenario by id.',
  map_propose_observation: 'Propose one observation; answers its minted id.',
  map_modify_observation: 'Replace the body of one proposed observation by id.',
  map_strike: 'Strike a map entry, with a reason.',
  map_choose: 'Choose a fork\'s recommended option.',
  map_link: 'Link an ES node id to a map deliverable.',
  map_unlink: 'Remove a link between an ES node id and a map deliverable.',
  map_cover: 'Record that a scenario covers an ES element.',
  map_uncover: 'Remove a coverage pair.',
  map_undo: 'Undo your own last map write. Takes no arguments.',
  get_map: 'Read the map and its seq.',
  get_card: 'Read the card or cards a channel key names, with their examples.',
  get_map_links: 'Read the report of the map\'s links against the merged graph.',
  get_coverage: 'Read the report of the map\'s coverage pairs against the merged graph.',
  spec_post: 'Create or replace spec entries by id, in one batch.',
  spec_strike: 'Strike spec entries by id, each with a reason.',
  get_spec: 'Read the design spec and its seq.'
} as const;

export type ToolName = keyof typeof FALLBACK_DESCRIPTIONS;

export const FALLBACK_NOTES = {
  'reclassify.workingTree.changed': `${ BLUEPRINT_OVERRIDES_FILENAME } changed in the working tree.`,
  'reclassify.workingTree.unchanged': `${ BLUEPRINT_OVERRIDES_FILENAME } already held these entries; nothing was written.`
} as const;

export type NoteKey = keyof typeof FALLBACK_NOTES;

/** The text the server registers its tools with: the served document over the fallbacks. */
export type ResolvedToolText = {
  instructions: string;
  describe( tool: ToolName ): string;
  /** The served description of one of a tool's input fields, by field path; undefined when none is served. */
  field( tool: ToolName, path: string ): string | undefined;
  note( key: NoteKey ): string;
  /** A failure carrying the recovery the served text names for its tool and code, if any. */
  withRecovery<Outcome extends ToolOutcome<unknown>>( tool: ToolName, outcome: Outcome ): Outcome;
};

const isRecord = ( value: unknown ): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray( value );

const textOf = ( value: unknown ): string | undefined => ( typeof value === 'string' && value.trim() !== '' ? value : undefined );

/**
 * The served document as this MCP reads it, or undefined when it is not one. Entries that are not text are dropped
 * and keys it does not know are ignored, so a newer server's additions never break an older MCP.
 */
export function parseToolText( value: unknown ): ToolText | undefined {
  if ( !isRecord( value ) || value.version !== TOOL_TEXT_VERSION ) return undefined;
  const strings = ( entries: unknown ): Record<string, string> =>
    isRecord( entries )
      ? Object.fromEntries( Object.entries( entries ).flatMap(([ key, item ]) => {
        const text = textOf( item );
        return text === undefined ? [] : [ [ key, text ] ];
      }))
      : {};
  const byTool = ( entries: unknown ): Record<string, Record<string, string>> =>
    isRecord( entries ) ? Object.fromEntries( Object.entries( entries ).map(([ tool, items ]) => [ tool, strings( items ) ])) : {};
  const instructions = textOf( value.instructions );
  return {
    version: TOOL_TEXT_VERSION,
    ...( instructions !== undefined ? { instructions } : {}),
    tools: strings( value.tools ),
    fields: byTool( value.fields ),
    recovery: byTool( value.recovery ),
    notes: strings( value.notes )
  };
}

export function resolveToolText( served: ToolText | undefined ): ResolvedToolText {
  const own = <Item>( record: Record<string, Item> | undefined, key: string ): Item | undefined =>
    record !== undefined && Object.hasOwn( record, key ) ? record[ key ] : undefined;
  function withRecovery<Outcome extends ToolOutcome<unknown>>( tool: ToolName, outcome: Outcome ): Outcome {
    if ( outcome.ok ) return outcome;
    const recovery = own( own( served?.recovery, tool ), outcome.error.code );
    return recovery === undefined ? outcome : { ...outcome, error: { ...outcome.error, recovery } };
  }
  return {
    instructions: served?.instructions ?? FALLBACK_INSTRUCTIONS,
    describe: ( tool ) => own( served?.tools, tool ) ?? FALLBACK_DESCRIPTIONS[ tool ],
    field: ( tool, path ) => own( own( served?.fields, tool ), path ),
    note: ( key ) => own( served?.notes, key ) ?? FALLBACK_NOTES[ key ],
    withRecovery
  };
}

export type FetchToolTextOptions = {
  hostUrl: string;
  accessToken: string;
  sessionId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Where the one line a failed read writes goes; stderr by default. */
  log?: ( line: string ) => void;
};

/**
 * Reads the tool text the session's server serves, with the job key the MCP already holds. Any failure (no answer, a
 * refusal, a body that is not the document) answers undefined and logs one line, and the MCP runs on its fallbacks.
 */
export async function fetchToolText( options: FetchToolTextOptions ): Promise<ToolText | undefined> {
  const log = options.log ?? ( ( line: string ) => process.stderr.write( `${ line }\n` ));
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${ options.hostUrl.replace( /\/+$/, '' ) }${ TOOL_TEXT_ROUTE }`;
  const redact = ( text: string ): string => ( options.accessToken === '' ? text : text.split( options.accessToken ).join( '[redacted]' ));
  let reason: string;
  try {
    const response = await doFetch( url, {
      headers: { accept: 'application/json', authorization: `Bearer ${ options.accessToken }`, [ SESSION_HEADER ]: options.sessionId },
      signal: AbortSignal.timeout( options.timeoutMs ?? 10_000 )
    });
    if ( response.ok ){
      const parsed = parseToolText( await response.json().catch(() => undefined ));
      if ( parsed !== undefined ) return parsed;
      reason = 'the answer is not a tool text document';
    } else {
      reason = `the host answered ${ response.status }`;
    }
  } catch ( cause ){
    reason = cause instanceof Error ? cause.message : String( cause );
  }
  log( `[blueprint-mcp] tool text unavailable (${ redact( reason ) }); running on fallback descriptions` );
  return undefined;
}
