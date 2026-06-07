import type {
  CodexSource,
  CodexStatus,
  NormalizedEvent,
  RateLimitSnapshot,
} from "./codex-state.js";

export type ThreadSnapshot = {
  threadId: string;
  sessionId: string;
  source: CodexSource | null;
  status: CodexStatus;
  turnId: string | null;
  lastEventAt: number;
  contextTokens: number | null;
  modelContextWindow: number | null;
  quota: RateLimitSnapshot | null;
};

type ThreadRecord = {
  snapshot: ThreadSnapshot;
  receiveSequence: number;
};

type StatusEvent = NormalizedEvent & {
  kind: "status";
  status: CodexStatus;
};

type TokenEvent = NormalizedEvent & {
  kind: "token";
};

export class ThreadAggregator {
  private readonly threads = new Map<string, ThreadRecord>();
  private activeThreadId: string | null = null;
  private receiveSequence = 0;

  apply(event: NormalizedEvent): ThreadSnapshot | null {
    if (event.kind !== "status" && event.kind !== "token") {
      return null;
    }

    if (event.kind === "status" && event.status === undefined) {
      return null;
    }

    const receiveSequence = ++this.receiveSequence;
    const existing = this.threads.get(event.threadId);
    if (existing && !isNewer(event.occurredAt, receiveSequence, existing)) {
      return null;
    }

    const snapshot =
      event.kind === "status"
        ? this.applyStatusEvent(event as StatusEvent, existing)
        : this.applyTokenEvent(event as TokenEvent, existing);

    const record: ThreadRecord = {
      snapshot,
      receiveSequence,
    };
    this.threads.set(event.threadId, record);

    if (this.shouldSelectActive(record)) {
      this.activeThreadId = event.threadId;
    }

    return cloneSnapshot(snapshot);
  }

  setSource(threadId: string, source: CodexSource): ThreadSnapshot | null {
    const existing = this.threads.get(threadId);
    if (!existing) {
      return null;
    }

    existing.snapshot.source = source;
    return cloneSnapshot(existing.snapshot);
  }

  current(): ThreadSnapshot | null {
    if (this.activeThreadId === null) {
      return null;
    }

    const current = this.threads.get(this.activeThreadId);
    return current ? cloneSnapshot(current.snapshot) : null;
  }

  private applyStatusEvent(
    event: StatusEvent,
    existing: ThreadRecord | undefined,
  ): ThreadSnapshot {
    return {
      threadId: event.threadId,
      sessionId: event.sessionId,
      source: event.source ?? existing?.snapshot.source ?? null,
      status: event.status,
      turnId: event.turnId,
      lastEventAt: event.occurredAt,
      contextTokens:
        event.contextTokens !== undefined
          ? event.contextTokens
          : existing?.snapshot.contextTokens ?? null,
      modelContextWindow:
        event.modelContextWindow !== undefined
          ? event.modelContextWindow
          : existing?.snapshot.modelContextWindow ?? null,
      quota: cloneQuota(existing?.snapshot.quota ?? null),
    };
  }

  private applyTokenEvent(
    event: TokenEvent,
    existing: ThreadRecord | undefined,
  ): ThreadSnapshot {
    const turnResumed = event.turnId !== null;

    return {
      threadId: event.threadId,
      sessionId: event.sessionId,
      source: event.source ?? existing?.snapshot.source ?? null,
      status: turnResumed ? "WORKING" : existing?.snapshot.status ?? "IDLE",
      turnId: turnResumed ? event.turnId : existing?.snapshot.turnId ?? null,
      lastEventAt: event.occurredAt,
      contextTokens:
        event.contextTokens !== undefined
          ? event.contextTokens
          : existing?.snapshot.contextTokens ?? null,
      modelContextWindow:
        event.modelContextWindow !== undefined
          ? event.modelContextWindow
          : existing?.snapshot.modelContextWindow ?? null,
      quota:
        event.quota !== undefined
          ? cloneQuota(event.quota)
          : cloneQuota(existing?.snapshot.quota ?? null),
    };
  }

  private shouldSelectActive(record: ThreadRecord): boolean {
    if (this.activeThreadId === null) {
      return true;
    }

    const current = this.threads.get(this.activeThreadId);
    return current === undefined || isNewerRecord(record, current);
  }
}

function isNewer(
  occurredAt: number,
  receiveSequence: number,
  existing: ThreadRecord,
): boolean {
  return (
    occurredAt > existing.snapshot.lastEventAt ||
    (occurredAt === existing.snapshot.lastEventAt && receiveSequence > existing.receiveSequence)
  );
}

function isNewerRecord(candidate: ThreadRecord, current: ThreadRecord): boolean {
  return (
    candidate.snapshot.lastEventAt > current.snapshot.lastEventAt ||
    (candidate.snapshot.lastEventAt === current.snapshot.lastEventAt &&
      candidate.receiveSequence > current.receiveSequence)
  );
}

function cloneSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return {
    ...snapshot,
    quota: cloneQuota(snapshot.quota),
  };
}

function cloneQuota(quota: RateLimitSnapshot | null): RateLimitSnapshot | null {
  return quota === null ? null : structuredClone(quota);
}
