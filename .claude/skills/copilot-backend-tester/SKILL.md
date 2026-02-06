---
name: copilot-backend-tester
description: >
  直接测试 GitHub Copilot 后端 API，绕过本地代理，验证后端是否支持新参数或功能。
  触发场景：(1) 验证 Copilot 后端是否支持新 API 参数（如 adaptive thinking、effort），
  (2) 直接对 Copilot 后端发 /v1/messages 或 /chat/completions 请求，
  (3) 调试代理和后端之间的请求/响应格式差异，
  (4) 用户说"测试 copilot 后端"、"curl copilot"、"验证后端支持"、"test copilot backend"。
---

# Copilot 后端测试

直接调用 GitHub Copilot 后端 API，在改代理代码之前先确认后端支持情况。

## 前置条件

本地代理 `http://localhost:4141` 必须在运行。通过 `/token` 端点获取 Copilot token：

```bash
COPILOT_TOKEN=$(curl -s http://localhost:4141/token | jq -r '.token')
```

## 端点

| 端点 | URL | 账户类型 |
|------|-----|----------|
| Messages (Anthropic 格式) | `https://api.individual.githubcopilot.com/v1/messages` | individual（默认） |
| Messages (Business) | `https://api.business.githubcopilot.com/v1/messages` | business |
| Chat Completions (OpenAI 格式) | `https://api.individual.githubcopilot.com/chat/completions` | individual |

## 必需 Headers

```
Authorization: Bearer $COPILOT_TOKEN
content-type: application/json
copilot-integration-id: vscode-chat
editor-version: vscode/1.99.0
editor-plugin-version: copilot-chat/0.25.2025012301
user-agent: GitHubCopilotChat/0.25.2025012301
openai-intent: conversation-agent
x-github-api-version: 2025-04-01
X-Initiator: agent|user
x-request-id: <uuid>
```

`X-Initiator` 对 premium 模型（Opus 等）必须设为 `agent`，否则可能被拒绝。

## 脚本

脚本位于 `.claude/skills/copilot-backend-tester/scripts/`。

### test-messages.sh

测试 `/v1/messages`（Anthropic 格式）：

```bash
# Opus 4.6 adaptive thinking + max effort
bash scripts/test-messages.sh claude-opus-4.6 --adaptive --effort max

# Opus 4.5 手动 thinking budget
bash scripts/test-messages.sh claude-opus-4.5 --thinking 4096

# 流式测试
bash scripts/test-messages.sh claude-sonnet-4 --stream

# 自定义 prompt
bash scripts/test-messages.sh claude-opus-4.6 --adaptive --prompt "Explain recursion"
```

### test-chat-completions.sh

测试 `/chat/completions`（OpenAI 格式）：

```bash
bash scripts/test-chat-completions.sh gpt-5
bash scripts/test-chat-completions.sh gpt-5-mini --stream
```

## 查看可用模型

```bash
curl -s http://localhost:4141/v1/models | jq '.data[].id'
```

## 验证新功能流程

1. 获取 token：`curl -s http://localhost:4141/token | jq -r '.token'`
2. 用脚本或手动构造 curl，加上要测试的新参数
3. 看响应：200 = 支持，400 + error message = 不支持或格式不对
4. 有无参数各跑一次，对比行为差异

常见错误：
- `model_not_supported` — 模型名错了，用 `/v1/models` 确认正确 ID
- `invalid_request_error` — 参数被拒，看 error message 里的具体说明
- `budget_tokens: Input should be >= 1024` — 手动 thinking 的最低限制
