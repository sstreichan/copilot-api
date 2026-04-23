## Why

当前仓库已经通过多轮真实后端实验确认，`/models/session` 能返回与 Auto 路径相关的 `session_token`、`available_models` 与 `discounted_costs` 等信号；但运行时主链路尚未把这些信号沉淀为统一组件，因此三条 LLM API 调用链仍主要按旧路径直接发起请求。现在引入一个最小侵入的 Auto Session Manager，可以在不重写现有主链路的前提下，让受 Auto 覆盖的模型尽可能复用 Auto session，同时保留潜在的 discount / routing 附加收益。

## What Changes

- 新增一个独立的 Auto Session Manager，用于统一管理 `/models/session` 请求、`session_token` 缓存、`available_models` 缓存与过期刷新。
- 在服务启动时初始化 Auto Session Manager，预热一次 `/models/session`，拿到初始 token 与模型列表。
- 为三条现有 LLM API 调用链增加统一接入点：当传入模型命中 Auto Session Manager 当前缓存的 `available_models` 时，向组件获取有效 token 并将其附着到实际上游请求；未命中时保持现有行为不变。
- 将 token 过期检查与刷新时机收敛为“调用方取 token 时按需刷新”，不引入后台定时轮询。
- 在 token 刷新时同步刷新 `available_models`，保证模型覆盖判断与 token 生命周期保持一致。
- 为 Auto Session Manager 增加简洁的运行时日志，在模型命中/未命中 Auto 可用集合以及 token 刷新时输出 `info` 级 `consola` 日志，并沿用仓库现有日志样式与配色模式。
- 为该能力补充相应的运行时约束、边界行为与测试要求，确保其是一个最小侵入、可渐进扩展的基础设施层，而不是完整复制 GitHub 内部 Auto 协议。

## Capabilities

### New Capabilities
- `auto-session-manager`: 为运行时提供统一的 Auto session 管理能力，包括 `/models/session` 状态预热、token/模型列表缓存、按需刷新，以及为受覆盖模型请求附加 Auto session token。

### Modified Capabilities
- 无。

## Impact

- 受影响代码主要位于 `src/lib/`、`src/services/copilot/` 与三条现有 LLM API 调用链对应的创建请求逻辑。
- 受影响的运行时行为包括：启动阶段状态预热、实际上游请求附带 `Copilot-Session-Token` 的条件、以及模型是否命中 Auto 可用集合时的分流判断。
- 受影响的可观测性还包括：新增 Auto Session Manager 的 `info` 级 `consola` 日志，用于记录模型命中/未命中与 token 刷新事件。
- 不引入新的对外公开 API；现有外部端点与未命中 Auto 覆盖模型的请求行为应保持兼容。
- 需要新增或更新测试，以覆盖初始化、过期刷新、模型命中/未命中分支，以及最小侵入接入约束。
