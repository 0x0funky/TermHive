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

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';

    const darkTheme = {
      background: '#1e1e1e',
      foreground: '#e6edf3',
      cursor: '#529cca',
      selectionBackground: 'rgba(82, 156, 202, 0.3)',
      black: '#1e1e1e',
      red: '#eb5757',
      green: '#4dab9a',
      yellow: '#e6c845',
      blue: '#529cca',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#d4d4d4',
      brightBlack: '#6e7681',
      brightRed: '#f47067',
      brightGreen: '#6bc49a',
      brightYellow: '#f0d96d',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#76d9e6',
      brightWhite: '#e6edf3',
    };

    // Light palette matched to Claude Code's light theme (ansi color names)
    const lightTheme = {
      background: '#f7f7f5',
      foreground: '#37352f',
      cursor: '#2383e2',
      selectionBackground: 'rgba(0, 153, 153, 0.2)',
      black: '#37352f',          // ansi:black → text color
      red: '#c0392b',            // ansi:red → error
      green: '#2c7a39',          // ansi:green → success
      yellow: '#966c1e',         // ansi:yellow → warning
      blue: '#2383e2',           // ansi:blue → permission, suggestion
      magenta: '#8700af',        // ansi:magenta → autoAccept, merged
      cyan: '#0e7a7a',           // ansi:cyan → planMode, background
      white: '#e0ddd8',          // ansi:white → inverse, message bg
      brightBlack: '#8b8680',    // ansi:blackBright → inactive, subtle
      brightRed: '#d77b53',      // ansi:redBright → claude name, agent orange
      brightGreen: '#4dab9a',    // ansi:greenBright → diff added word
      brightYellow: '#c49a1a',   // ansi:yellowBright → shimmer, warning
      brightBlue: '#529cca',     // ansi:blueBright → ide, professional blue
      brightMagenta: '#b44dd7',  // ansi:magentaBright → pink agent
      brightCyan: '#3aafa9',     // ansi:cyanBright
      brightWhite: '#f7f7f5',    // ansi:whiteBright → bash message bg
    };

    const term = new XTerminal({
      cursorBlink: true,
      fontSize: 12.25,
      fontFamily: "'Consolas', 'Fira Code', monospace",
      theme: isLight ? lightTheme : darkTheme,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // IME positioning is handled by xterm/Claude Code natively

    // Only scroll to bottom during initial buffer load (attach), not on every output
    let initialLoad = true;
    let scrollTimer: ReturnType<typeof setTimeout>;

    // Attach to agent terminal
    send({ type: 'terminal:attach', agentId });

    // Stop initial scroll after buffer finishes streaming
    scrollTimer = setTimeout(() => { initialLoad = false; }, 2000);

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
          if (initialLoad) {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
              term.scrollToBottom();
              initialLoad = false;
            }, 150);
          }
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
      clearTimeout(scrollTimer);
      send({ type: 'terminal:detach', agentId });
      ws?.removeEventListener('message', handler);
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [agentId]);

  return <div ref={containerRef} className="terminal-container" />;
}
