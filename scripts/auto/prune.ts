// Audit DB pruning — delete stale automation runs and their child rows.
//
// The audit DB is the same SQLite file the daemon writes to and the dashboard
// reads from. WAL mode lets us open it from another process for delete writes
// without blocking the daemon. We always protect runs whose status is 'running'
// AND whose pid is alive.
//
// Used by: `openbroker auto prune` and as a sub-step of `openbroker auto clean`.

import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureConfigDir } from '../core/config.js';

export const AUDIT_DB_PATH = process.env.OPENBROKER_AUDIT_DB_PATH
  || path.join(ensureConfigDir(), 'automation-audit.sqlite');

export interface PruneFilters {
  /** Delete runs whose started_at < (now - olderThanMs). Falsy = no age filter. */
  olderThanMs?: number;
  /** Delete runs whose status is in this set. Default: stopped, error, stale. */
  statuses?: Set<string>;
  /** For each automation_id, keep the N most recent runs regardless of other filters. */
  keepLastPerAutomation?: number;
  /** Delete every run that is not currently alive (overrides status/age). */
  all?: boolean;
}

export interface PruneOptions extends PruneFilters {
  dbPath?: string;
  dryRun?: boolean;
  vacuum?: boolean;
  /**
   * When true, skip the deletion phase and only update status of orphaned
   * 'running' rows whose pid is dead — used by `auto clean` to reconcile state
   * without losing history.
   */
  reconcileOnly?: boolean;
}

export interface PruneResult {
  reconciled: number;
  candidateRunIds: string[];
  deletedRows: Record<string, number>;
  freedBytes: number;
  dryRun: boolean;
}

const CHILD_TABLES = [
  'automation_logs',
  'automation_events',
  'automation_actions',
  'automation_snapshots',
  'automation_order_updates',
  'automation_fills',
  'automation_user_events',
  'automation_state_changes',
  'automation_publishes',
  'automation_errors',
  'automation_notes',
  'automation_metrics',
] as const;

const DEFAULT_STATUSES = new Set(['stopped', 'error', 'stale']);

function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse human-friendly durations like `7d`, `24h`, `30m`, `45s`. */
export function parseDuration(input: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/.exec(input);
  if (!m) throw new Error(`invalid duration: ${input}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const mult: Record<string, number> = {
    ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000,
  };
  return n * mult[unit];
}

/** Reconcile orphan-running rows in the DB (process dead → mark stopped). */
export function reconcileStaleRuns(db: DatabaseSync, opts: { dryRun?: boolean; now?: number } = {}): number {
  const now = opts.now ?? Date.now();
  const runningRows = db.prepare(`
    SELECT run_id, pid FROM automation_runs WHERE status = 'running'
  `).all() as { run_id: string; pid: number | null }[];

  const orphans = runningRows.filter((r) => !isProcessAlive(r.pid));
  if (orphans.length === 0) return 0;
  if (opts.dryRun) return orphans.length;

  const update = db.prepare(`
    UPDATE automation_runs
    SET status = 'stopped',
        stop_reason = COALESCE(stop_reason, 'reconciled (process exited)'),
        stopped_at = COALESCE(stopped_at, ?)
    WHERE run_id = ?
  `);
  let n = 0;
  for (const o of orphans) {
    update.run(now, o.run_id);
    n++;
  }
  return n;
}

export function prune(opts: PruneOptions = {}): PruneResult {
  const dbPath = opts.dbPath ?? AUDIT_DB_PATH;
  if (!existsSync(dbPath)) {
    return {
      reconciled: 0,
      candidateRunIds: [],
      deletedRows: {},
      freedBytes: 0,
      dryRun: !!opts.dryRun,
    };
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  try {
    const reconciled = reconcileStaleRuns(db, { dryRun: opts.dryRun });
    if (opts.reconcileOnly) {
      return {
        reconciled,
        candidateRunIds: [],
        deletedRows: {},
        freedBytes: 0,
        dryRun: !!opts.dryRun,
      };
    }

    const allRuns = db.prepare(`
      SELECT run_id, automation_id, status, pid, started_at
      FROM automation_runs
      ORDER BY started_at DESC
    `).all() as {
      run_id: string;
      automation_id: string;
      status: string;
      pid: number | null;
      started_at: number;
    }[];

    const statuses = opts.statuses ?? DEFAULT_STATUSES;
    const cutoff = opts.olderThanMs && opts.olderThanMs > 0 ? Date.now() - opts.olderThanMs : null;

    // group runs per automation_id (already sorted DESC by started_at)
    const byAuto = new Map<string, typeof allRuns>();
    for (const r of allRuns) {
      const arr = byAuto.get(r.automation_id) ?? [];
      arr.push(r);
      byAuto.set(r.automation_id, arr);
    }

    const candidates: typeof allRuns = [];

    for (const [, runs] of byAuto) {
      const protectedIdx = new Set<number>();
      if (opts.keepLastPerAutomation && opts.keepLastPerAutomation > 0) {
        for (let i = 0; i < Math.min(opts.keepLastPerAutomation, runs.length); i++) {
          protectedIdx.add(i);
        }
      }
      runs.forEach((r, i) => {
        if (protectedIdx.has(i)) return;
        // never delete a truly-running automation
        if (r.status === 'running' && isProcessAlive(r.pid)) return;
        if (opts.all) {
          candidates.push(r);
          return;
        }
        if (!statuses.has(r.status)) {
          // 'running' rows that aren't actually alive were just reconciled to
          // 'stopped' above, so the status check catches them.
          return;
        }
        if (cutoff !== null && r.started_at >= cutoff) return;
        candidates.push(r);
      });
    }

    const candidateRunIds = candidates.map((r) => r.run_id);
    const deletedRows: Record<string, number> = {};
    let freedBytes = 0;

    if (!opts.dryRun && candidateRunIds.length > 0) {
      const sizeBefore = db.prepare('PRAGMA page_count').get() as { page_count: number };
      const pageSize = db.prepare('PRAGMA page_size').get() as { page_size: number };

      db.exec('BEGIN');
      try {
        for (const table of CHILD_TABLES) {
          let n = 0;
          const stmt = db.prepare(`DELETE FROM ${table} WHERE run_id = ?`);
          for (const id of candidateRunIds) {
            const info = stmt.run(id) as { changes?: number };
            n += Number(info.changes ?? 0);
          }
          deletedRows[table] = n;
        }
        const runStmt = db.prepare('DELETE FROM automation_runs WHERE run_id = ?');
        let runChanges = 0;
        for (const id of candidateRunIds) {
          const info = runStmt.run(id) as { changes: number };
          runChanges += Number(info.changes ?? 0);
        }
        deletedRows.automation_runs = runChanges;
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      if (opts.vacuum) {
        // VACUUM cannot run inside a transaction
        db.exec('VACUUM');
      }

      const sizeAfter = db.prepare('PRAGMA page_count').get() as { page_count: number };
      freedBytes = (Number(sizeBefore.page_count) - Number(sizeAfter.page_count)) * Number(pageSize.page_size);
    }

    return {
      reconciled,
      candidateRunIds,
      deletedRows,
      freedBytes: Math.max(0, freedBytes),
      dryRun: !!opts.dryRun,
    };
  } finally {
    db.close();
  }
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
