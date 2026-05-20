/**
 * codex-server.ts — client for `codex app-server`.
 *
 * v2.2: Codex agents run as threads inside a single long-lived
 * `codex app-server` process, which speaks JSON-RPC 2.0 as newline-delimited
 * JSON over stdio (the `"jsonrpc"` field is omitted on the wire).
 *
 * This module owns that process:
 *   - spawn + `initialize` handshake
 *   - request/response correlation by id
 *   - notification fan-out (turn/thread/item events)
 *   - server→client requests (approvals) handled via an injectable handler
 *   - auto-respawn — call `ensureStarted()` before any operation
 *
 * It is transport only — turning Codex agents into app-server threads, and
 * rendering their events, is layered on top (Stage 2+).
 */

import { spawn, type ChildProcess } from 'child_process';

type NotifListener = (method: string, params: Record<string, unknown>) => void;
/**
 * Handle a server→client request (e.g. an approval prompt). Returns the
 * JSON-RPC `result` payload to send back.
 */
export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => unknown;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const isWin = process.platform === 'win32';

/** JSON-RPC requests are quick (the long work arrives as notifications). */
const REQUEST_TIMEOUT_MS = 60_000;

export class CodexAppServer {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buf = '';
  private starting: Promise<void> | null = null;

  private readonly pending = new Map<number, Pending>();
  private readonly notifListeners = new Set<NotifListener>();
  private readonly exitListeners = new Set<() => void>();
  /** Default: approve nothing of substance — Stage 2+ installs a real one. */
  private serverRequestHandler: ServerRequestHandler = () => ({});

  /** Install the handler for server→client requests (approvals etc.). */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Subscribe to app-server notifications (turn/thread/item events). */
  onNotification(listener: NotifListener): () => void {
    this.notifListeners.add(listener);
    return () => this.notifListeners.delete(listener);
  }

  /** Subscribe to app-server process exits (so threads can be re-resumed). */
  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /** Ensure the app-server is running and handshaked. Safe to call often. */
  async ensureStarted(): Promise<void> {
    if (this.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = this.spawnAndHandshake().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async spawnAndHandshake(): Promise<void> {
    const proc = spawn('codex', ['app-server'], {
      shell: isWin,
      windowsHide: true,
      env: process.env as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.buf = '';

    proc.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString()));
    proc.stderr?.on('data', () => { /* app-server diagnostics — ignored */ });

    proc.on('exit', () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('codex app-server exited'));
      }
      this.pending.clear();
      this.proc = null;
      for (const l of this.exitListeners) l();
    });
    proc.on('error', (err) => {
      console.error('[codex-server] spawn error:', err.message);
      this.proc = null;
    });

    // Handshake: initialize request, then the initialized notification.
    await this.request('initialize', {
      clientInfo: { name: 'termhive', title: 'Termhive', version: '0.1.0' },
    });
    this.notify('initialized', {});
    console.log('[codex-server] codex app-server ready');
  }

  // ─────────────────────────── Wire I/O ───────────────────────────

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, any>;
    try { msg = JSON.parse(line); } catch { return; }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(msg.error?.message || `codex app-server error (${msg.error?.code})`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Server→client request — we must reply with the same id.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      let result: unknown;
      try { result = this.serverRequestHandler(msg.method, msg.params || {}); }
      catch { result = {}; }
      this.send({ id: msg.id, result });
      return;
    }

    // Notification.
    if (typeof msg.method === 'string') {
      for (const l of this.notifListeners) {
        try { l(msg.method, msg.params || {}); }
        catch (err) { console.error('[codex-server] notification listener error:', err); }
      }
    }
  }

  private send(obj: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc || !proc.stdin?.writable) return;
    try { proc.stdin.write(JSON.stringify(obj) + '\n'); }
    catch (err) { console.error('[codex-server] write error:', err); }
  }

  // ─────────────────────────── RPC ───────────────────────────

  /** Send a JSON-RPC request; resolves with `result` or rejects on error. */
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin?.writable) {
        reject(new Error('codex app-server not running'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  /** Send a fire-and-forget JSON-RPC notification. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ method, params });
  }

  /** Kill the app-server process. */
  stop(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* best-effort */ }
      this.proc = null;
    }
  }
}
