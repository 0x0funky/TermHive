import { useState, useEffect, useRef } from 'react';

interface ActivityEvent {
  id: string;
  projectId: string;
  agentId?: string;
  agentName?: string;
  event: string;
  detail: string;
  timestamp: string;
}

interface Props {
  projectId: string;
  wsRef: React.RefObject<WebSocket | null>;
}

const eventColors: Record<string, string> = {
  'agent:started': 'var(--green)',
  'agent:stopped': 'var(--text-secondary)',
  'content:created': 'var(--accent)',
  'content:modified': 'var(--yellow)',
  'content:deleted': 'var(--red)',
};

const eventIcons: Record<string, string> = {
  'agent:started': '>',
  'agent:stopped': 'x',
  'content:created': '+',
  'content:modified': '~',
  'content:deleted': '-',
};

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export default function ActivityFeed({ projectId, wsRef }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load initial events
  useEffect(() => {
    fetch(`/api/activity?projectId=${projectId}`)
      .then(r => r.json())
      .then(data => setEvents(data))
      .catch(() => {});
  }, [projectId]);

  // Listen for new events via WebSocket
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handler = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'activity' && data.event.projectId === projectId) {
          setEvents(prev => [...prev, data.event]);
        }
      } catch { /* ignore */ }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [projectId, wsRef]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  return (
    <div className="activity-feed">
      <div className="activity-feed-header">
        Activity Feed
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {events.length} events
        </span>
      </div>
      <div className="activity-feed-list">
        {events.length === 0 ? (
          <div className="empty-state" style={{ fontSize: 13 }}>
            No activity yet. Start an agent or edit shared content.
          </div>
        ) : (
          events.map(event => (
            <div key={event.id} className="activity-event">
              <span
                className="activity-icon"
                style={{ color: eventColors[event.event] || 'var(--text-secondary)' }}
              >
                {eventIcons[event.event] || '.'}
              </span>
              <span className="activity-detail">
                {event.detail}
              </span>
              <span className="activity-time">
                {timeAgo(event.timestamp)}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
