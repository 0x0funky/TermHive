/**
 * Command panel — the conversation with the orchestrator brain ("The Keeper").
 * Opened with ⌘J. A right-side drawer.
 *
 * Keeps multiple conversations (chat threads); each persists in the daemon and
 * survives restarts. The conversation list / switcher is the History view.
 *
 *  - GET /api/brain        — replay the current conversation + the list
 *  - ws { brain:send }     — send a user message
 *  - ws { brain:new }      — start a fresh conversation
 *  - ws { brain:switch }   — switch the active conversation
 *  - ws { brain:delete }   — delete a conversation
 *  - ws { brain:event }    — live append / status / full-state updates
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import Ic from './Icons';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { stopSpeaking } from './JarvisHud';

function renderMd(text: string): string {
  try { return marked.parse(text, { async: false }) as string; }
  catch { return text; }
}

interface BrainMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system' | 'error';
  text: string;
  ts: string;
  tool?: string;
}
type BrainStatus = 'idle' | 'thinking';
interface BrainConversationMeta {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}
interface BrainState {
  messages: BrainMessage[];
  status: BrainStatus;
  engine: string;
  currentId: string;
  conversations: BrainConversationMeta[];
}
type BrainEvent =
  | { kind: 'append'; conversationId: string; message: BrainMessage }
  | { kind: 'status'; status: BrainStatus }
  | { kind: 'state'; state: BrainState };

interface Props {
  open: boolean;
  onClose: () => void;
  wsRef: React.RefObject<WebSocket | null>;
  sttCfg: { provider: 'browser' | 'openai' | 'gemini'; language: string };
}

const EXAMPLES = [
  'What is every project working on right now?',
  'Which agents are waiting on me?',
  'Ask the backend agent for its current progress',
];

function timeAgo(ts: string): string {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function CommandPanel({ open, onClose, wsRef, sttCfg }: Props) {
  const [messages, setMessages] = useState<BrainMessage[]>([]);
  const [status, setStatus] = useState<BrainStatus>('idle');
  const [conversations, setConversations] = useState<BrainConversationMeta[]>([]);
  const [currentId, setCurrentId] = useState('');
  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // "Stick to bottom" mode — true while the user is parked at the bottom of
  // the transcript. As soon as they scroll up to read history, we stop
  // auto-following new messages so they're not yanked back down.
  const stickBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeechInput(
    (text, final) => { setInput(text); if (final && text.trim()) send(text); },
    { provider: sttCfg.provider, language: sttCfg.language },
  );

  // Keep the active conversation id reachable from the (long-lived) ws handler.
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  const applyState = useCallback((s: BrainState) => {
    setMessages(Array.isArray(s.messages) ? s.messages : []);
    if (s.status) setStatus(s.status);
    if (s.currentId) setCurrentId(s.currentId);
    if (Array.isArray(s.conversations)) setConversations(s.conversations);
  }, []);

  // Load the conversation + subscribe to live events whenever the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    fetch('/api/brain')
      .then((r) => r.json())
      .then((s: BrainState) => { if (!cancelled) applyState(s); })
      .catch(() => { /* daemon down — usable once it returns */ });

    const ws = wsRef.current;
    if (!ws) return () => { cancelled = true; };
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type !== 'brain:event') return;
        const p: BrainEvent = data.payload;
        if (p.kind === 'append') {
          if (p.conversationId === currentIdRef.current) {
            setMessages((prev) =>
              prev.some((m) => m.id === p.message.id) ? prev : [...prev, p.message]);
          }
        } else if (p.kind === 'status') {
          setStatus(p.status);
        } else if (p.kind === 'state') {
          applyState(p.state);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => { cancelled = true; ws.removeEventListener('message', handler); };
  }, [open, wsRef, applyState]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Re-snap to the bottom only if the user is still parked there. The
    // panel opening always lands at the bottom (fresh view).
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, status, open]);

  // Re-engage "stick to bottom" when the panel opens (fresh view).
  useEffect(() => {
    if (open) stickBottomRef.current = true;
  }, [open]);

  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Threshold: within 30px of the bottom counts as "at the bottom" — gives
    // a little forgiveness for sub-pixel layout.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    stickBottomRef.current = atBottom;
  }, []);

  if (!open) return null;

  const wsSend = (obj: object): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  };

  const send = (textArg?: string) => {
    const text = (textArg ?? input).trim();
    if (!text || status === 'thinking') return;
    if (wsSend({ type: 'brain:send', message: text })) {
      setInput('');
      setShowHistory(false);
    }
  };

  const newConversation = () => {
    wsSend({ type: 'brain:new' });
    setShowHistory(false);
  };

  const switchTo = (id: string) => {
    if (id !== currentId) wsSend({ type: 'brain:switch', conversationId: id });
    setShowHistory(false);
  };

  const deleteConversation = (id: string) => {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    wsSend({ type: 'brain:delete', conversationId: id });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const currentTitle =
    conversations.find((c) => c.id === currentId)?.title || 'New conversation';

  return (
    <div className="cmd-scrim" onClick={onClose}>
      <div className="cmd-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="cmd-h">
          <div className="cmd-h-l">
            <div className="cmd-mark"><Ic.logo size={15} /></div>
            <div className="cmd-h-txt">
              <div className="cmd-title">Command</div>
              <div className="cmd-sub">{currentTitle}</div>
            </div>
          </div>
          <div className="cmd-h-r">
            <button
              className={'hbtn' + (showHistory ? ' active' : '')}
              title="Conversations"
              onClick={() => setShowHistory((h) => !h)}
            >
              <Ic.book size={13} />
            </button>
            <button className="hbtn" title="New conversation" onClick={newConversation}>
              <Ic.plus size={13} />
            </button>
            <button className="hbtn" title="Close (Esc)" onClick={onClose}>
              <Ic.x size={13} />
            </button>
          </div>
        </header>

        {showHistory ? (
          <div className="cmd-hist scroll">
            <button className="cmd-hist-new" onClick={newConversation}>
              <Ic.plus size={12} /> New conversation
            </button>
            {conversations.length === 0 && (
              <div className="panel-empty" style={{ padding: 24 }}>No conversations yet.</div>
            )}
            {conversations.map((c) => (
              <div
                key={c.id}
                className={'cmd-hist-row' + (c.id === currentId ? ' active' : '')}
                onClick={() => switchTo(c.id)}
              >
                <div className="cmd-hist-main">
                  <div className="cmd-hist-title">{c.title || 'New conversation'}</div>
                  <div className="cmd-hist-meta">
                    {c.messageCount} {c.messageCount === 1 ? 'message' : 'messages'} · {timeAgo(c.updatedAt)}
                  </div>
                </div>
                <button
                  className="cmd-hist-del"
                  title="Delete conversation"
                  onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }}
                >
                  <Ic.x size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="cmd-body scroll" ref={bodyRef} onScroll={onBodyScroll}>
            {messages.length === 0 ? (
              <div className="cmd-intro">
                <div className="cmd-intro-mark"><Ic.logo size={24} /></div>
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
                <button
                  className="jv-stop"
                  onClick={() => { stopSpeaking(); wsSend({ type: 'brain:abort' }); }}
                  title="Stop"
                >
                  <Ic.stop size={11} /> Stop
                </button>
              </div>
            )}
          </div>
        )}

        {!showHistory && (
          <div className="cmd-compose">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Ask The Keeper…  (Enter to send, Shift+Enter for a new line)"
              rows={2}
            />
            {speech.supported && (
              <button
                className={'cmd-mic' + (speech.listening ? ' on' : '')}
                onClick={speech.toggle}
                title={speech.error || (speech.listening ? 'Stop listening' : 'Voice input')}
              >
                <Ic.mic size={15} />
              </button>
            )}
            <button
              className="cmd-send"
              onClick={() => send()}
              disabled={!input.trim() || status === 'thinking'}
              title="Send"
            >
              <Ic.send size={14} />
            </button>
          </div>
        )}
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
          <div className="cmd-avatar"><Ic.logo size={11} /></div>
          <div
            className="cmd-bubble cmd-md"
            dangerouslySetInnerHTML={{ __html: renderMd(m.text) }}
          />
        </div>
      );
    case 'tool':
      return (
        <div className="cmd-tool" title={m.text || m.tool || 'tool'}>
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
