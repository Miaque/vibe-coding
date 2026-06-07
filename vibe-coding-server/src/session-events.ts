import type {
  CodexSource,
  NormalizedEvent,
  RateLimitSnapshot,
  RateLimitWindow,
} from "./codex-state.js";

export type SessionMetadata = {
  threadId: string;
  sessionId: string;
  source: CodexSource;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizeSource(originator: unknown, source: unknown): CodexSource | null {
  const normalizedOriginator = typeof originator === "string" ? originator.toLowerCase() : "";
  const normalizedSource = typeof source === "string" ? source.toLowerCase() : "";

  if (normalizedOriginator === "codex desktop" || normalizedSource === "vscode") {
    return "desktop";
  }
  if (normalizedOriginator === "codex-tui" || normalizedSource === "cli") {
    return "cli";
  }
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readNumber(object: JsonObject, key: string): number | null {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRateLimitWindow(value: unknown): RateLimitWindow | null {
  if (!isObject(value)) {
    return null;
  }

  const usedPercent = readNumber(value, "used_percent");
  if (usedPercent === null) {
    return null;
  }

  if (!Object.hasOwn(value, "resets_at")) {
    return { usedPercent };
  }

  const resetsAt = value.resets_at;
  if (resetsAt === null) {
    return { usedPercent, resetsAt: null };
  }
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
    return { usedPercent, resetsAt };
  }
  return null;
}

function parseQuota(value: unknown): RateLimitSnapshot | null {
  if (!isObject(value)) {
    return null;
  }

  const quota: RateLimitSnapshot = {
    limitId: typeof value.limit_id === "string" ? value.limit_id : null,
    primary: parseRateLimitWindow(value.primary),
    secondary: parseRateLimitWindow(value.secondary),
  };
  if (typeof value.plan_type === "string" || value.plan_type === null) {
    quota.planType = value.plan_type;
  }

  return quota;
}

export function parseSessionMetadata(line: string): SessionMetadata | null {
  const record = parseObject(line);
  if (!record || record.type !== "session_meta" || !isObject(record.payload)) {
    return null;
  }

  const { id, originator, source, cwd } = record.payload;
  const normalizedSource = normalizeSource(originator, source);
  if (typeof id !== "string" || typeof cwd !== "string" || !normalizedSource) {
    return null;
  }

  return {
    threadId: id,
    sessionId: id,
    source: normalizedSource,
  };
}

export function parseSessionRecord(
  line: string,
  metadata: SessionMetadata,
  activeTurnId: string | null,
): NormalizedEvent | null {
  const record = parseObject(line);
  const occurredAt = record ? parseTimestamp(record.timestamp) : null;
  if (!record || occurredAt === null || record.type !== "event_msg" || !isObject(record.payload)) {
    return null;
  }

  const payload = record.payload;
  if (payload.type === "task_started") {
    const turnId = payload.turn_id;
    const modelContextWindow = readNumber(payload, "model_context_window");
    if (typeof turnId !== "string" || modelContextWindow === null) {
      return null;
    }

    return {
      kind: "status",
      ...metadata,
      turnId,
      occurredAt,
      status: "WORKING",
      modelContextWindow,
    };
  }

  if (payload.type === "task_complete" || payload.type === "turn_aborted") {
    const turnId = payload.turn_id;
    if (typeof turnId !== "string") {
      return null;
    }

    return {
      kind: "status",
      ...metadata,
      turnId,
      occurredAt,
      status: "IDLE",
    };
  }

  if (payload.type === "token_count") {
    if (!isObject(payload.info) || !isObject(payload.info.last_token_usage)) {
      return null;
    }

    const contextTokens = readNumber(payload.info.last_token_usage, "total_tokens");
    const modelContextWindow = readNumber(payload.info, "model_context_window");
    const quota = parseQuota(payload.rate_limits);
    if (contextTokens === null || modelContextWindow === null) {
      return null;
    }

    return {
      kind: "token",
      ...metadata,
      turnId: activeTurnId,
      occurredAt,
      contextTokens,
      modelContextWindow,
      quota,
    };
  }

  return null;
}
