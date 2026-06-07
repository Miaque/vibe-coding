# Codex OLED Status Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first monitor that shows the most recently active Codex Desktop or CLI thread's account, quota, live context usage, and `WORKING` / `WAIT` / `IDLE` / `ERROR` / `OFFLINE` state on the ESP32 OLED.

**Architecture:** Codex hooks write low-latency lifecycle events into a global inbox, while a session watcher incrementally reads Codex JSONL files as the durable source for thread metadata, turn lifecycle, token usage, and quota. The server selects the thread with the newest valid event, resolves the matching Desktop or CLI account, publishes one atomic retained state plus an availability Last Will, and the firmware renders that contract.

**Tech Stack:** TypeScript 6, Node.js 20+, Node test runner, MQTT.js, Codex app-server JSON-RPC, Codex plugin hooks, PlatformIO, Arduino C++, ArduinoJson, PubSubClient, Adafruit SSD1306/GFX.

---

## Scope And File Map

### Server files

- Create `vibe-coding-server/src/codex-state.ts`: shared state, event, quota, and payload types plus pure conversion helpers.
- Create `vibe-coding-server/src/session-events.ts`: parse one Codex JSONL record into normalized monitor events.
- Create `vibe-coding-server/src/session-watcher.ts`: discover session files and incrementally emit normalized events.
- Create `vibe-coding-server/src/hook-inbox.ts`: consume atomic hook event files.
- Create `vibe-coding-server/src/thread-aggregator.ts`: per-thread state and most-recent-event selection.
- Create `vibe-coding-server/src/runtime-resolver.ts`: map Desktop/CLI session sources to app-server commands.
- Create `vibe-coding-server/src/account-resolver.ts`: account/quota matching and stale retry policy.
- Create `vibe-coding-server/src/state-cache.ts`: atomic `last-state.json` persistence.
- Create `vibe-coding-server/src/monitor-service.ts`: compose watcher, inbox, account resolver, cache, and MQTT publisher.
- Modify `vibe-coding-server/src/app-server-client.ts`: allow an explicit resolved command and expose reusable account/quota probe behavior.
- Modify `vibe-coding-server/src/publisher.ts`: publish atomic state and availability.
- Modify `vibe-coding-server/src/index.ts`: replace quota-only startup with monitor service startup.
- Modify `vibe-coding-server/src/quota.ts`: keep rate-limit types/helpers, remove display-payload ownership after migration.
- Delete `vibe-coding-server/src/quota-monitor.ts` after the new monitor is wired and tested.
- Update `vibe-coding-server/.env.example` and `vibe-coding-server/README.md`.

### Server tests and fixtures

- Create `vibe-coding-server/test/codex-state.test.ts`.
- Create `vibe-coding-server/test/session-events.test.ts`.
- Create `vibe-coding-server/test/session-watcher.test.ts`.
- Create `vibe-coding-server/test/hook-inbox.test.ts`.
- Create `vibe-coding-server/test/thread-aggregator.test.ts`.
- Create `vibe-coding-server/test/runtime-resolver.test.ts`.
- Create `vibe-coding-server/test/account-resolver.test.ts`.
- Create `vibe-coding-server/test/state-cache.test.ts`.
- Create `vibe-coding-server/test/monitor-service.test.ts`.
- Create JSONL fixtures under `vibe-coding-server/test/fixtures/sessions/`.
- Modify `vibe-coding-server/test/app-server-client.test.ts`.
- Modify `vibe-coding-server/test/publisher.test.ts`.
- Remove quota-monitor tests when `quota-monitor.ts` is removed.

### Hook plugin files

- Create `.agents/plugins/marketplace.json`.
- Create `plugins/codex-oled-monitor/.codex-plugin/plugin.json`.
- Create `plugins/codex-oled-monitor/hooks/hooks.json`.
- Create `plugins/codex-oled-monitor/scripts/write-runtime-event.mjs`.
- Create `plugins/codex-oled-monitor/test/write-runtime-event.test.mjs`.
- Create `plugins/codex-oled-monitor/README.md`.

### Firmware files

- Create `vibe-coding-firmware/include/codex_state.h`: state types and parser/status API.
- Create `vibe-coding-firmware/src/codex_state.cpp`: pure JSON parsing and effective-status logic.
- Modify `vibe-coding-firmware/src/main.cpp`: multiple topic subscription, state rendering, blinking, and availability.
- Modify `vibe-coding-firmware/scripts/load_env.py`: replace one topic with a topic prefix.
- Modify `vibe-coding-firmware/platformio.ini`: add native tests for pure state logic.
- Create `vibe-coding-firmware/test/test_codex_state/test_main.cpp`.
- Update `vibe-coding-firmware/.env.example`.

### Documentation

- Update `vibe-coding-server/README.md`.
- Create `plugins/codex-oled-monitor/README.md`.
- Keep `docs/spec/2026-06-07-codex-oled-status-monitor.md` aligned with any verified contract corrections found during implementation.

## Task 1: Define The Atomic State Contract

**Files:**
- Create: `vibe-coding-server/src/codex-state.ts`
- Create: `vibe-coding-server/test/codex-state.test.ts`
- Modify: `vibe-coding-server/src/quota.ts`

- [ ] **Step 1: Write failing tests for context and quota conversion**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  contextPercent,
  createDisplayState,
  remainingPercent,
} from "../src/codex-state.js";

test("contextPercent uses last token usage, not session total", () => {
  assert.equal(contextPercent(64_600, 258_400), 25);
  assert.equal(contextPercent(null, 258_400), null);
  assert.equal(contextPercent(1, null), null);
});

test("remainingPercent clamps used percentage", () => {
  assert.equal(remainingPercent({ usedPercent: 28 }), 72);
  assert.equal(remainingPercent({ usedPercent: 101 }), 0);
  assert.equal(remainingPercent(null), null);
});

test("createDisplayState requires a non-empty email", () => {
  assert.throws(
    () =>
      createDisplayState({
        threadId: "thread-1",
        sessionId: "session-1",
        source: "desktop",
        status: "WORKING",
        email: "",
        accountStale: false,
        quota: null,
        contextTokens: null,
        modelContextWindow: null,
        updatedAt: 1,
      }),
    /email/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
cd vibe-coding-server
node --import tsx --test test/codex-state.test.ts
```

Expected: FAIL because `src/codex-state.ts` does not exist.

- [ ] **Step 3: Implement the shared types and pure helpers**

Create these public types and functions:

```ts
export type CodexStatus = "IDLE" | "WORKING" | "WAIT" | "ERROR";
export type CodexSource = "desktop" | "cli";

export type RateLimitWindow = {
  usedPercent: number;
  resetsAt?: number | null;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
};

export type NormalizedEvent = {
  kind: "status" | "token";
  threadId: string;
  sessionId: string;
  turnId: string | null;
  occurredAt: number;
  source?: CodexSource;
  status?: CodexStatus;
  contextTokens?: number | null;
  modelContextWindow?: number | null;
  quota?: RateLimitSnapshot | null;
};

export type DisplayState = {
  version: 1;
  threadId: string;
  sessionId: string;
  source: CodexSource;
  status: CodexStatus;
  email: string;
  accountStale: boolean;
  fiveHourRemaining: number | null;
  weeklyRemaining: number | null;
  contextUsedPercent: number | null;
  contextTokens: number | null;
  modelContextWindow: number | null;
  updatedAt: number;
};
```

`NormalizedEvent.occurredAt` is always epoch milliseconds. Hook events use `receivedAt`; session events parse the outer ISO `timestamp`. Never compare JSONL epoch seconds directly with hook milliseconds.

Implement:

```ts
export function contextPercent(tokens: number | null, window: number | null): number | null {
  if (tokens === null || window === null || window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
}

export function remainingPercent(window: RateLimitWindow | null | undefined): number | null {
  if (!window) return null;
  return Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)));
}
```

`createDisplayState()` must reject a blank email and construct all display fields from one thread snapshot.

- [ ] **Step 4: Run the focused tests**

Run:

```powershell
node --import tsx --test --test-name-pattern="contextPercent|remainingPercent|createDisplayState" test/codex-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add vibe-coding-server/src/codex-state.ts vibe-coding-server/src/quota.ts vibe-coding-server/test/codex-state.test.ts
git commit -m "feat: 定义 OLED 原子状态契约"
```

## Task 2: Parse Codex Session Events

**Files:**
- Create: `vibe-coding-server/src/session-events.ts`
- Create: `vibe-coding-server/test/session-events.test.ts`
- Create: `vibe-coding-server/test/fixtures/sessions/desktop.jsonl`
- Create: `vibe-coding-server/test/fixtures/sessions/cli.jsonl`

- [ ] **Step 1: Add representative fixture records**

Use sanitized copies of verified records:

```json
{"timestamp":"2026-06-06T17:57:40.869Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1780768660,"model_context_window":258400}}
{"timestamp":"2026-06-06T17:57:53.200Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":43192},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":1,"resets_at":1780778325},"secondary":{"used_percent":34,"resets_at":1781142977},"plan_type":"plus"}}}
{"timestamp":"2026-06-06T17:58:18.875Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":1780768698}}
```

The first line in each fixture must be a sanitized `session_meta` record containing `id`, `originator`, `source`, and `cwd`.

- [ ] **Step 2: Write failing parser tests**

Cover:

- Desktop and CLI source normalization.
- `task_started -> WORKING`.
- `task_complete` and `turn_aborted -> IDLE`.
- `token_count` uses `last_token_usage.total_tokens`.
- snake_case rate limits normalize to the shared camelCase type.
- unknown and malformed records return `null` instead of throwing.

Real `token_count` records do not contain `turn_id`. Parse the preceding `task_started` first and pass its turn into the token parser:

```ts
const started = parseSessionRecord(startLine, metadata, null);
assert.equal(started?.turnId, "turn-1");

assert.deepEqual(parseSessionRecord(tokenLine, metadata, started?.turnId ?? null), {
  kind: "token",
  threadId: "thread-1",
  sessionId: "thread-1",
  turnId: "turn-1",
  occurredAt: 1780768673200,
  source: "desktop",
  contextTokens: 43192,
  modelContextWindow: 258400,
  quota: {
    limitId: "codex",
    planType: "plus",
    primary: { usedPercent: 1, resetsAt: 1780778325 },
    secondary: { usedPercent: 34, resetsAt: 1781142977 },
  },
});
```

- [ ] **Step 3: Run and verify failure**

```powershell
cd vibe-coding-server
node --import tsx --test test/session-events.test.ts
```

Expected: FAIL because the parser is absent.

- [ ] **Step 4: Implement strict-at-boundary, tolerant-inside parsing**

Expose:

```ts
export type SessionMetadata = {
  threadId: string;
  sessionId: string;
  source: CodexSource;
};

export function parseSessionMetadata(line: string): SessionMetadata | null;
export function parseSessionRecord(
  line: string,
  metadata: SessionMetadata,
  activeTurnId: string | null,
): NormalizedEvent | null;
```

Use `JSON.parse`, explicit object guards, and event-specific field extraction. Do not use regex to parse JSON. Unknown records return `null`; malformed JSON is caught and returns `null`. `task_started`, `task_complete`, and `turn_aborted` take their own `turn_id`; `token_count` uses the supplied `activeTurnId`.

- [ ] **Step 5: Run parser tests and full server tests**

```powershell
node --import tsx --test test/session-events.test.ts
npm test
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```powershell
git add vibe-coding-server/src/session-events.ts vibe-coding-server/test/session-events.test.ts vibe-coding-server/test/fixtures/sessions
git commit -m "feat: 解析 Codex 会话事件"
```

## Task 3: Incrementally Watch Session JSONL Files

**Files:**
- Create: `vibe-coding-server/src/session-watcher.ts`
- Create: `vibe-coding-server/test/session-watcher.test.ts`

- [ ] **Step 1: Write failing integration tests with a temporary session tree**

Tests must prove:

1. Existing complete lines are replayed once at startup.
2. Appended lines emit one new event.
3. A partial trailing line is held until its newline arrives.
4. A malformed line does not stop later valid lines.
5. File truncation resets the offset safely.
6. The first valid `session_meta` emits one `"metadata"` event before later normalized events.

Use `mkdtemp`, `appendFile`, and an injected polling interval of 10 ms. Do not depend on platform-specific `fs.watch` semantics in tests.

- [ ] **Step 2: Run and verify failure**

```powershell
node --import tsx --test test/session-watcher.test.ts
```

Expected: FAIL because `SessionWatcher` is absent.

- [ ] **Step 3: Implement a polling incremental watcher**

Public API:

```ts
export class SessionWatcher extends EventEmitter {
  constructor(options: {
    root: string;
    pollIntervalMs?: number;
  });
  scanOnce(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
}
```

Maintain per-file:

```ts
type FileCursor = {
  offset: number;
  pending: string;
  metadata: SessionMetadata | null;
  activeTurnId: string | null;
  size: number;
};
```

On each poll:

- Recursively enumerate `.jsonl` files under the current year/month/day tree.
- Read only bytes from the saved offset.
- Split complete newline-terminated records.
- Preserve the final partial line.
- Emit `"metadata"` once when a file's first valid `session_meta` is parsed.
- Emit `"event"` with `NormalizedEvent`.
- Set `activeTurnId` on `task_started`; clear it after parsing a matching `task_complete` or `turn_aborted`.
- Reset cursor if size becomes smaller than offset.

Keep the implementation dependency-free for V1.

- [ ] **Step 4: Run watcher tests**

```powershell
node --import tsx --test test/session-watcher.test.ts
```

Expected: PASS with no leaked timers.

- [ ] **Step 5: Commit**

```powershell
git add vibe-coding-server/src/session-watcher.ts vibe-coding-server/test/session-watcher.test.ts
git commit -m "feat: 增量监听 Codex 会话文件"
```

## Task 4: Add The Low-Latency Hook Plugin And Inbox Consumer

**Files:**
- Create: `.agents/plugins/marketplace.json`
- Create: `plugins/codex-oled-monitor/.codex-plugin/plugin.json`
- Create: `plugins/codex-oled-monitor/hooks/hooks.json`
- Create: `plugins/codex-oled-monitor/scripts/write-runtime-event.mjs`
- Create: `plugins/codex-oled-monitor/test/write-runtime-event.test.mjs`
- Create: `plugins/codex-oled-monitor/README.md`
- Create: `vibe-coding-server/src/hook-inbox.ts`
- Create: `vibe-coding-server/test/hook-inbox.test.ts`

- [ ] **Step 1: Write the hook writer test first**

Spawn the script with:

```json
{
  "session_id": "session-1",
  "turn_id": "turn-1",
  "transcript_path": "C:\\sessions\\thread.jsonl",
  "cwd": "H:\\workspace\\repo",
  "hook_event_name": "PermissionRequest",
  "model": "gpt-5.5"
}
```

Set `VIBE_CODING_RUNTIME_DIR` to a temporary directory. Assert exactly one `.json` file exists in `inbox`, its JSON is complete, and `receivedAt` is a millisecond timestamp.

- [ ] **Step 2: Run and verify failure**

```powershell
node --test plugins/codex-oled-monitor/test/write-runtime-event.test.mjs
```

Expected: FAIL because the plugin script is absent.

- [ ] **Step 3: Implement the atomic writer**

The script must:

- Read all stdin as UTF-8.
- Parse JSON.
- Require `session_id`, `hook_event_name`, and `cwd`.
- Use `%LOCALAPPDATA%\VibeCoding\runtime` by default on Windows and `~/.local/state/vibe-coding` on non-Windows.
- Create `inbox`.
- Generate a basename from `receivedAt`, process ID, and `randomUUID()`, write `${basename}.tmp`, then rename it to `${basename}.json`.
- Complete without network access.

Do not normalize away unknown hook fields; copy only the documented fields into the output.

- [ ] **Step 4: Add plugin metadata and hooks**

`plugin.json`:

```json
{
  "name": "codex-oled-monitor",
  "version": "0.1.0",
  "description": "Emit Codex lifecycle events for the OLED status monitor.",
  "author": { "name": "Vibe Coding" },
  "license": "MIT"
}
```

Create `.agents/plugins/marketplace.json`:

```json
{
  "name": "vibe-coding",
  "interface": {
    "displayName": "Vibe Coding"
  },
  "plugins": [
    {
      "name": "codex-oled-monitor",
      "source": {
        "source": "local",
        "path": "./plugins/codex-oled-monitor"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Engineering"
    }
  ]
}
```

Create `hooks/hooks.json` with the complete matcher structure:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PLUGIN_ROOT/scripts/write-runtime-event.mjs\"",
            "commandWindows": "node \"%CLAUDE_PLUGIN_ROOT%\\scripts\\write-runtime-event.mjs\"",
            "timeout": 2,
            "async": false
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PLUGIN_ROOT/scripts/write-runtime-event.mjs\"",
            "commandWindows": "node \"%CLAUDE_PLUGIN_ROOT%\\scripts\\write-runtime-event.mjs\"",
            "timeout": 2,
            "async": false
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PLUGIN_ROOT/scripts/write-runtime-event.mjs\"",
            "commandWindows": "node \"%CLAUDE_PLUGIN_ROOT%\\scripts\\write-runtime-event.mjs\"",
            "timeout": 2,
            "async": false
          }
        ]
      }
    ]
  }
}
```

These names match the installed Codex hook loader contract: plugin hooks live under `hooks/hooks.json`, command hooks use `timeout`, and the plugin root environment variable is `CLAUDE_PLUGIN_ROOT`.

- [ ] **Step 5: Write failing inbox consumer tests**

Tests:

- Existing files are consumed oldest-first.
- `PermissionRequest -> WAIT`, `UserPromptSubmit -> WORKING`, `Stop -> IDLE`.
- Consumed files are deleted only after successful parse and emission.
- Invalid files move to `runtime/rejected/` instead of retrying forever.

- [ ] **Step 6: Implement `HookInbox`**

Public API:

```ts
export class HookInbox extends EventEmitter {
  constructor(options: { runtimeDir: string; pollIntervalMs?: number });
  start(): Promise<void>;
  stop(): void;
}
```

Emit normalized status events. `occurredAt` is `receivedAt`; source remains undefined until the session watcher emits matching metadata.

- [ ] **Step 7: Run all hook and inbox tests**

```powershell
node --test plugins/codex-oled-monitor/test/write-runtime-event.test.mjs
cd vibe-coding-server
node --import tsx --test test/hook-inbox.test.ts
```

Expected: PASS.

- [ ] **Step 8: Verify Codex recognizes the plugin hooks**

Install the repository as a local marketplace and add the plugin:

```powershell
codex plugin marketplace add H:\workspace\embedded\vibe-coding
codex plugin add codex-oled-monitor@vibe-coding
codex plugin list
```

Start a fresh Codex process and run one test turn with hook trust explicitly bypassed for this verified local plugin:

```powershell
codex --dangerously-bypass-hook-trust exec "Reply with exactly: hook-ok"
```

Expected:

- `codex plugin list` reports `codex-oled-monitor` installed from `vibe-coding`.
- No marketplace, schema, trust, or command warnings.
- A test turn writes `UserPromptSubmit` and `Stop` files.

- [ ] **Step 9: Commit**

```powershell
git add .agents/plugins/marketplace.json plugins/codex-oled-monitor vibe-coding-server/src/hook-inbox.ts vibe-coding-server/test/hook-inbox.test.ts
git commit -m "feat: 添加 Codex 状态 hook"
```

## Task 5: Aggregate Threads And Select The Newest Event

**Files:**
- Create: `vibe-coding-server/src/thread-aggregator.ts`
- Create: `vibe-coding-server/test/thread-aggregator.test.ts`

- [ ] **Step 1: Write failing state-machine tests**

Required cases:

- A newer event selects its thread.
- An older event cannot overwrite a newer status.
- A token event can switch the active thread and update CTX/quota.
- A newer token event for an open turn changes that thread from `WAIT` back to `WORKING`, providing recovery after approval.
- `setSource()` enriches a hook-created thread without changing its event timestamp or current-thread ordering.
- Account refresh events are not accepted by the aggregator and cannot switch threads.
- `PermissionRequest -> WAIT`.
- `task_complete` after an earlier `PermissionRequest -> IDLE`.
- Another thread's older `ERROR` does not take priority.

Representative sequence:

```ts
aggregator.apply(event("thread-a", 100, "WORKING"));
aggregator.apply(event("thread-b", 110, "WAIT"));
aggregator.apply(event("thread-a", 105, "IDLE"));

assert.equal(aggregator.current()?.threadId, "thread-b");
assert.equal(aggregator.current()?.status, "WAIT");
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --import tsx --test test/thread-aggregator.test.ts
```

Expected: FAIL because the aggregator is absent.

- [ ] **Step 3: Implement the aggregator**

Public API:

```ts
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

export class ThreadAggregator {
  apply(event: NormalizedEvent): ThreadSnapshot | null;
  setSource(threadId: string, source: CodexSource): ThreadSnapshot | null;
  current(): ThreadSnapshot | null;
}
```

Use `(occurredAt, receiveSequence)` ordering so same-millisecond events remain deterministic. `setSource()` enriches metadata but must not change `lastEventAt` or current-thread selection. A token event with a non-null `turnId` is evidence that the turn resumed; it updates CTX/quota and changes `WAIT` to `WORKING`. A token event with no open turn updates data but does not invent a lifecycle transition.

- [ ] **Step 4: Run tests**

```powershell
node --import tsx --test test/thread-aggregator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add vibe-coding-server/src/thread-aggregator.ts vibe-coding-server/test/thread-aggregator.test.ts
git commit -m "feat: 聚合最近活跃 Codex 线程"
```

## Task 6: Resolve Desktop/CLI Accounts And Match Quota

**Files:**
- Create: `vibe-coding-server/src/runtime-resolver.ts`
- Create: `vibe-coding-server/src/account-resolver.ts`
- Create: `vibe-coding-server/test/runtime-resolver.test.ts`
- Create: `vibe-coding-server/test/account-resolver.test.ts`
- Modify: `vibe-coding-server/src/app-server-client.ts`
- Modify: `vibe-coding-server/test/app-server-client.test.ts`

- [ ] **Step 1: Write failing runtime mapping tests**

Test:

- `Codex Desktop`/`vscode` maps to the newest Desktop runtime under `%LOCALAPPDATA%\OpenAI\Codex\bin`.
- `codex-tui`/`cli` maps to `CODEX_CLI_COMMAND` or PATH.
- `CODEX_DESKTOP_COMMAND` overrides auto-discovery.
- Ubuntu CLI maps to `codex`.

- [ ] **Step 2: Write failing quota-match tests**

```ts
assert.equal(
  quotaMatches(
    snapshot(23, 37, 1000, 2000),
    snapshot(24, 36, 1000, 2000),
  ),
  true,
);

assert.equal(
  quotaMatches(
    snapshot(23, 37, 1000, 2000),
    snapshot(23, 37, 1001, 2000),
  ),
  false,
);
```

Also test:

- Both missing windows match.
- One missing and one present do not match.
- A blank/non-ChatGPT account is rejected.
- Failed probes keep the previous email and mark it stale.

- [ ] **Step 3: Run and verify failures**

```powershell
node --import tsx --test test/runtime-resolver.test.ts test/account-resolver.test.ts
```

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Refactor `AppServerClient` to accept a command**

Add:

```ts
export type AppServerCommand = {
  command: string;
  args: string[];
  shell: boolean;
};

constructor(options: {
  spawnServer?: () => AppServerProcess;
  command?: AppServerCommand;
} = {})
```

Keep all existing behavior and tests. Do not add thread monitoring to this client.

- [ ] **Step 5: Implement runtime resolution and account probing**

Expose:

```ts
export function resolveRuntimeCommand(source: CodexSource): AppServerCommand;

export type AccountSnapshot = {
  email: string;
  planType: string | null;
  quota: RateLimitSnapshot;
  resolvedAt: number;
};

export async function probeAccount(
  command: AppServerCommand,
): Promise<AccountSnapshot>;
```

`probeAccount()` starts one app-server, initializes it, calls `account/read` and `account/rateLimits/read`, then stops it in `finally`.

- [ ] **Step 6: Implement stale retry scheduling**

`AccountResolver.resolve(thread)`:

- Returns the last verified email immediately with `stale: true` when a new match is pending.
- Tries delays `0`, `250`, `500`, `1000`, and `2000` ms.
- Continues at 30-second intervals after fast retries.
- Cancels obsolete retries when the current thread/source changes.
- Emits `"resolved"` only when email or stale state changes.

Inject `probe`, `sleep`, and `now` in tests; do not wait real seconds.

- [ ] **Step 7: Run focused and full tests**

```powershell
node --import tsx --test test/app-server-client.test.ts test/runtime-resolver.test.ts test/account-resolver.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add vibe-coding-server/src/app-server-client.ts vibe-coding-server/src/runtime-resolver.ts vibe-coding-server/src/account-resolver.ts vibe-coding-server/test/app-server-client.test.ts vibe-coding-server/test/runtime-resolver.test.ts vibe-coding-server/test/account-resolver.test.ts
git commit -m "feat: 按线程来源解析 Codex 账号"
```

## Task 7: Persist Last State And Publish MQTT Availability

**Files:**
- Create: `vibe-coding-server/src/state-cache.ts`
- Create: `vibe-coding-server/test/state-cache.test.ts`
- Modify: `vibe-coding-server/src/publisher.ts`
- Modify: `vibe-coding-server/test/publisher.test.ts`

- [ ] **Step 1: Write failing cache tests**

Test:

- Save writes valid JSON.
- Save uses a temporary file and rename.
- Load returns `null` for missing or invalid cache.
- Load rejects a cached state with blank email.
- Restored state is copied with `accountStale: true`.

- [ ] **Step 2: Write failing publisher tests**

Replace quota-only expectations with:

```ts
await publishState(client, "oled/codex/state", state);
```

Assert `{ retain: true, qos: 1 }`.

Add:

```ts
createMqttOptions("oled/codex/availability")
```

Expected result includes:

```ts
will: {
  topic: "oled/codex/availability",
  payload: "offline",
  qos: 1,
  retain: true,
}
```

Test `publishAvailability(client, topic, "online")`.

- [ ] **Step 3: Run and verify failures**

```powershell
node --import tsx --test test/state-cache.test.ts test/publisher.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement atomic cache and generic retained publishing**

Expose:

```ts
export async function loadCachedState(path: string): Promise<DisplayState | null>;
export async function saveCachedState(path: string, state: DisplayState): Promise<void>;
export function publishState(
  client: Pick<MqttClient, "publish">,
  topic: string,
  state: DisplayState,
): Promise<void>;
export function publishAvailability(
  client: Pick<MqttClient, "publish">,
  topic: string,
  value: "online" | "offline",
): Promise<void>;
export function createMqttOptions(availabilityTopic: string): IClientOptions;
```

Do not log or persist MQTT credentials.

- [ ] **Step 5: Run tests**

```powershell
node --import tsx --test test/state-cache.test.ts test/publisher.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add vibe-coding-server/src/state-cache.ts vibe-coding-server/src/publisher.ts vibe-coding-server/test/state-cache.test.ts vibe-coding-server/test/publisher.test.ts
git commit -m "feat: 持久化并发布 OLED 状态"
```

## Task 8: Compose The Monitor Service

**Files:**
- Create: `vibe-coding-server/src/monitor-service.ts`
- Create: `vibe-coding-server/test/monitor-service.test.ts`
- Modify: `vibe-coding-server/src/index.ts`
- Modify: `vibe-coding-server/.env.example`
- Delete: `vibe-coding-server/src/quota-monitor.ts`
- Delete: `vibe-coding-server/test/quota-monitor.test.ts`
- Modify: `vibe-coding-server/test/quota.test.ts`

- [ ] **Step 1: Write failing service orchestration tests**

Use fakes for watcher, inbox, resolver, cache, and publisher. Prove:

- Cached state publishes first with stale account.
- No-cache startup publishes nothing until an email resolves.
- Session `"metadata"` events call `setSource()` without selecting a thread.
- A hook event received before metadata is retained but not published until its source is known.
- Hook `WAIT` publishes within the same event loop turn.
- Token events update quota and CTX without probing quota again.
- Account resolution republishes the same thread with a verified email.
- Duplicate display states are not republished.
- Graceful stop publishes `offline` and stops all timers/watchers.

- [ ] **Step 2: Run and verify failure**

```powershell
node --import tsx --test test/monitor-service.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `MonitorService`**

Constructor dependencies:

```ts
type MonitorServiceOptions = {
  sessionWatcher: SessionWatcherLike;
  hookInbox: HookInboxLike;
  aggregator: ThreadAggregator;
  accountResolver: AccountResolverLike;
  loadCache: () => Promise<DisplayState | null>;
  saveCache: (state: DisplayState) => Promise<void>;
  publishState: (state: DisplayState) => Promise<void>;
  publishAvailability: (value: "online" | "offline") => Promise<void>;
};
```

Rules:

- Apply every normalized event to the aggregator.
- Route each session watcher `"metadata"` event to `aggregator.setSource(threadId, source)` without changing event recency.
- Keep source-less hook state in the aggregator, but do not publish it until matching session metadata identifies Desktop or CLI.
- Build state only when a non-empty current email exists.
- On thread switch, carry the last email with `accountStale: true` until matched.
- Serialize publish/cache operations to preserve ordering.
- Compare serialized payloads to suppress exact duplicates.

- [ ] **Step 4: Replace quota-only entry point**

Environment contract:

```text
MQTT_URL=mqtt://127.0.0.1:1883
MQTT_TOPIC_PREFIX=oled/codex
CODEX_SESSIONS_DIR=%USERPROFILE%\.codex\sessions
VIBE_CODING_RUNTIME_DIR=%LOCALAPPDATA%\VibeCoding\runtime
CODEX_DESKTOP_COMMAND=
CODEX_CLI_COMMAND=
```

Derived topics:

```ts
const stateTopic = `${prefix}/state`;
const availabilityTopic = `${prefix}/availability`;
```

Connect MQTT with Last Will before starting producers. Publish `online`, then start the service. On `SIGINT`/`SIGTERM`, stop producers, publish `offline`, and close MQTT.

- [ ] **Step 5: Remove the obsolete quota monitor**

Delete `quota-monitor.ts` and its tests only after `MonitorService` tests pass. Retain reusable rate-limit types/helpers in `quota.ts` or move them into `codex-state.ts`; do not keep two competing publishers.

- [ ] **Step 6: Run all server tests and build**

```powershell
cd vibe-coding-server
npm test
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Run a no-MQTT local probe**

Add or preserve a `--once` diagnostic mode that:

- Calls `SessionWatcher.scanOnce()` without starting its poll timer.
- Selects the latest valid thread event.
- Resolves the matching account.
- Prints one `DisplayState` JSON.
- Does not modify or resume any Codex thread.

Run:

```powershell
npm run dev -- --once
```

Expected: one state with non-empty `email`, valid `status`, and source `desktop` or `cli`.

- [ ] **Step 8: Commit**

```powershell
git add vibe-coding-server
git commit -m "feat: 接入 Codex OLED 状态监控服务"
```

## Task 9: Add Firmware State Parsing And Availability Logic

**Files:**
- Create: `vibe-coding-firmware/include/codex_state.h`
- Create: `vibe-coding-firmware/src/codex_state.cpp`
- Create: `vibe-coding-firmware/test/test_codex_state/test_main.cpp`
- Modify: `vibe-coding-firmware/platformio.ini`

- [ ] **Step 1: Add a native test environment**

Add:

```ini
[env:native]
platform = native
test_build_src = true
build_src_filter =
  +<codex_state.cpp>
lib_deps =
  bblanchon/ArduinoJson
```

Keep the existing ESP32 environment unchanged.

- [ ] **Step 2: Write failing parser tests**

Tests must cover:

- A complete state payload.
- Missing CTX becomes `-1`.
- Percentages clamp to `0-100`.
- Blank email rejects the payload.
- Unknown status rejects the payload.
- `mqttConnected == false -> OFFLINE`.
- availability offline overrides state.
- valid online state returns its Codex status.

State API:

```cpp
enum class CodexStatus {
    Idle,
    Working,
    Wait,
    Error,
    Offline,
};

struct CodexDisplayState {
    CodexStatus status;
    int fiveHourRemaining;
    int weeklyRemaining;
    int contextUsedPercent;
    bool accountStale;
    char email[64];
};
```

- [ ] **Step 3: Run and verify failure**

```powershell
cd vibe-coding-firmware
pio test -e native
```

Expected: FAIL because parser functions are absent.

- [ ] **Step 4: Implement pure parsing and effective status**

Expose:

```cpp
bool parseCodexState(const uint8_t *payload, size_t length, CodexDisplayState &state);
CodexStatus effectiveStatus(
    bool mqttConnected,
    bool serverOnline,
    bool hasValidState,
    CodexStatus payloadStatus
);
const char *statusText(CodexStatus status);
```

Use ArduinoJson structured access. Do not allocate or render OLED content in this module.

- [ ] **Step 5: Run native tests**

```powershell
pio test -e native
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add vibe-coding-firmware/include/codex_state.h vibe-coding-firmware/src/codex_state.cpp vibe-coding-firmware/test/test_codex_state/test_main.cpp vibe-coding-firmware/platformio.ini
git commit -m "feat: 解析 OLED 状态消息"
```

## Task 10: Render Status, CTX, Stale Account, And Offline

**Files:**
- Modify: `vibe-coding-firmware/src/main.cpp`
- Modify: `vibe-coding-firmware/scripts/load_env.py`
- Modify: `vibe-coding-firmware/.env.example`

- [ ] **Step 1: Change firmware configuration tests manually through the generator**

Update required keys to:

```py
REQUIRED_KEYS = ("WIFI_SSID", "WIFI_PASSWORD", "MQTT_SERVER", "MQTT_TOPIC_PREFIX")
```

Generate:

```cpp
static const char MQTT_STATE_TOPIC_VALUE[] = "oled/codex/state";
static const char MQTT_AVAILABILITY_TOPIC_VALUE[] = "oled/codex/availability";
```

Run the generator through PlatformIO with shell overrides so the user's real `.env` is not edited:

```powershell
$env:WIFI_SSID="test"
$env:WIFI_PASSWORD="test-password"
$env:MQTT_SERVER="127.0.0.1"
$env:MQTT_TOPIC_PREFIX="oled/codex"
pio run -e esp32-s3-devkitm-1
Remove-Item Env:WIFI_SSID,Env:WIFI_PASSWORD,Env:MQTT_SERVER,Env:MQTT_TOPIC_PREFIX
```

Verify both exact macros appear in `include/generated_config.h`.

- [ ] **Step 2: Replace quota-only callback dispatch**

In `handleMqttMessage`:

```cpp
if (strcmp(topic, MQTT_STATE_TOPIC_VALUE) == 0) {
    handleStatePayload(payload, length);
    return;
}

if (strcmp(topic, MQTT_AVAILABILITY_TOPIC_VALUE) == 0) {
    handleAvailabilityPayload(payload, length);
}
```

Subscribe to both full topics. Do not use wildcard dispatch in V1.

- [ ] **Step 3: Implement the fixed 128x64 layout**

Use text size 1 and stable coordinates:

```text
y=0   email and stale marker
y=13  labels: 5H / WK / CTX
y=24  percentages
y=35  four-cell bars
y=50  divider
y=54  status footer
```

Reserve the rightmost 6 pixels of the header for `*`. Shorten the email to fit the remaining width. Render all five statuses via `statusText()`.

- [ ] **Step 4: Implement non-blocking blink and offline logic**

In `loop()`:

- Continue calling `mqttClient.loop()`.
- Every 500 ms toggle `blinkVisible` only for `WAIT` and `ERROR`.
- Redraw the footer when blink visibility changes.
- Set server availability from exact payloads `online` and `offline`.
- Derive `OFFLINE` when Wi-Fi/MQTT disconnects or availability is offline.
- Do not mark an old `IDLE` state offline based on elapsed time.

- [ ] **Step 5: Verify payload buffer margin**

Set the state buffer explicitly:

```cpp
mqttClient.setBufferSize(512);
```

In the server payload test, assert serialized UTF-8 length is below 400 bytes, leaving MQTT topic/header margin inside the 512-byte PubSubClient packet buffer.

- [ ] **Step 6: Build firmware**

```powershell
cd vibe-coding-firmware
pio test -e native
pio run -e esp32-s3-devkitm-1
```

Expected: tests PASS and firmware builds.

- [ ] **Step 7: Commit**

```powershell
git add vibe-coding-firmware
git commit -m "feat: 显示 Codex 实时状态和上下文"
```

## Task 11: Update Operator Documentation

**Files:**
- Modify: `vibe-coding-server/README.md`
- Modify: `plugins/codex-oled-monitor/README.md`
- Modify: `vibe-coding-firmware/.env.example`
- Modify: `vibe-coding-server/.env.example`

- [ ] **Step 1: Document installation in execution order**

Server README must include:

1. Build server.
2. Install/enable the local hook plugin.
3. Restart Codex Desktop/CLI so hooks are loaded.
4. Configure MQTT prefix.
5. Start server under the interactive user account.
6. Configure/build firmware.

State explicitly that a Windows system service running as `LocalSystem` cannot be assumed to share the interactive user's Codex authentication. Prefer a login-triggered scheduled task unless a service account is deliberately configured and tested.

- [ ] **Step 2: Document diagnostic commands**

Include:

```powershell
npm run dev -- --once
mosquitto_sub -h 127.0.0.1 -t "oled/codex/#" -v
```

Document expected `state`, `availability`, stale `*`, and all status meanings.

- [ ] **Step 3: Verify examples against actual config names**

Search:

```powershell
rg -n "MQTT_TOPIC|MQTT_TOPIC_PREFIX|oled/codex/quota|oled/codex/state|availability" .
```

Expected: no active instructions use the removed single quota topic, except migration/history text in the spec.

- [ ] **Step 4: Commit**

```powershell
git add vibe-coding-server/README.md vibe-coding-server/.env.example vibe-coding-firmware/.env.example plugins/codex-oled-monitor/README.md
git commit -m "docs: 补充 OLED 状态监控部署说明"
```

## Task 12: End-To-End Verification

**Files:**
- Modify only files required by failures discovered during verification.

- [ ] **Step 1: Run the complete automated suite**

```powershell
cd vibe-coding-server
npm test
npm run build

cd ..\vibe-coding-firmware
pio test -e native
pio run -e esp32-s3-devkitm-1

cd ..
node --test plugins/codex-oled-monitor/test/write-runtime-event.test.mjs
```

Expected: all commands PASS.

- [ ] **Step 2: Verify Desktop lifecycle**

Start the server and subscribe to MQTT. In Codex Desktop:

1. Submit a prompt: state becomes `WORKING`.
2. Trigger an approval request: state becomes `WAIT`.
3. Approve it and confirm the next token event restores `WORKING`.
4. Let the turn finish: state becomes `IDLE`.
5. Confirm `contextUsedPercent` changes while the turn is active.

Record timestamps; each hook-driven transition must arrive within 1 second.

- [ ] **Step 3: Verify CLI takeover**

Start a CLI turn after the Desktop turn. Confirm:

- `source` becomes `cli`.
- CLI thread becomes current on its first valid event.
- Status, quota, and CTX switch together.
- Desktop's older `WAIT` or `ERROR` cannot override it.

- [ ] **Step 4: Verify account switching**

Switch the selected surface to another ChatGPT account:

- The existing email remains visible.
- `accountStale` becomes `true`.
- OLED shows `*`.
- The new email replaces the old email only after quota matching.
- `accountStale` returns to `false`.

- [ ] **Step 5: Verify offline behavior**

Force-kill the server process without graceful shutdown.

Expected:

- Broker publishes retained `offline` through Last Will.
- ESP32 displays `OFFLINE`.
- Restart publishes `online` and restores the cached state with stale account until revalidated.

- [ ] **Step 6: Verify the physical OLED**

Upload firmware and inspect:

- No text overlap at 128x64.
- Long email plus `*` fits.
- All percentages and bars align.
- `WAIT` and `ERROR` blink every 500 ms without MQTT disconnects.
- `WORKING` and `IDLE` remain steady.

Capture one photo for `WORKING`, `WAIT`, and `IDLE`.

- [ ] **Step 7: Review final diff**

```powershell
git status --short
git diff --check
git log --oneline --max-count=15
```

Expected:

- No unrelated files.
- No whitespace errors.
- Each task is represented by a focused Chinese commit.

- [ ] **Step 8: Commit verification-only fixes**

If verification required changes:

```powershell
git add -u -- vibe-coding-server vibe-coding-firmware plugins docs
git commit -m "fix: 修正 OLED 状态监控集成问题"
```

If no files changed, do not create an empty commit.
