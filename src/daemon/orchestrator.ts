/**
 * The Keeper — Termhive's orchestrator brain.
 *
 * A long-lived conversational agent hosted inside the daemon. The user talks
 * to it from the Command panel; it inspects the hive through the Hive
 * Orchestrator MCP and reports back.
 *
 * Runtime (v2.3 Phase 1): **Codex**. Each turn is a `codex exec` invocation
 * that resumes the brain's own thread, so the conversation is continuous and
 * — because programmatic Codex is subscription-covered (plan §3) — free.
 *
 * The brain runs with a dedicated `CODEX_HOME` so its Hive MCP wiring never
 * touches the user's own Codex config or the project agents.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { BrainEvent, BrainMessage, BrainState, BrainStatus } from './protocol.js';
import { DAEMON_HTTP_URL } from './protocol.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

/** Cap the persisted transcript so state.json stays small. */
const MAX_HISTORY = 240;

const BRAIN_DIR = path.join(os.homedir(), '.termhive', 'brain');
const CODEX_HOME = path.join(BRAIN_DIR, 'codex-home');
const STATE_PATH = path.join(BRAIN_DIR, 'state.json');
const AGENTS_MD_PATH = path.join(BRAIN_DIR, 'AGENTS.md');

/** The brain's persona + operating rules — loaded by Codex as AGENTS.md. */
const AGENTS_MD = `# The Keeper — Termhive Orchestrator Brain

You are **The Keeper**, the orchestrator brain of Termhive — a command center
for a team of coding CLI agents. The user talks to you in plain language; you
inspect the hive and report back. Act like a sharp chief-of-staff: concise,
accurate, and proactive about what needs the user's attention.

## Your tools (MCP server \`hive\`)

- \`list_projects\` — every project and its agents, with live status.
- \`list_agents\` — the agents of one project, in detail.
- \`get_agent_status\` — the live status of one agent.
- \`ask_agent\` — send a question or instruction to one agent and get its reply.

## How to work

1. Use the tools — never guess. If you don't know the teams yet, start with
   \`list_projects\`.
2. To get something from an agent, call \`ask_agent(project, agent, message)\`.
   It delivers your message into that agent's live session and returns the
   agent's answer.
3. Synthesize. Don't dump raw tool output — give a short, clear summary.
   Surface blockers and anything that needs a decision from the user.
4. Be concise. A few sentences or a short list. This is a chat panel.

## Boundaries (Phase 1)

- You are **advisory**. Inspect agents and ask them questions freely.
- Relay an instruction to an agent only when the user explicitly asks you to.
  Do not invent work or change code on your own.
- Do not run shell commands. Use only the \`hive\` tools.
- If an agent is not running, say so — never pretend you reached it.
`;

interface PersistedState {
  threadId: string | null;
  messages: BrainMessage[];
}

/** TOML basic-string literal with proper escaping (Windows paths included). */
function tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** cmd.exe-safe quoting — only needed when spawning with `shell: true`. */
function winQuote(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t"&|<>()^%]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

export class Orchestrator {
  private threadId: string | null = null;
  private messages: BrainMessage[] = [];
  private status: BrainStatus = 'idle';
  private busy = false;

  private readonly hiveMcpPath = path.resolve(__dirname_, '../hive-mcp-server.js');

  constructor(private readonly emit: (ev: BrainEvent) => void) {
    this.load();
  }

  // ─────────────────────────── Public API ───────────────────────────

  getState(): BrainState {
    return { messages: this.messages, status: this.status, engine: 'codex' };
  }

  /** Wipe the conversation and start a fresh Codex thread. */
  reset(): void {
    this.threadId = null;
    this.messages = [];
    this.status = 'idle';
    this.busy = false;
    this.save();
    this.emit({ kind: 'reset' });
  }

  /** Run one brain turn for a user message. */
  async send(message: string): Promise<void> {
    const text = message.trim();
    if (!text) return;

    if (this.busy) {
      this.append({
        role: 'system',
        text: 'The Keeper is still working on the previous request — one moment.',
      });
      return;
    }

    this.busy = true;
    this.append({ role: 'user', text });
    this.setStatus('thinking');

    try {
      await this.runCodexTurn(text);
    } catch (err) {
      this.append({
        role: 'error',
        text: 'Brain turn failed: ' + (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      this.busy = false;
      this.setStatus('idle');
      this.save();
    }
  }

  // ─────────────────────────── Codex turn ───────────────────────────

  private runCodexTurn(prompt: string): Promise<void> {
    this.ensureBrainEnv();

    const outFile = path.join(BRAIN_DIR, `lastmsg-${Date.now()}.txt`);
    // The brain runs non-interactively, so nobody can answer Codex approval
    // prompts — and under the default `never` policy every gated call (which
    // includes MCP tool calls) is auto-cancelled. `--dangerously-bypass-...`
    // is Codex's supported flag for headless automation. It is safe here: the
    // brain's only capability is the Hive MCP toolset (its AGENTS.md forbids
    // shell use), and real write-actions still flow through sandboxed agents.
    const turnArgs = [
      '--dangerously-bypass-approvals-and-sandbox',
      '--json', '--skip-git-repo-check', '-o', outFile, '-',
    ];
    const args = this.threadId
      ? ['exec', 'resume', this.threadId, ...turnArgs]
      : ['exec', '--cd', BRAIN_DIR, ...turnArgs];

    const isWin = process.platform === 'win32';
    const spawnArgs = isWin ? args.map(winQuote) : args;

    return new Promise<void>((resolve) => {
      let child;
      try {
        child = spawn('codex', spawnArgs, {
          cwd: BRAIN_DIR,
          env: { ...process.env, CODEX_HOME },
          shell: isWin,
          windowsHide: true,
        });
      } catch (err) {
        this.append({
          role: 'error',
          text: 'Could not start Codex. Is the `codex` CLI installed and on PATH? ' +
            (err instanceof Error ? err.message : String(err)),
        });
        resolve();
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      let producedAssistant = false;

      child.stdin?.on('error', () => { /* ignore broken pipe */ });
      child.stdin?.write(prompt);
      child.stdin?.end();

      child.stdout?.on('data', (d: Buffer) => {
        stdoutBuf += d.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line && this.handleCodexLine(line)) producedAssistant = true;
        }
      });

      child.stderr?.on('data', (d: Buffer) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
      });

      child.on('error', (err) => {
        this.append({
          role: 'error',
          text: 'Could not start Codex (`codex` CLI not found?): ' + err.message,
        });
        resolve();
      });

      child.on('close', (code) => {
        // Safety net: if no agent_message streamed through, fall back to the
        // canonical last-message file Codex wrote.
        if (!producedAssistant) {
          let last = '';
          try {
            if (fs.existsSync(outFile)) last = fs.readFileSync(outFile, 'utf-8').trim();
          } catch { /* ignore */ }
          if (last) {
            this.append({ role: 'assistant', text: last });
          } else if (code !== 0) {
            const detail = stderrBuf.trim().split('\n').slice(-4).join('\n');
            this.append({
              role: 'error',
              text: `Codex exited with code ${code}.` + (detail ? `\n${detail}` : ''),
            });
          }
        }
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
        resolve();
      });
    });
  }

  /** Parse one Codex `--json` event line. Returns true if it was an answer. */
  private handleCodexLine(line: string): boolean {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { return false; }

    const type = obj.type;
    if (type === 'thread.started') {
      const id = obj.thread_id;
      if (typeof id === 'string' && id) { this.threadId = id; this.save(); }
      return false;
    }
    if (type === 'item.completed') {
      const msg = this.itemToMessage(obj.item as Record<string, unknown> | undefined);
      if (msg) {
        this.append(msg);
        return msg.role === 'assistant';
      }
      return false;
    }
    if (type === 'turn.failed' || type === 'error') {
      const e = (obj.error || obj) as { message?: string };
      this.append({ role: 'error', text: e.message || 'Brain turn failed.' });
      return false;
    }
    return false;
  }

  /** Map a Codex turn item to a renderable brain message (or null to skip). */
  private itemToMessage(item: Record<string, unknown> | undefined): Omit<BrainMessage, 'id' | 'ts'> | null {
    if (!item) return null;
    const type = String(item.type || '');

    if (type === 'agent_message') {
      const text = String(item.text || '').trim();
      return text ? { role: 'assistant', text } : null;
    }
    if (type === 'reasoning') {
      const text = String(item.text || item.summary || '').trim();
      return text ? { role: 'reasoning', text } : null;
    }
    if (type === 'command_execution') {
      const cmd = String(item.command || item.cmd || '(command)');
      return { role: 'tool', tool: 'shell', text: '$ ' + cmd };
    }
    if (type === 'mcp_tool_call' || type.includes('mcp') || type.includes('tool_call')) {
      const name = String(item.tool || item.name || item.tool_name || 'tool');
      const server = item.server ? `${item.server}/` : '';
      let summary = '';
      const rawArgs = item.arguments ?? item.input ?? item.args;
      if (rawArgs !== undefined) {
        try { summary = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs); }
        catch { summary = ''; }
      }
      return { role: 'tool', tool: server + name, text: summary.slice(0, 240) };
    }
    if (type === 'error') {
      return { role: 'error', text: String(item.message || 'error') };
    }
    // todo_list / file_change / web_search / etc. — not surfaced in Phase 1.
    return null;
  }

  // ─────────────────────────── Brain environment ───────────────────────────

  /** Write the brain's AGENTS.md + dedicated Codex home (config + auth). */
  private ensureBrainEnv(): void {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
    fs.mkdirSync(CODEX_HOME, { recursive: true });

    fs.writeFileSync(AGENTS_MD_PATH, AGENTS_MD, 'utf-8');

    // Dedicated Codex config — only the Hive MCP server + the user's model.
    const config = [
      '# Termhive Orchestrator brain — managed by Termhive. Do not edit.',
      this.userCodexModelConfig(),
      '',
      '[mcp_servers.hive]',
      `command = ${tomlStr(process.execPath)}`,
      `args = [${[this.hiveMcpPath, '--daemon', DAEMON_HTTP_URL].map(tomlStr).join(', ')}]`,
      '',
    ].filter((l) => l !== '').join('\n') + '\n';
    fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), config, 'utf-8');

    // Copy the user's Codex auth so the brain inherits their subscription.
    try {
      const src = path.join(os.homedir(), '.codex', 'auth.json');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(CODEX_HOME, 'auth.json'));
      }
    } catch { /* the brain may still authenticate via env / OPENAI_API_KEY */ }
  }

  /** Inherit `model` / `service_tier` from the user's Codex config, if set. */
  private userCodexModelConfig(): string {
    const out: string[] = [];
    try {
      const userCfg = path.join(os.homedir(), '.codex', 'config.toml');
      if (fs.existsSync(userCfg)) {
        for (const raw of fs.readFileSync(userCfg, 'utf-8').split('\n')) {
          const line = raw.trim();
          if (line.startsWith('[')) break; // top-level scalars only
          if (/^(model|service_tier)\s*=/.test(line)) out.push(line);
        }
      }
    } catch { /* fall back to Codex defaults */ }
    return out.join('\n');
  }

  // ─────────────────────────── State ───────────────────────────

  private append(m: Omit<BrainMessage, 'id' | 'ts'>): void {
    const message: BrainMessage = { id: randomUUID(), ts: new Date().toISOString(), ...m };
    this.messages.push(message);
    if (this.messages.length > MAX_HISTORY) {
      this.messages.splice(0, this.messages.length - MAX_HISTORY);
    }
    this.emit({ kind: 'append', message });
  }

  private setStatus(status: BrainStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ kind: 'status', status });
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as PersistedState;
        this.threadId = data.threadId ?? null;
        this.messages = Array.isArray(data.messages) ? data.messages : [];
      }
    } catch {
      this.threadId = null;
      this.messages = [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(BRAIN_DIR, { recursive: true });
      const data: PersistedState = { threadId: this.threadId, messages: this.messages };
      fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* best-effort persistence */ }
  }
}
