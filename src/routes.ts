import { Router, type Request, type Response } from 'express';
import * as storage from './storage.js';
import * as activity from './activity.js';
import type { DaemonClient } from './daemon/client.js';

/**
 * REST API. Agent runtime operations (start/stop/status/inject) are delegated
 * to termhive-daemon over `daemon` — the web server no longer owns PTYs.
 */
export function createRouter(
  daemon: DaemonClient,
  broadcastStatus: (agentId: string, status: string) => void,
  broadcastContentUpdate: (projectId: string, filename: string) => void,
) {
  const router = Router();

  /** Fetch the set of currently-running agent ids from the daemon.
   *  If the daemon is unreachable, nothing is running (it owns every PTY). */
  async function runningIds(): Promise<Set<string>> {
    try {
      const r = await daemon.request('agent:runningIds');
      return new Set(r.ids);
    } catch {
      return new Set();
    }
  }

  // --- Projects ---
  router.get('/projects', (_req: Request, res: Response) => {
    res.json(storage.listProjects());
  });

  router.post('/projects', (req: Request, res: Response) => {
    const { name, cwd, description } = req.body;
    if (!name || !cwd) {
      res.status(400).json({ error: 'name and cwd are required' });
      return;
    }
    const project = storage.createProject(name, cwd, description);
    res.status(201).json(project);
  });

  router.put('/projects/:id', (req: Request, res: Response) => {
    const project = storage.updateProject(req.params.id, req.body);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(project);
  });

  router.delete('/projects/:id', (req: Request, res: Response) => {
    const removeData = req.query.removeData === 'true';
    if (!storage.deleteProject(req.params.id, removeData)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(204).end();
  });

  // --- Agents ---
  router.get('/projects/:id/agents', async (req: Request, res: Response) => {
    const agents = storage.listAgents(req.params.id);
    const running = await runningIds();
    for (const agent of agents) {
      agent.status = running.has(agent.id) ? 'running' : 'stopped';
    }
    res.json(agents);
  });

  router.get('/projects/:id/agents/previews', async (req: Request, res: Response) => {
    const agents = storage.listAgents(req.params.id);
    const previews: Record<string, string> = {};
    await Promise.all(agents.map(async (agent) => {
      try {
        const r = await daemon.request('agent:preview', { agentId: agent.id });
        previews[agent.id] = r.preview;
      } catch {
        previews[agent.id] = '';
      }
    }));
    res.json(previews);
  });

  router.post('/projects/:id/agents', (req: Request, res: Response) => {
    const { name, cli, cwd, role, flags } = req.body;
    if (!name || !cli) {
      res.status(400).json({ error: 'name and cli are required' });
      return;
    }
    const projectData = storage.getProjectData(req.params.id);
    if (!projectData) { res.status(404).json({ error: 'Project not found' }); return; }
    const agentCwd = cwd || projectData.project.cwd;
    const agent = storage.createAgent(req.params.id, name, cli, agentCwd, role, flags);
    if (!agent) { res.status(404).json({ error: 'Project not found' }); return; }
    res.status(201).json(agent);
  });

  router.put('/projects/:id/agents/:aid', (req: Request, res: Response) => {
    const agent = storage.updateAgent(req.params.id, req.params.aid, req.body);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json(agent);
  });

  router.delete('/projects/:id/agents/:aid', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    try {
      await daemon.request('agent:stop', { agentId: req.params.aid });
      if (agent) await daemon.request('agent:cleanup', { projectId: req.params.id, agentId: req.params.aid });
    } catch { /* daemon down — agent already not running */ }
    if (!storage.deleteAgent(req.params.id, req.params.aid)) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.status(204).end();
  });

  // --- Teammates (list other agents the given agent can message) ---
  router.get('/projects/:id/agents/:aid/teammates', async (req: Request, res: Response) => {
    const all = storage.listAgents(req.params.id);
    const self = all.find(a => a.id === req.params.aid);
    if (!self) { res.status(404).json({ error: 'Agent not found' }); return; }
    const running = await runningIds();
    const teammates = all
      .filter(a => a.id !== self.id)
      .map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        cli: a.cli,
        status: running.has(a.id) ? 'running' : 'stopped',
      }));
    res.json({ self: { id: self.id, name: self.name, role: self.role }, teammates });
  });

  // --- Agent-to-agent messaging (called by MCP server) ---
  router.post('/projects/:id/messages', async (req: Request, res: Response) => {
    const { fromAgentId, fromAgentName, target, message } = req.body || {};
    if (!fromAgentId || !target || !message) {
      res.status(400).json({ error: 'fromAgentId, target, and message are required' });
      return;
    }

    const agents = storage.listAgents(req.params.id);
    const sender = agents.find(a => a.id === fromAgentId);
    if (!sender) { res.status(404).json({ error: 'Sender agent not found in this project' }); return; }

    // Resolve target: match by name case-insensitively, excluding self
    const targetNorm = String(target).trim().toLowerCase();
    const matches = agents.filter(a => a.id !== sender.id && a.name.toLowerCase() === targetNorm);
    if (matches.length === 0) {
      const fuzzy = agents.filter(a =>
        a.id !== sender.id &&
        (a.name.toLowerCase().includes(targetNorm) || (a.role || '').toLowerCase().includes(targetNorm))
      );
      if (fuzzy.length === 0) {
        res.status(404).json({ error: `No teammate named "${target}" in this project` });
        return;
      }
      if (fuzzy.length > 1) {
        res.status(400).json({
          error: `Ambiguous target "${target}" — matches multiple agents: ${fuzzy.map(a => a.name).join(', ')}`,
        });
        return;
      }
      matches.push(fuzzy[0]);
    }
    if (matches.length > 1) {
      res.status(400).json({
        error: `Multiple agents named "${target}" — rename one to disambiguate: ${matches.map(a => `${a.name} (${a.id.slice(0, 8)})`).join(', ')}`,
      });
      return;
    }

    const recipient = matches[0];
    const fromName = fromAgentName || sender.name;
    let delivered = false;
    try {
      const r = await daemon.request('agent:inject', {
        agentId: recipient.id, fromName, message: String(message),
      });
      delivered = r.delivered;
    } catch { /* daemon down */ }

    activity.pushEvent({
      projectId: req.params.id,
      agentId: sender.id,
      agentName: sender.name,
      event: 'agent:message',
      detail: `${fromName} → ${recipient.name}: ${String(message).slice(0, 120)}`,
      fromAgent: fromName,
      toAgent: recipient.name,
      message: String(message),
    });

    res.json({ delivered, toAgentId: recipient.id, toAgentName: recipient.name });
  });

  router.post('/projects/:id/agents/:aid/start', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    try {
      const r = await daemon.request('agent:start', { projectId: req.params.id, agentId: agent.id });
      if (!r.ok) { res.status(500).json({ error: 'Failed to start agent' }); return; }
    } catch (err) {
      res.status(503).json({ error: 'Daemon unavailable: ' + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    activity.pushEvent({ projectId: req.params.id, agentId: agent.id, agentName: agent.name, event: 'agent:started', detail: `${agent.name} (${agent.cli}) started` });
    const projectData = storage.getProjectData(req.params.id);
    if (projectData) activity.watchProject(req.params.id, projectData.project.name);
    res.json({ status: 'running' });
  });

  router.post('/projects/:id/agents/:aid/stop', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    try {
      await daemon.request('agent:stop', { agentId: agent.id });
    } catch { /* daemon down — treat as stopped */ }
    storage.updateAgent(req.params.id, req.params.aid, { status: 'stopped', pid: undefined });
    broadcastStatus(agent.id, 'stopped');
    activity.pushEvent({ projectId: req.params.id, agentId: agent.id, agentName: agent.name, event: 'agent:stopped', detail: `${agent.name} stopped` });
    res.json({ status: 'stopped' });
  });

  router.post('/projects/:id/agents/:aid/restart', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    try {
      await daemon.request('agent:restart', { projectId: req.params.id, agentId: agent.id });
    } catch (err) {
      res.status(503).json({ error: 'Daemon unavailable: ' + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    res.json({ status: 'restarting' });
  });

  // --- Shared Content ---
  router.get('/projects/:id/content', (req: Request, res: Response) => {
    res.json(storage.listContent(req.params.id));
  });

  router.get('/projects/:id/content/:filename(*)', (req: Request, res: Response) => {
    const item = storage.getContent(req.params.id, req.params.filename);
    if (!item) { res.status(404).json({ error: 'Content not found' }); return; }
    res.json(item);
  });

  router.post('/projects/:id/content', (req: Request, res: Response) => {
    const { filename, content, createdBy } = req.body;
    if (!filename) { res.status(400).json({ error: 'filename is required' }); return; }
    const item = storage.createContent(req.params.id, filename, content || '', createdBy || 'user');
    if (!item) { res.status(404).json({ error: 'Project not found' }); return; }
    broadcastContentUpdate(req.params.id, filename);
    res.status(201).json(item);
  });

  router.put('/projects/:id/content/:filename(*)', (req: Request, res: Response) => {
    const { content } = req.body;
    const item = storage.updateContent(req.params.id, req.params.filename, content || '');
    if (!item) { res.status(404).json({ error: 'Content not found' }); return; }
    broadcastContentUpdate(req.params.id, req.params.filename);
    res.json(item);
  });

  router.delete('/projects/:id/content/:filename(*)', (req: Request, res: Response) => {
    if (!storage.deleteContent(req.params.id, req.params.filename)) {
      res.status(404).json({ error: 'Content not found' });
      return;
    }
    res.status(204).end();
  });

  // --- Project Wiki ---
  router.get('/projects/:id/wiki/status', (req: Request, res: Response) => {
    res.json({ initialized: storage.isWikiInitialized(req.params.id) });
  });

  router.post('/projects/:id/wiki/initialize', (req: Request, res: Response) => {
    const ok = storage.initializeWiki(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ initialized: true });
  });

  router.get('/projects/:id/wiki', (req: Request, res: Response) => {
    res.json(storage.listWikiFiles(req.params.id));
  });

  router.get('/projects/:id/wiki/:filename(*)', (req: Request, res: Response) => {
    const item = storage.getWikiFile(req.params.id, req.params.filename);
    if (!item) { res.status(404).json({ error: 'File not found' }); return; }
    res.json(item);
  });

  router.put('/projects/:id/wiki/:filename(*)', (req: Request, res: Response) => {
    const { content } = req.body;
    const item = storage.updateWikiFile(req.params.id, req.params.filename, content || '');
    if (!item) { res.status(404).json({ error: 'File not found' }); return; }
    res.json(item);
  });

  return router;
}
