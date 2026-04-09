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

// SVG icons matching Figma design
const icons: Record<string, { svg: JSX.Element; symbol: string; color: string }> = {
  'agent:started': {
    svg: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M4.5 2.5L10.5 7L4.5 11.5V2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    symbol: '>',
    color: 'var(--green)',
  },
  'agent:stopped': {
    svg: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="3" y="3" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
    symbol: 'x',
    color: 'var(--red)',
  },
  'content:created': {
    svg: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M3 2h5.5L11 4.5V12H3V2Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M8 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M5.5 8h3M7 6.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    ),
    symbol: '+',
    color: 'var(--accent)',
  },
  'content:modified': {
    svg: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 10.5L2.5 8.5L9.5 1.5C9.8 1.2 10.2 1.2 10.5 1.5L11.5 2.5C11.8 2.8 11.8 3.2 11.5 3.5L4.5 10.5L2 11L2 10.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    symbol: '~',
    color: '#e6c845',
  },
  'content:deleted': {
    svg: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M4 5h6M4.5 5V11h5V5M6 7v2.5M8 7v2.5M5.5 5V3.5h3V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    symbol: '-',
    color: 'var(--red)',
  },
};

const defaultIcon = {
  svg: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  ),
  symbol: '.',
  color: 'var(--text-muted)',
};

export default function ActivityFeed({ projectId, wsRef }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/activity?projectId=${projectId}`)
      .then(r => r.json())
      .then(data => setEvents(data))
      .catch(() => {});
  }, [projectId]);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  return (
    <div className="activity-feed">
      <div className="activity-feed-header">
        <span>Activity Feed</span>
        <span className="activity-feed-count">{events.length} events</span>
      </div>
      <div className="activity-feed-list">
        {events.length === 0 ? (
          <div className="empty-state" style={{ fontSize: 12.25 }}>
            No activity yet. Start an agent or edit shared content.
          </div>
        ) : (
          events.map(event => {
            const iconData = icons[event.event] || defaultIcon;
            return (
              <div key={event.id} className="activity-event">
                <span className="activity-icon" style={{ color: iconData.color }}>
                  {iconData.svg}
                </span>
                <span className="activity-symbol" style={{ color: iconData.color }}>
                  {iconData.symbol}
                </span>
                <span className="activity-detail">{event.detail}</span>
                <span className="activity-time">{timeAgo(event.timestamp)}</span>
                <span className="activity-chevron">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M5.25 3.5L8.75 7L5.25 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
