// Maps OpenClaw plugin config → process.env vars
// Only sets vars that are not already defined (env vars take priority)

import type { OpenBrokerPluginConfig } from './types.js';

const CONFIG_MAP: Record<string, string> = {
  privateKey: 'HYPERLIQUID_PRIVATE_KEY',
  accountAddress: 'HYPERLIQUID_ACCOUNT_ADDRESS',
  network: 'HYPERLIQUID_NETWORK',
};

/**
 * Inject plugin config values into process.env if not already set.
 *
 * Priority chain:
 * 1. Real env vars (highest — already in process.env)
 * 2. Plugin config (injected here)
 * 3. ~/.openbroker/.env (loaded by core/config.ts)
 * 4. Hardcoded defaults in core/config.ts
 */
export function applyConfigBridge(pluginConfig: Record<string, unknown>): void {
  const config = pluginConfig as OpenBrokerPluginConfig;

  for (const [key, envVar] of Object.entries(CONFIG_MAP)) {
    const value = config[key as keyof OpenBrokerPluginConfig];
    if (value !== undefined && value !== null && typeof value !== 'object' && !process.env[envVar]) {
      process.env[envVar] = String(value);
    }
  }
}
