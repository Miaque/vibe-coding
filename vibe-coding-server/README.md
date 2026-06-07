# Codex OLED 状态 MQTT

从本机 Codex session、hook inbox 和 `codex app-server` 读取线程状态、上下文用量、
账号和配额，并通过 MQTT retained 消息发布给 ESP32 OLED。

## 环境要求

- Node.js 20 或更高版本
- 已登录的 Codex Desktop 或 Codex CLI
- 当前机器可以访问的 MQTT broker
- 构建固件时可用的 PlatformIO

## 安装与运行

以下命令假定当前目录是仓库根目录。

### 1. 构建服务端

```powershell
Set-Location .\vibe-coding-server
npm install
npm run build
Set-Location ..
```

### 2. 安装并启用本地 hook 插件

仓库根目录的 `.agents/plugins/marketplace.json` 定义了名为 `vibe-coding` 的
marketplace，插件位于 `plugins/codex-oled-monitor`。

```powershell
codex plugin marketplace add .
codex plugin list --marketplace vibe-coding
codex plugin add codex-oled-monitor@vibe-coding
codex plugin list --json
```

安装、启用和 runtime inbox 验证详见
[`plugins/codex-oled-monitor/README.md`](../plugins/codex-oled-monitor/README.md)。

### 3. 重启 Codex Desktop 或 CLI

完全退出并重新启动 Codex Desktop；对 CLI 则结束当前进程并启动新会话。Codex 只会在
新进程中加载刚安装或刚修改的 hooks。

### 4. 配置 MQTT topic 前缀

```powershell
Set-Location .\vibe-coding-server
Copy-Item .env.example .env
```

编辑 `.env`，至少确认 `MQTT_URL` 和 `MQTT_TOPIC_PREFIX`。服务端发布：

- `<prefix>/state`：JSON，QoS 1，retained。
- `<prefix>/availability`：`online` 或 `offline`，QoS 1，retained；MQTT Last Will
  也会向该 topic 发布 `offline`。

不要配置旧变量 `MQTT_TOPIC`，也不要订阅旧的 `oled/codex/quota` 单 topic。

服务端支持的环境变量如下：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MQTT_URL` | `mqtt://127.0.0.1:1883` | MQTT broker 地址 |
| `MQTT_TOPIC_PREFIX` | `oled/codex` | MQTT topic 前缀 |
| `CODEX_SESSIONS_DIR` | `%USERPROFILE%\.codex\sessions` | Codex session JSONL 根目录 |
| `VIBE_CODING_RUNTIME_DIR` | `%LOCALAPPDATA%\VibeCoding\runtime` | hook inbox 和状态缓存根目录 |
| `CODEX_DESKTOP_COMMAND` | 自动发现 | Codex Desktop 使用的 `codex` 可执行文件 |
| `CODEX_CLI_COMMAND` | `codex` 或 Windows PATH 解析 | Codex CLI 使用的 `codex` 可执行文件 |
| `MQTT_USER` | 未设置 | 可选 MQTT 用户名 |
| `MQTT_PASSWORD` | 未设置 | 可选 MQTT 密码 |

PowerShell 中已设置的环境变量优先于 `.env`。如果覆盖
`VIBE_CODING_RUNTIME_DIR`，必须让 Codex Desktop/CLI 的 hook 和服务端看到同一个值，
两者才能使用同一个 `<runtime>/inbox`。

### 5. 使用交互用户账号启动服务端

```powershell
npm start
```

服务端必须运行在能够访问当前 Codex 登录、session 目录和 runtime inbox 的交互用户
账号下。Windows `LocalSystem` 系统服务不能假定共享交互用户的 Codex
登录、auth 或 session；Windows 开机自启优先使用该登录用户触发的计划任务。只有在
服务账号已单独配置 Codex 登录、目录权限、环境变量，并完成实际验证时，才应改用系统
服务。

### 6. 配置并构建固件

保持服务端运行，在另一个 PowerShell 中从仓库根目录执行：

```powershell
Set-Location .\vibe-coding-firmware
Copy-Item .env.example .env
# 编辑 .env，填写 Wi-Fi、MQTT broker，并保持 MQTT_TOPIC_PREFIX 与服务端一致。
pio run
```

固件必填 `WIFI_SSID`、`WIFI_PASSWORD`、`MQTT_SERVER` 和
`MQTT_TOPIC_PREFIX`；`MQTT_PORT` 默认 `1883`，`MQTT_USER`、`MQTT_PASSWORD` 和
`MQTT_CLIENT_ID` 可选。示例值是安全占位符，必须按实际网络填写。

固件订阅 `<prefix>/state` 和 `<prefix>/availability`。需要烧录设备后才能确认实际
Wi-Fi、MQTT、SSD1306 接线和 OLED 显示；仅构建成功不代表实机验证已通过。

## 诊断

先在 `vibe-coding-server` 目录验证本机 Codex 数据读取：

```powershell
npm run dev -- --once
```

成功时输出一条状态 JSON。该命令不连接 MQTT；如果最新 thread 中的 quota 与当前
Codex 账号不匹配，命令会失败并报告不匹配。这是防止把旧账号数据标成当前账号的安全
诊断，不会把不匹配数据作为 stale 成功返回。

运行服务端后，在另一个终端观察默认前缀：

```powershell
mosquitto_sub -h 127.0.0.1 -t "oled/codex/#" -v
```

默认配置下应看到：

- `oled/codex/state` 后跟 JSON 状态。
- `oled/codex/availability online`；服务端异常断开时由 Last Will 发布
  `oled/codex/availability offline`。
- OLED 状态为 `WORKING`、`WAIT`、`IDLE`、`ERROR` 或 `OFFLINE`。
- state JSON 的 `accountStale` 为 `true` 时，OLED 邮箱行显示 `*`。

若修改了 `MQTT_TOPIC_PREFIX`，诊断订阅命令中的 `oled/codex` 也要改为相同前缀。

## OLED 字段

- `status`：服务端状态为 `IDLE`、`WORKING`、`WAIT` 或 `ERROR`；固件在 MQTT、
  availability 或有效 state 不可用时显示 `OFFLINE`。
- `source`：`desktop` 或 `cli`。
- `fiveHourRemaining`：5 小时窗口的剩余额度百分比。
- `weeklyRemaining`：每周窗口的剩余额度百分比。
- `contextUsedPercent`：最近一次 token 用量占模型上下文窗口的百分比。
- `contextTokens`：最近一次 `token_count` 的 `total_tokens`。
- `modelContextWindow`：模型上下文窗口。
- `email`：ChatGPT 账号邮箱。
- `accountStale`：为 `true` 时表示账号信息来自缓存或尚未重新验证，OLED 显示 `*`。
