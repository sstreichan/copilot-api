# Proposal: 研究 Copilot API 契约

## 摘要

深入研究官方 VSCode Copilot Chat 扩展源代码，了解扩展与 GitHub Copilot 后端之间的精确 API 契约。此研究将指导我们 proxy 翻译逻辑的改进。

## 动机

我们的 proxy 将 Anthropic/Gemini API 格式翻译为 OpenAI 格式发送给 GitHub Copilot。为确保翻译准确，我们需要了解：

1. **请求结构**：发送给 Copilot 后端的确切字段、类型和值
2. **响应结构**：流式 SSE chunks 的结构
3. **Headers**：认证和路由所需的必选和可选 headers
4. **API 变体**：`/chat/completions` 和 `/responses` 端点的差异

## 范围

**包含：**
- Clone 并分析 `microsoft/vscode-copilot-chat` 仓库
- 记录 Chat Completions API 的请求体构建
- 记录 Responses API 的请求体构建
- 记录所有 headers（请求和响应）及**值来源链路**
- 记录 SSE 流解析逻辑
- **记录端点选择与模型能力映射逻辑**
- **记录非流式响应结构**
- **记录错误响应与 retry/backoff 行为**
- 为我们的 proxy 创建参考文档

**不包含：**
- BYOK（自带密钥）流程（Anthropic、Azure 等）
- VSCode 扩展 UI/UX 代码（仅限 headers 值来源相关的最短路径追踪）
- 认证流程（我们有自己的实现）
- MCP 服务器集成代码
- Tool schema 来源链路（工作量大，优先级中）

## 研究目标

### 需要记录的关键接口

1. **请求体** (`IEndpointBody`)
   - messages 结构
   - model 参数
   - tool_choice / tools
   - stream 选项
   - thinking/reasoning 参数

2. **Headers**
   - `Authorization`
   - `X-Request-Id`
   - `X-Initiator` (user vs agent)
   - `X-Interaction-Id`
   - `X-GitHub-Api-Version`
   - `OpenAI-Intent`
   - `Copilot-Vision-Request`

3. **响应解析**
   - SSE 事件格式
   - Delta 结构（content, tool_calls, reasoning）
   - Usage/token 统计
   - finish_reason 处理

## 交付物

1. **`docs/copilot-api-contract.md`** - 完整的 API 契约文档
2. **类型定义更新** - 对齐我们的类型与发现的结构
3. **测试 fixtures** - 真实示例用于验证

## 成功标准

- [ ] 所有请求字段已记录（类型和示例）
- [ ] 所有响应字段已记录（类型和示例）
- [ ] 所有 headers 已记录（用途、值来源和使用时机）
- [ ] Chat Completions 和 Responses API 差异已阐明
- [ ] **端点选择与模型能力映射逻辑已记录**
- [ ] **非流式响应结构已记录**
- [ ] **错误响应（4xx/5xx）与 retry/backoff 行为已记录**
- [ ] 我们的 proxy 翻译逻辑已根据发现验证

## 参考

- 仓库：https://github.com/microsoft/vscode-copilot-chat
- 许可证：MIT
- 我们现有文档：`docs/anthropic-api-compatibility.md`
