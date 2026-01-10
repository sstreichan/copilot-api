# 任务清单

- [x] `src/lib/state.ts` - 添加 `forceAgent: boolean`
- [x] `src/start.ts` - 添加 `--force-agent` / `-F` 标志
- [x] `src/services/copilot/create-chat-completions.ts` - 检查 state 后设置 header
- [x] `src/services/copilot/create-responses.ts` - 同上
- [x] 更新测试
- [x] 还原未暂存的硬编码更改（已通过实现正确逻辑完成）

**依赖**: 1 → 2 → [3,4] → 5 → 6
