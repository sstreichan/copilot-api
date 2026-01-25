# 临时记录

## 背景
- 用户要求将有用信息整理至此文件，以便 compact 后继续调查。
- 当前关注点：Claude Code → Anthropic API → copilot-api(4141) → Responses API 的子代理 resume 异常（subagent 使用 gpt-5.2-codex，走 Responses endpoint）。

## 已确认现象 / 复现
- API Error 400: "No tool output found for function call ..."
- 稳定最小复现（目前）：同一条 subagent 回复里 **两个 Read 且读取不同文件** → resume 失败（2/2）。
- 对照：同一条回复内 **两次 Read 同一文件** → resume 成功（1/1）。
- 单工具调用可正常 resume。
- 其他组合（Read + Bash / Read + Grep）不稳定，且顺序可能影响结果；“Bash → Read”曾成功。

## 已做检查（copilot-api）
- 已阅读文件：
  - src/routes/messages/handler.ts
  - src/routes/messages/non-stream-translation.ts
  - src/routes/messages/responses-translation.ts
  - src/routes/messages/responses-stream-translation.ts
- 排查重点：tool_use/tool_result 归并、Responses/OpenAI translation、parallel_tool_calls、interleaved thinking 插入路径。

## 可疑代码点（只定位，不改动）
- src/routes/messages/responses-stream-translation.ts:215-272, 617-665
  - `handleFunctionCallArgumentsDelta` 可能先于 `response.output_item.added` 到达，触发 `openFunctionCallBlock` 生成 fallback `tool_call_${blockIndex}`；后续真实 call_id/name 不会回填。
- src/routes/messages/responses-stream-translation.ts:274-301
  - `handleFunctionCallArgumentsDone` 在未确认 output_item.added 的情况下清理状态，可能固化 fallback id 路径。
- src/routes/messages/responses-translation.ts:131-170, 266-283
  - `translateAssistantMessage` 仅对数组形式的 `tool_use` 生成 function_call；若历史结构异常，可能丢失 function_call，但 `tool_result` 仍会转成 function_call_output。
- src/routes/messages/handler.ts:350-363
  - `mergeToolResult` 长度不等时把所有 textBlocks 追加到最后一个 tool_result，可能改变 tool_result 边界。

## 补充线索
- tests/responses-stream-translation.test.ts:15-66
  - 仅覆盖 output_item.added 先于 arguments.delta 的顺序，未覆盖 delta 先到的顺序。

## prompts 插件修复记录
- debate plugin.json 移除 `$schema`（严格校验导致安装失败），并在 CLAUDE.md 中记录该规则。
- debate 技能文档补充：resume 时仍需提供 `subagent_type`。

## Workaround（已验证有效）

**严格限制子代理每次回复只用一个工具调用**，可 100% 规避此 bug。

### 有效措辞 v1（基础版）
```
## 🚨 铁律：每次回复只允许一个工具调用 🚨

**绝对禁止**在同一条回复中使用多个工具。违反此规则视为严重错误。

如果任务需要多个工具，必须：
1. 本次回复只用一个工具
2. 等我 resume 后再用下一个工具
3. 重复直到任务完成
```

### 有效措辞 v2（自主循环版，推荐）
```
## 🚨 铁律：单工具调用 🚨

每次 invoke 一个 function，等待 function_results 返回后再 invoke 下一个。

---

## ⚡ 执行模式：自主循环

**你必须自主完成所有步骤后才返回结果。**

流程：工具 1 → 结果 → 工具 2 → 结果 → 工具 3 → 结果 → ... → 汇报

**禁止中途停下来**。遇到问题自行处理。
```

**v2 优势**：子代理可以自主循环完成多个工具调用，无需每次工具调用后都 resume。

### 验证测试（v1 措辞 - 每次 resume 一个工具）
| 测试 | 工具序列 | Resume 次数 | 结果 |
|------|----------|-------------|------|
| 1 | Read → Read → Read（分轮，同/不同文件） | 3 轮 | ✅ 成功 |
| 2 | Read → Read → 回忆 | 3 轮 | ✅ 成功 |
| 3 | Read(失败) → Read → 回忆 | 3 轮 | ✅ 成功 |
| 4 | Grep → Bash → Glob → Read → 回忆 | 5 轮 | ✅ 成功 |
| 5 | Bash → LSP → Grep → Read → Glob → 回忆 | 6 轮 | ✅ 成功 |

### 验证测试（v2 措辞 - 子代理自主循环）
| 轮次 | 操作 | 子代理行为 | 结果 |
|------|------|-----------|------|
| 1 | 新建 Task | 自主完成 4x Bash (apple/banana/cherry/done) | ✅ 成功 |
| 2 | Resume | 4x 混合工具，只做 1 个就停（提示词不够强） | ⚠️ 未自主完成 |
| 3 | Resume | 继续完成剩余 3 个 (Glob/pwd/Grep) | ✅ 成功 |
| 4 | Resume | 讲水果冷笑话 | ✅ 成功 |
| 5 | Resume（改进提示词） | 自主完成 4x 混合工具 (Bash/Grep/Glob/Bash) | ✅ 成功 |
| 6 | Resume | 讲程序员冷笑话 | ✅ 成功 |
| 7 | Resume | 回忆所有轮次，记忆完整无误 | ✅ 成功 |

**结论**：
1. 工具类型不影响结果，关键是每次回复只用一个工具
2. v2 措辞可让子代理自主循环，减少 resume 次数
3. 子代理上下文在多轮 resume 后完整保留

## 已提交 Issue

- https://github.com/caozhiyuan/copilot-api/issues/80

## 后续计划（待继续）
- 等待 issue #80 反馈或修复
- 如需深入，可构建最小请求体/响应体对照，聚焦翻译层与状态机
