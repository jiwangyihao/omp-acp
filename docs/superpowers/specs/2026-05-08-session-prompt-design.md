# Stage 3: session/new、session/prompt 与消息流设计

> 对应总体计划「阶段 3：session/new、session/prompt 与消息流」。本阶段把 ACP session handler 接入 Stage 2 的 OMP RPC client，但只实现文本 prompt、message/thought 流和取消边界；tool、edit、commands、MCP、image、embedded context、session list/load/resume/fork/close 仍不得声明。

## 目标

- `session/new` 创建一个 ACP session，并启动/持有一个 OMP RPC runtime client。
- `session/prompt` 接收 ACP text prompt，转换为 OMP RPC request，并通过 `session/update` 推送 OMP message/thought chunks。
- `session/cancel`/ACP `cancel` 通知能停止当前 prompt 的普通转发；如 runtime 支持 cancel request，则尽力发送；不支持或失败时仍在本地终止转发并以 `stopReason: "cancelled"` 完成 prompt。
- runtime crash、RPC parse failure、response error 等必须作为 prompt 失败暴露，不能伪装成 assistant 文本。
- `initialize` 在本阶段完成后只声明已实现的 baseline text prompt 能力，继续声明 image/audio/embeddedContext/MCP/session list/load/resume/fork 为 false/absent。

## 非目标

- 不实现 tool_call/tool_call_update、structured edit diff、host tool bridge。
- 不实现 MCP HTTP/SSE、filesystem delegation、terminal delegation。
- 不实现 session list/load/resume/fork/close。
- 不把 runtime 错误、extension_error 或 transport failure 包装为 `agent_message_chunk`。
- 不发布 npm 包，不移除 `private: true`。

## 已知约束

- 直接在主分支开发，不创建 worktree 或实现分支。
- 必须 TDD：先添加失败测试，再实现最小代码，再验证通过。
- stdout 只能输出 ACP JSON-RPC/NDJSON frame；runtime diagnostics 进入 stderr 或内部 diagnostics，不能污染 ACP stdout。
- 本阶段不依赖真实 OMP。smoke/contract 使用 `src/testing/script-rpc-process.ts` fixture 通过 `process.execPath --import tsx ...` 启动。

## 设计

### Runtime 注入

- `startAcpServer` 增加可选 `runtimeFactory?: RuntimeFactory`，默认启动真实 `startOmpRpcClient()`。
- `RuntimeFactory` 输入至少包含 `{ cwd: string; mcpServers: unknown[] }`，输出 `RuntimeAdapter`。
- CLI 默认不变；测试 smoke 必须通过环境变量或测试入口把 runtime command 指向 `src/testing/script-rpc-process.ts` fixture，不能依赖本机真实 OMP。

### Session manager

- `SessionManager` 管理 `sessionId -> SessionRecord`。
- `createSession(params)` 生成唯一 session id，启动 runtime，等待 `runtime.ready`，返回 `{ sessionId }`。
- 每个 session 同时只允许一个 active prompt；新 prompt 到来前若旧 prompt 仍 active，应取消旧 prompt 或拒绝。本阶段采用明确拒绝并测试错误路径，避免并发 turn 语义不清。
- `closeAll()` 供 server cleanup/测试使用；`startAcpServer` 必须在 `AgentSideConnection.closed` settle 后调用 `SessionManager.closeAll()`，因为本阶段不暴露 ACP `session/close` capability，客户端断连是释放 OMP runtime 的唯一协议边界。

### Prompt 转换

- `translatePromptToOmpRequest(params)` 支持 ACP baseline `type: "text"` 和 `type: "resource_link"` content blocks。
- 多个 blocks 按顺序合并为一个文本 prompt，使用两个换行分隔，保留顺序。
- `text` block 输出原始 `text`；`resource_link` block 输出稳定文本引用，格式为 `[Resource: <title-or-name>] <uri>`，如有 `description` 则追加换行说明；不得尝试读取文件内容或声明 embedded context。
- 遇到 image/audio/resource 等 unsupported block，抛出明确错误；不得静默丢弃。
- OMP request method 采用测试契约名 `prompt`，params 至少包含 `{ sessionId, prompt }`。真实 OMP 若后续需要不同 method/shape，必须先以 contract 更新本 spec 和 translator，不在 handler 内散落兼容分支。

### Event 转换

- `message_update` 映射规则：
  - 若 raw.kind/raw.role/raw.channel 表示 thought/reasoning，或 raw.type/message kind 明确是 thought，则推送 `agent_thought_chunk`。
  - 其他文本输出推送 `agent_message_chunk`。
  - 文本字段从 `content`、`text`、`message` 中按顺序提取；非字符串或空字符串不推送普通 chunk。
- `agent_start` 暂不推送用户可见内容。
- `extension_error` 转为 prompt failure，不转为 assistant message。
- `host_tool_call`、`host_tool_cancel` 等已知但本阶段未实现的 action event 必须 fail active prompt，错误信息说明该 runtime event unsupported；不得忽略后继续返回 `end_turn`。
- 未识别且非 action 的 telemetry/future event 暂不推送，保留到 Stage 4+。

### Prompt lifecycle

- prompt 开始时注册 runtime event listener。
- event listener 只在当前 prompt active 且未 cancel 时转发普通 message/thought chunks。
- runtime response 成功后返回 `{ stopReason: "end_turn" }`，除非已 cancel。
- runtime response error、runtime crash、parse failure、extension_error 均 reject `session/prompt`，让 ACP 返回 JSON-RPC error。
- cancel 后：
  - 标记 active prompt cancelled；
  - 尽力调用 `runtime.request("cancel", { sessionId })`，忽略该 cancel request 本身失败；
  - 后续普通 message/thought events 不再转发；
  - prompt response 返回 `{ stopReason: "cancelled" }`。
- prompt listener 必须保证 ACP 层可观察到的 `session/update` 在对应 `session/prompt` response 之前送出；smoke test 需要断言 update-before-response 顺序。
- cancel race 需要覆盖 late message/thought event 和 late success response：cancel 后 late 普通 chunk 不得泄漏，最终 `stopReason` 必须保持 `cancelled`。

## 文件范围

- 新增 `src/session/manager.ts`
- 新增 `src/session/cancellation.ts`
- 新增 `src/translate/prompt.ts`
- 新增 `src/translate/events.ts`
- 新增 `src/translate/errors.ts`
- 新增 `src/acp/handlers/session-new.ts`
- 新增 `src/acp/handlers/session-prompt.ts`
- 新增 `src/acp/handlers/session-cancel.ts`
- 修改 `src/acp/server.ts`
- 修改 `src/acp/capabilities.ts`
- 扩展 `src/testing/script-rpc-process.ts`
- 新增/修改测试：
  - `test/unit/translate/prompt.test.ts`
  - `test/unit/translate/events-message.test.ts`
  - `test/unit/session/manager.test.ts`
  - `test/smoke/session-prompt.test.ts`
  - 更新 `test/unit/acp/initialize.test.ts` 与旧 phase 1 smoke guard 断言

## 验收标准

- 新 session 可接受一个 text prompt，并产生 ACP `session/update` + `session/prompt` response，且 update 在 response 前可观察。
- 新 session 可接受 baseline `resource_link` prompt block，并按稳定文本引用传入 OMP prompt。
- message chunk 与 thought chunk 不混流。
- runtime error / `extension_error` / known unsupported action event 不会伪装为 assistant message。
- cancel 后不会继续向已取消 prompt 推送普通完成事件；即使 runtime 随后发送 late success response，prompt response 仍为 `stopReason: "cancelled"`。
- smoke tests 通过 fixture seam 覆盖 session/new、prompt、cancel 和 error，不依赖真实 OMP。
- `initialize` 只声明 baseline text/resource_link prompt 能力：image/audio/embeddedContext 仍为 false；不声明 session list/load/resume/fork、MCP true、tool/edit/terminal/filesystem 能力。
- `npm run check` 通过。