import { FeedbackTracker } from './StructuredFeedback.js';

describe('FeedbackTracker', () => {
  it('should track feedback per criterion', () => {
    const tracker = new FeedbackTracker();
    tracker.addFeedback(1, 'criterion-A', { status: 'failing', score: 0.2, feedback: 'No data found' });
    tracker.addFeedback(1, 'criterion-B', { status: 'passing', score: 0.9, feedback: 'Fully met' });
    expect(tracker.pendingCriteria()).toEqual(['criterion-A']);
    expect(tracker.resolvedCriteria()).toEqual(['criterion-B']);
  });

  it('should mark criterion as resolved when it passes', () => {
    const tracker = new FeedbackTracker();
    tracker.addFeedback(1, 'criterion-A', { status: 'failing', score: 0.2, feedback: 'Not found' });
    tracker.addFeedback(2, 'criterion-A', { status: 'passing', score: 0.85, feedback: 'Found and verified' });
    expect(tracker.pendingCriteria()).toEqual([]);
    expect(tracker.resolvedCriteria()).toEqual(['criterion-A']);
  });

  it('should render only pending feedback for prompt', () => {
    const tracker = new FeedbackTracker();
    tracker.addFeedback(1, 'criterion-A', { status: 'failing', score: 0.2, feedback: 'Missing' });
    tracker.addFeedback(1, 'criterion-B', { status: 'passing', score: 0.9, feedback: 'Good' });
    tracker.addFeedback(2, 'criterion-A', { status: 'failing', score: 0.4, feedback: 'Improved but incomplete' });

    const rendered = tracker.renderForPrompt();
    expect(rendered).toContain('Improved but incomplete');
    expect(rendered).not.toContain('Missing');
    expect(rendered).not.toContain('Good');
    expect(rendered).toContain('criterion-B');
    expect(rendered).toContain('resolved');
  });

  it('should return empty string when no feedback exists', () => {
    const tracker = new FeedbackTracker();
    expect(tracker.renderForPrompt()).toBe('');
  });

  it('should handle criterion regressing from passing to failing', () => {
    const tracker = new FeedbackTracker();
    tracker.addFeedback(1, 'criterion-A', { status: 'passing', score: 0.9, feedback: 'Good' });
    tracker.addFeedback(2, 'criterion-A', { status: 'failing', score: 0.3, feedback: 'Regressed' });
    expect(tracker.pendingCriteria()).toEqual(['criterion-A']);
    expect(tracker.resolvedCriteria()).toEqual([]);
  });

  it('should preserve insertion order for criteria', () => {
    const tracker = new FeedbackTracker();
    tracker.addFeedback(1, 'z-criterion', { status: 'failing', score: 0.1, feedback: 'Bad' });
    tracker.addFeedback(1, 'a-criterion', { status: 'failing', score: 0.2, feedback: 'Also bad' });
    tracker.addFeedback(1, 'm-criterion', { status: 'passing', score: 0.9, feedback: 'Fine' });
    expect(tracker.pendingCriteria()).toEqual(['z-criterion', 'a-criterion']);
    expect(tracker.resolvedCriteria()).toEqual(['m-criterion']);
  });

  it('should render score in pending criteria output', () => {
    const tracker = new FeedbackTracker();
    tracker.addFeedback(1, 'criterion-A', { status: 'failing', score: 0.4, feedback: 'Needs work' });
    const rendered = tracker.renderForPrompt();
    expect(rendered).toContain('0.4');
    expect(rendered).toContain('Needs work');
  });
});
