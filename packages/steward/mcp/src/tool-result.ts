import type { CapabilitiesAdvertisement } from './capabilities.js';

export type ToolSuccess<Result> = {
  ok: true;
} & Result;

export type ToolFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    // What to do next, where the tool knows a recovery for this code.
    recovery?: string;
  };
  capabilities?: CapabilitiesAdvertisement;
};

/**
 * A write the server had already recorded under the same submission (it answers `replayed: true`): the seqs it
 * landed at, and a map-post's entry id where the feed still shows it.
 */
export type ToolRecorded = {
  seqs: number[];
  replayed: true;
  id?: string;
};

export type ToolOutcome<Result> = ToolSuccess<Result> | ToolFailure;

export type WriteOutcome<Result> = ToolOutcome<Result> | ToolSuccess<ToolRecorded>;

export type CallToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export function toCallToolResult( outcome: ToolOutcome<unknown> ): CallToolResult {
  return {
    content: [ { type: 'text', text: JSON.stringify( outcome, null, 2 ) } ],
    ...( outcome.ok ? {} : { isError: true })
  };
}

export function toolFailure( code: string, message: string, details?: unknown ): ToolFailure {
  return {
    ok: false,
    error: { code, message, ...( details !== undefined ? { details } : {}) }
  };
}
