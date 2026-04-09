import { useEffect, useRef } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  agentId: string;
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
}

export default function Terminal({ agentId, send, wsRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // IME positioning is handled by xterm/Claude Code natively

    // Attach to agent terminal
    send({ type: 'terminal:attach', agentId });

    // Send resize
    const { cols, rows } = term;
    send({ type: 'terminal:resize', agentId, cols, rows });

    // Handle user input
    term.onData((data) => {
      send({ type: 'terminal:input', agentId, data });
    });

    term.onResize(({ cols, rows }) => {
      send({ type: 'terminal:resize', agentId, cols, rows });
    });

    // Handle incoming data
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'terminal:output' && msg.agentId === agentId) {
          term.write(msg.data);
        }
      } catch { /* ignore */ }
    };

    const ws = wsRef.current;
    ws?.addEventListener('message', handler);

    // Fit on resize — debounced to avoid thrashing during drag
    let fitTimeout: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(fitTimeout);
      fitTimeout = setTimeout(() => fit.fit(), 50);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(fitTimeout);
      send({ type: 'terminal:detach', agentId });
      ws?.removeEventListener('message', handler);
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [agentId]);

  return <div ref={containerRef} className="terminal-container" />;
}
