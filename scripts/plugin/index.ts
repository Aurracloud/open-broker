// OpenClaw Plugin Entry Point for OpenBroker

import type { OpenClawPluginApi, OpenBrokerPluginConfig } from './types.js';
import { applyConfigBridge } from './config-bridge.js';
import { PositionWatcher } from './watcher.js';
import { createTools } from './tools.js';
import { registerCliCommands } from './cli.js';

export default {
  id: 'openbroker',
  name: 'OpenBroker — Hyperliquid Trading',

  register(api: OpenClawPluginApi): void {
    const { logger, gatewayPort } = api;
    const pluginConfig = (api.pluginConfig ?? {}) as OpenBrokerPluginConfig;

    // 1. Apply config bridge: inject plugin config → process.env
    applyConfigBridge(pluginConfig as Record<string, unknown>);
    logger.debug('OpenBroker config bridge applied');

    // 2. Register background position watcher (unless disabled)
    let watcher: PositionWatcher | null = null;
    const watcherEnabled = pluginConfig.watcher?.enabled !== false;

    if (watcherEnabled) {
      watcher = new PositionWatcher({
        logger,
        gatewayPort,
        hooksToken: pluginConfig.hooksToken,
        accountAddress: pluginConfig.accountAddress
          || process.env.HYPERLIQUID_ACCOUNT_ADDRESS
          || undefined,
        network: pluginConfig.network || process.env.HYPERLIQUID_NETWORK,
        pollIntervalMs: pluginConfig.watcher?.pollIntervalMs,
        pnlChangeThresholdPct: pluginConfig.watcher?.pnlChangeThresholdPct,
        marginUsageWarningPct: pluginConfig.watcher?.marginUsageWarningPct,
        notifyOnPositionChange: pluginConfig.watcher?.notifyOnPositionChange,
        notifyOnFunding: pluginConfig.watcher?.notifyOnFunding,
      });
      api.registerService(watcher);
      logger.debug('OpenBroker position watcher registered');
    } else {
      logger.debug('OpenBroker position watcher disabled by config');
    }

    // 3. Register agent tools
    const tools = createTools(watcher);
    for (const tool of tools) {
      api.registerTool(tool);
    }
    logger.debug(`Registered ${tools.length} OpenBroker agent tools`);

    // 4. Register CLI commands
    registerCliCommands(api, watcher, logger);
    logger.debug('OpenBroker CLI commands registered');
  },
};
