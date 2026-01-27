# Copilot API Documentation

## ADDED Requirements

### Requirement: Copilot API 契约文档

项目 **SHALL** 包含完整的 GitHub Copilot API 契约文档，记录请求/响应结构和 headers。

#### Scenario: 开发者查阅请求体结构

**Given** 开发者需要了解 Copilot API 请求格式
**When** 开发者打开 `docs/copilot-api-contract.md`
**Then** 文档应包含：
- Chat Completions API 请求体结构（TypeScript 接口）
- Responses API 请求体结构（TypeScript 接口）
- 两种 API 的差异对比表

#### Scenario: 开发者查阅 Headers

**Given** 开发者需要了解 Copilot API 所需的 headers
**When** 开发者查阅文档的 Headers 章节
**Then** 文档应列出：
- 所有请求 headers（名称、是否必选、值来源、用途）
- 所有响应 headers（名称、用途）

#### Scenario: 开发者查阅流式响应

**Given** 开发者需要了解 SSE 流式响应格式
**When** 开发者查阅文档的流式响应章节
**Then** 文档应包含：
- SSE 事件格式示例
- Delta 结构定义
- finish_reason 取值及含义

### Requirement: 与现有实现对比验证

我们的 proxy 实现 **MUST** 与官方 Copilot 插件行为保持一致。

#### Scenario: 验证类型定义一致性

**Given** 我们的请求体类型定义
**When** 与官方 `IEndpointBody` 对比
**Then** 应记录所有差异并评估是否需要更新

#### Scenario: 验证 Headers 一致性

**Given** 我们的 headers 配置
**When** 与官方 `postRequest` 函数对比
**Then** 应确保包含所有必要 headers
