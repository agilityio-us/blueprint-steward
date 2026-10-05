import { z } from 'zod';

/**
 * Input field descriptions are served by field path (ToolText.fields) and written onto a tool's zod schema before it
 * is registered, so tools/list carries them. A path joins property names with `.`, marks an array's element with
 * `[]` and a discriminated union's variant with its discriminator value: `nodes[].label`, `entries[].edge.from`. An
 * optional or nullable wrapper and a plain union's options share their parent's path.
 */

export type FieldText = ( path: string ) => string | undefined;

/** A raw shape, as registerTool takes it. */
export type InputShape = Record<string, z.ZodTypeAny>;

const join = ( path: string, key: string ): string => ( path === '' ? key : `${ path }.${ key }` );

// A schema of the same kind with one part of its definition replaced; unchanged parts keep their instances.
const rebuilt = <Schema extends z.ZodTypeAny>( schema: Schema, def: Record<string, unknown> ): Schema =>
  new ( schema.constructor as new ( def: unknown ) => Schema )({ ...schema._def, ...def });

function overlayShape( shape: InputShape, path: string, text: FieldText ): InputShape {
  let changed = false;
  const next = Object.fromEntries( Object.entries( shape ).map(([ key, field ]) => {
    const described = overlaySchema( field, join( path, key ), text );
    if ( described !== field ) changed = true;
    return [ key, described ];
  }));
  return changed ? next : shape;
}

// The schema at `path` with every described descendant rebuilt; the schema itself when nothing under it is described.
function overlayInner( schema: z.ZodTypeAny, path: string, text: FieldText ): z.ZodTypeAny {
  if ( schema instanceof z.ZodOptional || schema instanceof z.ZodNullable ){
    const inner = overlayInner( schema._def.innerType as z.ZodTypeAny, path, text );
    return inner === schema._def.innerType ? schema : rebuilt( schema, { innerType: inner });
  }
  if ( schema instanceof z.ZodArray ){
    const element = overlaySchema( schema.element as z.ZodTypeAny, `${ path }[]`, text );
    return element === schema.element ? schema : rebuilt( schema, { type: element });
  }
  if ( schema instanceof z.ZodObject ){
    const shape = schema.shape as InputShape;
    const next = overlayShape( shape, path, text );
    return next === shape ? schema : rebuilt( schema, { shape: () => next });
  }
  if ( schema instanceof z.ZodDiscriminatedUnion ){
    const discriminator = schema.discriminator as string;
    const options = schema.options as z.ZodObject<z.ZodRawShape>[];
    const next = options.map(( option ) => {
      const value = ( option.shape[ discriminator ] as z.ZodLiteral<string> ).value;
      return overlaySchema( option, join( path, value ), text ) as z.ZodObject<z.ZodRawShape>;
    });
    if ( next.every(( option, index ) => option === options[ index ])) return schema;
    const optionsMap = new Map( next.map(( option ) => [ ( option.shape[ discriminator ] as z.ZodLiteral<string> ).value, option ]));
    return rebuilt( schema, { options: next, optionsMap });
  }
  if ( schema instanceof z.ZodUnion ){
    const options = schema.options as z.ZodTypeAny[];
    const next = options.map(( option ) => overlayInner( option, path, text ));
    return next.every(( option, index ) => option === options[ index ]) ? schema : rebuilt( schema, { options: next });
  }
  return schema;
}

function overlaySchema( schema: z.ZodTypeAny, path: string, text: FieldText ): z.ZodTypeAny {
  const inner = overlayInner( schema, path, text );
  const description = path === '' ? undefined : text( path );
  return description === undefined ? inner : inner.describe( description );
}

/** A tool's input schema, raw shape or object, with the served field descriptions written onto it. */
export function describeInput<Input extends InputShape | z.ZodTypeAny>( input: Input, text: FieldText ): Input {
  return ( input instanceof z.ZodType ? overlaySchema( input, '', text ) : overlayShape( input as InputShape, '', text )) as Input;
}
