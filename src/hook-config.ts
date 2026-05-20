/**
 * Per-agent Claude Code hook configuration.
 *
 * When the daemon starts a Claude agent it writes a session-scoped settings
 * file to ~/.termhive/hook-configs/<agentId>.json and passes it via
 * `claude --settings <path>`. The hooks fire on lifecycle events and POST to
 * the daemon's HTTP endpoint, which turns them into precise agent status.
 *
 * `--settings` is additive — it merges with the user's global settings, so
 * their own hooks keep working.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Lifecycle events we register hooks for. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Map a hook event to a coarse agent status. */
export function hookEventToStatus(event: string): string | null {
  switch (event) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'running';
    case 'Notification': // permission prompt or idle prompt — either way, needs you
    case 'Stop':         // turn finished — waiting for the next prompt
      return 'awaiting_input';
    case 'SessionEnd':
      return 'stopped';
    default:
      return null;
  }
}

function hookConfigDir(): string {
  return path.join(os.homedir(), '.termhive', 'hook-configs');
}

export function getHookConfigPath(agentId: string): string {
  return path.join(hookConfigDir(), `${agentId}.json`);
}

/**
 * Write the per-agent hook settings file. Each hook is a curl POST to the
 * daemon. Returns the file path (to pass to `claude --settings`).
 */
export function writeClaudeHookConfig(agentId: string, hookBaseUrl: string): string {
  const dir = hookConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    const url = `${hookBaseUrl}/hook/${agentId}/${event}`;
    hooks[event] = [
      {
        hooks: [
          {
            type: 'command',
            // -s silent, --max-time 2 so a slow/dead daemon never stalls the
            // agent. The daemon replies 204 with an empty body, so nothing is
            // written to stdout (cross-platform — no /dev/null vs NUL needed).
            command: `curl -s --max-time 2 -X POST "${url}"`,
          },
        ],
      },
    ];
  }

  const configPath = getHookConfigPath(agentId);
  fs.writeFileSync(configPath, JSON.stringify({ hooks }, null, 2), 'utf-8');
  return configPath;
}

/** Remove an agent's hook config (called on agent deletion). */
export function removeClaudeHookConfig(agentId: string): void {
  try {
    const p = getHookConfigPath(agentId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}
