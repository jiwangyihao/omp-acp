# Stage 6: OpenCode parity 能力边界设计

> 对应总体计划「阶段 6」。本阶段只实现能够 truthful 声明并自动化验证的能力；无法由当前 ACP SDK 或 OMP RPC 契约支撑的能力保持不声明，并在 capability matrix 写明原因。

## 目标

- 实现 ACP `session/resume`：不回放历史，恢复 OMP session path 并允许后续 prompt。
- 不实现/不声明 `session/fork`：当前 ACP request 只有 source session id，而 OMP RPC `branch` 需要 entry id；用 `new_session parentSession` 也无法保证 ACP fork 语义。
- 不实现/不声明 `session/close`：当前 `@agentclientprotocol/sdk@0.12.0` 没有 agent-side `session/close` method。
- 实现 prompt image block 转发到 OMP RPC `images` 字段，并声明 `promptCapabilities.image:true`。
- 实现 embedded resource context 转换为 stable text prompt sections，并声明 `promptCapabilities.embeddedContext:true`；text resource 直接嵌入 text，blob resource 以 uri/mime/base64 blob text section 传递，不静默丢弃。
- 保持 audio prompt unsupported，继续声明 `audio:false`。
- MCP HTTP/SSE、permission request、usage update 保持不声明：当前 adapter 没有 OMP runtime contract 或 ACP schema surface 可以 truthfully 映射。

## Observed protocol basis

- OMP RPC docs define prompt command image support as `{ id?, type:"prompt", message:string, images?: ImageContent[] }`; the adapter's existing runtime shim uses method `"prompt"` with params, so Stage 6 maps ACP images to `params.images` while preserving the existing `params.prompt` string used by Stage 3-5 fixtures.
- ACP SDK `ImageContent` is `{ data:string, mimeType:string, uri?:string|null }`, which is compatible with the OMP docs' `ImageContent` boundary for adapter-level forwarding tests.
- ACP SDK `PromptCapabilities.embeddedContext` means clients may send embedded `resource` blocks; OMP RPC has no separate embedded-resource field, so Stage 6 represents embedded resources as explicit prompt text sections. This is truthful because the adapter consumes the resource block and forwards its content, not just a link.
- MCP boundary: ACP receives MCP server declarations in session requests, but the adapter has no tested OMP RPC command or process launch contract that wires HTTP/SSE MCP servers into the running OMP session. Therefore `mcpCapabilities.http/sse` remain false.
- Permission boundary: ACP permission UX requires agent-to-client `session/request_permission`; the adapter has no OMP runtime event contract for permission requests or policy decisions. Therefore permission request remains unimplemented.
- Usage boundary: the installed ACP SDK schema has no `usage_update` session update type, and no OMP usage event shape has been contract-tested. Therefore usage update remains unimplemented.

## Session resume contract

- `unstable_resumeSession(params)` 通过 `findOmpSessionById(params.sessionId, { cwd, agentDir })` 找 session path。
- 启动 runtime，等待 ready，发送 `runtime.request("switch_session", { sessionPath })`。
- 在 `SessionManager` 中发布同一 `sessionId`，不 replay history，返回 ACP `ResumeSessionResponse` `{}`。
- `initialize` 声明 `sessionCapabilities.resume:{}`，但不声明 fork/close。

## Prompt image / embedded context contract

- `translatePromptToOmpRequest` 对 text/resource_link 保持现有稳定文本格式。
- image block `{ type:"image", data, mimeType, uri? }` 不进入 prompt text；追加到 `params.images`，保持 `data`、`mimeType`，有 string `uri` 时保留。
- embedded text resource `{ type:"resource", resource:{ uri, text, mimeType? } }` 追加 stable text section：
  ```text
  [Embedded Resource: <uri>]
  MIME: <mimeType>   # only when present
  <text>
  ```
- embedded blob resource `{ type:"resource", resource:{ uri, blob, mimeType? } }` 追加 stable text section：
  ```text
  [Embedded Blob Resource: <uri>]
  MIME: <mimeType>   # only when present
  <blob>
  ```
- Unknown resource shape or audio block raises `PromptTranslationError`.

## Files

- Add `src/acp/handlers/session-resume.ts`
- Modify `src/acp/server.ts`
- Modify `src/acp/capabilities.ts`
- Modify `src/translate/prompt.ts`
- Modify `src/session/manager.ts` only if needed for optional MCP server arrays
- Extend `src/testing/script-rpc-process.ts` if smoke coverage needs resume/image fixture
- Add/extend tests:
  - `test/unit/acp/session-resume.test.ts`
  - `test/unit/acp/initialize.test.ts`
  - `test/unit/translate/prompt.test.ts`
  - `test/smoke/session-prompt.test.ts`

## Acceptance

- `session/resume` has unit and smoke coverage; prompt after resume works.
- `initialize` declares `sessionCapabilities.resume:{}` and still does not declare fork/close.
- prompt image blocks produce `params.images` without polluting text.
- embedded text/blob resource blocks are represented in prompt text; unsupported audio still fails.
- capability matrix states MCP HTTP/SSE, permission request, and usage update remain unimplemented/not declared with explicit rationale.
- `npm run check` passes.