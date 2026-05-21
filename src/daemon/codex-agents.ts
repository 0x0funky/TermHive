/**
 * codex-agents.ts — the Codex agent runtime (v2.2).
 *
 * Codex agents run as **threads** inside one shared `codex app-server` process.
 * app-server emits structured events; this module normalizes them into
 * `CodexItem`s and streams them to the frontend, which renders a real
 * structured view (messages, collapsible tool cards, diffs) rather than a
 * flat terminal log.
 */

import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Agent } from '../types.js';
import type { CodexItem } from './protocol.js';
import { updateAgent } from '../storage.js';
import { CodexAppServer } from './codex-server.js';

type StatusFn = (agentId: string, status: string) => void;
type ItemListener = (item: CodexItem) => void;

interface CodexSession {
  agent: Agent;
  threadId: string;
  items: CodexItem[];
  listeners: Set<ItemListener>;
  status: string;
  inputLine: string;
}

const MAX_ITEMS = 500;

/**
 * Per-thread config override (merged over ~/.codex/config.toml). `detailed`
 * reasoning summaries make codex stream its thinking — without this the
 * reasoning items arrive empty.
 */
const THREAD_CONFIG = { model_reasoning_summary: 'detailed' };

const sessions = new Map<string, CodexSession>();   // agentId → session
const threadToAgent = new Map<string, string>();    // threadId → agentId
let server: CodexAppServer | null = null;
let onStatus: StatusFn = () => {};

const now = () => new Date().toISOString();

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
  // Codex agents do real work — auto-approve so they aren't blocked.
  s.onServerRequest(() => ({ decision: 'approved' }));
  s.onExit(() => {
    for (const agentId of [...sessions.keys()]) onStatus(agentId, 'stopped');
    sessions.clear();
    threadToAgent.clear();
  });
  server = s;
  return s;
}

// ─────────────────────────── Item store ───────────────────────────

function upsert(s: CodexSession, item: CodexItem): void {
  const idx = s.items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    s.items[idx] = item;
  } else {
    s.items.push(item);
    if (s.items.length > MAX_ITEMS) s.items.splice(0, s.items.length - MAX_ITEMS);
  }
  for (const l of s.listeners) {
    try { l(item); } catch (err) { console.error('[codex-agents] item listener error:', err); }
  }
}

function itemById(s: CodexSession, id: unknown): CodexItem | undefined {
  if (typeof id !== 'string') return undefined;
  return s.items.find((i) => i.id === id);
}

function setStatus(s: CodexSession, status: string): void {
  if (s.status === status) return;
  s.status = status;
  onStatus(s.agent.id, status);
}

// ─────────────────────────── Event → CodexItem ───────────────────────────

function extractReasoning(item: Record<string, any>): string {
  const parts: string[] = [];
  for (const arr of [item.summary, item.content]) {
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (typeof e === 'string') parts.push(e);
        else if (e && typeof e.text === 'string') parts.push(e.text);
      }
    }
  }
  if (typeof item.text === 'string') parts.push(item.text);
  return parts.join('\n').trim();
}

/**
 * Strip the shell wrapper codex adds so the card shows the real command.
 * On Windows codex runs everything as `"…\powershell.exe" -Command "ACTUAL"`;
 * unwrapped, the card would show only the useless wrapper path.
 */
function cleanCommand(raw: unknown): string {
  let cmd = String(raw ?? '').trim();
  const ps = cmd.match(/powershell(?:\.exe)?"?\s+-(?:command|c)\s+([\s\S]+)$/i);
  if (ps) {
    cmd = ps[1].trim();
  } else {
    const sh = cmd.match(/\b(?:bash|sh|zsh)(?:\.exe)?"?\s+-c\s+([\s\S]+)$/i);
    if (sh) cmd = sh[1].trim();
  }
  if (cmd.length >= 2) {
    const a = cmd[0];
    const b = cmd[cmd.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      cmd = cmd.slice(1, -1).trim();
    }
  }
  return cmd;
}

function stringify(v: unknown, cap = 4000): string {
  if (v === undefined || v === null) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

/** Map one app-server thread item to a normalized CodexItem (or null to skip). */
function normalizeItem(raw: unknown, status: CodexItem['status']): CodexItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, any>;
  const id = String(item.id || randomUUID());
  const t = String(item.type || '');

  if (t === 'agentMessage') {
    return { id, kind: 'message', role: 'agent', text: String(item.text || ''), status, ts: now() };
  }
  if (t === 'userMessage') {
    const text = Array.isArray(item.content)
      ? item.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
      : String(item.text || '');
    return { id, kind: 'message', role: 'user', text, status, ts: now() };
  }
  if (t === 'reasoning') {
    const text = extractReasoning(item);
    if (!text) return null;   // no summary surfaced — don't show an empty card
    return { id, kind: 'reasoning', text, status, ts: now() };
  }
  if (t === 'commandExecution') {
    const exit = typeof item.exitCode === 'number' ? item.exitCode
      : (typeof item.exit_code === 'number' ? item.exit_code : null);
    return {
      id, kind: 'command',
      command: cleanCommand(item.command || item.cmd),
      output: String(item.aggregatedOutput || item.output || ''),
      exitCode: exit,
      status, ts: now(),
    };
  }
  if (t === 'mcpToolCall') {
    const inv = item.invocation || {};
    return {
      id, kind: 'tool',
      server: String(item.server || inv.server || ''),
      tool: String(item.tool || item.name || inv.tool || 'tool'),
      args: stringify(item.arguments ?? inv.arguments, 600),
      result: stringify(item.result, 4000),
      status, ts: now(),
    };
  }
  if (t === 'fileChange') {
    return {
      id, kind: 'file',
      path: String(item.path || item.title || ''),
      diff: typeof item.diff === 'string' ? item.diff : stringify(item.changes, 8000),
      status, ts: now(),
    };
  }
  if (t === 'error') {
    return { id, kind: 'error', text: String(item.message || 'error'), status, ts: now() };
  }
  // todo_list / plan / imageView / etc. — not surfaced yet.
  return null;
}

function handleNotification(method: string, raw: Record<string, unknown>): void {
  const params = raw as Record<string, any>;
  const threadId: string | undefined = params.threadId || params.thread?.id;
  if (!threadId) return;
  const agentId = threadToAgent.get(threadId);
  if (!agentId) return;
  const s = sessions.get(agentId);
  if (!s) return;

  switch (method) {
    case 'thread/status/changed':
      setStatus(s, params.status?.type === 'active' ? 'running' : 'awaiting_input');
      break;

    case 'item/started': {
      const ci = normalizeItem(params.item, 'running');
      if (ci) upsert(s, ci);
      break;
    }
    case 'item/completed': {
      const ci = normalizeItem(params.item, 'done');
      if (ci) {
        upsert(s, ci);
      } else {
        // e.g. a reasoning item streamed via deltas — finalize it rather than
        // dropping it (normalizeItem skips the empty completed payload).
        const existing = itemById(s, params.item?.id);
        if (existing && existing.status === 'running') {
          existing.status = 'done';
          upsert(s, existing);
        }
      }
      break;
    }

    case 'item/agentMessage/delta': {
      const it = itemById(s, params.itemId);
      if (it && it.kind === 'message') {
        it.text = (it.text || '') + String(params.delta || '');
        upsert(s, it);
      } else if (typeof params.itemId === 'string') {
        upsert(s, {
          id: params.itemId, kind: 'message', role: 'agent',
          text: String(params.delta || ''), status: 'running', ts: now(),
        });
      }
      break;
    }
    case 'item/commandExecution/outputDelta': {
      const it = itemById(s, params.itemId);
      if (it && it.kind === 'command') {
        it.output = (it.output || '') + String(params.delta ?? params.chunk ?? '');
        upsert(s, it);
      }
      break;
    }
    case 'item/reasoning/summaryPartAdded': {
      const it = itemById(s, params.itemId);
      if (it && it.kind === 'reasoning' && it.text) {
        it.text += '\n\n';
        upsert(s, it);
      }
      break;
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const it = itemById(s, params.itemId);
      if (it && it.kind === 'reasoning') {
        it.text = (it.text || '') + String(params.delta || '');
        upsert(s, it);
      } else if (typeof params.itemId === 'string') {
        upsert(s, {
          id: params.itemId, kind: 'reasoning',
          text: String(params.delta || ''), status: 'running', ts: now(),
        });
      }
      break;
    }

    case 'error':
      upsert(s, { id: randomUUID(), kind: 'error', text: String(params.message || 'error'), ts: now() });
      break;
  }
}

// ─────────────────────────── Turn submission ───────────────────────────

function submitTurn(s: CodexSession, text: string, model?: string, effort?: string): void {
  if (!server) return;
  const params: Record<string, unknown> = {
    threadId: s.threadId,
    input: [{ type: 'text', text }],
  };
  if (model) params.model = model;
  if (effort) params.effort = effort;
  server.request('turn/start', params).catch((err) => {
    upsert(s, {
      id: randomUUID(), kind: 'error',
      text: 'turn failed: ' + (err instanceof Error ? err.message : String(err)),
      ts: now(),
    });
  });
}

/** Pull a resumed thread's past turns/items back into the view. */
async function loadHistory(cs: CodexAppServer, s: CodexSession): Promise<void> {
  try {
    const r = await cs.request('thread/read', { threadId: s.threadId, includeTurns: true });
    const turns = r?.thread?.turns;
    if (!Array.isArray(turns)) return;
    for (const turn of turns) {
      const items = turn?.items;
      if (!Array.isArray(items)) continue;
      for (const raw of items) {
        const ci = normalizeItem(raw, 'done');
        if (ci) {
          ci.id = `${turn?.id || 'turn'}:${ci.id}`;   // unique across turns
          s.items.push(ci);
        }
      }
    }
    if (s.items.length > MAX_ITEMS) s.items.splice(0, s.items.length - MAX_ITEMS);
  } catch (err) {
    console.error('[codex-agents] history load failed:', err);
  }
}

// ─────────────────────────── Public API ───────────────────────────

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
  let resumed = false;
  try {
    if (agent.codexThreadId) {
      const r = await cs.request('thread/resume', {
        threadId: agent.codexThreadId, cwd, config: THREAD_CONFIG,
      });
      threadId = r?.thread?.id || agent.codexThreadId;
      resumed = true;
    } else {
      const r = await cs.request('thread/start', {
        cwd, sandbox: 'workspace-write', approvalPolicy: 'on-failure',
        config: THREAD_CONFIG,
      });
      threadId = r?.thread?.id || '';
    }
  } catch {
    try {
      const r = await cs.request('thread/start', {
        cwd, sandbox: 'workspace-write', approvalPolicy: 'on-failure',
        config: THREAD_CONFIG,
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
    items: [],
    listeners: new Set(),
    status: 'running',
    inputLine: '',
  };
  sessions.set(agent.id, session);
  threadToAgent.set(threadId, agent.id);

  if (agent.codexThreadId !== threadId) {
    try { updateAgent(agent.projectId, agent.id, { codexThreadId: threadId }); }
    catch { /* non-fatal */ }
  }

  // A resumed thread → pull its past turns back into the view.
  if (resumed) await loadHistory(cs, session);

  upsert(session, {
    id: randomUUID(), kind: 'system',
    text: `Codex agent online — app-server thread ${threadId.slice(0, 8)}`,
    ts: now(),
  });
  onStatus(agent.id, 'running');
  return true;
}

/** Submit a turn with an optional per-turn model / reasoning-effort override. */
export function sendTurn(agentId: string, text: string, model?: string, effort?: string): void {
  const s = sessions.get(agentId);
  if (!s) return;
  const clean = text.replace(/\r/g, '').trim();
  if (clean) submitTurn(s, clean, model, effort);
}

/** Start a fresh thread for this agent, dropping the current conversation. */
export async function newThread(agentId: string): Promise<boolean> {
  const s = sessions.get(agentId);
  if (!s || !server) return false;
  try {
    const r = await server.request('thread/start', {
      cwd: expandHome(s.agent.cwd),
      sandbox: 'workspace-write', approvalPolicy: 'on-failure', config: THREAD_CONFIG,
    });
    const newId: string = r?.thread?.id || '';
    if (!newId) return false;
    threadToAgent.delete(s.threadId);
    s.threadId = newId;
    threadToAgent.set(newId, agentId);
    s.items = [];
    try { updateAgent(s.agent.projectId, agentId, { codexThreadId: newId }); }
    catch { /* non-fatal */ }
    upsert(s, {
      id: randomUUID(), kind: 'system',
      text: `New thread — ${newId.slice(0, 8)}`, ts: now(),
    });
    return true;
  } catch (err) {
    console.error('[codex-agents] newThread failed:', err);
    return false;
  }
}

/** List the models codex offers — for the UI model picker. */
export async function listModels(): Promise<string[]> {
  if (!server) return [];
  try {
    await server.ensureStarted();
    const r = await server.request('model/list', {});
    const data = r?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((m: Record<string, unknown>) => String(m?.id || m?.slug || m?.name || ''))
      .filter(Boolean);
  } catch (err) {
    console.error('[codex-agents] model/list failed:', err);
    return [];
  }
}

export function stopAgent(agentId: string): boolean {
  const s = sessions.get(agentId);
  if (!s) return false;
  threadToAgent.delete(s.threadId);
  sessions.delete(agentId);
  onStatus(agentId, 'stopped');
  if (sessions.size === 0 && server) {
    server.stop();
    server = null;
  }
  return true;
}

/** Terminal input from the composer — buffered into a line, submitted as a turn. */
export function writeToAgent(agentId: string, data: string): void {
  const s = sessions.get(agentId);
  if (!s) return;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      const line = s.inputLine;
      s.inputLine = '';
      if (line.trim()) submitTurn(s, line.trim());
    } else if (ch === '\x7f' || ch === '\b') {
      s.inputLine = s.inputLine.slice(0, -1);
    } else if (ch >= ' ') {
      s.inputLine += ch;
    }
  }
}

/** Inject a message and run it as a turn (the userMessage item renders it). */
export function injectMessage(agentId: string, fromName: string, message: string): boolean {
  const s = sessions.get(agentId);
  if (!s) return false;
  submitTurn(s, `[Message from ${fromName}]: ${message.replace(/\r/g, '').trim()}`);
  return true;
}

export interface CodexAskResult {
  ok: boolean;
  status: 'replied' | 'no-reply' | 'timeout' | 'not-running' | 'error';
  reply: string | null;
  error?: string;
}

const ASK_TIMEOUT_MS = 120_000;

/** Run a turn and wait for the reply — the Codex side of `ask_agent`. */
export async function askAgent(agentId: string, message: string): Promise<CodexAskResult> {
  const s = sessions.get(agentId);
  if (!s || !server) return { ok: false, status: 'not-running', reply: null };
  const cs = server;

  let turnId = '';
  try {
    const r = await cs.request('turn/start', {
      threadId: s.threadId,
      input: [{ type: 'text', text: message }],
    });
    turnId = r?.turn?.id || '';
  } catch (err) {
    return { ok: false, status: 'error', reply: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (!turnId) return { ok: false, status: 'error', reply: null, error: 'turn/start returned no turn id' };

  return new Promise<CodexAskResult>((resolve) => {
    const texts: string[] = [];
    let done = false;
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      if (timedOut) { resolve({ ok: true, status: 'timeout', reply: null }); return; }
      const reply = texts.join('\n\n').trim();
      resolve({ ok: true, status: reply ? 'replied' : 'no-reply', reply: reply || null });
    };
    const off = cs.onNotification((method, raw) => {
      const params = raw as Record<string, any>;
      if (params.threadId !== s.threadId) return;
      if (method === 'item/completed'
        && params.turnId === turnId
        && params.item?.type === 'agentMessage'
        && params.item?.text) {
        texts.push(String(params.item.text));
      }
      if (method === 'turn/completed' && params.turn?.id === turnId) finish(false);
    });
    const timer = setTimeout(() => finish(true), ASK_TIMEOUT_MS);
  });
}

/** No-op — app-server threads have no terminal geometry. */
export function resizeAgent(_agentId: string, _cols: number, _rows: number): void {
  /* intentionally empty */
}

/** Current structured items, for replay when a client attaches. */
export function getItems(agentId: string): CodexItem[] {
  return sessions.get(agentId)?.items.slice() ?? [];
}

/** Subscribe to live structured items. */
export function subscribeItems(agentId: string, listener: ItemListener): () => void {
  const s = sessions.get(agentId);
  if (!s) return () => { /* nothing */ };
  s.listeners.add(listener);
  return () => { sessions.get(agentId)?.listeners.delete(listener); };
}

export function getAgentPreview(agentId: string): string {
  const s = sessions.get(agentId);
  if (!s) return '';
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === 'message' && it.text) {
      return it.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    }
  }
  return '';
}

export function isAgentRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

export function getRunningAgentIds(): string[] {
  return [...sessions.keys()];
}
