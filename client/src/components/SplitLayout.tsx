import { useState, useRef, useCallback, useEffect } from 'react';
import Terminal from './Terminal';
import type { Agent } from '../api';

// Recursive tree structure for tmux-like splits
export type SplitNode =
  | { type: 'pane'; id: string; agentId: string | null }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number; children: [SplitNode, SplitNode] };

let nodeIdCounter = 1;
function newPaneId() { return `pane-${nodeIdCounter++}`; }

export function createPane(agentId: string | null = null): SplitNode {
  return { type: 'pane', id: newPaneId(), agentId };
}

// Immutable tree helpers
function updateNode(root: SplitNode, targetId: string, updater: (node: SplitNode) => SplitNode): SplitNode {
  if (root.id === targetId) return updater(root);
  if (root.type === 'split') {
    return {
      ...root,
      children: [
        updateNode(root.children[0], targetId, updater),
        updateNode(root.children[1], targetId, updater),
      ] as [SplitNode, SplitNode],
    };
  }
  return root;
}

function replaceNode(root: SplitNode, targetId: string, replacement: SplitNode): SplitNode {
  return updateNode(root, targetId, () => replacement);
}

function removePane(root: SplitNode, targetId: string): SplitNode | null {
  if (root.type === 'pane') {
    return root.id === targetId ? null : root;
  }
  const [a, b] = root.children;
  if (a.id === targetId) return b;
  if (b.id === targetId) return a;
  const newA = removePane(a, targetId);
  const newB = removePane(b, targetId);
  if (newA === null) return b;
  if (newB === null) return a;
  return { ...root, children: [newA, newB] as [SplitNode, SplitNode] };
}

function countPanes(node: SplitNode): number {
  if (node.type === 'pane') return 1;
  return countPanes(node.children[0]) + countPanes(node.children[1]);
}

// --- Components ---

function AgentSelector({ agents, selectedId, onSelect }: {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <select
      value={selectedId || ''}
      onChange={e => onSelect(e.target.value || null)}
      style={{
        background: 'var(--select-bg)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '2px 6px',
        fontSize: 11,
        maxWidth: 140,
      }}
    >
      <option value="">-- Select --</option>
      {agents.map(a => (
        <option key={a.id} value={a.id}>{a.name} ({a.cli})</option>
      ))}
    </select>
  );
}

function Divider({ direction, nodeId, treeRef, onTreeChange, containerRef }: {
  direction: 'horizontal' | 'vertical';
  nodeId: string;
  treeRef: React.RefObject<SplitNode>;
  onTreeChange: (tree: SplitNode) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const isH = direction === 'horizontal';

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let lastPos = isH ? e.clientX : e.clientY;

    const onMouseMove = (e: MouseEvent) => {
      const pos = isH ? e.clientX : e.clientY;
      const delta = pos - lastPos;
      lastPos = pos;

      const container = containerRef.current;
      if (!container || delta === 0) return;
      const size = isH ? container.offsetWidth : container.offsetHeight;
      if (size === 0) return;

      const currentTree = treeRef.current;
      // Find the node and read its current ratio
      const findNode = (n: SplitNode): (SplitNode & { type: 'split' }) | null => {
        if (n.id === nodeId && n.type === 'split') return n;
        if (n.type === 'split') {
          return findNode(n.children[0]) || findNode(n.children[1]);
        }
        return null;
      };
      const splitNode = findNode(currentTree);
      if (!splitNode) return;

      const newRatio = Math.min(80, Math.max(20, splitNode.ratio + (delta / size) * 100));
      const newTree = updateNode(currentTree, nodeId, (n) => ({ ...n, ratio: newRatio } as SplitNode));
      onTreeChange(newTree);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [isH, nodeId, treeRef, onTreeChange, containerRef]);

  return (
    <div
      onMouseDown={onMouseDown}
      className={`split-divider ${isH ? 'split-divider-h' : 'split-divider-v'}`}
    >
      <div className="split-divider-grip">
        {isH ? '⋮' : '⋯'}
      </div>
    </div>
  );
}

interface CommonProps {
  agents: Agent[];
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
  treeRef: React.RefObject<SplitNode>;
  onTreeChange: (tree: SplitNode) => void;
  onStartAgent: (agent: Agent) => void;
  onStopAgent: (agent: Agent) => void;
  activePaneId: string | null;
  setActivePaneId: (id: string) => void;
}

function PaneView({ node, tree, ...props }: CommonProps & { node: SplitNode & { type: 'pane' }; tree: SplitNode }) {
  const { agents, send, wsRef, treeRef, onTreeChange, onStartAgent, onStopAgent, activePaneId, setActivePaneId } = props;
  const agent = agents.find(a => a.id === node.agentId);
  const canClose = countPanes(tree) > 1;
  const isActive = activePaneId === node.id;

  const splitH = () => {
    const newNode: SplitNode = {
      type: 'split', id: newPaneId(), direction: 'horizontal', ratio: 50,
      children: [{ ...node }, createPane()],
    };
    onTreeChange(replaceNode(treeRef.current, node.id, newNode));
  };

  const splitV = () => {
    const newNode: SplitNode = {
      type: 'split', id: newPaneId(), direction: 'vertical', ratio: 50,
      children: [{ ...node }, createPane()],
    };
    onTreeChange(replaceNode(treeRef.current, node.id, newNode));
  };

  const close = () => {
    const result = removePane(treeRef.current, node.id);
    if (result) onTreeChange(result);
  };

  return (
    <div
      onMouseDown={() => setActivePaneId(node.id)}
      style={{
        display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden',
        minWidth: 0, minHeight: 0, maxWidth: '100%', width: '100%',
        border: isActive ? '1.5px solid var(--accent)' : '1.5px solid transparent',
        borderRadius: 2,
        transition: 'border-color 0.15s',
      }}
    >
      <div className="split-pane-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {agent && <span className={`status-dot ${agent.status}`} />}
          <AgentSelector
            agents={agents}
            selectedId={node.agentId}
            onSelect={(id) => onTreeChange(replaceNode(treeRef.current, node.id, { ...node, agentId: id }))}
          />
        </div>
        <div className="pane-actions">
          {agent && agent.status === 'stopped' && (
            <button onClick={() => onStartAgent(agent)} className="btn-start" style={{ fontSize: 10, padding: '2px 8px' }}>Start</button>
          )}
          {agent && agent.status === 'running' && (
            <button onClick={() => onStopAgent(agent)} className="btn-stop" style={{ fontSize: 10, padding: '2px 8px' }}>Stop</button>
          )}
          <button onClick={splitH} title="Split Horizontal" className="pane-action-btn">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="6" y1="1.5" x2="6" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
          <button onClick={splitV} title="Split Vertical" className="pane-action-btn">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="1.5" y1="6" x2="10.5" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M6 2.5L4.5 4.5H7.5L6 2.5Z" fill="currentColor"/>
              <path d="M6 9.5L4.5 7.5H7.5L6 9.5Z" fill="currentColor"/>
            </svg>
          </button>
          {canClose && (
            <button onClick={close} title="Close Pane" className="pane-action-btn pane-action-close-default">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>
      </div>
      {agent && agent.status === 'running' ? (
        <Terminal agentId={agent.id} send={send} wsRef={wsRef} onFocus={() => setActivePaneId(node.id)} />
      ) : (
        <div className="empty-state" style={{ fontSize: 12 }}>
          {agent ? (
            <>
              <span>Agent stopped</span>
              <button className="primary" onClick={() => onStartAgent(agent)} style={{ fontSize: 11 }}>Start</button>
            </>
          ) : (
            <span>Select an agent</span>
          )}
        </div>
      )}
    </div>
  );
}

function NodeView({ node, tree, parentRef, ...props }: CommonProps & {
  node: SplitNode;
  tree: SplitNode;
  parentRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (node.type === 'pane') {
    return <PaneView node={node} tree={tree} {...props} />;
  }

  const isH = node.direction === 'horizontal';
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isH ? 'row' : 'column',
        flex: 1,
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div style={{ [isH ? 'width' : 'height']: `${node.ratio}%`, display: 'flex', overflow: 'hidden', minWidth: 0, minHeight: 0, maxWidth: '100%', position: 'relative', zIndex: 0 }}>
        <NodeView node={node.children[0]} tree={tree} parentRef={containerRef} {...props} />
      </div>
      <Divider
        direction={node.direction}
        nodeId={node.id}
        treeRef={props.treeRef}
        onTreeChange={props.onTreeChange}
        containerRef={containerRef}
      />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0, minHeight: 0, maxWidth: '100%', position: 'relative', zIndex: 0 }}>
        <NodeView node={node.children[1]} tree={tree} parentRef={containerRef} {...props} />
      </div>
    </div>
  );
}

interface SplitLayoutProps {
  agents: Agent[];
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
  tree: SplitNode;
  onTreeChange: (tree: SplitNode) => void;
  onStartAgent: (agent: Agent) => void;
  onStopAgent: (agent: Agent) => void;
}

export default function SplitLayout({ agents, send, wsRef, tree, onTreeChange, onStartAgent, onStopAgent }: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);

  // Keep a ref always pointing to the latest tree so drag handlers read fresh state
  const treeRef = useRef(tree);
  useEffect(() => { treeRef.current = tree; }, [tree]);

  const commonProps: CommonProps = { agents, send, wsRef, treeRef, onTreeChange, onStartAgent, onStopAgent, activePaneId, setActivePaneId };

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <NodeView node={tree} tree={tree} parentRef={containerRef} {...commonProps} />
    </div>
  );
}
