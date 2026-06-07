import { quotaMatches, type AccountSnapshot } from "./account-resolver.js";
import { createDisplayState, type DisplayState } from "./codex-state.js";
import type { ThreadSnapshot } from "./thread-aggregator.js";

export function createOnceDisplayState(
  thread: ThreadSnapshot,
  account: AccountSnapshot,
): DisplayState {
  if (!thread.source) {
    throw new Error("最新 Codex thread 缺少来源信息");
  }
  if (thread.quota && !quotaMatches(thread.quota, account.quota)) {
    throw new Error("最新 Codex thread 与当前账号配额不匹配");
  }

  return createDisplayState({
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    source: thread.source,
    status: thread.status,
    email: account.email,
    accountStale: false,
    quota: thread.quota ?? account.quota,
    contextTokens: thread.contextTokens,
    modelContextWindow: thread.modelContextWindow,
    updatedAt: thread.lastEventAt,
  });
}
