/**
 * Hive dispatch — the org-level operations behind the Hive Orchestrator MCP.
 *
 *  - `orgSnapshot`  builds the projects + agents + live-status view the brain
 *    reads through `list_projects` / `list_agents` / `get_agent_status`.
 *  - `askAgentDispatch` is the core `ask_agent`: it injects a message into a
 *    target agent's live PTY, waits for that turn to finish (via the v2.1
 *    status-engine hooks), and reads the agent's reply back from its session
 *    transcript.
 *
 * Per the v2 billing strategy (§3 of the plan) this keeps Claude agents in
 * interactive PTY mode — subscription-covered — instead of metered `claude -p`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import * as storage from '../storage.js';
import * as ptyManager from '../pty-manager.js';
import type { Agent, Project } from '../types.js';
import { hookEvents } from './hook-events.js';

/** Upper bound on how long `ask_agent` waits for a Claude turn to finish. */
const TURN_TIMEOUT_MS = 120_000;

// ─────────────────────────── Org snapshot ───────────────────────────

export interface OrgSnapshotAgent {
  id: string;
  name: string;
  role?: string;
  cli: string;
  status: string;
}
export interface OrgSnapshotProject {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  agents: OrgSnapshotAgent[];
}
export interface OrgSnapshot {
  projects: OrgSnapshotProject[];
}

/**
 * Full hive view. `liveStatus` resolves the daemon's fine-grained status for
 * an agent id (the daemon owns the status engine, so it injects this).
 */
export function orgSnapshot(liveStatus: (agentId: string) => string): OrgSnapshot {
  return {
    projects: storage.listProjects().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      cwd: p.cwd,
      agents: storage.listAgents(p.id).map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        cli: a.cli,
        status: liveStatus(a.id),
      })),
    })),
  };
}

// ─────────────────────────── ask_agent ───────────────────────────

export interface AskAgentResult {
  ok: boolean;
  /** replied | no-reply | timeout | delivered | not-running | not-found */
  status: 'replied' | 'no-reply' | 'timeout' | 'delivered' | 'not-running' | 'not-found';
  projectId?: string;
  projectName?: string;
  agentName?: string;
  cli?: string;
  reply?: string | null;
  error?: string;
}

/** Expand a leading ~ to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveProject(ref: string): Project | null {
  const norm = ref.trim().toLowerCase();
  const all = storage.listProjects();
  return (
    all.find((p) => p.id === ref) ||
    all.find((p) => p.name.toLowerCase() === norm) ||
    all.find((p) => p.name.toLowerCase().includes(norm)) ||
    null
  );
}

function resolveAgent(projectId: string, ref: string): Agent | null {
  const norm = ref.trim().toLowerCase();
  const agents = storage.listAgents(projectId);
  return (
    agents.find((a) => a.id === ref) ||
    agents.find((a) => a.name.toLowerCase() === norm) ||
    agents.find((a) => (a.role || '').toLowerCase() === norm) ||
    agents.find((a) => a.name.toLowerCase().includes(norm)) ||
    null
  );
}

/**
 * Resolve the daemon-owned hooks for a Claude agent into a turn boundary.
 *
 * After we inject a prompt the agent fires `UserPromptSubmit` (turn started),
 * works, then fires `Stop` (turn finished). We wait for that `Stop`. If no
 * `UserPromptSubmit` shows up in time, the injection may have landed without a
 * hook firing — we then accept the next `Stop` regardless.
 */
function waitForTurnEnd(agentId: string, timeoutMs: number): Promise<'ended' | 'timeout'> {
  return new Promise((resolve) => {
    let sawPrompt = false;
    let done = false;

    const finish = (outcome: 'ended' | 'timeout') => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(promptTimer);
      hookEvents.off('hook', onHook);
      resolve(outcome);
    };

    const onHook = (id: string, event: string) => {
      if (id !== agentId) return;
      if (event === 'UserPromptSubmit') sawPrompt = true;
      if ((event === 'Stop' || event === 'SessionEnd') && sawPrompt) finish('ended');
    };

    // If the prompt-submit hook never arrives, stop gating on it after a while.
    const promptTimer = setTimeout(() => { sawPrompt = true; }, 20_000);
    const hardTimer = setTimeout(() => finish('timeout'), timeoutMs);

    hookEvents.on('hook', onHook);
  });
}

/**
 * Claude Code stores per-project transcripts at
 *   ~/.claude/projects/<slug>/<sessionId>.jsonl
 * where <slug> is the cwd with every non-alphanumeric char replaced by `-`.
 */
function claudeTranscriptDir(cwd: string): string {
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

/** Pull the text blocks out of an assistant transcript record. */
function assistantText(rec: { message?: { content?: unknown } }): string[] {
  const blocks = rec?.message?.content;
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      out.push(b.text.trim());
    }
  }
  return out;
}

/**
 * Read the reply a Claude agent produced for our injected message.
 *
 * Branch-safe: it locates our exact injected turn in the transcript, then
 * follows the `parentUuid` tree to collect only the assistant text that
 * descends from it. A Claude session can fork (e.g. when the same session is
 * driven from two places); reading "the newest assistant text" could otherwise
 * return a reply from an unrelated branch. Falls back to a timestamp window if
 * the injected turn cannot be matched.
 */
function readClaudeReply(cwd: string, sinceMs: number, injectedText: string): string | null {
  const dir = claudeTranscriptDir(cwd);
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;

  const cutoff = sinceMs - 3000; // grace for clock skew
  const target = injectedText.trim();

  // The active session is almost always the newest file; check the top two.
  for (const { full } of files.slice(0, 2)) {
    let content = '';
    try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    const recs: Array<Record<string, any>> = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { recs.push(JSON.parse(t)); } catch { /* skip malformed line */ }
    }

    // Locate our injected turn — the latest user record whose content matches
    // the injected text and arrived no earlier than when we injected.
    let injectedUuid: string | null = null;
    for (const o of recs) {
      if (o.type !== 'user' || typeof o.uuid !== 'string') continue;
      const c = o.message?.content;
      if (typeof c !== 'string') continue;
      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : 0;
      if (ts && ts < cutoff) continue;
      if (c.trim() === target || c.includes(target)) injectedUuid = o.uuid;
    }
    if (!injectedUuid) continue; // not in this file — try the next newest

    // Collect every descendant of our turn via the parentUuid tree.
    const childrenOf: Record<string, string[]> = {};
    for (const o of recs) {
      if (typeof o.parentUuid === 'string' && typeof o.uuid === 'string') {
        (childrenOf[o.parentUuid] ||= []).push(o.uuid);
      }
    }
    const descendants = new Set<string>();
    const stack = [injectedUuid];
    while (stack.length) {
      const u = stack.pop() as string;
      for (const cu of childrenOf[u] || []) {
        if (!descendants.has(cu)) { descendants.add(cu); stack.push(cu); }
      }
    }

    // Assistant text from descendants only, in transcript order.
    const texts: string[] = [];
    for (const o of recs) {
      if (o.type === 'assistant' && typeof o.uuid === 'string' && descendants.has(o.uuid)) {
        texts.push(...assistantText(o));
      }
    }
    return texts.join('\n\n').trim() || null;
  }

  // Fallback: injected turn not located — best-effort timestamp window.
  for (const { full } of files.slice(0, 2)) {
    let content = '';
    try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    const texts: string[] = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o: Record<string, any>;
      try { o = JSON.parse(t); } catch { continue; }
      if (o.type !== 'assistant') continue;
      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : 0;
      if (!ts || ts < cutoff) continue;
      texts.push(...assistantText(o));
    }
    if (texts.length) return texts.join('\n\n').trim() || null;
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Dispatch a message to an agent and collect its reply. The core of the
 * orchestrator's `ask_agent` tool.
 */
export async function askAgentDispatch(
  projectRef: string,
  agentRef: string,
  message: string,
): Promise<AskAgentResult> {
  const project = resolveProject(projectRef);
  if (!project) {
    return { ok: false, status: 'not-found', error: `No project matching "${projectRef}".` };
  }
  const agent = resolveAgent(project.id, agentRef);
  if (!agent) {
    return {
      ok: false,
      status: 'not-found',
      projectName: project.name,
      error: `No agent matching "${agentRef}" in ${project.name}.`,
    };
  }

  const base = {
    projectId: project.id,
    projectName: project.name,
    agentName: agent.name,
    cli: agent.cli,
  };

  if (!ptyManager.isAgentRunning(agent.id)) {
    return { ok: false, status: 'not-running', ...base, reply: null };
  }

  const since = Date.now();

  if (agent.cli === 'claude') {
    // Claude → PTY injection + status-engine turn detection + transcript read.
    const turnEnded = waitForTurnEnd(agent.id, TURN_TIMEOUT_MS);
    const injected = ptyManager.injectMessage(agent.id, 'Hive Orchestrator', message);
    if (!injected) {
      return { ok: false, status: 'not-running', ...base, reply: null };
    }

    const outcome = await turnEnded;
    if (outcome === 'timeout') {
      return {
        ok: true,
        status: 'timeout',
        ...base,
        reply: null,
        error: 'Agent did not finish within the wait window.',
      };
    }

    await sleep(800); // let the final transcript line flush to disk
    // The text injectMessage wrote — used to locate our exact turn in the
    // transcript so the reply is read from the right conversation branch.
    const injectedText = `[Message from Hive Orchestrator]: ${message.replace(/\r/g, '').trim()}`;
    const reply = readClaudeReply(expandHome(agent.cwd), since, injectedText);
    return { ok: true, status: reply ? 'replied' : 'no-reply', ...base, reply };
  }

  // Codex / Gemini / other — deliver the message; reply capture lands with
  // their precise-status support (v2.2 / later).
  const injected = ptyManager.injectMessage(agent.id, 'Hive Orchestrator', message);
  return {
    ok: injected,
    status: injected ? 'delivered' : 'not-running',
    ...base,
    reply: null,
  };
}

// ─────────────────────────── start_agent ───────────────────────────

export interface StartAgentResult {
  ok: boolean;
  /** started | already-running | not-found | start-failed */
  status: 'started' | 'already-running' | 'not-found' | 'start-failed';
  projectName?: string;
  agentName?: string;
  cli?: string;
  error?: string;
}

/**
 * Wait until a freshly-started agent can accept injected input.
 * Claude keys off its SessionStart lifecycle hook plus a settle buffer (the
 * TUI and MCP servers need a moment after the session opens). Other CLIs have
 * no hooks, so we fall back to a fixed boot delay.
 */
function waitForAgentReady(agentId: string, cli: string): Promise<void> {
  if (cli !== 'claude') return sleep(16_000);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(floorTimer);
      hookEvents.off('hook', onHook);
      resolve();
    };
    const onHook = (id: string, event: string) => {
      if (id !== agentId) return;
      if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop') {
        hookEvents.off('hook', onHook);
        clearTimeout(floorTimer);
        setTimeout(finish, 12_000); // let the TUI + MCP servers settle
      }
    };
    // Floor: proceed even if no hook ever arrives (slow boot / hooks disabled).
    const floorTimer = setTimeout(finish, 45_000);
    hookEvents.on('hook', onHook);
  });
}

/**
 * Start a stopped agent and wait until it is ready to be messaged. `doStart`
 * is injected by the daemon (it owns the pty-manager status callback).
 */
export async function startAgentDispatch(
  projectRef: string,
  agentRef: string,
  doStart: (agent: Agent) => boolean,
): Promise<StartAgentResult> {
  const project = resolveProject(projectRef);
  if (!project) {
    return { ok: false, status: 'not-found', error: `No project matching "${projectRef}".` };
  }
  const agent = resolveAgent(project.id, agentRef);
  if (!agent) {
    return {
      ok: false,
      status: 'not-found',
      projectName: project.name,
      error: `No agent matching "${agentRef}" in ${project.name}.`,
    };
  }

  const base = { projectName: project.name, agentName: agent.name, cli: agent.cli };
  if (ptyManager.isAgentRunning(agent.id)) {
    return { ok: true, status: 'already-running', ...base };
  }
  if (!doStart(agent)) {
    return { ok: false, status: 'start-failed', ...base, error: 'Failed to spawn the agent process.' };
  }

  await waitForAgentReady(agent.id, agent.cli);
  return { ok: true, status: 'started', ...base };
}

// ─────────────────────── Knowledge base reads ───────────────────────

export interface WikiReadResult {
  ok: boolean;
  projectName?: string;
  initialized?: boolean;
  /** Present when listing pages. */
  pages?: string[];
  /** Present when reading one page (or the overview). */
  page?: string;
  content?: string;
  error?: string;
}

/** Read a project's wiki — a page if given, otherwise the page list. */
export function readWiki(projectRef: string, page?: string): WikiReadResult {
  const project = resolveProject(projectRef);
  if (!project) return { ok: false, error: `No project matching "${projectRef}".` };
  if (!storage.isWikiInitialized(project.id)) {
    return { ok: true, projectName: project.name, initialized: false, pages: [] };
  }
  if (page) {
    const file = storage.getWikiFile(project.id, page);
    if (!file) {
      return { ok: false, projectName: project.name, error: `No wiki page "${page}" in ${project.name}.` };
    }
    return { ok: true, projectName: project.name, initialized: true, page, content: file.content };
  }
  const pages = storage.listWikiFiles(project.id).map((w) => w.filename).sort();
  return { ok: true, projectName: project.name, initialized: true, pages };
}

/** Read a project's wiki overview — the "what is this project" summary. */
export function projectOverview(projectRef: string): WikiReadResult {
  const project = resolveProject(projectRef);
  if (!project) return { ok: false, error: `No project matching "${projectRef}".` };
  if (!storage.isWikiInitialized(project.id)) {
    return {
      ok: true,
      projectName: project.name,
      initialized: false,
      content: project.description || '',
    };
  }
  const overview =
    storage.getWikiFile(project.id, 'overview.md') ||
    storage.getWikiFile(project.id, '_index.md');
  return {
    ok: true,
    projectName: project.name,
    initialized: true,
    page: overview?.filename,
    content: overview?.content || '',
  };
}

export interface SharedReadResult {
  ok: boolean;
  projectName?: string;
  files?: string[];
  file?: string;
  content?: string;
  error?: string;
}

/** Read a project's shared content — a file if given, otherwise the file list. */
export function readShared(projectRef: string, file?: string): SharedReadResult {
  const project = resolveProject(projectRef);
  if (!project) return { ok: false, error: `No project matching "${projectRef}".` };
  if (file) {
    const item = storage.getContent(project.id, file);
    if (!item) {
      return { ok: false, projectName: project.name, error: `No shared file "${file}" in ${project.name}.` };
    }
    return { ok: true, projectName: project.name, file, content: item.content };
  }
  const files = storage.listContent(project.id).map((c) => c.filename).sort();
  return { ok: true, projectName: project.name, files };
}

// ─────────────────────────── broadcast ───────────────────────────

export interface BroadcastReply {
  projectId: string;
  projectName: string;
  agentName: string;
  cli: string;
  status: string;
  reply?: string | null;
}
export interface BroadcastResult {
  ok: boolean;
  projectName?: string;
  error?: string;
  replies: BroadcastReply[];
  skipped: Array<{ projectName: string; agentName: string; reason: string }>;
}

/**
 * Ask every running agent at once — optionally scoped to one project. Stopped
 * agents are skipped (not auto-started: a broadcast should not spin up the
 * whole hive); the brain can start specific ones if it needs them.
 */
export async function broadcastDispatch(
  projectRef: string | undefined,
  message: string,
): Promise<BroadcastResult> {
  const targets: Array<{ project: Project; agent: Agent }> = [];
  if (projectRef) {
    const project = resolveProject(projectRef);
    if (!project) {
      return { ok: false, error: `No project matching "${projectRef}".`, replies: [], skipped: [] };
    }
    for (const agent of storage.listAgents(project.id)) targets.push({ project, agent });
  } else {
    for (const project of storage.listProjects()) {
      for (const agent of storage.listAgents(project.id)) targets.push({ project, agent });
    }
  }

  const running = targets.filter((t) => ptyManager.isAgentRunning(t.agent.id));
  const skipped = targets
    .filter((t) => !ptyManager.isAgentRunning(t.agent.id))
    .map((t) => ({ projectName: t.project.name, agentName: t.agent.name, reason: 'not running' }));

  const scopeName = projectRef ? targets[0]?.project.name : undefined;
  if (running.length === 0) {
    return {
      ok: true,
      projectName: scopeName,
      error: 'No running agents to broadcast to.',
      replies: [],
      skipped,
    };
  }

  const replies = await Promise.all(
    running.map(async (t): Promise<BroadcastReply> => {
      try {
        const r = await askAgentDispatch(t.project.id, t.agent.id, message);
        return {
          projectId: t.project.id,
          projectName: t.project.name,
          agentName: t.agent.name,
          cli: t.agent.cli,
          status: r.status,
          reply: r.reply ?? null,
        };
      } catch {
        return {
          projectId: t.project.id,
          projectName: t.project.name,
          agentName: t.agent.name,
          cli: t.agent.cli,
          status: 'error',
          reply: null,
        };
      }
    }),
  );

  return { ok: true, projectName: scopeName, replies, skipped };
}

// ─────────────────────── create project / agent ───────────────────────

export interface CreateProjectResult {
  ok: boolean;
  status: 'created' | 'exists' | 'error';
  projectId?: string;
  projectName?: string;
  cwd?: string;
  error?: string;
}

/** Create a new project/team. Ensures the working directory exists. */
export function createProjectDispatch(
  name: string,
  cwd: string,
  description?: string,
): CreateProjectResult {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, status: 'error', error: 'A project name is required.' };
  if (!cwd || !cwd.trim()) {
    return { ok: false, status: 'error', error: 'A working directory (cwd) is required.' };
  }

  const existing = storage
    .listProjects()
    .find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    return {
      ok: false,
      status: 'exists',
      projectId: existing.id,
      projectName: existing.name,
      error: `A project named "${trimmed}" already exists.`,
    };
  }

  const resolved = path.resolve(expandHome(cwd.trim()));
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      error: 'Could not create the directory: ' + (err instanceof Error ? err.message : String(err)),
    };
  }

  const project = storage.createProject(trimmed, resolved, description?.trim() || undefined);
  return {
    ok: true,
    status: 'created',
    projectId: project.id,
    projectName: project.name,
    cwd: project.cwd,
  };
}

export interface CreateAgentResult {
  ok: boolean;
  status: 'created' | 'exists' | 'not-found' | 'error';
  projectName?: string;
  agentId?: string;
  agentName?: string;
  cli?: string;
  error?: string;
}

const VALID_CLIS = ['claude', 'codex', 'gemini', 'opencode'];

/** Add an agent to a project. The agent is created stopped. */
export function createAgentDispatch(
  projectRef: string,
  name: string,
  cli: string,
  role?: string,
  cwd?: string,
): CreateAgentResult {
  const project = resolveProject(projectRef);
  if (!project) {
    return { ok: false, status: 'not-found', error: `No project matching "${projectRef}".` };
  }
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return { ok: false, status: 'error', projectName: project.name, error: 'An agent name is required.' };
  }
  const cliNorm = (cli || '').trim().toLowerCase();
  if (!VALID_CLIS.includes(cliNorm)) {
    return {
      ok: false,
      status: 'error',
      projectName: project.name,
      error: `cli must be one of: ${VALID_CLIS.join(', ')}.`,
    };
  }

  const dup = storage
    .listAgents(project.id)
    .find((a) => a.name.toLowerCase() === trimmed.toLowerCase());
  if (dup) {
    return {
      ok: false,
      status: 'exists',
      projectName: project.name,
      agentId: dup.id,
      agentName: dup.name,
      error: `Project "${project.name}" already has an agent named "${trimmed}".`,
    };
  }

  let agentCwd = project.cwd;
  if (cwd && cwd.trim()) {
    agentCwd = path.resolve(expandHome(cwd.trim()));
    try { fs.mkdirSync(agentCwd, { recursive: true }); } catch { /* best-effort */ }
  }

  const agent = storage.createAgent(
    project.id,
    trimmed,
    cliNorm as Agent['cli'],
    agentCwd,
    role?.trim() || undefined,
  );
  if (!agent) {
    return { ok: false, status: 'error', projectName: project.name, error: 'Failed to create the agent.' };
  }
  return {
    ok: true,
    status: 'created',
    projectName: project.name,
    agentId: agent.id,
    agentName: agent.name,
    cli: agent.cli,
  };
}
