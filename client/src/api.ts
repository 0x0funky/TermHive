const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Projects
export const listProjects = () => request<Project[]>('/projects');
export const createProject = (data: { name: string; cwd: string; description?: string }) =>
  request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) });
export const updateProject = (id: string, data: Partial<Project>) =>
  request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteProject = (id: string) =>
  request<void>(`/projects/${id}`, { method: 'DELETE' });

// Agents
export const listAgents = (projectId: string) =>
  request<Agent[]>(`/projects/${projectId}/agents`);
export const getAgentPreviews = (projectId: string) =>
  request<Record<string, string>>(`/projects/${projectId}/agents/previews`);
export const createAgent = (projectId: string, data: { name: string; cli: string; cwd?: string; role?: string; flags?: Agent['flags'] }) =>
  request<Agent>(`/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify(data) });
export const deleteAgent = (projectId: string, agentId: string) =>
  request<void>(`/projects/${projectId}/agents/${agentId}`, { method: 'DELETE' });
export const startAgent = (projectId: string, agentId: string) =>
  request<{ status: string }>(`/projects/${projectId}/agents/${agentId}/start`, { method: 'POST' });
export const stopAgent = (projectId: string, agentId: string) =>
  request<{ status: string }>(`/projects/${projectId}/agents/${agentId}/stop`, { method: 'POST' });
export const restartAgent = (projectId: string, agentId: string) =>
  request<{ status: string }>(`/projects/${projectId}/agents/${agentId}/restart`, { method: 'POST' });

// Shared Content
export const listContent = (projectId: string) =>
  request<SharedContent[]>(`/projects/${projectId}/content`);
export const getContent = (projectId: string, filename: string) =>
  request<SharedContent>(`/projects/${projectId}/content/${encodeURIComponent(filename)}`);
export const createContent = (projectId: string, data: { filename: string; content?: string; createdBy?: string }) =>
  request<SharedContent>(`/projects/${projectId}/content`, { method: 'POST', body: JSON.stringify(data) });
export const updateContent = (projectId: string, filename: string, content: string) =>
  request<SharedContent>(`/projects/${projectId}/content/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) });
export const deleteContent = (projectId: string, filename: string) =>
  request<void>(`/projects/${projectId}/content/${encodeURIComponent(filename)}`, { method: 'DELETE' });

// Project Memory
export const getWikiStatus = (projectId: string) =>
  request<{ initialized: boolean }>(`/projects/${projectId}/wiki/status`);
export const initializeWiki = (projectId: string) =>
  request<{ initialized: boolean }>(`/projects/${projectId}/wiki/initialize`, { method: 'POST' });
export const listWikiFiles = (projectId: string) =>
  request<SharedContent[]>(`/projects/${projectId}/wiki`);
export const getWikiFile = (projectId: string, filename: string) =>
  request<SharedContent>(`/projects/${projectId}/wiki/${encodeURIComponent(filename)}`);
export const updateWikiFile = (projectId: string, filename: string, content: string) =>
  request<SharedContent>(`/projects/${projectId}/wiki/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) });

// Types (shared with backend)
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
  cli: 'claude' | 'codex' | 'gemini';
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
