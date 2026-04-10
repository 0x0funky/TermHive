import { Router, type Request, type Response } from 'express';
import * as storage from './storage.js';
import * as ptyManager from './pty-manager.js';
import * as activity from './activity.js';

export function createRouter(broadcastStatus: (agentId: string, status: string) => void, broadcastContentUpdate: (projectId: string, filename: string) => void) {
  const router = Router();

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
    if (!storage.deleteProject(req.params.id)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(204).end();
  });

  // --- Agents ---
  router.get('/projects/:id/agents', (req: Request, res: Response) => {
    const agents = storage.listAgents(req.params.id);
    // Sync running status
    for (const agent of agents) {
      agent.status = ptyManager.isAgentRunning(agent.id) ? 'running' : 'stopped';
    }
    res.json(agents);
  });

  router.get('/projects/:id/agents/previews', (req: Request, res: Response) => {
    const agents = storage.listAgents(req.params.id);
    const previews: Record<string, string> = {};
    for (const agent of agents) {
      previews[agent.id] = ptyManager.getAgentPreview(agent.id);
    }
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

  router.delete('/projects/:id/agents/:aid', (req: Request, res: Response) => {
    ptyManager.stopAgent(req.params.aid);
    if (!storage.deleteAgent(req.params.id, req.params.aid)) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.status(204).end();
  });

  router.post('/projects/:id/agents/:aid/start', (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    const ok = ptyManager.startAgent(agent, broadcastStatus);
    if (!ok) { res.status(500).json({ error: 'Failed to start agent' }); return; }
    activity.pushEvent({ projectId: req.params.id, agentId: agent.id, agentName: agent.name, event: 'agent:started', detail: `${agent.name} (${agent.cli}) started` });
    // Start watching shared content for this project
    const projectData = storage.getProjectData(req.params.id);
    if (projectData) activity.watchProject(req.params.id, projectData.project.name);
    res.json({ status: 'running' });
  });

  router.post('/projects/:id/agents/:aid/stop', (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    ptyManager.stopAgent(agent.id);
    storage.updateAgent(req.params.id, req.params.aid, { status: 'stopped', pid: undefined });
    broadcastStatus(agent.id, 'stopped');
    activity.pushEvent({ projectId: req.params.id, agentId: agent.id, agentName: agent.name, event: 'agent:stopped', detail: `${agent.name} stopped` });
    res.json({ status: 'stopped' });
  });

  router.post('/projects/:id/agents/:aid/restart', (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    ptyManager.stopAgent(agent.id);
    setTimeout(() => {
      const freshAgent = storage.getAgent(req.params.id, req.params.aid);
      if (freshAgent) ptyManager.startAgent(freshAgent, broadcastStatus);
    }, 500);
    res.json({ status: 'restarting' });
  });

  // --- Shared Content ---
  router.get('/projects/:id/content', (req: Request, res: Response) => {
    res.json(storage.listContent(req.params.id));
  });

  router.get('/projects/:id/content/:filename', (req: Request, res: Response) => {
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

  router.put('/projects/:id/content/:filename', (req: Request, res: Response) => {
    const { content } = req.body;
    const item = storage.updateContent(req.params.id, req.params.filename, content || '');
    if (!item) { res.status(404).json({ error: 'Content not found' }); return; }
    broadcastContentUpdate(req.params.id, req.params.filename);
    res.json(item);
  });

  router.delete('/projects/:id/content/:filename', (req: Request, res: Response) => {
    if (!storage.deleteContent(req.params.id, req.params.filename)) {
      res.status(404).json({ error: 'Content not found' });
      return;
    }
    res.status(204).end();
  });

  // --- Project Memory ---
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
