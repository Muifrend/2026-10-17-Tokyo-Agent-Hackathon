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
  MarkerType,
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

const EDGE_LABELS: Record<GoalDetailKind, string> = {
  subgoal: 'needs',
  action: 'action',
  motivation: 'why',
  obstacle: 'obstacle',
  success_criterion: 'success',
  distraction: 'distraction',
};

type GraphNodeData = {
  label: string;
  kind: 'root' | GoalDetailKind;
};

type GraphNode = Node<GraphNodeData>;

const NODE_W = 220;
const NODE_H = 72;
const ROOT_W = 240;
const ROOT_H = 90;

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

  nodes.push({
    id: goal.id,
    type: 'graph',
    position: { x: 0, y: 0 },
    data: { label: goal.title, kind: 'root' },
    draggable: true,
    selectable: true,
  });

  if (relevant.length === 0) {
    return { nodes, edges };
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 100, nodesep: 32 });
  g.setDefaultEdgeLabel(() => ({}));
  g.setNode(goal.id,{width:ROOT_W,height:ROOT_H});

  for (const d of relevant) {
    g.setNode(d.id, { width: NODE_W, height: NODE_H });
  }
  for (const d of relevant) {
    const parent = d.parentId && relevant.some((x) => x.id === d.parentId) ? d.parentId : goal.id;
    g.setEdge(parent, d.id);
  }
  dagre.layout(g);

  const rootNode = g.node(goal.id);
  const rootX = rootNode ? rootNode.x - ROOT_W / 2 : 0;
  const rootY = rootNode ? rootNode.y - ROOT_H / 2 : 0;
  nodes[0] = { ...nodes[0], position: { x: rootX, y: rootY } };

  const ids = new Set(relevant.map((d) => d.id));
  for (const d of relevant) {
    const n = g.node(d.id);
    nodes.push({
      id: d.id,
      type: 'graph',
      position: { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 },
      data: { label: d.text, kind: d.kind },
      draggable: true,
      selectable: true,
    });
    const parent = d.parentId && ids.has(d.parentId) ? d.parentId : goal.id;
    edges.push({
      id: `e-${parent}-${d.id}`,
      source: parent,
      target: d.id,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
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

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout(goal, details);
    const idsKey = n.map((x) => x.id).join(',')+'|'+e.map(edge=>edge.source+':'+edge.target).join(',');
    const structural = idsKey !== lastIdsKey.current;
    lastIdsKey.current = idsKey;
    setNodes(previous=>structural?n:n.map(node=>({...node,position:previous.find(old=>old.id===node.id)?.position??node.position})));
    setEdges(e);
    if (structural) {
      window.setTimeout(() => void fitView({ padding: 0.15, duration: 250 }), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.id, layoutKey]);

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
        fitViewOptions={{ padding: 0.15 }}
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
