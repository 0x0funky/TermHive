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
  // --- Fire-and-forget commands ---
  | { op: 'terminal:attach'; agentId: string }
  | { op: 'terminal:detach'; agentId: string }
  | { op: 'terminal:input'; agentId: string; data: string }
  | { op: 'terminal:resize'; agentId: string; cols: number; rows: number };

/** Daemon → Web. */
export type DaemonMessage =
  | { kind: 'hello'; pid: number; startedAt: string }
  | { kind: 'reply'; id: string; ok: true; result: unknown }
  | { kind: 'reply'; id: string; ok: false; error: string }
  | { kind: 'event'; event: 'terminal:output'; agentId: string; data: string }
  | { kind: 'event'; event: 'agent:status'; agentId: string; status: string };

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
}
