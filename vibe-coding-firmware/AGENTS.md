# 固件协作指南

## 适用范围

本文件适用于 `vibe-coding-firmware/`。同时继承仓库根目录的规则。

## 技术栈与目录

这是基于 PlatformIO 和 Arduino 的 ESP32-S3 固件，目标板为
`esp32-s3-devkitm-1`。

- `src/main.cpp`：当前固件入口，以及 Wi-Fi、MQTT、JSON 解析和 OLED 渲染。
- `include/`：项目头文件；`generated_config.h` 由构建脚本生成。
- `lib/`：仅放项目私有库。
- `scripts/load_env.py`：读取 `.env` 并生成编译期配置。
- `test/`：PlatformIO 测试。
- `platformio.ini`：开发板、框架、串口和依赖配置。

## 常用命令

以下命令均从 `vibe-coding-firmware/` 执行：

- `pio run`：构建固件。
- `pio test`：运行已有 PlatformIO 测试。
- `pio run -t upload`：构建并烧录开发板。
- `pio device monitor -b 115200`：打开串口监视器。
- `pio run -t clean`：仅在需要排除缓存问题时清理构建产物。

如果 `pio` 不在 `PATH` 中，先激活 PlatformIO 环境；Windows 常见安装也可用
`& "$HOME\.platformio\penv\Scripts\pio.exe" run` 直接构建。

首次构建前，从 `.env.example` 创建本地 `.env` 并填写必需配置。
不要手工修改或提交 `include/generated_config.h`；如果配置生成有问题，应修改
`.env.example`、`.env` 或 `scripts/load_env.py`。

## 代码约定

- 使用 4 空格缩进，保持现有 Arduino/C++ 风格。
- 函数和变量使用 `camelCase`，常量和宏使用 `UPPER_SNAKE_CASE`。
- 硬件引脚、屏幕尺寸和地址使用含义明确的常量。
- 优先拆分可独立测试的解析和状态转换逻辑，硬件调用留在薄的适配层。
- 避免在主循环新增长时间阻塞；必须阻塞时要说明对重连和 MQTT 保活的影响。
- 固定大小缓冲区必须显式限制写入长度，处理 MQTT payload 时不得假设输入有效。
- 源码注释、错误消息、串口日志和测试名称使用中文。
- 代码标识符、协议字段、命令以及必须原样显示或透传的第三方文本保持原文。

## MQTT 与显示

固件消费的是跨模块公共契约。修改订阅 topic、JSON 字段、默认值、百分比语义、
过期状态或离线显示时，必须同步检查服务端及 `docs/spec/`。对缺失字段和非法
payload 保持明确的降级行为，不要让单条消息导致设备重启。

## 验证要求

- 所有固件源码或依赖改动至少运行 `pio run`。
- 可脱离硬件的逻辑改动应在 `test/` 增加测试并运行 `pio test`。
- 引脚、Wi-Fi、MQTT、时序或 OLED 布局改动还需要烧录设备，通过串口和屏幕验证。
- 报告设备型号、串口输出或实际观察结果；未连接硬件时明确说明未做设备验证。

真实 Wi-Fi 和 MQTT 凭据只能保存在被忽略的 `.env` 或外部环境变量中。
