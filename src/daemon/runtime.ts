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
import type { CodexItem } from './protocol.js';

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

/**
 * Attach to an agent's live output. PTY agents stream text (`onText`); Codex
 * agents stream structured items (`onItem`, replayed on attach). Returns a
 * teardown function.
 */
export function attach(
  agentId: string,
  handlers: { onText: (data: string) => void; onItem: (item: CodexItem) => void },
): () => void {
  if (isCodex(agentId)) {
    for (const it of codex.getItems(agentId)) handlers.onItem(it);
    return codex.subscribeItems(agentId, handlers.onItem);
  }
  pty.addOutputListener(agentId, handlers.onText);
  return () => pty.removeOutputListener(agentId, handlers.onText);
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

/** Run a turn on a Codex agent and wait for its reply (the Codex `ask_agent`). */
export function askCodexAgent(agentId: string, message: string) {
  return codex.askAgent(agentId, message);
}

/** Submit a turn to a Codex agent with optional model / effort overrides. */
export function sendCodexTurn(agentId: string, text: string, model?: string, effort?: string): void {
  codex.sendTurn(agentId, text, model, effort);
}

/** Start a fresh thread for a Codex agent. */
export function newCodexThread(agentId: string): Promise<boolean> {
  return codex.newThread(agentId);
}

/** List the models codex offers (UI model picker). */
export function listCodexModels(): Promise<string[]> {
  return codex.listModels();
}
