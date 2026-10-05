export const BLUEPRINT_MCP_CAPABILITIES_SCHEMA_VERSION = 1;

export const BLUEPRINT_MCP_CAPABILITIES = {
  schemaVersion: BLUEPRINT_MCP_CAPABILITIES_SCHEMA_VERSION,
  families: {
    design: [
      'comment',
      'get_design',
      'get_flow',
      'modify',
      'propose',
      'reclassify',
      'remove',
      'resolve',
      'undo'
    ],
    map: [
      'get_card',
      'get_coverage',
      'get_map',
      'get_map_links',
      'map_choose',
      'map_cover',
      'map_ground',
      'map_link',
      'map_modify_observation',
      'map_modify_scenario',
      'map_post',
      'map_propose_observation',
      'map_propose_scenario',
      'map_strike',
      'map_uncover',
      'map_undo',
      'map_unlink'
    ],
    // The design spec: get_spec reads it, spec_post and spec_strike write it.
    spec: [
      'get_spec',
      'spec_post',
      'spec_strike'
    ]
  }
} as const;

export const UNFAMILIED_TOOLS = [
  'get_marks',
  'kpi_lookup',
  'mark_synced',
  'read_changes',
  'status'
] as const;

export type VerbFamily = keyof typeof BLUEPRINT_MCP_CAPABILITIES.families;

export type CapabilitiesAdvertisement = {
  schemaVersion: number;
  verbFamilies: VerbFamily[];
};

export function capabilitiesAdvertisement(): CapabilitiesAdvertisement {
  const verbFamilies = ( Object.keys( BLUEPRINT_MCP_CAPABILITIES.families ) as VerbFamily[] ).sort();
  return { schemaVersion: BLUEPRINT_MCP_CAPABILITIES.schemaVersion, verbFamilies };
}
