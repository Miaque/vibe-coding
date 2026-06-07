import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { DisplayState } from "./codex-state.js";

export async function saveState(path: string, state: DisplayState): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, JSON.stringify(state), "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
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
  return (
    typeof value === "object"
    && value !== null
    && "email" in value
    && typeof value.email === "string"
    && value.email.trim() !== ""
  );
}
