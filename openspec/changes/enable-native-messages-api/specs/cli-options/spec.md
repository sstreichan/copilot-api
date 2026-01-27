# cli-options Spec Delta

## ADDED Requirements

### Requirement: REQ-CLI-NATIVE-MESSAGES 原生 Messages API 选项

启动命令 MUST 支持 `--native-messages` 标志，为 Claude 模型启用 Copilot 原生 `/v1/messages` 端点。

#### Scenario: 使用 --native-messages 启动并请求 Claude 模型
- Given: 用户执行 `copilot-api start --native-messages`
- When: 发送 model 为 `claude-*` 的 `/v1/messages` 请求
- Then: 请求直接透传到 Copilot `/v1/messages` 端点
- And: 响应直接透传回客户端，不做格式转换

#### Scenario: 使用 --native-messages 启动但请求非 Claude 模型
- Given: 用户执行 `copilot-api start --native-messages`
- When: 发送 model 为 `gpt-*` 或其他非 Claude 模型的请求
- Then: 静默 fallback 到现有逻辑（转换后发送到 `/chat/completions` 或 `/responses`）
- And: 用户无感知，行为与不使用标志时一致

#### Scenario: 不使用标志启动（默认行为）
- Given: 用户执行 `copilot-api start`（无 `--native-messages` 标志）
- When: 发送任何 `/v1/messages` 请求
- Then: 使用现有转换逻辑（Anthropic → OpenAI → Copilot）
- And: 新代码路径完全不执行

#### Scenario: 短标志别名
- Given: 用户执行 `copilot-api start -M`
- When: 发送 Claude 模型请求
- Then: 行为等同于 `--native-messages`

#### Scenario: 与其他标志组合
- Given: 用户执行 `copilot-api start -M -F -v`
- When: 发送 Claude 模型请求
- Then: `--native-messages`、`--force-agent`、`--verbose` 均生效
- And: 各标志功能互不干扰
