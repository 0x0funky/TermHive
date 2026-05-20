/**
 * The Keeper — Termhive's orchestrator brain.
 *
 * A long-lived conversational agent hosted inside the daemon. The user talks
 * to it from the Command panel; it inspects the hive through the Hive
 * Orchestrator MCP and reports back.
 *
 * Runtime: **Codex**. Each turn is a `codex exec` invocation that resumes the
 * conversation's own thread, so context is continuous and — because
 * programmatic Codex is subscription-covered (plan §3) — free.
 *
 * The brain keeps **multiple conversations** (like chat threads); each has its
 * own Codex thread. All of them persist to ~/.termhive/brain/state.json and
 * survive daemon restarts.
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

/** Cap each conversation's transcript so state.json stays small. */
const MAX_HISTORY = 240;
/** Cap how many conversations are kept (oldest dropped beyond this). */
const MAX_CONVERSATIONS = 50;

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
- \`get_project_overview\` — read a project's wiki overview to learn what it does.
- \`read_wiki\` — read a project's wiki pages (its knowledge base).
- \`read_shared\` — read a project's shared content files.
- \`create_project\` — create a new project/team (needs a name + working directory).
- \`create_agent\` — add an agent to a project (claude / codex / gemini / opencode).
- \`start_agent\` — start a stopped agent (it resumes its previous session).
- \`stop_agent\` — stop a running agent (its session is kept; start_agent resumes it).
- \`ask_agent\` — send a question or instruction to one agent and get its reply.
- \`broadcast\` — ask every running agent at once (optionally scoped to a project).

## How to work

1. Use the tools — never guess. Start with \`list_projects\` to see the teams.
   \`get_project_overview\` tells you what a project is about without bothering
   an agent; \`broadcast\` collects status from every running agent in one shot.
2. To get something from an agent, call \`ask_agent(project, agent, message)\`.
   It delivers your message into that agent's live session and returns its reply.
3. **A stopped agent is never a dead end.** If an agent you need is stopped,
   you MUST call \`start_agent\` on it and then \`ask_agent\` — in the same turn.
   \`start_agent\` boots it and resumes its previous session, so it keeps its
   prior context. Starting agents is safe and pre-approved: never ask the user
   for permission first, and never answer with just "the agent is stopped".
   If you started an agent only to check on it, offer to \`stop_agent\` it
   again afterwards so the hive isn't left cluttered with processes the user
   didn't intend to keep running.
4. To set up a new team, use \`create_project\` — it needs a working directory,
   so if the user didn't give one, ask. To add a team member, use
   \`create_agent\` (then \`start_agent\` it if they want it running). These
   create lasting structure — confirm the name, directory, and CLI with the
   user if anything is unclear.
5. Synthesize. Don't dump raw tool output — give a short, clear summary.
   Surface blockers and anything that needs a decision from the user.
6. Be concise. A few sentences or a short list. This is a chat panel.

## Boundaries (Phase 1)

- You are **advisory**. Inspecting agents, starting and stopping them, asking
  them questions, and creating projects/agents **when the user asks** are all safe.
- Never create a project or agent the user didn't ask for.
- Relay an instruction that changes code or deploys only when the user
  explicitly asks. Do not invent work on your own.
- Do not run shell commands. Use only the \`hive\` tools.
- Never pretend you reached an agent you didn't.
`;

/** One brain conversation — its own Codex thread and transcript. */
interface Conversation {
  id: string;
  title: string;
  threadId: string | null;
  messages: BrainMessage[];
  createdAt: string;
  updatedAt: string;
}

interface PersistedState {
  conversations: Conversation[];
  currentId: string;
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
  private conversations: Conversation[] = [];
  private currentId = '';
  private status: BrainStatus = 'idle';
  private busy = false;

  private readonly hiveMcpPath = path.resolve(__dirname_, '../hive-mcp-server.js');

  constructor(private readonly emit: (ev: BrainEvent) => void) {
    this.load();
  }

  // ─────────────────────────── Public API ───────────────────────────

  getState(): BrainState {
    const cur = this.current();
    return {
      messages: cur.messages,
      status: this.status,
      engine: 'codex',
      currentId: this.currentId,
      conversations: [...this.conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          messageCount: c.messages.length,
        })),
    };
  }

  /** Start a fresh conversation (keeps the existing ones). */
  newConversation(): void {
    const conv = this.makeConversation();
    this.conversations.push(conv);
    this.trimConversations();
    this.currentId = conv.id;
    this.save();
    this.emitState();
  }

  /** Switch the active conversation. */
  switchConversation(id: string): void {
    if (id === this.currentId) return;
    if (!this.conversations.some((c) => c.id === id)) return;
    this.currentId = id;
    this.save();
    this.emitState();
  }

  /** Delete a conversation. Always keeps at least one. */
  deleteConversation(id: string): void {
    const idx = this.conversations.findIndex((c) => c.id === id);
    if (idx < 0) return;
    this.conversations.splice(idx, 1);
    if (this.conversations.length === 0) {
      this.conversations.push(this.makeConversation());
    }
    if (this.currentId === id) {
      this.currentId = [...this.conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
    }
    this.save();
    this.emitState();
  }

  /** Run one brain turn for a user message. */
  async send(message: string): Promise<void> {
    const text = message.trim();
    if (!text) return;

    // The turn targets whichever conversation is current right now; capture it
    // so a mid-turn switch doesn't misroute the streamed messages.
    const conv = this.current();

    if (this.busy) {
      this.append(conv, {
        role: 'system',
        text: 'The Keeper is still working on the previous request — one moment.',
      });
      return;
    }

    this.busy = true;
    if (conv.messages.length === 0) conv.title = makeTitle(text);
    this.append(conv, { role: 'user', text });
    this.setStatus('thinking');

    try {
      await this.runCodexTurn(conv, text);
    } catch (err) {
      this.append(conv, {
        role: 'error',
        text: 'Brain turn failed: ' + (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      this.busy = false;
      this.setStatus('idle');
      this.save();
      this.emitState(); // refresh the conversation list (title / updatedAt / count)
    }
  }

  // ─────────────────────────── Codex turn ───────────────────────────

  private runCodexTurn(conv: Conversation, prompt: string): Promise<void> {
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
    const args = conv.threadId
      ? ['exec', 'resume', conv.threadId, ...turnArgs]
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
        this.append(conv, {
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
          if (line && this.handleCodexLine(conv, line)) producedAssistant = true;
        }
      });

      child.stderr?.on('data', (d: Buffer) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
      });

      child.on('error', (err) => {
        this.append(conv, {
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
            this.append(conv, { role: 'assistant', text: last });
          } else if (code !== 0) {
            const detail = stderrBuf.trim().split('\n').slice(-4).join('\n');
            this.append(conv, {
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
  private handleCodexLine(conv: Conversation, line: string): boolean {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { return false; }

    const type = obj.type;
    if (type === 'thread.started') {
      const id = obj.thread_id;
      if (typeof id === 'string' && id) { conv.threadId = id; this.save(); }
      return false;
    }
    if (type === 'item.completed') {
      const msg = this.itemToMessage(obj.item as Record<string, unknown> | undefined);
      if (msg) {
        this.append(conv, msg);
        return msg.role === 'assistant';
      }
      return false;
    }
    if (type === 'turn.failed' || type === 'error') {
      const e = (obj.error || obj) as { message?: string };
      this.append(conv, { role: 'error', text: e.message || 'Brain turn failed.' });
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
      return { role: 'tool', tool: server + name, text: summary.slice(0, 600) };
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

  private current(): Conversation {
    return this.conversations.find((c) => c.id === this.currentId) || this.conversations[0];
  }

  private makeConversation(): Conversation {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title: 'New conversation',
      threadId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Drop the oldest conversations beyond the cap. */
  private trimConversations(): void {
    if (this.conversations.length <= MAX_CONVERSATIONS) return;
    this.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.conversations = this.conversations.slice(0, MAX_CONVERSATIONS);
  }

  private append(conv: Conversation, m: Omit<BrainMessage, 'id' | 'ts'>): void {
    const message: BrainMessage = { id: randomUUID(), ts: new Date().toISOString(), ...m };
    conv.messages.push(message);
    if (conv.messages.length > MAX_HISTORY) {
      conv.messages.splice(0, conv.messages.length - MAX_HISTORY);
    }
    conv.updatedAt = message.ts;
    this.emit({ kind: 'append', conversationId: conv.id, message });
  }

  private setStatus(status: BrainStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ kind: 'status', status });
  }

  private emitState(): void {
    this.emit({ kind: 'state', state: this.getState() });
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
        if (Array.isArray(data.conversations) && data.conversations.length > 0) {
          this.conversations = data.conversations;
          this.currentId = typeof data.currentId === 'string' ? data.currentId : '';
        } else if (Array.isArray(data.messages)) {
          // Migrate the old single-conversation shape ({ threadId, messages }).
          const conv = this.makeConversation();
          conv.threadId = typeof data.threadId === 'string' ? data.threadId : null;
          conv.messages = data.messages;
          const firstUser = data.messages.find((m: BrainMessage) => m?.role === 'user');
          if (firstUser) conv.title = makeTitle(firstUser.text);
          this.conversations = [conv];
          this.currentId = conv.id;
        }
      }
    } catch {
      this.conversations = [];
    }
    if (this.conversations.length === 0) {
      const conv = this.makeConversation();
      this.conversations = [conv];
      this.currentId = conv.id;
    }
    if (!this.conversations.some((c) => c.id === this.currentId)) {
      this.currentId = this.conversations[0].id;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(BRAIN_DIR, { recursive: true });
      const data: PersistedState = {
        conversations: this.conversations,
        currentId: this.currentId,
      };
      fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* best-effort persistence */ }
  }
}

/** Make a short conversation title from the first user message. */
function makeTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  return t.length > 48 ? t.slice(0, 48) + '…' : t;
}
