# Proposal: 启用原生 Messages API 端点

## 摘要

新增 CLI flag `--native-messages` (`-M`)，允许用户选择将 Claude 模型的 `/v1/messages` 请求直接透传到 Copilot 后端的 `/v1/messages` 端点，而非通过现有的格式转换流程。

## 动机

根据 `docs/copilot-messages-api-testing.md` 的测试结果，Copilot `/v1/messages` 端点**高度兼容** Anthropic Messages API：

| 问题（现有实现） | /v1/messages 原生 |
|------------------|-------------------|
| `max_tokens` 强制最小 12800 | 支持任意值 |
| `temperature` Responses 路径固定为 1 | 完全支持 |
| `top_k` 不传递 | 居然支持 |
| `stop_sequences` Responses 路径不传 | 完全支持 |
| `thinking: disabled` 类型不支持 | 支持 |
| `tool_choice` 缺少部分变体 | 全部支持 |
| 格式转换开销 | 无需转换 |

**直接透传的优势**：
1. 消除转换代码中的兼容性问题
2. 获得完整的 Anthropic 原生体验
3. 减少延迟（无转换开销）
4. 代码更简洁

## 核心设计

### 分支逻辑

```
handleCompletion():
  if (!state.nativeMessages):
    → 完全走现有逻辑，新代码不运行

  if (state.nativeMessages && !model.startsWith("claude")):
    → 静默 fallback 到现有逻辑，新代码不运行

  if (state.nativeMessages && model.startsWith("claude")):
    → 使用新的 handleWithNativeMessages() 透传到 /v1/messages
```

### 影响范围

- **只影响** `/v1/messages` 路由的后端调用
- **不影响** `/chat/completions`、`/responses`、`/generate-content` 等其他路由
- **现有行为完全保留**：flag 不给时，一切照旧

## 实现方法论

实现阶段应遵循以下研究策略：

1. **读取 `package.json`** 了解项目依赖
2. **使用 context7、deepwiki 或其他 MCP 工具** 搜索这些库的使用方式
3. **借鉴现有代码** 中的模式（如 `create-chat-completions.ts`、`create-responses.ts`）

## 设计原则

- **模块化**：新增独立的 `create-messages.ts` 服务，不修改现有服务
- **SRP**：每个文件/方法只做一件事
- **设计要点**：
  - Single Responsibility: 新服务只负责 `/v1/messages` 调用
  - Open-Closed: 扩展新功能而非修改现有逻辑
  - 配置驱动: 使用 `state` 作为配置源，handler 根据 state 决定行为

## 测试策略

- **只测重要的**，不追求覆盖率
- 需要测试的关键点：
  1. flag 解析和 state 设置
  2. 分支逻辑（flag + model 组合）
  3. 请求透传正确性
  4. 流式响应转发

## 范围

**包含：**
- 新增 CLI flag `--native-messages` (`-M`)
- 新增 `state.nativeMessages` 状态
- 新增 `create-messages.ts` 服务
- 修改 `messages/handler.ts` 添加分支逻辑
- 关键测试

**不包含：**
- 修改其他路由
- 修改现有转换逻辑
- 修改现有服务

## 成功标准

- [ ] `bun run dev -- -M` 可启用原生 Messages API
- [ ] Claude 模型请求正确透传到 `/v1/messages`
- [ ] 非 Claude 模型静默 fallback 到现有逻辑
- [ ] 不给 flag 时行为完全不变
- [ ] 关键测试通过
- [ ] 代码符合 SOLID 原则

## 依赖

- 依赖 `study-copilot-api-contract` 的研究成果（API 契约文档）

## 参考

- 测试报告：`docs/copilot-messages-api-testing.md`
- API 契约：`docs/copilot-api-contract.md`
- 实验代码：`experiments/messages-api-poc/`
