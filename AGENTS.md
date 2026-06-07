# 项目协作指南

## 适用范围

本文件适用于整个仓库。进入子目录工作时，还必须遵循该目录内更具体的
`AGENTS.md`；子目录规则优先于本文件。

## 项目结构

- `vibe-coding-server/`：Node.js + TypeScript 服务，从 `codex app-server`
  读取账号和配额，并通过 MQTT 发布状态。
- `vibe-coding-firmware/`：PlatformIO + Arduino 固件，运行在
  `esp32-s3-devkitm-1`，订阅 MQTT 并在 SSD1306 OLED 上显示状态。
- `docs/spec/`：行为、协议和架构规格。
- `docs/plans/`：按日期组织的实施计划。

不要编辑或提交 `node_modules/`、`dist/`、`.pio/`、`.history/`、`.env`
以及固件生成的 `include/generated_config.h`。

## 跨模块约束

MQTT payload 是服务端与固件之间的公共契约。修改字段名、类型、空值语义、
topic、QoS、retain 或离线行为时，必须同步检查：

- 服务端类型、组装逻辑和测试；
- 固件 JSON 解析、状态模型和显示逻辑；
- `docs/spec/` 中的协议说明；
- 两个模块各自的 README 或 `.env.example`。

保持改动最小。不要借功能修改顺手重构另一模块，也不要为尚未出现的需求增加
抽象或配置项。

## 工作流程

1. 先阅读目标目录的 `AGENTS.md`、相关源码和测试。
2. 行为变更先补充能复现或描述预期的测试，再修改实现。
3. 从对应模块目录运行验证命令；根目录没有统一构建命令。
4. 只报告实际执行过的验证，不把未进行的设备测试写成已通过。

最低验证要求：

- 服务端改动：在 `vibe-coding-server/` 运行 `npm test`。
- 固件改动：在 `vibe-coding-firmware/` 运行 `pio run`。
- 只改文档：检查链接、路径、命令和术语与当前源码一致。
- 修改跨端契约：同时执行服务端测试和固件构建。

## Git 与安全

沿用仓库现有中文 Conventional Commits 风格，例如
`feat: 增加状态发布`、`fix: 修正离线显示`、`docs: 更新部署说明`。
不要覆盖或回退与当前任务无关的工作区改动。

任何日志、测试夹具、文档或示例中都不得写入真实 Wi-Fi、MQTT 或账号凭据。
新增环境变量时同步更新对应 `.env.example`，仅提供安全的占位值或默认值。
