/**
 * Messages panel — shows agent-to-agent MCP messages pulled from the
 * activity feed (agent:message events), with a composer that POSTs to the
 * same `/api/projects/:id/messages` endpoint the MCP server uses.
 */

import { useState, useEffect, useRef } from 'react';
import Ic from './Icons';
import type { Agent } from '../api';

interface ActivityEvent {
  id: string;
  projectId: string;
  agentId?: string;
  agentName?: string;
  event: string;
  detail: string;
  timestamp: string;
  fromAgent?: string;
  toAgent?: string;
  message?: string;
}

interface Props {
  projectId: string;
  agents: Agent[];
  wsRef: React.RefObject<WebSocket | null>;
}

function timeAgo(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  return new Date(ts).toLocaleDateString();
}

export default function MessagesPanel({ projectId, agents, wsRef }: Props) {
  const [messages, setMessages] = useState<ActivityEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeFrom, setComposeFrom] = useState<string>('');
  const [composeTo, setComposeTo] = useState<string>('');
  const [composeBody, setComposeBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didInit = useRef(false);

  useEffect(() => {
    fetch(`/api/activity?projectId=${projectId}`)
      .then(r => r.json())
      .then((all: ActivityEvent[]) => {
        const msgs = all.filter(e => e.event === 'agent:message');
        setMessages(msgs);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'activity' && data.event.projectId === projectId && data.event.event === 'agent:message') {
          setMessages(prev => [...prev, data.event]);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [projectId, wsRef]);

  useEffect(() => {
    if (!didInit.current && messages.length > 0 && !selectedId) {
      setSelectedId(messages[messages.length - 1].id);
      didInit.current = true;
    }
  }, [messages, selectedId]);

  useEffect(() => {
    if (agents.length > 0) {
      if (!composeFrom) setComposeFrom(agents[0].name);
      if (!composeTo && agents.length > 1) setComposeTo(agents[1].name);
    }
  }, [agents, composeFrom, composeTo]);

  const sortedMessages = [...messages].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const selected = sortedMessages.find(m => m.id === selectedId);

  const handleSend = async () => {
    if (!composeFrom || !composeTo || !composeBody.trim()) return;
    const sender = agents.find(a => a.name.toLowerCase() === composeFrom.toLowerCase());
    if (!sender) { setError('Sender not found'); return; }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromAgentId: sender.id,
          fromAgentName: sender.name,
          target: composeTo,
          message: composeBody.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || `HTTP ${res.status}`); return; }
      setComposeBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel msg-panel">
      <div className="panel-h">
        <div className="panel-h-l">
          <h2>Messages</h2>
          <span className="panel-sub">
            Agent-to-agent handoffs via MCP · {messages.length} {messages.length === 1 ? 'message' : 'messages'}
          </span>
        </div>
      </div>
      <div className="msg-split">
        <div className="msg-col-list scroll">
          {sortedMessages.length === 0 ? (
            <div className="panel-empty" style={{ padding: 24 }}>
              No messages yet.<br />Ask an agent to "tell Backend I'm done" to try it.
            </div>
          ) : (
            sortedMessages.map(m => (
              <button
                key={m.id}
                className={'msg-row' + (selected && selected.id === m.id ? ' active' : '')}
                onClick={() => setSelectedId(m.id)}
              >
                <div className="msg-row-h">
                  <span className="from">{m.fromAgent || 'agent'}</span>
                  <span className="arrow">→</span>
                  <span className="to">{m.toAgent || 'agent'}</span>
                  <span className="ts">{timeAgo(m.timestamp)}</span>
                </div>
                <div className="msg-row-body">{m.message || m.detail}</div>
              </button>
            ))
          )}
        </div>
        <div className="msg-col-preview">
          {selected ? (
            <>
              <div className="msg-preview-h">
                <div className="msg-chip">{selected.fromAgent || 'agent'}</div>
                <Ic.arrowR size={11} />
                <div className="msg-chip">{selected.toAgent || 'agent'}</div>
                <div className="grow" />
                <span className="panel-sub">{timeAgo(selected.timestamp)}</span>
              </div>
              <div className="msg-preview-body">{selected.message || selected.detail}</div>
              <div className="msg-compose-full">
                {error && (
                  <div style={{ color: 'var(--err)', fontSize: 11.5 }}>{error}</div>
                )}
                <textarea
                  placeholder={'Compose a message…'}
                  rows={3}
                  value={composeBody}
                  onChange={(e) => setComposeBody(e.target.value)}
                />
                <div className="msg-compose-footer">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select value={composeFrom} onChange={(e) => setComposeFrom(e.target.value)}>
                      {agents.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                    </select>
                    <Ic.arrowR size={11} />
                    <select value={composeTo} onChange={(e) => setComposeTo(e.target.value)}>
                      {agents
                        .filter(a => a.name !== composeFrom)
                        .map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                    </select>
                  </div>
                  <button
                    className="send-btn primary"
                    onClick={handleSend}
                    disabled={sending || !composeBody.trim() || !composeFrom || !composeTo}
                  >
                    <Ic.send size={11} /> {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="panel-empty">No message selected</div>
          )}
        </div>
      </div>
    </div>
  );
}
