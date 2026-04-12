#!/usr/bin/env node
/**
 * Termhive MCP Server
 *
 * Provides coding-agent-to-agent messaging via MCP. Spawned as a stdio MCP server
 * per Claude Code / Codex CLI agent session. Each instance is configured with its
 * own identity (project, agent) via command-line args, then forwards tool calls
 * to the Termhive backend over HTTP.
 *
 * Args:
 *   --hub    <url>         Termhive server URL (default http://localhost:3200)
 *   --project <projectId>  UUID of the project this agent belongs to
 *   --agent   <agentId>    UUID of this agent
 *   --name    <agentName>  Display name of this agent
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

interface Args {
  hubUrl: string;
  projectId: string;
  agentId: string;
  agentName: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  return {
    hubUrl: getArg('hub') || process.env.TERMHIVE_HUB_URL || 'http://localhost:3200',
    projectId: getArg('project') || process.env.TERMHIVE_PROJECT_ID || '',
    agentId: getArg('agent') || process.env.TERMHIVE_AGENT_ID || '',
    agentName: getArg('name') || process.env.TERMHIVE_AGENT_NAME || 'unknown',
  };
}

async function hubFetch(args: Args, path: string, init?: RequestInit): Promise<Response> {
  const url = `${args.hubUrl}${path}`;
  return fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

async function main() {
  const args = parseArgs();

  if (!args.projectId || !args.agentId) {
    console.error('[termhive-mcp] Missing --project or --agent arg. MCP will start but tools may fail.');
  }

  const server = new Server(
    {
      name: 'termhive',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'message_agent',
        description:
          'Send a message to another agent (teammate) in this project. ' +
          'Use this when the user asks you to notify, tell, or communicate with another agent. ' +
          'The target agent will see the message in their terminal. ' +
          'Call list_teammates first if you are unsure who is available.',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'The name of the target agent (case-insensitive). Must be another agent in the same project.',
            },
            message: {
              type: 'string',
              description: 'The message content to send. Be clear and actionable. Mention file paths if referring to shared content.',
            },
          },
          required: ['target', 'message'],
        },
      },
      {
        name: 'list_teammates',
        description:
          'List all other agents in this project that you can send messages to. ' +
          'Returns each teammate\'s name, role, CLI, and running status. ' +
          'Useful when the user mentions a teammate by role (e.g. "the backend") rather than name.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params;

    try {
      if (name === 'message_agent') {
        const target = String((toolArgs as Record<string, unknown>)?.target || '').trim();
        const message = String((toolArgs as Record<string, unknown>)?.message || '').trim();
        if (!target || !message) {
          return { content: [{ type: 'text', text: 'Error: target and message are required.' }], isError: true };
        }

        const res = await hubFetch(args, `/api/projects/${args.projectId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            fromAgentId: args.agentId,
            fromAgentName: args.agentName,
            target,
            message,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errMsg = (body as { error?: string }).error || `HTTP ${res.status}`;
          return { content: [{ type: 'text', text: `Failed to send: ${errMsg}` }], isError: true };
        }
        const delivered = (body as { delivered?: boolean; toAgentName?: string }).delivered;
        const to = (body as { toAgentName?: string }).toAgentName || target;
        return {
          content: [
            {
              type: 'text',
              text: delivered
                ? `Message delivered to ${to}.`
                : `Message queued for ${to} (agent not running — will see it when next attended).`,
            },
          ],
        };
      }

      if (name === 'list_teammates') {
        const res = await hubFetch(args, `/api/projects/${args.projectId}/agents/${args.agentId}/teammates`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errMsg = (body as { error?: string }).error || `HTTP ${res.status}`;
          return { content: [{ type: 'text', text: `Failed to list teammates: ${errMsg}` }], isError: true };
        }
        const teammates = (body as { teammates?: Array<{ name: string; role?: string; cli: string; status: string }> }).teammates || [];
        if (teammates.length === 0) {
          return { content: [{ type: 'text', text: 'No teammates in this project.' }] };
        }
        const lines = teammates.map(t => {
          const role = t.role ? ` — ${t.role}` : '';
          return `- ${t.name} (${t.cli}, ${t.status})${role}`;
        });
        return { content: [{ type: 'text', text: 'Teammates:\n' + lines.join('\n') }] };
      }

      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Tool call failed: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[termhive-mcp] connected as ${args.agentName} (${args.agentId})`);
}

main().catch((err) => {
  console.error('[termhive-mcp] fatal:', err);
  process.exit(1);
});
