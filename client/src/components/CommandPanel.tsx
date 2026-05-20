/**
 * Command panel — the v2.3 conversation with the orchestrator brain ("The
 * Keeper"). Opened with ⌘J. A right-side drawer: you type plain-language
 * orders, the brain inspects the hive through its tools and reports back.
 *
 * The conversation lives in the daemon; this panel is a thin client:
 *  - GET /api/brain        — replay the persisted conversation on open
 *  - ws { brain:send }     — send a user message
 *  - ws { brain:reset }    — start a fresh conversation
 *  - ws { brain:event }    — live append / status / reset
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Ic from './Icons';

interface BrainMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system' | 'error';
  text: string;
  ts: string;
  tool?: string;
}
type BrainStatus = 'idle' | 'thinking';
type BrainEvent =
  | { kind: 'append'; message: BrainMessage }
  | { kind: 'status'; status: BrainStatus }
  | { kind: 'reset' };

interface Props {
  open: boolean;
  onClose: () => void;
  wsRef: React.RefObject<WebSocket | null>;
}

const EXAMPLES = [
  'What is every project working on right now?',
  'Which agents are waiting on me?',
  'Ask the backend agent for its current progress',
];

export default function CommandPanel({ open, onClose, wsRef }: Props) {
  const [messages, setMessages] = useState<BrainMessage[]>([]);
  const [status, setStatus] = useState<BrainStatus>('idle');
  const [engine, setEngine] = useState('codex');
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const appendMessage = useCallback((msg: BrainMessage) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  // Replay the conversation + subscribe to live events whenever the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    fetch('/api/brain')
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        if (Array.isArray(s.messages)) {
          setMessages((prev) => {
            const ids = new Set<string>(s.messages.map((m: BrainMessage) => m.id));
            const extra = prev.filter((m) => !ids.has(m.id)); // events that beat the fetch
            return [...s.messages, ...extra];
          });
        }
        if (s.status) setStatus(s.status);
        if (s.engine) setEngine(s.engine);
      })
      .catch(() => { /* daemon down — panel still usable once it returns */ });

    const ws = wsRef.current;
    if (!ws) return () => { cancelled = true; };
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type !== 'brain:event') return;
        const p: BrainEvent = data.payload;
        if (p.kind === 'append') appendMessage(p.message);
        else if (p.kind === 'status') setStatus(p.status);
        else if (p.kind === 'reset') { setMessages([]); setStatus('idle'); }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => { cancelled = true; ws.removeEventListener('message', handler); };
  }, [open, wsRef, appendMessage]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  // Keep the latest message in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status, open]);

  if (!open) return null;

  const send = () => {
    const text = input.trim();
    if (!text || status === 'thinking') return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'brain:send', message: text }));
    setInput('');
  };

  const reset = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'brain:reset' }));
    }
    setMessages([]);
    setStatus('idle');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="cmd-scrim" onClick={onClose}>
      <div className="cmd-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="cmd-h">
          <div className="cmd-h-l">
            <div className="cmd-mark"><Ic.sparkles size={15} /></div>
            <div className="cmd-h-txt">
              <div className="cmd-title">Command</div>
              <div className="cmd-sub">The Keeper · {engine} brain</div>
            </div>
          </div>
          <div className="cmd-h-r">
            <button className="hbtn" title="New conversation" onClick={reset}>
              <Ic.restart size={13} />
            </button>
            <button className="hbtn" title="Close (Esc)" onClick={onClose}>
              <Ic.x size={13} />
            </button>
          </div>
        </header>

        <div className="cmd-body scroll" ref={bodyRef}>
          {messages.length === 0 ? (
            <div className="cmd-intro">
              <div className="cmd-intro-mark"><Ic.sparkles size={24} /></div>
              <h3>Talk to The Keeper</h3>
              <p>
                Your orchestrator brain. Give it plain-language orders — it inspects
                your projects, checks agents, and relays instructions for you.
              </p>
              <div className="cmd-egs">
                {EXAMPLES.map((eg) => (
                  <button key={eg} className="cmd-eg" onClick={() => setInput(eg)}>
                    {eg}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <BrainRow key={m.id} m={m} />)
          )}
          {status === 'thinking' && (
            <div className="cmd-thinking">
              <span className="cmd-dot" /><span className="cmd-dot" /><span className="cmd-dot" />
              The Keeper is working…
            </div>
          )}
        </div>

        <div className="cmd-compose">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask The Keeper…  (Enter to send, Shift+Enter for a new line)"
            rows={2}
          />
          <button
            className="cmd-send"
            onClick={send}
            disabled={!input.trim() || status === 'thinking'}
            title="Send"
          >
            <Ic.send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function BrainRow({ m }: { m: BrainMessage }) {
  switch (m.role) {
    case 'user':
      return (
        <div className="cmd-msg user">
          <div className="cmd-bubble">{m.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="cmd-msg brain">
          <div className="cmd-avatar"><Ic.sparkles size={11} /></div>
          <div className="cmd-bubble">{m.text}</div>
        </div>
      );
    case 'tool':
      return (
        <div className="cmd-tool">
          <Ic.bolt size={10} />
          <span className="cmd-tool-n">{m.tool || 'tool'}</span>
          {m.text && <span className="cmd-tool-a">{m.text}</span>}
        </div>
      );
    case 'reasoning':
      return <div className="cmd-reasoning">{m.text}</div>;
    case 'error':
      return <div className="cmd-err">{m.text}</div>;
    default:
      return <div className="cmd-system">{m.text}</div>;
  }
}
