# Router 总纲

> 话说这 Sticky Router，乃是多实例调度之枢纽。
> 凡上游请求入得此间，须按 session·agent·model 三元钥匙寻得旧绑，
> 若无旧绑，则以「最闲者得」之法择端口而遣之。
> 世人谓之 **session-sticky, least-loaded routing**。

## 卷一 · 文目结构

主逻辑四件，在于后端三层与前台一面；另有 `start.sh` 为外场班头，替诸实例排兵列阵。

```
router/
├── lib.ts              # 纯函数层——解析、格式化、取 header，不沾状态
├── state.ts            # 状态与 I/O——binding 表、SSE 广播、路由决策、代理转发、dashboard handler
├── sticky-router.ts    # 装配壳——读配置、发现模型、起两个 Bun.serve、裁日志
├── dashboard.html      # 前端仪表盘——SSE 实时流、binding/history 可视、按钮清除
├── start.sh            # tmux 编排脚本——验 tokens/端口 → 起多实例 → 等就绪 → 起 router
└── AGENTS.md           # 此文也
```

测试四组，居于 `tests/router/`：

| 测试文件 | 覆盖范围 |
|:---------|:---------|
| `lib.test.ts` | 纯函数：解析 instance、model、header、binding key |
| `state.test.ts` | 状态操作：least-loaded 选择、计数累加、SSE 广播、路由记录 |
| `proxy.test.ts` | 代理转发：正常透传、上游失败 502、GET 不发 body |
| `integration.test.ts` | 端到端：sticky 复用、无 model 降级、模型不存在 502 |

## 卷二 · 令典（命令速查）

```bash
# 完整启动（tmux 编排，一键起多实例 + router + dashboard）
bash router/start.sh

# 单独起 router（需后端实例已在运行）
TOKENS_PATH=~/.local/share/copilot-api/tokens.json bun run router/sticky-router.ts

# 测试
bun test tests/router/                    # 跑全部 router 测试
bun test tests/router/state.test.ts       # 跑单个测试文件
bun test --test-name-pattern "sticky"     # 按名称过滤

# 质量
bun run lint:all --fix                    # Lint 并修复
bun run typecheck                         # 类型检查
```

## 卷三 · 要旨（核心概念）

### 三层拆分之道

- **`lib.ts`** — 纯函数，无副作用，可单独测试。凡解析、格式化、取值之事皆归此处。
- **`state.ts`** — 有状态之物：`StickyRouterState` 为唯一真相源。路由决策（`pickPort`）、负载计算（`pickLeastLoaded`）、SSE 广播、代理转发皆在此。
- **`sticky-router.ts`** — 装配壳，仅做三事：读配置、发现模型、起服务器。七十余行，不宜膨胀。

### Sticky Binding

请求通常携三元标识：`x-session-id`、`x-oc-agent`、`x-oc-model`。
仅当 `x-session-id` 存在时，才会生成 binding key（`{session}:{agent}:{model}`）。
已有绑定且端口仍支持该模型 → **sticky**（复用旧端口）。
无绑定或无 `x-session-id` → **least-loaded**（总请求数最少之端口，平局随机）。
已有绑定但原端口不再支持该模型 → **rebalance**（重新选择并覆盖绑定）。

另可见 `x-oc-provider`。此项只入 `RouteRecord` 与日志，供人辨来路；
**不入 binding key**，亦不主导 sticky 去向。

### Least-Loaded 选择

`getTotalRequestCount` 对该端口所有模型计数求和，取最小者。
平局时 `Math.random()` 随机——故测试中不可断言具体端口号，
当以 sorted 比较或 `proxiedPorts[0] === proxiedPorts[1]` 验证 sticky 行为。

### 无模型降级

请求中无 model → `pickLeastLoaded` 在全部端口中选一个，reason 记为 `nomodel`。

### Model 来源优先级

路由侧先尝试从 request body 解析 `model`，若缺失再回退到 `x-oc-model` header。
其中 `x-oc-model: _` 视作空值，不参与模型路由决策。

### Router 自身端点

- `GET /status` —— 回实例状态、binding 表、`modelToPorts`、history 大小，供巡检或脚本探问。
- `GET /v1/models` —— 将各实例已发现模型去重后并表返回，作 router 视角之模型清册。
  若同名模型在多实例存在，保留 `context_window` 更大的详情对象。

### Upstream Header Snapshots

`router` 今番不但记路由与 binding，也记每个端口最近一次上游 quota/rate-limit 头之快照。

- `lib.ts` 纯解析：`parseUpstreamHeaderSnapshot()` 统一拆解 `x-quota-snapshot-premium_interactions`、`x-usage-ratelimit-session`、`x-usage-ratelimit-weekly`
- `state.ts` 持状态：`portHeaderSnapshots` 为唯一存放处；代理成功或 429 回包后都要更新该端口 snapshot
- `discoverModels()` 清模型映射时，也清旧 snapshot，免得 dashboard 留存陈迹
- `GET /status` 现已包含每个实例的 `headerSnapshot`；dashboard 只负责展示，不负责推断或修复坏值
- 非法、缺失、越界 header 一律降为 `null`，不要在 `state.ts` 或 `dashboard.html` 里自行脑补默认值

### Proxy 转发

`proxyTo` 转发时保留原 method 与多数 header，但会删去 `host`；
`GET` / `HEAD` 不附 body；若上游连不通，则回 `502` 与 JSON 错误。

## 卷四 · 外联（上下游依赖）

### `tokens.json`

实例注册表，默认位于 `~/.local/share/copilot-api/tokens.json`。
数组格式，每条至少含 `name`（唯一名）、`port`（唯一端口）、`token`；`flags` 与 `accountType` 均可选。
Router 只取 `name` 与 `port`；`token` 与可选 `flags`/`accountType` 由 `start.sh` 转交各实例。
若条目缺少 `accountType`，`start.sh` 不传 `-a`，交由实例自身从 token endpoint 解析真实账户类型。

### OpenCode 注记插件

仓库内随附之 OpenCode 插件位于 `.opencode/plugins/subagent-marker.js`；它专司注入 `__SUBAGENT_MARKER__`，并不主持多实例路由。

若外场另配 session-sticky 所用插件，其职责当是在 `chat.headers` 钩子中注入下列四个 header：
- `x-session-id` — `input.sessionID`，会话标识（binding key 之首段）
- `x-oc-agent` — `input.agent` 的 name，代理名称
- `x-oc-model` — `input.model.id`，模型 ID
- `x-oc-provider` — `input.provider.id`，提供商标识（仅入日志与 `RouteRecord`，**不入 binding key**）

前三者构成 binding key（`{session}:{agent}:{model}`），为 router 判定路由之全部信号。
插件自带日志轮转（写入同目录 `session-router.log`，上限 200 行，超限裁至 150 行）。

### Dashboard

`:4139`（默认）提供实时仪表盘。API 端点：

| 路径 | 方法 | 用途 |
|:-----|:-----|:-----|
| `/api/status` | GET | 实例状态、binding 表、模型映射 |
| `/api/history` | GET | 路由历史记录 |
| `/api/history/clear` | POST | 清空历史 |
| `/api/bindings/clear` | POST | 清空所有 sticky binding |
| `/api/events` | GET | SSE 实时路由事件流 |

页面本身会展示每实例的 per-model requestCounts、SSE 连通状态，
又以两枚按钮直击清 history / clear bindings 两道 POST 端点。
近一版还额外展示 premium/session/weekly snapshot；若此处数值不对，先查 `router/lib.ts` 之解析与 `state.ts` 之更新点，不要先改前端文案。

### `start.sh`

此脚本非业务核心，却是起局要津：
先验 `tokens.json` 形制与端口空闲，再分 pane 起多实例；
待各实例、router、dashboard 皆就绪后，方算礼成。
tmux 会话默认启用 `mouse on`，滚轮不再误作箭头乱窜。

## 卷五 · 文法（代码风格）

### 导入

```typescript
import { readFileSync } from "node:fs"    // Node 内置加 node: 前缀
import { readPort, parseInstances } from "./lib"  // 本地相对路径
import type { Instance } from "./lib"      // 类型单独 import type
```

### 命名

- 函数：`camelCase`，动词开头（`pickPort`、`getStatusPayload`、`broadcastSse`）
- 接口：`PascalCase`（`StickyRouterState`、`RouteRecord`）
- 常量：`UPPER_SNAKE`（`DEFAULT_HISTORY_LIMIT`、`DEFAULT_SSE_RETRY_MS`）

### 格式

- 无分号
- 双引号
- 尾逗号
- `Array<T>` 而非 `T[]`
- 函数参数多于两个时用 options 对象 + 解构

### 错误处理

- `catch` 块：空 catch 仅用于「忽略即可」之情形（如日志轮转失败）
- 上游失败：返回 `502` + JSON `{ error: "..." }`，不抛异常
- 用 `formatError(error)` 统一格式化错误消息

### 测试

- 使用 `bun:test`（`describe` / `it` / `expect`）
- Mock：注入 `fetchImpl` / `now` 参数，不用全局 mock
- 不硬编码具体端口号（least-loaded 含随机性），用语义断言
- Fixture 数据内联于测试文件

## 卷六 · 禁忌

| 忌讳 | 缘由 |
|:-----|:-----|
| 在 `lib.ts` 中引入状态或 I/O | 纯函数层之洁癖，不可沾染 |
| 膨胀 `sticky-router.ts` | 装配壳当薄如蝉翼，业务逻辑归 `state.ts` |
| 把 `x-oc-provider` 纳入 binding key | provider 只记来路，不该打碎 sticky 复用 |
| 在 `state.ts` / `dashboard.html` 手写 header 解析 | quota/rate-limit 快照之解析须收于 `lib.ts` 纯函数层 |
| 测试中断言 `pickLeastLoaded` 返回具体端口 | 平局随机，断言会闪烁 |
| 硬编码 token 或账户信息 | 敏感之物，概不入代码 |
| `as any` / `@ts-ignore` | 类型当严，不可苟且 |
| 改 `start.sh` 时忘记 `set -Eeuo pipefail` | Bash 严格模式，命脉所在 |

## 卷七 · 环境变量

| 变量 | 默认 | 说明 |
|:-----|:-----|:-----|
| `TOKENS_PATH` | `~/.local/share/copilot-api/tokens.json` | 实例注册表路径 |
| `ROUTER_PORT` | `4140` | Router 监听端口 |
| `DASHBOARD_PORT` | `4139` | Dashboard 监听端口 |
| `ROUTER_HEIGHT` | `8` | tmux 中 router pane 的预留高度 |
| `READINESS_TIMEOUT_SECONDS` | `60` | 等待实例 / router / dashboard 就绪的超时 |
| `READINESS_INTERVAL_SECONDS` | `2` | readiness 探测间隔 |
| `STICKY_ROUTER_LOG_FILE` | `/tmp/sticky-router.log` | 日志文件路径 |

## 跋

> 凡改此处代码者，当先跑测试，后看仪表盘。
> 改纯函数加测试于 `lib.test.ts`，改路由逻辑加测试于 `state.test.ts`。
> 切记：**sticky binding 会在 clear 操作或模型可用性变化时重算**。
> 此乃设计之本意，非 bug 也。
