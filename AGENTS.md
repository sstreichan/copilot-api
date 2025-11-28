# AGENTS.md

## 使用 bd (beads) 进行 Issue 跟踪

**重要提示**: 本项目使用 **bd (beads)** 进行 **所有** issue 跟踪。不要使用 markdown TODO 列表、任务清单或其他跟踪方式。

### 为什么使用 bd?

- **依赖感知**: 跟踪 issue 之间的阻塞关系和关联
- **Git 友好**: 自动同步到 JSONL，便于版本控制
- **为 Agent 优化**: JSON 输出、就绪工作检测、discovered-from 链接
- **防止重复**: 避免多个跟踪系统造成的混乱

### 快速开始

**查看就绪任务:**
```bash
bd ready --json
```

**创建新 issue:**
```bash
bd create "Issue 标题" -t bug|feature|task -p 0-4 --json
bd create "Issue 标题" -p 1 --deps discovered-from:bd-123 --json
```

**认领和更新:**
```bash
bd update bd-42 --status in_progress --json
bd update bd-42 --priority 1 --json
```

**完成任务:**
```bash
bd close bd-42 --reason "已完成" --json
```

### Issue 类型

- `bug` - 某些东西坏了
- `feature` - 新功能
- `task` - 工作项（测试、文档、重构）
- `epic` - 大型功能，包含子任务
- `chore` - 维护工作（依赖、工具）

### 优先级

- `0` - 紧急（安全、数据丢失、构建失败）
- `1` - 高（主要功能、重要 bug）
- `2` - 中（默认，不错但非必需）
- `3` - 低（优化、润色）
- `4` - 待办（未来想法）

### AI Agent 工作流程

1. **检查就绪工作**: `bd ready` 显示未阻塞的 issues
2. **认领任务**: `bd update <id> --status in_progress`
3. **开始工作**: 实现、测试、编写文档
4. **发现新工作?** 创建关联 issue:
   - `bd create "发现的 bug" -p 1 --deps discovered-from:<parent-id>`
5. **完成**: `bd close <id> --reason "完成"`
6. **一并提交**: 务必将 `.beads/issues.jsonl` 文件与代码更改一起提交，以保持 issue 状态与代码状态同步

### 自动同步

bd 自动与 git 同步:
- 更改后导出到 `.beads/issues.jsonl`（5秒防抖）
- 当 JSONL 较新时自动导入（例如 `git pull` 后）
- 无需手动导出/导入！

### MCP Server (推荐)

如果使用 Claude 或兼容 MCP 的客户端，请安装 beads MCP server:

```bash
pip install beads-mcp
```

添加到 MCP 配置（例如 `~/.config/claude/config.json`）:
```json
{
  "beads": {
    "command": "beads-mcp",
    "args": []
  }
}
```

然后使用 `mcp__beads__*` 函数代替 CLI 命令。

### 管理 AI 生成的规划文档

AI 助手在开发过程中经常创建规划和设计文档:
- PLAN.md, IMPLEMENTATION.md, ARCHITECTURE.md
- DESIGN.md, CODEBASE_SUMMARY.md, INTEGRATION_PLAN.md
- TESTING_GUIDE.md, TECHNICAL_DESIGN.md 等类似文件

**最佳实践: 使用专用目录存放这些临时文件**

**推荐做法:**
- 在项目根目录创建 `history/` 目录
- 将所有 AI 生成的规划/设计文档存放在 `history/`
- 保持仓库根目录整洁，专注于永久项目文件
- 仅在明确要求审查过去规划时才访问 `history/`

**.gitignore 示例条目（可选）**:
```
# AI 规划文档（临时）
history/
```

**好处:**
- ✅ 仓库根目录整洁
- ✅ 临时文档和永久文档清晰分离
- ✅ 可根据需要轻松排除版本控制
- ✅ 保留规划历史，便于追溯
- ✅ 浏览项目时减少干扰

### 重要规则

- ✅ **所有**任务跟踪都使用 bd
- ✅ 程序化使用时始终使用 --json 标志
- ✅ 使用 `discovered-from` 依赖链接发现的工作
- ✅ 在问"我该做什么"之前先检查 `bd ready`
- ✅ 将 AI 规划文档存放在 `history/` 目录
- ❌ 不要创建 markdown TODO 列表
- ❌ 不要使用外部 issue 跟踪器
- ❌ 不要重复跟踪系统
- ❌ 不要用规划文档 clutter 仓库根目录

更多详情，请查看 README.md 和 QUICKSTART.md.

## Build、Lint 和 Test 命令

- **构建:**
  `bun run build` (使用 tsup)
- **开发:**
  `bun run dev`
- **Lint:**
  `bun run lint` (使用 @echristian/eslint-config)
- **Lint & 修复暂存文件:**
  `bunx lint-staged`
- **测试所有:**
   `bun test`
- **测试单个文件:**
   `bun test tests/claude-request.test.ts`
- **启动（生产）:**
  `bun run start`

## 代码风格指南

- **导入:**
  使用 ESNext 语法。优先使用 `~/*` 绝对导入 `src/*` (见 `tsconfig.json`)
- **格式化:**
  遵循 Prettier (含 `prettier-plugin-packagejson`)。运行 `bun run lint` 自动修复
- **类型:**
  严格 TypeScript (`strict: true`)。避免 `any`；使用显式类型和接口
- **命名:**
  变量/函数使用 `camelCase`，类型/类使用 `PascalCase`
- **错误处理:**
  使用显式错误类 (见 `src/lib/error.ts`)。避免静默失败
- **未使用:**
  未使用的导入/变量是错误 (`noUnusedLocals`, `noUnusedParameters`)
- **Switch:**
  switch 语句不允许 fallthrough
- **模块:**
  使用 ESNext 模块，不使用 CommonJS
- **测试:**
   使用 Bun 内置测试运行器。测试放在 `tests/`，命名为 `*.test.ts`
- **Lint:**
  使用 `@echristian/eslint-config` (见 npm 详情)。包含风格、未使用导入、正则和 package.json 规则
- **路径:**
  从 `src/` 导入使用路径别名 (`~/*`)

---

此文件专为 agentic coding agents 定制。更多详情，见 `eslint.config.js` 和 `tsconfig.json` 中的配置。未检测到 Cursor 或 Copilot 规则。
