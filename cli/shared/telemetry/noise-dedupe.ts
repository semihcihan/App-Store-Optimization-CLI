type DedupeState = {
  lastSentAt: number;
  suppressedCount: number;
};

export type DedupeDecision = {
  shouldSend: boolean;
  dedupedCount: number;
};

export class NoiseDedupeWindow {
  private readonly stateBySignature = new Map<string, DedupeState>();

  constructor(
    private readonly windowMs: number,
    private readonly retentionMultiplier = 2
  ) {}

  reset(): void {
    this.stateBySignature.clear();
  }

  register(signature: string, now = Date.now()): DedupeDecision {
    const existing = this.stateBySignature.get(signature);
    if (existing && now - existing.lastSentAt < this.windowMs) {
      existing.suppressedCount += 1;
      this.stateBySignature.set(signature, existing);
      return { shouldSend: false, dedupedCount: 0 };
    }

    const dedupedCount = existing?.suppressedCount ?? 0;
    this.stateBySignature.set(signature, { lastSentAt: now, suppressedCount: 0 });
    this.prune(now);
    return { shouldSend: true, dedupedCount };
  }

  private prune(now: number): void {
    const expiryMs = this.windowMs * this.retentionMultiplier;
    for (const [signature, state] of this.stateBySignature.entries()) {
      if (now - state.lastSentAt > expiryMs) {
        this.stateBySignature.delete(signature);
      }
    }
  }
}
