// Automation Runtime — loads scripts, polls market data, dispatches events
// Supports real-time WebSocket feeds with REST polling as fallback heartbeat

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { getClient } from '../core/client.js';
import type { HyperliquidClient } from '../core/client.js';
import {
  roundPrice, roundSize, sleep, normalizeCoin,
  formatUsd, formatPercent, annualizeFundingRate,
} from '../core/utils.js';
import { WebSocketManager } from '../core/ws.js';
import { AutomationEventBus } from './events.js';
import { loadAutomation } from './loader.js';
import { registerAutomation, unregisterAutomation, markAutomationError, getRegisteredAutomations as getRegisteredFromFile } from './registry.js';
import type {
  AutomationAPI,
  AutomationLogger,
  AutomationState,
  AutomationSnapshot,
  PositionSnapshot,
  PublishOptions,
  ScheduledTask,
  RunningAutomation,
} from './types.js';

const STATE_DIR = path.join(os.homedir(), '.openbroker', 'state');

// ── State persistence ───────────────────────────────────────────────

function createState(id: string): AutomationState {
  mkdirSync(STATE_DIR, { recursive: true });
  const stateFile = path.join(STATE_DIR, `${id}.json`);

  let data: Record<string, unknown> = {};
  if (existsSync(stateFile)) {
    try {
      data = JSON.parse(readFileSync(stateFile, 'utf-8'));
    } catch {
      data = {};
    }
  }

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      writeFileSync(stateFile, JSON.stringify(data, null, 2));
    }, 500);
  }

  return {
    get<T = unknown>(key: string, defaultValue?: T): T | undefined {
      return (key in data ? data[key] : defaultValue) as T | undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      data[key] = value;
      scheduleFlush();
    },
    delete(key: string): void {
      delete data[key];
      scheduleFlush();
    },
    clear(): void {
      data = {};
      scheduleFlush();
    },
  };
}

// ── Logger ──────────────────────────────────────────────────────────

function createLogger(id: string, verbose: boolean): AutomationLogger {
  const prefix = `[auto:${id}]`;
  return {
    info: (msg: string) => console.log(`${prefix} ${msg}`),
    warn: (msg: string) => console.log(`${prefix} ⚠ ${msg}`),
    error: (msg: string) => console.error(`${prefix} ✗ ${msg}`),
    debug: (msg: string) => { if (verbose) console.log(`${prefix} … ${msg}`); },
  };
}

// ── Dry-run client proxy ────────────────────────────────────────────

const WRITE_METHODS = new Set([
  'order', 'marketOrder', 'limitOrder', 'triggerOrder',
  'takeProfit', 'stopLoss', 'cancel', 'cancelAll',
  'updateLeverage', 'approveBuilderFee',
]);

function createDryClient(client: HyperliquidClient, log: AutomationLogger): HyperliquidClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && WRITE_METHODS.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => {
          log.info(`[DRY] ${prop}(${args.map(a => JSON.stringify(a)).join(', ')})`);
          return Promise.resolve({ status: 'ok', response: { type: 'dry_run' } });
        };
      }
      return value;
    },
  });
}

// ── Snapshot building ───────────────────────────────────────────────

async function buildSnapshot(
  client: HyperliquidClient,
): Promise<AutomationSnapshot> {
  const [state, mids, metaCtxs] = await Promise.all([
    client.getUserStateAll(),
    client.getAllMids(),
    client.getMetaAndAssetCtxs(),
  ]);

  const prices = new Map<string, number>();
  for (const [coin, mid] of Object.entries(mids)) {
    prices.set(coin, parseFloat(mid as string));
  }

  const positions = new Map<string, PositionSnapshot>();
  for (const ap of state.assetPositions) {
    const p = ap.position;
    const size = parseFloat(p.szi);
    if (size === 0) continue;
    positions.set(p.coin, {
      coin: p.coin,
      size,
      entryPrice: parseFloat(p.entryPx),
      positionValue: parseFloat(p.positionValue),
      unrealizedPnl: parseFloat(p.unrealizedPnl),
      liquidationPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
      leverage: typeof p.leverage === 'object' ? p.leverage.value : parseFloat(String(p.leverage)),
      marginUsed: parseFloat(p.marginUsed),
    });
  }

  const equity = parseFloat(state.marginSummary.accountValue);
  const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);

  // Build funding rates from asset contexts
  const fundingRates = new Map<string, { rate: number; premium: number }>();
  if (metaCtxs && Array.isArray(metaCtxs)) {
    for (const group of metaCtxs) {
      if (!group.universe || !group.assetCtxs) continue;
      for (let i = 0; i < group.universe.length; i++) {
        const meta = group.universe[i];
        const ctx = group.assetCtxs[i];
        if (ctx && meta) {
          fundingRates.set(meta.name, {
            rate: parseFloat(ctx.funding || '0'),
            premium: parseFloat(ctx.premium || '0'),
          });
        }
      }
    }
  }

  return {
    prices,
    positions,
    openOrderIds: new Set(), // filled by separate call if needed
    equity,
    marginUsed,
    marginUsedPct: equity > 0 ? (marginUsed / equity) * 100 : 0,
    fundingRates,
    timestamp: Date.now(),
  };
}

// ── Publish (webhook) ───────────────────────────────────────────────

function createPublish(
  automationId: string,
  log: AutomationLogger,
  gatewayPort?: number,
  hooksToken?: string,
): (message: string, options?: PublishOptions) => Promise<boolean> {
  return async (message: string, options?: PublishOptions): Promise<boolean> => {
    const token = hooksToken || process.env.OPENCLAW_HOOKS_TOKEN;
    const port = gatewayPort || parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);

    if (!token) {
      log.debug('publish() skipped — no hooks token configured (set OPENCLAW_HOOKS_TOKEN or pass hooksToken in plugin config)');
      return false;
    }

    const body: Record<string, unknown> = {
      message,
      name: options?.name || `ob-auto-${automationId}`,
      wakeMode: options?.wakeMode || 'now',
    };

    if (options?.deliver !== undefined) body.deliver = options.deliver;
    if (options?.channel) body.channel = options.channel;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        log.warn(`publish() failed: HTTP ${res.status} ${res.statusText}`);
        return false;
      }

      log.debug(`publish() delivered to /hooks/agent (${message.length} chars)`);
      return true;
    } catch (err) {
      log.warn(`publish() error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
}

// ── Runtime ─────────────────────────────────────────────────────────

export interface RuntimeOptions {
  scriptPath: string;
  id?: string;
  dryRun?: boolean;
  verbose?: boolean;
  pollIntervalMs?: number;
  /** Gateway port for webhook delivery. Falls back to OPENCLAW_GATEWAY_PORT or 18789 */
  gatewayPort?: number;
  /** Hooks token for webhook auth. Falls back to OPENCLAW_HOOKS_TOKEN */
  hooksToken?: string;
  /** Pre-seed state before the factory function runs (e.g. from --set key=value) */
  initialState?: Record<string, unknown>;
  /**
   * Enable WebSocket for real-time events (allMids, orderUpdates, userFills, userEvents).
   * When enabled, REST polling interval is relaxed to a heartbeat (default 60s).
   * Falls back gracefully to polling if WebSocket connection fails.
   * @default true
   */
  useWebSocket?: boolean;
}

/** Registry of all running automations */
const registry = new Map<string, RunningAutomation>();

export function getRunningAutomations(): RunningAutomation[] {
  return [...registry.values()];
}

export function getAutomation(id: string): RunningAutomation | undefined {
  return registry.get(id);
}

/** Get all automations from file-based registry (cross-process visibility) */
export { getRegisteredFromFile as getRegisteredAutomations };

export async function startAutomation(options: RuntimeOptions): Promise<RunningAutomation> {
  const {
    scriptPath,
    dryRun = false,
    verbose = false,
    gatewayPort,
    hooksToken,
    initialState,
    useWebSocket = true,
  } = options;

  // When WebSocket is enabled, REST poll becomes a heartbeat (30s default)
  // When disabled, use the original 10s polling interval
  const pollIntervalMs = options.pollIntervalMs ?? (useWebSocket ? 30_000 : 10_000);

  const id = options.id || path.basename(scriptPath, '.ts');

  if (registry.has(id)) {
    throw new Error(`Automation "${id}" is already running`);
  }

  const log = createLogger(id, verbose);
  const state = createState(id);

  // Pre-seed state from --set flags (doesn't overwrite already-persisted keys)
  if (initialState) {
    for (const [key, value] of Object.entries(initialState)) {
      if (state.get(key) === undefined) {
        state.set(key, value);
      }
    }
  }

  const eventBus = new AutomationEventBus();

  const rawClient = getClient();
  const client = dryRun ? createDryClient(rawClient, log) : rawClient;

  const startHooks: Array<() => void | Promise<void>> = [];
  const stopHooks: Array<() => void | Promise<void>> = [];
  const errorHooks: Array<(err: Error) => void | Promise<void>> = [];
  const scheduledTasks: ScheduledTask[] = [];

  // Build the API object
  const publish = createPublish(id, log, gatewayPort, hooksToken);
  const api: AutomationAPI = {
    client,
    utils: { roundPrice, roundSize, sleep, normalizeCoin, formatUsd, formatPercent, annualizeFundingRate },
    on: (event, handler) => eventBus.on(event, handler),
    every: (intervalMs, handler) => scheduledTasks.push({ intervalMs, handler, lastRun: 0 }),
    onStart: (handler) => startHooks.push(handler),
    onStop: (handler) => stopHooks.push(handler),
    onError: (handler) => errorHooks.push(handler),
    publish,
    state,
    log,
    id,
    dryRun,
  };

  // Load and execute the factory function (registers handlers)
  log.info(`Loading automation: ${scriptPath}`);
  const factory = await loadAutomation(scriptPath);
  await factory(api);

  // Call onStart hooks
  for (const hook of startHooks) {
    try { await hook(); } catch (err) {
      log.error(`onStart hook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Polling state (declared early so WebSocket handlers can reference)
  let previousSnapshot: AutomationSnapshot | null = null;
  let pollCount = 0;
  let eventsEmitted = 0;
  let isPolling = false;
  let stopped = false;

  async function handleErrors(errors: Error[]) {
    for (const err of errors) {
      log.error(`Handler error: ${err.message}`);
      for (const hook of errorHooks) {
        try { await hook(err); } catch { /* swallow */ }
      }
    }
  }

  // ── WebSocket setup ─────────────────────────────────────────────
  let ws: WebSocketManager | null = null;
  let wsConnected = false;
  // Track latest prices from WebSocket for real-time price_change events
  let wsPrices = new Map<string, number>();

  if (useWebSocket) {
    try {
      ws = new WebSocketManager(verbose);

      // Wire WebSocket events to the automation event bus
      ws.on('allMids', ({ mids }) => {
        const now = Date.now();
        for (const [coin, mid] of Object.entries(mids)) {
          const newPrice = parseFloat(mid);
          if (isNaN(newPrice) || newPrice === 0) continue;
          const oldPrice = wsPrices.get(coin);
          wsPrices.set(coin, newPrice);

          if (oldPrice !== undefined && oldPrice !== 0 && eventBus.has('price_change')) {
            const changePct = ((newPrice - oldPrice) / oldPrice) * 100;
            if (Math.abs(changePct) >= 0.01) {
              eventBus.emit('price_change', { coin, oldPrice, newPrice, changePct })
                .then(errors => { if (errors.length) handleErrors(errors); });
              eventsEmitted++;
            }
          }
        }
      });

      ws.on('orderUpdate', (update) => {
        if (eventBus.has('order_update')) {
          eventBus.emit('order_update', {
            coin: update.order.coin,
            oid: update.order.oid,
            side: update.order.side === 'B' ? 'buy' : 'sell',
            size: parseFloat(update.order.sz),
            price: parseFloat(update.order.limitPx),
            origSize: parseFloat(update.order.origSz),
            status: update.status,
            statusTimestamp: update.statusTimestamp,
          }).then(errors => { if (errors.length) handleErrors(errors); });
          eventsEmitted++;
        }

        // Also emit order_filled for backward compatibility
        if (update.status === 'filled' && eventBus.has('order_filled')) {
          eventBus.emit('order_filled', {
            coin: update.order.coin,
            oid: update.order.oid,
            side: update.order.side === 'B' ? 'buy' : 'sell',
            size: parseFloat(update.order.sz),
            price: parseFloat(update.order.limitPx),
          }).then(errors => { if (errors.length) handleErrors(errors); });
          eventsEmitted++;
        }
      });

      ws.on('userFill', (fill) => {
        // userFill events are already covered by order_update with status=filled
        // But this provides the realized PnL and fee data that order_update doesn't have
        log.debug(`Fill: ${fill.side === 'B' ? 'BUY' : 'SELL'} ${fill.sz} ${fill.coin} @ ${fill.px} (PnL: ${fill.closedPnl})`);
      });

      ws.on('userEvent', (event) => {
        // Handle liquidation events — only available through WebSocket
        if ('liquidation' in event && eventBus.has('liquidation')) {
          const liq = event.liquidation;
          eventBus.emit('liquidation', {
            lid: liq.lid,
            liquidator: liq.liquidator,
            liquidatedUser: liq.liquidated_user,
            liquidatedNtlPos: parseFloat(liq.liquidated_ntl_pos),
            liquidatedAccountValue: parseFloat(liq.liquidated_account_value),
          }).then(errors => { if (errors.length) handleErrors(errors); });
          eventsEmitted++;
        }
      });

      ws.on('error', ({ error }) => {
        log.warn(`WebSocket error: ${error.message}`);
      });

      ws.on('disconnected', () => {
        wsConnected = false;
        log.warn('WebSocket disconnected — falling back to REST polling');
      });

      ws.on('connected', () => {
        wsConnected = true;
        log.info('WebSocket connected — real-time events active');
      });

      // Connect and subscribe
      const userAddress = rawClient.address as `0x${string}`;
      await ws.subscribeAll(userAddress);
      log.info('WebSocket subscriptions active (allMids, orderUpdates, userFills, userEvents)');
    } catch (err) {
      log.warn(`WebSocket setup failed: ${err instanceof Error ? err.message : String(err)} — using REST polling only`);
      ws = null;
      wsConnected = false;
    }
  }

  async function poll() {
    if (isPolling || stopped) return;
    isPolling = true;

    try {
      const snapshot = await buildSnapshot(rawClient);
      pollCount++;
      const now = Date.now();

      // Always emit tick
      const tickErrors = await eventBus.emit('tick', { timestamp: now, pollCount });
      if (tickErrors.length) await handleErrors(tickErrors);
      eventsEmitted++;

      if (previousSnapshot) {
        // Price changes (skip when WebSocket is handling real-time prices)
        if (eventBus.has('price_change') && !wsConnected) {
          for (const [coin, newPrice] of snapshot.prices) {
            const oldPrice = previousSnapshot.prices.get(coin);
            if (oldPrice === undefined || oldPrice === 0) continue;
            const changePct = ((newPrice - oldPrice) / oldPrice) * 100;
            if (Math.abs(changePct) >= 0.01) { // 0.01% minimum to fire (filters rounding noise)
              const errors = await eventBus.emit('price_change', { coin, oldPrice, newPrice, changePct });
              if (errors.length) await handleErrors(errors);
              eventsEmitted++;
            }
          }
        }

        // Funding updates
        if (eventBus.has('funding_update')) {
          for (const [coin, data] of snapshot.fundingRates) {
            const errors = await eventBus.emit('funding_update', {
              coin,
              fundingRate: data.rate,
              annualized: annualizeFundingRate(data.rate),
              premium: data.premium,
            });
            if (errors.length) await handleErrors(errors);
            eventsEmitted++;
          }
        }

        // Position opened
        if (eventBus.has('position_opened')) {
          for (const [coin, pos] of snapshot.positions) {
            if (!previousSnapshot.positions.has(coin)) {
              const errors = await eventBus.emit('position_opened', {
                coin,
                side: pos.size > 0 ? 'long' : 'short',
                size: Math.abs(pos.size),
                entryPrice: pos.entryPrice,
              });
              if (errors.length) await handleErrors(errors);
              eventsEmitted++;
            }
          }
        }

        // Position closed
        if (eventBus.has('position_closed')) {
          for (const [coin, prevPos] of previousSnapshot.positions) {
            if (!snapshot.positions.has(coin)) {
              const errors = await eventBus.emit('position_closed', {
                coin,
                previousSize: prevPos.size,
                entryPrice: prevPos.entryPrice,
              });
              if (errors.length) await handleErrors(errors);
              eventsEmitted++;
            }
          }
        }

        // Position size changed
        if (eventBus.has('position_changed')) {
          for (const [coin, pos] of snapshot.positions) {
            const prevPos = previousSnapshot.positions.get(coin);
            if (prevPos && pos.size !== prevPos.size) {
              const errors = await eventBus.emit('position_changed', {
                coin,
                oldSize: prevPos.size,
                newSize: pos.size,
                entryPrice: pos.entryPrice,
              });
              if (errors.length) await handleErrors(errors);
              eventsEmitted++;
            }
          }
        }

        // PnL threshold (5% of position value)
        if (eventBus.has('pnl_threshold')) {
          for (const [coin, pos] of snapshot.positions) {
            const prevPos = previousSnapshot.positions.get(coin);
            if (!prevPos || pos.positionValue === 0) continue;
            const pnlChange = Math.abs(pos.unrealizedPnl - prevPos.unrealizedPnl);
            const changePct = (pnlChange / pos.positionValue) * 100;
            if (changePct >= 5) {
              const errors = await eventBus.emit('pnl_threshold', {
                coin,
                unrealizedPnl: pos.unrealizedPnl,
                changePct,
                positionValue: pos.positionValue,
              });
              if (errors.length) await handleErrors(errors);
              eventsEmitted++;
            }
          }
        }

        // Margin warning (80%)
        if (eventBus.has('margin_warning') && snapshot.marginUsedPct >= 80) {
          const prevPct = previousSnapshot.marginUsedPct;
          if (prevPct < 80 || snapshot.marginUsedPct - prevPct >= 5) {
            const errors = await eventBus.emit('margin_warning', {
              marginUsedPct: snapshot.marginUsedPct,
              equity: snapshot.equity,
              marginUsed: snapshot.marginUsed,
            });
            if (errors.length) await handleErrors(errors);
            eventsEmitted++;
          }
        }

        // Order filled — compare open order IDs
        // (Skipped for MVP — requires tracking open orders per poll, will add when needed)
      }

      // Run scheduled tasks
      for (const task of scheduledTasks) {
        if (now - task.lastRun >= task.intervalMs) {
          try {
            await task.handler();
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`Scheduled task error: ${error.message}`);
            await handleErrors([error]);
          }
          task.lastRun = now;
        }
      }

      previousSnapshot = snapshot;
    } catch (err) {
      log.error(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      isPolling = false;
    }
  }

  // Start polling
  const wsLabel = wsConnected ? ', ws=on' : (useWebSocket ? ', ws=failed' : '');
  log.info(`Started (poll every ${pollIntervalMs / 1000}s, dry=${dryRun}${wsLabel})`);
  const timer = setInterval(poll, pollIntervalMs);

  // Initial poll to seed state
  await poll();

  // Stop function
  async function stop(opts?: { persist?: boolean }) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    // Close WebSocket
    if (ws) {
      ws.removeAllListeners();
      await ws.close();
      ws = null;
    }

    for (const hook of stopHooks) {
      try { await hook(); } catch (err) {
        log.error(`onStop hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    eventBus.removeAll();
    registry.delete(id);

    // persist defaults to true — fully remove from file registry.
    // When false (gateway shutdown), keep the entry so it restarts next time.
    if (opts?.persist !== false) {
      unregisterAutomation(id);
    }
    log.info(`Stopped (${pollCount} polls, ${eventsEmitted} events)`);
  }

  const entry: RunningAutomation = {
    id,
    scriptPath,
    startedAt: new Date(),
    get pollCount() { return pollCount; },
    get eventsEmitted() { return eventsEmitted; },
    dryRun,
    stop,
  };

  registry.set(id, entry);

  // Persist to file-based registry so other processes (CLI, plugin) can see it
  registerAutomation({
    id,
    scriptPath,
    dryRun,
    verbose,
    pollIntervalMs,
  });

  return entry;
}
