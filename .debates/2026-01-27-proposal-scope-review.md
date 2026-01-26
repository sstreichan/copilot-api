# Debate: Proposal 范围是否过于有限

**Date**: 2026-01-27
**Status**: in-progress
**Participants**: Main Agent ↔ Sub Agent (general-purpose)
**Selection Rationale**: 需要全面评估研究范围，general-purpose 适合多角度分析

---

## Context

正在评审的 Proposal: `study-copilot-api-contract`

**目的**: 研究 VSCode Copilot Chat 扩展源代码，了解 Copilot API 契约

**当前范围**:
- ✅ 请求体结构 (Chat Completions + Responses API)
- ✅ Headers (请求和响应)
- ✅ SSE 流解析
- ✅ 特殊功能 (thinking, tool_calls, vision)
- ❌ BYOK 流程
- ❌ 认证流程
- ❌ MCP 集成
- ❌ UI/UX 代码

**我们的最终目的**: 改进 copilot-api proxy 的翻译准确性

---

## Round 1

### Main Agent Position

我认为当前 proposal 范围**足够**，理由：

1. **聚焦核心目标**：我们只需要了解请求/响应格式，不需要了解 VSCode 如何呈现结果

2. **BYOK 不相关**：BYOK 是用户自带密钥调用第三方 API（如直接调 Anthropic），与 Copilot 后端无关

3. **认证已实现**：我们有自己的 OAuth 认证流程，不需要研究官方实现

4. **工作量控制**：仓库代码量巨大，扩大范围会导致研究失焦

### Sub Agent Review

**结论**：范围**略偏窄**，存在遗漏风险。

#### 质疑点

1. **遗漏的重要内容**：
   - 模型/端点选择与能力映射（`endpointProvider`）
   - 错误响应与重试/限流语义（429/401/403/5xx）
   - 非流式响应结构
   - Headers 值的来源链路

2. **排除项并非完全不相关**：
   - **认证流程**：token 形态、scope 需确认与官方一致
   - **BYOK**：包含请求体字段差异信息
   - **MCP**：tool schema 生成可能来自 MCP
   - **UI 代码**：intent/initiator/mode 等值的来源

3. **建议扩大范围**（最小扩展）：
   - 端点选择与模型能力映射
   - 错误响应 + retry/backoff
   - 非流式响应结构
   - Headers 值来源链路
   - Tool schema 来源

4. **建议改进研究方法**：
   - 从"静态分析为主"改为"三角验证"
   - 动态抓包从"备选"提升为"必选"
   - 对比两个版本 diff

---

## Round 2

### User Decision

- mitmproxy 不采用（已决定只用静态分析）
- 其他建议需要评估优先级

### Sub Agent 优先级评估

| 建议 | 优先级 | 理由 | 工作量 |
|------|--------|------|--------|
| 端点选择与模型能力映射 | **高** | 直接决定请求/响应格式路径 | 中 |
| 错误响应 + retry/backoff | 中 | 行为一致性影响，但非核心翻译 | 中 |
| 非流式响应结构 | **中-高** | 非流式路径易产生翻译偏差 | 中 |
| Headers 值来源链路 | **高** | 规范强制要求"值来源" | 中 |
| Tool schema 来源 | 中 | tool_calls 一致性依赖 schema | 大 |

**关键洞察**：规范已把"headers 值来源"提升为硬性要求（SHALL），这是"行为一致性"的核心证据链。

---

## Conclusion

**Status**: completed
**Outcome**: partial (采纳部分建议)

### 用户决定

**采纳**（4 项）：
1. ✅ 端点选择与模型能力映射
2. ✅ Headers 值来源链路
3. ✅ 非流式响应结构
4. ✅ 错误响应 + retry/backoff

**不采纳**（1 项）：
- ❌ Tool schema 来源（工作量大，优先级中）

**其他决定**：
- mitmproxy 不采用，只用静态分析

### 下一步

更新 `openspec/changes/study-copilot-api-contract/` 文件以反映扩大后的范围。

---

## Round 3

### Sub Agent 审查更新

**确认**：4 项新增任务已正确反映建议。

**发现的轻微遗漏**：

1. **成功标准未覆盖新增范围**
   - 现有成功标准只提"请求字段、响应字段、headers、差异、翻译验证"
   - 未显式覆盖：端点选择、非流式响应、错误响应
   - 建议：在成功标准中增加对应条目

2. **"非 UI 代码"边界模糊**
   - Proposal 标注"UI/UX 代码不包含（除 headers 值来源追踪外）"
   - 任务 3.4 要求追踪 headers 值来源，可能需进入 UI 层
   - 建议：补充"仅限与 headers 值来源相关的最短路径追踪"

**结论**：范围基本足够覆盖"改进 proxy 翻译准确性"的目标。

---

## Round 4

### Main Agent 修复

已根据子代理建议修复：

1. ✅ 成功标准新增 3 项（端点选择、非流式响应、错误响应）
2. ✅ UI 代码边界澄清为"仅限 headers 值来源相关的最短路径追踪"

### Sub Agent 确认

**已达成共识。**

---

## Final Conclusion

**Status**: completed
**Outcome**: consensus

经过 4 轮辩论，主代理与子代理就 proposal 范围达成完全共识。

**最终范围变更**：
- 新增 4 项研究任务（2.4、3.4、4.4、4.5）
- 新增 3 项成功标准
- 澄清 UI 代码追踪边界
- 预估时间从 2 小时调整为 3 小时

**决定不采纳**：
- mitmproxy 动态抓包
- Tool schema 来源追踪

---
