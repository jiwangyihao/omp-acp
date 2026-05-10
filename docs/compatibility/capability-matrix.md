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
| `initialize` | 已实现 | 声明已实现的 baseline session/new、text/resource_link/image/embedded prompt、session/list、rich OMP JSONL history session/load、session/resume、session/fork；`promptCapabilities.audio` 仍为 `false`，MCP/close 仍不声明或为 `false` | `test/unit/acp/initialize.test.ts` + smoke tests |
| `session/new` | 已实现 | baseline ACP method 可用；不声明 session close | `test/smoke/session-prompt.test.ts` |
| `session/prompt` text/resource_link | 已实现 | baseline text 与 resource_link 可用；实时 Assistant streaming 支持真实 OMP `assistantMessageEvent.text_delta` / `thinking_delta`，并在 `agent_end.messages` 中对未发送的最终 assistant 文本或思考做去重 fallback，确保返回 `end_turn` 前先发出可见 assistant update | `test/unit/translate/prompt.test.ts` + `test/unit/translate/events-message.test.ts` + `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/cancel` | 已实现 | baseline ACP notification 可用；best-effort 传递 runtime cancel 并本地抑制 late chunks | `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/list` | 已实现 | 声明 `sessionCapabilities.list:{}`；按 OMP session JSONL header 扫描并支持 cwd filter | `test/unit/runtime/omp/sessions.test.ts` + `test/unit/acp/session-list-load.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/load` | 已实现 | 声明 `loadSession:true`；按 OMP JSONL 顺序富回放可安全渲染的历史：文本、图片、resource/resource_link、assistant thinking、toolCall/toolResult、session info、model/thinking/service tier/mode/compaction/branch/custom visible events；发布前会在 `switch_session` 后的最终 OMP session 上再次执行 Ask 禁用二层防护；ACP-visible content、`rawInput`、`rawOutput` 复用共享净化边界，provider 私有 payload、signature、encrypted reasoning、secret/config/key/token/encrypted 字段会净化或跳过，无法安全映射的块不再使整次 load 失败 | `test/unit/runtime/omp/sessions.test.ts` + `test/unit/acp/session-list-load.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/close` | 不支持 | SDK 0.21.0 已暴露 agent-side `session/close` method，但 adapter 尚无可防御的 OMP close 语义；不声明 | SDK method inventory + capability test |
| `session/fork` | 已实现 | 声明 `sessionCapabilities.fork:{}`；第一阶段从源 OMP session 当前持久化 head fork 出新 session；不支持 message-bound fork / `_meta.messageId`；active prompt 下拒绝；发布前会在 fork 后的最终 OMP session 上再次执行 Ask 禁用二层防护 | `forkOmpSessionFile` unit + `test/unit/acp/session-fork.test.ts` + `test/smoke/session-prompt.test.ts` + `scripts/smoke-acp.mjs` + `scripts/smoke-sdk-client.mjs` + `scripts/probe-registry-matrix.mjs` |
| `session/resume` | 已实现 | 声明 `sessionCapabilities.resume:{}`；switch OMP session path，不 replay history；发布前会在 `switch_session` 后的最终 OMP session 上再次执行 Ask 禁用二层防护 | `test/unit/acp/session-resume.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/set_model` | 已实现 | SDK 0.21.0 unstable method；不通过 `initialize` 额外声明 capability。模型列表与当前值来自 ACP setup response `models` 与 `configOptions(model)`；setter 成功后 reread OMP state 并发送 `config_option_update` | `test/unit/acp/session-controls.test.ts` + `test/unit/acp/session-config.test.ts` + `test/smoke/session-prompt.test.ts` + `scripts/smoke-acp.mjs` + `scripts/smoke-sdk-client.mjs` + `scripts/probe-registry-matrix.mjs` |
| `session/set_config_option` | 已实现 | 仅支持 `model` 与 `thinking`；active prompt 下拒绝；thinking 按当前模型 metadata 动态裁剪。OMP-specific runtime knobs（steering/follow-up/interrupt/auto compaction）不暴露为 ACP config options，因此不会在 Zed 显示 | `test/unit/acp/session-controls.test.ts` + `test/unit/acp/session-config.test.ts` + `test/smoke/session-prompt.test.ts` + `scripts/smoke-acp.mjs` + `scripts/smoke-sdk-client.mjs` + `scripts/probe-registry-matrix.mjs` |
| `session/set_mode` | 已实现 | 首批仅支持 `default` mode；非 `default` 返回 invalid params；不声明多 mode，不伪造 OMP agent/mode 切换 | `test/unit/acp/session-config.test.ts` + `test/smoke/session-prompt.test.ts` + `scripts/smoke-acp.mjs` + `scripts/smoke-sdk-client.mjs` + `scripts/probe-registry-matrix.mjs` |
| `agent_message_chunk` | 已实现 | runtime `message_update` 文本输出映射为 ACP message chunk；支持真实 OMP `assistantMessageEvent.text_delta`，并在 `agent_end.messages` 中仅补发未被 streaming 覆盖的 assistant 文本 | `test/unit/translate/events-message.test.ts` + `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `agent_thought_chunk` | 已实现 | runtime thought/reasoning 标记映射为 ACP thought chunk；支持真实 OMP `assistantMessageEvent.thinking_delta`，并在 `agent_end.messages` 中仅补发未被 streaming 覆盖的 assistant 思考内容 | `test/unit/translate/events-message.test.ts` + `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `tool_call` | 已实现 | runtime tool start events 与 host-tool bridge pending 状态会作为 ACP `session/update` 发出；`rawInput` 经过共享净化后才进入 ACP-visible 内容；无额外 initialize flag | `test/unit/translate/tools.test.ts` + `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `tool_call_update` | 已实现 | runtime tool update/end、tool failure/cancel、host-tool result/failure 会作为 ACP `session/update` 发出；tool result content 与 `rawOutput` 经过共享净化后才进入 ACP-visible 内容；无额外 initialize flag | `test/unit/translate/tools.test.ts` + `test/unit/runtime/omp/host-tools.test.ts` + `test/smoke/session-prompt.test.ts` |
| Structured edit diff | 已实现 | adapter 支持已测试的 OMP/fixture diff shape；未知 diff shape 作为 failed tool update，不伪造文本成功 | `test/unit/translate/diffs.test.ts` + `test/smoke/session-prompt.test.ts` |
| OMP host tool bridge | 已实现 | 仅 adapter registry 中显式注册的 host tool 会执行；host tool `rawInput` / `rawOutput` 复用共享净化边界；未注册 host tool 回写已净化的 raw `host_tool_result` error；不声明 MCP/terminal/filesystem delegation | `test/unit/runtime/omp/host-tools.test.ts` + `test/contract/omp-rpc/tool-events.test.ts` + `test/smoke/session-prompt.test.ts` |
| Image prompt | 已实现 | 声明 `promptCapabilities.image:true`；ACP image blocks 作为 OMP prompt `images` 转发，不污染 prompt text | `test/unit/translate/prompt.test.ts` + `test/smoke/session-prompt.test.ts` |
| Embedded context | 已实现 | 声明 `promptCapabilities.embeddedContext:true`；embedded text/blob resources 转为 stable prompt text sections | `test/unit/translate/prompt.test.ts` |
| MCP HTTP | 未实现 | 不声明；尚无测试过的 OMP RPC/launch contract 将 ACP HTTP MCP server 接入 runtime session | Stage 6 boundary spec |
| MCP SSE | 未实现 | 不声明；尚无测试过的 OMP RPC/launch contract 将 ACP SSE MCP server 接入 runtime session | Stage 6 boundary spec |
| Permission request | 部分实现 | 不在 `initialize` 中额外声明；仅 OMP `extension_ui_request method=confirm` 映射到 ACP `session/request_permission`。通用 Ask、`select`、`input`、`editor` 不支持，也不依赖 ACP elicitation 或映射为 permission | `test/unit/acp/extension-ui.test.ts` + `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| OMP extension `setWidget` display | 已实现 | `widgetLines` 作为限长、按 `widgetKey` 去重的 `agent_thought_chunk` 展示，用于 thought/progress；清除或空 widget 不发送 update；不渲染复杂 extension widget，不依赖 ACP elicitation | `test/unit/acp/extension-ui.test.ts` + `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| OMP Ask tool exposure | 已禁用 | 默认 OMP 启动不使用静态 `--tools` 白名单；adapter 注入 extension，并在 `session/new` setup 中基于 `dumpTools` 仅移除 active `ask`；`session/load`、`session/resume`、`session/fork` 发布前会在最终 OMP session 上执行同样的 Ask 禁用二层防护；保留 OMP settings、插件/extension、MCP 与其他工具 | `test/runtime/omp/command.test.ts` + `test/unit/session/manager.test.ts` |
| Filesystem delegation | 未实现 | 不声明 | Zed delegation smoke test |
| Terminal delegation | 未实现 | 不声明 | Zed delegation smoke test |
| Usage update | 未实现 | SDK 0.21.0 已有 `usage_update` session update 类型，但 OMP usage event 尚未 contract-tested；不伪造 | Stage 6 boundary spec |
| OMP slash commands | 已实现 | 仅 discovery metadata；不执行、不作为可用 slash command 暴露 | `test/unit/runtime/omp/commands.test.ts` |
| OMP skills commands | 已实现 | 仅 discovery metadata；不执行、不作为可用 slash command 暴露 | `test/unit/runtime/omp/commands.test.ts` |
| `omp.extensions` manifest entries | 已实现 | 仅 package/module entry discovery metadata；不执行 extension，不声称 runtime-registered command names | `test/unit/runtime/omp/commands.test.ts` |


## 发布验证

发布前必须同时满足：

1. `npm run check` 通过；
2. `npm run build` 通过；
3. `npm run smoke:acp` 通过；
4. `npm run smoke:sdk-client` 通过；
5. `npm run smoke:omp-rpc-controls:required` 通过；顶层 skip、timeout、failure、`dumpTools` 不可用，或 `ask` 存在但无法验证移除/恢复，均为发布门禁失败；若 active tools 已不含 `ask`，`set_active_tools.skipped` 记录为已满足 ask 禁用边界；
6. `npm run smoke:omp-rpc-controls:optional` 可作为开发机诊断运行，但不得作为发布通过条件；
7. `npm run validate:registry` 通过；
8. `npm run validate:acpx` 完成，且没有 unexpected draft failure；
9. 真实 `omp --mode rpc` controls smoke 结果已在 `docs/release-checklist.md` 记录；
10. `scripts/smoke-zed.md` 中的 Zed 手工 smoke 全部通过。

当前环境已安装官方 Zed 1.1.6，可用绝对路径 `C:/Users/34404/AppData/Local/Programs/Zed/bin/zed.exe` 启动；Zed 手工 smoke 仍需按 `scripts/smoke-zed.md` 在 GUI 中执行，因此仍是发布阻塞项。

## 更新规则

每次把能力从「未实现」或「待验证」改为「已实现」时，必须同时提交：

1. 实现代码；
2. 对应自动化测试；
3. `initialize` 能力声明变更；
4. 本表状态更新；
5. 如涉及用户可见行为，同步更新 README 或 Zed 兼容文档。