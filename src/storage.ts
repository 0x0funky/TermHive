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
const WIKI_DIR = path.join(BASE_DIR, 'wiki');

function sharedDir(projectName: string) {
  return path.join(SHARED_CONTENT_DIR, projectName);
}

function wikiDir(projectName: string) {
  return path.join(WIKI_DIR, projectName);
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

// --- Project Wiki (stored in ~/.termhive/memory/[project_name]/) ---

const WIKI_SCHEMA = `# Project Wiki Schema

## Purpose
This is the project's persistent knowledge base, maintained by AI agents via Termhive.
It accumulates and organizes knowledge over time — architecture decisions, API specs,
progress tracking, and cross-referenced documentation.

## Structure

### Core Pages
- **overview.md** — Project purpose, tech stack, current state. The "executive summary" — always keep under 200 lines.
- **architecture.md** — System design, components, data flow, infrastructure.
- **api-endpoints.md** — All API endpoints with request/response formats.
- **data-model.md** — Database schema, models, relationships.
- **decisions.md** — Architecture and design decisions with rationale. Append-only — never delete entries.
- **progress.md** — What's done, what's in progress, what's blocked.

### Agent Logs
- **agents/[agent-name].md** — Per-agent work log: what this agent has accomplished, current focus, blockers.

### Raw Sources (optional)
- **raw/** — Original documents, specs, or references. Immutable — agents read but never modify these.

## Maintenance Rules

When asked to "update wiki" or "write to wiki":

1. Read \`_index.md\` first to find relevant existing pages
2. Update ALL affected pages, not just one. A single change might touch 3-5 pages.
3. Add \`[[cross-references]]\` to related pages using markdown links
4. Always append an entry to \`_log.md\` with format: \`## [YYYY-MM-DD] action | Summary\`
5. Update \`_index.md\` if you created or deleted pages
6. Never delete content from \`decisions.md\` — only append
7. When new information contradicts existing content, note the contradiction and update

## Operations

### Ingest
When processing new information: read it, extract key points, update relevant pages,
add cross-references, update index, append to log.

### Query
When answering questions about the project: read \`_index.md\` first, then drill into
relevant pages. Cite which pages you referenced.

### Lint
Periodically check for: contradictions between pages, stale information, orphan pages
with no inbound links, important concepts missing their own page, gaps that need filling.
`;

const WIKI_INDEX = `# Project Wiki Index

> Auto-maintained by AI agents. See \`_schema.md\` for conventions.

## Core
- [Overview](overview.md) — Project purpose, tech stack, current state
- [Architecture](architecture.md) — System design and components
- [API Endpoints](api-endpoints.md) — REST/GraphQL endpoint reference
- [Data Model](data-model.md) — Database schema and relationships
- [Decisions](decisions.md) — Architecture decision records
- [Progress](progress.md) — Current status and roadmap

## Agents
<!-- Agent pages will be listed here as they are created -->
`;

const WIKI_LOG = `# Project Wiki Log

> Chronological record of wiki updates. Append-only.
> Format: ## [YYYY-MM-DD] action | Summary

`;

const WIKI_OVERVIEW = `# Project Overview

> This page should be the first thing a new agent reads to understand the project.
> Keep it under 200 lines. Update it as the project evolves.

## Purpose
<!-- What does this project do? Who is it for? -->

## Tech Stack
<!-- Languages, frameworks, databases, infrastructure -->

## Current State
<!-- What's working? What's in progress? What's the immediate priority? -->

## Key Links
<!-- Repository, deployment, documentation, etc. -->
`;

export function isWikiInitialized(projectId: string): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  const dir = wikiDir(data.project.name);
  return fs.existsSync(path.join(dir, '_schema.md'));
}

export function initializeWiki(projectId: string): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  const dir = wikiDir(data.project.name);
  ensureDir(dir);
  ensureDir(path.join(dir, 'agents'));
  ensureDir(path.join(dir, 'raw'));

  const files: Record<string, string> = {
    '_schema.md': WIKI_SCHEMA,
    '_index.md': WIKI_INDEX,
    '_log.md': WIKI_LOG,
    'overview.md': WIKI_OVERVIEW,
    'architecture.md': [
      '# Architecture',
      '',
      '## System Overview',
      '<!-- High-level description: what are the main components and how do they interact? -->',
      '',
      '## Component Diagram',
      '```',
      '┌──────────┐     ┌──────────┐     ┌──────────┐',
      '│ Frontend  │────>│ Backend  │────>│ Database │',
      '└──────────┘     └──────────┘     └──────────┘',
      '```',
      '<!-- Replace with your actual architecture -->',
      '',
      '## Components',
      '',
      '### Frontend',
      '<!-- Framework, structure, key patterns -->',
      '',
      '### Backend',
      '<!-- Framework, API layer, business logic -->',
      '',
      '### Database',
      '<!-- Type, schema overview, key tables -->',
      '',
      '## Data Flow',
      '<!-- How does data flow through the system? Key request paths? -->',
      '',
      '## Infrastructure',
      '<!-- Hosting, CI/CD, environment setup -->',
      '',
    ].join('\n'),
    'api-endpoints.md': [
      '# API Endpoints',
      '',
      '## Base URL',
      '<!-- e.g. http://localhost:3000/api -->',
      '',
      '## Endpoints',
      '',
      '| Method | Path | Description | Auth |',
      '|--------|------|-------------|------|',
      '| GET | /example | Description | No |',
      '| POST | /example | Description | Yes |',
      '',
      '## Authentication',
      '<!-- How does auth work? Token format? -->',
      '',
      '## Error Format',
      '<!-- Standard error response structure -->',
      '',
    ].join('\n'),
    'data-model.md': [
      '# Data Model',
      '',
      '## Entity Relationship',
      '<!-- Key entities and their relationships -->',
      '',
      '## Models',
      '',
      '### Example Model',
      '| Field | Type | Description |',
      '|-------|------|-------------|',
      '| id | string | Primary key |',
      '| created_at | datetime | Creation timestamp |',
      '',
      '## Migrations',
      '<!-- Notable migration history -->',
      '',
    ].join('\n'),
    'decisions.md': [
      '# Architecture Decisions',
      '',
      '> Append-only — never delete entries. New decisions go at the bottom.',
      '',
      '<!-- Template for new entries:',
      '## [YYYY-MM-DD] Decision Title',
      '**Context:** Why did this come up?',
      '**Decision:** What did we choose?',
      '**Alternatives considered:** What else was on the table?',
      '**Rationale:** Why this over the alternatives?',
      '-->',
      '',
    ].join('\n'),
    'progress.md': [
      '# Progress',
      '',
      '> Updated by agents when tasks are completed or started.',
      '> Move items between sections as status changes.',
      '',
      '## Done',
      '<!-- - [YYYY-MM-DD] What was completed -->',
      '',
      '## In Progress',
      '<!-- - What is currently being worked on (and by which agent) -->',
      '',
      '## Blocked',
      '<!-- - What is stuck and why -->',
      '',
      '## Upcoming',
      '<!-- - What needs to be done next -->',
      '',
    ].join('\n'),
  };

  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
  return true;
}

export function listWikiFiles(projectId: string): SharedContent[] {
  const data = getProjectData(projectId);
  if (!data) return [];
  const dir = wikiDir(data.project.name);
  if (!fs.existsSync(dir)) return [];

  const results: SharedContent[] = [];
  const readDir = (d: string, prefix: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const sub = prefix ? prefix + '/' + entry.name : entry.name;
        readDir(path.join(d, entry.name), sub);
      } else {
        const filePath = path.join(d, entry.name);
        const filename = prefix ? prefix + '/' + entry.name : entry.name;
        const stat = fs.statSync(filePath);
        results.push({
          id: filename,
          projectId,
          filename,
          content: '',
          createdBy: 'system',
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
  };
  readDir(dir, '');
  return results;
}

export function getWikiFile(projectId: string, filename: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = path.join(wikiDir(data.project.name), filename);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    id: filename,
    projectId,
    filename,
    content: fs.readFileSync(filePath, 'utf-8'),
    createdBy: 'system',
    updatedAt: stat.mtime.toISOString(),
  };
}

export function updateWikiFile(projectId: string, filename: string, content: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = path.join(wikiDir(data.project.name), filename);
  const dir = path.dirname(filePath);
  ensureDir(dir);
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

export { SHARED_CONTENT_DIR, WIKI_DIR };
