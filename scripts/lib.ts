// Public library API for `openbroker`.
//
// External packages — notably `openbroker-plugin` — import from here to
// drive the CLI's functionality in-process (no `child_process` dispatch).
//
// Stability: every symbol re-exported here is a public API. Renames or
// removals are breaking changes and require a major version bump.

export {
  HyperliquidClient,
  getClient,
} from './core/client.js';

export {
  loadConfig,
  isConfigured,
  getNetwork,
  isMainnet,
  ensureConfigDir,
  getConfigPath,
  GLOBAL_CONFIG_DIR,
  GLOBAL_ENV_PATH,
  OPEN_BROKER_BUILDER_ADDRESS,
} from './core/config.js';

export {
  roundPrice,
  roundSize,
  sleep,
  normalizeCoin,
  formatUsd,
  formatPercent,
  annualizeFundingRate,
  parseArgs,
  getSlippagePrice,
  getTimestampMs,
  generateCloid,
  orderToWire,
  checkBuilderFeeApproval,
} from './core/utils.js';

export type * from './core/types.js';

// ── Operations (in-process callable) ────────────────────────────────

export { runBracket } from './operations/bracket.js';
export type { BracketOptions, BracketResult } from './operations/bracket.js';

export { runChase } from './operations/chase.js';
export type { ChaseOptions, ChaseResult } from './operations/chase.js';

// ── Automation runtime ──────────────────────────────────────────────

export {
  startAutomation,
  getRunningAutomations,
  getAutomation,
  getRegisteredAutomations,
} from './auto/runtime.js';
export type { RuntimeOptions } from './auto/runtime.js';

export {
  resolveScriptPath,
  resolveExamplePath,
  listAutomations,
  listExamples,
  loadExampleConfigs,
  ensureAutomationsDir,
  loadAutomation,
} from './auto/loader.js';

export {
  registerAutomation,
  unregisterAutomation,
  cleanRegistry,
  getAutomationsToRestart,
  markAutomationError,
} from './auto/registry.js';

export type * from './auto/types.js';
