// OpenClaw Plugin API types for openbroker
// Re-exports core types where possible

export type {
  OpenBrokerConfig,
  ClearinghouseState,
  Position,
  MarginSummary,
  OpenOrder,
  FundingInfo,
  AssetMeta,
  AssetCtx,
  MetaAndAssetCtxs,
} from '../core/types.js';

/** Logger provided by OpenClaw to plugins */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** A background service registered by a plugin */
export interface PluginService {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** JSON Schema for tool parameters */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    default?: unknown;
  }>;
  required?: string[];
}

/** Tool result content block */
export interface ToolResultContent {
  type: 'text';
  text: string;
}

/** An agent tool registered by a plugin */
export interface PluginTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{
    content: ToolResultContent[];
    details?: unknown;
  }>;
}

/** Commander.js-style program for CLI registration */
export interface CliProgram {
  command(name: string): CliCommand;
}

export interface CliCommand {
  command(name: string): CliCommand;
  description(desc: string): CliCommand;
  argument(name: string, desc?: string): CliCommand;
  option(flags: string, desc?: string, defaultValue?: unknown): CliCommand;
  action(fn: (...args: unknown[]) => void | Promise<void>): CliCommand;
}

/** The API that OpenClaw passes to plugin register() */
export interface OpenClawPluginApi {
  logger: PluginLogger;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  gatewayPort: number;
  registerService(service: PluginService): void;
  registerTool(tool: PluginTool): void;
  registerCli(
    setup: (ctx: { program: CliProgram }) => void,
    opts: { commands: string[] },
  ): void;
}

/** Plugin config schema matching openclaw.plugin.json */
export interface OpenBrokerPluginConfig {
  privateKey?: string;
  accountAddress?: string;
  network?: 'mainnet' | 'testnet';
  hooksToken?: string;
  watcher?: {
    enabled?: boolean;
    pollIntervalMs?: number;
    pnlChangeThresholdPct?: number;
    marginUsageWarningPct?: number;
    notifyOnPositionChange?: boolean;
    notifyOnFunding?: boolean;
  };
}

/** Snapshot of a single position for watcher comparison */
export interface PositionSnapshot {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  leverage: { type: string; value: number };
  marginUsed: string;
}

/** Snapshot of full account state for watcher comparison */
export interface AccountSnapshot {
  equity: string;
  marginUsed: string;
  marginUsedPct: number;
  positions: Map<string, PositionSnapshot>;
  timestamp: number;
}

/** Position event types */
export type PositionEventType =
  | 'position_opened'
  | 'position_closed'
  | 'position_size_changed'
  | 'pnl_threshold'
  | 'margin_warning';

/** Position event for hook notifications */
export interface PositionEvent {
  type: PositionEventType;
  coin?: string;
  message: string;
  details: Record<string, unknown>;
  detectedAt: string;
}

/** Watcher status for introspection */
export interface WatcherStatus {
  running: boolean;
  pollIntervalMs: number;
  accountAddress: string | null;
  positions: Array<{
    coin: string;
    size: string;
    entryPrice: string;
    unrealizedPnl: string;
    liquidationPrice: string | null;
  }>;
  equity: string | null;
  marginUsedPct: number | null;
  eventsDetected: number;
  lastPollAt: string | null;
}
