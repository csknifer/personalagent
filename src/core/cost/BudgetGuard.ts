export interface BudgetGuardOptions {
  maxCostPerRequest?: number;
}

export interface BudgetStatus {
  spent: number;
  remaining: number;
  percentUsed: number;
  isExhausted: boolean;
}

export class BudgetGuard {
  private readonly maxCost: number | undefined;
  private spent: number = 0;

  constructor(options: BudgetGuardOptions) {
    this.maxCost = options.maxCostPerRequest;
  }

  recordCost(amount: number): void {
    this.spent += amount;
  }

  isExhausted(): boolean {
    if (this.maxCost === undefined) return false;
    return this.spent >= this.maxCost;
  }

  isEnabled(): boolean {
    return this.maxCost !== undefined;
  }

  remaining(): number {
    if (this.maxCost === undefined) return Infinity;
    return Math.max(0, this.maxCost - this.spent);
  }

  status(): BudgetStatus {
    const remaining = this.remaining();
    const percentUsed = this.maxCost !== undefined
      ? (this.spent / this.maxCost) * 100
      : 0;

    return {
      spent: this.spent,
      remaining,
      percentUsed,
      isExhausted: this.isExhausted(),
    };
  }

  reset(): void {
    this.spent = 0;
  }
}
