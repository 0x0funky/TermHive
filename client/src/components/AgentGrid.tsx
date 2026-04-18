/**
 * AgentGrid — the multi-agent terminal dashboard.
 *
 * Five layout modes:
 *  - single: one pane
 *  - 2up / 3up: horizontal row with draggable reorder + resize dividers
 *  - grid: recursive split tree (tmux-style) — per-pane split/close controls,
 *    drag-to-swap between any two leaves, resize dividers at every split
 *  - canvas: free-form, each card is absolutely positioned with 8-way resize
 *    handles; positions persist per project.
 *
 * Each pane wraps the real xterm Terminal component so WebSocket I/O is live.
 */

import { useState, useEffect, useRef, Fragment } from 'react';
import Terminal from './Terminal';
import Ic from './Icons';
import { agentHue, agentInitials } from '../utils/agentIdentity';
import type { Agent } from '../api';

export type GridLayout = 'single' | '2up' | '3up' | 'grid' | 'canvas';

// ---- Split tree model (for grid layout) --------------------------------

type TreeNode =
  | { kind: 'leaf'; id: string }
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; a: TreeNode; b: TreeNode };

function validateTree(t: TreeNode | null, ids: Set<string>): boolean {
  if (!t) return false;
  const walk = (n: TreeNode): boolean => {
    if (n.kind === 'leaf') return ids.has(n.id);
    return n.kind === 'split' && walk(n.a) && walk(n.b);
  };
  return walk(t);
}
function leafIds(t: TreeNode | null): string[] {
  if (!t) return [];
  if (t.kind === 'leaf') return [t.id];
  return [...leafIds(t.a), ...leafIds(t.b)];
}
function splitLeaf(tree: TreeNode, leafId: string, dir: 'h' | 'v', newAgentId: string): TreeNode {
  const walk = (n: TreeNode): TreeNode => {
    if (n.kind === 'leaf') {
      if (n.id === leafId) {
        return {
          kind: 'split', dir, ratio: 0.5,
          a: { kind: 'leaf', id: leafId },
          b: { kind: 'leaf', id: newAgentId },
        };
      }
      return n;
    }
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(tree);
}
function removeLeaf(tree: TreeNode, leafId: string): TreeNode | null {
  if (tree.kind === 'leaf') return tree.id === leafId ? null : tree;
  const a = removeLeaf(tree.a, leafId);
  const b = removeLeaf(tree.b, leafId);
  if (!a) return b;
  if (!b) return a;
  return { ...tree, a, b };
}
function swapLeaves(tree: TreeNode, idA: string, idB: string): TreeNode {
  if (idA === idB) return tree;
  const walk = (n: TreeNode): TreeNode => {
    if (n.kind === 'leaf') {
      if (n.id === idA) return { ...n, id: idB };
      if (n.id === idB) return { ...n, id: idA };
      return n;
    }
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(tree);
}
function updateRatio(tree: TreeNode, path: ('a' | 'b')[], ratio: number): TreeNode {
  const walk = (n: TreeNode, depth: number): TreeNode => {
    if (depth === path.length) return { ...(n as Exclude<TreeNode, { kind: 'leaf' }>), ratio };
    const side = path[depth];
    const next = walk((n as Exclude<TreeNode, { kind: 'leaf' }>)[side], depth + 1);
    return { ...(n as Exclude<TreeNode, { kind: 'leaf' }>), [side]: next };
  };
  return walk(tree, 0);
}

function buildTiledTree(agents: Agent[], dir: 'h' | 'v' = 'h'): TreeNode | null {
  if (agents.length === 0) return null;
  if (agents.length === 1) return { kind: 'leaf', id: agents[0].id };
  const mid = Math.ceil(agents.length / 2);
  return {
    kind: 'split', dir, ratio: mid / agents.length,
    a: buildTiledTree(agents.slice(0, mid), dir === 'h' ? 'v' : 'h')!,
    b: buildTiledTree(agents.slice(mid), dir === 'h' ? 'v' : 'h')!,
  };
}

// ---- Shared subcomponents ----------------------------------------------

interface AgentPaneProps {
  agent: Agent;
  focused: boolean;
  onFocus: () => void;
  onStart: (a: Agent) => void;
  onStop: (a: Agent) => void;
  onRestart: (a: Agent) => void;
  onDelete: (a: Agent) => void;
  dragHandlers?: {
    draggable?: boolean;
    onDragStart?: (e: React.DragEvent) => void;
    onDragOver?: (e: React.DragEvent) => void;
    onDragLeave?: () => void;
    onDrop?: (e: React.DragEvent) => void;
    onDragEnd?: () => void;
  };
  headMouseDown?: (e: React.MouseEvent) => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
}

function AgentPane({
  agent, focused, onFocus,
  onStart, onStop, onRestart, onDelete,
  dragHandlers, headMouseDown, isDragging, isDragOver,
  send, wsRef,
}: AgentPaneProps) {
  const hue = agentHue(agent.name);
  const initials = agentInitials(agent.name);
  const cls = ['pane'];
  if (focused) cls.push('focused');
  if (isDragging) cls.push('dragging');
  if (isDragOver) cls.push('drag-over');

  const isRunning = agent.status === 'running';

  return (
    <div
      className={cls.join(' ')}
      onClick={onFocus}
      onDragOver={dragHandlers?.onDragOver}
      onDragLeave={dragHandlers?.onDragLeave}
      onDrop={dragHandlers?.onDrop}
      onDragEnd={dragHandlers?.onDragEnd}
    >
      <div
        className="pane-head"
        draggable={dragHandlers?.onDragStart ? true : undefined}
        onDragStart={dragHandlers?.onDragStart}
        onMouseDown={headMouseDown}
      >
        <span className="pane-drag" title="Drag"><Ic.dots size={12} /></span>
        <div className="pane-head-l">
          <div className="pane-agent">
            <div className="pane-agent-avatar" style={{ background: hue }}>{initials}</div>
            <div className="pane-agent-info">
              <div className="pane-agent-row">
                <span className="pane-agent-name">{agent.name}</span>
                {agent.role && <span className="pane-agent-role">{agent.role}</span>}
              </div>
              <div className="pane-agent-cwd">
                {agent.cli} · {agent.cwd}
              </div>
            </div>
          </div>
          <span className={'pane-status-chip ' + agent.status}>
            <span className={'sdot ' + agent.status} style={{ width: 6, height: 6 }} />
            {agent.status}
          </span>
        </div>
        <div className="pane-head-r">
          <div style={{ display: 'flex', gap: 2 }}>
            {isRunning ? (
              <button className="pane-btn" title="Stop" onClick={(e) => { e.stopPropagation(); onStop(agent); }}><Ic.stop size={9} /></button>
            ) : (
              <button className="pane-btn" title="Start" onClick={(e) => { e.stopPropagation(); onStart(agent); }}><Ic.play size={10} /></button>
            )}
            <button className="pane-btn" title="Restart" onClick={(e) => { e.stopPropagation(); onRestart(agent); }}><Ic.restart size={12} /></button>
            <button className="pane-btn danger" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(agent); }}><Ic.x size={12} /></button>
          </div>
        </div>
      </div>

      <div className="pane-body">
        {isRunning ? (
          <Terminal
            agentId={agent.id}
            send={send}
            wsRef={wsRef}
            onFocus={onFocus}
            focused={focused}
          />
        ) : (
          <div className="pane-stopped">
            <div className="label">agent stopped</div>
            <div className="meta">{agent.cli} · {agent.cwd}</div>
            <button className="batch-btn primary" onClick={(e) => { e.stopPropagation(); onStart(agent); }}>
              <Ic.play size={10} /> Start agent
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Resizer({ onDrag }: { onDrag: (dx: number, dy: number) => void }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => onDrag(ev.movementX, ev.movementY);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
  };
  return (
    <div className="pane-resizer" onMouseDown={onMouseDown}>
      <div className="pane-resizer-grip" />
    </div>
  );
}

interface DraggableRowProps {
  items: Agent[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  sizes?: number[];
  onResize?: (i: number, dx: number) => void;
  onStart: (a: Agent) => void;
  onStop: (a: Agent) => void;
  onRestart: (a: Agent) => void;
  onDelete: (a: Agent) => void;
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
  rowRef?: React.RefObject<HTMLDivElement>;
}

function DraggableRow({
  items, focusedId, onFocus, onReorder, sizes, onResize,
  onStart, onStop, onRestart, onDelete, send, wsRef,
}: DraggableRowProps) {
  const [dragIx, setDragIx] = useState<number | null>(null);
  const [overIx, setOverIx] = useState<number | null>(null);

  return (
    <>
      {items.map((a, i) => {
        const handlers = {
          onDragStart: (e: React.DragEvent) => {
            setDragIx(i);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
          },
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overIx !== i) setOverIx(i);
          },
          onDragLeave: () => { if (overIx === i) setOverIx(null); },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            if (dragIx != null && dragIx !== i) onReorder(dragIx, i);
            setDragIx(null); setOverIx(null);
          },
          onDragEnd: () => { setDragIx(null); setOverIx(null); },
        };
        const basis = sizes ? sizes[i] : undefined;
        return (
          <Fragment key={a.id}>
            <div className="pane-wrap" style={basis != null ? { flex: `${basis} 1 0` } : undefined}>
              <AgentPane
                agent={a}
                focused={a.id === focusedId}
                onFocus={() => onFocus(a.id)}
                onStart={onStart}
                onStop={onStop}
                onRestart={onRestart}
                onDelete={onDelete}
                dragHandlers={handlers}
                isDragging={dragIx === i}
                isDragOver={overIx === i && dragIx !== i}
                send={send}
                wsRef={wsRef}
              />
            </div>
            {onResize && i < items.length - 1 && (
              <Resizer onDrag={(dx) => onResize(i, dx)} />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// ---- Grid (tmux-style recursive splits) --------------------------------

interface TmuxNodeProps {
  node: TreeNode;
  agents: Agent[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  onSplit: (leafId: string, dir: 'h' | 'v') => void;
  onClose: (leafId: string) => void;
  onRatio: (path: ('a' | 'b')[], ratio: number) => void;
  onSwap: (idA: string, idB: string) => void;
  dragState: { dragId: string | null; overId: string | null };
  setDragState: React.Dispatch<React.SetStateAction<{ dragId: string | null; overId: string | null }>>;
  path?: ('a' | 'b')[];
  onStart: (a: Agent) => void;
  onStop: (a: Agent) => void;
  onRestart: (a: Agent) => void;
  onDelete: (a: Agent) => void;
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
}

function TmuxNode({
  node, agents, focusedId, onFocus,
  onSplit, onClose, onRatio, onSwap,
  dragState, setDragState, path = [],
  onStart, onStop, onRestart, onDelete, send, wsRef,
}: TmuxNodeProps): JSX.Element | null {
  if (node.kind === 'leaf') {
    const agent = agents.find(a => a.id === node.id);
    if (!agent) return null;
    const isDragging = dragState.dragId === node.id;
    const isDropTarget = dragState.overId === node.id && dragState.dragId != null && dragState.dragId !== node.id;
    const leafCls = ['tmux-leaf'];
    if (isDragging) leafCls.push('is-dragging');
    if (isDropTarget) leafCls.push('is-drop-target');
    if (agent.id === focusedId) leafCls.push('is-focused');
    return (
      <div
        className={leafCls.join(' ')}
        onDragOver={(e) => {
          if (!dragState.dragId || dragState.dragId === node.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragState.overId !== node.id) setDragState(s => ({ ...s, overId: node.id }));
        }}
        onDragLeave={(e) => {
          const rel = e.relatedTarget as Node | null;
          if (rel && e.currentTarget.contains(rel)) return;
          if (dragState.overId === node.id) setDragState(s => ({ ...s, overId: null }));
        }}
        onDrop={(e) => {
          e.preventDefault();
          const src = dragState.dragId;
          if (src && src !== node.id) onSwap(src, node.id);
          setDragState({ dragId: null, overId: null });
        }}
      >
        <AgentPane
          agent={agent}
          focused={agent.id === focusedId}
          onFocus={() => onFocus(agent.id)}
          onStart={onStart}
          onStop={onStop}
          onRestart={onRestart}
          onDelete={onDelete}
          dragHandlers={{
            onDragStart: (e) => {
              e.dataTransfer.effectAllowed = 'move';
              try { e.dataTransfer.setData('text/plain', (node as { kind: 'leaf'; id: string }).id); } catch { /* ignore */ }
              setDragState({ dragId: (node as { kind: 'leaf'; id: string }).id, overId: null });
            },
            onDragEnd: () => setDragState({ dragId: null, overId: null }),
          }}
          send={send}
          wsRef={wsRef}
        />
        <div className="tmux-pane-ctrls">
          <button className="pane-btn" title="Split right" onClick={(e) => { e.stopPropagation(); onSplit((node as { kind: 'leaf'; id: string }).id, 'h'); }}>
            <Ic.splitH size={11} />
          </button>
          <button className="pane-btn" title="Split down" onClick={(e) => { e.stopPropagation(); onSplit((node as { kind: 'leaf'; id: string }).id, 'v'); }}>
            <Ic.splitV size={11} />
          </button>
          <button className="pane-btn danger" title="Close pane" onClick={(e) => { e.stopPropagation(); onClose((node as { kind: 'leaf'; id: string }).id); }}>
            <Ic.x size={10} />
          </button>
        </div>
      </div>
    );
  }

  const isH = node.dir === 'h';
  const styleA = isH ? { width: (node.ratio * 100) + '%' } : { height: (node.ratio * 100) + '%' };
  const styleB = isH ? { width: ((1 - node.ratio) * 100) + '%' } : { height: ((1 - node.ratio) * 100) + '%' };

  const onResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const containerEl = (e.currentTarget as HTMLElement).parentElement;
    if (!containerEl) return;
    const rect0 = containerEl.getBoundingClientRect();
    const size0 = isH ? rect0.width : rect0.height;
    let accPx = 0;
    const startRatio = node.ratio;
    const move = (ev: MouseEvent) => {
      accPx += isH ? ev.movementX : ev.movementY;
      const ratio = Math.max(0.1, Math.min(0.9, startRatio + accPx / size0));
      onRatio(path, ratio);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
  };

  return (
    <div className={'tmux-split ' + (isH ? 'horiz' : 'vert')}>
      <div className="tmux-side" style={styleA}>
        <TmuxNode node={node.a} agents={agents} focusedId={focusedId} onFocus={onFocus}
          onSplit={onSplit} onClose={onClose} onRatio={onRatio}
          onSwap={onSwap} dragState={dragState} setDragState={setDragState}
          path={[...path, 'a']}
          onStart={onStart} onStop={onStop} onRestart={onRestart} onDelete={onDelete}
          send={send} wsRef={wsRef} />
      </div>
      <div className={'tmux-divider ' + (isH ? 'vert' : 'horiz')} onMouseDown={onResizeDown} />
      <div className="tmux-side" style={styleB}>
        <TmuxNode node={node.b} agents={agents} focusedId={focusedId} onFocus={onFocus}
          onSplit={onSplit} onClose={onClose} onRatio={onRatio}
          onSwap={onSwap} dragState={dragState} setDragState={setDragState}
          path={[...path, 'b']}
          onStart={onStart} onStop={onStop} onRestart={onRestart} onDelete={onDelete}
          send={send} wsRef={wsRef} />
      </div>
    </div>
  );
}

function GridTmuxLayout({
  agents, focusedId, onFocus, projectId,
  onStart, onStop, onRestart, onDelete, send, wsRef,
}: {
  agents: Agent[]; focusedId: string | null; onFocus: (id: string) => void; projectId: string;
  onStart: (a: Agent) => void; onStop: (a: Agent) => void;
  onRestart: (a: Agent) => void; onDelete: (a: Agent) => void;
  send: (msg: object) => void; wsRef: React.RefObject<WebSocket | null>;
}) {
  const storageKey = `termhive:tmux-tree:${projectId}`;
  const idSet = new Set(agents.map(a => a.id));

  const [tree, setTree] = useState<TreeNode | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as TreeNode;
        if (validateTree(parsed, idSet)) return parsed;
      }
    } catch { /* ignore */ }
    return buildTiledTree(agents);
  });

  // Keep tree aligned with current agent set. Drop missing leaves, add new ones as splits.
  useEffect(() => {
    setTree(prev => {
      if (!prev) return buildTiledTree(agents);
      // Remove leaves for agents no longer present
      let t: TreeNode | null = prev;
      for (const id of leafIds(prev)) {
        if (!idSet.has(id)) {
          t = t ? removeLeaf(t, id) : null;
        }
      }
      if (!t) return buildTiledTree(agents);
      // Add new agents as splits on the first leaf
      const existingLeaves = new Set(leafIds(t));
      for (const a of agents) {
        if (!existingLeaves.has(a.id)) {
          const anchor = leafIds(t)[0];
          if (anchor) t = splitLeaf(t, anchor, leafIds(t).length % 2 === 0 ? 'v' : 'h', a.id);
          else t = { kind: 'leaf', id: a.id };
        }
      }
      return t;
    });
  }, [agents.map(a => a.id).join(',')]);

  useEffect(() => {
    try {
      if (tree) localStorage.setItem(storageKey, JSON.stringify(tree));
      else localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }, [tree, storageKey]);

  const [dragState, setDragState] = useState<{ dragId: string | null; overId: string | null }>({ dragId: null, overId: null });

  const used = new Set(leafIds(tree));
  const available = agents.filter(a => !used.has(a.id));

  const onSplit = (leafId: string, dir: 'h' | 'v') => {
    const next = available[0] || agents.find(a => a.id !== leafId) || agents[0];
    if (!next) return;
    setTree(t => (t ? splitLeaf(t, leafId, dir, next.id) : t));
  };
  const onClose = (leafId: string) => setTree(t => (t ? removeLeaf(t, leafId) : t));
  const onRatioCh = (path: ('a' | 'b')[], ratio: number) => setTree(t => (t ? updateRatio(t, path, ratio) : t));
  const onSwap = (idA: string, idB: string) => setTree(t => (t ? swapLeaves(t, idA, idB) : t));

  if (!tree) {
    return (
      <div className="gr-body layout-grid empty">
        <div className="tmux-empty">
          <div className="tmux-empty-title">No panes</div>
          <div className="tmux-empty-sub">Add an agent to start</div>
        </div>
      </div>
    );
  }

  return (
    <div className="gr-body layout-grid">
      <TmuxNode
        node={tree}
        agents={agents}
        focusedId={focusedId}
        onFocus={onFocus}
        onSplit={onSplit}
        onClose={onClose}
        onRatio={onRatioCh}
        onSwap={onSwap}
        dragState={dragState}
        setDragState={setDragState}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
        onDelete={onDelete}
        send={send}
        wsRef={wsRef}
      />
    </div>
  );
}

// ---- Canvas (free-form) ------------------------------------------------

interface Rect { x: number; y: number; w: number; h: number; z: number }

function CanvasLayout({
  agents, focusedId, onFocus, projectId,
  onStart, onStop, onRestart, onDelete, send, wsRef,
}: {
  agents: Agent[]; focusedId: string | null; onFocus: (id: string) => void; projectId: string;
  onStart: (a: Agent) => void; onStop: (a: Agent) => void;
  onRestart: (a: Agent) => void; onDelete: (a: Agent) => void;
  send: (msg: object) => void; wsRef: React.RefObject<WebSocket | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const storageKey = `termhive:canvas:${projectId}`;

  const initRects = (): Record<string, Rect> => {
    try {
      const s = localStorage.getItem(storageKey);
      if (s) return JSON.parse(s);
    } catch { /* ignore */ }
    const rects: Record<string, Rect> = {};
    agents.forEach((a, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      rects[a.id] = { x: 20 + col * 520, y: 60 + row * 360, w: 500, h: 340, z: i + 1 };
    });
    return rects;
  };

  const [rects, setRects] = useState<Record<string, Rect>>(initRects);
  const [zTop, setZTop] = useState<number>(() => agents.length + 1);

  // Sync rects with current agent set (add missing, drop gone)
  useEffect(() => {
    setRects(prev => {
      const next: Record<string, Rect> = { ...prev };
      let z = zTop;
      agents.forEach((a, i) => {
        if (!next[a.id]) {
          const col = i % 2;
          const row = Math.floor(i / 2);
          z += 1;
          next[a.id] = { x: 20 + col * 520, y: 60 + row * 360, w: 500, h: 340, z };
        }
      });
      // Drop agents that no longer exist
      const ids = new Set(agents.map(a => a.id));
      for (const key of Object.keys(next)) {
        if (!ids.has(key)) delete next[key];
      }
      if (z !== zTop) setZTop(z);
      return next;
    });
  }, [agents.map(a => a.id).join(',')]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(rects)); } catch { /* ignore */ }
  }, [rects, storageKey]);

  const bringFront = (id: string) => {
    setZTop(z => {
      const nz = z + 1;
      setRects(r => (r[id] ? { ...r, [id]: { ...r[id], z: nz } } : r));
      return nz;
    });
  };

  const startDrag = (id: string) => (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.pane-btn') || target.closest('input')) return;
    e.preventDefault();
    bringFront(id);
    const move = (ev: MouseEvent) => {
      setRects(prev => {
        const cur = prev[id];
        if (!cur) return prev;
        return {
          ...prev,
          [id]: { ...cur, x: Math.max(0, cur.x + ev.movementX), y: Math.max(0, cur.y + ev.movementY) },
        };
      });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'grabbing';
  };

  const startResize = (id: string, dir: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    bringFront(id);
    const MIN_W = 280, MIN_H = 200;
    const move = (ev: MouseEvent) => {
      const dx = ev.movementX, dy = ev.movementY;
      setRects(prev => {
        const cur = prev[id];
        if (!cur) return prev;
        const r = { ...cur };
        if (dir.includes('e')) r.w = Math.max(MIN_W, r.w + dx);
        if (dir.includes('s')) r.h = Math.max(MIN_H, r.h + dy);
        if (dir.includes('w')) {
          const nw = Math.max(MIN_W, r.w - dx);
          const shift = r.w - nw;
          r.x = r.x + shift;
          r.w = nw;
        }
        if (dir.includes('n')) {
          const nh = Math.max(MIN_H, r.h - dy);
          const shift = r.h - nh;
          r.y = r.y + shift;
          r.h = nh;
        }
        return { ...prev, [id]: r };
      });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    const cursors: Record<string, string> = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      se: 'nwse-resize', nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    };
    document.body.style.cursor = cursors[dir] || '';
  };

  const tileAll = () => {
    const host = hostRef.current;
    if (!host || agents.length === 0) return;
    const W = host.clientWidth;
    const H = host.clientHeight - 44;
    const n = agents.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = (W - 16 * (cols + 1)) / cols;
    const ch = (H - 16 * (rows + 1)) / rows;
    const next: Record<string, Rect> = {};
    agents.forEach((a, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      next[a.id] = { x: 16 + c * (cw + 16), y: 60 + r * (ch + 16), w: cw, h: ch, z: i + 1 };
    });
    setRects(next);
    setZTop(n + 1);
  };

  return (
    <div className="gr-body layout-canvas" ref={hostRef}>
      <div className="canvas-toolbar">
        <button className="pane-btn" onClick={tileAll} title="Tile all panes">
          <Ic.grid size={11} />
          <span style={{ marginLeft: 4 }}>Tile</span>
        </button>
        <span className="canvas-hint">Drag header to move · corners to resize</span>
      </div>
      <div className="canvas-scroll">
        {agents.map(a => {
          const r = rects[a.id] || { x: 20, y: 60, w: 500, h: 340, z: 1 };
          return (
            <div
              key={a.id}
              className={'canvas-card' + (a.id === focusedId ? ' focused' : '')}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: r.z }}
              onMouseDown={() => bringFront(a.id)}
            >
              <div className="canvas-card-inner" onClick={() => onFocus(a.id)}>
                <AgentPane
                  agent={a}
                  focused={a.id === focusedId}
                  onFocus={() => onFocus(a.id)}
                  onStart={onStart}
                  onStop={onStop}
                  onRestart={onRestart}
                  onDelete={onDelete}
                  headMouseDown={startDrag(a.id)}
                  send={send}
                  wsRef={wsRef}
                />
              </div>
              {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map(d => (
                <div key={d} className={'canvas-handle h-' + d} onMouseDown={startResize(a.id, d)} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Main dispatcher ---------------------------------------------------

interface Props {
  agents: Agent[];
  layout: GridLayout;
  focusedId: string | null;
  onFocus: (id: string) => void;
  onStart: (a: Agent) => void;
  onStop: (a: Agent) => void;
  onRestart: (a: Agent) => void;
  onDelete: (a: Agent) => void;
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
  projectId: string;
}

export default function AgentGrid({
  agents, layout, focusedId, onFocus,
  onStart, onStop, onRestart, onDelete,
  send, wsRef, projectId,
}: Props) {
  const orderKey = `termhive:agent-order:${projectId}`;
  const sizesKey2 = `termhive:grid-sizes-2:${projectId}`;
  const sizesKey3 = `termhive:grid-sizes-3:${projectId}`;

  const [order, setOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(orderKey);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return agents.map(a => a.id);
  });

  useEffect(() => {
    const current = agents.map(a => a.id);
    const next = order.filter(id => current.includes(id));
    for (const id of current) if (!next.includes(id)) next.push(id);
    if (next.join(',') !== order.join(',')) setOrder(next);
  }, [agents.map(a => a.id).join(',')]);

  useEffect(() => {
    try { localStorage.setItem(orderKey, JSON.stringify(order)); } catch { /* ignore */ }
  }, [order, orderKey]);

  const ordered = order.map(id => agents.find(a => a.id === id)).filter((a): a is Agent => a != null);

  const reorder = (from: number, to: number) => {
    setOrder(prev => {
      const next = prev.slice();
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });
  };

  const [sizes2, setSizes2] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(sizesKey2);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [50, 50];
  });
  const [sizes3, setSizes3] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(sizesKey3);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [33.33, 33.33, 33.33];
  });
  useEffect(() => { try { localStorage.setItem(sizesKey2, JSON.stringify(sizes2)); } catch { /* ignore */ } }, [sizes2, sizesKey2]);
  useEffect(() => { try { localStorage.setItem(sizesKey3, JSON.stringify(sizes3)); } catch { /* ignore */ } }, [sizes3, sizesKey3]);

  const rowRef = useRef<HTMLDivElement>(null);

  const resizeRow = (setter: React.Dispatch<React.SetStateAction<number[]>>) =>
    (i: number, dxPx: number) => {
      const host = rowRef.current;
      const W = host?.clientWidth || 1000;
      const dPct = (dxPx / W) * 100;
      setter(prev => {
        const next = prev.slice();
        const a = next[i] + dPct;
        const b = next[i + 1] - dPct;
        const MIN = 8;
        if (a < MIN || b < MIN) return prev;
        next[i] = a; next[i + 1] = b;
        return next;
      });
    };

  if (ordered.length === 0) {
    return (
      <div className="gr-body layout-single">
        <div className="panel-empty">No agents yet. Add one from the sidebar.</div>
      </div>
    );
  }

  const commonPaneProps = { onStart, onStop, onRestart, onDelete, send, wsRef };

  if (layout === 'canvas') {
    return (
      <CanvasLayout
        agents={ordered}
        focusedId={focusedId}
        onFocus={onFocus}
        projectId={projectId}
        {...commonPaneProps}
      />
    );
  }

  if (layout === 'single') {
    const main = ordered.find(a => a.id === focusedId) || ordered[0];
    return (
      <div className="gr-body layout-single">
        <AgentPane agent={main} focused onFocus={() => onFocus(main.id)} {...commonPaneProps} />
      </div>
    );
  }

  if (layout === '2up') {
    const pick = focusedId
      ? [ordered.find(a => a.id === focusedId)!, ...ordered.filter(a => a.id !== focusedId)].filter(Boolean).slice(0, 2)
      : ordered.slice(0, 2);
    const currentSizes = sizes2.slice(0, pick.length);
    if (currentSizes.length < pick.length) {
      currentSizes.push(...Array(pick.length - currentSizes.length).fill(100 / pick.length));
    }
    return (
      <div className="gr-body layout-row" ref={rowRef}>
        <DraggableRow
          items={pick}
          focusedId={focusedId}
          onFocus={onFocus}
          onReorder={reorder}
          sizes={currentSizes}
          onResize={resizeRow(setSizes2)}
          {...commonPaneProps}
        />
      </div>
    );
  }

  if (layout === '3up') {
    const pick = ordered.slice(0, 3);
    const currentSizes = sizes3.slice(0, pick.length);
    if (currentSizes.length < pick.length) {
      currentSizes.push(...Array(pick.length - currentSizes.length).fill(100 / pick.length));
    }
    return (
      <div className="gr-body layout-row" ref={rowRef}>
        <DraggableRow
          items={pick}
          focusedId={focusedId}
          onFocus={onFocus}
          onReorder={reorder}
          sizes={currentSizes}
          onResize={resizeRow(setSizes3)}
          {...commonPaneProps}
        />
      </div>
    );
  }

  // grid: recursive split tree (tmux-style)
  return (
    <GridTmuxLayout
      agents={ordered}
      focusedId={focusedId}
      onFocus={onFocus}
      projectId={projectId}
      {...commonPaneProps}
    />
  );
}
