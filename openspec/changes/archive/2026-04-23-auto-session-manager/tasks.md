## 1. Auto Session Manager 基础结构

- [x] 1.1 梳理 `/models/session` 请求所需的共享依赖与现有状态落点，确定 Auto Session Manager 的文件位置与对外接口。
- [x] 1.2 实现 Auto Session Manager 的基础结构，包含缓存的 `session_token`、`available_models`、过期信息与统一读取接口。
- [x] 1.3 为 Auto Session Manager 增加 `/models/session` 刷新逻辑，并确保单次刷新同时更新 token 与模型列表。
- [x] 1.4 为 Auto Session Manager 设计简洁的 `info` 级 `consola` 日志文案，覆盖模型 hit/miss 与 token refreshed，并与仓库现有日志模式和颜色保持一致。

## 2. 启动预热与按需刷新

- [x] 2.1 在服务启动流程中接入 Auto Session Manager 的一次性预热初始化。
- [x] 2.2 实现“调用方取 token 时按需刷新”的过期判定与缺失缓存补齐逻辑。
- [x] 2.3 处理预热失败或刷新失败时的回退行为，保证未依赖 Auto session 的请求仍可按旧路径继续执行。

## 3. 三条 LLM 调用链接入

- [x] 3.1 在 messages 调用链接入“模型命中 `available_models` 时才附加 `Copilot-Session-Token`”的统一逻辑。
- [x] 3.2 在 chat completions 调用链接入同样的统一逻辑，并确认未命中模型时行为不变。
- [x] 3.3 在 responses 调用链接入同样的统一逻辑，并确认未命中模型时行为不变。
- [x] 3.4 在统一接入点补上模型命中/未命中与 token 刷新相关的 `info` 级 `consola` 日志，并确认日志输出保持简洁。

## 4. 测试与验证

- [x] 4.1 为 Auto Session Manager 补充单元或集成测试，覆盖启动预热成功、预热失败、缓存命中、按需刷新与缺失缓存补齐。
- [x] 4.2 为三条调用链补充测试，覆盖命中模型附加 token 与未命中模型保持旧行为两类分支。
- [x] 4.3 为关键日志路径补充验证，确认 hit/miss/refreshed 事件按 `info` 级输出，且不偏离现有 `consola` 样式。
- [x] 4.4 运行项目约定的验证命令，确认本次改动未破坏现有主链路与相关运行时约束。
