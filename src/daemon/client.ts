/**
 * DaemonClient — used by the web server to talk to termhive-daemon.
 *
 * Handles connect + auto-reconnect, RPC request/response correlation, and
 * fan-out of streaming events (terminal output, agent status) to listeners.
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import {
  DAEMON_URL,
  type DaemonMessage,
  type DaemonRpcResults,
  type BrainEvent,
  type AgentDispatch,
} from './protocol.js';

type OutputListener = (agentId: string, data: string) => void;
type StatusListener = (agentId: string, status: string) => void;
type BrainListener = (payload: BrainEvent) => void;
type DispatchListener = (payload: AgentDispatch) => void;
type OrgChangedListener = () => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DaemonClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private readonly pending = new Map<string, Pending>();
  private readonly outputListeners = new Set<OutputListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly brainListeners = new Set<BrainListener>();
  private readonly dispatchListeners = new Set<DispatchListener>();
  private readonly orgChangedListeners = new Set<OrgChangedListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outbox: string[] = []; // queued while disconnected

  constructor(private readonly url: string = DAEMON_URL) {}

  connect(): void {
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      console.log('[daemon-client] connected to daemon');
      // Flush anything queued while we were down
      for (const msg of this.outbox.splice(0)) {
        ws.send(msg);
      }
    });

    ws.on('message', (raw) => {
      let msg: DaemonMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.dispatch(msg);
    });

    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.warn('[daemon-client] socket error:', err.message);
      // 'close' will follow and trigger reconnect
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private dispatch(msg: DaemonMessage): void {
    switch (msg.kind) {
      case 'hello':
        console.log(`[daemon-client] daemon ready (pid ${msg.pid}, up since ${msg.startedAt})`);
        break;
      case 'reply': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        break;
      }
      case 'event':
        if (msg.event === 'terminal:output') {
          for (const l of this.outputListeners) l(msg.agentId, msg.data);
        } else if (msg.event === 'agent:status') {
          for (const l of this.statusListeners) l(msg.agentId, msg.status);
        } else if (msg.event === 'brain:event') {
          for (const l of this.brainListeners) l(msg.payload);
        } else if (msg.event === 'agent:dispatch') {
          for (const l of this.dispatchListeners) l(msg.payload);
        } else if (msg.event === 'org:changed') {
          for (const l of this.orgChangedListeners) l();
        }
        break;
    }
  }

  private raw(json: string): void {
    if (this.connected && this.ws) {
      this.ws.send(json);
    } else {
      this.outbox.push(json);
      this.connect();
    }
  }

  /** RPC call — resolves with the typed result or rejects on daemon error. */
  request<K extends keyof DaemonRpcResults>(
    op: K,
    params: Record<string, unknown> = {},
  ): Promise<DaemonRpcResults[K]> {
    const id = randomUUID();
    return new Promise<DaemonRpcResults[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon RPC timeout: ${op}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.raw(JSON.stringify({ id, op, ...params }));
    });
  }

  /** Fire-and-forget command (no reply expected). */
  command(cmd: Record<string, unknown>): void {
    this.raw(JSON.stringify(cmd));
  }

  attachTerminal(agentId: string): void {
    this.command({ op: 'terminal:attach', agentId });
  }
  detachTerminal(agentId: string): void {
    this.command({ op: 'terminal:detach', agentId });
  }
  writeTerminal(agentId: string, data: string): void {
    this.command({ op: 'terminal:input', agentId, data });
  }
  resizeTerminal(agentId: string, cols: number, rows: number): void {
    this.command({ op: 'terminal:resize', agentId, cols, rows });
  }

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  onBrain(listener: BrainListener): () => void {
    this.brainListeners.add(listener);
    return () => this.brainListeners.delete(listener);
  }
  onDispatch(listener: DispatchListener): () => void {
    this.dispatchListeners.add(listener);
    return () => this.dispatchListeners.delete(listener);
  }
  onOrgChanged(listener: OrgChangedListener): () => void {
    this.orgChangedListeners.add(listener);
    return () => this.orgChangedListeners.delete(listener);
  }

  /** Send a user message to the orchestrator brain (fire-and-forget). */
  sendBrain(message: string): void {
    this.command({ op: 'brain:send', message });
  }
  /** Reset the orchestrator brain conversation (fire-and-forget). */
  resetBrain(): void {
    this.command({ op: 'brain:reset' });
  }

  isConnected(): boolean {
    return this.connected;
  }
}
