# ACP adapter 架构收敛与分叉消除设计

## 背景

`omp-acp` 已经实现 OMP RPC 到 ACP 的主要桥接能力，包括实时 prompt 事件、工具调用、host tool bridge、session/list/load/resume/fork、session controls、extension UI `confirm` / `setWidget`。近期在富历史回放中发现一个典型分叉问题：`session/load` 历史回放原本在 `src/runtime/omp/sessions.ts` 中单独维护工具展示逻辑，没有复用实时工具事件转换 `src/translate/tools.ts`，导致历史中的 bash 工具只显示 `Bash` 或工具名，而不是实时路径中已有的 `Bash: <command>` 和 `$ <command>`。

虽然该问题已通过复用 `toolExecutionStartToUpdate()` / `toolExecutionEndToUpdate()` 修复，但进一步审查发现仍存在多个类似风险：同一类 ACP 可见数据在实时路径、历史路径、host tool 路径或 session 生命周期路径中分别维护。这类分叉会导致行为漂移、隐私边界不一致，以及 fixture 自证契约掩盖真实 OMP RPC 差异。

本规格用于全面收敛这些分叉，目标是在不扩大 ACP capability 声明、不引入迁移阶段、不牺牲安全边界的前提下，把重复的转换和协议边界归一到共享模块。

## 目标

- 统一 ACP 可见工具 `rawInput` 净化策略，实时工具事件、历史工具回放、host tool 展示都不得泄漏 provider 私有字段、secret、token、base URL、raw config 或 key。
- 统一实时 `message_update` / `agent_end.messages` 与历史 assistant 消息映射，确保实时 prompt 在返回 `end_turn` 前已经发送可见 assistant 文本、思考或安全内容。
- 统一 ACP `ContentBlock` 白名单和 tool result content 提取策略，避免实时和历史对 image/resource/resource_link/未知文本块表现不一致。
- 统一 `extension_ui_request` 方法分类与错误格式化，避免 bridge 与通用 event translator 各自维护方法矩阵。
- 统一 session setup state 的公共响应投影，防止 `runtimeSessionId` 等内部字段从 load/resume/fork 泄漏到 ACP 响应。
- 增强真实 OMP RPC contract smoke，覆盖 `dumpTools` / `set_active_tools`，避免 fixture 与真实 runtime 分叉。
- 统一 host tool cancel 的 id 归一化，明确 OMP call id 与 ACP toolCallId 的边界。
- 保持 stdout 只输出 ACP JSON-RPC/NDJSON；诊断仍走 stderr 或测试断言。

## 非目标

- 不新增未实现的 ACP initialize capability。
- 不实现通用 ACP elicitation，也不改变 Ask 工具禁用策略的产品边界。
- 不改变 OMP session JSONL 文件格式。
- 不把 provider-private payload、encrypted reasoning、signature 或 raw provider config 显示给 ACP client。
- 不把工具调用伪装成普通 assistant 文本。
- 不重写整个 adapter 架构；本次只收敛已经识别出的重复边界。
- 不要求 Zed/ZedG GUI 手工 smoke 作为本规格实现完成的自动化验收条件；GUI smoke 仍属于发布门禁。

## 现状问题清单

### 1. 实时工具 `rawInput` 与历史回放净化分叉

现状：

- 历史回放在 `src/runtime/omp/sessions.ts` 中调用 `sanitizeToolInput(parseToolInput(...))`，过滤 `provider`、`signature`、`encrypted`、`apiKey`、`token`、`secret`、`baseURL`、`config`、`key` 等字段。
- 实时工具转换在 `src/translate/tools.ts` 的 `toolExecutionStartToUpdate()` 中直接把 `raw.rawInput/input/args` 写入 ACP `tool_call.rawInput`。

风险：

- 同一个 OMP tool args 在历史路径被净化，在实时路径可能泄漏。
- 后续维护私有 key 列表时可能只改历史路径。

设计：

- 新增共享模块 `src/translate/safety.ts`，提供：
  - `sanitizeToolInput(value: unknown): unknown`
  - `isPrivateAcpVisibleKey(key: string): boolean`
  - `parseToolInput(value: unknown): unknown`
- `toolExecutionStartToUpdate()` 在设置 `rawInput` 前必须调用 `sanitizeToolInput(parseToolInput(...))`。
- `sessions.ts` 删除本地 `sanitizeToolInput` / `isPrivateHistoryKey` / `parseToolInput` 实现，改用共享模块。
- host tool bridge 在发 `tool_call.rawInput` 前也调用同一个 `sanitizeToolInput()`。

验收：

- 实时 `tool_execution_start` 携带 `providerApiKey`、`token`、`secret`、`baseURL`、`config`、`key`、`accessKey`、`plain_key`、`api-key` 时，ACP `rawInput` 不包含这些字段。
- 历史 `toolCall.arguments` 为对象或 JSON 字符串时，净化结果与实时路径一致。
- 非敏感字段如 `command`、`cwd`、`path`、`query` 保留。

### 2. 实时 Assistant 消息流与历史回放分叉

现状：

- 历史回放在 `src/runtime/omp/sessions.ts` 中读取持久化 `AssistantMessage.content[]`，可以把 assistant 文本、thinking、安全 content block 转成 ACP `agent_message_chunk` / `agent_thought_chunk`。
- 实时路径 `src/translate/events.ts` 的 `translateMessageUpdate()` 主要读取 `raw.content`、`raw.text`、`raw.message` 字符串。
- 真实 OMP RPC 的 `message_update` 事件形状是 `{ type:"message_update", message: AgentMessage, assistantMessageEvent }`；assistant 文本增量在 `assistantMessageEvent.type === "text_delta"` 的 `delta` 字段中，思考增量在 `thinking_delta.delta` 中，错误在 `assistantMessageEvent.error.errorMessage` 中。
- `src/acp/handlers/session-prompt.ts` 把 `agent_end` 只当作 turn completion signal，当前不读取 `agent_end.messages` 作为最终 assistant 消息兜底。

风险：

- 真实 runtime 一进入 assistant 输出阶段时，结构化 `message_update` 可能被实时 translator 返回 `undefined`，随后 `agent_end` 触发 `end_turn`，客户端看到 prompt 结束但没有 assistant 消息。
- 历史回放正常，实时展示异常，形成与工具回放同类的实时 / 历史分叉。
- 如果直接在 `agent_end.messages` 重放最终消息而不做去重，会和正常 streaming delta 重复显示。

设计：

- 新增共享模块 `src/translate/messages.ts`，提供：
  - `messageUpdateEventToSessionUpdate(raw: Record<string, unknown>): SessionUpdate | undefined`
  - `messageToSessionUpdates(message: unknown, options: { role?: "user" | "assistant"; unknownText: "drop" | "summarize"; includeToolCalls?: boolean }): SessionUpdate[]`
  - `agentEndMessagesToFallbackUpdates(raw: Record<string, unknown>, emitted: StreamedAssistantMessageIndex): SessionUpdate[]`
  - `StreamedAssistantMessageIndex` 记录本轮已成功发送的 assistant message/content 维度，而不是仅记录全局布尔值；优先使用 `responseId`、`timestamp`、`assistantMessageEvent.contentIndex`，缺少稳定标识时用本轮 assistant 消息顺序、contentIndex 和 chunk 类型作为保守去重 key。
- `messageUpdateEventToSessionUpdate()` 必须支持真实 OMP `assistantMessageEvent`：
  - `text_delta` → `agent_message_chunk`
  - `thinking_delta` → `agent_thought_chunk`
  - `error` → 可见 `agent_message_chunk`，内容为错误消息；如果无错误文本则忽略
  - `toolcall_start` / `toolcall_delta` / `toolcall_end` → 忽略，由 `tool_execution_*` 路径负责工具展示
- 旧 fixture 形状 `raw.content` / `raw.text` / `raw.message` 字符串仍保留，避免破坏现有测试。
- 历史回放 `sessions.ts` 删除本地 assistant/user message 转换逻辑，改用 `messageToSessionUpdates()`；实时 `agent_end` fallback 也使用同一函数，但 `includeToolCalls: false`，并且必须忽略 `role !== "assistant"` 的消息和 assistant 内的 `toolCall` block，避免在 turn 结束时重复工具调用或重放 user/toolResult。
- `handleSessionPrompt()` 跟踪本轮已成功发出的 assistant message/content 维度。收到 `agent_end` 时：
  - 先用 `agentEndMessagesToFallbackUpdates()` 补发缺失的最终 assistant 文本 / 思考安全内容；
  - 已通过 streaming delta 成功发出的具体 assistant message/content 不再 fallback，避免重复；
  - 未被 streaming 覆盖的后续 assistant message/content 仍必须 fallback，不能因为同一类型已有任意 chunk 就全局跳过；
  - fallback update 进入同一个 `updatePromises` drain 流程，必须送达后才能返回 `end_turn`。

验收：

- 真实形状 `message_update` `{ message:{ role:"assistant", content:[...] }, assistantMessageEvent:{ type:"text_delta", delta:"hi" } }` 被映射为 ACP `agent_message_chunk`。
- `thinking_delta` 被映射为 `agent_thought_chunk`；toolcall 类 assistant message event 不从 message path 展示。
- 只有 `agent_end.messages` 有最终 assistant 文本、此前没有匹配到该 assistant message/content 的 agent message chunk 时，prompt 会先发 assistant update，再返回 `{ stopReason:"end_turn" }`。
- 如果已经收到并发送过同一 assistant message/content 的 `text_delta`，`agent_end.messages` 不再重复发该文本；如果同一 `agent_end.messages` 中还有另一个未 streamed assistant message，则仍会 fallback 该消息。
- `agent_end.messages` fallback 必须忽略 user、toolResult 和 assistant toolCall block。
- 历史回放、实时 `message_update`、实时 `agent_end` fallback 共用同一个 message/content sanitizer，私有 provider payload 不进入 ACP content。


### 3. `ContentBlock` 白名单与 tool result content 提取分叉

现状：

- 实时路径 `src/translate/tools.ts` 有私有 `toSafeContentBlock()`。
- 历史路径 `src/runtime/omp/sessions.ts` 有私有 `sanitizeRenderableContentBlock()`。
- 两者都维护 text/image/resource_link/resource 的可显示字段白名单。
- 未知但可文本化 block 的处理策略不统一。

风险：

- 新增或修正 ACP content 类型时需要同时改两处。
- 同一个 OMP tool result 在实时和历史回放中显示不同。

设计：

- 新增共享模块 `src/translate/content.ts`，提供：
  - `sanitizeContentBlock(value: unknown): ContentBlock | undefined`
  - `contentItemsToToolCallContent(items: unknown, options?: { unknownText: "drop" | "summarize" }): ToolCallContent[]`
  - `contentItemsToMessageUpdates(role, items, options)` 可选；如果实现后能简化历史消息映射，则使用。
  - `sanitizeToolOutputForAcp(value: unknown): unknown`
- `sanitizeContentBlock()` 只允许 ACP 安全字段：
  - `text`: `type`、`text`
  - `image`: `type`、`data`、`mimeType`、可选 `uri`
  - `resource_link`: `type`、`uri`、`name`、可选 `title`、`description`、`mimeType`、`size`
  - `resource`: `resource.uri` + `resource.text` 或 `resource.blob` + 可选 `mimeType`
- `src/translate/tools.ts` 和 `src/runtime/omp/sessions.ts` 都使用该模块。
- 对未知 block 的策略必须显式传入：
  - 实时工具结果默认 `unknownText: "drop"`，除非已有测试要求显示。
  - 历史回放默认 `unknownText: "summarize"`，以满足“应放尽放”的历史回放目标。
- 摘要逻辑必须复用同一安全规则，遇到 provider/private/signature/encrypted block 或敏感 key 时跳过。
- `sanitizeToolOutputForAcp()` 必须递归复用 `isPrivateAcpVisibleKey()`，过滤 provider-private、signature、encrypted、secret/token/key/baseURL/config 等字段；净化后为空对象/空数组时返回 `undefined`。
- 实时工具、历史工具结果和 host tool result 在设置 ACP `rawOutput` 前必须调用 `sanitizeToolOutputForAcp()`；如果净化结果为 `undefined`，不得发送原始 `rawOutput`。

验收：

- 实时和历史对 text/image/resource_link/resource 的字段净化完全一致。
- 历史未知安全文本块仍显示为 thought/content 摘要。
- provider payload、signature、encrypted content、secret/config/key 不出现在任何 ACP content 或 rawOutput 中。
- `tool_call_update.rawOutput` 对实时工具、历史工具和 host tool result 使用同一输出净化函数；敏感结果不能因为 content 已净化而通过 rawOutput 泄漏。

### 4. `extension_ui_request` 方法分类分叉

现状：

- `src/acp/extension-ui.ts` 维护 `confirm`、`setWidget`、fire-and-forget、unsupported interactive 的处理。
- `src/translate/events.ts` 维护另一套 `isFireAndForgetExtensionUiRequest()`，其中 `setWidget` 仍被分类为 fire-and-forget 并忽略。
- `formatExtensionUiRequest()` 在两个文件中重复。

风险：

- 主 prompt 路径与 fallback translator 对同一 method 的语义不一致。
- 新增或调整 method 时可能只改其中一处。

设计：

- 新增共享模块 `src/translate/extension-ui.ts`，提供：
  - `classifyExtensionUiRequest(raw): "confirm" | "widget" | "fire_and_forget" | "unsupported_interactive" | "unsupported"`
  - `formatExtensionUiRequest(raw): string`
  - `isFireAndForgetExtensionUiRequest(raw): boolean`（如仍需要）
- `src/acp/extension-ui.ts` 使用 classifier 决定执行路径。
- `src/translate/events.ts` 使用同一个 classifier，只负责通用 fallback：
  - fire-and-forget → `undefined`
  - widget → `undefined` 或明确注释“只有 bridge 路径会显示 widget”，但分类来源必须一致。
  - unsupported interactive/unsupported → 抛 `UnsupportedRuntimeEventError(formatExtensionUiRequest(raw))`
- 删除重复的本地格式化函数。

验收：

- `confirm`、`setWidget`、`cancel`、`notify`、`setStatus`、`setTitle`、`set_editor_text`、`select`、`input`、`editor`、未知 method 的分类由同一模块输出。
- bridge 和 translator 单测断言引用同一分类结果，不再各自维护 method 白名单。
- 现有 `confirm` permission、`setWidget` thought 显示、unsupported cancel-back 行为不变。

### 5. `SessionSetupState` 公共响应与内部元数据混用

现状：

- `SessionSetupState` 包含 `runtimeSessionId`，供 `session/new` 将 provisional id 替换为 OMP runtime session id。
- `session-new.ts` 有私有 `toPublicSetupState()` 删除该字段。
- `session-load.ts`、`session-resume.ts`、`session-fork.ts` 直接返回 `requireSetupState(setupState)`。

风险：

- load/resume/fork 可能把 `runtimeSessionId` 泄漏到 ACP 响应。
- 未来新增内部字段时，各 handler 可能继续分叉。

设计：

- 在 `src/acp/session-controls.ts` 中拆分类型：
  - `SessionSetupStatePublic = Pick<NewSessionResponse, "models" | "modes" | "configOptions">`
  - `SessionSetupState = SessionSetupStatePublic & { runtimeSessionId?: string }`
- 在同文件导出：
  - `toPublicSessionSetupState(setupState: SessionSetupState): SessionSetupStatePublic`
  - `requireSessionSetupState(setupState: SessionSetupState | undefined): SessionSetupState`
- new/load/resume/fork 全部使用共享 `requireSessionSetupState()` 和 `toPublicSessionSetupState()`。
- 不允许 handler 私有复制 `requireSetupState()` / `toPublicSetupState()`。

验收：

- `session/new`、`session/load`、`session/resume`、`session/fork` 响应均不包含 `runtimeSessionId`。
- `session/new` 仍返回 OMP runtime real session id 作为 `sessionId`。
- 单测覆盖四个 handler 的 public response 投影。

### 6. `set_active_tools` 真实 OMP RPC 契约缺少 smoke 覆盖

现状：

- adapter 与 fixture 支持 `{ type: "set_active_tools", toolNames }`。
- `scripts/smoke-omp-rpc-controls.mjs` 未覆盖 `dumpTools` / `set_active_tools`。

风险：

- fixture 可能掩盖真实 OMP RPC shape 或语义差异。
- Ask 禁用依赖该命令作为 session setup 防线。

设计：

- 扩展 `scripts/smoke-omp-rpc-controls.mjs`：
  1. 启动真实 `omp --mode rpc`。
  2. 调用 `get_state`，读取 `dumpTools` 当前 active tool names。
  3. 如果 active tools 可用，选择一个安全的 no-op 差集操作：
     - 若包含 `ask`，调用 `set_active_tools` 去掉 `ask`；
     - 否则临时移除一个非关键测试工具不可取，避免破坏会话。因此 smoke 可以只在包含 `ask` 时做 mutation；不包含时记录 skip 原因。
  4. mutation 后再次 `get_state` 验证 `dumpTools` 生效。
  5. 如果做过 mutation，恢复原 active tools 并验证恢复。
- smoke 输出必须区分 pass / skip / fail；skip 仅允许在真实 runtime 不暴露可安全 mutation 条件时发生。
- `npm run smoke:omp-rpc-controls` 文档说明该检查项。

验收：

- 在支持 `dumpTools` 且 active tools 包含 `ask` 的真实 OMP 环境中，smoke 验证 `set_active_tools` round-trip。
- 如果真实 OMP 返回不支持命令，smoke fail，并暴露具体错误。
- fixture 单测仍保留，但不再是唯一契约证据。

### 7. Host tool cancel id 边界未归一

现状：

- `HostToolBridge.activeCalls` 使用 OMP host call `id` 做 key。
- cancel 接受 `targetId ?? toolCallId`，但直接用该值查表。
- 如果真实 runtime 以 `toolCallId` 取消且 `id !== toolCallId`，取消会失败。

风险：

- 表面兼容两种 cancel shape，实际只支持一种索引。
- 未命中时可能用 `toolCallId` 当 `host_tool_result.id` 回写，导致 id 不匹配。

设计：

- `ActiveCall` 增加原始 `id` 字段。
- `HostToolBridge` 维护两个索引：
  - `activeCallsById: Map<string, ActiveCall>`
  - `activeCallIdByToolCallId: Map<string, string>`
- host call 开始时同时登记。
- cancel 时：
  - 优先读取 `targetId`；若命中原始 id，使用原始 id。
  - 如果只有 `toolCallId` 或 `targetId` 未命中，再尝试 `toolCallId -> id` 映射。
  - abort、emit ACP failed update 使用 `active.toolCallId`。
  - 回写 OMP `host_tool_result.id` 必须使用原始 host call id。
- cleanup 时删除两个索引。

验收：

- 新增测试：host call `{ id: "host_1", toolCallId: "tc_1" }`，cancel `{ toolCallId: "tc_1" }` 能取消执行，并回写 `{ type:"host_tool_result", id:"host_1", ... }`。
- 现有 targetId cancel 行为不变。
- missing target 仍返回明确失败，不吞错误。

## 实施顺序

1. 提取共享安全净化模块，接入实时工具、历史工具、host tool rawInput。
2. 提取共享 message/content 映射模块，接入实时 `message_update`、`agent_end.messages` fallback 与历史 message replay。
3. 提取共享 tool result content 模块，接入实时工具与历史工具结果回放。
4. 提取 extension UI classifier，接入 bridge 与 runtime event translator。
5. 统一 session setup state public projection，更新 new/load/resume/fork handler 与测试。
6. 修复 host tool cancel id 归一化，补测试。
7. 扩展真实 OMP RPC controls smoke 覆盖 `set_active_tools`。
8. 更新文档：`docs/compatibility/capability-matrix.md`、`docs/compatibility/zed.md`、必要时 README / smoke 脚本文档。

## 测试策略

每项必须先写失败测试，再实现。

目标测试：

- `test/unit/translate/tools.test.ts`
  - 实时 tool start rawInput 净化。
  - 实时 tool result content 使用共享 sanitizer。
- `test/unit/translate/events-message.test.ts`
  - 真实 OMP `assistantMessageEvent.text_delta` / `thinking_delta` / `error` 映射。
  - toolcall 类 `assistantMessageEvent` 不从 message path 展示。
  - 旧 fixture `content` / `text` / `message` 字符串形状继续兼容。
- `test/unit/acp/session-handlers.test.ts`
  - handler 级红灯复现：emit 真实 OMP 形状 `message_update`（`message.role:"assistant"` + `assistantMessageEvent.type:"text_delta"` + `delta`），随后 emit `agent_end`；断言 `agent_message_chunk` 已进入 `session/update`，且 update promise resolve 前 prompt 不返回 `end_turn`。
  - `agent_end.messages` 在缺少 streaming assistant chunk 时补发最终 assistant 消息。
  - `agent_end.messages` 同时包含 user、toolResult、两个 assistant message 时，只 fallback 未 streamed 的 assistant 文本 / 思考，不重放 user/toolResult，不因第一个 assistant 已 streamed 而漏掉第二个未 streamed assistant。
  - 已发送 streaming `text_delta` 时不重复 fallback 同一 assistant message/content。
  - fallback update drain 完成后才返回 `end_turn`。
- `test/unit/runtime/omp/sessions.test.ts`
  - 历史 toolCall 与实时 tool start parity。
  - 历史 toolResult 与实时 tool end parity。
  - 历史 assistant/user message replay 与共享 message sanitizer 一致。
  - provider/private 字段不出现在 rawInput/rawOutput/content。
  - 历史工具结果 rawOutput 使用共享输出净化，与实时工具和 host tool result 一致。
- `test/unit/runtime/omp/host-tools.test.ts`
  - host tool rawInput 净化。
  - cancel by toolCallId 映射到原始 host call id。
- `test/unit/acp/session-config.test.ts`、`test/unit/acp/session-list-load.test.ts`、`test/unit/acp/session-resume.test.ts`、`test/unit/acp/session-fork.test.ts`
  - public setup response 不包含 `runtimeSessionId`。
- `test/unit/acp/extension-ui.test.ts`
  - extension UI classifier 共享语义。
- `scripts/smoke-omp-rpc-controls.mjs`
  - 真实 `set_active_tools` round-trip 或显式 skip/fail。

最终验证命令：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/tools.test.ts test/unit/translate/events-message.test.ts test/unit/acp/session-handlers.test.ts test/unit/runtime/omp/sessions.test.ts test/unit/runtime/omp/host-tools.test.ts
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts test/unit/acp/extension-ui.test.ts
npm run check
npm run build
git diff --check
```

如果修改 smoke 脚本，还应区分诊断 smoke 与发布门禁；真实 OMP 可用环境的发布/contract 验证使用 required 模式：

```bash
npm run smoke:omp-rpc-controls:optional
npm run smoke:omp-rpc-controls:required
```

若真实 OMP 环境不可用，必须记录不可用原因，不能把 fixture 测试当作真实 RPC contract 证据。

## 安全边界

以下内容不得进入 ACP `SessionUpdate` 的 `content`、`rawInput`、`rawOutput`、title 或 thought：

- `providerPayload`
- `thinkingSignature`
- `textSignature`
- `thoughtSignature`
- `signature` 及 provider-specific 签名字段
- `encrypted_content` 或任何 encrypted reasoning
- API key、access key、plain key、token、secret、authorization/auth
- provider base URL / baseURL / base_url
- raw provider config、runtime config、sampling knobs

共享净化函数必须递归处理对象和数组；净化后空对象/空数组应返回 `undefined`，避免给 ACP client 发送空壳私有结构。`rawOutput` 不能作为净化后的 content 之外的旁路泄漏渠道。

## 决策记录

- `usage_update`：继续不从历史 replay 伪造。只有未来存在真实、已验证、ACP 可解释的 usage runtime event 时再实现。
- 未知 content block：历史回放继续摘要安全文本；实时路径本轮保持 drop，避免改变实时 UI 噪声水平。两者必须通过同一共享函数和显式策略参数表达，禁止再出现隐式分叉。
- `set_active_tools` smoke：如果真实 runtime 当前 active tools 不包含 `ask`，不应为了测试随意移除用户工具；允许记录 skip，但命令不支持必须 fail。

## 验收标准

- 所有 identified 分叉都有共享模块或明确边界说明。
- 不再存在 handler 私有 `toPublicSetupState` / `requireSetupState` 复制。
- 不再存在两套 ContentBlock 白名单实现。
- 不再存在两套 extension UI method 分类实现。
- 实时、历史、host tool 的 ACP-visible rawInput 均使用同一净化函数。
- 实时、历史、host tool 的 ACP-visible rawOutput 均使用同一净化函数，或在净化为空时省略。
- 实时 assistant `message_update` 支持真实 OMP `assistantMessageEvent` 形状；`agent_end.messages` 只在缺失 streaming chunk 时作为去重兜底。
- host tool cancel 支持原始 id 与 toolCallId 映射，不再把展示 id 误当回写 id。
- 自动化测试覆盖所有上述边界。
- `npm run check`、`npm run build`、`git diff --check` 通过。
