import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createShutdownManager } from './ShutdownManager.js';

describe('ShutdownManager', () => {
  let manager: ReturnType<typeof createShutdownManager>;

  beforeEach(() => {
    manager = createShutdownManager();
  });

  it('calls cleanup functions in priority order (highest first)', async () => {
    const order: string[] = [];

    manager.register('low', () => { order.push('low'); }, 0);
    manager.register('high', () => { order.push('high'); }, 10);
    manager.register('mid', () => { order.push('mid'); }, 5);

    await manager.shutdown('test');

    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('is idempotent — second call is a no-op', async () => {
    let callCount = 0;
    manager.register('counter', () => { callCount++; });

    await manager.shutdown('first');
    await manager.shutdown('second');

    expect(callCount).toBe(1);
  });

  it('sets isShuttingDown flag', async () => {
    expect(manager.getIsShuttingDown()).toBe(false);
    await manager.shutdown('test');
    expect(manager.getIsShuttingDown()).toBe(true);
  });

  it('one failing cleanup does not prevent others', async () => {
    const order: string[] = [];

    manager.register('first', () => { order.push('first'); }, 10);
    manager.register('failing', () => { throw new Error('boom'); }, 5);
    manager.register('last', () => { order.push('last'); }, 0);

    await manager.shutdown('test');

    expect(order).toEqual(['first', 'last']);
  });

  it('handles async cleanup functions', async () => {
    const order: string[] = [];

    manager.register('async', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push('async');
    }, 10);
    manager.register('sync', () => { order.push('sync'); }, 0);

    await manager.shutdown('test');

    expect(order).toEqual(['async', 'sync']);
  });

  it('times out hanging cleanup after 5 seconds', async () => {
    const order: string[] = [];

    manager.register('hanging', () => {
      return new Promise<void>(() => {
        // Never resolves
      });
    }, 10);
    manager.register('after', () => { order.push('after'); }, 0);

    await manager.shutdown('test');

    // The 'after' cleanup should still run even though 'hanging' timed out
    expect(order).toContain('after');
  }, 10000);

  it('works with no registered cleanups', async () => {
    // Should not throw
    await manager.shutdown('test');
    expect(manager.getIsShuttingDown()).toBe(true);
  });
});
