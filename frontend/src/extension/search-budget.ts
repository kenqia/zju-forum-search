/** Search requests and required waits consume this budget; planner calls do not. */
export class SearchBudget {
  private remainingMs: number;

  constructor(seconds: number, private readonly now: () => number) {
    this.remainingMs = Math.max(1, seconds) * 1000;
  }

  get exhausted(): boolean { return this.remainingMs <= 0; }

  async request<T>(operation: () => Promise<T>): Promise<T> {
    const started = this.now();
    try { return await operation(); }
    finally { this.remainingMs -= Math.max(0, this.now() - started); }
  }

  async wait(intervalMs: number, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
    const duration = Math.min(intervalMs, Math.max(0, this.remainingMs));
    const started = this.now();
    try { await sleep(duration); }
    finally { this.remainingMs -= Math.max(duration, this.now() - started); }
  }
}
