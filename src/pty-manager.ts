import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Agent } from './types.js';
import { updateAgent, getProjectData, SHARED_CONTENT_DIR, WIKI_DIR } from './storage.js';
import { writeClaudeMcpConfig, writeCodexMcpConfig, removeClaudeMcpConfig, removeCodexMcpConfig, getClaudeMcpConfigPath } from './mcp-config.js';
import { writeClaudeHookConfig, removeClaudeHookConfig } from './hook-config.js';
import { DAEMON_HOST, DAEMON_PORT } from './daemon/protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname_ = path.dirname(__filename);

/** Base URL the daemon serves hook callbacks on (HTTP on the daemon's port). */
function getHookBaseUrl(): string {
  return `http://${DAEMON_HOST}:${DAEMON_PORT}`;
}

/**
 * Absolute path to the compiled MCP server entry (dist/mcp-server.js).
 * tsup builds mcp-server.ts alongside server.ts in the same dist folder.
 */
function getMcpServerPath(): string {
  return path.resolve(__dirname_, 'mcp-server.js');
}

/**
 * Hub URL that the spawned MCP server will call back to. Matches the port
 * that server.ts listens on.
 */
function getHubUrl(): string {
  return process.env.TERMHIVE_HUB_URL || `http://localhost:${process.env.PORT || '3200'}`;
}

/** Expand leading ~ to the user's home directory */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Normalize for path equality — case-insensitive + forward slashes on Windows. */
function normalizePath(p: string): string {
  let n = path.resolve(p).replace(/\\/g, '/');
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

/**
 * Claude Code stores project session transcripts under
 *   ~/.claude/projects/<slug>/<sessionId>.jsonl
 * where <slug> is cwd with every non-alphanumeric character replaced by `-`.
 * Returns true if at least one .jsonl exists for this cwd (→ `claude -c` is safe).
 */
function hasClaudeSessionFor(cwd: string): boolean {
  try {
    const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', slug);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/**
 * Codex CLI stores session rollout files at
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * The cwd is embedded inside each file's first line (type:"session_meta").
 * We scan the 30 most recent rollouts and return true if any was recorded for
 * this cwd → `codex resume --last` is safe and will pick it up.
 *
 * `codex resume` is already cwd-filtered by default (the `--all` flag is what
 * disables that filtering), so `--last` will pick the most recent session for
 * the current working directory — exactly like `claude -c`.
 */
function hasCodexSessionFor(cwd: string): boolean {
  try {
    const root = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(root)) return false;

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.isFile() &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith('.jsonl')
        ) {
          files.push(full);
        }
      }
    };
    walk(root);

    // Filename carries the timestamp, so descending name sort == newest first
    files.sort((a, b) => b.localeCompare(a));

    const target = normalizePath(cwd);
    for (const f of files.slice(0, 30)) {
      try {
        // Only need the first line (session_meta)
        const firstLine = fs.readFileSync(f, 'utf-8').split('\n', 1)[0];
        if (!firstLine) continue;
        const obj = JSON.parse(firstLine);
        const sessionCwd = obj?.payload?.cwd || obj?.cwd;
        if (sessionCwd && normalizePath(sessionCwd) === target) return true;
      } catch {
        /* skip malformed file */
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Dynamic import for node-pty (optional dependency)
let pty: typeof import('node-pty') | null = null;
try {
  pty = await import('node-pty');
} catch {
  console.warn('node-pty not available — terminal spawning disabled. Install node-pty to enable.');
}

type IPty = import('node-pty').IPty;

interface PtySession {
  pty: IPty;
  agent: Agent;
  listeners: Set<(data: string) => void>;
  buffer: string[];
}

const sessions = new Map<string, PtySession>();
const MAX_BUFFER = 5000;

/**
 * Get the shared content directory path for a project.
 */
function getSharedPath(projectName: string): string {
  return path.join(SHARED_CONTENT_DIR, projectName);
}

/**
 * Ensure the shared content directory exists with a README.
 */
function ensureSharedDir(projectName: string): string {
  const sharedPath = getSharedPath(projectName);
  fs.mkdirSync(sharedPath, { recursive: true });
  const readmePath = path.join(sharedPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, [
      `# Shared Content — ${projectName}`,
      '',
      'This folder is shared across all agents in this project via Termhive.',
      'Any file you create, edit, or delete here is visible to all agents and the Termhive web UI.',
      '',
      '## Usage',
      '- Read files here for shared context (API specs, design docs, notes)',
      '- Write files here to share information with other agents or the user',
      '- The user can also view and edit these files from the Termhive "Shared Content" tab',
      '',
    ].join('\n'), 'utf-8');
  }
  return sharedPath;
}

/**
 * Build the Termhive instruction section content.
 */
function buildTermhiveSection(
  sharedPath: string,
  wikiPath: string,
  currentAgent: Agent,
  teammates: Agent[],
): { marker: string; section: string } {
  const marker = '<!-- Termhive -->';
  const hasWiki = fs.existsSync(path.join(wikiPath, '_schema.md'));

  const lines = [
    '',
    marker,
    '## Termhive — Multi-Agent Collaboration',
    '',
    'Shared content directory: `' + sharedPath + '`',
    '- Read/write files here to share information with other agents and the user',
    '',
    'Project wiki directory: `' + wikiPath + '`',
  ];

  if (hasWiki) {
    lines.push(
      '- **Start every session by reading `_index.md`** to understand current project state',
      '- Read `_schema.md` for wiki maintenance conventions',
      '- When asked to "update wiki", follow the schema rules',
      '- Do NOT auto-update wiki while coding — only when explicitly asked',
    );
  } else {
    lines.push(
      '- Wiki not initialized yet. User can initialize it from the Termhive Wiki tab.',
      '- Once initialized, read `_index.md` to understand the project.',
    );
  }

  // Teammates section — only emitted for CLIs that have MCP support (claude, codex)
  const mcpSupported = currentAgent.cli === 'claude' || currentAgent.cli === 'codex';
  if (mcpSupported) {
    lines.push(
      '',
      '### Teammates (other agents in this project)',
      '',
      `You are **${currentAgent.name}**` + (currentAgent.role ? ` (${currentAgent.role})` : '') + '.',
      '',
    );
    if (teammates.length === 0) {
      lines.push('You currently have no teammates. When other agents are added, they will appear here.');
    } else {
      lines.push('Other agents you can message:');
      for (const t of teammates) {
        const role = t.role ? ` — ${t.role}` : '';
        lines.push(`- **${t.name}** (${t.cli})${role}`);
      }
      lines.push(
        '',
        'To send a message to a teammate, use the `message_agent` MCP tool:',
        '- When the user says things like "tell backend I finished the API" or "跟後端說我做完了",',
        '  call `message_agent(target="<teammate name>", message="<what to say>")`.',
        '- The teammate will see your message in their terminal.',
        '- Use `list_teammates` if you need to look up who is available.',
        '- Messages are one-way notifications — do NOT wait for a reply in the same tool call.',
      );
    }
  }

  lines.push('', '<!-- End Termhive -->', '');
  return { marker, section: lines.join('\n') };
}

/**
 * Write Termhive instructions to a markdown file (CLAUDE.md or AGENTS.md).
 */
function ensureInstructionFile(
  filePath: string,
  projectName: string,
  sharedPath: string,
  wikiPath: string,
  currentAgent: Agent,
  teammates: Agent[],
) {
  const { section } = buildTermhiveSection(sharedPath, wikiPath, currentAgent, teammates);

  if (fs.existsSync(filePath)) {
    let existing = fs.readFileSync(filePath, 'utf-8');
    // Remove all old sections (AgentOrg, Termhive Shared Content, previous Termhive)
    existing = existing.replace(/\n*<!-- AgentOrg[^>]*-->[\s\S]*?<!-- End AgentOrg -->\n*/g, '\n');
    existing = existing.replace(/\n*<!-- Termhive[^>]*-->[\s\S]*?<!-- End Termhive -->\n*/g, '\n');
    // Append fresh section
    fs.writeFileSync(filePath, existing.trimEnd() + '\n' + section, 'utf-8');
  } else {
    fs.writeFileSync(filePath, '# ' + projectName + '\n' + section, 'utf-8');
  }
}

function getCliCommand(agent: Agent, sharedPath: string, wikiPath: string, mcpConfigPath: string | null, hookConfigPath: string | null, cwd: string): { cmd: string; args: string[] } {
  const args: string[] = [];
  switch (agent.cli) {
    case 'claude':
      // Auto-resume the most recent conversation for this cwd when one exists.
      // Without a prior session `claude -c` errors, so we only add it when we
      // see a matching transcript on disk.
      if (hasClaudeSessionFor(cwd)) args.push('-c');
      if (agent.flags?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
      if (agent.flags?.remoteControl) args.push('--remote-control');
      args.push('--add-dir', sharedPath);
      args.push('--add-dir', wikiPath);
      if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
      // Lifecycle hooks → daemon status engine (additive to user's settings)
      if (hookConfigPath) args.push('--settings', hookConfigPath);
      return { cmd: 'claude', args };
    case 'codex':
      // Same idea for Codex: `codex resume --last` is cwd-filtered by default
      // (use `--all` to disable), so it picks the most recent session recorded
      // from this cwd. Only add it when we find such a session.
      if (hasCodexSessionFor(cwd)) args.push('resume', '--last');
      // Codex's --add-dir adds *writable* roots, which requires sandbox mode
      // to be at least workspace-write. Default to workspace-write so shared
      // content / wiki are actually writable by the agent.
      args.push('-s', 'workspace-write');
      args.push('--add-dir', sharedPath);
      args.push('--add-dir', wikiPath);
      return { cmd: 'codex', args };
    case 'gemini':
      args.push('--include-directories', sharedPath);
      args.push('--include-directories', wikiPath);
      return { cmd: 'gemini', args };
    case 'opencode':
      if (agent.flags?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
      return { cmd: 'opencode', args };
  }
}

export function startAgent(agent: Agent, onStatus: (agentId: string, status: string) => void): boolean {
  if (!pty) {
    console.error('Cannot start agent: node-pty not available');
    return false;
  }
  if (sessions.has(agent.id)) return true;

  const projectData = getProjectData(agent.projectId);
  if (!projectData) return false;

  const projectName = projectData.project.name;
  const sharedPath = ensureSharedDir(projectName);
  const wikiPath = path.join(WIKI_DIR, projectName);

  const cwd = expandHome(agent.cwd);

  // Resolve teammates (all other agents in the same project)
  const teammates = projectData.agents.filter(a => a.id !== agent.id);

  // Register MCP server for agent-to-agent messaging (Claude + Codex only for now)
  let claudeMcpConfigPath: string | null = null;
  try {
    const mcpCtx = {
      agent,
      agentCwd: cwd,
      hubUrl: getHubUrl(),
      mcpServerPath: getMcpServerPath(),
    };
    if (agent.cli === 'claude') {
      claudeMcpConfigPath = writeClaudeMcpConfig(mcpCtx);
    } else if (agent.cli === 'codex') {
      writeCodexMcpConfig(mcpCtx);
    }
  } catch (err) {
    console.warn(`[pty-manager] Failed to write MCP config for ${agent.name}:`, err);
    // Non-fatal: agent still starts, just without messaging capability
  }

  // Register lifecycle hooks so the daemon can derive precise status (Claude only)
  let claudeHookConfigPath: string | null = null;
  if (agent.cli === 'claude') {
    try {
      claudeHookConfigPath = writeClaudeHookConfig(agent.id, getHookBaseUrl());
    } catch (err) {
      console.warn(`[pty-manager] Failed to write hook config for ${agent.name}:`, err);
      // Non-fatal: agent still starts, status falls back to running/stopped
    }
  }

  // Write instruction file in agent's cwd so the CLI knows about shared content + memory + teammates
  const instructionFiles: Record<string, string> = {
    claude: 'CLAUDE.md',
    codex: 'AGENTS.md',
    gemini: 'AGENTS.md',
    opencode: 'AGENTS.md',
  };
  const instrFile = path.join(cwd, instructionFiles[agent.cli]);
  ensureInstructionFile(instrFile, projectName, sharedPath, wikiPath, agent, teammates);

  const { cmd, args } = getCliCommand(agent, sharedPath, wikiPath, claudeMcpConfigPath, claudeHookConfigPath, cwd);
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

  let proc: IPty;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    console.error(`Failed to spawn PTY for agent ${agent.id}:`, err);
    return false;
  }

  const session: PtySession = {
    pty: proc,
    agent,
    listeners: new Set(),
    buffer: [],
  };
  sessions.set(agent.id, session);

  // Send the CLI command to the shell
  proc.write(`${cmd} ${args.join(' ')}\r`);

  proc.onData((data: string) => {
    session.buffer.push(data);
    if (session.buffer.length > MAX_BUFFER) {
      session.buffer.splice(0, session.buffer.length - MAX_BUFFER);
    }
    for (const listener of session.listeners) {
      listener(data);
    }
  });

  proc.onExit(({ exitCode }) => {
    sessions.delete(agent.id);
    updateAgent(agent.projectId, agent.id, { status: 'stopped', pid: undefined });
    onStatus(agent.id, 'stopped');
  });

  updateAgent(agent.projectId, agent.id, { status: 'running', pid: proc.pid });
  onStatus(agent.id, 'running');
  return true;
}

export function stopAgent(agentId: string): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.pty.kill();
  sessions.delete(agentId);
  return true;
}

export function writeToAgent(agentId: string, data: string) {
  const session = sessions.get(agentId);
  if (!session) return;
  session.pty.write(data);
}

/**
 * Inject an agent-to-agent message into the target agent's terminal.
 * The message is formatted so the target's LLM sees it as if the user had
 * just typed it in — a bracketed notification with sender identity.
 *
 * Returns true if delivered to a running PTY, false if the target is not running.
 */
export function injectMessage(targetAgentId: string, fromName: string, message: string): boolean {
  const session = sessions.get(targetAgentId);
  if (!session) return false;

  // Single-line banner + message body. Terminating with Enter so most CLIs
  // treat it as a submitted user message rather than pending input.
  const clean = message.replace(/\r/g, '').trim();
  const payload = `[Message from ${fromName}]: ${clean}\r`;
  session.pty.write(payload);
  return true;
}

/**
 * Clean up MCP config for an agent (called on deletion).
 */
export function cleanupMcpConfig(agent: Agent) {
  try {
    if (agent.cli === 'claude') {
      removeClaudeMcpConfig(agent.id);
      removeClaudeHookConfig(agent.id);
    } else if (agent.cli === 'codex') {
      removeCodexMcpConfig(agent.id);
    }
  } catch (err) {
    console.warn(`[pty-manager] Failed to clean up MCP config for ${agent.name}:`, err);
  }
}

export function resizeAgent(agentId: string, cols: number, rows: number) {
  const session = sessions.get(agentId);
  if (!session) return;
  session.pty.resize(cols, rows);
}

export function addOutputListener(agentId: string, listener: (data: string) => void) {
  const session = sessions.get(agentId);
  if (!session) return;
  for (const line of session.buffer) {
    listener(line);
  }
  session.listeners.add(listener);
}

export function removeOutputListener(agentId: string, listener: (data: string) => void) {
  const session = sessions.get(agentId);
  if (!session) return;
  session.listeners.delete(listener);
}

export function getAgentPreview(agentId: string): string {
  const session = sessions.get(agentId);
  if (!session || session.buffer.length === 0) return '';
  const tail = session.buffer.slice(-30).join('');
  // Strip all ANSI/VT escape sequences
  const stripped = tail
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')    // CSI sequences (including private ? mode)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')            // charset switches
    .replace(/\x1b[>=<]/g, '')                    // keypad modes
    .replace(/\x1b\[\?[0-9;]*[a-z]/g, '')        // private mode set/reset
    .replace(/\r/g, '')                           // carriage returns
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // control chars
  const lines = stripped.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  // Skip common noise lines
  const meaningful = lines.filter(l =>
    !l.startsWith('bypass permissions') &&
    !l.startsWith('Remote Control') &&
    !l.startsWith('Auto-update') &&
    !l.startsWith('Spindle') &&
    !l.match(/^\s*[>$%#]\s*$/)
  );
  const last = meaningful.length > 0 ? meaningful[meaningful.length - 1] : '';
  return last.slice(0, 60);
}

export function isAgentRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

export function getRunningAgentIds(): string[] {
  return Array.from(sessions.keys());
}
