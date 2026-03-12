// Automation script loader — discovers and loads .ts automation files

import { existsSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import type { AutomationFactory } from './types.js';

const AUTOMATIONS_DIR = path.join(os.homedir(), '.openbroker', 'automations');

/** Resolve a script path from a name or path */
export function resolveScriptPath(nameOrPath: string): string {
  // Absolute path
  if (path.isAbsolute(nameOrPath)) {
    if (!existsSync(nameOrPath)) {
      throw new Error(`Automation script not found: ${nameOrPath}`);
    }
    return nameOrPath;
  }

  // Relative to cwd
  const cwdPath = path.resolve(process.cwd(), nameOrPath);
  if (existsSync(cwdPath)) return cwdPath;

  // Relative to ~/.openbroker/automations/
  const globalPath = path.join(AUTOMATIONS_DIR, nameOrPath);
  if (existsSync(globalPath)) return globalPath;

  // Try appending .ts
  const withExt = path.join(AUTOMATIONS_DIR, `${nameOrPath}.ts`);
  if (existsSync(withExt)) return withExt;

  throw new Error(
    `Automation script not found: ${nameOrPath}\n` +
    `Searched:\n  ${cwdPath}\n  ${globalPath}\n  ${withExt}`,
  );
}

/** Load an automation module and validate the default export */
export async function loadAutomation(scriptPath: string): Promise<AutomationFactory> {
  const absolutePath = path.resolve(scriptPath);

  // Dynamic import — tsx handles TypeScript transpilation
  const mod = await import(absolutePath);

  const factory = mod.default;
  if (typeof factory !== 'function') {
    throw new Error(
      `Automation script must export a default function.\n` +
      `Got: ${typeof factory} from ${scriptPath}`,
    );
  }

  return factory as AutomationFactory;
}

/** List available automation scripts in ~/.openbroker/automations/ */
export function listAutomations(): Array<{ name: string; path: string }> {
  if (!existsSync(AUTOMATIONS_DIR)) return [];

  return readdirSync(AUTOMATIONS_DIR)
    .filter(f => f.endsWith('.ts') && !f.startsWith('.'))
    .map(f => ({
      name: f.replace(/\.ts$/, ''),
      path: path.join(AUTOMATIONS_DIR, f),
    }));
}

/** Ensure the automations directory exists */
export function ensureAutomationsDir(): void {
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
}
