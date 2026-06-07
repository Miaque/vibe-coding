# 服务端协作指南

## 适用范围

本文件适用于 `vibe-coding-server/`。同时继承仓库根目录的规则。

## 技术栈与职责

服务端要求 Node.js 20 或更高版本，使用 TypeScript、ESM、NodeNext 模块解析、
Node 内置测试运行器和 MQTT.js。

- `src/app-server-client.ts`：管理 `codex app-server` 子进程和 JSON-RPC 请求。
- `src/quota.ts`：把上游配额转换为稳定的 MQTT payload。
- `src/monitor-service.ts`：组合 session watcher、hook inbox、账号解析、缓存和 MQTT 发布。
- `src/publisher.ts`：负责 MQTT 序列化与发布选项。
- `src/index.ts`：加载配置并组合运行时依赖。
- `test/`：与模块对应的 `*.test.ts` 测试。

保持这些职责边界。纯数据转换不要依赖进程、网络或定时器；外部依赖通过现有的
构造参数或最小接口替身测试。

## 常用命令

以下命令均从 `vibe-coding-server/` 执行：

- `npm ci`：按 lockfile 安装依赖。
- `npm run dev -- --once`：不连接 MQTT，读取并输出一次本机 Codex 配额。
- `npm run build`：运行 TypeScript 编译。
- `npm test`：先编译，再运行全部 `node:test` 测试。
- `npm start`：运行 `dist/index.js`。

`--once` 依赖本机可用且已登录的 Codex CLI 或 Desktop runtime，不应作为纯单元
测试的前置条件。

## TypeScript 约定

- 保持 `strict` 模式，使用 2 空格缩进和双引号。
- 源码中的相对 ESM 导入保留 `.js` 后缀。
- 仅用于类型的导入使用 `import type`。
- 默认使用具名导出；不要为单一调用点增加通用框架式抽象。
- 源码注释、异常消息、日志文本和测试名称使用中文。
- 代码标识符、协议方法名、字段名、命令以及必须原样透传的第三方错误文本保持
  原文。
- 测试使用 `node:test` 与 `node:assert/strict`，按行为命名并覆盖失败路径。

## 行为约束

- 配额百分比表示“剩余百分比”，并限制在 `0..100`。
- 发布前读取当前账号，账号切换不能要求重启整个服务。
- 刷新失败时可重发最后一次成功数据，但必须标记 `stale: true`。
- MQTT 状态消息保持 JSON、QoS 1 和 `retain: true`，除非规格明确变更。
- 停止或重启 `app-server` 时，必须移除监听器并拒绝未完成请求，避免悬挂 Promise。

修改上述行为时，先更新或新增对应测试；涉及 payload 的改动还要同步固件与规格。

## 配置与安全

运行配置来自环境变量和本地 `.env`。新增变量时同步更新 `.env.example` 和
README。不要提交 `.env`、账号信息、broker 密码、访问令牌、`dist/` 或
`node_modules/`。
