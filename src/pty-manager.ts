import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Agent } from './types.js';
import { updateAgent, getProjectData, SHARED_CONTENT_DIR, WIKI_DIR } from './storage.js';

/** Expand leading ~ to the user's home directory */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
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
function buildTermhiveSection(sharedPath: string, wikiPath: string): { marker: string; section: string } {
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
  ];

  if (hasWiki) {
    lines.push(
      'Project wiki directory: `' + wikiPath + '`',
      '- **Start every session by reading `_index.md`** to understand current project state',
      '- Read `_schema.md` for wiki maintenance conventions',
      '- When asked to "update wiki", follow the schema rules',
      '- Do NOT auto-update wiki while coding — only when explicitly asked',
      '',
    );
  }

  lines.push('<!-- End Termhive -->', '');
  return { marker, section: lines.join('\n') };
}

/**
 * Write Termhive instructions to a markdown file (CLAUDE.md or AGENTS.md).
 */
function ensureInstructionFile(filePath: string, projectName: string, sharedPath: string, wikiPath: string) {
  const { marker, section } = buildTermhiveSection(sharedPath, wikiPath);

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

function getCliCommand(agent: Agent, sharedPath: string, wikiPath: string): { cmd: string; args: string[] } {
  const args: string[] = [];
  const hasWiki = fs.existsSync(path.join(wikiPath, '_schema.md'));
  switch (agent.cli) {
    case 'claude':
      if (agent.flags?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
      if (agent.flags?.remoteControl) args.push('--remote-control');
      args.push('--add-dir', sharedPath);
      if (hasWiki) args.push('--add-dir', wikiPath);
      return { cmd: 'claude', args };
    case 'codex':
      args.push('--add-dir', sharedPath);
      if (hasWiki) args.push('--add-dir', wikiPath);
      return { cmd: 'codex', args };
    case 'gemini':
      args.push('--include-directories', sharedPath);
      if (hasWiki) args.push('--include-directories', wikiPath);
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

  // Write instruction file in agent's cwd so the CLI knows about shared content + memory
  const instructionFiles: Record<string, string> = {
    claude: 'CLAUDE.md',
    codex: 'AGENTS.md',
    gemini: 'AGENTS.md',
    opencode: 'AGENTS.md',
  };
  const instrFile = path.join(cwd, instructionFiles[agent.cli]);
  ensureInstructionFile(instrFile, projectName, sharedPath, wikiPath);

  const { cmd, args } = getCliCommand(agent, sharedPath, wikiPath);
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
