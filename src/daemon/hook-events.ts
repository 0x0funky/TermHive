/**
 * Tiny event bus for Claude Code lifecycle hooks.
 *
 * The daemon's HTTP hook endpoint emits `('hook', agentId, event)` here for
 * every lifecycle event it receives. The Hive dispatch layer (hive.ts) listens
 * so it can tell when an `ask_agent` turn has started and finished.
 *
 * Kept in its own module so daemon.ts (emitter) and hive.ts (listener) share
 * it without a circular import.
 */

import { EventEmitter } from 'events';

/** Emits `('hook', agentId: string, event: string)`. */
export const hookEvents = new EventEmitter();
// A daemon may drive several agents at once — lift the default 10-listener cap.
hookEvents.setMaxListeners(100);
