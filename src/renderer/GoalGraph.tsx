import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type NodeProps,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { Goal, GoalDetail, GoalDetailKind } from '../shared/types';
import './goal-graph.css';

const KIND_LABELS: Record<GoalDetailKind, string> = {
  subgoal: 'Subgoal',
  action: 'Action',
  motivation: 'Why',
  obstacle: 'Obstacle',
  success_criterion: 'Success',
  distraction: 'Distraction',
};

type GraphNodeData = {
  label: string;
  kind: 'root' | GoalDetailKind;
};

type GraphNode = Node<GraphNodeData>;

const NODE_W = 280;
const ROOT_W = 300;

// Estimate rendered text height so dagre reserves enough space (no overlaps).
function estimateHeight(text: string, width: number, root: boolean): number {
  const perLine = Math.max(8, Math.floor((width - 32) / (root ? 9.5 : 8)));
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return Math.max(root ? 112 : 104, 54 + lines * (root ? 25 : 22));
}

function GraphNodeCard({ data }: NodeProps<GraphNode>) {
  const isRoot = data.kind === 'root';
  const caption = isRoot ? 'Goal' : KIND_LABELS[data.kind as GoalDetailKind];
  return (
    <div title={data.label} className={`gg-node gg-node--${data.kind}`} data-testid={`gg-node-${isRoot ? 'root' : data.kind}`}>
      <Handle type="target" position={Position.Left} className="gg-handle" isConnectable={false} />
      <div className="gg-node-caption">
        <span className="gg-dot" aria-hidden="true" />
        {caption}
      </div>
      <div className="gg-node-text">{data.label}</div>
      <Handle type="source" position={Position.Right} className="gg-handle" isConnectable={false} />
    </div>
  );
}

const nodeTypes = { graph: GraphNodeCard };

function buildLayout(goal: Goal, details: GoalDetail[]): { nodes: GraphNode[]; edges: Edge[] } {
  const relevant = details.filter((d) => d.goalId === goal.id);
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];

  const rootH = estimateHeight(goal.title, ROOT_W, true);
  nodes.push({
    id: goal.id,
    type: 'graph',
    position: { x: 0, y: 0 },
    data: { label: goal.title, kind: 'root' },
    style: { width: ROOT_W, height: rootH },
    draggable: true,
    selectable: true,
  });

  if (relevant.length === 0) {
    return { nodes, edges };
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 100, nodesep: 36 });
  g.setDefaultEdgeLabel(() => ({}));
  g.setNode(goal.id, { width: ROOT_W, height: rootH });

  const sizes = new Map<string, number>();
  for (const d of relevant) {
    const h = estimateHeight(d.text, NODE_W, false);
    sizes.set(d.id, h);
    g.setNode(d.id, { width: NODE_W, height: h });
  }
  for (const d of relevant) {
    const parent = d.parentId && relevant.some((x) => x.id === d.parentId) ? d.parentId : goal.id;
    g.setEdge(parent, d.id);
  }
  dagre.layout(g);

  const rootNode = g.node(goal.id);
  nodes[0] = { ...nodes[0], position: { x: rootNode.x - ROOT_W / 2, y: rootNode.y - rootH / 2 } };

  const ids = new Set(relevant.map((d) => d.id));
  for (const d of relevant) {
    const h = sizes.get(d.id) ?? 112;
    const n = g.node(d.id);
    nodes.push({
      id: d.id,
      type: 'graph',
      position: { x: n.x - NODE_W / 2, y: n.y - h / 2 },
      data: { label: d.text, kind: d.kind },
      style: { width: NODE_W, height: h },
      draggable: true,
      selectable: true,
    });
    const parent = d.parentId && ids.has(d.parentId) ? d.parentId : goal.id;
    edges.push({
      id: `e-${parent}-${d.id}`,
      source: parent,
      target: d.id,
      type: 'smoothstep',
      className: 'gg-edge',
    });
  }

  return { nodes, edges };
}

function GoalGraphInner({ goal, details }: { goal: Goal; details: GoalDetail[] }) {
  const layoutKey = useMemo(
    () =>
      goal.id + goal.title +
      '|' +
      details
        .filter((d) => d.goalId === goal.id)
        .map((d) => `${d.id}:${d.parentId ?? ''}:${d.kind}:${d.text}`)
        .join('|'),
    [goal, details]
  );
  const lastIdsKey = useRef('');

  const initial = useMemo(() => buildLayout(goal, details), [goal.id, layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const { fitView } = useReactFlow();

  const refit = useCallback(() => {
    window.setTimeout(() => { void fitView({ padding: 0.18, maxZoom: 1, duration: 250 }); }, 0);
  }, [fitView]);

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout(goal, details);
    const idsKey = n.map((x) => x.id).join(',') + '|' + e.map((edge) => edge.source + ':' + edge.target).join(',');
    const structural = idsKey !== lastIdsKey.current;
    lastIdsKey.current = idsKey;
    setNodes((previous) => structural
      ? n
      : n.map((node) => ({ ...node, position: previous.find((old) => old.id === node.id)?.position ?? node.position })));
    setEdges(e);
    if (structural) refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.id, layoutKey, refit]);

  return (
    <div className="gg-wrap" role="region" aria-label="Goal graph" data-testid="goal-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        panOnDrag
        zoomOnScroll
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--gg-grid)" gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

export default function GoalGraph({ goal, details }: { goal: Goal; details: GoalDetail[] }) {
  return (
    <ReactFlowProvider>
      <GoalGraphInner goal={goal} details={details} />
    </ReactFlowProvider>
  );
}
