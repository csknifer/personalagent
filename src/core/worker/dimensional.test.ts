import { describe, it, expect } from 'vitest';
import { ScoreTracker } from './dimensional.js';

describe('ScoreTracker', () => {
  it('should track best score', () => {
    const tracker = new ScoreTracker();
    tracker.record(0.3);
    tracker.record(0.7);
    tracker.record(0.5);
    expect(tracker.best).toBe(0.7);
  });

  it('should detect plateau', () => {
    const tracker = new ScoreTracker();
    tracker.record(0.5);
    tracker.record(0.51);
    tracker.record(0.52);
    expect(tracker.isPlateau()).toBe(true);
  });

  it('should not detect plateau with significant changes', () => {
    const tracker = new ScoreTracker();
    tracker.record(0.3);
    tracker.record(0.5);
    tracker.record(0.7);
    expect(tracker.isPlateau()).toBe(false);
  });

  it('should detect regression', () => {
    const tracker = new ScoreTracker();
    tracker.record(0.7);
    tracker.record(0.5);
    tracker.record(0.3);
    expect(tracker.isRegressing()).toBe(true);
  });

  it('should not detect regression with improvement', () => {
    const tracker = new ScoreTracker();
    tracker.record(0.3);
    tracker.record(0.5);
    tracker.record(0.7);
    expect(tracker.isRegressing()).toBe(false);
  });

  it('should return false for plateau/regression with < 3 scores', () => {
    const tracker = new ScoreTracker();
    tracker.record(0.5);
    tracker.record(0.5);
    expect(tracker.isPlateau()).toBe(false);
    expect(tracker.isRegressing()).toBe(false);
  });

  it('should return 0 for best when empty', () => {
    const tracker = new ScoreTracker();
    expect(tracker.best).toBe(0);
  });
});
