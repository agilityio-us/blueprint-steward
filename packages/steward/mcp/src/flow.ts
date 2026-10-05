import {
  buildFlowIndex,
  isEdgeInFlow,
  traverseFlow,
  type CrossSubdomainMode,
  type DesignStatus,
  type EdgeKind,
  type BlueprintGraph,
  type BlueprintNode,
  type NodeType,
  type Origin
} from '@bett3r-dev/blueprint-schema';

import { BlueprintMcpError } from './errors.js';

export type FlowBoundary = 'subdomain' | 'end-to-end';

export type FlowScope = {
  boundary?: FlowBoundary;
  subdomains?: string[];
};

export type FlowNodeView = {
  id: string;
  type: NodeType;
  label: string;
  subdomain: string;
  row: number;
  foreign?: true;
  resourceKey?: string;
  queries?: string[];
  origin?: Origin;
  status?: DesignStatus;
  previousLabel?: string;
  note?: string;
};

export type FlowEdgeView = {
  from: string;
  to: string;
  kind: EdgeKind;
  via?: string;
  handlers?: string[];
  origin?: Origin;
  status?: DesignStatus;
  note?: string;
};

export type FlowView = {
  rootCommand: string;
  scope: { boundary: FlowBoundary; subdomains: string[] };
  stats: { nodes: number; edges: number; foreign: number };
  nodes: FlowNodeView[];
  edges: FlowEdgeView[];
};

const CROSS_SUBDOMAIN_MODE: Record<FlowBoundary, CrossSubdomainMode> = {
  'end-to-end': 'full',
  'subdomain': 'leaf'
};

const edgeKey = ( edge: { from: string; to: string; kind: EdgeKind }): string =>
  `${ edge.from }|${ edge.to }|${ edge.kind }`;

function toNodeView( node: BlueprintNode, row: number, foreign: boolean ): FlowNodeView {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    subdomain: node.subdomain,
    row,
    ...( foreign ? { foreign: true as const } : {}),
    ...( node.resourceKey !== undefined ? { resourceKey: node.resourceKey } : {}),
    ...( node.queries !== undefined ? { queries: node.queries.map( query => query.route ) } : {}),
    ...( node.origin !== undefined && node.origin !== 'extracted' ? { origin: node.origin } : {}),
    ...( node.status !== undefined ? { status: node.status } : {}),
    ...( node.previousLabel !== undefined ? { previousLabel: node.previousLabel } : {}),
    ...( node.note !== undefined ? { note: node.note } : {})
  };
}

export function flowView(
  graph: BlueprintGraph,
  rootCommand: string,
  scope: FlowScope = {}
): FlowView {
  const boundary: FlowBoundary = scope.boundary ?? 'end-to-end';

  if ( boundary === 'end-to-end' && scope.subdomains !== undefined ){
    throw new BlueprintMcpError(
      'INVALID_SCOPE',
      'scope.subdomains bounds a \'subdomain\' boundary; it means nothing end-to-end. '
        + 'Use { boundary: \'subdomain\', subdomains: [ … ] }, or drop subdomains.',
      { boundary, subdomains: scope.subdomains }
    );
  }

  const index = buildFlowIndex( graph );

  const rootNode = index.nodesById.get( rootCommand );
  if ( !rootNode ){
    throw new BlueprintMcpError(
      'ROOT_NOT_FOUND',
      `no node ${ rootCommand } in the merged graph`,
      { rootCommand }
    );
  }
  if ( rootNode.type !== 'command' ){
    throw new BlueprintMcpError(
      'ROOT_NOT_COMMAND',
      `${ rootCommand } is a '${ rootNode.type }', and a flow is rooted at a command`,
      { rootCommand, actualType: rootNode.type }
    );
  }

  const subdomains = scope.subdomains ?? [ rootNode.subdomain ];
  const home = new Set( subdomains );

  const depth = traverseFlow( index, {
    rootId: rootCommand,
    homeSubdomains: subdomains,
    crossSubdomainMode: CROSS_SUBDOMAIN_MODE[ boundary ]
  });

  const nodes: FlowNodeView[] = [ ...depth ]
    .sort(( a, b ) => a[ 1 ] - b[ 1 ] || a[ 0 ].localeCompare( b[ 0 ], 'en' ))
    .map(([ id, row ]) => {
      const node = index.nodesById.get( id )!;
      return toNodeView( node, row, !home.has( node.subdomain ));
    });

  const positionByKey = new Map<string, number>();
  const edges: FlowEdgeView[] = [];
  for ( const edge of graph.edges ){
    if ( !isEdgeInFlow( edge, depth )) continue;
    const key = edgeKey( edge );

    const existing = positionByKey.get( key );
    if ( existing !== undefined ){
      const reported = edges[ existing ]!;
      if ( reported.handlers === undefined ) continue;
      if ( edge.handlers === undefined || edge.handlers.length === 0 ){
        delete reported.handlers;
        continue;
      }
      for ( const handlerId of edge.handlers ){
        if ( !reported.handlers.includes( handlerId )) reported.handlers.push( handlerId );
      }
      continue;
    }

    positionByKey.set( key, edges.length );
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...( edge.via !== undefined ? { via: edge.via } : {}),
      ...( edge.handlers !== undefined && edge.handlers.length > 0
        ? { handlers: [ ...edge.handlers ] }
        : {}),
      ...( edge.origin !== undefined && edge.origin !== 'extracted' ? { origin: edge.origin } : {}),
      ...( edge.status !== undefined ? { status: edge.status } : {}),
      ...( edge.note !== undefined ? { note: edge.note } : {})
    });
  }

  return {
    rootCommand,
    scope: { boundary, subdomains },
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      foreign: nodes.filter( node => node.foreign === true ).length
    },
    nodes,
    edges
  };
}
