import type { OmoDagGraphNode, OmoDagRun } from "@t3tools/client-runtime/state/omoDag";

export const OMO_DAG_NODE_WIDTH = 220;
export const OMO_DAG_NODE_HEIGHT = 92;

const CANVAS_PADDING = 20;
const COLUMN_GAP = 20;
const WAVE_LABEL_HEIGHT = 24;
const WAVE_GAP = 44;

export interface OmoDagLayoutNode {
  readonly node: OmoDagGraphNode;
  readonly x: number;
  readonly y: number;
  readonly waveIndex: number;
}

export interface OmoDagLayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly path: string;
  readonly critical: boolean;
}

export interface OmoDagLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<OmoDagLayoutNode>;
  readonly waves: ReadonlyArray<{
    readonly index: number;
    readonly y: number;
    readonly nodes: ReadonlyArray<OmoDagLayoutNode>;
  }>;
  readonly edges: ReadonlyArray<OmoDagLayoutEdge>;
}

type LayoutInput = Pick<OmoDagRun, "nodes" | "edges" | "waves" | "criticalPath">;

function fallbackDepths(input: LayoutInput): ReadonlyMap<string, number> {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const parents = new Map<string, Array<string>>();
  for (const node of input.nodes) parents.set(node.id, []);
  for (const edge of input.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue;
    parents.get(edge.to)?.push(edge.from);
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (nodeId: string): number => {
    const existing = depths.get(nodeId);
    if (existing !== undefined) return existing;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const incoming = parents.get(nodeId) ?? [];
    const depth =
      incoming.length === 0 ? 0 : Math.max(...incoming.map((parent) => visit(parent))) + 1;
    visiting.delete(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };
  for (const node of input.nodes) visit(node.id);
  return depths;
}

export function layoutOmoDag(input: LayoutInput): OmoDagLayout {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const assigned = new Set<string>();
  const waveNodeIds = new Map<number, Array<string>>();
  for (const wave of [...input.waves].toSorted((left, right) => left.index - right.index)) {
    const members = waveNodeIds.get(wave.index) ?? [];
    if (!waveNodeIds.has(wave.index)) waveNodeIds.set(wave.index, members);
    for (const nodeId of wave.nodeIds) {
      if (!nodesById.has(nodeId) || assigned.has(nodeId)) continue;
      assigned.add(nodeId);
      members.push(nodeId);
    }
  }
  const depths = fallbackDepths(input);
  for (const node of input.nodes) {
    if (assigned.has(node.id)) continue;
    const waveIndex = depths.get(node.id) ?? 0;
    const members = waveNodeIds.get(waveIndex) ?? [];
    if (!waveNodeIds.has(waveIndex)) waveNodeIds.set(waveIndex, members);
    assigned.add(node.id);
    members.push(node.id);
  }

  const waves = [...waveNodeIds.entries()]
    .filter(([, nodeIds]) => nodeIds.length > 0)
    .toSorted(([left], [right]) => left - right);
  const maxColumns = Math.max(1, ...waves.map(([, nodeIds]) => nodeIds.length));
  const width = Math.max(
    280,
    CANVAS_PADDING * 2 + maxColumns * OMO_DAG_NODE_WIDTH + (maxColumns - 1) * COLUMN_GAP,
  );
  const rowHeight = WAVE_LABEL_HEIGHT + OMO_DAG_NODE_HEIGHT;
  const height =
    CANVAS_PADDING * 2 + waves.length * rowHeight + Math.max(0, waves.length - 1) * WAVE_GAP;
  const laidOutWaves = waves.map(([index, nodeIds], rowIndex) => {
    const y = CANVAS_PADDING + rowIndex * (rowHeight + WAVE_GAP);
    const rowWidth = nodeIds.length * OMO_DAG_NODE_WIDTH + (nodeIds.length - 1) * COLUMN_GAP;
    const startX = (width - rowWidth) / 2;
    const nodes = nodeIds.flatMap((nodeId, columnIndex) => {
      const node = nodesById.get(nodeId);
      if (!node) return [];
      return [
        {
          node,
          x: startX + columnIndex * (OMO_DAG_NODE_WIDTH + COLUMN_GAP),
          y: y + WAVE_LABEL_HEIGHT,
          waveIndex: index,
        },
      ];
    });
    return { index, y, nodes };
  });
  const positions = new Map(
    laidOutWaves.flatMap((wave) => wave.nodes.map((node) => [node.node.id, node] as const)),
  );
  const criticalPath = new Set(input.criticalPath ?? []);
  const seenEdges = new Set<string>();
  const edges = input.edges.flatMap((edge): Array<OmoDagLayoutEdge> => {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    const key = `${edge.from}\0${edge.to}`;
    if (source === undefined || target === undefined || seenEdges.has(key)) return [];
    seenEdges.add(key);
    const sourceX = source.x + OMO_DAG_NODE_WIDTH / 2;
    const sourceY = source.y + OMO_DAG_NODE_HEIGHT;
    const targetX = target.x + OMO_DAG_NODE_WIDTH / 2;
    const targetY = target.y;
    const curve = Math.max(24, Math.abs(targetY - sourceY) / 2);
    return [
      {
        ...edge,
        path: `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY + curve}, ${targetX} ${targetY - curve}, ${targetX} ${targetY}`,
        critical: criticalPath.has(edge.from) && criticalPath.has(edge.to),
      },
    ];
  });
  return {
    width,
    height,
    waves: laidOutWaves,
    nodes: laidOutWaves.flatMap((wave) => wave.nodes),
    edges,
  };
}

export function omoDagLayoutSignature(input: LayoutInput): string {
  return JSON.stringify({
    nodes: input.nodes.map((node) => node.id),
    edges: input.edges,
    waves: input.waves,
  });
}
