import { describe, it, expect } from 'vitest';
import { BudgetGuard } from './BudgetGuard.js';

describe('BudgetGuard', () => {
  it('should allow calls within budget', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });
    guard.recordCost(0.10);
    guard.recordCost(0.15);
    expect(guard.isExhausted()).toBe(false);
    expect(guard.remaining()).toBeCloseTo(0.25);
  });

  it('should flag exhaustion when budget exceeded', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });
    guard.recordCost(0.30);
    guard.recordCost(0.25);
    expect(guard.isExhausted()).toBe(true);
    expect(guard.remaining()).toBeLessThanOrEqual(0);
  });

  it('should provide budget status summary', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });
    guard.recordCost(0.35);
    const status = guard.status();
    expect(status.spent).toBeCloseTo(0.35);
    expect(status.remaining).toBeCloseTo(0.15);
    expect(status.percentUsed).toBeCloseTo(70);
    expect(status.isExhausted).toBe(false);
  });

  it('should be disabled when no budget set', () => {
    const guard = new BudgetGuard({});
    guard.recordCost(100);
    expect(guard.isExhausted()).toBe(false);
    expect(guard.isEnabled()).toBe(false);
  });

  it('should reset spent amount', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });
    guard.recordCost(0.40);
    guard.reset();
    expect(guard.remaining()).toBeCloseTo(0.50);
    expect(guard.isExhausted()).toBe(false);
  });

  it('should report enabled when budget is set', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 1.00 });
    expect(guard.isEnabled()).toBe(true);
  });

  it('should return Infinity remaining when no budget set', () => {
    const guard = new BudgetGuard({});
    expect(guard.remaining()).toBe(Infinity);
  });

  it('should report 0 percentUsed when no budget set', () => {
    const guard = new BudgetGuard({});
    guard.recordCost(5.00);
    const status = guard.status();
    expect(status.spent).toBeCloseTo(5.00);
    expect(status.remaining).toBe(Infinity);
    expect(status.percentUsed).toBe(0);
    expect(status.isExhausted).toBe(false);
  });

  it('should handle exact budget match as exhausted', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });
    guard.recordCost(0.50);
    expect(guard.isExhausted()).toBe(true);
    expect(guard.remaining()).toBeCloseTo(0);
  });
});
