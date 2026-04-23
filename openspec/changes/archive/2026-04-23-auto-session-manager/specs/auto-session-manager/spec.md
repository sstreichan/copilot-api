## ADDED Requirements

### Requirement: 运行时必须维护 Auto session 的共享缓存
系统 MUST 提供一个共享的 Auto Session Manager，用于维护 `/models/session` 返回的当前 `session_token` 与 `available_models` 快照，并向运行时调用方暴露统一读取接口。

#### Scenario: 服务启动时预热 Auto session 缓存
- **WHEN** 服务启动并初始化共享运行时状态
- **THEN** 系统尝试调用 `/models/session` 获取初始 `session_token` 与 `available_models`
- **AND** 成功结果被写入共享缓存供后续请求复用

#### Scenario: 启动预热失败不阻断原有主链路
- **WHEN** 服务启动阶段的 `/models/session` 预热请求失败
- **THEN** 系统不会因为 Auto Session Manager 初始化失败而阻止服务继续启动
- **AND** 运行时仍可按既有路径处理未依赖 Auto session 的请求

### Requirement: Auto Session Manager 必须按需刷新过期状态
系统 MUST 在调用方请求当前 Auto session token 时检查缓存状态，并在 token 缺失、已过期或不可用时刷新 `/models/session` 缓存；刷新时 MUST 同步更新 `available_models`。

#### Scenario: 调用方读取有效 token 时复用缓存
- **WHEN** 调用方请求当前 Auto session token 且缓存中的 token 仍然有效
- **THEN** 系统直接返回当前缓存 token
- **AND** 不额外发起新的 `/models/session` 请求

#### Scenario: 调用方读取过期 token 时触发刷新
- **WHEN** 调用方请求当前 Auto session token 且缓存中的 token 已过期或不可用
- **THEN** 系统重新调用 `/models/session` 获取新的 `session_token`
- **AND** 系统使用同一次刷新结果同步更新 `available_models`

#### Scenario: 首次按需读取时补齐缺失缓存
- **WHEN** 调用方请求当前 Auto session token 且缓存尚未建立
- **THEN** 系统调用 `/models/session` 建立新的缓存快照
- **AND** 在成功后返回新的 token 给调用方

### Requirement: 只有命中 Auto 可用模型的请求才能附带 Auto session token
系统 MUST 仅在传入模型命中当前缓存的 `available_models` 时，才向实际上游请求附加 `Copilot-Session-Token`；未命中模型 MUST 保持原有请求行为不变。

#### Scenario: 受覆盖模型请求附带 Auto session token
- **WHEN** 某条 LLM API 调用链收到的传入模型存在于当前 `available_models` 缓存中
- **THEN** 系统向 Auto Session Manager 请求当前有效 token
- **AND** 将该 token 作为 `Copilot-Session-Token` 附加到对应的上游请求

#### Scenario: 未覆盖模型请求不触发 Auto session 注入
- **WHEN** 某条 LLM API 调用链收到的传入模型不存在于当前 `available_models` 缓存中
- **THEN** 系统不会因为该请求去附加 `Copilot-Session-Token`
- **AND** 该请求继续按现有路径执行而不改变既有行为

### Requirement: 三条现有 LLM API 调用链必须以一致方式接入 Auto Session Manager
系统 MUST 使三条现有 LLM API 调用链遵循同一套 Auto session 注入规则：命中模型则取 token 并附加，未命中则不改变现有行为。

#### Scenario: messages 链路遵循统一注入规则
- **WHEN** messages 调用链处理上游请求
- **THEN** 它对 Auto session 的使用规则与其他两条调用链一致
- **AND** 不得出现只在 messages 链路额外刷新或额外注入的偏差行为

#### Scenario: chat completions 链路遵循统一注入规则
- **WHEN** chat completions 调用链处理上游请求
- **THEN** 它对 Auto session 的使用规则与其他两条调用链一致
- **AND** 不得出现只在该链路忽略模型覆盖判断的偏差行为

#### Scenario: responses 链路遵循统一注入规则
- **WHEN** responses 调用链处理上游请求
- **THEN** 它对 Auto session 的使用规则与其他两条调用链一致
- **AND** 不得出现只在该链路绕过 Auto Session Manager 的偏差行为

### Requirement: Auto Session Manager 必须输出简洁且一致的运行时日志
系统 MUST 为 Auto Session Manager 的关键事件输出简洁短日志，并使用仓库现有的 `consola` 模式以 `info` 级记录模型命中、模型未命中与 token 刷新事件。

#### Scenario: 命中可用模型时记录 hit 日志
- **WHEN** 某条调用链收到的模型命中当前 `available_models`
- **THEN** 系统输出一条简洁的 `info` 级 `consola` 日志表明该模型命中 Auto 可用集合
- **AND** 该日志样式与仓库现有日志模式保持一致

#### Scenario: 未命中可用模型时记录 miss 日志
- **WHEN** 某条调用链收到的模型未命中当前 `available_models`
- **THEN** 系统输出一条简洁的 `info` 级 `consola` 日志表明该模型未命中 Auto 可用集合
- **AND** 日志不会扩展成冗长调试输出

#### Scenario: 刷新 token 时记录 refreshed 日志
- **WHEN** Auto Session Manager 因过期、缺失或不可用状态而刷新 `/models/session`
- **THEN** 系统输出一条简洁的 `info` 级 `consola` 日志表明 token 已刷新
- **AND** 日志风格与仓库现有颜色和展示模式保持一致
