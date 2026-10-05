export type BlueprintMcpErrorCode =
  | 'BLUEPRINT_DIR_MISSING'
  | 'GRAPH_MISSING'
  | 'GRAPH_UNREADABLE'
  | 'OVERRIDES_UNREADABLE'
  | 'BOARD_UNREADABLE'
  | 'ROOT_NOT_FOUND'
  | 'ROOT_NOT_COMMAND'
  | 'INVALID_SCOPE'
  | 'HOST_UNREACHABLE'
  | 'RUN_GRANT_ENDED'
  // The refusal the card-chat example tools judge before writing (handlers.ts).
  | 'MAP_ENTRY_INVALID';

export class BlueprintMcpError extends Error {
  readonly code: BlueprintMcpErrorCode;
  readonly details: unknown;

  constructor( code: BlueprintMcpErrorCode, message: string, details?: unknown ){
    super( message );
    this.name = 'BlueprintMcpError';
    this.code = code;
    this.details = details;
  }
}

export function isBlueprintMcpError( value: unknown ): value is BlueprintMcpError {
  return value instanceof BlueprintMcpError;
}
