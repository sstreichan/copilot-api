# Tasks: 启用原生 Messages API

## 实现顺序

任务按依赖顺序排列，可并行执行的任务已标注。

---

### Phase 1: 基础设施

#### Task 1.1: 新增 state 字段
**文件**: `src/lib/state.ts`
**变更**: 添加 `nativeMessages: boolean` 字段（默认 `false`）
**验证**: TypeScript 编译通过

#### Task 1.2: 新增 CLI flag
**文件**: `src/start.ts`
**变更**:
- 添加 `--native-messages` (`-M`) 参数定义
- 在 `runServer()` 中设置 `state.nativeMessages`
- 更新 `RunServerOptions` 接口
**验证**: `bun run dev -- -M` 启动时 state 正确设置

---

### Phase 2: 核心服务（可与 Phase 1.2 并行）

#### Task 2.1: 创建 create-messages.ts 服务
**文件**: `src/services/copilot/create-messages.ts` (新建)
**内容**:
- 导出 `createMessages()` 函数
- 复用现有 token 刷新逻辑
- 构建必要 headers
- POST 到 `/v1/messages`
- 支持流式和非流式响应

**研究方法**:
- 读取 `package.json` 了解依赖
- 使用 context7/deepwiki 查询库使用方式
- 借鉴 `create-chat-completions.ts` 和 `create-responses.ts` 的模式

**验证**: 单元测试 mock 调用成功

---

### Phase 3: Handler 集成

#### Task 3.1: 添加辅助函数
**文件**: `src/routes/messages/handler.ts`
**变更**: 添加 `isClaudeModel()` 辅助函数
**验证**: 函数正确识别 claude 模型

#### Task 3.2: 添加 handleWithNativeMessages()
**文件**: `src/routes/messages/handler.ts`
**变更**:
- 新增 `handleWithNativeMessages()` 函数
- 读取 `anthropic-beta` header，并在 `createMessages()` 中按 allowlist 过滤后转发
- 流式响应使用 `c.body(response.body)` 直接转发（不用 `streamSSE`）
- 非流式响应直接返回 JSON
**验证**: 函数可被调用并返回响应

#### Task 3.3: 修改 handleCompletion() 添加分支
**文件**: `src/routes/messages/handler.ts`
**变更**:
```typescript
// ⚠️ CRITICAL: Must be BEFORE getSmallModel() and mergeToolResultForClaude()
if (state.nativeMessages && isClaudeModel(anthropicPayload.model)) {
  return await handleWithNativeMessages(c, anthropicPayload, originalModel)
}
```
**关键约束**: 分支必须在任何 payload 改写逻辑之前
**验证**: 分支逻辑按预期工作，payload 不被修改

---

### Phase 4: 测试

#### Task 4.1: 编写 flag 解析测试
**文件**: `tests/start.test.ts` 或新文件
**内容**: 验证 `-M` 正确设置 state
**验证**: 测试通过

#### Task 4.2: 编写分支逻辑测试
**文件**: `tests/messages/native-messages.test.ts` (新建)
**内容**:
- `!nativeMessages` → 不调用 native handler
- `nativeMessages && !claude` → 不调用 native handler
- `nativeMessages && claude` → 调用 native handler
**验证**: 测试通过

#### Task 4.3: 编写请求透传测试
**文件**: `tests/messages/native-messages.test.ts`
**内容**:
- 验证 payload 不被修改（model、content 保持原样）
- 验证 allowlisted `anthropic-beta` header 被转发
- 验证非 allowlisted `anthropic-beta` header 被过滤
**验证**: 测试通过

#### Task 4.4: 编写 streaming 透传测试
**文件**: `tests/messages/native-messages.test.ts`
**内容**:
- 验证流式响应使用原始 body 透传（`c.body(response.body)`）
- 验证 SSE 事件格式未被修改
**验证**: 测试通过

---

### Phase 5: 验证与文档

#### Task 5.1: 端到端验证 (用户执行)
**方法**: 手动测试 (**由用户自己执行，非 agent**)
- 启动服务器 `bun run dev -- -M`
- 发送 Claude 模型请求，确认使用 native endpoint
- 发送 GPT 模型请求，确认 fallback
- 不带 flag 启动，确认行为不变

#### Task 5.2: 更新 CLAUDE.md
**文件**: `CLAUDE.md`
**变更**: 在 CLI Flags 部分添加 `-M` 说明

---

## 任务依赖图

```
Task 1.1 ─────┐
              ├──→ Task 3.1 ──→ Task 3.2 ──→ Task 3.3
Task 1.2 ─────┤
              │
Task 2.1 ─────┘

Task 3.3 ──→ Task 4.1, 4.2, 4.3, 4.4 (parallel)

Task 4.* ──→ Task 5.1 ──→ Task 5.2
```

## 估计工作量

| Phase | 任务数 | 复杂度 |
|-------|--------|--------|
| Phase 1 | 2 | 低 |
| Phase 2 | 1 | 中 |
| Phase 3 | 3 | 中 |
| Phase 4 | 4 | 低 |
| Phase 5 | 2 | 低 |
