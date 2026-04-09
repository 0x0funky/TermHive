import fs from 'fs';
import path from 'path';
import type { Agent } from './types.js';
import { updateAgent, getProjectData, SHARED_CONTENT_DIR, MEMORY_DIR } from './storage.js';

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
function buildTermhiveSection(sharedPath: string, memoryPath: string): { marker: string; section: string } {
  const marker = '<!-- Termhive -->';
  const hasMemory = fs.existsSync(path.join(memoryPath, '_schema.md'));

  const lines = [
    '',
    marker,
    '## Termhive — Multi-Agent Collaboration',
    '',
    'Shared content directory: `' + sharedPath + '`',
    '- Read/write files here to share information with other agents and the user',
    '',
  ];

  if (hasMemory) {
    lines.push(
      'Project memory directory: `' + memoryPath + '`',
      '- Read `_index.md` first to understand the project',
      '- Read `_schema.md` for memory maintenance conventions',
      '- When asked to "update memory", follow the schema rules',
      '- Do NOT auto-update memory while coding — only when explicitly asked',
      '',
    );
  }

  lines.push('<!-- End Termhive -->', '');
  return { marker, section: lines.join('\n') };
}

/**
 * Write Termhive instructions to a markdown file (CLAUDE.md or AGENTS.md).
 */
function ensureInstructionFile(filePath: string, projectName: string, sharedPath: string, memoryPath: string) {
  const { marker, section } = buildTermhiveSection(sharedPath, memoryPath);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing.includes(marker)) {
      const updated = existing.replace(
        /<!-- Termhive -->[\s\S]*?<!-- End Termhive -->/,
        marker + section.split(marker)[1]
      );
      fs.writeFileSync(filePath, updated, 'utf-8');
    } else {
      fs.appendFileSync(filePath, section, 'utf-8');
    }
  } else {
    fs.writeFileSync(filePath, '# ' + projectName + '\n' + section, 'utf-8');
  }
}

function getCliCommand(agent: Agent, sharedPath: string, memoryPath: string): { cmd: string; args: string[] } {
  const args: string[] = [];
  const hasMemory = fs.existsSync(path.join(memoryPath, '_schema.md'));
  switch (agent.cli) {
    case 'claude':
      if (agent.flags?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
      if (agent.flags?.remoteControl) args.push('--remote-control');
      args.push('--add-dir', sharedPath);
      if (hasMemory) args.push('--add-dir', memoryPath);
      return { cmd: 'claude', args };
    case 'codex':
      args.push('--add-dir', sharedPath);
      if (hasMemory) args.push('--add-dir', memoryPath);
      return { cmd: 'codex', args };
    case 'gemini':
      args.push('--include-directories', sharedPath);
      if (hasMemory) args.push('--include-directories', memoryPath);
      return { cmd: 'gemini', args };
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
  const memoryPath = path.join(MEMORY_DIR, projectName);

  // Write instruction file in agent's cwd so the CLI knows about shared content + memory
  const instructionFiles: Record<string, string> = {
    claude: 'CLAUDE.md',
    codex: 'AGENTS.md',
    gemini: 'AGENTS.md',
  };
  const instrFile = path.join(agent.cwd, instructionFiles[agent.cli]);
  ensureInstructionFile(instrFile, projectName, sharedPath, memoryPath);

  const { cmd, args } = getCliCommand(agent, sharedPath, memoryPath);
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

  let proc: IPty;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: agent.cwd,
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

export function isAgentRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

export function getRunningAgentIds(): string[] {
  return Array.from(sessions.keys());
}
