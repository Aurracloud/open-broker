import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { once } from 'events';
import net, { type Socket } from 'net';
import path from 'path';
import readline from 'readline';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { ensureConfigDir } from '../core/config.js';

export interface AutomationAuditSink {
  readonly runId: string;
  readonly dbPath: string;
  recordLog(level: 'info' | 'warn' | 'error' | 'debug', message: string, timestamp?: number): void;
  recordEvent(eventType: string, source: 'poll' | 'ws' | 'manual', payload: unknown, timestamp?: number): void;
  recordAction(args: {
    actionId?: string;
    phase: 'request' | 'response' | 'error';
    method: string;
    payload?: unknown;
    result?: unknown;
    error?: unknown;
    dryRun?: boolean;
    timestamp?: number;
  }): void;
  recordSnapshot(snapshot: {
    pollCount: number;
    equity: number;
    marginUsed: number;
    marginUsedPct: number;
    positions: unknown[];
    timestamp?: number;
  }): void;
  recordOrderUpdate(payload: unknown, timestamp?: number): void;
  recordFill(payload: unknown, timestamp?: number): void;
  recordUserEvent(payload: unknown, timestamp?: number): void;
  recordStateChange(op: 'set' | 'delete' | 'clear', key: string | null, value?: unknown, timestamp?: number): void;
  recordPublish(message: string, options: unknown, delivered: boolean, timestamp?: number): void;
  recordError(stage: string, error: unknown, timestamp?: number): void;
  recordNote(kind: string, payload?: unknown, timestamp?: number): void;
  recordMetric(name: string, value: number, tags?: Record<string, unknown>, timestamp?: number): void;
  stop(args: {
    status: 'stopped' | 'error';
    stopReason: string;
    pollCount: number;
    eventsEmitted: number;
    timestamp?: number;
  }): Promise<void>;
}

type AuditMessageType =
  | 'init'
  | 'log'
  | 'event'
  | 'action'
  | 'snapshot'
  | 'order_update'
  | 'fill'
  | 'user_event'
  | 'state_change'
  | 'publish'
  | 'error'
  | 'note'
  | 'metric'
  | 'stop';

type AuditPayload = Record<string, unknown>;

type AuditMessage = {
  messageId: string;
  type: AuditMessageType;
  payload: AuditPayload;
};

type AuditResponse = {
  messageId: string;
  ok: boolean;
  error?: string;
};

export interface AuditStartOptions {
  automationId: string;
  scriptPath: string;
  dryRun: boolean;
  verbose: boolean;
  pollIntervalMs: number;
  useWebSocket: boolean;
  accountAddress: string;
  walletAddress: string;
  isApiWallet: boolean;
  initialState?: Record<string, unknown>;
  persistedState?: Record<string, unknown>;
}

export const AUDIT_DB_PATH = process.env.OPENBROKER_AUDIT_DB_PATH
  || path.join(ensureConfigDir(), 'automation-audit.sqlite');

export const AUDIT_SOCKET_PATH = process.env.OPENBROKER_AUDIT_SOCKET_PATH
  || (process.platform === 'win32'
    ? '\\\\.\\pipe\\openbroker-automation-audit-v2'
    : path.join(ensureConfigDir(), 'automation-audit.v2.sock'));

function internalWarn(automationId: string, message: string): void {
  console.error(`[auto:${automationId}:audit] ${message}`);
}

export function toSerializable<T = unknown>(value: T): T {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === 'bigint') {
      return currentValue.toString();
    }
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }
    if (currentValue instanceof Map) {
      return Object.fromEntries(currentValue.entries());
    }
    if (currentValue instanceof Set) {
      return [...currentValue.values()];
    }
    if (typeof currentValue === 'object' && currentValue !== null) {
      if (seen.has(currentValue)) {
        return '[Circular]';
      }
      seen.add(currentValue);
    }
    return currentValue;
  });
  if (encoded === undefined) {
    return null as T;
  }
  return JSON.parse(encoded) as T;
}

class NoopAuditSink implements AutomationAuditSink {
  readonly runId = randomUUID();
  readonly dbPath = AUDIT_DB_PATH;
  recordLog(): void {}
  recordEvent(): void {}
  recordAction(): void {}
  recordSnapshot(): void {}
  recordOrderUpdate(): void {}
  recordFill(): void {}
  recordUserEvent(): void {}
  recordStateChange(): void {}
  recordPublish(): void {}
  recordError(): void {}
  recordNote(): void {}
  recordMetric(): void {}
  async stop(): Promise<void> {}
}

class DaemonAuditSink implements AutomationAuditSink {
  readonly runId = randomUUID();
  readonly dbPath = AUDIT_DB_PATH;

  private socketPath = AUDIT_SOCKET_PATH;
  private socket: Socket | null = null;
  private lineReader: readline.Interface | null = null;
  private connectPromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;
  private closed = false;
  private daemonSpawnedAt = 0;
  private pendingQueue: AuditMessage[] = [];
  private inFlight = new Map<string, AuditMessage>();
  private ackWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  constructor(private readonly automationId: string, options: AuditStartOptions) {
    this.enqueue({
      type: 'init',
      payload: {
        runId: this.runId,
        automationId: options.automationId,
        scriptPath: options.scriptPath,
        dryRun: options.dryRun,
        verbose: options.verbose,
        pollIntervalMs: options.pollIntervalMs,
        useWebSocket: options.useWebSocket,
        accountAddress: options.accountAddress,
        walletAddress: options.walletAddress,
        isApiWallet: options.isApiWallet,
        initialState: toSerializable(options.initialState ?? {}),
        persistedState: toSerializable(options.persistedState ?? {}),
        pid: process.pid,
        startedAt: Date.now(),
      },
    });
  }

  private handleSocketClose(): void {
    if (this.lineReader) {
      this.lineReader.close();
      this.lineReader = null;
    }

    const inflight = [...this.inFlight.values()];
    this.inFlight.clear();
    if (inflight.length > 0) {
      this.pendingQueue = inflight.concat(this.pendingQueue);
    }

    this.socket = null;
    if (!this.closed) {
      void this.ensureConnected();
    }
  }

  private handleResponse(line: string): void {
    let response: AuditResponse;
    try {
      response = JSON.parse(line) as AuditResponse;
    } catch (error) {
      internalWarn(this.automationId, `failed to parse audit daemon response: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    this.inFlight.delete(response.messageId);
    const waiter = this.ackWaiters.get(response.messageId);
    if (!waiter) return;
    this.ackWaiters.delete(response.messageId);
    if (response.ok) {
      waiter.resolve();
    } else {
      waiter.reject(new Error(response.error || 'audit daemon returned an error'));
    }
  }

  private async openConnection(): Promise<void> {
    const socket = net.createConnection(this.socketPath);

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onConnect = () => {
        if (settled) return;
        settled = true;
        socket.off('error', onError);
        resolve();
      };

      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.off('connect', onConnect);
        socket.destroy();
        reject(error);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });

    socket.setEncoding('utf8');
    socket.on('close', () => this.handleSocketClose());
    socket.on('error', (error) => {
      if (!this.closed) {
        internalWarn(this.automationId, `audit socket error: ${error.message}`);
      }
    });

    this.lineReader = readline.createInterface({
      input: socket,
      crlfDelay: Infinity,
    });
    this.lineReader.on('line', (line) => this.handleResponse(line));

    this.socket = socket;
  }

  private async spawnDaemon(): Promise<void> {
    const now = Date.now();
    if (now - this.daemonSpawnedAt < 1_000) return;
    this.daemonSpawnedAt = now;

    const daemonPath = fileURLToPath(new URL('./audit-daemon.js', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--experimental-sqlite', daemonPath, this.dbPath, this.socketPath],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      },
    );
    child.unref();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) return;
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        await this.openConnection();
      } catch {
        await this.spawnDaemon();
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < 30 && !this.closed; attempt++) {
          try {
            await delay(100 + (attempt * 50));
            await this.openConnection();
            lastError = null;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }

        if (lastError) {
          throw lastError;
        }
      }

      await this.flushQueue();
    })().catch((error) => {
      internalWarn(this.automationId, `audit daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private enqueue(message: { type: AuditMessageType; payload: AuditPayload }): AuditMessage {
    const payload = message.type === 'init'
      ? message.payload
      : { runId: this.runId, ...message.payload };

    const wire: AuditMessage = {
      messageId: randomUUID(),
      type: message.type,
      payload,
    };
    this.pendingQueue.push(wire);
    void this.ensureConnected();
    if (this.socket && !this.socket.destroyed) {
      void this.flushQueue();
    }
    return wire;
  }

  private async flushQueue(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;

    this.flushPromise = (async () => {
      while (!this.closed && this.socket && !this.socket.destroyed && this.pendingQueue.length > 0) {
        const message = this.pendingQueue.shift()!;
        this.inFlight.set(message.messageId, message);

        const line = `${JSON.stringify(message)}\n`;
        const writable = this.socket.write(line);
        if (!writable && this.socket) {
          await once(this.socket, 'drain');
        }
      }
    })().finally(() => {
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  private send(message: { type: AuditMessageType; payload: AuditPayload }, waitForAck = false): Promise<void> {
    if (this.closed) return Promise.resolve();

    const wire = this.enqueue(message);
    if (!waitForAck) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      this.ackWaiters.set(wire.messageId, { resolve, reject });
      void this.flushQueue();
    });
  }

  recordLog(level: 'info' | 'warn' | 'error' | 'debug', message: string, timestamp: number = Date.now()): void {
    void this.send({ type: 'log', payload: { timestamp, level, message } });
  }

  recordEvent(eventType: string, source: 'poll' | 'ws' | 'manual', payload: unknown, timestamp: number = Date.now()): void {
    void this.send({ type: 'event', payload: { timestamp, eventType, source, payload: toSerializable(payload) } });
  }

  recordAction(args: {
    actionId?: string;
    phase: 'request' | 'response' | 'error';
    method: string;
    payload?: unknown;
    result?: unknown;
    error?: unknown;
    dryRun?: boolean;
    timestamp?: number;
  }): void {
    void this.send({
      type: 'action',
      payload: {
        timestamp: args.timestamp ?? Date.now(),
        actionId: args.actionId ?? randomUUID(),
        phase: args.phase,
        method: args.method,
        payload: toSerializable(args.payload),
        result: toSerializable(args.result),
        error: toSerializable(args.error),
        dryRun: args.dryRun ?? false,
      },
    });
  }

  recordSnapshot(snapshot: {
    pollCount: number;
    equity: number;
    marginUsed: number;
    marginUsedPct: number;
    positions: unknown[];
    timestamp?: number;
  }): void {
    void this.send({
      type: 'snapshot',
      payload: {
        timestamp: snapshot.timestamp ?? Date.now(),
        pollCount: snapshot.pollCount,
        equity: snapshot.equity,
        marginUsed: snapshot.marginUsed,
        marginUsedPct: snapshot.marginUsedPct,
        positions: toSerializable(snapshot.positions),
      },
    });
  }

  recordOrderUpdate(payload: unknown, timestamp: number = Date.now()): void {
    void this.send({ type: 'order_update', payload: { timestamp, payload: toSerializable(payload) } });
  }

  recordFill(payload: unknown, timestamp: number = Date.now()): void {
    void this.send({ type: 'fill', payload: { timestamp, payload: toSerializable(payload) } });
  }

  recordUserEvent(payload: unknown, timestamp: number = Date.now()): void {
    void this.send({ type: 'user_event', payload: { timestamp, payload: toSerializable(payload) } });
  }

  recordStateChange(op: 'set' | 'delete' | 'clear', key: string | null, value?: unknown, timestamp: number = Date.now()): void {
    void this.send({
      type: 'state_change',
      payload: {
        timestamp,
        op,
        key,
        value: toSerializable(value),
      },
    });
  }

  recordPublish(message: string, options: unknown, delivered: boolean, timestamp: number = Date.now()): void {
    void this.send({
      type: 'publish',
      payload: {
        timestamp,
        message,
        options: toSerializable(options),
        delivered,
      },
    });
  }

  recordError(stage: string, error: unknown, timestamp: number = Date.now()): void {
    void this.send({
      type: 'error',
      payload: {
        timestamp,
        stage,
        error: toSerializable(error),
      },
    });
  }

  recordNote(kind: string, payload?: unknown, timestamp: number = Date.now()): void {
    void this.send({
      type: 'note',
      payload: {
        timestamp,
        kind,
        payload: toSerializable(payload),
      },
    });
  }

  recordMetric(name: string, value: number, tags?: Record<string, unknown>, timestamp: number = Date.now()): void {
    void this.send({
      type: 'metric',
      payload: {
        timestamp,
        name,
        value,
        tags: toSerializable(tags ?? {}),
      },
    });
  }

  async stop(args: {
    status: 'stopped' | 'error';
    stopReason: string;
    pollCount: number;
    eventsEmitted: number;
    timestamp?: number;
  }): Promise<void> {
    if (this.closed) return;

    try {
      await this.send({
        type: 'stop',
        payload: {
          timestamp: args.timestamp ?? Date.now(),
          status: args.status,
          stopReason: args.stopReason,
          pollCount: args.pollCount,
          eventsEmitted: args.eventsEmitted,
        },
      }, true);
    } catch (error) {
      internalWarn(this.automationId, `failed to flush stop audit message: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.closed = true;
    if (this.lineReader) {
      this.lineReader.close();
      this.lineReader = null;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
    this.socket = null;
    this.pendingQueue = [];
    this.inFlight.clear();
    this.ackWaiters.clear();
  }
}

export function createAutomationAudit(options: AuditStartOptions): AutomationAuditSink {
  try {
    return new DaemonAuditSink(options.automationId, options);
  } catch (error) {
    internalWarn(options.automationId, `audit disabled: ${error instanceof Error ? error.message : String(error)}`);
    return new NoopAuditSink();
  }
}
