# Stage 5: OMP session、config、commands 与 extension UI request 设计

> 对应总体计划「阶段 5」。本阶段只实现可本地验证的 OMP-native discovery 与 session list/load 基线，不实现 MCP、permission、filesystem/terminal delegation、真实 extension runtime 执行或发布流程。

## 目标

- 按 OMP 文档读取默认 session 存储：`~/.omp/agent/sessions/--<cwd-encoded>--/*.jsonl`。
- 支持 ACP `session/list` 与 `session/load` 基线：列出 session metadata；load 时启动 runtime 并把 runtime 切到对应 OMP session path。
- 提供 OMP config discovery helpers：`.omp` 优先，其次 `.claude`、`.codex`、`.gemini`；user roots 在 project roots 前；project discovery 支持 cwd 参数。
- 提供 slash command discovery helpers：区分 built-in、file-based、skills、extension commands；只暴露可识别且可测试的命令 metadata，不执行命令。
- 提供 `omp.extensions`/`pi.extensions` package manifest discovery helper；保持路径字符串和 manifest order，不安装插件。
- 明确处理未支持的 `extension_ui_request` runtime event：prompt 必须失败，而不是静默丢弃。
- 增加 Zed 兼容文档，说明本地开发运行方式和仍未实现限制。

## 非目标

- 不实现 session fork/resume/close。
- 不回放完整历史消息到 ACP client；`loadSession` 只创建可继续 prompt 的 ACP session，并通过 runtime `switch_session` fixture/contract 切换 OMP session path。历史回放留给后续阶段。
- 不执行 slash command、skills 或 extension command。
- 不声明 MCP HTTP/SSE、permission request、terminal/filesystem delegation、image/embedded context。
- 不移除 `private: true`，不添加 `npx -y omp-acp` 发布指令。

## 数据契约

### Session 文件

- OMP session header 位于 JSONL 第一条有效 JSON object：`{ type:"session", id, cwd, timestamp, title?, parentSession? }`。
- `listOmpSessions({ cwd?, agentDir? })` 返回 `{ sessionId, cwd, title?, updatedAt, path }[]`，按 `updatedAt` 降序；`updatedAt` 来源为最后一条带 string `timestamp` 的有效 JSONL entry，若没有则用 header `timestamp`，再无则用文件 mtime ISO string。
- cwd filter 必须通过扫描 agent session root 下所有 session dirs 并匹配 header cwd 实现；不得只依赖 directory name encoding，因为真实 OMP Windows home 内路径可能存成 `-source-repos-...` 而不是包含 drive/home segments。
- `encodeOmpSessionCwd(cwd)` 仅作为 fallback/fixture helper：去掉 leading slash，然后把 `/`、`\\`、`:` 替换为 `-`，并加 `--` 前后缀；list/load 正确性以 header cwd 扫描为准，Windows/POSIX 字符串必须可测试。
- malformed、missing header、非 JSON 行不会让 list 失败；该文件跳过并记录 diagnostics（测试可断言 skipped count）。

### ACP list/load

- `unstable_listSessions` 调用 session discovery，并返回 ACP `ListSessionsResponse`：`{ sessions, nextCursor? }`；每个 `SessionInfo._meta.ompSessionPath` 保存 adapter 私有 path。
- `loadSession` 只有在实现历史回放后才可声明。本阶段 load 契约为 text-history baseline：
  1. 根据 ACP `sessionId` 找到 session file path；
  2. 解析 JSONL 中 `type:"message"` entries，按文件顺序把 role `user`/`assistant` 的 string 或 text-block content 转成 ACP `user_message_chunk` / `agent_message_chunk`；
  3. 遇到 unsupported role/content 时 `loadSession` 失败，不静默丢弃历史；
  4. 启动 runtime，等待 ready；
  5. 发送 `runtime.request("switch_session", { sessionPath })`；
  6. 在 SessionManager 中发布 ACP session record；
  7. 通过 `connection.sessionUpdate` replay 全部 parsed history，并在 replay drain 后返回 ACP `LoadSessionResponse` `{}`。
- `initialize` 只有在上述 text-history replay、runtime switch、error-on-unsupported 全部测试通过后声明 `loadSession: true` 与 `sessionCapabilities.list: {}`；不得声明 fork/resume/close。

### Commands / config

- `discoverConfigRoots({ cwd, home })` 输出 roots：user `.omp/agent`、`.claude`、`.codex`、`.gemini`，然后 project `.omp`、`.claude`、`.codex`、`.gemini`。
- `discoverSlashCommands({ cwd, home })` 读取 `commands/*.md`，返回 `{ name, source, scope, path, kind:"file", supported:false }`。Dedup 总顺序：source priority (`.omp` > `.claude` > `.codex` > `.gemini`) 先于 scope，scope 中 project 优先于 user；仍相同则按 deterministic path order。
- built-in commands 由 adapter 常量提供，至少包括 `clear` 且标记 `{ supported:false }`，避免暴露为可执行能力。
- skills commands 来自 `skills/*/SKILL.md`，kind `skill`，source `.omp`，scope 为 project/user，name 为 skill directory basename，`supported:false`。
- extension manifest discovery 只读取 package/module entry metadata，不声称知道 runtime-registered command names：`package.json` 中 `omp.extensions` 优先于 legacy `pi.extensions`；字段必须是 string array，entry path 相对 package directory 解析；输出 `{ kind:"extension", name:<basename>, path, manifestPath, manifestKey:"omp.extensions"|"pi.extensions", supported:false }`。若两者同时存在，仅使用 `omp.extensions`。

## Extension UI request

- runtime event `{ type:"extension_ui_request", method, id }` 当前 unsupported。
- `translateRuntimeEventToSessionUpdate` 必须抛 `UnsupportedRuntimeEventError`，message 包含 `extension_ui_request` 和 method/id（如有）。
- session prompt handler 因该错误 reject；不发送普通 assistant message。

## 文件范围

- 新增 `src/runtime/omp/config.ts`
- 新增 `src/runtime/omp/sessions.ts`
- 新增 `src/runtime/omp/commands.ts`
- 新增 `src/acp/handlers/session-list.ts`
- 新增 `src/acp/handlers/session-load.ts`
- 修改 `src/session/manager.ts`
- 修改 `src/acp/server.ts`
- 修改 `src/acp/capabilities.ts`
- 修改 `src/translate/events.ts`
- 扩展 `src/testing/script-rpc-process.ts`
- 新增 `test/unit/runtime/omp/config.test.ts`
- 新增 `test/unit/runtime/omp/sessions.test.ts`
- 新增 `test/unit/runtime/omp/commands.test.ts`
- 新增 `test/unit/acp/session-list-load.test.ts`
- 扩展 `test/unit/translate/events-message.test.ts`
- 扩展 `test/smoke/session-prompt.test.ts` 或 `test/smoke/acp-stdio.test.ts`
- 新增 `docs/compatibility/zed.md`
- 更新 README、capability matrix、总体 plan

## 验收标准

- `session/list` 与 `session/load` 均有 fixture 覆盖；load 会向 runtime 发送 `switch_session` 并保留 session cwd。
- `.omp` 与 `.claude` 相关 discovery 顺序和 dedup 有测试。
- `omp.extensions` 与 legacy `pi.extensions` manifest discovery 有测试。
- `extension_ui_request` prompt 失败且不静默丢弃。
- capability matrix 与 `initialize` 输出一致：只声明 `loadSession:true` 和 `sessionCapabilities.list:{}`。
- README / Zed 文档给出本地开发配置和当前限制。
- `npm run check` 通过。