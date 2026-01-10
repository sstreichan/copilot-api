# 提案：添加强制 Agent Initiator 选项

## Why

当前行为根据消息内容动态设置 `X-Initiator`，部分用户需要强制为 agent 以获得特定 API 行为。

## What Changes

添加 `--force-agent` (`-fa`) 启动选项，强制 `X-Initiator` 头始终为 `"agent"`。

## 范围

- 新增 CLI 标志 `--force-agent` (`-fa`)
- `State` 添加 `forceAgent` 属性
- 修改 `create-chat-completions.ts` 和 `create-responses.ts`

## 成功标准

- 使用 `-fa` 时所有请求为 `agent`
- 不使用时保持原始动态行为
