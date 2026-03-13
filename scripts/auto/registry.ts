// File-based automation registry — tracks desired state across processes
// Persisted at ~/.openbroker/state/_registry.json so both CLI and plugin
// can see which automations should be running.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const STATE_DIR = path.join(os.homedir(), '.openbroker', 'state');
const REGISTRY_FILE = path.join(STATE_DIR, '_registry.json');

export interface RegistryEntry {
  id: string;
  scriptPath: string;
  dryRun: boolean;
  verbose: boolean;
  pollIntervalMs: number;
  startedAt: string;        // ISO timestamp
  pid: number;              // Process that started it
  status: 'running' | 'stopped' | 'error';
  error?: string;           // Last error message if status is 'error'
}

function ensureDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

function readRegistry(): RegistryEntry[] {
  if (!existsSync(REGISTRY_FILE)) return [];
  try {
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  ensureDir();
  writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
}

/** Check if a process is still alive */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = just check, don't kill
    return true;
  } catch {
    return false;
  }
}

/** Register an automation as running */
export function registerAutomation(entry: Omit<RegistryEntry, 'status' | 'pid' | 'startedAt'>): void {
  const entries = readRegistry();

  // Remove any existing entry with the same id
  const filtered = entries.filter(e => e.id !== entry.id);

  filtered.push({
    ...entry,
    status: 'running',
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  writeRegistry(filtered);
}

/** Unregister an automation (remove from desired state) */
export function unregisterAutomation(id: string): void {
  const entries = readRegistry();
  writeRegistry(entries.filter(e => e.id !== id));
}

/** Mark an automation as errored (keep in registry for visibility) */
export function markAutomationError(id: string, error: string): void {
  const entries = readRegistry();
  const entry = entries.find(e => e.id === id);
  if (entry) {
    entry.status = 'error';
    entry.error = error;
    writeRegistry(entries);
  }
}

/** Get all registered automations, with stale process detection */
export function getRegisteredAutomations(): RegistryEntry[] {
  const entries = readRegistry();
  let dirty = false;

  for (const entry of entries) {
    if (entry.status === 'running' && !isProcessAlive(entry.pid)) {
      // Process died without cleanup — mark as stopped
      entry.status = 'stopped';
      dirty = true;
    }
  }

  if (dirty) writeRegistry(entries);
  return entries;
}

/** Get automations that should be restarted (were running when process died) */
export function getAutomationsToRestart(): RegistryEntry[] {
  const entries = getRegisteredAutomations();
  // Return entries that were running but whose process is no longer alive
  // (getRegisteredAutomations already marked them as 'stopped')
  // We want entries that are 'stopped' — they need to be restarted
  return entries.filter(e => e.status === 'stopped');
}

/** Clean up the registry — remove stopped/errored entries */
export function cleanRegistry(): void {
  const entries = readRegistry();
  writeRegistry(entries.filter(e => e.status === 'running' && isProcessAlive(e.pid)));
}
