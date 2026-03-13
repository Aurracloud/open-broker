// Background Position Watcher
// Polls Hyperliquid via the core client for position changes and sends hook notifications

import type {
  PluginLogger,
  PluginService,
  AccountSnapshot,
  PositionSnapshot,
  PositionEvent,
  WatcherStatus,
} from './types.js';

interface WatcherOptions {
  logger: PluginLogger;
  gatewayPort: number;
  hooksToken?: string;
  accountAddress?: string;
  network?: string;
  pollIntervalMs?: number;
  pnlChangeThresholdPct?: number;
  marginUsageWarningPct?: number;
  notifyOnPositionChange?: boolean;
  notifyOnFunding?: boolean;
}

export class PositionWatcher implements PluginService {
  readonly id = 'ob-position-watcher';

  private logger: PluginLogger;
  private gatewayPort: number;
  private hooksToken: string | undefined;
  private pollIntervalMs: number;
  private pnlChangeThresholdPct: number;
  private marginUsageWarningPct: number;
  private notifyOnPositionChange: boolean;

  private accountAddress: string | undefined;
  private previousSnapshot: AccountSnapshot | null = null;
  private eventsDetected = 0;
  private lastPollAt: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private seeded = false;

  constructor(options: WatcherOptions) {
    this.logger = options.logger;
    this.gatewayPort = options.gatewayPort;
    this.hooksToken = options.hooksToken || process.env.OPENCLAW_HOOKS_TOKEN;
    this.accountAddress = options.accountAddress || process.env.HYPERLIQUID_ACCOUNT_ADDRESS || undefined;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.pnlChangeThresholdPct = options.pnlChangeThresholdPct ?? 5;
    this.marginUsageWarningPct = options.marginUsageWarningPct ?? 80;
    this.notifyOnPositionChange = options.notifyOnPositionChange ?? true;
  }

  async start(): Promise<void> {
    // Resolve account address from client if not set
    if (!this.accountAddress) {
      try {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        this.accountAddress = client.address;
      } catch {
        this.logger.warn('Could not resolve account address — position watcher cannot start. Run "openbroker setup" first.');
        return;
      }
    }

    this.logger.info(`Starting position watcher for ${this.accountAddress} (poll every ${this.pollIntervalMs / 1000}s)`);

    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);

    // Initial poll to seed state
    await this.poll();
    this.seeded = true;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Position watcher stopped');
  }

  getStatus(): WatcherStatus {
    const positions: WatcherStatus['positions'] = [];

    if (this.previousSnapshot) {
      for (const p of this.previousSnapshot.positions.values()) {
        positions.push({
          coin: p.coin,
          size: p.szi,
          entryPrice: p.entryPx,
          unrealizedPnl: p.unrealizedPnl,
          liquidationPrice: p.liquidationPx,
        });
      }
    }

    return {
      running: this.timer !== null,
      pollIntervalMs: this.pollIntervalMs,
      accountAddress: this.accountAddress ?? null,
      positions,
      equity: this.previousSnapshot?.equity ?? null,
      marginUsedPct: this.previousSnapshot?.marginUsedPct ?? null,
      eventsDetected: this.eventsDetected,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
    };
  }

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const { getClient } = await import('../core/client.js');
      const client = getClient();
      const state = await client.getUserStateAll(this.accountAddress);

      const snapshot = this.buildSnapshot(state);

      const posCount = snapshot.positions.size;
      const equity = parseFloat(snapshot.equity).toFixed(2);
      const marginPct = snapshot.marginUsedPct.toFixed(1);
      this.logger.debug(`Poll: ${posCount} position(s), equity $${equity}, margin ${marginPct}%`);

      const events = this.seeded ? this.detectEvents(snapshot) : [];

      if (events.length > 0) {
        for (const event of events) {
          this.eventsDetected++;
          this.logger.info(`[${event.type}] ${event.message}`);
          await this.sendHook(event);
        }
      } else if (this.seeded) {
        this.logger.debug('No position changes detected');
      }

      this.previousSnapshot = snapshot;
      this.lastPollAt = new Date();
    } catch (err) {
      this.logger.error(`Watcher poll error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isPolling = false;
    }
  }

  private buildSnapshot(state: { marginSummary: { accountValue: string; totalMarginUsed: string }; assetPositions: Array<{ position: PositionSnapshot }> }): AccountSnapshot {
    const positions = new Map<string, PositionSnapshot>();

    for (const ap of state.assetPositions) {
      const p = ap.position;
      if (parseFloat(p.szi) === 0) continue;

      positions.set(p.coin, {
        coin: p.coin,
        szi: p.szi,
        entryPx: p.entryPx,
        positionValue: p.positionValue,
        unrealizedPnl: p.unrealizedPnl,
        returnOnEquity: p.returnOnEquity,
        liquidationPx: p.liquidationPx,
        leverage: p.leverage,
        marginUsed: p.marginUsed,
      });
    }

    const equity = parseFloat(state.marginSummary.accountValue);
    const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);
    const marginUsedPct = equity > 0 ? (marginUsed / equity) * 100 : 0;

    return {
      equity: state.marginSummary.accountValue,
      marginUsed: state.marginSummary.totalMarginUsed,
      marginUsedPct,
      positions,
      timestamp: Date.now(),
    };
  }

  private detectEvents(current: AccountSnapshot): PositionEvent[] {
    const events: PositionEvent[] = [];
    const prev = this.previousSnapshot;
    if (!prev) return events;

    const now = new Date().toISOString();

    // 1. New positions (opened)
    if (this.notifyOnPositionChange) {
      for (const [coin, pos] of current.positions) {
        if (!prev.positions.has(coin)) {
          const side = parseFloat(pos.szi) > 0 ? 'long' : 'short';
          events.push({
            type: 'position_opened',
            coin,
            message: `Position opened: ${side} ${Math.abs(parseFloat(pos.szi))} ${coin} at $${pos.entryPx}`,
            details: { coin, side, size: pos.szi, entryPrice: pos.entryPx },
            detectedAt: now,
          });
        }
      }

      // 2. Closed positions
      for (const [coin, pos] of prev.positions) {
        if (!current.positions.has(coin)) {
          events.push({
            type: 'position_closed',
            coin,
            message: `Position closed: ${coin} (was ${pos.szi} at $${pos.entryPx}, final unrealized PnL: $${pos.unrealizedPnl})`,
            details: { coin, previousSize: pos.szi, entryPrice: pos.entryPx, lastPnl: pos.unrealizedPnl },
            detectedAt: now,
          });
        }
      }

      // 3. Size changes
      for (const [coin, pos] of current.positions) {
        const prevPos = prev.positions.get(coin);
        if (!prevPos) continue;

        const currentSize = parseFloat(pos.szi);
        const prevSize = parseFloat(prevPos.szi);

        if (currentSize !== prevSize) {
          const diff = currentSize - prevSize;
          const action = Math.abs(currentSize) > Math.abs(prevSize) ? 'increased' : 'decreased';
          events.push({
            type: 'position_size_changed',
            coin,
            message: `Position ${coin} size ${action}: ${prevPos.szi} → ${pos.szi} (${diff > 0 ? '+' : ''}${diff.toFixed(6)})`,
            details: { coin, previousSize: prevPos.szi, newSize: pos.szi, change: diff },
            detectedAt: now,
          });
        }
      }
    }

    // 4. PnL threshold
    for (const [coin, pos] of current.positions) {
      const prevPos = prev.positions.get(coin);
      if (!prevPos) continue;

      const currentPnl = parseFloat(pos.unrealizedPnl);
      const prevPnl = parseFloat(prevPos.unrealizedPnl);
      const posValue = parseFloat(pos.positionValue);

      if (posValue === 0) continue;

      const pnlChangePct = Math.abs(((currentPnl - prevPnl) / posValue) * 100);

      if (pnlChangePct >= this.pnlChangeThresholdPct) {
        events.push({
          type: 'pnl_threshold',
          coin,
          message: `PnL alert on ${coin}: $${prevPnl.toFixed(2)} → $${currentPnl.toFixed(2)} (${pnlChangePct.toFixed(1)}% of position). Position value: $${posValue.toFixed(2)}`,
          details: {
            coin, previousPnl: prevPnl, currentPnl, changePct: pnlChangePct, positionValue: posValue,
          },
          detectedAt: now,
        });
      }
    }

    // 5. Margin usage warning
    if (current.marginUsedPct >= this.marginUsageWarningPct) {
      const prevMarginPct = prev.marginUsedPct;
      if (prevMarginPct < this.marginUsageWarningPct || current.marginUsedPct - prevMarginPct >= 5) {
        events.push({
          type: 'margin_warning',
          message: `Margin usage warning: ${current.marginUsedPct.toFixed(1)}% (equity: $${current.equity}, margin used: $${current.marginUsed})`,
          details: {
            marginUsedPct: current.marginUsedPct,
            equity: current.equity,
            marginUsed: current.marginUsed,
            threshold: this.marginUsageWarningPct,
          },
          detectedAt: now,
        });
      }
    }

    return events;
  }

  private async sendHook(event: PositionEvent): Promise<void> {
    const port = this.gatewayPort || 18789;

    if (!this.hooksToken) {
      this.logger.debug('sendHook skipped — no hooks token configured');
      return;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.hooksToken}`,
        },
        body: JSON.stringify({
          message: event.message,
          name: `ob-watcher-${event.type}`,
          wakeMode: 'now',
        }),
      });

      if (!res.ok) {
        this.logger.warn(`sendHook failed: HTTP ${res.status} ${res.statusText}`);
      } else {
        this.logger.debug(`sendHook delivered for ${event.type} (${event.message.length} chars)`);
      }
    } catch (err) {
      this.logger.warn(`sendHook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
