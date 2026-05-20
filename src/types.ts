export interface Project {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  createdAt: string;
}

/**
 * Agent status. v2.1 derives the finer states from Claude Code lifecycle hooks:
 *   running        — actively working
 *   awaiting_input — finished a turn / asked something — needs the user
 *   idle           — awaiting_input for a while with no attention
 *   stopped        — not running
 */
export type AgentStatus = 'stopped' | 'running' | 'idle' | 'awaiting_input';

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  role?: string;
  cli: 'claude' | 'codex' | 'gemini' | 'opencode';
  cwd: string;
  status: AgentStatus;
  pid?: number;
  flags?: {
    dangerouslySkipPermissions?: boolean;
    remoteControl?: boolean;
  };
}

export interface SharedContent {
  id: string;
  projectId: string;
  filename: string;
  content: string;
  createdBy: string;
  updatedAt: string;
}

export interface ProjectData {
  project: Project;
  agents: Agent[];
}

import type { BrainEvent } from './daemon/protocol.js';

// WebSocket message types
export type WSClientMessage =
  | { type: 'terminal:attach'; agentId: string }
  | { type: 'terminal:input'; agentId: string; data: string }
  | { type: 'terminal:detach'; agentId: string }
  | { type: 'terminal:resize'; agentId: string; cols: number; rows: number }
  | { type: 'brain:send'; message: string }
  | { type: 'brain:new' }
  | { type: 'brain:switch'; conversationId: string }
  | { type: 'brain:delete'; conversationId: string };

export interface ActivityEvent {
  id: string;
  projectId: string;
  agentId?: string;
  agentName?: string;
  event: 'agent:started' | 'agent:stopped' | 'content:created' | 'content:modified' | 'content:deleted' | 'user:input' | 'agent:message';
  detail: string;
  timestamp: string;
  // For agent:message events
  fromAgent?: string;
  toAgent?: string;
  message?: string;
}

export interface AgentMessage {
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  message: string;
  timestamp: string;
}

export type WSServerMessage =
  | { type: 'terminal:output'; agentId: string; data: string }
  | { type: 'agent:status'; agentId: string; status: string }
  | { type: 'content:updated'; projectId: string; filename: string }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'brain:event'; payload: BrainEvent }
  | { type: 'org:changed' };
