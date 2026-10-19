import { defineConfig } from 'vitest/config';

// Epic goal oracles: run alone and on demand (they need a blueprint checkout and pv3), never in `npm test`.
export default defineConfig( {
  test: {
    include: [ 'packages/*/oracles/**/*.oracle.test.ts' ],
  },
} );
