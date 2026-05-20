import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRouter } from './routes.js';
import * as storage from './storage.js';
import * as activity from './activity.js';
import * as usage from './usage.js';
import { DaemonClient } from './daemon/client.js';
import type { WSClientMessage, WSServerMessage, ActivityEvent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3200', 10);

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- Daemon connection — the daemon owns every agent PTY ---
const daemon = new DaemonClient();
daemon.connect();

// Track all connected browser clients
const clients = new Set<WebSocket>();

// agentId → browser sockets currently watching that agent's terminal
const subscribers = new Map<string, Set<WebSocket>>();

function broadcast(msg: WSServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastStatus(agentId: string, status: string) {
  broadcast({ type: 'agent:status', agentId, status });
}

function broadcastContentUpdate(projectId: string, filename: string) {
  broadcast({ type: 'content:updated', projectId, filename });
}

// Terminal output from the daemon → fan out to the browsers watching that agent
daemon.onOutput((agentId, data) => {
  const subs = subscribers.get(agentId);
  if (!subs) return;
  const frame = JSON.stringify({ type: 'terminal:output', agentId, data } satisfies WSServerMessage);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
});

// Agent status changes from the daemon → broadcast to all browsers
daemon.onStatus((agentId, status) => {
  broadcastStatus(agentId, status);
});

// Orchestrator brain events from the daemon → broadcast to all browsers
daemon.onBrain((payload) => {
  broadcast({ type: 'brain:event', payload });
});

// Orchestrator dispatches (ask_agent / broadcast) → record in the activity
// feed so the brain's actions are visible in the Messages panel.
daemon.onDispatch((d) => {
  activity.pushEvent({
    projectId: d.projectId,
    agentName: d.fromName,
    event: 'agent:message',
    detail: `${d.fromName} → ${d.agentName}: ${d.message.slice(0, 120)}`,
    fromAgent: d.fromName,
    toAgent: d.agentName,
    message: d.message,
  });
});

// The brain created/changed a project or agent → start watching any new
// project and tell browsers to reload the sidebar.
daemon.onOrgChanged(() => {
  for (const project of storage.listProjects()) {
    activity.watchProject(project.id, project.name);
  }
  broadcast({ type: 'org:changed' });
});

// Wire activity feed to broadcast
activity.setBroadcast((event: ActivityEvent) => {
  broadcast({ type: 'activity', event });
  if (event.event.startsWith('content:')) {
    broadcastContentUpdate(event.projectId, event.detail.split(': ')[1] || '');
  }
});

// Start file watchers for all existing projects
for (const project of storage.listProjects()) {
  activity.watchProject(project.id, project.name);
}

// API routes
app.use('/api', createRouter(daemon, broadcastStatus, broadcastContentUpdate));

// Activity feed REST endpoint
app.get('/api/activity', (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  res.json(activity.getEvents(projectId));
});

// Usage endpoint
app.get('/api/usage', async (_req, res) => {
  const data = await usage.getUsage();
  res.json(data);
});

// Daemon health endpoint
app.get('/api/daemon/status', (_req, res) => {
  res.json({ connected: daemon.isConnected() });
});

// Orchestrator brain — conversation snapshot for the Command panel
app.get('/api/brain', async (_req, res) => {
  try {
    const state = await daemon.request('brain:state');
    res.json(state);
  } catch {
    res.status(503).json({ messages: [], status: 'idle', engine: 'codex' });
  }
});

usage.startPolling();

// Serve static frontend in production
const clientDist = path.join(__dirname, 'client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// --- Graceful shutdown ---
// The web server NO LONGER kills agents — the daemon owns them and outlives us.
// We just exit cleanly; agents keep running for the next web start to reattach.
function gracefulShutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down web server (agents stay alive in daemon)`);
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}

// --- WebSocket handling (browser ↔ web server) ---
function unsubscribeAll(ws: WebSocket) {
  for (const [agentId, subs] of subscribers) {
    if (subs.delete(ws) && subs.size === 0) {
      subscribers.delete(agentId);
      daemon.detachTerminal(agentId);
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('message', (raw) => {
    let msg: WSClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'terminal:attach': {
        let subs = subscribers.get(msg.agentId);
        if (!subs) {
          subs = new Set();
          subscribers.set(msg.agentId, subs);
        }
        subs.add(ws);
        // Ask the daemon to (re)stream this agent — it replays the scroll buffer.
        daemon.attachTerminal(msg.agentId);
        break;
      }
      case 'terminal:detach': {
        const subs = subscribers.get(msg.agentId);
        if (subs && subs.delete(ws) && subs.size === 0) {
          subscribers.delete(msg.agentId);
          daemon.detachTerminal(msg.agentId);
        }
        break;
      }
      case 'terminal:input': {
        daemon.writeTerminal(msg.agentId, msg.data);
        break;
      }
      case 'terminal:resize': {
        daemon.resizeTerminal(msg.agentId, msg.cols, msg.rows);
        break;
      }
      case 'brain:send': {
        daemon.sendBrain(msg.message);
        break;
      }
      case 'brain:new': {
        daemon.newBrainConversation();
        break;
      }
      case 'brain:switch': {
        daemon.switchBrainConversation(msg.conversationId);
        break;
      }
      case 'brain:delete': {
        daemon.deleteBrainConversation(msg.conversationId);
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    unsubscribeAll(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Termhive web server running on http://localhost:${PORT}`);
  console.log(`[server] daemon: ${daemon.isConnected() ? 'connected' : 'connecting…'}`);
});
