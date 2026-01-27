# Design: 研究 Copilot API 契约

## 研究方法论

### 方法 1：静态代码分析（主要）

直接阅读 `microsoft/vscode-copilot-chat` 源代码：

**优势：**
- 可以看到完整逻辑和所有分支
- 有 TypeScript 类型定义
- 可以看到代码注释和设计意图
- 无需配置环境

**步骤：**
1. Clone 仓库（shallow clone 节省时间）
2. 使用 grep/ripgrep 搜索关键函数
3. 追踪调用链
4. 提取类型定义和示例

### 方法 2：动态抓包（备选验证）

使用 mitmproxy 抓取实际请求：

**优势：**
- 眼见为实
- 可以看到实际值
- 可以验证静态分析的理解

**何时使用：**
- 对源码理解有疑问时
- 想确认实际发送的 header 值
- 调试我们的 proxy 时对比

## 研究范围边界

### 包含

与 Copilot 后端通信相关的网络层、端点处理、流解析等代码。

### 排除

- BYOK（自带密钥）流程
- MCP 服务器集成
- UI 组件
- 测试相关代码

## 输出格式设计

### API 契约文档结构

```markdown
# Copilot API Contract

## 端点

### POST /chat/completions
- 请求体结构
- 必选/可选字段

### POST /responses
- 请求体结构
- 与 chat/completions 的差异

## Headers

### 请求 Headers
| Header | 必选 | 值来源 | 用途 |
|--------|------|--------|------|

### 响应 Headers
| Header | 用途 |
|--------|------|

## 流式响应

### SSE 事件格式
### Delta 结构
### 终止条件

## 特殊功能

### Thinking/Reasoning
### Tool Calls
### Vision
```

## 与现有实现的对比点

### 需要验证的假设

1. **我们的 `ChatCompletionsPayload` 类型是否完整？**
   - 对比：官方 `IEndpointBody`

2. **我们的 headers 是否齐全？**
   - 对比：官方 `postRequest`

3. **SSE 解析逻辑是否一致？**
   - 对比：官方 `SSEProcessor`

4. **finish_reason 映射是否正确？**
   - 对比：官方处理逻辑

## 风险和缓解

| 风险 | 缓解 |
|------|------|
| 源码版本可能与线上不同 | 关注 main 分支最新提交 |
| 部分逻辑可能在服务端 | 记录客户端可观察行为 |
| 代码量大难以全面覆盖 | 聚焦请求/响应相关代码 |
