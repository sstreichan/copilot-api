# Tasks: 研究 Copilot API 契约

## 阶段 1：环境准备

- [ ] **1.1** Clone `microsoft/vscode-copilot-chat` 仓库到本地
  - 验证：`ls src/platform/networking` 目录存在

- [ ] **1.2** 快速浏览目录结构，确认关键文件位置
  - 验证：能列出 5 个核心文件路径

## 阶段 2：请求构建研究

- [ ] **2.1** 分析 `createCapiRequestBody` 函数（Chat Completions）
  - 文件：`src/platform/networking/common/networking.ts`
  - 记录：所有参数字段、类型、默认值
  - 验证：输出请求体 TypeScript 接口定义

- [ ] **2.2** 分析 `createResponsesRequestBody` 函数（Responses API）
  - 文件：`src/platform/endpoint/node/responsesApi.ts`
  - 记录：与 Chat Completions 的差异
  - 验证：输出两种 API 的差异对比表

- [ ] **2.3** 分析 `ChatEndpoint.createRequestBody` API 选择逻辑
  - 文件：`src/platform/endpoint/node/chatEndpoint.ts`
  - 记录：何时使用 Responses API vs Chat Completions
  - 验证：总结选择条件

- [ ] **2.4** 分析端点选择与模型能力映射 *(新增)*
  - 文件：`src/platform/endpoint/common/endpointProvider.ts`
  - 记录：`ModelSupportedEndpoint` 枚举、模型能力判定逻辑
  - 验证：输出端点选择决策树

## 阶段 3：Headers 研究

- [ ] **3.1** 分析 `postRequest` 函数中的 headers 设置
  - 文件：`src/platform/networking/common/networking.ts`
  - 记录：所有 headers 名称、值来源、用途
  - 验证：输出完整 headers 列表

- [ ] **3.2** 分析 `chatMLFetcher.ts` 中的额外 headers
  - 文件：`src/extension/prompt/node/chatMLFetcher.ts`
  - 记录：`X-Initiator`、`Copilot-Vision-Request` 等
  - 验证：补充到 headers 列表

- [ ] **3.3** 分析响应 headers 读取
  - 文件：`src/platform/networking/common/fetch.ts`
  - 记录：`getRequestId` 函数读取哪些 headers
  - 验证：输出响应 headers 列表

- [ ] **3.4** 追踪 Headers 值来源链路 *(新增)*
  - 追踪：`X-Initiator`、`X-Interaction-Id`、`OpenAI-Intent` 等值的来源
  - 记录：值的枚举与设置条件
  - 验证：输出完整的值来源映射表

## 阶段 4：响应处理研究

- [ ] **4.1** 分析 `SSEProcessor` 类（Chat Completions 流）
  - 文件：`src/platform/networking/node/stream.ts`
  - 记录：SSE 事件解析逻辑、chunk 格式
  - 验证：输出 SSE 事件类型列表

- [ ] **4.2** 分析 `OpenAIResponsesProcessor`（Responses API 流）
  - 文件：`src/platform/endpoint/node/responsesApi.ts`
  - 记录：与 SSEProcessor 的差异
  - 验证：对比两种处理器的差异

- [ ] **4.3** 分析 `FinishedCompletion` 和 `ChatCompletion` 类型
  - 记录：完整响应结构
  - 验证：输出 TypeScript 接口定义

- [ ] **4.4** 分析非流式响应结构 *(新增)*
  - 文件：`src/platform/networking/common/openai.ts`
  - 记录：非流式返回的完整结构
  - 验证：对比流式与非流式差异

- [ ] **4.5** 分析错误响应与 retry/backoff *(新增)*
  - 搜索：`429`、`retry-after`、`backoff`
  - 记录：错误响应结构（4xx、5xx）
  - 记录：重试逻辑与 rate-limit headers
  - 验证：输出错误处理决策表

## 阶段 5：特殊功能研究

- [ ] **5.1** 分析 thinking/reasoning 字段处理
  - 搜索：`reasoning_text`、`reasoning_opaque`
  - 记录：请求和响应中如何传递
  - 验证：与我们实现对比

- [ ] **5.2** 分析 tool_calls 处理
  - 记录：请求中的 tools 定义格式
  - 记录：响应中的 tool_calls 结构
  - 验证：与我们实现对比

- [ ] **5.3** 分析 vision 请求处理
  - 搜索：`Copilot-Vision-Request`、`image_url`
  - 记录：图像如何编码和发送
  - 验证：与我们实现对比

## 阶段 6：文档输出

- [ ] **6.1** 创建 `docs/copilot-api-contract.md`
  - 包含：请求结构、响应结构、headers
  - 格式：TypeScript 接口 + 示例

- [ ] **6.2** 更新我们的类型定义（如需要）
  - 对比：`src/services/copilot/create-chat-completions.ts`
  - 记录：发现的差异

- [ ] **6.3** 验证并更新 `docs/anthropic-api-compatibility.md`
  - 确保与 Copilot 实际行为一致

## 依赖关系

```
阶段 1 → 阶段 2, 3, 4 (可并行)
         ↓
      阶段 5
         ↓
      阶段 6
```

## 预估时间

- 阶段 1：10 分钟
- 阶段 2：40 分钟（+1 任务）
- 阶段 3：40 分钟（+1 任务）
- 阶段 4：50 分钟（+2 任务）
- 阶段 5：20 分钟
- 阶段 6：30 分钟
- **总计**：约 3 小时

## 变更记录

- 2026-01-27：基于辩论结果扩大范围，新增 4 项任务（2.4、3.4、4.4、4.5）
