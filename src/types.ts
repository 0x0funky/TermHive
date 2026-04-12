export interface Project {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  role?: string;
  cli: 'claude' | 'codex' | 'gemini' | 'opencode';
  cwd: string;
  status: 'stopped' | 'running' | 'idle';
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

// WebSocket message types
export type WSClientMessage =
  | { type: 'terminal:attach'; agentId: string }
  | { type: 'terminal:input'; agentId: string; data: string }
  | { type: 'terminal:detach'; agentId: string }
  | { type: 'terminal:resize'; agentId: string; cols: number; rows: number };

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
  | { type: 'activity'; event: ActivityEvent };
