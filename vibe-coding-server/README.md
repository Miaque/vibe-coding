# Codex Quota MQTT

Reads ChatGPT Codex quota from the local `codex app-server` process and publishes
a compact retained MQTT message for an ESP32 display.

## Requirements

- Node.js 20 or newer
- A logged-in Codex CLI installation
- An MQTT broker reachable from this machine

## Install

```powershell
npm install
```

Verify the local Codex integration without MQTT:

```powershell
npm run start -- --once
```

Example output:

```json
{"limitId":"codex","email":"user@example.com","planType":"plus","fiveHourRemaining":92,"fiveHourResetAt":1780331108,"weeklyRemaining":99,"weeklyResetAt":1780917908,"syncedAt":1780317000,"stale":false}
```

## Run With MQTT

Create `.env` from the example file, edit it for your broker, and start the
monitor:

```powershell
Copy-Item .env.example .env
# Edit .env if your MQTT broker is not mqtt://127.0.0.1:1883
npm start
```

Variables already set in PowerShell take precedence over values in `.env`.

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MQTT_USER` | unset | MQTT username |
| `MQTT_PASSWORD` | unset | MQTT password |
| `POLL_INTERVAL_MS` | `30000` | Fallback polling interval |
| `CODEX_APP_SERVER_COMMAND` | Codex Desktop runtime on Windows, otherwise `codex` | Explicit `codex` executable to run with `app-server` |

The monitor publishes immediately after startup, on
`account/rateLimits/updated` notifications, and after each fallback poll. MQTT
messages use QoS 1 and `retain: true`. If a later poll fails, the last successful
payload is retained with `"stale":true`. Before publishing fresh quota data, the
monitor reads the active account again so account switches do not require a
server restart. On Windows, the monitor prefers the Codex Desktop runtime under
`%LOCALAPPDATA%\OpenAI\Codex\bin` so it tracks the account selected in the app
instead of a separate globally installed Codex CLI. Each fallback poll restarts
the `app-server` child process so account changes are picked up even when a
long-running child process has cached its previous authentication state.

## OLED Mapping

- `fiveHourRemaining`: remaining percentage for the 5-hour window
- `weeklyRemaining`: remaining percentage for the weekly window
- `fiveHourResetAt` and `weeklyResetAt`: Unix timestamps in seconds
- `email`: ChatGPT account email, or `null` for non-ChatGPT authentication
- `planType`: ChatGPT plan type
- `stale`: show `STALE` when `true`
