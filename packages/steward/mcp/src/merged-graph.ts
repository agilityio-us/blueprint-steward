import { readFile, stat } from 'node:fs/promises';

import {
  applyDesign,
  applyOverrides,
  emptyDiagnostics,
  emptyOverrides,
  type DesignFile,
  type Diagnostics,
  type BlueprintGraph,
  type BlueprintOverrides,
  type RottedHandlerScope,
  type StrandingReport
} from '@bett3r-dev/blueprint-schema';
import { BlueprintMcpError } from './errors.js';
import type { BlueprintPaths } from './paths.js';

export type MergedGraph = {
  graph: BlueprintGraph;
  design: DesignFile;
  designError?: string;
  handlerScopeRejections?: RottedHandlerScope[];
  strandedProposals?: StrandingReport;
};

async function readJsonFile( filePath: string ): Promise<unknown | undefined> {
  try {
    return JSON.parse( await readFile( filePath, 'utf-8' )) as unknown;
  } catch ( cause ){
    if (( cause as NodeJS.ErrnoException ).code === 'ENOENT' ) return undefined;
    throw cause;
  }
}

function isSchemaVersion1( parsed: unknown ): boolean {
  return parsed !== null
    && typeof parsed === 'object'
    && ( parsed as { schemaVersion?: unknown } ).schemaVersion === 1;
}

export async function assertBlueprintDir( paths: BlueprintPaths ): Promise<void> {
  const missing = ( detail: string ): BlueprintMcpError => new BlueprintMcpError(
    'BLUEPRINT_DIR_MISSING',
    `no .blueprint directory at ${ paths.blueprintDir } — run the extractor in this checkout first`,
    { blueprintDir: paths.blueprintDir, detail }
  );
  try {
    if ( !( await stat( paths.blueprintDir )).isDirectory() ) throw missing( 'not-a-directory' );
  } catch ( cause ){
    if ( cause instanceof BlueprintMcpError ) throw cause;
    throw missing( String(( cause as NodeJS.ErrnoException ).code ));
  }
}

async function readGraph( paths: BlueprintPaths ): Promise<BlueprintGraph> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile( paths.graphPath );
  } catch ( cause ){
    throw new BlueprintMcpError(
      'GRAPH_UNREADABLE',
      `${ paths.graphPath } exists but could not be parsed; retry once the extractor has finished writing`,
      { graphPath: paths.graphPath, message: ( cause as Error ).message }
    );
  }
  if ( parsed === undefined ){
    throw new BlueprintMcpError(
      'GRAPH_MISSING',
      `no ${ paths.graphPath } — run the BLUEPRINT extractor in this checkout before reading flows`,
      { graphPath: paths.graphPath }
    );
  }
  if ( !isSchemaVersion1( parsed )){
    throw new BlueprintMcpError(
      'GRAPH_UNREADABLE',
      `${ paths.graphPath } is not an BLUEPRINT graph at schemaVersion 1`,
      { graphPath: paths.graphPath }
    );
  }
  return parsed as BlueprintGraph;
}

async function readOverrides( paths: BlueprintPaths ): Promise<BlueprintOverrides> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile( paths.overridesPath );
  } catch ( cause ){
    throw new BlueprintMcpError(
      'OVERRIDES_UNREADABLE',
      `${ paths.overridesPath } exists but could not be parsed; fix it before reading flows`,
      { overridesPath: paths.overridesPath, message: ( cause as Error ).message }
    );
  }
  if ( parsed === undefined ) return emptyOverrides();
  if ( !isSchemaVersion1( parsed )){
    throw new BlueprintMcpError(
      'OVERRIDES_UNREADABLE',
      `${ paths.overridesPath } is not an overrides document at schemaVersion 1`,
      { overridesPath: paths.overridesPath }
    );
  }
  return parsed as BlueprintOverrides;
}

async function readDiagnostics( paths: BlueprintPaths ): Promise<Diagnostics> {
  const parsed = await readJsonFile( paths.diagnosticsPath ).catch( () => undefined );
  const candidate = parsed as Partial<Diagnostics> | undefined | null;
  return Array.isArray( candidate?.unresolvedEdges ) && Array.isArray( candidate?.topologyViolations )
    ? { ...emptyDiagnostics(), ...candidate }
    : emptyDiagnostics();
}

/** The session's design, read from the server; the checkout holds none. */
export type DesignReader = () => Promise<DesignFile>;

// A design that cannot be read leaves the extracted graph and overrides to stand alone, reported as designError.
async function readSessionDesign(
  reader: DesignReader
): Promise<{ design: DesignFile | undefined; error?: string }> {
  try {
    return { design: await reader() };
  } catch ( cause ){
    const message = cause instanceof Error ? cause.message : String( cause );
    return { design: undefined, error: `the session's design could not be read (${ message }) — reading extracted + overrides only` };
  }
}

/** The checkout's graph, overrides and diagnostics, with the session's design applied on top. */
export async function readMergedGraph( paths: BlueprintPaths, designReader: DesignReader ): Promise<MergedGraph> {
  await assertBlueprintDir( paths );

  const [ graph, overrides, diagnostics, designLoad ] = await Promise.all( [
    readGraph( paths ),
    readOverrides( paths ),
    readDiagnostics( paths ),
    readSessionDesign( designReader )
  ] );

  const withOverrides = applyOverrides( graph, diagnostics, overrides );
  const withDesign = applyDesign( withOverrides.graph, designLoad.design );

  return {
    graph: withDesign.graph,
    design: designLoad.design ?? { schemaVersion: 1 },
    ...( designLoad.error !== undefined ? { designError: designLoad.error } : {}),
    ...( withDesign.handlerScopeRejections.length > 0
      ? { handlerScopeRejections: withDesign.handlerScopeRejections }
      : {}),
    ...( withDesign.strandedProposals.frontier.length > 0
      || withDesign.strandedProposals.downstream.length > 0
      ? { strandedProposals: withDesign.strandedProposals }
      : {})
  };
}
