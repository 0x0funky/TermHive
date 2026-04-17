import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { SHARED_CONTENT_DIR } from './storage.js';
import type { ActivityEvent } from './types.js';

const MAX_EVENTS = 200;
const events: ActivityEvent[] = [];
const watchers = new Map<string, FSWatcher>();

let broadcastFn: ((event: ActivityEvent) => void) | null = null;

export function setBroadcast(fn: (event: ActivityEvent) => void) {
  broadcastFn = fn;
}

export function pushEvent(event: Omit<ActivityEvent, 'id' | 'timestamp'>) {
  const full: ActivityEvent = {
    ...event,
    id: uuid(),
    timestamp: new Date().toISOString(),
  };
  events.push(full);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcastFn?.(full);
}

export function getEvents(projectId?: string): ActivityEvent[] {
  if (projectId) return events.filter(e => e.projectId === projectId);
  return [...events];
}

/**
 * Start watching a project's shared content directory for file changes.
 */
export function watchProject(projectId: string, projectName: string) {
  if (watchers.has(projectId)) return;

  const dir = path.join(SHARED_CONTENT_DIR, projectName);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`[activity] Watching shared content: ${dir}`);

  const watcher = watch(dir, {
    ignoreInitial: true,
    // Allow nested subfolders (up to 5 levels deep to avoid runaway watchers on symlink loops)
    depth: 5,
  });

  // Convert full filesystem path to shared-content-relative path with forward slashes
  const toRelative = (filePath: string): string =>
    path.relative(dir, filePath).replace(/\\/g, '/');

  // Skip hidden files/folders at any level (e.g. ".git", "subfolder/.DS_Store")
  const isHidden = (relPath: string): boolean =>
    relPath.split('/').some(seg => seg.startsWith('.'));

  watcher.on('add', (filePath: string) => {
    const rel = toRelative(filePath);
    if (!rel || isHidden(rel)) return;
    console.log(`[activity] File created: ${rel}`);
    pushEvent({
      projectId,
      event: 'content:created',
      detail: `File created: ${rel}`,
    });
  });

  watcher.on('change', (filePath: string) => {
    const rel = toRelative(filePath);
    if (!rel || isHidden(rel)) return;
    console.log(`[activity] File modified: ${rel}`);
    pushEvent({
      projectId,
      event: 'content:modified',
      detail: `File modified: ${rel}`,
    });
  });

  watcher.on('unlink', (filePath: string) => {
    const rel = toRelative(filePath);
    if (!rel || isHidden(rel)) return;
    console.log(`[activity] File deleted: ${rel}`);
    pushEvent({
      projectId,
      event: 'content:deleted',
      detail: `File deleted: ${rel}`,
    });
  });

  watcher.on('error', (err: Error) => {
    console.error(`[activity] Watcher error for ${projectName}:`, err);
  });

  watchers.set(projectId, watcher);
}

export function unwatchProject(projectId: string) {
  const watcher = watchers.get(projectId);
  if (watcher) {
    watcher.close();
    watchers.delete(projectId);
  }
}
