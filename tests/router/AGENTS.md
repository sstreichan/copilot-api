# Router Test Guide

## Overview

这里专门测试 sticky router：验证 least-loaded 选择、binding 复用、代理转发、dashboard 与 SSE 行为。测试重点是语义，不是固定端口号。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Pure state decisions | `state.test.ts` | least-loaded、sticky、rebalance、history trim |
| Proxy forwarding | `proxy.test.ts` | host 删除、GET/POST body、502 包装 |
| End-to-end router handler | `integration.test.ts` | `/status`、`/v1/models`、sticky reuse、dashboard |
| Pure helper parsing | `lib.test.ts` | header / instance / binding key 解析 |

## Critical Invariants

- tie-break 含随机性时，不要断言具体端口号；断言“两个端口都可能出现”或“第二次 sticky 复用第一次端口”
- `createFetchStub()` / `fetchImpl` 注入是 router 测试的标准模式；不要把全局 `fetch` mock 成共享状态
- dashboard 测试要使用临时 html 文件，并在 `afterEach` 清理；避免污染 `/tmp`
- `x-oc-provider` 只进入日志/route record，不进入 binding key；测试 sticky key 时只断言 `session:agent:model`
- 若改动涉及 router 的 quota/rate-limit 可观测性，至少覆盖三件事：`lib.test.ts` 测 parser 容错，`state.test.ts` 测 `headerSnapshot` 出现在 status payload，`proxy.test.ts` 测代理路径会更新 snapshot

## Project-Specific Rules

- `state.test.ts` 里的 least-loaded 断言以 requestCounts 与 reason 为主，不以端口顺序为主
- `proxy.test.ts` 必须验证 `host` 被剥离、上游错误变成 502 JSON、GET/HEAD 不强塞 body
- `integration.test.ts` 里的 nomodel 场景要验证 reason=`nomodel` 与两端口分流，而不是固定某个实例

## Anti-Patterns

- 用真实网络端口起 router 再测试；当前约定是直接调用 handler / state helpers
- 在 sticky 测试里把随机平局端口写死
- 忘记清空 `routeHistory`、`sessionBindings` 或 dashboard 临时文件
- 只测 requestCounts / binding，不测 `headerSnapshot`，导致 router 新增的 quota 观测能力无回归保护
