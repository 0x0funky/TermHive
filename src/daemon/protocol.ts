/**
 * Wire protocol between the Termhive web server and the termhive-daemon.
 *
 * The daemon owns all PTY/agent processes and outlives the web server, so the
 * web server can restart freely without killing agents. They talk over a
 * local-only WebSocket.
 */

export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_PORT = parseInt(process.env.TERMHIVE_DAEMON_PORT || '3210', 10);
export const DAEMON_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}`;
/** HTTP base — the daemon serves hook callbacks and the Hive org API here. */
export const DAEMON_HTTP_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`;

// ─────────────────────────── Orchestrator brain ───────────────────────────
// v2.3: "The Keeper" — a long-lived orchestrator brain hosted in the daemon.

/** A rendered turn item in the brain conversation (for UI replay). */
export interface BrainMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system' | 'error';
  text: string;
  ts: string;
  /** For role === 'tool': the tool name (e.g. "hive/ask_agent"). */
  tool?: string;
}

export type BrainStatus = 'idle' | 'thinking';

/** Lightweight conversation entry for the Command panel's switcher. */
export interface BrainConversationMeta {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** Snapshot of the brain — returned by `brain:state` and `state` events. */
export interface BrainState {
  /** Messages of the *current* conversation. */
  messages: BrainMessage[];
  status: BrainStatus;
  /** Which CLI powers the brain — Phase 1 is always 'codex'. */
  engine: 'codex' | 'claude';
  /** Id of the current conversation. */
  currentId: string;
  /** All conversations, newest first — for the switcher. */
  conversations: BrainConversationMeta[];
}

/** Streamed daemon → web while the brain works and when conversations change. */
export type BrainEvent =
  | { kind: 'append'; conversationId: string; message: BrainMessage }
  | { kind: 'status'; status: BrainStatus }
  | { kind: 'state'; state: BrainState };

/**
 * Emitted when the orchestrator dispatches to an agent (ask_agent / broadcast),
 * so the web server can record it in the activity feed — the brain's actions
 * become visible in the Messages panel like agent-to-agent messages.
 */
export interface AgentDispatch {
  projectId: string;
  projectName: string;
  agentName: string;
  fromName: string;
  message: string;
  status: string;
  reply?: string | null;
}

/**
 * Web → Daemon. Messages with an `id` expect a `reply`; messages without an
 * `id` are fire-and-forget commands.
 */
export type DaemonRequest =
  // --- RPC (expect a reply) ---
  | { id: string; op: 'agent:start'; projectId: string; agentId: string }
  | { id: string; op: 'agent:stop'; agentId: string }
  | { id: string; op: 'agent:restart'; projectId: string; agentId: string }
  | { id: string; op: 'agent:cleanup'; projectId: string; agentId: string }
  | { id: string; op: 'agent:inject'; agentId: string; fromName: string; message: string }
  | { id: string; op: 'agent:isRunning'; agentId: string }
  | { id: string; op: 'agent:preview'; agentId: string }
  | { id: string; op: 'agent:runningIds' }
  | { id: string; op: 'agent:statuses' }
  | { id: string; op: 'brain:state' }
  // --- Fire-and-forget commands ---
  | { op: 'terminal:attach'; agentId: string }
  | { op: 'terminal:detach'; agentId: string }
  | { op: 'terminal:input'; agentId: string; data: string }
  | { op: 'terminal:resize'; agentId: string; cols: number; rows: number }
  | { op: 'brain:send'; message: string }
  | { op: 'brain:new' }
  | { op: 'brain:switch'; conversationId: string }
  | { op: 'brain:delete'; conversationId: string };

/** Daemon → Web. */
export type DaemonMessage =
  | { kind: 'hello'; pid: number; startedAt: string }
  | { kind: 'reply'; id: string; ok: true; result: unknown }
  | { kind: 'reply'; id: string; ok: false; error: string }
  | { kind: 'event'; event: 'terminal:output'; agentId: string; data: string }
  | { kind: 'event'; event: 'agent:status'; agentId: string; status: string }
  | { kind: 'event'; event: 'brain:event'; payload: BrainEvent }
  | { kind: 'event'; event: 'agent:dispatch'; payload: AgentDispatch }
  | { kind: 'event'; event: 'org:changed' };

/** Result shapes for each RPC op (for type-safe clients). */
export interface DaemonRpcResults {
  'agent:start': { ok: boolean };
  'agent:stop': { ok: boolean };
  'agent:restart': { ok: boolean };
  'agent:cleanup': { ok: boolean };
  'agent:inject': { delivered: boolean };
  'agent:isRunning': { running: boolean };
  'agent:preview': { preview: string };
  'agent:runningIds': { ids: string[] };
  'agent:statuses': { statuses: Record<string, string> };
  'brain:state': BrainState;
}
