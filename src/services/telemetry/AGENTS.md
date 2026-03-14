# Telemetry Service Guide

## Overview

这里封装 Copilot telemetry：解析 token 中的 `tid`、拼装 Application Insights envelope、异步发送事件，并模拟延迟 feedback 行为；业务请求绝不能依赖它成功。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Event sending | `telemetry.ts` | fire-and-forget fetch、success/error wrapper |
| Identity fields | `identity.ts` | machine ID、persistent device ID、session ID |
| Envelope / constants | `types.ts` | event names、AI envelope shape、`parseTid()` |
| Mock values | `mock-values.ts` | round-robin language/participant/command 与随机反馈 |

## Critical Invariants

- `initTelemetry()` 必须在拿到 Copilot token 后尽早执行；否则早期事件会缺 `ai.user.id`
- `trackEvent()` 是 fire-and-forget：不 await、不 throw，只记 warning；不能影响主请求成功与否
- `_endpoint` 需要规范化到单个 `/telemetry` 结尾；不能重复拼接，也不能把原始 endpoint 原封不动写进去
- `scheduleFeedbackEvents()` 只在成功响应后、且约 30% 概率触发；不要把 edit feedback 变成同步副作用

## Project-Specific Rules

- `identity.ts` 的 `SESSION_ID` 只在进程生命周期内稳定；持久的是 `getDevDeviceId()` 写入 `~/.cache/Microsoft/DeveloperTools/deviceid`
- `getMachineId()` 用首个非 internal MAC 做 SHA-256；找不到时 hash 空串，不能抛错中断流程
- telemetry 总开关来自 `getConfig().telemetry === true`；默认关闭，不发送任何事件
- `trackRequestSent` / `trackResponseSuccess` / `trackResponseError` 支持透传 `modelCallId`，但是否生成 UUID 由上游 service 决定

## Anti-Patterns

- 在 route / handler 里手写 telemetry fetch，绕开这里的 envelope 与 timeout 规则
- 为 telemetry 加通用重试或 await，拖慢主请求
- 把敏感原文直接塞进 `TelemetryProperties`，破坏当前“非敏感字符串”假设
- 在多个位置各自生成 device ID 或 session ID，造成身份字段漂移
