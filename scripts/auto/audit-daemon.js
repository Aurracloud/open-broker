#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import net from 'net';
import path from 'path';
import readline from 'readline';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const socketPath = process.argv[3];

if (!dbPath || !socketPath) {
  console.error('usage: audit-daemon.js <db-path> <socket-path>');
  process.exit(1);
}

mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
}

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS automation_runs (
    run_id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    script_path TEXT NOT NULL,
    account_address TEXT,
    wallet_address TEXT,
    is_api_wallet INTEGER NOT NULL,
    dry_run INTEGER NOT NULL,
    verbose INTEGER NOT NULL,
    poll_interval_ms INTEGER,
    use_websocket INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    stop_reason TEXT,
    initial_state_json TEXT,
    persisted_state_json TEXT,
    poll_count INTEGER,
    events_emitted INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_automation_runs_id_started
    ON automation_runs (automation_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS automation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_automation_logs_run_time
    ON automation_logs (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    payload_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_events_run_time
    ON automation_events (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    action_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    method TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    payload_json TEXT,
    result_json TEXT,
    error_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_actions_run_time
    ON automation_actions (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    poll_count INTEGER NOT NULL,
    equity REAL NOT NULL,
    margin_used REAL NOT NULL,
    margin_used_pct REAL NOT NULL,
    positions_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_snapshots_run_time
    ON automation_snapshots (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_order_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    oid INTEGER,
    coin TEXT,
    side TEXT,
    size REAL,
    price REAL,
    orig_size REAL,
    status TEXT,
    status_timestamp INTEGER,
    payload_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_order_updates_run_time
    ON automation_order_updates (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    coin TEXT,
    side TEXT,
    size REAL,
    price REAL,
    fee REAL,
    closed_pnl REAL,
    oid INTEGER,
    crossed INTEGER,
    payload_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_fills_run_time
    ON automation_fills (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_user_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    payload_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_user_events_run_time
    ON automation_user_events (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_state_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    op TEXT NOT NULL,
    key_name TEXT,
    value_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_state_changes_run_time
    ON automation_state_changes (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_publishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    delivered INTEGER NOT NULL,
    message TEXT NOT NULL,
    options_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_publishes_run_time
    ON automation_publishes (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    stage TEXT NOT NULL,
    error_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_errors_run_time
    ON automation_errors (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_notes_run_time
    ON automation_notes (run_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS automation_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    name TEXT NOT NULL,
    value REAL NOT NULL,
    tags_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_metrics_run_time
    ON automation_metrics (run_id, timestamp DESC);
`);

const statements = {
  initRun: db.prepare(`
    INSERT INTO automation_runs (
      run_id, automation_id, script_path, account_address, wallet_address,
      is_api_wallet, dry_run, verbose, poll_interval_ms, use_websocket,
      pid, started_at, status, initial_state_json, persisted_state_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      automation_id = excluded.automation_id,
      script_path = excluded.script_path,
      account_address = excluded.account_address,
      wallet_address = excluded.wallet_address,
      is_api_wallet = excluded.is_api_wallet,
      dry_run = excluded.dry_run,
      verbose = excluded.verbose,
      poll_interval_ms = excluded.poll_interval_ms,
      use_websocket = excluded.use_websocket,
      pid = excluded.pid,
      started_at = excluded.started_at,
      status = 'running',
      initial_state_json = excluded.initial_state_json,
      persisted_state_json = excluded.persisted_state_json
  `),
  finishRun: db.prepare(`
    UPDATE automation_runs
    SET stopped_at = ?, status = ?, stop_reason = ?, poll_count = ?, events_emitted = ?
    WHERE run_id = ?
  `),
  log: db.prepare(`
    INSERT INTO automation_logs (run_id, timestamp, level, message)
    VALUES (?, ?, ?, ?)
  `),
  event: db.prepare(`
    INSERT INTO automation_events (run_id, timestamp, event_type, source, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `),
  action: db.prepare(`
    INSERT INTO automation_actions (
      run_id, timestamp, action_id, phase, method, dry_run, payload_json, result_json, error_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  snapshot: db.prepare(`
    INSERT INTO automation_snapshots (
      run_id, timestamp, poll_count, equity, margin_used, margin_used_pct, positions_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  orderUpdate: db.prepare(`
    INSERT INTO automation_order_updates (
      run_id, timestamp, oid, coin, side, size, price, orig_size, status, status_timestamp, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  fill: db.prepare(`
    INSERT INTO automation_fills (
      run_id, timestamp, coin, side, size, price, fee, closed_pnl, oid, crossed, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  userEvent: db.prepare(`
    INSERT INTO automation_user_events (run_id, timestamp, event_kind, payload_json)
    VALUES (?, ?, ?, ?)
  `),
  stateChange: db.prepare(`
    INSERT INTO automation_state_changes (run_id, timestamp, op, key_name, value_json)
    VALUES (?, ?, ?, ?, ?)
  `),
  publish: db.prepare(`
    INSERT INTO automation_publishes (run_id, timestamp, delivered, message, options_json)
    VALUES (?, ?, ?, ?, ?)
  `),
  error: db.prepare(`
    INSERT INTO automation_errors (run_id, timestamp, stage, error_json)
    VALUES (?, ?, ?, ?)
  `),
  note: db.prepare(`
    INSERT INTO automation_notes (run_id, timestamp, kind, payload_json)
    VALUES (?, ?, ?, ?)
  `),
  metric: db.prepare(`
    INSERT INTO automation_metrics (run_id, timestamp, name, value, tags_json)
    VALUES (?, ?, ?, ?, ?)
  `),
};

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function detectUserEventKind(payload) {
  if (payload && typeof payload === 'object') {
    if ('liquidation' in payload) return 'liquidation';
    if ('funding' in payload) return 'funding';
    if ('nonUserCancel' in payload) return 'non_user_cancel';
  }
  return 'unknown';
}

function send(socket, response) {
  socket.write(`${JSON.stringify(response)}\n`);
}

function handleMessage(message) {
  const payload = message.payload;

  switch (message.type) {
    case 'init':
      statements.initRun.run(
        payload.runId,
        payload.automationId,
        payload.scriptPath,
        payload.accountAddress ?? null,
        payload.walletAddress ?? null,
        payload.isApiWallet ? 1 : 0,
        payload.dryRun ? 1 : 0,
        payload.verbose ? 1 : 0,
        payload.pollIntervalMs ?? null,
        payload.useWebSocket ? 1 : 0,
        payload.pid,
        payload.startedAt,
        json(payload.initialState ?? {}),
        json(payload.persistedState ?? {}),
      );
      break;

    case 'log':
      statements.log.run(payload.runId, payload.timestamp, payload.level, payload.message);
      break;

    case 'event':
      statements.event.run(payload.runId, payload.timestamp, payload.eventType, payload.source, json(payload.payload));
      break;

    case 'action':
      statements.action.run(
        payload.runId,
        payload.timestamp,
        payload.actionId,
        payload.phase,
        payload.method,
        payload.dryRun ? 1 : 0,
        json(payload.payload),
        json(payload.result),
        json(payload.error),
      );
      break;

    case 'snapshot':
      statements.snapshot.run(
        payload.runId,
        payload.timestamp,
        payload.pollCount,
        payload.equity,
        payload.marginUsed,
        payload.marginUsedPct,
        json(payload.positions ?? []),
      );
      break;

    case 'order_update': {
      const update = payload.payload ?? {};
      statements.orderUpdate.run(
        payload.runId,
        payload.timestamp,
        numberOrNull(update.oid),
        update.coin ?? null,
        update.side ?? null,
        numberOrNull(update.size),
        numberOrNull(update.price),
        numberOrNull(update.origSize),
        update.status ?? null,
        numberOrNull(update.statusTimestamp),
        json(update),
      );
      break;
    }

    case 'fill': {
      const fill = payload.payload ?? {};
      statements.fill.run(
        payload.runId,
        payload.timestamp,
        fill.coin ?? null,
        fill.side ?? null,
        numberOrNull(fill.size ?? fill.sz),
        numberOrNull(fill.price ?? fill.px),
        numberOrNull(fill.fee),
        numberOrNull(fill.closedPnl),
        numberOrNull(fill.oid),
        fill.crossed ? 1 : 0,
        json(fill),
      );
      break;
    }

    case 'user_event':
      statements.userEvent.run(payload.runId, payload.timestamp, detectUserEventKind(payload.payload), json(payload.payload));
      break;

    case 'state_change':
      statements.stateChange.run(payload.runId, payload.timestamp, payload.op, payload.key, json(payload.value));
      break;

    case 'publish':
      statements.publish.run(payload.runId, payload.timestamp, payload.delivered ? 1 : 0, payload.message, json(payload.options));
      break;

    case 'error':
      statements.error.run(payload.runId, payload.timestamp, payload.stage, json(payload.error));
      break;

    case 'note':
      statements.note.run(payload.runId, payload.timestamp, payload.kind, json(payload.payload));
      break;

    case 'metric':
      statements.metric.run(payload.runId, payload.timestamp, payload.name, payload.value, json(payload.tags));
      break;

    case 'stop':
      statements.finishRun.run(
        payload.timestamp,
        payload.status,
        payload.stopReason,
        payload.pollCount,
        payload.eventsEmitted,
        payload.runId,
      );
      break;

    default:
      throw new Error(`unknown audit message type: ${message.type}`);
  }
}

async function socketInUse(target) {
  return await new Promise((resolve) => {
    const socket = net.createConnection(target);

    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

if (process.platform !== 'win32' && existsSync(socketPath)) {
  const active = await socketInUse(socketPath);
  if (active) {
    process.exit(0);
  }

  try {
    unlinkSync(socketPath);
  } catch {
    // ignore stale socket cleanup failures
  }
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  const rl = readline.createInterface({
    input: socket,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
      handleMessage(message);
      send(socket, { messageId: message.messageId, ok: true });
    } catch (error) {
      send(socket, {
        messageId: message?.messageId ?? null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on('close', () => {
    rl.close();
  });
});

function cleanupAndExit(code = 0) {
  try {
    server.close();
  } catch {
    // ignore close failures
  }

  if (process.platform !== 'win32' && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore cleanup failures
    }
  }

  try {
    db.close();
  } catch {
    // ignore close failures
  }

  process.exit(code);
}

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE' && process.platform !== 'win32') {
    const active = await socketInUse(socketPath);
    if (active) {
      process.exit(0);
      return;
    }

    try {
      unlinkSync(socketPath);
      server.listen(socketPath);
      return;
    } catch (retryError) {
      console.error(retryError instanceof Error ? retryError.message : String(retryError));
      cleanupAndExit(1);
      return;
    }
  }

  console.error(error.message);
  cleanupAndExit(1);
});

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));

server.listen(socketPath, () => {
  if (process.platform !== 'win32') {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // ignore chmod failures on some filesystems
    }
  }
});
