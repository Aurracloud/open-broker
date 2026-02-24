// CLI commands for the OpenClaw plugin
// Registered via api.registerCli with Commander.js-style program

import type { PluginLogger, OpenClawPluginApi } from './types.js';
import type { PositionWatcher } from './watcher.js';

export function registerCliCommands(
  api: OpenClawPluginApi,
  watcher: PositionWatcher | null,
  logger: PluginLogger,
): void {
  api.registerCli(({ program }) => {
    const ob = program.command('ob').description('OpenBroker Hyperliquid trading tools');

    ob
      .command('watch')
      .description('Start the position watcher in foreground (for debugging)')
      .option('--interval <ms>', 'Poll interval in milliseconds', '30000')
      .action(async (opts: unknown) => {
        // If watcher is already running (gateway context), show its status
        if (watcher && watcher.getStatus().running) {
          const status = watcher.getStatus();
          console.log('Position watcher is running as a background service.');
          console.log(`Account:           ${status.accountAddress}`);
          console.log(`Tracking           ${status.positions.length} position(s)`);
          console.log(`Events detected:   ${status.eventsDetected}`);
          console.log(`Last poll:         ${status.lastPollAt ?? 'Never'}`);
          return;
        }

        // CLI context: start watcher in foreground for debugging
        const { PositionWatcher: WatcherClass } = await import('./watcher.js');
        const { interval: intervalStr } = opts as { interval: string };
        const interval = parseInt(intervalStr, 10);

        const fgWatcher = new WatcherClass({
          logger,
          gatewayPort: api.gatewayPort || 0,
          pollIntervalMs: interval,
          notifyOnPositionChange: api.gatewayPort > 0,
        });

        console.log('Starting position watcher in foreground...');
        console.log(`Poll interval: ${interval / 1000}s`);
        console.log('Press Ctrl+C to stop.\n');

        process.on('SIGINT', async () => {
          await fgWatcher.stop();
          process.exit(0);
        });

        await fgWatcher.start();

        // Keep alive
        await new Promise(() => {});
      });

    ob
      .command('status')
      .description('Show position watcher status and current positions')
      .action(async () => {
        // If watcher is running in gateway context, show its live state
        if (watcher && watcher.getStatus().running) {
          const status = watcher.getStatus();

          console.log('OpenBroker Position Watcher Status');
          console.log('==================================\n');
          console.log(`Running:           Yes (background service)`);
          console.log(`Account:           ${status.accountAddress}`);
          console.log(`Poll interval:     ${status.pollIntervalMs / 1000}s`);
          console.log(`Events detected:   ${status.eventsDetected}`);
          console.log(`Last poll:         ${status.lastPollAt ?? 'Never'}`);
          console.log(`Equity:            $${status.equity ?? '?'}`);
          console.log(`Margin used:       ${status.marginUsedPct?.toFixed(1) ?? '?'}%`);

          if (status.positions.length === 0) {
            console.log('\nNo open positions.');
          } else {
            console.log(`\nOpen Positions (${status.positions.length}):`);
            for (const p of status.positions) {
              const side = parseFloat(p.size) > 0 ? 'LONG' : 'SHORT';
              console.log(`  ${p.coin} ${side}`);
              console.log(`    Size:       ${p.size}`);
              console.log(`    Entry:      $${p.entryPrice}`);
              console.log(`    Unreal PnL: $${p.unrealizedPnl}`);
              console.log(`    Liq Price:  ${p.liquidationPrice ? `$${p.liquidationPrice}` : 'N/A'}`);
              console.log('');
            }
          }
          return;
        }

        // CLI context: one-shot account query
        console.log('OpenBroker Status (live query)\n');
        try {
          const { getClient } = await import('../core/client.js');
          const { formatUsd } = await import('../core/utils.js');
          const client = getClient();
          const state = await client.getUserState();

          console.log(`Account:  ${client.address}`);
          console.log(`Equity:   ${formatUsd(parseFloat(state.marginSummary.accountValue))}`);
          console.log(`Margin:   ${formatUsd(parseFloat(state.marginSummary.totalMarginUsed))}`);

          const positions = state.assetPositions.filter(ap => parseFloat(ap.position.szi) !== 0);
          if (positions.length === 0) {
            console.log('\nNo open positions.');
          } else {
            console.log(`\nOpen Positions (${positions.length}):`);
            for (const ap of positions) {
              const p = ap.position;
              const side = parseFloat(p.szi) > 0 ? 'LONG' : 'SHORT';
              console.log(`  ${p.coin} ${side} ${p.szi} @ $${p.entryPx} | PnL: $${p.unrealizedPnl} | Liq: ${p.liquidationPx ?? 'N/A'}`);
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          console.log('\nRun "openbroker setup" to configure your wallet.');
        }

        if (watcher && !watcher.getStatus().running) {
          console.log('\nNote: The background watcher is registered but not running.');
          console.log('It starts automatically with the gateway. Use "openclaw ob watch" for foreground mode.');
        }
      });
  }, { commands: ['ob'] });
}
