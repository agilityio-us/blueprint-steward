const MARKS_ANNOTATION_KEY = 'marks';

const NON_MARK_TYPES: ReadonlySet<string> = new Set( [ 'stickyNote' ] );

export type MarkEnclosure = {
  flowId: string;
  nodeId: string;
  ordinal: number;
};

export type BoardMark = {
  markId: string;
  id: string;
  type: string;
  data: Record<string, unknown>;
  x: number;
  y: number;
  encloses: MarkEnclosure[];
  enclosedNodeIds: string[];
};

export type BoardMarksRead = {
  present: boolean;
  marks: BoardMark[];
};

const isRecord = ( value: unknown ): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray( value );

const asFinite = ( value: unknown ): number | undefined =>
  typeof value === 'number' && Number.isFinite( value ) ? value : undefined;

const asEnclosure = ( value: unknown ): MarkEnclosure | undefined => {
  if ( !isRecord( value )) return undefined;
  const { flowId, nodeId, ordinal } = value;
  if ( typeof flowId !== 'string' || flowId.length === 0 ) return undefined;
  if ( typeof nodeId !== 'string' || nodeId.length === 0 ) return undefined;
  if ( typeof ordinal !== 'number' || !Number.isInteger( ordinal ) || ordinal < 0 ) return undefined;
  return { flowId, nodeId, ordinal };
};

const asBoardMark = ( value: unknown ): BoardMark | undefined => {
  if ( !isRecord( value )) return undefined;
  const { id, type } = value;
  if ( typeof id !== 'string' || id.length === 0 ) return undefined;
  if ( typeof type !== 'string' || type.length === 0 || NON_MARK_TYPES.has( type )) return undefined;
  const markId = typeof value.markId === 'string' && value.markId.length > 0 ? value.markId : id;
  const x = asFinite( value.x );
  const y = asFinite( value.y );
  if ( x === undefined || y === undefined ) return undefined;

  const encloses: MarkEnclosure[] = [];
  if ( Array.isArray( value.encloses )){
    for ( const entry of value.encloses ){
      const enclosure = asEnclosure( entry );
      if ( enclosure === undefined ) return undefined;
      encloses.push( enclosure );
    }
  }

  const enclosedNodeIds: string[] = [];
  for ( const enclosure of encloses ){
    if ( !enclosedNodeIds.includes( enclosure.nodeId )) enclosedNodeIds.push( enclosure.nodeId );
  }

  return {
    markId,
    id,
    type,
    data: isRecord( value.data ) ? value.data : {},
    x,
    y,
    encloses,
    enclosedNodeIds
  };
};

// The session's board.json route answers marks as annotations.marks, a record keyed by mark id. Entries that are not marks are dropped; the result is sorted by markId.
export function marksFromAnnotations( annotations: unknown ): BoardMark[] {
  const stored = isRecord( annotations ) ? annotations[ MARKS_ANNOTATION_KEY ] : undefined;
  const marks: BoardMark[] = [];
  if ( isRecord( stored )){
    for ( const entry of Object.values( stored )){
      const mark = asBoardMark( entry );
      if ( mark !== undefined ) marks.push( mark );
    }
  }
  marks.sort(( a, b ) => a.markId.localeCompare( b.markId, 'en' ));
  return marks;
}
