/**
 * Dashboard audit forwarder.
 *
 * When OB_DASHBOARD_URL is set, wraps the AutomationAudit API to also POST
 * audit notes, metrics, and agent action logs to the ob-app backend.
 *
 * Fires HTTP requests in the background — never blocks the automation loop.
 */

import type { AutomationAudit } from './types.js';

const DASHBOARD_URL = process.env.OB_DASHBOARD_URL; // e.g. "http://localhost:3001"
const VAULT_ADDRESS = process.env.HYPERSTABLE_VAULT_ADDRESS || process.env.VAULT || '';

function postJSON(path: string, body: unknown): void {
  if (!DASHBOARD_URL || !VAULT_ADDRESS) return;

  const url = `${DASHBOARD_URL}/api/vaults/${VAULT_ADDRESS.toLowerCase()}${path}`;

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Silently ignore — dashboard may be down, automation must not be affected.
  });
}

/**
 * Wrap an existing AutomationAudit to forward calls to the dashboard API.
 * If OB_DASHBOARD_URL is not set, returns the original audit object unchanged.
 */
export function withDashboardForwarder(audit: AutomationAudit): AutomationAudit {
  if (!DASHBOARD_URL || !VAULT_ADDRESS) return audit;

  return {
    record(kind: string, payload?: unknown): void {
      audit.record(kind, payload);
      postJSON('/audit/notes', {
        category: kind,
        label: typeof payload === 'object' && payload !== null && 'reason' in payload
          ? String((payload as Record<string, unknown>).reason)
          : kind,
        data: payload ?? {},
      });
    },

    metric(name: string, value: number, tags?: Record<string, unknown>): void {
      audit.metric(name, value, tags);
      postJSON('/audit/metrics', {
        name,
        value,
        tags: tags ?? {},
      });
    },
  };
}

/**
 * Forward an agent action log to the dashboard.
 * Call this from audited client wrappers or directly from automation code.
 */
export function forwardAgentAction(
  action: string,
  status: 'success' | 'error' | 'pending',
  details: Record<string, unknown>,
  txHash?: string,
): void {
  postJSON('/agent/logs', { action, status, details, txHash });
}
