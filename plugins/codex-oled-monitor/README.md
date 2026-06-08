# Codex OLED Monitor Plugin

该插件通过 Codex hooks 把低延迟运行时事件写入本机 runtime inbox，供
`vibe-coding-server` 消费。

## 安装并启用

仓库根目录的 `.agents/plugins/marketplace.json` 声明了 `vibe-coding`
marketplace，并通过相对路径 `./plugins/codex-oled-monitor` 指向本插件。以下命令必须
从仓库根目录执行：

```powershell
codex plugin marketplace add .
codex plugin list --marketplace vibe-coding
codex plugin add codex-oled-monitor@vibe-coding
codex plugin list --json
```

`codex plugin list --marketplace vibe-coding` 应列出可安装的
`codex-oled-monitor`；安装后的 `codex plugin list --json` 应在 `installed` 中列出该
插件。安装会把插件加入 Codex 本地配置并启用其 hooks。

如果本机已经添加同一 marketplace，不需要重复添加。更新本地插件文件后，从仓库根目录
重新安装插件：

```powershell
codex plugin remove codex-oled-monitor@vibe-coding
codex plugin add codex-oled-monitor@vibe-coding
```

随后完全重启 Codex Desktop 或 CLI；已运行的进程不会自动重新加载 hooks。

## Runtime inbox

hook 脚本把事件写入 `<runtime>/inbox`：

- Windows 默认 runtime：`%LOCALAPPDATA%\VibeCoding\runtime`
- 其他系统默认 runtime：`$XDG_STATE_HOME/vibe-coding`；未设置
  `XDG_STATE_HOME` 时为 `~/.local/state/vibe-coding`

因此 Windows 默认 inbox 是
`%LOCALAPPDATA%\VibeCoding\runtime\inbox`。

可用 `VIBE_CODING_RUNTIME_DIR` 覆盖 runtime 根目录。Codex Desktop/CLI 进程和
`vibe-coding-server` 必须使用相同的 `VIBE_CODING_RUNTIME_DIR`，否则 hook 写入和
服务端读取的不是同一个 inbox。

## 验证

1. 完全退出并重新启动 Codex Desktop，或结束当前 Codex CLI 后启动新会话。
2. 在新会话中提交提示、触发权限请求或结束一轮，让 hook 产生事件。
3. 在 PowerShell 检查默认 inbox：

```powershell
Get-ChildItem "$env:LOCALAPPDATA\VibeCoding\runtime\inbox" -Filter *.json
```

如果设置了 `VIBE_CODING_RUNTIME_DIR`，改为检查：

```powershell
Get-ChildItem (Join-Path $env:VIBE_CODING_RUNTIME_DIR "inbox") -Filter *.json
```

看到 JSON 文件表示 hook 已写入事件。运行中的 `vibe-coding-server` 会消费并删除有效
文件，因此目录为空也可能表示事件已被服务端及时处理；需要单独验证 hook 写入时，应先
停止服务端再触发事件。

hook 执行异常会按 JSON Lines 格式追加到 `<runtime>/logs/hook-errors.log`。每条记录
包含异常时间、错误堆栈和原始 hook 输入；日志落盘失败时，诊断信息仍会输出到 stderr。

该流程依赖当前 Codex Desktop/CLI 对本地 marketplace、hooks 和 hook 信任提示的实际
支持。首次启动若出现 hook 信任或授权提示，需要由交互用户确认；仓库内测试不能代替
Desktop/CLI 的外部加载验证。
