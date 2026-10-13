/**
 * Process-wide gate for panel member spawns.
 *
 * Shared across calls rather than created per review: a panel's reviewers and
 * moderator, and panels for different repositories, all draw from the same
 * `maxConcurrency`.
 *
 * This gates one extension runtime. A reload creates a new gate while calls
 * under the old one may still be running.
 *
 * Non-reentrant: a holder that acquires again while holding self-deadlocks at
 * limit 1. FIFO order holds because `release` hands the slot to the head waiter
 * synchronously.
 */

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Subagent was aborted");
    }

    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve();
      };

      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("Subagent was aborted"));
      };

      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    if (this.active < 1) {
      throw new Error("Semaphore released without a held slot");
    }
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
