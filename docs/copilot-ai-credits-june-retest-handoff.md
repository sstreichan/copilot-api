# GitHub Copilot AI Credits 六月复测交接

## 目标

在 2026 年 6 月重新验证 GitHub Copilot 从 premium quota / premium interactions 计费向 GitHub AI Credits / token-based billing 迁移后，真实 Copilot backend、usage API 与 VS Code Copilot 插件源码是否已经对齐。

本交接文件用于未来 agent 复现 2026 年 5 月底的检查流程，并在 6 月对同一批账号和后端端口重新测试。

## 背景结论（截至 2026-05-28）

- `.vendor/vscode` 是 VS Code 主仓库的 very shallow sparse clone。
- Copilot 插件源码目录是 `.vendor/vscode/extensions/copilot`。
- 当时检查到的 `.vendor/vscode` HEAD 是 `1897fa34033285d932624a72654cb1cf943f634f`。
- 当时检查到的 HEAD 日期是 `2026-05-27T15:18:48Z`。
- 旧的 `microsoft/vscode-copilot-chat` 仓库已 archived，活跃开发迁入 `microsoft/vscode` 主仓库。
- 2026 年 5 月底，VS Code Copilot 插件源码已经出现 AI Credits / token-based billing 相关字段、UI 和错误文案。
- 2026 年 5 月底，4142 / 4145 / 4146 真实 Copilot backend 尚未返回这些新字段。

## 需要重新验证的问题

1. 6 月后 Copilot backend 是否开始返回 AI Credits / token-based billing 字段。
2. VS Code Copilot 插件源码里与 quota、charging、headers、initiator 相关的实现是否继续变化。
3. `X-Initiator: agent` 与 user / agent 交互类型是否影响计费、headers 或 usage 形态。
4. 4142 / 4145 / 4146 的 `/models` catalog 中哪些模型真实可用，而不是只存在于 catalog。
5. usage API 是否开始返回 AI Credits / token usage 相关的新字段。

## 建议使用的 skills

- `copilot-backend-tester`：测试 Copilot 真实 backend、usage API、headers/body。
- `multi-source-inquiry`：查 GitHub 官方公告、Copilot billing 文档、VS Code / Copilot 相关 release note。
- `karpathy-guidelines`：若需要修改 repo 文件，先加载并遵守外科式改动原则。
- `handoff`：若复测后还要交接下一轮，把结论继续写成文档。

## 更新 VS Code Copilot 源码

不要 full clone 整个 VS Code 仓库。继续使用 very shallow + sparse checkout：

```bash
cd /home/cpf/code-inside/copilot-api/.vendor/vscode
git fetch --depth=1 --filter=blob:none origin main
git reset --hard origin/main
git sparse-checkout set extensions/copilot
git log -1 --format='%H %cI %s'
```

确认目录：

```bash
pwd
git remote -v
git sparse-checkout list
ls extensions/copilot
```

预期 Copilot 插件源码目录：

```text
/home/cpf/code-inside/copilot-api/.vendor/vscode/extensions/copilot
```

## 源码搜索种子

以下词只是 seeds，不是最终关键词。搜索时要围绕语义继续扩展：

```bash
cd /home/cpf/code-inside/copilot-api/.vendor/vscode
rg -n 'token_based_billing|token_prices|copilot_usage|total_nano_aiu|nano_aiu|aiu|credits|premium_interactions|premium|quota|overage|billing|multiplier|model_picker_price_category|model_picker_enabled|policy.state|X-Initiator|X-Interaction-Type|initiator|agent' \
  extensions/copilot/src extensions/copilot/package.json extensions/copilot/package.nls.json
```

重点关注：

- quota / usage 状态读取
- model picker 是否显示 price category
- token-based billing 文案
- overage / exhausted / quota reset 文案
- request header 中 initiator / interaction type 的生成逻辑
- response header 的解析和转发逻辑

## 真实 backend 复测要求

测试 4142 / 4145 / 4146 的真实 backend。所有 Copilot 请求固定带：

```text
X-Initiator: agent
```

不要只看 `/models` 里是否存在模型 id；必须同时检查：

- `model_picker_enabled`
- `policy.state`
- `supported_endpoints`
- 最终请求是否真的返回 `200`

如果 `gpt-5.5` 在 catalog 里存在但 `model_picker_enabled=false` 或 `policy.state=disabled`，不能当作可用模型。

## 2026-05-28 的实测基线

### 4142

- 账号类型：business。
- `gpt-5.5` 的 `/responses` 当时可用。
- premium quota 当时已经 overage。
- 当时 header snapshot 示例：

```text
ent=300&ov=1382.4&ovPerm=true&rem=0.0&rst=2026-06-01T00:00:00Z&totRem=0.0
```

解释：

- `rem=0.0`：premium quota remaining 为 0。
- `ovPerm=true`：overage permitted。
- `ov=1382.4`：已产生 overage。

### 4145

- 账号类型：individual。
- `gpt-5.5` catalog entry 当时存在但 disabled：
  - `model_picker_enabled=false`
  - `policy.state=disabled`
- 当时可用模型示例：
  - `gpt-5.4-mini` `/responses`
  - `claude-haiku-4.5` `/v1/messages`

### 4146

- 账号类型：individual。
- `gpt-5.5` catalog entry 当时存在但 disabled。
- 当时可用模型示例：
  - `gpt-5.4-mini` `/responses`
  - `claude-sonnet-4.6` `/v1/messages`

## 复测时要观察的新字段

在完整 response headers 和 response body 中查找：

- `token_based_billing`
- `billing.token_prices`
- `model_picker_price_category`
- `usage.copilot_usage`
- `copilot_usage.total_nano_aiu`
- `total_nano_aiu`
- `nano_aiu`
- `aiu`
- `x-quota-snapshot-premium_interactions`
- `x-usage-ratelimit-session`
- `x-usage-ratelimit-weekly`
- `billing.multiplier`

截至 2026-05-28，真实 backend 仍返回旧形态：

- `x-quota-snapshot-premium_interactions`
- `x-usage-ratelimit-session`
- `x-usage-ratelimit-weekly`
- `billing.multiplier`
- ordinary token counts / cache token counts

截至 2026-05-28，真实 backend 未见：

- `token_based_billing=true`
- `billing.token_prices`
- `model_picker_price_category`
- `usage.copilot_usage`
- `copilot_usage.total_nano_aiu`

## usage API 复测

usage API 要直打 GitHub API：

```bash
curl -i -sS https://api.github.com/copilot_internal/user \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28"
```

注意：

- 用进程参数或本地配置中的 GitHub token。
- 不要使用 `/token` 返回的 Copilot token 打 usage API。
- 保存完整 headers/body，但文档和回复中必须脱敏 token。
- 重点比较 `quota_remaining`、overage、premium quota、AI credits / token usage 字段。

## 建议输出格式

复测完成后输出四块：

1. 源码变化
   - `.vendor/vscode` 最新 HEAD、日期、相关 diff / grep 结果。
2. backend 行为
   - 4142 / 4145 / 4146 每个端口的模型可用性、请求状态、headers/body 新旧字段。
3. usage API 行为
   - 是否出现 AI Credits / token usage 相关字段。
4. 结论
   - “已经 rollout”、“部分 rollout”、“仍未 rollout”或“无法确认”，并给证据。

## 安全与脱敏

- 不要把 GitHub token、Copilot token、cookie、authorization header 写入文档。
- 如果保存原始响应，建议放入本地 ignored 目录，例如 `tmp/`。
- 对外报告只保留必要字段和脱敏后的 header/body 摘要。

## 停止条件

满足以下条件即可停止：

- `.vendor/vscode/extensions/copilot` 已更新到当日最新 shallow sparse checkout。
- 已 grep 并记录 quota / charging / headers / initiator 相关源码变化。
- 4142 / 4145 / 4146 均完成真实 backend 测试，且每个端口至少有一个真实可用模型请求成功或明确失败原因。
- usage API 已直打并记录关键字段。
- 已明确判断新 AI Credits 字段是否在 backend/usage API 中出现。
