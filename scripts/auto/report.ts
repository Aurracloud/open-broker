#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { AUDIT_DB_PATH } from './audit.js';
import { formatUsd, parseArgs } from '../core/utils.js';

const DEFAULT_WATCH_INTERVAL_MS = 2000;

function printUsage() {
  console.log(`
Usage: openbroker auto report <id> [options]

Options:
  --run <run-id|latest>  Specific run ID to inspect (default: latest)
  --limit <n>            Number of recent rows per section (default: 10)
  --watch                Refresh the report continuously
  --watch-interval <ms>  Refresh interval for --watch (default: 2000)
  --json                 Output JSON
  --help, -h             Show this help

Examples:
  openbroker auto report hype-mm-v2-live-r4
  openbroker auto report hype-mm-v2-live-r4 --limit 20
  openbroker auto report hype-mm-v2-live-r4 --watch
  openbroker auto report hype-mm-v2-live-r4 --run 123e4567... --json
`);
}

type RunRow = {
  run_id: string;
  automation_id: string;
  script_path: string;
  account_address: string | null;
  wallet_address: string | null;
  is_api_wallet: number;
  dry_run: number;
  verbose: number;
  poll_interval_ms: number | null;
  use_websocket: number;
  pid: number;
  started_at: number;
  stopped_at: number | null;
  status: string;
  stop_reason: string | null;
  initial_state_json: string | null;
  persisted_state_json: string | null;
  poll_count: number | null;
  events_emitted: number | null;
};

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseNumber(raw: string | boolean | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatTimestamp(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString() : '-';
}

function formatDurationMs(startedAt: number, stoppedAt: number | null): string {
  const end = stoppedAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getPositionalArgs(rawArgs: string[]): string[] {
  return rawArgs.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    if (index > 0 && rawArgs[index - 1]?.startsWith('--')) return false;
    return true;
  });
}

function loadReport(
  db: DatabaseSync,
  automationId: string,
  runSelector: string,
  limit: number,
) {
  const run = runSelector !== 'latest'
    ? db.prepare(`
        SELECT *
        FROM automation_runs
        WHERE automation_id = ? AND run_id = ?
        LIMIT 1
      `).get(automationId, runSelector) as RunRow | undefined
    : db.prepare(`
        SELECT *
        FROM automation_runs
        WHERE automation_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `).get(automationId) as RunRow | undefined;

  if (!run) {
    throw new Error(`No audit run found for automation "${automationId}"${runSelector !== 'latest' ? ` and run "${runSelector}"` : ''}`);
  }

  const countTables = {
    logs: 'automation_logs',
    events: 'automation_events',
    actions: 'automation_actions',
    snapshots: 'automation_snapshots',
    orderUpdates: 'automation_order_updates',
    fills: 'automation_fills',
    userEvents: 'automation_user_events',
    stateChanges: 'automation_state_changes',
    publishes: 'automation_publishes',
    errors: 'automation_errors',
    notes: 'automation_notes',
    metrics: 'automation_metrics',
  } as const;

  const counts = Object.fromEntries(
    Object.entries(countTables).map(([key, table]) => {
      const row = db.prepare(`SELECT count(*) AS c FROM ${table} WHERE run_id = ?`).get(run.run_id) as { c: number };
      return [key, row.c];
    }),
  );

  const fillSummary = db.prepare(`
    SELECT
      count(*) AS count,
      COALESCE(sum(fee), 0) AS total_fee,
      COALESCE(sum(closed_pnl), 0) AS total_closed_pnl,
      COALESCE(sum(size * price), 0) AS total_volume
    FROM automation_fills
    WHERE run_id = ?
  `).get(run.run_id) as {
    count: number;
    total_fee: number;
    total_closed_pnl: number;
    total_volume: number;
  };

  const firstSnapshot = db.prepare(`
    SELECT timestamp, poll_count, equity, margin_used, margin_used_pct, positions_json
    FROM automation_snapshots
    WHERE run_id = ?
    ORDER BY timestamp ASC
    LIMIT 1
  `).get(run.run_id) as Record<string, unknown> | undefined;

  const latestSnapshot = db.prepare(`
    SELECT timestamp, poll_count, equity, margin_used, margin_used_pct, positions_json
    FROM automation_snapshots
    WHERE run_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(run.run_id) as Record<string, unknown> | undefined;

  const actionBreakdown = db.prepare(`
    SELECT
      method,
      sum(CASE WHEN phase = 'request' THEN 1 ELSE 0 END) AS requests,
      sum(CASE WHEN phase = 'response' THEN 1 ELSE 0 END) AS responses,
      sum(CASE WHEN phase = 'error' THEN 1 ELSE 0 END) AS errors
    FROM automation_actions
    WHERE run_id = ?
    GROUP BY method
    ORDER BY requests DESC, responses DESC, errors DESC, method ASC
  `).all(run.run_id);

  const recentLogs = db.prepare(`
    SELECT timestamp, level, message
    FROM automation_logs
    WHERE run_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(run.run_id, limit);

  const recentErrors = db.prepare(`
    SELECT timestamp, stage, error_json
    FROM automation_errors
    WHERE run_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(run.run_id, limit);

  const recentFills = db.prepare(`
    SELECT timestamp, coin, side, size, price, fee, closed_pnl
    FROM automation_fills
    WHERE run_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(run.run_id, limit);

  const recentOrderUpdates = db.prepare(`
    SELECT timestamp, coin, side, size, price, status, oid
    FROM automation_order_updates
    WHERE run_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(run.run_id, limit);

  const recentNotes = db.prepare(`
    SELECT timestamp, kind, payload_json
    FROM automation_notes
    WHERE run_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(run.run_id, limit);

  const recentMetrics = db.prepare(`
    SELECT timestamp, name, value, tags_json
    FROM automation_metrics
    WHERE run_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(run.run_id, limit);

  const report = {
    automationId: run.automation_id,
    runId: run.run_id,
    status: run.status,
    stopReason: run.stop_reason,
    scriptPath: run.script_path,
    startedAt: new Date(run.started_at).toISOString(),
    stoppedAt: run.stopped_at ? new Date(run.stopped_at).toISOString() : null,
    durationSec: Math.max(0, Math.round(((run.stopped_at ?? Date.now()) - run.started_at) / 1000)),
    accountAddress: run.account_address,
    walletAddress: run.wallet_address,
    dryRun: run.dry_run === 1,
    verbose: run.verbose === 1,
    useWebSocket: run.use_websocket === 1,
    pollIntervalMs: run.poll_interval_ms,
    pid: run.pid,
    initialState: parseJson<Record<string, unknown>>(run.initial_state_json),
    persistedState: parseJson<Record<string, unknown>>(run.persisted_state_json),
    runtimeStats: {
      pollCount: run.poll_count,
      eventsEmitted: run.events_emitted,
    },
    counts,
    fills: {
      count: fillSummary.count,
      totalFees: fillSummary.total_fee,
      totalClosedPnl: fillSummary.total_closed_pnl,
      netAfterFees: fillSummary.total_closed_pnl - fillSummary.total_fee,
      totalVolume: fillSummary.total_volume,
    },
    equity: {
      first: firstSnapshot ? {
        timestamp: firstSnapshot.timestamp,
        pollCount: firstSnapshot.poll_count,
        equity: firstSnapshot.equity,
        marginUsed: firstSnapshot.margin_used,
        marginUsedPct: firstSnapshot.margin_used_pct,
        positions: parseJson(firstSnapshot.positions_json as string | null),
      } : null,
      latest: latestSnapshot ? {
        timestamp: latestSnapshot.timestamp,
        pollCount: latestSnapshot.poll_count,
        equity: latestSnapshot.equity,
        marginUsed: latestSnapshot.margin_used,
        marginUsedPct: latestSnapshot.margin_used_pct,
        positions: parseJson(latestSnapshot.positions_json as string | null),
      } : null,
      delta: firstSnapshot && latestSnapshot
        ? Number(latestSnapshot.equity) - Number(firstSnapshot.equity)
        : null,
    },
    actionBreakdown,
    recent: {
      logs: recentLogs,
      errors: recentErrors.map((row) => ({
        ...row,
        error: parseJson(row.error_json as string | null),
      })),
      fills: recentFills,
      orderUpdates: recentOrderUpdates,
      notes: recentNotes.map((row) => ({
        ...row,
        payload: parseJson(row.payload_json as string | null),
      })),
      metrics: recentMetrics.map((row) => ({
        ...row,
        tags: parseJson(row.tags_json as string | null),
      })),
    },
  };

  return { run, report, counts, actionBreakdown, recentErrors, recentFills, recentLogs };
}

function renderTextReport(data: ReturnType<typeof loadReport>, watchMode = false, watchIntervalMs = DEFAULT_WATCH_INTERVAL_MS): void {
  const { run, report, counts, actionBreakdown, recentErrors, recentFills, recentLogs } = data;

  if (watchMode && process.stdout.isTTY) {
    process.stdout.write('\x1Bc');
  }

  console.log('Open Broker - Automation Report');
  console.log('===============================\n');

  console.log(`Automation:     ${report.automationId}`);
  console.log(`Run ID:         ${report.runId}`);
  console.log(`Status:         ${report.status}${report.stopReason ? ` (${report.stopReason})` : ''}`);
  console.log(`Started:        ${formatTimestamp(run.started_at)}`);
  console.log(`Stopped:        ${formatTimestamp(run.stopped_at)}`);
  console.log(`Duration:       ${formatDurationMs(run.started_at, run.stopped_at)}`);
  console.log(`Script:         ${run.script_path}`);
  console.log(`Account:        ${run.account_address ?? '-'}`);
  console.log(`Mode:           ${report.dryRun ? 'dry' : 'live'}${report.useWebSocket ? ', ws' : ', polling only'}`);
  console.log(`Poll interval:  ${run.poll_interval_ms ?? '-'} ms`);
  if (watchMode) {
    console.log(`Refresh:        every ${watchIntervalMs} ms (Ctrl-C to stop)`);
  }

  console.log('\nCounts');
  console.log('------');
  for (const [key, value] of Object.entries(counts)) {
    console.log(`${key.padEnd(14)} ${value}`);
  }

  console.log('\nEconomics');
  console.log('---------');
  console.log(`Fills:          ${report.fills.count}`);
  console.log(`Volume:         ${formatUsd(report.fills.totalVolume)}`);
  console.log(`Closed PnL:     ${formatUsd(report.fills.totalClosedPnl)}`);
  console.log(`Fees:           ${formatUsd(report.fills.totalFees)}`);
  console.log(`Net after fees: ${formatUsd(report.fills.netAfterFees)}`);

  console.log('\nEquity');
  console.log('------');
  if (report.equity.first) {
    console.log(`First snapshot: ${formatUsd(Number(report.equity.first.equity))} @ ${formatTimestamp(Number(report.equity.first.timestamp))}`);
  } else {
    console.log('First snapshot: -');
  }
  if (report.equity.latest) {
    console.log(`Latest snapshot:${formatUsd(Number(report.equity.latest.equity))} @ ${formatTimestamp(Number(report.equity.latest.timestamp))}`);
  } else {
    console.log('Latest snapshot:-');
  }
  console.log(`Delta:          ${report.equity.delta === null ? '-' : formatUsd(report.equity.delta)}`);

  if (Array.isArray(actionBreakdown) && actionBreakdown.length > 0) {
    console.log('\nActions');
    console.log('-------');
    for (const row of actionBreakdown as Array<Record<string, unknown>>) {
      console.log(
        `${String(row.method).padEnd(20)} req=${String(row.requests).padStart(3)} resp=${String(row.responses).padStart(3)} err=${String(row.errors).padStart(3)}`,
      );
    }
  }

  if (recentErrors.length > 0) {
    console.log('\nRecent Errors');
    console.log('-------------');
    for (const row of recentErrors as Array<Record<string, unknown>>) {
      const parsed = parseJson<{ message?: string }>(row.error_json as string | null);
      console.log(`${formatTimestamp(Number(row.timestamp))}  ${String(row.stage)}  ${parsed?.message || String(row.error_json)}`);
    }
  }

  if (recentFills.length > 0) {
    console.log('\nRecent Fills');
    console.log('------------');
    for (const row of recentFills as Array<Record<string, unknown>>) {
      console.log(
        `${formatTimestamp(Number(row.timestamp))}  ${String(row.side).toUpperCase()} ${String(row.coin)} ${row.size} @ ${row.price} pnl=${row.closed_pnl} fee=${row.fee}`,
      );
    }
  }

  if (recentLogs.length > 0) {
    console.log('\nRecent Logs');
    console.log('-----------');
    for (const row of recentLogs as Array<Record<string, unknown>>) {
      console.log(`${formatTimestamp(Number(row.timestamp))}  ${String(row.level).toUpperCase()}  ${String(row.message)}`);
    }
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const positional = getPositionalArgs(rawArgs);
  const automationId = positional[0];
  if (!automationId) {
    console.error('Error: automation ID is required');
    printUsage();
    process.exit(1);
  }

  const runSelector = String(args.run || 'latest');
  const limit = parseNumber(args.limit, 10);
  const jsonOutput = args.json === true;
  const watchMode = args.watch === true;
  const watchIntervalMs = parseNumber(args['watch-interval'], DEFAULT_WATCH_INTERVAL_MS);

  if (watchMode && jsonOutput) {
    console.error('Error: --watch cannot be combined with --json');
    process.exit(1);
  }

  const db = new DatabaseSync(AUDIT_DB_PATH);
  let stopRequested = false;

  const cleanup = () => {
    try {
      db.close();
    } catch {
      // ignore close failures during shutdown
    }
  };

  const requestStop = () => {
    stopRequested = true;
  };

  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  try {
    if (!watchMode) {
      const data = loadReport(db, automationId, runSelector, limit);
      if (jsonOutput) {
        console.log(JSON.stringify(data.report, null, 2));
      } else {
        renderTextReport(data);
      }
      return;
    }

    while (!stopRequested) {
      const data = loadReport(db, automationId, runSelector, limit);
      renderTextReport(data, true, watchIntervalMs);
      await new Promise((resolve) => setTimeout(resolve, watchIntervalMs));
    }
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    cleanup();
  }
}

await main();
