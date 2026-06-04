# Codex 配额 MQTT

从本机 `codex app-server` 进程读取 ChatGPT Codex 配额，并发布一条简洁的
MQTT retained 消息，供 ESP32 显示使用。

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
{"limitId":"codex","email":"user@example.com","planType":"plus","fiveHourRemaining":92,"fiveHourResetAt":1780331108,"weeklyRemaining":99,"weeklyResetAt":1780917908,"syncedAt":1780317000,"stale":false}
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
| `MQTT_USER` | 未设置 | MQTT 用户名 |
| `MQTT_PASSWORD` | 未设置 | MQTT 密码 |
| `POLL_INTERVAL_MS` | `30000` | 兜底轮询间隔 |
| `CODEX_APP_SERVER_COMMAND` | Windows 上使用 Codex Desktop 运行时，其他系统使用 `codex` | 指定运行 `app-server` 的 `codex` 可执行文件 |

监控会在启动后立即发布一次，也会在收到 `account/rateLimits/updated` 通知后发布，
并在每次兜底轮询结束后发布。MQTT 消息使用 QoS 1 和 `retain: true`。如果后续轮询失败，
会保留上一次成功的 payload，并把 `"stale"` 标记为 `true`。每次发布新的配额数据前，
监控都会重新读取当前账号，因此切换账号后不需要重启服务。在 Windows 上，监控会优先使用
`%LOCALAPPDATA%\OpenAI\Codex\bin` 下的 Codex Desktop 运行时，这样它跟随的是应用里选中的账号，
而不是另一个全局安装的 Codex CLI。每次兜底轮询都会重启 `app-server` 子进程，即使长时间运行的
子进程缓存了旧的认证状态，也能及时发现账号变化。

在 Ubuntu 上，服务会直接运行 `codex app-server`，因此需要先安装并登录 Codex CLI，并确保
`codex` 在当前 shell 的 `PATH` 中。如果 `codex` 不在 `PATH`，可以用
`CODEX_APP_SERVER_COMMAND=/path/to/codex npm start` 显式指定。

## OLED 字段映射

- `fiveHourRemaining`：5 小时窗口的剩余额度百分比
- `weeklyRemaining`：每周窗口的剩余额度百分比
- `fiveHourResetAt` 和 `weeklyResetAt`：Unix 秒级时间戳
- `email`：ChatGPT 账号邮箱；非 ChatGPT 认证时为 `null`
- `planType`：ChatGPT 套餐类型
- `stale`：为 `true` 时显示 `STALE`
