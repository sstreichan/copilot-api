# cli-options Specification

## Purpose
TBD - created by archiving change add-force-agent-initiator-option. Update Purpose after archive.
## Requirements
### Requirement: REQ-CLI-FORCE-AGENT 强制 Agent Initiator 选项

启动命令 MUST 支持 `--force-agent` 标志，强制所有 API 请求使用 `X-Initiator: agent`。

#### Scenario: 使用 --force-agent 启动
- Given: 用户执行 `copilot-api start --force-agent`
- When: 发送任何 API 请求
- Then: `X-Initiator` 头始终为 `"agent"`

#### Scenario: 不使用标志启动（默认行为）
- Given: 用户执行 `copilot-api start`（无标志）
- When: 发送仅含 user 消息的请求
- Then: `X-Initiator` 头为 `"user"`

#### Scenario: 短标志别名
- Given: 用户执行 `copilot-api start -fa`
- When: 发送任何请求
- Then: 行为等同于 `--force-agent`

