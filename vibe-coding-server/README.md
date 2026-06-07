# Codex OLED 状态 MQTT

从本机 Codex session、hook inbox 和 `codex app-server` 读取线程状态、上下文用量、
账号和配额，并通过 MQTT retained 消息发布给 ESP32 OLED 显示使用。

## 环境要求

- Node.js 20 或更高版本
- 已登录的 Codex CLI
- 当前机器可以访问的 MQTT broker

## 安装

Windows PowerShell 和 Ubuntu bash 都可以直接安装依赖：

```sh
npm install
```

不连接 MQTT，先验证本机 Codex 集成是否可用：

```sh
npm run dev -- --once
```

输出示例：

```json
{"version":1,"threadId":"thread-1","sessionId":"thread-1","source":"cli","status":"WORKING","email":"user@example.com","accountStale":false,"fiveHourRemaining":92,"weeklyRemaining":99,"contextUsedPercent":25,"contextTokens":64600,"modelContextWindow":258400,"updatedAt":1780317000000}
```

## 通过 MQTT 运行

根据示例创建 `.env`，按你的 broker 配置好后启动监控：

Ubuntu / bash：

```sh
cp .env.example .env
# 如果你的 MQTT broker 不是 mqtt://127.0.0.1:1883，请修改 .env
npm run build
npm start
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
# 如果你的 MQTT broker 不是 mqtt://127.0.0.1:1883，请修改 .env
npm run build
npm start
```

PowerShell 里已经设置过的环境变量会优先于 `.env` 中的值。

可选变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MQTT_URL` | `mqtt://127.0.0.1:1883` | MQTT broker 地址 |
| `MQTT_TOPIC_PREFIX` | `oled/codex` | MQTT topic 前缀，状态发布到 `${prefix}/state`，可用性发布到 `${prefix}/availability` |
| `CODEX_SESSIONS_DIR` | `%USERPROFILE%\.codex\sessions` | Codex session JSONL 根目录 |
| `VIBE_CODING_RUNTIME_DIR` | `%LOCALAPPDATA%\VibeCoding\runtime` | hook inbox 和状态缓存目录 |
| `CODEX_DESKTOP_COMMAND` | 自动发现 | 指定 Codex Desktop 运行时的 `codex` 可执行文件 |
| `CODEX_CLI_COMMAND` | `codex` 或 Windows PATH 解析 | 指定 Codex CLI 的 `codex` 可执行文件 |
| `MQTT_USER` | 未设置 | MQTT 用户名 |
| `MQTT_PASSWORD` | 未设置 | MQTT 密码 |

监控连接 MQTT 时会配置 Last Will，把 `${prefix}/availability` 设为 retained `offline`。
连接成功后先发布 retained `online`，再启动 session watcher 和 hook inbox。状态消息发布到
`${prefix}/state`，使用 QoS 1 和 `retain: true`。如果有缓存状态，启动时会先发布
`accountStale: true` 的缓存状态；新的 session/hook/token 事件到达后才发布实时状态。
账号解析失败或线程切换时会沿用上一次邮箱，并把 `accountStale` 标记为 `true`。

在 Ubuntu 上，服务会直接运行 `codex app-server`，因此需要先安装并登录 Codex CLI，并确保
`codex` 在当前 shell 的 `PATH` 中。如果 `codex` 不在 `PATH`，可以用
`CODEX_CLI_COMMAND=/path/to/codex npm start` 显式指定。Windows 上 Desktop 来源会优先使用
`%LOCALAPPDATA%\OpenAI\Codex\bin` 下的 Codex Desktop 运行时，也可以通过
`CODEX_DESKTOP_COMMAND` 覆盖。

## OLED 字段映射

- `status`：`IDLE`、`WORKING`、`WAIT` 或 `ERROR`
- `source`：`desktop` 或 `cli`
- `fiveHourRemaining`：5 小时窗口的剩余额度百分比
- `weeklyRemaining`：每周窗口的剩余额度百分比
- `contextUsedPercent`：最近一次 token 用量占模型上下文窗口的百分比
- `contextTokens`：最近一次 `token_count` 的 `total_tokens`
- `modelContextWindow`：模型上下文窗口
- `email`：ChatGPT 账号邮箱
- `accountStale`：为 `true` 时显示账号信息来自缓存或尚未重新验证
