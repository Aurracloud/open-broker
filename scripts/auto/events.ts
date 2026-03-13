// Lightweight typed event bus for the automation runtime

import type {
  AutomationEventType,
  AutomationEventPayloads,
  AutomationEventHandler,
} from './types.js';

export class AutomationEventBus {
  private handlers = new Map<AutomationEventType, Set<Function>>();

  on<E extends AutomationEventType>(
    event: E,
    handler: AutomationEventHandler<E>,
  ): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  /** Emit an event — handlers run sequentially, errors are returned (not thrown) */
  async emit<E extends AutomationEventType>(
    event: E,
    payload: AutomationEventPayloads[E],
  ): Promise<Error[]> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return [];

    const errors: Error[] = [];
    for (const handler of set) {
      try {
        await handler(payload);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return errors;
  }

  /** Check if any handlers are registered for an event */
  has(event: AutomationEventType): boolean {
    const set = this.handlers.get(event);
    return set !== undefined && set.size > 0;
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
