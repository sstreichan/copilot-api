# Claude Plugin Guide

## Overview

`claude-plugin/` 是 Claude Code marketplace 插件源码，用来在 `SubagentStart` 时注入 `__SUBAGENT_MARKER__...`，让代理服务端推断 `X-Initiator: agent`。

## Structure

- `.claude-plugin/plugin.json` - 插件元数据
- `hooks/hooks.json` - `SubagentStart` hook 声明
- `scripts/subagent-start-marker.js` - marker 生产脚本

## Project-Specific Rules

- hook 命令路径使用 `${CLAUDE_PLUGIN_ROOT}`，不要写死本地绝对路径
- marker 前缀必须保持 `__SUBAGENT_MARKER__`；服务端/子代理启动上下文依赖这个格式
- 修改 marker payload 结构时，要同时检查代理端的解析逻辑与 README 说明
- 仓库根 `.claude-plugin/marketplace.json` 是 marketplace catalog，和这里的源码目录配套使用

## Anti-Patterns

- 只改插件脚本，不同步 hook 声明或 marketplace 文档
- 更换 marker 前缀/JSON 结构而不更新消费端
- 把插件逻辑混进根目录运行时代码；这里应保持为独立插件包
