# Project Memory: Preferences

- Lint 结论只认 `bun run lint:all` / `bun run lint:all --fix`；不要把 LSP diagnostics 当作 lint clean/dirty 的依据。
- 对 `history/` 里的 draft 文档，默认只做状态判断；除非用户明确要求，否则不要自动把 Draft 改成 Completed 或替用户收口文档。
- 仓库根目录的本地 `.html` 文件可能是用户自留文件；除非用户明确要求，否则不要把它们判定为 scope creep 或擅自删除。
