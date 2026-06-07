import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { DisplayState } from "./codex-state.js";

type SaveStateFileOperations = {
  writeFile: (path: string, content: string, encoding: "utf8") => Promise<unknown>;
  rename: (source: string, destination: string) => Promise<unknown>;
  rm: (path: string, options: { force: true }) => Promise<unknown>;
};

const defaultSaveStateFileOperations: SaveStateFileOperations = {
  writeFile,
  rename,
  rm,
};

export async function saveState(
  path: string,
  state: DisplayState,
  fileOperations: SaveStateFileOperations = defaultSaveStateFileOperations,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  try {
    await fileOperations.writeFile(temporaryPath, JSON.stringify(state), "utf8");
    await fileOperations.rename(temporaryPath, path);
  } finally {
    await fileOperations.rm(temporaryPath, { force: true });
  }
}

export async function loadState(path: string): Promise<DisplayState | null> {
  try {
    const cached: unknown = JSON.parse(await readFile(path, "utf8"));

    if (!isCachedState(cached)) {
      return null;
    }

    return { ...cached, accountStale: true };
  } catch {
    return null;
  }
}

function isCachedState(value: unknown): value is DisplayState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const state = value as Record<string, unknown>;

  return (
    state.version === 1
    && typeof state.threadId === "string"
    && typeof state.sessionId === "string"
    && (state.source === "desktop" || state.source === "cli")
    && (
      state.status === "IDLE"
      || state.status === "WORKING"
      || state.status === "WAIT"
      || state.status === "ERROR"
    )
    && typeof state.email === "string"
    && state.email.trim() !== ""
    && typeof state.accountStale === "boolean"
    && isNullableFiniteNumber(state.fiveHourRemaining)
    && isNullableFiniteNumber(state.weeklyRemaining)
    && isNullableFiniteNumber(state.contextUsedPercent)
    && isNullableFiniteNumber(state.contextTokens)
    && isNullableFiniteNumber(state.modelContextWindow)
    && typeof state.updatedAt === "number"
    && Number.isFinite(state.updatedAt)
  );
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
