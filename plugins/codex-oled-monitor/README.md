# Codex OLED Monitor Plugin

该插件通过 Codex hook 把低延迟运行时事件写入本机 runtime inbox，供
`vibe-coding-server` 消费并发布到 OLED 状态主题。

默认写入位置：

- Windows：`%LOCALAPPDATA%\VibeCoding\runtime\inbox`
- 其他系统：`~/.local/state/vibe-coding/inbox`

可用 `VIBE_CODING_RUNTIME_DIR` 覆盖 runtime 根目录。
