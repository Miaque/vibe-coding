import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { AppServerCommand } from "./app-server-client.js";
import type { CodexSource } from "./codex-state.js";

type RuntimeResolverOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform | string;
  exists?: (file: string) => boolean;
  readdir?: (dir: string) => string[];
  statMtimeMs?: (file: string) => number;
};

export function resolveRuntimeCommand(
  source: CodexSource,
  options: RuntimeResolverOptions = {},
): AppServerCommand {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (source === "cli") {
    return resolveCliCommand(env, platform);
  }

  return resolveDesktopCommand(env, platform, options);
}

function resolveCliCommand(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform | string,
): AppServerCommand {
  if (env.CODEX_CLI_COMMAND) {
    return appServerCommand(env.CODEX_CLI_COMMAND);
  }

  if (platform === "win32") {
    return windowsPathCommand(env);
  }

  return appServerCommand("codex");
}

function resolveDesktopCommand(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform | string,
  options: RuntimeResolverOptions,
): AppServerCommand {
  if (env.CODEX_DESKTOP_COMMAND) {
    return appServerCommand(env.CODEX_DESKTOP_COMMAND);
  }

  if (platform === "win32") {
    const localCommand = findLocalDesktopCommand(env, options);
    return localCommand ? appServerCommand(localCommand) : windowsPathCommand(env);
  }

  return appServerCommand("codex");
}

function findLocalDesktopCommand(
  env: Record<string, string | undefined>,
  options: RuntimeResolverOptions,
): string | null {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const exists = options.exists ?? existsSync;
  const readdir = options.readdir ?? readdirSync;
  const statMtimeMs = options.statMtimeMs ?? ((file: string) => statSync(file).mtimeMs);
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");

  if (!exists(binRoot)) {
    return null;
  }

  try {
    return (
      readdir(binRoot)
        .map((entry) => path.join(binRoot, entry, "codex.exe"))
        .filter((candidate) => exists(candidate))
        .sort((left, right) => statMtimeMs(right) - statMtimeMs(left))[0] ?? null
    );
  } catch {
    return null;
  }
}

function appServerCommand(command: string): AppServerCommand {
  return {
    command,
    args: ["app-server"],
    shell: false,
  };
}

function windowsPathCommand(env: Record<string, string | undefined>): AppServerCommand {
  return {
    command: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "codex app-server"],
    shell: false,
  };
}
