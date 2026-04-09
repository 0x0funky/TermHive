import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRouter } from './routes.js';
import * as storage from './storage.js';
import * as ptyManager from './pty-manager.js';
import * as activity from './activity.js';
import type { WSClientMessage, WSServerMessage, ActivityEvent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3200', 10);

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track all connected clients
const clients = new Set<WebSocket>();

function broadcast(msg: WSServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcastStatus(agentId: string, status: string) {
  broadcast({ type: 'agent:status', agentId, status });
}

function broadcastContentUpdate(projectId: string, filename: string) {
  broadcast({ type: 'content:updated', projectId, filename });
}

// Wire activity feed to broadcast
activity.setBroadcast((event: ActivityEvent) => {
  broadcast({ type: 'activity', event });
  // Also broadcast content:updated when files change so Shared Content tab auto-refreshes
  if (event.event.startsWith('content:')) {
    broadcastContentUpdate(event.projectId, event.detail.split(': ')[1] || '');
  }
});

// Start file watchers for all existing projects
for (const project of storage.listProjects()) {
  activity.watchProject(project.id, project.name);
}

// API routes
app.use('/api', createRouter(broadcastStatus, broadcastContentUpdate));

// Activity feed REST endpoint
app.get('/api/activity', (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  res.json(activity.getEvents(projectId));
});

// Serve static frontend in production
const clientDist = path.join(__dirname, 'client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// WebSocket handling
wss.on('connection', (ws) => {
  clients.add(ws);
  const agentListeners = new Map<string, (data: string) => void>();

  ws.on('message', (raw) => {
    let msg: WSClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'terminal:attach': {
        const listener = (data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'terminal:output',
              agentId: msg.agentId,
              data,
            } satisfies WSServerMessage));
          }
        };
        agentListeners.set(msg.agentId, listener);
        ptyManager.addOutputListener(msg.agentId, listener);
        break;
      }
      case 'terminal:detach': {
        const listener = agentListeners.get(msg.agentId);
        if (listener) {
          ptyManager.removeOutputListener(msg.agentId, listener);
          agentListeners.delete(msg.agentId);
        }
        break;
      }
      case 'terminal:input': {
        ptyManager.writeToAgent(msg.agentId, msg.data);
        break;
      }
      case 'terminal:resize': {
        ptyManager.resizeAgent(msg.agentId, msg.cols, msg.rows);
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    for (const [agentId, listener] of agentListeners) {
      ptyManager.removeOutputListener(agentId, listener);
    }
    agentListeners.clear();
  });
});

server.listen(PORT, () => {
  console.log(`Termhive server running on http://localhost:${PORT}`);
});
