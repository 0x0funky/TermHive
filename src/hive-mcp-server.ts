#!/usr/bin/env node
/**
 * Termhive Hive Orchestrator MCP Server
 *
 * Gives the orchestrator brain ("The Keeper") org-level tools to see and
 * command the whole hive. Spawned as a stdio MCP server by the brain's CLI
 * process; forwards every tool call to the termhive-daemon over HTTP.
 *
 * Unlike the per-agent `mcp-server.ts` (agent-to-agent messaging), this server
 * is loaded only by the brain and exposes cross-project tools.
 *
 * Args:
 *   --daemon <url>   termhive-daemon HTTP base (default http://127.0.0.1:3210)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

interface Args {
  daemonUrl: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  return {
    daemonUrl: getArg('daemon') || process.env.TERMHIVE_DAEMON_HTTP || 'http://127.0.0.1:3210',
  };
}

interface SnapshotAgent {
  id: string;
  name: string;
  role?: string;
  cli: string;
  status: string;
}
interface SnapshotProject {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  agents: SnapshotAgent[];
}
interface Snapshot {
  projects: SnapshotProject[];
}

interface AskResult {
  ok: boolean;
  agentName?: string;
  projectName?: string;
  cli?: string;
  status: string;
  reply?: string | null;
  error?: string;
}

interface StartResult {
  ok: boolean;
  status: string;
  agentName?: string;
  projectName?: string;
  cli?: string;
  error?: string;
}

interface WikiResult {
  ok: boolean;
  projectName?: string;
  initialized?: boolean;
  pages?: string[];
  page?: string;
  content?: string;
  error?: string;
}

interface SharedResult {
  ok: boolean;
  projectName?: string;
  files?: string[];
  file?: string;
  content?: string;
  error?: string;
}

interface BroadcastBody {
  ok: boolean;
  projectName?: string;
  error?: string;
  replies?: Array<{
    projectName: string;
    agentName: string;
    cli: string;
    status: string;
    reply?: string | null;
  }>;
  skipped?: Array<{ projectName: string; agentName: string; reason: string }>;
}

/** Plain fetch with an upper-bound timeout so a dead daemon never hangs us. */
async function daemonFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getSnapshot(args: Args): Promise<Snapshot> {
  const res = await daemonFetch(`${args.daemonUrl}/org/snapshot`, undefined, 8000);
  if (!res.ok) throw new Error(`daemon /org/snapshot returned HTTP ${res.status}`);
  return (await res.json()) as Snapshot;
}

/** Resolve a project by id or case-insensitive name. */
function findProject(snap: Snapshot, ref: string): SnapshotProject | undefined {
  const norm = ref.trim().toLowerCase();
  return (
    snap.projects.find((p) => p.id === ref) ||
    snap.projects.find((p) => p.name.toLowerCase() === norm) ||
    snap.projects.find((p) => p.name.toLowerCase().includes(norm))
  );
}

function findAgent(project: SnapshotProject, ref: string): SnapshotAgent | undefined {
  const norm = ref.trim().toLowerCase();
  return (
    project.agents.find((a) => a.id === ref) ||
    project.agents.find((a) => a.name.toLowerCase() === norm) ||
    project.agents.find((a) => (a.role || '').toLowerCase() === norm) ||
    project.agents.find((a) => a.name.toLowerCase().includes(norm))
  );
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}
function err(t: string) {
  return { content: [{ type: 'text' as const, text: t }], isError: true };
}

async function main() {
  const args = parseArgs();

  const server = new Server(
    { name: 'termhive-hive', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_projects',
        description:
          'List every project in the hive with its agents and their live status. ' +
          'Call this first when you need an overview of the teams you can command.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_agents',
        description:
          'List the agents of one project in detail — name, role, CLI, and live ' +
          'status (running / awaiting_input / idle / stopped).',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Project name or id.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'get_agent_status',
        description: 'Get the live status of a single agent in a project.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or id.' },
            agent: { type: 'string', description: 'Agent name, role, or id.' },
          },
          required: ['project', 'agent'],
        },
      },
      {
        name: 'get_project_overview',
        description:
          'Read a project\'s wiki overview — a quick summary of what the project ' +
          'is and its current state. Use this to understand a project before ' +
          'digging into its agents.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or id.' },
          },
          required: ['project'],
        },
      },
      {
        name: 'read_wiki',
        description:
          'Read a project\'s wiki (its knowledge base). Omit `page` to list the ' +
          'available pages; pass a `page` filename to read that page\'s content.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or id.' },
            page: {
              type: 'string',
              description: 'Wiki page filename (e.g. "architecture.md"). Omit to list pages.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'read_shared',
        description:
          'Read a project\'s shared content files — the docs and notes agents ' +
          'and the user exchange. Omit `file` to list files; pass a `file` to read it.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or id.' },
            file: {
              type: 'string',
              description: 'Shared file path (e.g. "api-spec.md"). Omit to list files.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'start_agent',
        description:
          'Start a stopped agent so it can be reached. Call this before ' +
          'ask_agent when the target agent is not running. Starting a Claude ' +
          'agent resumes its previous session, so it keeps the context of what ' +
          'it was working on. Booting takes roughly 15-40 seconds; this tool ' +
          'waits until the agent is ready before returning.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or id.' },
            agent: { type: 'string', description: 'Agent name, role, or id.' },
          },
          required: ['project', 'agent'],
        },
      },
      {
        name: 'ask_agent',
        description:
          'Send a question or instruction to one agent and wait for its reply. ' +
          'This injects your message into the agent\'s live session as if the user ' +
          'typed it, then returns what the agent answered. Use this to collect ' +
          'progress, ask an agent to inspect something, or relay an instruction. ' +
          'The agent must be running. Replies are captured for Claude agents; for ' +
          'other CLIs the message is delivered but the reply is not yet captured.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or id.' },
            agent: { type: 'string', description: 'Agent name, role, or id.' },
            message: {
              type: 'string',
              description: 'What to ask or tell the agent. Be clear and specific.',
            },
          },
          required: ['project', 'agent', 'message'],
        },
      },
      {
        name: 'broadcast',
        description:
          'Ask every running agent the same question at once and collect all ' +
          'their replies. Optionally scope to one project. Stopped agents are ' +
          'skipped (not started). Use this for hive-wide status checks like ' +
          '"what is everyone working on right now".',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The question or instruction to send to every running agent.',
            },
            project: {
              type: 'string',
              description: 'Optional — limit the broadcast to one project (name or id).',
            },
          },
          required: ['message'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params;
    const a = (toolArgs || {}) as Record<string, unknown>;

    try {
      if (name === 'list_projects') {
        const snap = await getSnapshot(args);
        if (snap.projects.length === 0) {
          return text('No projects in the hive yet.');
        }
        const lines: string[] = [];
        for (const p of snap.projects) {
          lines.push(`## ${p.name}${p.description ? ` — ${p.description}` : ''}`);
          if (p.agents.length === 0) {
            lines.push('  (no agents)');
          } else {
            for (const ag of p.agents) {
              const role = ag.role ? ` — ${ag.role}` : '';
              lines.push(`  - ${ag.name} (${ag.cli}, ${ag.status})${role}`);
            }
          }
          lines.push('');
        }
        return text(lines.join('\n').trim());
      }

      if (name === 'list_agents') {
        const project = String(a.project || '').trim();
        if (!project) return err('project is required.');
        const snap = await getSnapshot(args);
        const proj = findProject(snap, project);
        if (!proj) return err(`No project matching "${project}".`);
        if (proj.agents.length === 0) {
          return text(`Project "${proj.name}" has no agents.`);
        }
        const lines = proj.agents.map((ag) => {
          const role = ag.role ? ` — ${ag.role}` : '';
          return `- ${ag.name} (${ag.cli}, ${ag.status})${role}`;
        });
        return text(`Agents in ${proj.name}:\n` + lines.join('\n'));
      }

      if (name === 'get_agent_status') {
        const project = String(a.project || '').trim();
        const agent = String(a.agent || '').trim();
        if (!project || !agent) return err('project and agent are required.');
        const snap = await getSnapshot(args);
        const proj = findProject(snap, project);
        if (!proj) return err(`No project matching "${project}".`);
        const ag = findAgent(proj, agent);
        if (!ag) return err(`No agent matching "${agent}" in ${proj.name}.`);
        const role = ag.role ? `, role: ${ag.role}` : '';
        return text(`${ag.name} (${ag.cli}${role}) in ${proj.name} — status: ${ag.status}`);
      }

      if (name === 'get_project_overview') {
        const project = String(a.project || '').trim();
        if (!project) return err('project is required.');
        const res = await daemonFetch(
          `${args.daemonUrl}/org/wiki?project=${encodeURIComponent(project)}&overview=1`,
          undefined, 8000,
        );
        const body = (await res.json().catch(() => ({}))) as WikiResult;
        if (!body.ok) return err(body.error || `Could not read overview for "${project}".`);
        if (body.initialized === false) {
          return text(
            `${body.projectName}: wiki not initialized.` +
            (body.content ? `\nProject description: ${body.content}` : ''),
          );
        }
        return text(
          `${body.projectName} — overview${body.page ? ` (${body.page})` : ''}:\n\n` +
          (body.content || '(empty)'),
        );
      }

      if (name === 'read_wiki') {
        const project = String(a.project || '').trim();
        const page = a.page ? String(a.page).trim() : '';
        if (!project) return err('project is required.');
        let qs = `project=${encodeURIComponent(project)}`;
        if (page) qs += `&page=${encodeURIComponent(page)}`;
        const res = await daemonFetch(`${args.daemonUrl}/org/wiki?${qs}`, undefined, 8000);
        const body = (await res.json().catch(() => ({}))) as WikiResult;
        if (!body.ok) return err(body.error || `Could not read wiki for "${project}".`);
        if (body.initialized === false) {
          return text(`${body.projectName}: wiki not initialized.`);
        }
        if (page) {
          return text(`${body.projectName} wiki — ${body.page}:\n\n` + (body.content || '(empty)'));
        }
        const pages = body.pages || [];
        if (pages.length === 0) return text(`${body.projectName} wiki has no pages.`);
        return text(`${body.projectName} wiki pages:\n` + pages.map((p) => `- ${p}`).join('\n'));
      }

      if (name === 'read_shared') {
        const project = String(a.project || '').trim();
        const file = a.file ? String(a.file).trim() : '';
        if (!project) return err('project is required.');
        let qs = `project=${encodeURIComponent(project)}`;
        if (file) qs += `&file=${encodeURIComponent(file)}`;
        const res = await daemonFetch(`${args.daemonUrl}/org/shared?${qs}`, undefined, 8000);
        const body = (await res.json().catch(() => ({}))) as SharedResult;
        if (!body.ok) return err(body.error || `Could not read shared content for "${project}".`);
        if (file) {
          return text(`${body.projectName} shared — ${body.file}:\n\n` + (body.content || '(empty)'));
        }
        const files = body.files || [];
        if (files.length === 0) return text(`${body.projectName} has no shared content files.`);
        return text(`${body.projectName} shared files:\n` + files.map((f) => `- ${f}`).join('\n'));
      }

      if (name === 'start_agent') {
        const project = String(a.project || '').trim();
        const agent = String(a.agent || '').trim();
        if (!project || !agent) return err('project and agent are required.');
        const res = await daemonFetch(
          `${args.daemonUrl}/org/start-agent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project, agent }),
          },
          90_000,
        );
        const body = (await res.json().catch(() => ({}))) as StartResult;
        const who = `${body.agentName || agent} (${body.projectName || project})`;
        switch (body.status) {
          case 'started':
            return text(`${who} is now running and ready — you can ask_agent it now.`);
          case 'already-running':
            return text(`${who} was already running.`);
          case 'start-failed':
            return err(body.error || `Failed to start ${who}.`);
          case 'not-found':
            return err(body.error || `Could not find agent "${agent}" in "${project}".`);
          default:
            return err(body.error || `start_agent failed (${body.status || 'unknown'}).`);
        }
      }

      if (name === 'ask_agent') {
        const project = String(a.project || '').trim();
        const agent = String(a.agent || '').trim();
        const message = String(a.message || '').trim();
        if (!project || !agent || !message) {
          return err('project, agent, and message are all required.');
        }
        // The daemon holds the response open while the target agent finishes
        // its turn — give it generous headroom on top of the daemon's own cap.
        const res = await daemonFetch(
          `${args.daemonUrl}/org/ask-agent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project, agent, message }),
          },
          180_000,
        );
        const body = (await res.json().catch(() => ({}))) as AskResult;
        if (!res.ok && !body.status) {
          return err(`ask_agent failed: HTTP ${res.status}`);
        }

        const who = `${body.agentName || agent} (${body.projectName || project})`;
        switch (body.status) {
          case 'replied':
            return text(`${who} replied:\n\n${body.reply}`);
          case 'no-reply':
            return text(
              `${who} finished its turn but no reply text could be captured. ` +
              `Check the agent's terminal, or ask again.`,
            );
          case 'timeout':
            return text(
              `${who} received the message and is still working (did not finish ` +
              `within the wait window). Ask again shortly to collect the result.`,
            );
          case 'delivered':
            return text(
              `Message delivered to ${who}. Reply capture is not yet supported ` +
              `for ${body.cli} agents — check its terminal for the response.`,
            );
          case 'not-running':
            return text(
              `${who} is not running. Call start_agent on it first (that resumes ` +
              `its previous session), then ask_agent again.`,
            );
          case 'not-found':
            return err(body.error || `Could not find agent "${agent}" in "${project}".`);
          default:
            return err(body.error || `ask_agent failed (${body.status || 'unknown'}).`);
        }
      }

      if (name === 'broadcast') {
        const message = String(a.message || '').trim();
        const project = a.project ? String(a.project).trim() : '';
        if (!message) return err('message is required.');
        const res = await daemonFetch(
          `${args.daemonUrl}/org/broadcast`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, project: project || undefined }),
          },
          200_000,
        );
        const body = (await res.json().catch(() => ({}))) as BroadcastBody;
        const replies = body.replies || [];
        const skipped = body.skipped || [];
        const skippedLine = skipped.length
          ? `\n\nSkipped (not running): ${skipped.map((s) => `${s.agentName} (${s.projectName})`).join(', ')}`
          : '';

        if (replies.length === 0) {
          return text((body.error || 'No running agents to broadcast to.') + skippedLine);
        }
        const blocks = replies.map((r) => {
          const head = `## ${r.agentName} (${r.projectName}) — ${r.status}`;
          if (r.status === 'replied' && r.reply) return `${head}\n${r.reply}`;
          if (r.status === 'delivered') {
            return `${head}\n(delivered; reply capture not supported for ${r.cli} agents)`;
          }
          if (r.status === 'timeout') return `${head}\n(still working — no reply captured yet)`;
          return head;
        });
        return text(
          `Broadcast to ${replies.length} agent(s):\n\n` + blocks.join('\n\n') + skippedLine,
        );
      }

      return err(`Unknown tool: ${name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`Tool call failed: ${msg}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[hive-mcp] connected — daemon ${args.daemonUrl}`);
}

main().catch((e) => {
  console.error('[hive-mcp] fatal:', e);
  process.exit(1);
});
