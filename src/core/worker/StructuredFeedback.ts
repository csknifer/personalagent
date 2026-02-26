/**
 * Structured feedback tracking for per-criterion verification status.
 *
 * Replaces appended feedback strings with structured objects that track
 * resolved vs pending criteria. Only pending feedback (latest iteration)
 * is shown in prompts; resolved criteria are collapsed to a brief mention.
 */

export interface CriterionFeedback {
  status: 'passing' | 'failing';
  score: number;
  feedback: string;
}

interface CriterionEntry {
  iteration: number;
  status: 'passing' | 'failing';
  score: number;
  feedback: string;
}

export class FeedbackTracker {
  /** Map from criterion name to its history of feedback entries, ordered by insertion. */
  private criteria: Map<string, CriterionEntry[]> = new Map();

  /**
   * Record feedback for a criterion at a given iteration.
   * Later iterations supersede earlier ones when determining current status.
   */
  addFeedback(iteration: number, criterion: string, entry: CriterionFeedback): void {
    if (!this.criteria.has(criterion)) {
      this.criteria.set(criterion, []);
    }
    this.criteria.get(criterion)!.push({
      iteration,
      status: entry.status,
      score: entry.score,
      feedback: entry.feedback,
    });
  }

  /** Returns names of criteria whose latest status is 'failing', in insertion order. */
  pendingCriteria(): string[] {
    const result: string[] = [];
    for (const [name, entries] of this.criteria) {
      const latest = entries[entries.length - 1];
      if (latest.status === 'failing') {
        result.push(name);
      }
    }
    return result;
  }

  /** Returns names of criteria whose latest status is 'passing', in insertion order. */
  resolvedCriteria(): string[] {
    const result: string[] = [];
    for (const [name, entries] of this.criteria) {
      const latest = entries[entries.length - 1];
      if (latest.status === 'passing') {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Render feedback for prompt injection.
   *
   * - Resolved criteria: single line listing names (no feedback text)
   * - Pending criteria: latest feedback only, with score
   * - Empty string if no feedback recorded
   */
  renderForPrompt(): string {
    if (this.criteria.size === 0) {
      return '';
    }

    const lines: string[] = [];
    const resolved = this.resolvedCriteria();
    const pending = this.pendingCriteria();

    if (resolved.length > 0) {
      lines.push(`Already resolved (do not revisit): ${resolved.join(', ')}`);
    }

    for (const name of pending) {
      const entries = this.criteria.get(name)!;
      const latest = entries[entries.length - 1];
      lines.push(`PENDING — ${name} (score: ${latest.score}): ${latest.feedback}`);
    }

    return lines.join('\n');
  }
}
