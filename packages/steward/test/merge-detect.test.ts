import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs Steward module
import { hostAdapter } from '../lib/merge-detect.mjs';

describe( 'merge-detect newest merged PR', () => {
  it( 'Given two merged PRs for a re-created branch in either order, when Bitbucket finds the merge, then the newest wins', async () => {
    const values = [
      { merge_commit: { hash: 'old' }, updated_on: '2026-01-01T00:00:00Z' },
      { merge_commit: { hash: 'new' }, updated_on: '2026-03-01T00:00:00Z' },
    ];
    for ( const order of [ values, [ ...values ].reverse() ] ) {
      vi.stubGlobal( 'fetch', async () => ( { ok: true, json: async () => ( { values: order } ) } ) );
      const { adapter } = hostAdapter( { repo: '.', remoteUrl: 'git@bitbucket.org:o/r.git', env: { BITBUCKET_TOKEN: 't' } } );
      expect( ( await adapter!.findMerge( 'feat/x', 'main' ) ).mergeSha ).toBe( 'new' );
    }
    vi.unstubAllGlobals();
  } );
} );
