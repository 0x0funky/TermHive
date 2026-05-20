/**
 * runtime.ts — routes agent operations to the right runtime.
 *
 *   Claude / Gemini / OpenCode → PTY            (pty-manager)
 *   Codex                      → app-server thread (codex-agents)
 *
 * The daemon and the Hive dispatch layer talk only to this module, so they
 * never branch on CLI themselves.
 */

import * as pty from '../pty-manager.js';
import * as codex from './codex-agents.js';
import type { Agent } from '../types.js';

type StatusFn = (agentId: string, status: string) => void;

/** True once this agent id is a live Codex (app-server) agent. */
function isCodex(agentId: string): boolean {
  return codex.isAgentRunning(agentId);
}

/** Start an agent on its runtime. Async — Codex must create a thread. */
export async function startAgent(agent: Agent, onStatus: StatusFn): Promise<boolean> {
  if (agent.cli === 'codex') return codex.startAgent(agent, onStatus);
  return pty.startAgent(agent, onStatus);
}

export function stopAgent(agentId: string): boolean {
  return isCodex(agentId) ? codex.stopAgent(agentId) : pty.stopAgent(agentId);
}

export function writeToAgent(agentId: string, data: string): void {
  if (isCodex(agentId)) codex.writeToAgent(agentId, data);
  else pty.writeToAgent(agentId, data);
}

export function injectMessage(agentId: string, fromName: string, message: string): boolean {
  return isCodex(agentId)
    ? codex.injectMessage(agentId, fromName, message)
    : pty.injectMessage(agentId, fromName, message);
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  if (isCodex(agentId)) codex.resizeAgent(agentId, cols, rows);
  else pty.resizeAgent(agentId, cols, rows);
}

export function addOutputListener(agentId: string, listener: (data: string) => void): void {
  if (isCodex(agentId)) codex.addOutputListener(agentId, listener);
  else pty.addOutputListener(agentId, listener);
}

export function removeOutputListener(agentId: string, listener: (data: string) => void): void {
  if (isCodex(agentId)) codex.removeOutputListener(agentId, listener);
  else pty.removeOutputListener(agentId, listener);
}

export function getAgentPreview(agentId: string): string {
  return isCodex(agentId) ? codex.getAgentPreview(agentId) : pty.getAgentPreview(agentId);
}

export function isAgentRunning(agentId: string): boolean {
  return pty.isAgentRunning(agentId) || codex.isAgentRunning(agentId);
}

export function getRunningAgentIds(): string[] {
  return [...pty.getRunningAgentIds(), ...codex.getRunningAgentIds()];
}

/** MCP config cleanup on agent deletion (pty-manager owns both CLIs' configs). */
export function cleanupMcpConfig(agent: Agent): void {
  pty.cleanupMcpConfig(agent);
}
