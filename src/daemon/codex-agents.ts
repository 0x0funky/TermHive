/**
 * codex-agents.ts — the Codex agent runtime (v2.2).
 *
 * Codex agents no longer run in a PTY. They run as **threads** inside one
 * shared `codex app-server` process. This module is the PTY-runtime's
 * counterpart for Codex: it exposes the same surface (startAgent / stopAgent /
 * output listeners / injectMessage / …) so the daemon can route by CLI.
 *
 * app-server events (agent messages, tool calls, command output) are rendered
 * into a plain-text stream so the existing xterm view shows a terminal-like
 * log. Thread status feeds the v2.1 status engine.
 */

import os from 'os';
import path from 'path';
import type { Agent } from '../types.js';
import { updateAgent } from '../storage.js';
import { CodexAppServer } from './codex-server.js';

type StatusFn = (agentId: string, status: string) => void;

interface CodexSession {
  agent: Agent;
  threadId: string;
  buffer: string[];
  listeners: Set<(data: string) => void>;
  status: string;
  inputLine: string;
  streamingItems: Set<string>;
}

const MAX_BUFFER = 2000;

const sessions = new Map<string, CodexSession>();   // agentId → session
const threadToAgent = new Map<string, string>();    // threadId → agentId
let server: CodexAppServer | null = null;
let onStatus: StatusFn = () => {};

// ─────────────────────────── ANSI helpers ───────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** Expand a leading ~ to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ─────────────────────────── Shared app-server ───────────────────────────

function getServer(): CodexAppServer {
  if (server) return server;
  const s = new CodexAppServer();
  s.onNotification(handleNotification);
  // Codex agents do real work — auto-approve so they aren't blocked waiting
  // for a human who isn't watching the JSON-RPC channel.
  s.onServerRequest(() => ({ decision: 'approved' }));
  s.onExit(() => {
    // The app-server died — every Codex agent is down. (Stage 4 re-resumes.)
    for (const agentId of [...sessions.keys()]) onStatus(agentId, 'stopped');
    sessions.clear();
    threadToAgent.clear();
  });
  server = s;
  return s;
}

// ─────────────────────────── Rendering ───────────────────────────

function emit(s: CodexSession, data: string): void {
  if (!data) return;
  s.buffer.push(data);
  if (s.buffer.length > MAX_BUFFER) s.buffer.splice(0, s.buffer.length - MAX_BUFFER);
  for (const l of s.listeners) l(data);
}

function setStatus(s: CodexSession, status: string): void {
  if (s.status === status) return;
  s.status = status;
  onStatus(s.agent.id, status);
}

function renderCompletedItem(s: CodexSession, item: Record<string, any>): void {
  const type = String(item?.type || '');
  if (type === 'agentMessage') {
    if (s.streamingItems.has(item.id)) {
      s.streamingItems.delete(item.id);
      emit(s, '\r\n');
    } else {
      emit(s, String(item.text || '') + '\r\n');
    }
  } else if (type === 'commandExecution') {
    const cmd = String(item.command || item.cmd || '');
    emit(s, cyan('$ ' + cmd) + '\r\n');
    const out = item.aggregatedOutput || item.output || '';
    if (out) emit(s, String(out).replace(/\r?\n/g, '\r\n').trimEnd() + '\r\n');
  } else if (type === 'mcpToolCall') {
    const name = (item.server ? item.server + '/' : '') + (item.tool || item.name || 'tool');
    emit(s, cyan('⏺ ' + name) + '\r\n');
  } else if (type === 'fileChange') {
    emit(s, cyan('✎ file change: ' + (item.path || item.title || '')) + '\r\n');
  } else if (type === 'error') {
    emit(s, red(String(item.message || 'error')) + '\r\n');
  }
  // userMessage (we echo locally), reasoning, plan, etc. — not surfaced.
}

function handleNotification(method: string, params: Record<string, any>): void {
  const threadId: string | undefined = params.threadId || params.thread?.id;
  if (!threadId) return;
  const agentId = threadToAgent.get(threadId);
  if (!agentId) return;
  const s = sessions.get(agentId);
  if (!s) return;

  switch (method) {
    case 'thread/status/changed': {
      const type = params.status?.type;
      setStatus(s, type === 'active' ? 'running' : 'awaiting_input');
      break;
    }
    case 'item/agentMessage/delta': {
      if (params.itemId) s.streamingItems.add(String(params.itemId));
      emit(s, String(params.delta || ''));
      break;
    }
    case 'item/completed': {
      if (params.item) renderCompletedItem(s, params.item);
      break;
    }
    case 'turn/completed': {
      emit(s, '\r\n');
      break;
    }
    case 'error': {
      emit(s, red('error: ' + (params.message || JSON.stringify(params))) + '\r\n');
      break;
    }
  }
}

// ─────────────────────────── Turn submission ───────────────────────────

function submitTurn(s: CodexSession, text: string): void {
  if (!server) return;
  server.request('turn/start', {
    threadId: s.threadId,
    input: [{ type: 'text', text }],
  }).catch((err) => {
    emit(s, red('turn failed: ' + (err instanceof Error ? err.message : String(err))) + '\r\n');
  });
}

// ─────────────────────────── Public API ───────────────────────────

/** Start a Codex agent as an app-server thread. */
export async function startAgent(agent: Agent, statusFn: StatusFn): Promise<boolean> {
  onStatus = statusFn;
  if (sessions.has(agent.id)) return true;

  const cs = getServer();
  try {
    await cs.ensureStarted();
  } catch (err) {
    console.error('[codex-agents] app-server failed to start:', err);
    return false;
  }

  const cwd = expandHome(agent.cwd);
  let threadId = '';
  try {
    if (agent.codexThreadId) {
      const r = await cs.request('thread/resume', { threadId: agent.codexThreadId, cwd });
      threadId = r?.thread?.id || agent.codexThreadId;
    } else {
      const r = await cs.request('thread/start', {
        cwd, sandbox: 'workspace-write', approvalPolicy: 'on-failure',
      });
      threadId = r?.thread?.id || '';
    }
  } catch {
    // resume can fail if the thread is gone — fall back to a fresh thread
    try {
      const r = await cs.request('thread/start', {
        cwd, sandbox: 'workspace-write', approvalPolicy: 'on-failure',
      });
      threadId = r?.thread?.id || '';
    } catch (err) {
      console.error('[codex-agents] thread/start failed:', err);
      return false;
    }
  }
  if (!threadId) return false;

  const session: CodexSession = {
    agent,
    threadId,
    buffer: [],
    listeners: new Set(),
    status: 'running',
    inputLine: '',
    streamingItems: new Set(),
  };
  sessions.set(agent.id, session);
  threadToAgent.set(threadId, agent.id);

  if (agent.codexThreadId !== threadId) {
    try { updateAgent(agent.projectId, agent.id, { codexThreadId: threadId }); }
    catch { /* non-fatal */ }
  }

  emit(session, dim(`● Codex agent on app-server thread ${threadId.slice(0, 8)}`) + '\r\n');
  onStatus(agent.id, 'running');
  return true;
}

/** Stop tracking a Codex agent. The thread is kept (resumable). */
export function stopAgent(agentId: string): boolean {
  const s = sessions.get(agentId);
  if (!s) return false;
  threadToAgent.delete(s.threadId);
  sessions.delete(agentId);
  onStatus(agentId, 'stopped');
  // Last Codex agent gone → free the app-server (ensureStarted respawns later).
  if (sessions.size === 0 && server) {
    server.stop();
    server = null;
  }
  return true;
}

/** Feed terminal keystrokes — buffered into a line, submitted as a turn. */
export function writeToAgent(agentId: string, data: string): void {
  const s = sessions.get(agentId);
  if (!s) return;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      const line = s.inputLine;
      s.inputLine = '';
      emit(s, '\r\n');
      if (line.trim()) submitTurn(s, line.trim());
    } else if (ch === '\x7f' || ch === '\b') {
      if (s.inputLine.length > 0) {
        s.inputLine = s.inputLine.slice(0, -1);
        emit(s, '\b \b');
      }
    } else if (ch >= ' ') {
      s.inputLine += ch;
      emit(s, ch);
    }
  }
}

/** Inject a message (agent-to-agent / orchestrator) and run it as a turn. */
export function injectMessage(agentId: string, fromName: string, message: string): boolean {
  const s = sessions.get(agentId);
  if (!s) return false;
  const clean = message.replace(/\r/g, '').trim();
  const banner = `[Message from ${fromName}]: ${clean}`;
  emit(s, '\r\n' + dim(banner) + '\r\n');
  submitTurn(s, banner);
  return true;
}

/** No-op — app-server threads have no terminal geometry. */
export function resizeAgent(_agentId: string, _cols: number, _rows: number): void {
  /* intentionally empty */
}

export function addOutputListener(agentId: string, listener: (data: string) => void): void {
  const s = sessions.get(agentId);
  if (!s) return;
  for (const chunk of s.buffer) listener(chunk);
  s.listeners.add(listener);
}

export function removeOutputListener(agentId: string, listener: (data: string) => void): void {
  sessions.get(agentId)?.listeners.delete(listener);
}

export function getAgentPreview(agentId: string): string {
  const s = sessions.get(agentId);
  if (!s || s.buffer.length === 0) return '';
  const tail = s.buffer.slice(-40).join('')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\r\b]/g, '');
  const lines = tail.split('\n').map((l) => l.trim()).filter((l) => l.length > 2);
  return (lines[lines.length - 1] || '').slice(0, 60);
}

export function isAgentRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

export function getRunningAgentIds(): string[] {
  return [...sessions.keys()];
}
