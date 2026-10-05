import { join } from 'node:path';

import { BLUEPRINT_OVERRIDES_FILENAME } from '@bett3r-dev/blueprint-schema';

/** The extractor's output in a checkout: the graph and diagnostics under .blueprint/, the overrides beside it. */
export type BlueprintPaths = {
  repoPath: string;
  blueprintDir: string;
  graphPath: string;
  diagnosticsPath: string;
  overridesPath: string;
};

export const BLUEPRINT_DIRNAME = '.blueprint';

export function blueprintPaths( repoPath: string ): BlueprintPaths {
  const blueprintDir = join( repoPath, BLUEPRINT_DIRNAME );
  return {
    repoPath,
    blueprintDir,
    graphPath: join( blueprintDir, 'graph.json' ),
    diagnosticsPath: join( blueprintDir, 'diagnostics.json' ),
    overridesPath: join( repoPath, BLUEPRINT_OVERRIDES_FILENAME )
  };
}
