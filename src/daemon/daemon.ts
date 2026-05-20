/**
 * termhive-daemon — owns every agent PTY process and outlives the web server.
 *
 * The web server connects as a client over a local WebSocket (see protocol.ts).
 * Because the PTYs live here, restarting / rebuilding the web server no longer
 * kills running agents — the daemon keeps them alive.
 *
 * Run standalone:  node dist/daemon.js   (or: npm run daemon)
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as ptyManager from '../pty-manager.js';
import * as storage from '../storage.js';
import {
  DAEMON_HOST,
  DAEMON_PORT,
  type DaemonRequest,
  type DaemonMessage,
} from './protocol.js';

const startedAt = new Date().toISOString();

/** Every connected web client. Normally one, but tolerate reconnects. */
const clients = new Set<WebSocket>();

/** Per-client: the output listeners it registered, keyed by agentId, so we can
 *  tear them down cleanly on detach / disconnect. */
const clientListeners = new WeakMap<WebSocket, Map<string, (data: string) => void>>();

function send(ws: WebSocket, msg: DaemonMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg: DaemonMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

/** Shared status callback handed to pty-manager — fans out to all web clients
 *  and persists the new status to storage. */
function onAgentStatus(agentId: string, status: string) {
  broadcast({ kind: 'event', event: 'agent:status', agentId, status });
}

function attachTerminal(ws: WebSocket, agentId: string) {
  const listeners = clientListeners.get(ws);
  if (!listeners) return;
  // Replace any existing listener for this agent (idempotent attach)
  const existing = listeners.get(agentId);
  if (existing) ptyManager.removeOutputListener(agentId, existing);

  const listener = (data: string) => {
    send(ws, { kind: 'event', event: 'terminal:output', agentId, data });
  };
  listeners.set(agentId, listener);
  ptyManager.addOutputListener(agentId, listener);
}

function detachTerminal(ws: WebSocket, agentId: string) {
  const listeners = clientListeners.get(ws);
  const listener = listeners?.get(agentId);
  if (listener) {
    ptyManager.removeOutputListener(agentId, listener);
    listeners!.delete(agentId);
  }
}

async function handleRequest(ws: WebSocket, req: DaemonRequest): Promise<void> {
  // Fire-and-forget commands (no id)
  if (!('id' in req)) {
    switch (req.op) {
      case 'terminal:attach': attachTerminal(ws, req.agentId); return;
      case 'terminal:detach': detachTerminal(ws, req.agentId); return;
      case 'terminal:input': ptyManager.writeToAgent(req.agentId, req.data); return;
      case 'terminal:resize': ptyManager.resizeAgent(req.agentId, req.cols, req.rows); return;
    }
    return;
  }

  // RPC — must reply with the same id
  const reply = (result: unknown) =>
    send(ws, { kind: 'reply', id: req.id, ok: true, result });
  const fail = (error: string) =>
    send(ws, { kind: 'reply', id: req.id, ok: false, error });

  try {
    switch (req.op) {
      case 'agent:start': {
        const agent = storage.getAgent(req.projectId, req.agentId);
        if (!agent) return fail('Agent not found');
        const ok = ptyManager.startAgent(agent, onAgentStatus);
        return reply({ ok });
      }
      case 'agent:stop': {
        const ok = ptyManager.stopAgent(req.agentId);
        return reply({ ok });
      }
      case 'agent:restart': {
        const agent = storage.getAgent(req.projectId, req.agentId);
        if (!agent) return fail('Agent not found');
        ptyManager.stopAgent(req.agentId);
        setTimeout(() => {
          const fresh = storage.getAgent(req.projectId, req.agentId);
          if (fresh) ptyManager.startAgent(fresh, onAgentStatus);
        }, 500);
        return reply({ ok: true });
      }
      case 'agent:cleanup': {
        const agent = storage.getAgent(req.projectId, req.agentId);
        if (agent) ptyManager.cleanupMcpConfig(agent);
        return reply({ ok: true });
      }
      case 'agent:inject': {
        const delivered = ptyManager.injectMessage(req.agentId, req.fromName, req.message);
        return reply({ delivered });
      }
      case 'agent:isRunning':
        return reply({ running: ptyManager.isAgentRunning(req.agentId) });
      case 'agent:preview':
        return reply({ preview: ptyManager.getAgentPreview(req.agentId) });
      case 'agent:runningIds':
        return reply({ ids: ptyManager.getRunningAgentIds() });
      default:
        return fail('Unknown op');
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

const wss = new WebSocketServer({ host: DAEMON_HOST, port: DAEMON_PORT });

wss.on('connection', (ws) => {
  clients.add(ws);
  clientListeners.set(ws, new Map());
  console.log(`[daemon] web client connected (${clients.size} total)`);

  send(ws, { kind: 'hello', pid: process.pid, startedAt });

  ws.on('message', (raw) => {
    let req: DaemonRequest;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleRequest(ws, req).catch((err) => {
      console.error('[daemon] request error:', err);
    });
  });

  ws.on('close', () => {
    // Remove all output listeners this client registered
    const listeners = clientListeners.get(ws);
    if (listeners) {
      for (const [agentId, listener] of listeners) {
        ptyManager.removeOutputListener(agentId, listener);
      }
      listeners.clear();
    }
    clients.delete(ws);
    console.log(`[daemon] web client disconnected (${clients.size} total)`);
  });
});

wss.on('listening', () => {
  console.log(`[daemon] termhive-daemon listening on ws://${DAEMON_HOST}:${DAEMON_PORT} (pid ${process.pid})`);
});

wss.on('error', (err) => {
  console.error('[daemon] server error:', err);
  process.exit(1);
});

// Graceful shutdown — kill every PTY so nothing is orphaned.
function shutdown(signal: string) {
  console.log(`[daemon] ${signal} — killing all agents...`);
  for (const agentId of ptyManager.getRunningAgentIds()) {
    try { ptyManager.stopAgent(agentId); } catch { /* best-effort */ }
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}
