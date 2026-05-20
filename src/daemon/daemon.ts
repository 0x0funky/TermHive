/**
 * termhive-daemon — owns every agent PTY process and outlives the web server.
 *
 * Two interfaces on one port (127.0.0.1:3210):
 *   - WebSocket  — the web server connects here (see protocol.ts)
 *   - HTTP       — agent lifecycle hooks POST here (POST /hook/:agentId/:event)
 *
 * Because the PTYs live here, restarting the web server no longer kills agents.
 * The HTTP hook endpoint feeds the status engine, which derives precise agent
 * status (running / awaiting_input / idle / stopped) from Claude Code hooks.
 *
 * Run standalone:  node dist/daemon/daemon.js   (or: npm run daemon)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as ptyManager from '../pty-manager.js';
import * as storage from '../storage.js';
import { hookEventToStatus } from '../hook-config.js';
import { Orchestrator } from './orchestrator.js';
import { hookEvents } from './hook-events.js';
import { orgSnapshot, askAgentDispatch } from './hive.js';
import {
  DAEMON_HOST,
  DAEMON_PORT,
  type DaemonRequest,
  type DaemonMessage,
  type BrainEvent,
} from './protocol.js';

const startedAt = new Date().toISOString();

/** Every connected web client. Normally one, but tolerate reconnects. */
const clients = new Set<WebSocket>();

/** Per-client output listeners, keyed by agentId, for clean teardown. */
const clientListeners = new WeakMap<WebSocket, Map<string, (data: string) => void>>();

function send(ws: WebSocket, msg: DaemonMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: DaemonMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ─────────────────────────── Status engine ───────────────────────────
// Derives precise status from Claude lifecycle hooks + process liveness.
//   running         — actively working (SessionStart/UserPromptSubmit/Pre|PostToolUse)
//   awaiting_input  — Stop / Notification fired — needs the user
//   idle            — awaiting_input for longer than IDLE_AFTER_MS
//   stopped         — process exited / SessionEnd

const IDLE_AFTER_MS = 3 * 60 * 1000;
const agentStatus = new Map<string, string>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setStatus(agentId: string, status: string) {
  const prev = agentStatus.get(agentId);

  // Any transition clears a pending idle timer
  const timer = idleTimers.get(agentId);
  if (timer) { clearTimeout(timer); idleTimers.delete(agentId); }

  if (status === 'stopped') {
    agentStatus.delete(agentId);
  } else {
    agentStatus.set(agentId, status);
  }

  if (prev !== status) {
    broadcast({ kind: 'event', event: 'agent:status', agentId, status });
  }

  // Awaiting input → after a while, demote to idle
  if (status === 'awaiting_input') {
    idleTimers.set(agentId, setTimeout(() => {
      idleTimers.delete(agentId);
      if (agentStatus.get(agentId) === 'awaiting_input') {
        setStatus(agentId, 'idle');
      }
    }, IDLE_AFTER_MS));
  }
}

/** Status callback handed to pty-manager — 'running' on spawn, 'stopped' on exit. */
function onAgentStatus(agentId: string, status: string) {
  setStatus(agentId, status);
}

/** Fine-grained status for one agent, with a process-liveness floor. */
function liveStatus(agentId: string): string {
  const s = agentStatus.get(agentId);
  if (s) return s;
  return ptyManager.isAgentRunning(agentId) ? 'running' : 'stopped';
}

// ─────────────────────────── Orchestrator brain ───────────────────────────
// "The Keeper" — the v2.3 orchestrator. It lives in the daemon because the
// daemon is the long-lived process that also owns the agents it dispatches to.

function broadcastBrainEvent(ev: BrainEvent) {
  broadcast({ kind: 'event', event: 'brain:event', payload: ev });
}
const orchestrator = new Orchestrator(broadcastBrainEvent);

// ─────────────────────────── Terminal streaming ───────────────────────────

function attachTerminal(ws: WebSocket, agentId: string) {
  const listeners = clientListeners.get(ws);
  if (!listeners) return;
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

// ─────────────────────────── WebSocket requests ───────────────────────────

async function handleRequest(ws: WebSocket, req: DaemonRequest): Promise<void> {
  if (!('id' in req)) {
    switch (req.op) {
      case 'terminal:attach': attachTerminal(ws, req.agentId); return;
      case 'terminal:detach': detachTerminal(ws, req.agentId); return;
      case 'terminal:input': ptyManager.writeToAgent(req.agentId, req.data); return;
      case 'terminal:resize': ptyManager.resizeAgent(req.agentId, req.cols, req.rows); return;
      case 'brain:send':
        orchestrator.send(req.message).catch((err) =>
          console.error('[daemon] brain send error:', err));
        return;
      case 'brain:reset': orchestrator.reset(); return;
    }
    return;
  }

  const reply = (result: unknown) => send(ws, { kind: 'reply', id: req.id, ok: true, result });
  const fail = (error: string) => send(ws, { kind: 'reply', id: req.id, ok: false, error });

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
        setStatus(req.agentId, 'stopped');
        return reply({ ok });
      }
      case 'agent:restart': {
        const agent = storage.getAgent(req.projectId, req.agentId);
        if (!agent) return fail('Agent not found');
        ptyManager.stopAgent(req.agentId);
        setStatus(req.agentId, 'stopped');
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
      case 'agent:statuses': {
        // Full fine-grained status map. Any pty-alive agent without a status
        // engine entry defaults to 'running'.
        const statuses: Record<string, string> = {};
        for (const id of ptyManager.getRunningAgentIds()) statuses[id] = 'running';
        for (const [id, s] of agentStatus) statuses[id] = s;
        return reply({ statuses });
      }
      case 'brain:state':
        return reply(orchestrator.getState());
      default:
        return fail('Unknown op');
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ─────────────────────────── HTTP endpoints ───────────────────────────
// Two HTTP surfaces on the daemon port:
//   POST /hook/:agentId/:event   — Claude lifecycle hooks → status engine
//   GET  /org/snapshot           — Hive MCP: whole-hive view
//   POST /org/ask-agent          — Hive MCP: dispatch a message to an agent
//   GET  /health

/** Collect a request body (capped to guard against runaway uploads). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleHttp(httpReq: IncomingMessage, res: ServerResponse) {
  const url = httpReq.url || '';
  const route = url.split('?')[0];

  // POST /hook/<agentId>/<event> — Claude lifecycle hooks
  if (httpReq.method === 'POST' && route.startsWith('/hook/')) {
    const parts = route.split('/'); // ['', 'hook', agentId, event]
    const agentId = parts[2];
    const event = parts[3];
    if (agentId && event) {
      // Feed the dispatch layer's turn detector (ask_agent) first.
      hookEvents.emit('hook', agentId, event);
      const status = hookEventToStatus(event);
      if (status && ptyManager.isAgentRunning(agentId)) setStatus(agentId, status);
    }
    res.writeHead(204); // empty body — keeps `curl -s` output silent
    res.end();
    return;
  }

  // GET /org/snapshot — whole-hive view for the Hive Orchestrator MCP
  if (httpReq.method === 'GET' && route === '/org/snapshot') {
    sendJson(res, 200, orgSnapshot(liveStatus));
    return;
  }

  // POST /org/ask-agent — dispatch a message to an agent and await its reply
  if (httpReq.method === 'POST' && route === '/org/ask-agent') {
    try {
      const body = JSON.parse((await readBody(httpReq)) || '{}');
      const project = String(body.project || '').trim();
      const agent = String(body.agent || '').trim();
      const message = String(body.message || '').trim();
      if (!project || !agent || !message) {
        sendJson(res, 400, {
          ok: false, status: 'not-found',
          error: 'project, agent, and message are required',
        });
        return;
      }
      const result = await askAgentDispatch(project, agent, message);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        ok: false, status: 'not-found',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (httpReq.method === 'GET' && route === '/health') {
    sendJson(res, 200, { ok: true, pid: process.pid, startedAt });
    return;
  }

  res.writeHead(404);
  res.end();
}

// ─────────────────────────── Server bootstrap ───────────────────────────

const httpServer = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error('[daemon] http error:', err);
    try { res.writeHead(500); res.end(); } catch { /* already sent */ }
  });
});
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  clients.add(ws);
  clientListeners.set(ws, new Map());
  console.log(`[daemon] web client connected (${clients.size} total)`);

  send(ws, { kind: 'hello', pid: process.pid, startedAt });

  // Replay current statuses so a freshly (re)started web server is in sync
  for (const [agentId, status] of agentStatus) {
    send(ws, { kind: 'event', event: 'agent:status', agentId, status });
  }

  ws.on('message', (raw) => {
    let req: DaemonRequest;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleRequest(ws, req).catch((err) => console.error('[daemon] request error:', err));
  });

  ws.on('close', () => {
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

httpServer.listen(DAEMON_PORT, DAEMON_HOST, () => {
  console.log(`[daemon] termhive-daemon listening on ${DAEMON_HOST}:${DAEMON_PORT} (pid ${process.pid})`);
  console.log(`[daemon]   ws://${DAEMON_HOST}:${DAEMON_PORT}  — web client`);
  console.log(`[daemon]   http://${DAEMON_HOST}:${DAEMON_PORT}/hook/:agentId/:event  — lifecycle hooks`);
});

httpServer.on('error', (err) => {
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
