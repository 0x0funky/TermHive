import { useEffect, useRef } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  agentId: string;
  send: (msg: object) => void;
  wsRef: React.RefObject<WebSocket | null>;
  onFocus?: () => void;
  /** When true, imperatively focus the xterm so keyboard input routes here. */
  focused?: boolean;
}

export default function Terminal({ agentId, send, wsRef, onFocus, focused }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // When the `focused` prop flips to true (e.g. via Ctrl+1-5 or programmatic
  // selection), route keyboard input to this xterm instance.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

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

    // Allow browser paste/copy and Termhive app shortcuts to reach the window handler
    // even when xterm has focus. Returning false tells xterm to skip the key; the
    // browser still dispatches keydown to window listeners (capture or otherwise).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'v') return false;                          // paste
      if (mod && e.key === 'c' && term.hasSelection()) return false;   // copy when selection
      // Termhive global shortcuts — palette + agent focus
      if (mod && (e.key === 'k' || e.key === 'K')) return false;       // palette
      if (mod && e.key === '/') return false;                          // palette (alt)
      if (mod && /^[1-9]$/.test(e.key)) return false;                  // agent focus
      if (e.key === 'Escape') return false;                            // close palette
      return true;
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

    // Notify parent when terminal gets focus; also ensure the hidden xterm
    // textarea gets focus when the user clicks so keyboard + paste routes work.
    const container = containerRef.current;
    const handleFocusIn = () => onFocus?.();
    const handleMouseDown = () => {
      onFocus?.();
      // Defer so the click-to-focus on the xterm textarea happens first,
      // then we confirm/re-apply focus in case something else stole it.
      setTimeout(() => termRef.current?.focus(), 0);
    };
    container.addEventListener('focusin', handleFocusIn);
    container.addEventListener('mousedown', handleMouseDown);

    // Explicit paste handler — works for both Ctrl/Cmd+V and right-click →
    // Paste. xterm.paste() routes the text into the terminal input stream as
    // if typed, handling bracketed paste mode when enabled by the server.
    const handlePaste = (ev: ClipboardEvent) => {
      const text = ev.clipboardData?.getData('text');
      if (text && termRef.current) {
        ev.preventDefault();
        ev.stopPropagation();
        termRef.current.paste(text);
      }
    };
    container.addEventListener('paste', handlePaste);

    // Fit on resize — debounced to avoid thrashing during drag
    let fitTimeout: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(fitTimeout);
      fitTimeout = setTimeout(() => fit.fit(), 50);
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(fitTimeout);
      clearTimeout(scrollTimer);
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('paste', handlePaste);
      send({ type: 'terminal:detach', agentId });
      ws?.removeEventListener('message', handler);
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [agentId]);

  return <div ref={containerRef} className="terminal-container" />;
}
