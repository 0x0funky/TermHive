/**
 * Writes MCP server configuration for each agent so the CLI tools auto-spawn
 * the Termhive MCP server when they start.
 *
 * - Claude Code: writes a session-scoped JSON config to
 *   ~/.termhive/mcp-configs/<agentId>.json and expects the CLI to be invoked
 *   with `--mcp-config <path>`. Does NOT touch ~/.claude.json so the user's
 *   global MCP setup stays untouched.
 * - Codex CLI: ~/.codex/config.toml, per-agent-id keyed server name
 *   (Codex does not support a per-session MCP flag, so we use a unique key
 *    per agent to avoid collisions.)
 *
 * All writes are idempotent and only touch the Termhive-owned keys.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Agent } from './types.js';

/** Directory holding per-agent Claude MCP config JSON files. */
export function getClaudeMcpConfigDir(): string {
  return path.join(os.homedir(), '.termhive', 'mcp-configs');
}

/** Absolute path to the per-agent Claude MCP config JSON file. */
export function getClaudeMcpConfigPath(agentId: string): string {
  return path.join(getClaudeMcpConfigDir(), `${agentId}.json`);
}

export interface McpWriteContext {
  agent: Agent;
  agentCwd: string;         // resolved cwd (already expanded)
  hubUrl: string;           // e.g. http://localhost:3200
  mcpServerPath: string;    // absolute path to compiled dist/mcp-server.js
}

/**
 * Unique MCP server key per agent (used in Codex where config is global).
 * Claude Code is per-project scope so we use a single key.
 */
export function mcpServerKeyForCodex(agentId: string): string {
  return `termhive_${agentId.slice(0, 8)}`;
}

/**
 * Build the command + args array used by both Claude and Codex configs.
 */
function buildInvocation(ctx: McpWriteContext): { command: string; args: string[] } {
  return {
    command: 'node',
    args: [
      ctx.mcpServerPath,
      '--hub', ctx.hubUrl,
      '--project', ctx.agent.projectId,
      '--agent', ctx.agent.id,
      '--name', ctx.agent.name,
    ],
  };
}

/**
 * Write a session-scoped MCP config JSON for a Claude agent. The file is
 * passed to Claude Code via `--mcp-config <path>` so the Termhive MCP server
 * is only loaded for this specific session (and is cleanly removed when the
 * file is deleted). Does not touch the user's global ~/.claude.json.
 */
export function writeClaudeMcpConfig(ctx: McpWriteContext): string {
  const dir = getClaudeMcpConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const invocation = buildInvocation(ctx);
  const configPath = getClaudeMcpConfigPath(ctx.agent.id);
  const config = {
    mcpServers: {
      termhive: {
        type: 'stdio',
        command: invocation.command,
        args: invocation.args,
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}

/**
 * Write Termhive MCP config into Codex CLI's ~/.codex/config.toml.
 * Codex MCP config is global (not per-project), so we use a per-agent key
 * to avoid collisions across multiple agents.
 */
export function writeCodexMcpConfig(ctx: McpWriteContext): void {
  const codexDir = path.join(os.homedir(), '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  fs.mkdirSync(codexDir, { recursive: true });

  const invocation = buildInvocation(ctx);
  const key = mcpServerKeyForCodex(ctx.agent.id);

  // Serialize a TOML section for this MCP server.
  // Codex expects: [mcp_servers.<key>] with command (string) + args (array of strings)
  const argsArray = '[' + invocation.args.map(a => tomlString(a)).join(', ') + ']';
  const section = [
    `[mcp_servers.${key}]`,
    `command = ${tomlString(invocation.command)}`,
    `args = ${argsArray}`,
    '',
  ].join('\n');

  let existing = '';
  if (fs.existsSync(configPath)) {
    existing = fs.readFileSync(configPath, 'utf-8');
  }

  // Remove any existing Termhive-owned section for this agent, then append
  const sectionRegex = new RegExp(
    `(?:^|\\n)\\[mcp_servers\\.${escapeRegex(key)}\\][\\s\\S]*?(?=\\n\\[|$)`,
    'g'
  );
  const cleaned = existing.replace(sectionRegex, '').trimEnd();

  const header = '# Termhive MCP servers — managed by Termhive, do not edit this section manually\n';
  const hasTermhiveHeader = cleaned.includes('# Termhive MCP servers');

  const newContent =
    (cleaned.length > 0 ? cleaned + '\n\n' : '') +
    (hasTermhiveHeader ? '' : header) +
    section;

  fs.writeFileSync(configPath, newContent, 'utf-8');
}

/**
 * Remove Termhive MCP config for a Claude agent. Just deletes the per-agent
 * JSON file; ~/.claude.json is never touched.
 */
export function removeClaudeMcpConfig(agentId: string): void {
  const configPath = getClaudeMcpConfigPath(agentId);
  if (fs.existsSync(configPath)) {
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
}

export function removeCodexMcpConfig(agentId: string): void {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) return;

  const key = mcpServerKeyForCodex(agentId);
  const existing = fs.readFileSync(configPath, 'utf-8');
  const sectionRegex = new RegExp(
    `(?:^|\\n)\\[mcp_servers\\.${escapeRegex(key)}\\][\\s\\S]*?(?=\\n\\[|$)`,
    'g'
  );
  const cleaned = existing.replace(sectionRegex, '').trimEnd();
  fs.writeFileSync(configPath, cleaned + (cleaned.length > 0 ? '\n' : ''), 'utf-8');
}

// --- TOML helpers (hand-rolled; keep scope minimal to avoid adding @iarna/toml) ---

function tomlString(s: string): string {
  // Use basic string with backslash escaping (TOML spec)
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
