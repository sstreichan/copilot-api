# 设计：强制 Agent Initiator

## 数据流

```
CLI --force-agent → state.forceAgent → API 函数检查
```

## 实现

```typescript
// state.ts
forceAgent: boolean  // 默认 false

// create-chat-completions.ts / create-responses.ts
const initiator = state.forceAgent ? "agent" : 原始逻辑
```

## 向后兼容

默认 `false`，现有用户无影响。
