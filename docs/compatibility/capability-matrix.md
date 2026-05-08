# OMP ACP 能力矩阵

本文档记录 `omp-acp` 对 ACP 能力的真实支持状态。`initialize` 输出必须与本表一致；没有实现和测试的能力不得声明。

## 状态说明

| 状态 | 含义 |
|---|---|
| 未实现 | adapter 当前没有实现该能力 |
| 待验证 | OMP runtime 可能支持，但 adapter 尚未完成 contract test |
| 已实现 | adapter 已实现并有自动化测试覆盖 |
| 不支持 | OMP runtime 或 ACP client 语义当前无法支持 |

## 当前矩阵

| 能力 | 当前状态 | 声明策略 | 验证要求 |
|---|---|---|---|
| ACP stdio transport | 已实现 | 内部可用；发布仍需通过 release checklist | `test/smoke/acp-stdio.test.ts` + `scripts/smoke-acp.mjs` |
| `initialize` | 已实现 | 声明已实现的 baseline session/new、text/resource_link/image/embedded prompt、session/list、text-history session/load、session/resume；`promptCapabilities.audio` 仍为 `false`，MCP/fork/close 仍不声明或为 `false` | `test/unit/acp/initialize.test.ts` + smoke tests |
| `session/new` | 已实现 | baseline ACP method 可用；不声明 session fork/close | `test/smoke/session-prompt.test.ts` |
| `session/prompt` text/resource_link | 已实现 | baseline text 与 resource_link 可用 | `test/unit/translate/prompt.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/cancel` | 已实现 | baseline ACP notification 可用；best-effort 传递 runtime cancel 并本地抑制 late chunks | `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/list` | 已实现 | 声明 `sessionCapabilities.list:{}`；按 OMP session JSONL header 扫描并支持 cwd filter | `test/unit/runtime/omp/sessions.test.ts` + `test/unit/acp/session-list-load.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/load` | 已实现 | 声明 `loadSession:true`；支持 text-only OMP JSONL history replay，unsupported history fails load rather than silently dropping | `test/unit/acp/session-list-load.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/close` | 不支持 | 当前 `@agentclientprotocol/sdk@0.12.0` 未暴露 agent-side `session/close` method；不声明 | SDK method inventory + capability test |
| `session/fork` | 不支持 | ACP fork request 只有 source session id，OMP branch/new-session 语义无法保证等价 fork；不声明 | Stage 6 boundary spec |
| `session/resume` | 已实现 | 声明 `sessionCapabilities.resume:{}`；switch OMP session path，不 replay history | `test/unit/acp/session-resume.test.ts` + `test/smoke/session-prompt.test.ts` |
| `agent_message_chunk` | 已实现 | runtime `message_update` 文本输出映射为 ACP message chunk | `test/unit/translate/events-message.test.ts` + `test/smoke/session-prompt.test.ts` |
| `agent_thought_chunk` | 已实现 | runtime thought/reasoning 标记映射为 ACP thought chunk | `test/unit/translate/events-message.test.ts` + `test/smoke/session-prompt.test.ts` |
| `tool_call` | 已实现 | runtime tool start events 与 host-tool bridge pending 状态会作为 ACP `session/update` 发出；无额外 initialize flag | `test/unit/translate/tools.test.ts` + `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `tool_call_update` | 已实现 | runtime tool update/end、tool failure/cancel、host-tool result/failure 会作为 ACP `session/update` 发出；无额外 initialize flag | `test/unit/translate/tools.test.ts` + `test/unit/runtime/omp/host-tools.test.ts` + `test/smoke/session-prompt.test.ts` |
| Structured edit diff | 已实现 | adapter 支持已测试的 OMP/fixture diff shape；未知 diff shape 作为 failed tool update，不伪造文本成功 | `test/unit/translate/diffs.test.ts` + `test/smoke/session-prompt.test.ts` |
| OMP host tool bridge | 已实现 | 仅 adapter registry 中显式注册的 host tool 会执行；未注册 host tool 回写 raw `host_tool_result` error；不声明 MCP/terminal/filesystem delegation | `test/unit/runtime/omp/host-tools.test.ts` + `test/contract/omp-rpc/tool-events.test.ts` + `test/smoke/session-prompt.test.ts` |
| Image prompt | 已实现 | 声明 `promptCapabilities.image:true`；ACP image blocks 作为 OMP prompt `images` 转发，不污染 prompt text | `test/unit/translate/prompt.test.ts` + `test/smoke/session-prompt.test.ts` |
| Embedded context | 已实现 | 声明 `promptCapabilities.embeddedContext:true`；embedded text/blob resources 转为 stable prompt text sections | `test/unit/translate/prompt.test.ts` |
| MCP HTTP | 未实现 | 不声明；尚无测试过的 OMP RPC/launch contract 将 ACP HTTP MCP server 接入 runtime session | Stage 6 boundary spec |
| MCP SSE | 未实现 | 不声明；尚无测试过的 OMP RPC/launch contract 将 ACP SSE MCP server 接入 runtime session | Stage 6 boundary spec |
| Permission request | 未实现 | 不声明；尚无 OMP runtime permission request event/policy contract | Stage 6 boundary spec |
| Filesystem delegation | 未实现 | 不声明 | Zed delegation smoke test |
| Terminal delegation | 未实现 | 不声明 | Zed delegation smoke test |
| Usage update | 不支持 | 当前 ACP SDK schema 无 `usage_update` session update 且 OMP usage event 未 contract-tested；不伪造 | Stage 6 boundary spec |
| OMP slash commands | 已实现 | 仅 discovery metadata；不执行、不作为可用 slash command 暴露 | `test/unit/runtime/omp/commands.test.ts` |
| OMP skills commands | 已实现 | 仅 discovery metadata；不执行、不作为可用 slash command 暴露 | `test/unit/runtime/omp/commands.test.ts` |
| `omp.extensions` manifest entries | 已实现 | 仅 package/module entry discovery metadata；不执行 extension，不声称 runtime-registered command names | `test/unit/runtime/omp/commands.test.ts` |


## 发布验证

发布前必须同时满足：

1. `npm run check` 通过；
2. `npm run build` 通过；
3. `npm run smoke:acp` 通过；
4. 真实 `omp --mode rpc` ready smoke 通过，或在 `docs/release-checklist.md` 记录不可用原因；
5. `scripts/smoke-zed.md` 中的 Zed 手工 smoke 全部通过。

当前环境已安装官方 Zed 1.1.6，可用绝对路径 `C:/Users/34404/AppData/Local/Programs/Zed/bin/zed.exe` 启动；Zed 手工 smoke 仍需按 `scripts/smoke-zed.md` 在 GUI 中执行，因此仍是发布阻塞项。

## 更新规则

每次把能力从「未实现」或「待验证」改为「已实现」时，必须同时提交：

1. 实现代码；
2. 对应自动化测试；
3. `initialize` 能力声明变更；
4. 本表状态更新；
5. 如涉及用户可见行为，同步更新 README 或 Zed 兼容文档。