interface QueuedDelivery {
  deliver: () => void;
  dueAt: number;
}

/**
 * Delays calls by a fixed latency plus random jitter and keeps their
 * order, like a slow TCP connection. Development only: it lets one
 * machine show what a match feels like over a real network.
 */
export class DelayLine {
  private queue: QueuedDelivery[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly latencyMs: number,
    private readonly jitterMs: number,
  ) {}

  get active() {
    return this.latencyMs > 0 || this.jitterMs > 0;
  }

  send(deliver: () => void) {
    if (!this.active) {
      deliver();
      return;
    }

    const last = this.queue[this.queue.length - 1];
    const dueAt = performance.now() + this.latencyMs + Math.random() * this.jitterMs;
    this.queue.push({ deliver, dueAt: last === undefined ? dueAt : Math.max(last.dueAt, dueAt) });
    this.schedule();
  }

  private schedule() {
    if (this.timer !== null || this.queue.length === 0) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const now = performance.now();
        while (this.queue.length > 0 && this.queue[0].dueAt <= now) {
          this.queue.shift()?.deliver();
        }
        this.schedule();
      },
      Math.max(0, this.queue[0].dueAt - performance.now()),
    );
  }
}

/**
 * One-way delay for each direction, read from `?lag=<ms>&jitter=<ms>`.
 * Without those parameters the lines deliver at once.
 */
export const createSimulatedLink = (enabled: boolean) => {
  const params = new URLSearchParams(enabled ? window.location.search : "");
  const read = (name: string) => {
    const value = Number(params.get(name));
    return Number.isFinite(value) && value > 0 ? Math.min(value, 2000) : 0;
  };
  const latencyMs = read("lag");
  const jitterMs = read("jitter");
  return {
    down: new DelayLine(latencyMs, jitterMs),
    up: new DelayLine(latencyMs, jitterMs),
  };
};
