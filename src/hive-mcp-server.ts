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
