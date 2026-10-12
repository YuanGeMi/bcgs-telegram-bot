export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Spaces sends: at least `perChatMs` between messages to one chat and `globalMs` between any two. */
export class SendRateLimiter {
  private lastGlobal = Number.NEGATIVE_INFINITY;
  private readonly lastPerChat = new Map<string, number>();

  constructor(
    private readonly clock: Clock = realClock,
    private readonly perChatMs = 1000,
    private readonly globalMs = 50,
  ) {}

  /** Waits until a message to `chatId` may be sent, then records it as sent now. */
  async acquire(chatId: string): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const readyAt = Math.max(this.lastGlobal + this.globalMs, (this.lastPerChat.get(chatId) ?? Number.NEGATIVE_INFINITY) + this.perChatMs);
      if (readyAt <= now) break;
      await this.clock.sleep(readyAt - now);
    }
    const now = this.clock.now();
    this.lastGlobal = now;
    this.lastPerChat.set(chatId, now);
    this.prune(now);
  }

  private prune(now: number): void {
    if (this.lastPerChat.size < 1000) return;
    for (const [chatId, at] of this.lastPerChat) {
      if (now - at >= this.perChatMs) this.lastPerChat.delete(chatId);
    }
  }
}
