# Codex OLED 状态监控 Spec

## 1. 结论

方案可行，但原方案需要调整。

V1 推荐使用：

- Codex lifecycle hooks 提供低延迟状态信号。
- Codex session JSONL 提供线程、turn、实时 token usage 和额度事实。
- 按线程来源选择对应 Codex runtime，通过 `account/read` 解析邮箱。
- `vibe-coding-server` 聚合最近活跃线程的完整状态，并发布一条原子 MQTT 快照。
- ESP32 只解析稳定的显示契约，不理解 Codex hook 或 transcript 格式。

V1 的完整支持目标是 Windows 上的 Codex Desktop 和 Codex CLI。Ubuntu CLI 保留兼容支持，但不包含 Desktop runtime 路由。

## 2. 最终目标

OLED 必须快速回答：

1. 最近活跃的 Codex 线程正在做什么？
2. 该线程使用哪个账号？
3. 该账号的 5 小时额度还剩多少？
4. 该账号的周额度还剩多少？
5. 该线程当前上下文窗口使用了多少？

状态必须明确显示：

```text
WORKING
WAIT
IDLE
ERROR
OFFLINE
```

其中 `WORKING`、`WAIT`、`IDLE` 是最重要的用户可见结果。

## 3. 已验证事实

本设计基于本机 Codex `0.137.0-alpha.4` 的实际协议和 session 数据验证。

### 3.1 App-server 能力

当前 app-server 协议原生提供：

```text
thread/status/changed
thread/tokenUsage/updated
turn/started
turn/completed
account/rateLimits/updated
```

线程状态包含：

```text
notLoaded
idle
systemError
active
  waitingOnApproval
  waitingOnUserInput
```

但是 Windows 上独立启动的 app-server 虽然能列出 Desktop 和 CLI 历史线程，正在由 Codex Desktop 使用的线程会显示为 `notLoaded`。Windows 当前也不支持 app-server daemon 生命周期，因此独立 app-server 不能作为 Desktop 实时状态主数据源。

### 3.2 Session JSONL 能力

`~/.codex/sessions/**/*.jsonl` 已确认包含：

```text
session_meta
task_started
token_count
task_complete
turn_aborted
```

`token_count` 包含：

```text
last_token_usage
total_token_usage
model_context_window
rate_limits
```

`session_meta` 包含线程来源，可区分：

```text
originator: Codex Desktop
source: vscode

originator: codex-tui
source: cli
```

### 3.3 Hook 能力与限制

当前 hook 输入可包含：

```text
session_id
turn_id
transcript_path
cwd
hook_event_name
model
```

可用事件包括：

```text
UserPromptSubmit
PermissionRequest
PreToolUse
PostToolUse
SessionStart
Stop
```

Hook 适合作为低延迟信号，但不能单独作为完整事实来源：

- `PreToolUse` 和 `PostToolUse` 并不覆盖所有工具。
- 某些后台行为可能产生 `UserPromptSubmit` 而不产生对应 `Stop`。
- session JSONL 的 turn 生命周期事件仍需用于校准。

### 3.4 账号限制

线程、hook 和 `token_count` 都不包含邮箱或可靠的账号 ID。

因此邮箱必须通过线程来源对应的 Codex runtime 执行：

```text
account/read
```

并使用同一 runtime 的 rate-limit 结果与线程最新 `token_count.rate_limits` 做一致性匹配。账号切换期间允许继续显示旧邮箱，但必须标记为 stale。

## 4. 范围

目标硬件：

- ESP32-S3-DevKitM-1
- SSD1306 OLED
- 128x64
- I2C
- 0.96 寸

系统组件：

```text
Codex hooks
  -> 全局 runtime inbox

Codex session JSONL
  -> session watcher

Desktop / CLI app-server
  -> account resolver

vibe-coding-server
  -> active thread aggregator
  -> MQTT publisher

ESP32
  -> MQTT consumer
  -> OLED renderer
```

## 5. 非目标

- 不启动、恢复、fork、修改或接管用户的 Codex session。
- 不依赖独立 app-server 获得 Desktop 实时 thread status。
- 不在 hook 中发送 MQTT、解析 transcript 或等待 server。
- 不要求 ESP32 理解 Codex 内部事件格式。
- 不把 session 累计 token 数当作上下文占用。
- 不在 V1 显示任务标题、模型名称或完整诊断。
- 不保证未来 Codex 内部 JSONL 格式无需适配。

## 6. 推荐架构

### 6.1 Hook runtime inbox

全局 hook 只负责快速写入小型事件文件：

```text
%LOCALAPPDATA%\VibeCoding\runtime\inbox\
```

每个 hook invocation 写一个唯一文件，例如：

```text
<receivedAt>-<sessionId>-<event>-<random>.json
```

使用临时文件写完后原子 rename，避免 server 读取半个 JSON。

事件至少包含：

```json
{
  "receivedAt": 1780760000123,
  "hookEventName": "PermissionRequest",
  "sessionId": "019e...",
  "turnId": "019e...",
  "transcriptPath": "C:\\Users\\...\\rollout-....jsonl",
  "cwd": "H:\\workspace\\...",
  "model": "gpt-5.5"
}
```

Server 成功处理后删除文件。启动时先消费遗留文件。

不使用项目内 `.codex-runtime/events.jsonl`，原因是 V1 监控所有项目和线程，项目本地文件会增加目录扫描、并发追加、轮转和 Git 忽略复杂度。

### 6.2 Session watcher

Server 监听：

```text
%USERPROFILE%\.codex\sessions\**\*.jsonl
```

职责：

- 发现 Desktop 和 CLI 线程。
- 读取 `session_meta` 建立线程来源。
- 增量读取新增行，不重复扫描完整文件。
- 解析 turn 生命周期和 `token_count`。
- 记录每个文件的 offset、identity 和最后事件时间。
- 文件缩短或替换时安全地重新建立 offset。

JSONL 解析必须：

- 忽略未知事件和未知字段。
- 忽略文件末尾尚未写完的一行，等待下次补齐。
- 单个坏行只影响该行，不能终止 watcher。
- 结构变化时输出诊断并保留最后有效状态。

### 6.3 Account resolver

线程来源映射：

| Session 来源 | Runtime |
| --- | --- |
| `Codex Desktop` / `vscode` | Codex Desktop runtime |
| `codex-tui` / `cli` | PATH 中的 Codex CLI runtime |

每个 runtime 独立维护：

```text
email
planType
rateLimits
resolvedAt
stale
```

触发账号解析：

- 当前展示线程切换来源。
- 当前线程出现新的 quota 快照。
- 当前线程状态变化。
- 账号处于 stale 匹配期。
- 每 30 秒兜底刷新。

状态变化必须强制读取对应 runtime 的账号和额度。账号解析器应串行执行探测，避免
同时启动多个 app-server；同一轮等待期间的连续状态变化合并为最新状态。

### 6.4 Active thread aggregator

Server 为每个线程维护：

```text
ThreadState
- threadId
- sessionId
- source
- status
- turnId
- lastEventAt
- contextUsedPercent
- contextTokens
- modelContextWindow
- quotaSnapshot
```

当前展示线程是全局最近发生有效事件的线程。

状态、邮箱、额度和 CTX 始终绑定到同一展示线程。其他线程即使处于 `WAIT` 或 `ERROR`，也不能抢占最近事件线程。

会改变当前展示线程的有效事件仅包括：

```text
UserPromptSubmit
PermissionRequest
Stop
task_started
task_complete
turn_aborted
token_count
明确的 turn failure
```

账号解析完成、MQTT 重连和定时刷新不能改变当前展示线程。

## 7. 状态机

### 7.1 Hook 快速路径

```text
UserPromptSubmit  -> WORKING
PermissionRequest -> WAIT
Stop              -> IDLE
```

收到 hook 后先刷新账号和额度，成功时发布完整快照；最长等待 2 秒，超时后先发布
stale 快照并继续后台刷新。

### 7.2 JSONL 校准路径

```text
task_started  -> WORKING
task_complete -> IDLE
turn_aborted  -> IDLE
明确失败事件   -> ERROR
```

JSONL 校准规则优先于较旧的 hook 事件。事件按 `receivedAt` 或 transcript 时间排序，旧事件不能覆盖新状态。

### 7.3 状态定义

#### WORKING

最近活跃线程正在执行 turn。

#### WAIT

最近活跃线程正在等待审批或用户输入。V1 的低延迟可靠来源是 `PermissionRequest` hook。

#### IDLE

最近活跃线程已结束当前 turn。

#### ERROR

仅用于明确的 turn failure、不可恢复的聚合错误，或当前 state 无法可信构造。普通工具失败不自动把整个 Codex turn 标记为 `ERROR`。

#### OFFLINE

ESP32 与 MQTT 断开，或 server 的 MQTT Last Will 表示服务离线。`OFFLINE` 不由 Codex 状态机发布。

## 8. 上下文计算

`CTX` 在 turn 运行期间随最新 `token_count` 更新，不等待 `Stop`。

计算：

```text
latest token_count 的 last_token_usage.total_tokens / model_context_window * 100
```

禁止使用：

```text
total_token_usage.total_tokens / model_context_window
```

`total_token_usage` 是 session 累计量，可能远超上下文窗口。

显示规则：

- 运行中随最新 `token_count` 更新。
- turn 结束后保留最后值。
- 当前展示线程切换时立即切换到该线程的 CTX。
- 没有可信数据时显示 `--`。

## 9. 账号和额度绑定

### 9.1 额度

非状态更新优先使用当前展示线程最新的：

```text
token_count.rate_limits
```

它与该线程实际请求绑定，比全局轮询更适合多账号切换。

状态变化时必须调用对应 runtime：

```text
account/rateLimits/read
```

### 9.2 邮箱

通过当前线程来源对应 runtime 的：

```text
account/read
```

获得邮箱。

### 9.3 匹配流程

1. 新事件将某线程选为当前展示线程。
2. 状态事件先保存最新 status，暂不发布。
3. 读取对应 runtime 的账号和额度。
4. 比较 runtime rate limits 与线程 quota。
5. 2 秒内完成时，使用本次读取的邮箱和额度，与最新 status、CTX 组成完整快照。
6. 2 秒内失败或超时时，使用最后有效邮箱和额度并设置 `accountStale: true`。
7. 后台刷新完成后再次发布完整快照。
8. 等待期间的连续状态只保留最新状态；线程或来源变化时丢弃旧探测结果。

一致性比较至少使用：

```text
limitId
primary.usedPercent
primary.resetsAt
secondary.usedPercent
secondary.resetsAt
```

允许 account 请求与线程事件存在小幅时间差；实现时应定义受测容差，而不是要求所有字段逐字节相等。

V1 的初始匹配容差：

- `limitId` 必须相同。
- reset 时间必须相同；字段同时缺失视为相同。
- used percent 允许相差 1 个百分点。
- primary 和 secondary 都存在时必须同时匹配。

### 9.4 邮箱持久缓存

Server 将最后一条已发布的有效 state 原子写入：

```text
%LOCALAPPDATA%\VibeCoding\runtime\last-state.json
```

启动行为：

1. 存在缓存时立即恢复邮箱和最后 state，并将 `accountStale` 设为 `true`。
2. 后台重新匹配当前展示线程账号。
3. 首次安装且没有缓存时，在成功读取至少一个邮箱前不发布新的 state。
4. Broker 上已有 retained state 时继续显示旧数据；没有 retained state 时 OLED 显示 `OFFLINE`，直到第一条带邮箱的 state 发布。

任何有效 state payload 的 `email` 都必须是非空字符串。

## 10. MQTT 设计

使用两个 topic：

```text
oled/codex/state
oled/codex/availability
```

### 10.1 State

`oled/codex/state`：

```text
QoS 1
retain: true
```

示例：

```json
{
  "version": 1,
  "threadId": "019e...",
  "sessionId": "019e...",
  "source": "desktop",
  "status": "WAIT",
  "email": "user@example.com",
  "accountStale": false,
  "fiveHourRemaining": 63,
  "weeklyRemaining": 42,
  "contextUsedPercent": 64,
  "contextTokens": 165376,
  "modelContextWindow": 258400,
  "updatedAt": 1780760000
}
```

这是原子显示快照。任何显示字段变化都重新发布完整 payload；状态变化还会先强制
读取当前 Email、5 小时额度和周额度。CTX 继续使用当前线程最近一次
`token_count`。

使用单个 state topic 的原因：

- 展示内容必须全部属于同一线程。
- 活跃线程切换时不能混合旧线程邮箱和新线程状态。
- payload 预计小于 512 字节。
- ESP32 无需实现跨 topic 事务或版本对齐。

### 10.2 Availability

`oled/codex/availability`：

```text
QoS 1
retain: true
payload: online | offline
```

MQTT 连接配置 Last Will：

```text
offline
```

连接成功后发布 retained `online`。正常退出主动发布 `offline`。

ESP32 不使用“状态 15-30 秒未更新”判断离线，因为长时间 `IDLE` 是正常状态。

## 11. ESP32 模型

固件维护：

```text
DisplayState
- latest valid state payload
- availability
- mqttConnected
- blinkVisible
```

状态选择：

```text
MQTT disconnected          -> OFFLINE
availability == offline    -> OFFLINE
valid state payload        -> payload.status
no valid state payload     -> OFFLINE
```

无效 state payload：

- 保留最后有效数值。
- footer 显示 `ERROR`。
- 记录串口诊断。

## 12. OLED 布局

```text
+--------------------------+
| miaque123...gmail.com  * |
+--------------------------+
| 5H      WK      CTX      |
| 63%     42%     64%      |
| ###-    ##--    ###-     |
+--------------------------+
| STATUS              WAIT |
+--------------------------+
```

`*` 表示 `accountStale: true`。

Footer 必须显眼显示：

```text
WORKING
WAIT
IDLE
ERROR
OFFLINE
```

`IDLE`、`WORKING`、`WAIT` 和 `OFFLINE` 静态显示。仅 `ERROR` 每 500 ms
闪烁；闪烁只更新 footer，不改变数据状态。

## 13. 显示规则

### 邮箱

- 邮箱始终显示。
- 长度不超过可见宽度时完整显示。
- 过长时显示前 9 个字符、`...`、后 9 个字符。
- `accountStale` 时在不覆盖邮箱的固定位置显示 `*`。

### 百分比

- 有效范围限制为 `0-100`。
- 缺失或无效显示 `--`。

### 四格进度条

```text
null   ----
0-24   ----
25-49  #---
50-74  ##--
75-99  ###-
100    ####
```

## 14. 刷新策略

### Server

- Hook 状态变化：立即聚合，刷新账号和额度后发布，最长等待 2 秒。
- JSONL lifecycle：立即校准；状态变化使用相同的 2 秒刷新门控。
- `token_count`：实时更新 CTX 和 quota，并按需发布。
- 线程切换：刷新新线程来源对应的账号和额度后发布完整快照。
- 邮箱匹配完成：再次发布，清除 stale。
- 相同快照不重复发布。

### ESP32

- 收到 state 后立即重绘。
- 收到 availability 后立即更新离线状态。
- 仅 `ERROR` 闪烁需要 500 ms 本地计时。
- 不需要每秒完整重绘。

## 15. 失败处理

| 故障 | 行为 |
| --- | --- |
| Hook 写入失败 | JSONL watcher 校准；记录诊断 |
| Hook 漏发 Stop | `task_complete` / `turn_aborted` 校准为 `IDLE` |
| JSONL 暂时未 flush | 保留旧值，等待追加 |
| JSONL 出现未知格式 | 忽略未知字段，保留最后有效状态 |
| Account 暂未切换 | 显示旧邮箱和 `*`，后台重试 |
| Account resolver 失败 | 显示旧邮箱和 `*`，不发布未经验证邮箱 |
| MQTT 断开 | Last Will 使 OLED 显示 `OFFLINE` |
| State JSON 无效 | 保留最后数据，footer 显示 `ERROR` |

## 16. 迁移策略

### 阶段 1：Server 状态聚合

- 增加 hook inbox consumer。
- 增加 session watcher。
- 增加 active thread aggregator。
- 保留现有 quota publisher，先用日志验证状态机。

### 阶段 2：账号路由和原子 state

- 增加 Desktop/CLI runtime resolver。
- 增加账号与 quota 匹配。
- 发布 `oled/codex/state` 和 availability Last Will。

### 阶段 3：Firmware

- 从单 quota payload 改为 state payload。
- 增加 status footer、CTX、stale 标记和 availability。
- 验证 payload 长度和 `PubSubClient` 512 字节 buffer。

### 阶段 4：移除旧 topic

- 新固件稳定后停止发布旧 quota topic。
- 不在 V1 同时维护两套长期数据契约。

## 17. 测试要求

### Server 单元测试

- Hook 到状态映射。
- JSONL lifecycle 校准。
- `last_token_usage` 上下文计算。
- 最近事件线程选择。
- 旧事件不能覆盖新事件。
- Desktop/CLI 来源识别。
- 账号 quota 匹配和容差。
- stale 邮箱过渡。
- state payload 原子构造和去重。

### Server 集成测试

- 增量读取追加中的 JSONL。
- 半行、坏行、未知事件、文件替换。
- 多线程交错事件。
- Desktop 与 CLI runtime account probe。
- 无缓存首次启动和有缓存恢复。
- MQTT retained state 和 Last Will。

### Firmware 测试

- state JSON 解析。
- 缺失字段和非法百分比。
- 邮箱缩写和 stale 标记。
- `WORKING`、`WAIT`、`IDLE`、`ERROR`、`OFFLINE` 渲染。
- 500 ms 闪烁不影响 MQTT loop。
- 最大 payload 不超过实际 buffer。

### 设备验证

- ESP32-S3-DevKitM-1 实机编译、上传和串口观察。
- Desktop 与 CLI 线程交替活动。
- Desktop 或 CLI 切换账号。
- MQTT broker/server 强制断线。
- OLED 拍照确认无重叠和截断。

## 18. 验收标准

- 最近发生有效事件的 Desktop 或 CLI 线程成为当前展示线程。
- 状态和 CTX 始终属于同一线程。
- `UserPromptSubmit -> WORKING`、`PermissionRequest -> WAIT`、`Stop -> IDLE`
  在账号和额度读取成功后更新，最长等待 2 秒后使用 stale 快照降级。
- Hook 漏发时 JSONL lifecycle 能恢复正确状态。
- 运行中的 `CTX` 随最新 `token_count` 更新。
- 上下文只使用 `last_token_usage` 计算。
- 状态变化时额度使用当前 runtime 刷新结果；其他更新优先使用当前线程携带的
  rate limits。
- 邮箱来自当前线程来源对应的 runtime。
- 账号切换期间始终显示邮箱，并以 `*` 标记 stale。
- 未验证的新邮箱不能绑定到当前线程。
- 每条已发布 state 的邮箱字段非空。
- Server 重启后能从 last-state 缓存恢复邮箱并进入 stale 匹配期。
- state payload 中邮箱、额度、CTX 和状态属于同一线程快照。
- 长时间 `IDLE` 不会被误判为 `OFFLINE`。
- MQTT/server 断线后 OLED 显示 `OFFLINE`。
- 仅 `ERROR` 在 OLED 上闪烁。

## 19. 风险

### Codex 内部格式变化

Session JSONL 属于内部持久化格式。解析器必须宽容，并使用 fixture 锁定当前版本行为。

### Hook 事件不完全

Hook 只用于低延迟信号，JSONL lifecycle 必须保留为校准路径。

### 多账号匹配延迟

账号切换时邮箱可能短暂 stale。V1 明确接受继续显示旧邮箱并标记 `*`，但不接受显示无法验证的新邮箱。

### Windows runtime 发现

Desktop 和 CLI runtime 路径可能变化。必须复用和扩展现有 runtime 发现逻辑，并提供显式环境变量覆盖。

## 20. 参考

- Codex app-server protocol：由本机 `codex app-server generate-ts --experimental` 生成并验证。
- Codex hooks schema：
  <https://github.com/openai/codex/blob/main/codex-rs/hooks/src/schema.rs>
- Codex hooks feature：
  <https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs>
- Hook 覆盖不完整问题：
  <https://github.com/openai/codex/issues/20204>
- `UserPromptSubmit` 无对应 `Stop` 的已报告场景：
  <https://github.com/openai/codex/issues/18541>
