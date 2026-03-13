// OpenClaw Plugin Entry Point for OpenBroker

import type { OpenClawPluginApi, OpenBrokerPluginConfig, PluginLogger } from './types.js';
import { applyConfigBridge } from './config-bridge.js';
import { PositionWatcher } from './watcher.js';
import { createTools } from './tools.js';
import { registerCliCommands } from './cli.js';

/**
 * AutomationService — restarts automations from the file-based registry
 * when the OpenClaw gateway starts. When the gateway process dies,
 * automations die with it. On next start, this service reads the registry
 * and restarts any automations that were previously running.
 */
function createAutomationService(logger: PluginLogger, gatewayPort?: number, hooksToken?: string) {
  return {
    id: 'openbroker-automations',

    async start() {
      const { getAutomationsToRestart } = await import('../auto/registry.js');
      const entries = getAutomationsToRestart();

      if (entries.length === 0) {
        logger.debug('No automations to restart');
        return;
      }

      logger.info(`Restarting ${entries.length} automation(s) from previous session`);

      const { startAutomation } = await import('../auto/runtime.js');
      const { resolveScriptPath } = await import('../auto/loader.js');

      for (const entry of entries) {
        try {
          // Verify script still exists before restarting
          const scriptPath = resolveScriptPath(entry.scriptPath);
          await startAutomation({
            scriptPath,
            id: entry.id,
            dryRun: entry.dryRun,
            verbose: entry.verbose,
            pollIntervalMs: entry.pollIntervalMs,
            gatewayPort,
            hooksToken,
          });
          logger.info(`Restarted automation: ${entry.id}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Failed to restart automation "${entry.id}": ${msg}`);

          // Mark as errored in registry so it doesn't retry forever
          const { markAutomationError } = await import('../auto/registry.js');
          markAutomationError(entry.id, msg);
        }
      }
    },

    async stop() {
      // Stop all in-process automations but keep them in the file registry
      // so they restart when the gateway comes back up
      const { getRunningAutomations } = await import('../auto/runtime.js');
      const running = getRunningAutomations();

      for (const auto of running) {
        try {
          await auto.stop({ persist: false }); // Keep in registry for restart
          logger.info(`Stopped automation for gateway shutdown: ${auto.id}`);
        } catch (err) {
          logger.error(`Error stopping automation "${auto.id}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}

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

    // 3. Register automation restart service
    const resolvedHooksToken = pluginConfig.hooksToken || process.env.OPENCLAW_HOOKS_TOKEN;
    api.registerService(createAutomationService(logger, gatewayPort, resolvedHooksToken));
    logger.debug('OpenBroker automation service registered');

    // 4. Register agent tools
    const tools = createTools({
      watcher,
      gatewayPort,
      hooksToken: pluginConfig.hooksToken || process.env.OPENCLAW_HOOKS_TOKEN,
    });
    for (const tool of tools) {
      api.registerTool(tool);
    }
    logger.debug(`Registered ${tools.length} OpenBroker agent tools`);

    // 5. Register CLI commands
    registerCliCommands(api, watcher, logger);
    logger.debug('OpenBroker CLI commands registered');
  },
};
