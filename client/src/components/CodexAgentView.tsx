/**
 * CodexAgentView — structured view for a Codex agent (v2.2).
 *
 * Codex agents run on `codex app-server`, which emits structured events; the
 * daemon maps them to CodexItems. Instead of a flat terminal log, this renders
 * a real conversation: markdown agent messages, collapsible command / tool /
 * file cards, red-green diffs. Used in place of <Terminal> for cli==='codex'.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import Ic from './Icons';

interface CodexItem {
  id: string;
  kind: 'message' | 'reasoning' | 'command' | 'file' | 'tool' | 'error' | 'system';
  role?: 'agent' | 'user';
  text?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  path?: string;
  diff?: string;
  server?: string;
  tool?: string;
  args?: string;
  result?: string;
  status?: 'running' | 'done' | 'failed';
  ts: string;
}

interface Props {
  agentId: string;
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
  onFocus?: () => void;
  focused?: boolean;
}

function renderMd(text: string): string {
  try { return marked.parse(text, { async: false }) as string; }
  catch { return text; }
}

export default function CodexAgentView({ agentId, send, wsRef, onFocus, focused }: Props) {
  const [items, setItems] = useState<CodexItem[]>([]);
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Available models for the picker (codex `model/list`).
  useEffect(() => {
    fetch('/api/codex/models')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d?.models)) setModels(d.models); })
      .catch(() => { /* picker just shows "default" */ });
  }, []);

  useEffect(() => {
    setItems([]);
    send({ type: 'terminal:attach', agentId });
    const ws = wsRef.current;
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'codex:item' && msg.agentId === agentId) {
          setItems((prev) => {
            const idx = prev.findIndex((i) => i.id === msg.item.id);
            if (idx >= 0) { const n = prev.slice(); n[idx] = msg.item; return n; }
            return [...prev, msg.item];
          });
        }
      } catch { /* ignore */ }
    };
    ws?.addEventListener('message', handler);
    return () => {
      ws?.removeEventListener('message', handler);
      send({ type: 'terminal:detach', agentId });
    };
  }, [agentId]);

  useEffect(() => {
    if (focused) inputRef.current?.focus();
  }, [focused]);

  // Keep the latest item in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const submit = () => {
    const t = input.trim();
    if (!t) return;
    send({
      type: 'codex:send', agentId, text: t,
      model: model || undefined, effort: effort || undefined,
    });
    setInput('');
  };

  const startNewThread = () => {
    setItems([]);
    setExpanded(new Set());
    send({ type: 'codex:new-thread', agentId });
  };

  const working = items.some((i) => i.status === 'running');

  return (
    <div className="cxv" onMouseDown={() => onFocus?.()}>
      <div className="cxv-toolbar">
        <select
          className="cxv-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="Model"
        >
          <option value="">Model: default</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          className="cxv-select"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          title="Reasoning effort"
        >
          <option value="">Reasoning: default</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
        </select>
        <div className="cxv-toolbar-sp" />
        <button className="cxv-newthread" onClick={startNewThread} title="Start a new thread">
          + New thread
        </button>
      </div>
      <div className="cxv-body" ref={bodyRef}>
        {items.length === 0 && (
          <div className="cxv-empty">Waiting for the Codex agent…</div>
        )}
        {items.map((it) => (
          <CodexItemRow
            key={it.id}
            item={it}
            open={expanded.has(it.id)}
            onToggle={() => toggle(it.id)}
          />
        ))}
        {working && (
          <div className="cxv-working">
            <span className="cxv-dot" /><span className="cxv-dot" /><span className="cxv-dot" />
            working…
          </div>
        )}
      </div>
      <div className="cxv-compose">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Message this Codex agent…  (Enter to send)"
          rows={2}
        />
        <button className="cxv-send" onClick={submit} disabled={!input.trim()} title="Send">
          <Ic.send size={14} />
        </button>
      </div>
    </div>
  );
}

function CodexItemRow({ item, open, onToggle }: {
  item: CodexItem;
  open: boolean;
  onToggle: () => void;
}) {
  const it = item;

  if (it.kind === 'system') {
    return <div className="cxv-system">{it.text}</div>;
  }
  if (it.kind === 'error') {
    return <div className="cxv-error">{it.text}</div>;
  }
  if (it.kind === 'message') {
    if (it.role === 'user') {
      return <div className="cxv-msg user"><div className="cxv-bubble">{it.text}</div></div>;
    }
    return (
      <div className="cxv-msg agent">
        <div className="cxv-avatar"><Ic.bolt size={11} /></div>
        <div
          className="cxv-md"
          dangerouslySetInnerHTML={{ __html: renderMd(it.text || '') }}
        />
      </div>
    );
  }
  if (it.kind === 'reasoning') {
    return (
      <div className="cxv-card">
        <button className="cxv-card-h" onClick={onToggle}>
          <Ic.chevR size={10} className={'cxv-chev' + (open ? ' rot' : '')} />
          <Ic.sparkles size={10} />
          <span className="cxv-card-t">Thinking</span>
        </button>
        {open && (
          <div
            className="cxv-card-b cxv-md cxv-reasoning"
            dangerouslySetInnerHTML={{ __html: renderMd(it.text || '') }}
          />
        )}
      </div>
    );
  }
  if (it.kind === 'command') {
    const show = open || it.status === 'running';
    return (
      <div className="cxv-card">
        <button className="cxv-card-h cxv-card-h-cmd" onClick={onToggle}>
          <Ic.chevR size={10} className={'cxv-chev' + (show ? ' rot' : '')} />
          <Ic.terminal size={10} />
          <span className="cxv-card-t mono cxv-cmd-t">{it.command || '(command)'}</span>
          {it.status === 'running'
            ? <span className="cxv-badge run">running</span>
            : it.exitCode != null && (
              <span className={'cxv-badge ' + (it.exitCode === 0 ? 'ok' : 'err')}>
                exit {it.exitCode}
              </span>
            )}
        </button>
        {show && it.output && <pre className="cxv-card-b mono">{it.output.trimEnd()}</pre>}
      </div>
    );
  }
  if (it.kind === 'tool') {
    return (
      <div className="cxv-card">
        <button className="cxv-card-h" onClick={onToggle}>
          <Ic.chevR size={10} className={'cxv-chev' + (open ? ' rot' : '')} />
          <Ic.bolt size={10} />
          <span className="cxv-card-t mono">
            {(it.server ? it.server + '/' : '') + (it.tool || 'tool')}
          </span>
          {it.status === 'running' && <span className="cxv-badge run">running</span>}
        </button>
        {open && (
          <div className="cxv-card-b">
            {it.args && <div className="cxv-kv"><span className="cxv-kv-k">args</span><pre className="mono">{it.args}</pre></div>}
            {it.result && <div className="cxv-kv"><span className="cxv-kv-k">result</span><pre className="mono">{it.result}</pre></div>}
          </div>
        )}
      </div>
    );
  }
  if (it.kind === 'file') {
    return (
      <div className="cxv-card">
        <button className="cxv-card-h" onClick={onToggle}>
          <Ic.chevR size={10} className={'cxv-chev' + (open ? ' rot' : '')} />
          <Ic.file size={10} />
          <span className="cxv-card-t mono">{it.path || '(file)'}</span>
        </button>
        {open && it.diff && (
          <pre className="cxv-card-b cxv-diff mono">
            {it.diff.split('\n').map((line, i) => {
              let cls = '';
              if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
              else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
              else if (line.startsWith('@@')) cls = 'hunk';
              return <div key={i} className={'cxv-diff-l ' + cls}>{line || ' '}</div>;
            })}
          </pre>
        )}
      </div>
    );
  }
  return null;
}
