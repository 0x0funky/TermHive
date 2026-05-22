/**
 * NotificationCenter — the header bell: a live "who needs you" feed.
 *
 * Stage 2 of the Keeper wedge: proactive awareness. Instead of scanning every
 * terminal for which agent is waiting, the bell surfaces them — derived live
 * from agent status, so it is always accurate.
 */

import { useState, useEffect, useRef } from 'react';
import Ic from './Icons';

export interface AgentNotif {
  agentId: string;
  agentName: string;
  projectId: string;
  projectName: string;
}

interface Props {
  notifs: AgentNotif[];
  unread: number;
  onOpen: () => void;
  onSelect: (projectId: string, agentId: string) => void;
}

export default function NotificationCenter({ notifs, unread, onOpen, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside the bell + popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) onOpen();
  };

  return (
    <div className="ntf" ref={rootRef}>
      <button
        className={'hbtn ntf-bell' + (unread > 0 ? ' has' : '')}
        title="Agents that need you"
        onClick={toggle}
      >
        <Ic.bell size={14} />
        {unread > 0 && <span className="ntf-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="ntf-pop">
          <div className="ntf-head">
            <span>Needs you</span>
            <span className="ntf-count">{notifs.length}</span>
          </div>
          {notifs.length === 0 ? (
            <div className="ntf-empty">All clear — nothing is waiting on you.</div>
          ) : (
            <div className="ntf-list">
              {notifs.map((n) => (
                <button
                  key={n.agentId}
                  className="ntf-row"
                  onClick={() => { onSelect(n.projectId, n.agentId); setOpen(false); }}
                >
                  <span className="ntf-row-dot" />
                  <span className="ntf-row-main">
                    <span className="ntf-row-t">{n.agentName}</span>
                    <span className="ntf-row-s">{n.projectName} · awaiting your input</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
