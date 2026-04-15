// Automation script loader — discovers and loads .ts automation files

import { existsSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { AutomationFactory, AutomationConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTOMATIONS_DIR = path.join(os.homedir(), '.openbroker', 'automations');
const EXAMPLES_DIR = path.join(__dirname, 'examples');

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

/** Resolve a bundled example by name */
export function resolveExamplePath(name: string): string {
  const examplePath = path.join(EXAMPLES_DIR, `${name}.ts`);
  if (!existsSync(examplePath)) {
    const available = listExamples().map(e => e.name).join(', ');
    throw new Error(`Unknown example: ${name}\nAvailable: ${available}`);
  }
  return examplePath;
}

/** List bundled example automations */
export function listExamples(): Array<{ name: string; path: string }> {
  if (!existsSync(EXAMPLES_DIR)) return [];

  return readdirSync(EXAMPLES_DIR)
    .filter(f => f.endsWith('.ts') && !f.startsWith('.'))
    .map(f => ({
      name: f.replace(/\.ts$/, ''),
      path: path.join(EXAMPLES_DIR, f),
    }));
}

/** Load config metadata from all bundled examples */
export async function loadExampleConfigs(): Promise<Record<string, AutomationConfig>> {
  const examples = listExamples();
  const configs: Record<string, AutomationConfig> = {};

  for (const example of examples) {
    try {
      const mod = await import(example.path);
      const config = resolveAutomationConfig(mod);
      if (config && typeof config === 'object' && config.description) {
        configs[example.name] = config;
      }
    } catch {
      // Skip examples that fail to load
    }
  }

  return configs;
}

function resolveAutomationFactory(mod: Record<string, unknown>): AutomationFactory | null {
  const candidates = [
    mod.default,
    (mod.default as Record<string, unknown> | undefined)?.default,
    mod["module.exports"],
    ((mod["module.exports"] as Record<string, unknown> | undefined)?.default)
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as AutomationFactory;
    }
  }

  return null;
}

function resolveAutomationConfig(mod: Record<string, unknown>): AutomationConfig | null {
  const candidates = [
    mod.config,
    (mod.default as Record<string, unknown> | undefined)?.config,
    (mod["module.exports"] as Record<string, unknown> | undefined)?.config
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && "description" in candidate) {
      return candidate as AutomationConfig;
    }
  }

  return null;
}

/** Load an automation module and validate the default export */
export async function loadAutomation(scriptPath: string): Promise<AutomationFactory> {
  const absolutePath = path.resolve(scriptPath);

  // Dynamic import — tsx handles TypeScript transpilation
  const mod = await import(absolutePath);

  const factory = resolveAutomationFactory(mod as Record<string, unknown>);
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
