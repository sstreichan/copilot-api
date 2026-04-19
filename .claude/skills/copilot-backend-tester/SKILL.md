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
editor-version: vscode/<VS_CODE_VERSION>
editor-plugin-version: copilot-chat/<COPILOT_VERSION>
user-agent: GitHubCopilotChat/<COPILOT_VERSION>
openai-intent: conversation-agent
x-github-api-version: <API_VERSION>
X-Initiator: agent|user
x-request-id: <uuid>
```

在本仓库当前代码（`src/lib/api-config.ts`）里，默认组合如下：

- `COPILOT_VERSION = 0.44.1`
- `editor-version = vscode/${state.vsCodeVersion}`，而 `state.vsCodeVersion` 默认来自 `src/services/get-vscode-version.ts` 的 fallback `1.116.0`
- `x-github-api-version` 对聊天主链路使用 `2025-10-01`

脚本已内置同样默认值，并支持环境变量覆盖：

- `COPILOT_VERSION`
- `VSCODE_VERSION`
- `COPILOT_API_VERSION`（messages/chat）
- `AUTO_API_VERSION`（auto session/intent）

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

### test-auto-route.sh

测试 Auto 两段式路由（`/models/session` → `/models/session/intent`）并可选发送最终请求：

```bash
# individual：查看 Auto 最终会选哪个模型，并验证是否真的回文本
bash scripts/test-auto-route.sh --prompt "Reply with exactly: hi"

# business：走 business 域名测试同一流程
bash scripts/test-auto-route.sh --business --proxy-url http://localhost:4142 --prompt "Reply with exactly: hi"

# 只看 session/intent，不发最终请求
bash scripts/test-auto-route.sh --skip-final --prompt "Explain distributed transactions"
```

## 查看可用模型

```bash
curl -s http://localhost:4141/v1/models | jq '.data[].id'
```

## Auto 模型探针

当用户问「Auto 最后会解析到哪个模型」「Auto 还能不能说话」「某实例 Auto 是否仍可用」时，不要直接把 `model` 设成 `auto` 去打 `/v1/messages` 或 `/chat/completions`。后端通常会把字面 `model: "auto"` 视为 `model_not_supported`。正确方法是走 Auto 自己的两段式后端链路，再按同一次解析结果发最终请求。

### 适用场景

- 验证 Auto 当前会解析到哪个真实模型
- 验证某实例在部分显式模型 rate limit 后，Auto 是否仍可工作
- 对比 individual / business 账户下 Auto 的候选模型与最终路由结果
- 调试代理是否把 Auto 当成字面模型错误下发

### Auto 路线概览

1. 先获取 Copilot token（仍然通过本地代理 `/token`）
2. 调 `POST /models/session`，body 使用 `{"auto_mode":{"model_hints":["auto"]}}`
3. 从响应中读取：
   - `available_models`
   - `selected_model`
   - `session_token`
4. 调 `POST /models/session/intent`，必须带 `Copilot-Session-Token: <session_token>`
5. 从 intent 响应中读取：
   - `chosen_model`
   - `candidate_models`
   - `predicted_label`
6. 再按 `chosen_model` 实际支持的 endpoint 发最终请求，验证是否真的能回文本

### 端点与版本要求

| 用途 | individual | business | 备注 |
|------|------------|----------|------|
| Auto session | `https://api.individual.githubcopilot.com/models/session` | `https://api.business.githubcopilot.com/models/session` | `POST` |
| Auto intent | `https://api.individual.githubcopilot.com/models/session/intent` | `https://api.business.githubcopilot.com/models/session/intent` | `POST` |

**额外要求：**

- `x-github-api-version` 对 Auto 端点应使用 `2025-07-16` 或更高（脚本默认 `AUTO_API_VERSION=2025-07-16`）
- `/models/session/intent` 必须带有效 `Copilot-Session-Token`
- individual token 打 business 域名、或 business token 打 individual 域名，可能出现 `421 Misdirected Request`

### 手动探针模板

#### 第一步：session

```bash
COPILOT_TOKEN=$(curl -s http://localhost:4141/token | jq -r '.token')

curl -s https://api.individual.githubcopilot.com/models/session \
  -H "Authorization: Bearer $COPILOT_TOKEN" \
  -H "content-type: application/json" \
  -H "copilot-integration-id: vscode-chat" \
  -H "editor-version: vscode/${VSCODE_VERSION:-1.116.0}" \
  -H "editor-plugin-version: copilot-chat/${COPILOT_VERSION:-0.44.1}" \
  -H "user-agent: GitHubCopilotChat/${COPILOT_VERSION:-0.44.1}" \
  -H "openai-intent: conversation-agent" \
  -H "x-github-api-version: ${AUTO_API_VERSION:-2025-07-16}" \
  -H "X-Initiator: agent" \
  -H "x-request-id: test-auto-session" \
  -d '{"auto_mode":{"model_hints":["auto"]}}' | jq .
```

#### 第二步：intent

```bash
SESSION_TOKEN='<from /models/session response>'
AVAILABLE_MODELS='["gpt-5.3-codex","gpt-4.1"]'
PROMPT='Reply with exactly: hi'

curl -s https://api.individual.githubcopilot.com/models/session/intent \
  -H "Authorization: Bearer $COPILOT_TOKEN" \
  -H "content-type: application/json" \
  -H "copilot-integration-id: vscode-chat" \
  -H "editor-version: vscode/${VSCODE_VERSION:-1.116.0}" \
  -H "editor-plugin-version: copilot-chat/${COPILOT_VERSION:-0.44.1}" \
  -H "user-agent: GitHubCopilotChat/${COPILOT_VERSION:-0.44.1}" \
  -H "openai-intent: conversation-agent" \
  -H "x-github-api-version: ${AUTO_API_VERSION:-2025-07-16}" \
  -H "X-Initiator: agent" \
  -H "Copilot-Session-Token: $SESSION_TOKEN" \
  -H "x-request-id: test-auto-intent" \
  -d "{\"prompt\":\"$PROMPT\",\"available_models\":$AVAILABLE_MODELS,\"turn_number\":1,\"prompt_char_count\":${#PROMPT}}" | jq .
```

### 如何发最终请求

不要把最终请求写成 `model: "auto"`。应当读取 `chosen_model`，然后按模型支持的 API 发请求：

- `claude-*` → 优先 `/v1/messages`
- `gpt-4.1`, `gpt-4o` → 常见是 `/chat/completions`
- `gpt-5.*`, `gpt-5.*-codex` → 常见是 `/v1/responses`

仍建议先用 `/v1/models` 或现有兼容层元数据确认 `supported_endpoints`，不要只凭命名猜测。

最终请求最好继续带同一个 `Copilot-Session-Token`，这样更接近 Auto 在客户端里的真实链路。

### 结果解读

- `selected_model`：session 阶段初始选择，不一定等于最终模型
- `chosen_model`：intent/router 阶段最终选中的模型，更接近真正会被发送的模型
- `candidate_models`：router 给出的候选集，可用来判断 prompt 是否触发了 reasoning 路由

如果目标是判断「Auto 最后会发哪个模型」，优先看 `chosen_model`；如果目标是判断「Auto 当前默认会先考虑谁」，可以同时看 `selected_model`。

### 文本输出验证

如果目标不是只看路由，而是确认 Auto 是否仍能“说话”，需要在上面两步之后继续发最终聊天请求，并抽取文本：

- `/v1/messages`：通常从 `content[].text` 抽正文
- `/chat/completions`：通常从 `choices[0].message.content` 抽正文
- `/v1/responses`：不要只看顶层字段；应遍历 `output[]`，在 `type == "message"` 的项里继续遍历 `content[]`，提取 `type == "output_text"` 的文本

若 `/v1/responses` 返回 `200` 但文本为空，先检查是否命中了：

- `max_output_tokens` 太小，响应里出现 `incomplete_details`
- 解析逻辑只看了顶层，没有向下遍历 `output[].content[]`

## 验证新功能流程

1. 获取 token：`curl -s http://localhost:4141/token | jq -r '.token'`
2. 用脚本或手动构造 curl，加上要测试的新参数
3. 看响应：200 = 支持，400 + error message = 不支持或格式不对
4. 有无参数各跑一次，对比行为差异

常见错误：
- `model_not_supported` — 模型名错了，用 `/v1/models` 确认正确 ID
- `invalid_request_error` — 参数被拒，看 error message 里的具体说明
- `budget_tokens: Input should be >= 1024` — 手动 thinking 的最低限制
- `Missing Copilot-Session-Token header` — `/models/session/intent` 少了 session token
- `Invalid Copilot-Session-Token` — session token 伪造、过期或与当前账户不匹配
- `421 Misdirected Request` — 账户类型与后端域名不匹配，检查 individual / business 分流

---

## OpenCode 问题调查

当需要排查 OpenCode（或类似 AI 编码工具）使用 copilot-api 时遇到的错误，按以下步骤系统排查。

### 数据源

OpenCode 有两个主要数据源，**必须同时检查**：

#### 1. 日志文件（文本日志）

- **位置**：`~/.local/share/opencode/log/`
- **格式**：纯文本，包含时间戳、错误类型、堆栈跟踪
- **大小**：通常数百 MB 到 1GB+，**不要**用 `cat` 读取全文
- **关键搜索模式**：

```bash
# 搜索 API 错误
grep -c "AI_APICallError" ~/.local/share/opencode/log/*.log

# 搜索特定错误类型
grep "thinking.*cannot be modified" ~/.local/share/opencode/log/*.log | head -5
grep "Invalid signature" ~/.local/share/opencode/log/*.log | head -5

# 提取错误附近的上下文（模型名、request ID）
grep -B5 "AI_APICallError" ~/.local/share/opencode/log/FILENAME.log | grep -E "(model|req_)" | head -20

# 确认是否走 Vertex AI 后端（看 request ID 前缀）
grep "req_vrtx_" ~/.local/share/opencode/log/*.log | head -5
# req_vrtx_ = Vertex AI 后端
# req_ (无 vrtx) = 其他后端
```

#### 2. SQLite 数据库

- **位置**：`~/.local/share/opencode/opencode.db`
- **大小**：225MB+（大型数据库）
- **关键表**：`session`、`message`、`part`
- **关键字段**：
  - `message.data` (JSON)：`role`、`modelID`、`providerID`、`tokens`、`finish`
  - `part.data` (JSON)：`type`（text/tool/reasoning/error 等）
  - `finish` 字段值：`"stop"`（正常）、`"tool-calls"`（工具调用）、`"unknown"`（**通常表示失败**）、`"length"`（截断）

**常用查询**：

```bash
# 查找失败的 Claude 消息
bun -e "
import Database from 'bun:sqlite';
const db = new Database('$HOME/.local/share/opencode/opencode.db', { readonly: true });
const rows = db.query(\"SELECT m.id, m.session_id, m.data, s.title FROM message m JOIN session s ON m.session_id = s.id WHERE json_extract(m.data, '$.finish') = 'unknown' AND json_extract(m.data, '$.modelID') LIKE '%claude%' ORDER BY m.time_created DESC LIMIT 10\").all();
rows.forEach(r => { const d = JSON.parse(r.data); console.log(r.id, d.modelID, r.title); });
db.close();
"

# 按模型统计错误数量
bun -e "
import Database from 'bun:sqlite';
const db = new Database('$HOME/.local/share/opencode/opencode.db', { readonly: true });
db.query(\"SELECT json_extract(data, '$.modelID') as model, COUNT(*) as count FROM message WHERE json_extract(data, '$.finish') = 'unknown' GROUP BY model ORDER BY count DESC\").all().forEach(e => console.log(e.model, ':', e.count));
db.close();
"

# 查找特定 session 中包含错误的 parts
bun -e "
import Database from 'bun:sqlite';
const db = new Database('$HOME/.local/share/opencode/opencode.db', { readonly: true });
const rows = db.query(\"SELECT p.id, p.data FROM part p JOIN message m ON p.message_id = m.id WHERE m.session_id = 'SESSION_ID_HERE' AND json_extract(p.data, '$.type') = 'error' ORDER BY p.time_created DESC LIMIT 5\").all();
rows.forEach(r => { console.log(r.id, JSON.parse(r.data)); });
db.close();
"

# 查找特定时间段的错误
bun -e "
import Database from 'bun:sqlite';
const db = new Database('$HOME/.local/share/opencode/opencode.db', { readonly: true });
const rows = db.query(\"SELECT m.id, m.time_created, json_extract(m.data, '$.modelID') as model, s.title FROM message m JOIN session s ON m.session_id = s.id WHERE json_extract(m.data, '$.finish') = 'unknown' AND m.time_created > datetime('now', '-24 hours') ORDER BY m.time_created DESC\").all();
rows.forEach(r => console.log(r.time_created, r.model, r.title));
db.close();
"
```

### 调查流程

1. **收集错误信息**
   - 从日志 `grep` 错误类型和关键词
   - 从 SQLite 查 `finish = 'unknown'` 的消息，提取 `modelID`
   - **交叉验证**：日志和数据库中的错误应该能互相印证

2. **提取原始参数**
   - 从数据库 `message.data` 中提取实际使用的模型名（`modelID`）
   - 从日志中提取 request ID（`req_vrtx_` 等）和错误响应体
   - **不要猜测参数** — 使用日志中记录的确切值

3. **构建最小复现请求**
   - **使用日志中的确切模型名**（如 `claude-opus-4.6`，不是你认为应该用的模型）
   - 用实际错误场景的参数构造 curl 请求
   - 使用本 skill 的脚本或手动 curl 直接发到 Copilot 后端
   - 对比：通过代理 vs 直接后端，定位问题出在哪一层

4. **根因分析**
   - 后端返回 400 → 看 error message，确认是参数问题还是 payload 格式问题
   - 代理返回错误但后端正常 → 代理的格式转换有 bug
   - 两边都报错 → 后端不支持该功能/参数组合

### 避坑指南（历史教训）

以下是之前排查问题时踩过的坑，**必须避免**：

1. **模型名不要猜测**
   - ❌ 错误：测试时随意用 `claude-sonnet-4` 或 `claude-opus-4.5`
   - ✅ 正确：先从日志/数据库中提取实际出错时使用的模型名（如 `claude-opus-4.6`），然后用**同一个模型**复现
   - 不同模型的后端行为可能不同，用错模型可能无法复现问题

2. **不要忽略 `X-Initiator: agent` header**
   - Premium 模型（Opus 等）**必须**使用 `X-Initiator: agent`
   - 缺少此 header 会导致请求被拒绝，产生误导性的错误

3. **复现必须忠于原始场景**
   - 使用日志中的原始参数（model、thinking config、max_tokens 等）
   - 不要"简化"请求到连问题都无法触发的程度
   - 多轮对话错误需要构造含 assistant 历史消息的 payload

4. **不要盲目删除有用代码**
   - 遇到看似"多余"的函数（如 `reorderAssistantBlocks`），先 `git log` 查看添加原因
   - 这些函数通常是为了修复特定后端约束而添加的
   - 删除可能导致之前已修复的问题重新出现

5. **日志文件太大不要用 cat**
   - 用 `grep` + `head` 精确搜索
   - 用 `wc -l` 估算日志大小
   - 需要上下文时用 `grep -B5 -A5` 而不是读取整个文件

6. **两个数据源必须交叉验证**
   - 日志可能不完整（被截断、日志级别不够）
   - 数据库可能缺少详细错误信息
   - 两者结合才能完整还原问题现场
