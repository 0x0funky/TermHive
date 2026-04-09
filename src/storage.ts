import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Project, Agent, ProjectData, SharedContent } from './types.js';

const BASE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.termhive');
const PROJECTS_DIR = path.join(BASE_DIR, 'projects');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function projectDir(projectId: string) {
  return path.join(PROJECTS_DIR, projectId);
}

function projectFile(projectId: string) {
  return path.join(projectDir(projectId), 'project.json');
}

const SHARED_CONTENT_DIR = path.join(BASE_DIR, 'shared_content');

function sharedDir(projectName: string) {
  return path.join(SHARED_CONTENT_DIR, projectName);
}

// Initialize storage
ensureDir(PROJECTS_DIR);

// --- Projects ---

export function listProjects(): Project[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const dirs = fs.readdirSync(PROJECTS_DIR);
  const projects: Project[] = [];
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, 'project.json');
    if (fs.existsSync(file)) {
      const data: ProjectData = JSON.parse(fs.readFileSync(file, 'utf-8'));
      projects.push(data.project);
    }
  }
  return projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProjectData(projectId: string): ProjectData | null {
  const file = projectFile(projectId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function saveProjectData(data: ProjectData) {
  ensureDir(projectDir(data.project.id));
  fs.writeFileSync(projectFile(data.project.id), JSON.stringify(data, null, 2));
}

export function createProject(name: string, cwd: string, description?: string): Project {
  const project: Project = {
    id: uuid(),
    name,
    description,
    cwd,
    createdAt: new Date().toISOString(),
  };
  saveProjectData({ project, agents: [] });
  return project;
}

export function updateProject(projectId: string, updates: Partial<Pick<Project, 'name' | 'description' | 'cwd'>>): Project | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  Object.assign(data.project, updates);
  saveProjectData(data);
  return data.project;
}

export function deleteProject(projectId: string): boolean {
  const dir = projectDir(projectId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true });
  return true;
}

// --- Agents ---

export function listAgents(projectId: string): Agent[] {
  const data = getProjectData(projectId);
  return data?.agents ?? [];
}

export function getAgent(projectId: string, agentId: string): Agent | null {
  const data = getProjectData(projectId);
  return data?.agents.find(a => a.id === agentId) ?? null;
}

export function createAgent(projectId: string, name: string, cli: Agent['cli'], cwd: string, role?: string, flags?: Agent['flags']): Agent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const agent: Agent = {
    id: uuid(),
    projectId,
    name,
    role,
    cli,
    cwd,
    status: 'stopped',
    flags,
  };
  data.agents.push(agent);
  saveProjectData(data);
  return agent;
}

export function updateAgent(projectId: string, agentId: string, updates: Partial<Pick<Agent, 'name' | 'role' | 'cli' | 'cwd' | 'status' | 'pid' | 'flags'>>): Agent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) return null;
  Object.assign(agent, updates);
  saveProjectData(data);
  return agent;
}

export function deleteAgent(projectId: string, agentId: string): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  const idx = data.agents.findIndex(a => a.id === agentId);
  if (idx === -1) return false;
  data.agents.splice(idx, 1);
  saveProjectData(data);
  return true;
}

// --- Shared Content (stored in ~/.termhive/shared_content/[project_name]/) ---

export function listContent(projectId: string): SharedContent[] {
  const data = getProjectData(projectId);
  if (!data) return [];
  const dir = sharedDir(data.project.name);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  return files.map(f => {
    const filePath = path.join(dir, f);
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      id: f,
      projectId,
      filename: f,
      content,
      createdBy: 'user',
      updatedAt: stat.mtime.toISOString(),
    };
  });
}

export function getContent(projectId: string, filename: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = path.join(sharedDir(data.project.name), filename);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  return {
    id: filename,
    projectId,
    filename,
    content,
    createdBy: 'user',
    updatedAt: stat.mtime.toISOString(),
  };
}

export function createContent(projectId: string, filename: string, content: string, _createdBy: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const dir = sharedDir(data.project.name);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  const stat = fs.statSync(filePath);
  return {
    id: filename,
    projectId,
    filename,
    content,
    createdBy: _createdBy,
    updatedAt: stat.mtime.toISOString(),
  };
}

export function updateContent(projectId: string, filename: string, content: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = path.join(sharedDir(data.project.name), filename);
  if (!fs.existsSync(filePath)) return null;
  fs.writeFileSync(filePath, content, 'utf-8');
  const stat = fs.statSync(filePath);
  return {
    id: filename,
    projectId,
    filename,
    content,
    createdBy: 'user',
    updatedAt: stat.mtime.toISOString(),
  };
}

export function deleteContent(projectId: string, filename: string): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  const filePath = path.join(sharedDir(data.project.name), filename);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export { SHARED_CONTENT_DIR };
