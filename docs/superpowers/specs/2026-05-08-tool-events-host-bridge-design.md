# Stage 4: tool call、edit diff 与 host tool bridge 设计

> 对应总体计划「阶段 4」。阶段 4 只处理 OMP runtime 已经发出的 tool/edit/host-tool 事件，不声明 MCP、terminal/filesystem delegation、permission request、session lifecycle 等未实现能力。

## 目标

- 将 OMP `tool_execution_start` / `tool_execution_update` / `tool_execution_end` runtime events 映射为 ACP `tool_call` / `tool_call_update` session updates。
- 编辑类工具输出 ACP structured diff (`ToolCallContent` 的 `type: "diff"`)，不能把 edit diff 仅伪装为普通文本。
- 从 runtime event 中提取 file path 与 line hint，保持 Windows 与 POSIX 路径字符串不被破坏。
- tool 失败必须成为 ACP 可见失败状态 (`status: "failed"`)，不能作为普通 assistant message。
- 为 OMP `host_tool_call` / `host_tool_cancel` 建立显式 bridge：只有已注册的 adapter-owned host tool 会执行并回写 OMP RPC `host_tool_update`/`host_tool_result` frame；未注册 host tool 返回错误结果并发出 failed tool update，而不是静默丢弃或假装成功。

## 非目标

- 不实现 ACP filesystem delegation、terminal delegation、MCP HTTP/SSE、permission request。
- 不把未知 OMP runtime events 猜测成 tool events。
- 不声明 OpenCode parity 或通用 host tool execution。
- 不修改 npm 发布状态。

## OMP RPC 依据

- OMP RPC stdout 会发出 `tool_execution_start`、`tool_execution_update`、`tool_execution_end`，以及 `host_tool_call` / `host_tool_cancel`。
- Host tool completion 回写 stdin 使用 raw JSONL frames：`{ type: "host_tool_update", id, partialResult }` 与 `{ type: "host_tool_result", id, result, isError? }`。因此 Stage 4 必须给 runtime adapter 增加 raw-frame 发送能力；不能用普通 request/response 伪造 host tool result。

## 数据契约

### Tool event 输入容忍形状

Translator 只承诺支持以下 OMP/fixture shape；真实 OMP 若有额外字段，后续必须补 contract test 后扩展：

- start: `{ type: "tool_execution_start", toolCallId|id, name|toolName, title?, kind?, status?, input|rawInput?, path?, line? }`
- update/end: `{ type: "tool_execution_update"|"tool_execution_end", toolCallId|id, status?, output|rawOutput?, content?, error?, path?, line?, diff? }`
- status normalization: `pending`/`queued` => `pending`; `running`/`in_progress`/`started` => `in_progress`; `success`/`succeeded`/`complete`/`completed`/missing on `tool_execution_end` => `completed`; `failed`/`error`/`cancelled`/`canceled` => `failed`.
- kind normalization: known ACP `ToolKind` values pass through; common names map (`read_file`=>`read`, `write`/`patch`=>`edit`, `grep`=>`search`, `bash`/`shell`=>`execute`); unknown kinds become `other`.
- text content normalization: runtime text output in `content`, `output`, or `rawOutput` becomes ACP `ToolCallContent` as `{ type:"content", content:{ type:"text", text } }`; raw OMP host-tool result content remains separate and must not be copied directly into ACP `content`.
- diff: `diff` 可为 `{ path, oldText?, newText }`、`{ filePath, oldText?, newText }`，或 rename fixture shape `{ operation:"rename", oldPath, newPath, oldText?, newText }`。create uses `oldText:null`; modify uses both `oldText` and `newText`; delete uses `newText:""` with `oldText` present; rename with `oldPath`、`newPath` and string `newText` is represented as two ACP diff items (delete old path with `newText:""` + create new path with `oldText:null`); rename without string `newText` becomes a failed unsupported update with rawOutput explaining unsupported rename shape.

### ACP 输出

- start => `{ sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending"|"in_progress", rawInput, locations }`
- update/end => `{ sessionUpdate: "tool_call_update", toolCallId, status, rawOutput, content?, locations? }`
- failed/cancelled OMP statuses 映射为 ACP `status: "failed"`，并在 `rawOutput` 中保留 `{ error }` 或 `{ cancelled: true }`。
- ACP schema 没有 `cancelled` status，因此取消必须作为 failed state with rawOutput.cancelled。

## Host tool bridge

- 新增 `src/runtime/omp/host-tools.ts`，定义 `HostToolBridge`。
- `HostToolBridge` 接收 `sendFrame(frame)`、session update sink `emitUpdate(update): Promise<void>`、failure callback `failPrompt(error)` 与 registry `{ [toolName]: executor }`。Bridge 发出的 update promise 必须由 `session-prompt` 纳入现有 update queue/drain，不能绕过 Stage 3 ordering。
- Host event input shapes:
  - call: `{ type:"host_tool_call", id, toolCallId?, toolName|name, arguments|input? }`，`id` 与 tool name 必填；缺失时发 failed update 并尽力回写 `host_tool_result` error（若有 id）。
  - cancel: `{ type:"host_tool_cancel", id?, targetId|toolCallId }`，`targetId` 指原始 host call id；缺失时发明确 failed update 或 diagnostics，不静默成功。
- 收到 `host_tool_call`：
  1. 立即发 ACP `tool_call` pending，kind `other`，title 使用 tool name；
  2. 若 tool 未注册：发 ACP failed `tool_call_update`，并 raw-frame 回写 `{ type:"host_tool_result", id, isError:true, result:{ content:[{type:"text",text:"Unsupported host tool: <name>"}] } }`；
  3. 若 tool 已注册：执行 executor，可发进度 `host_tool_update`，完成后回写 `host_tool_result`；失败时 `isError:true`；
  4. 所有结果必须带回原始 host tool `id`，不能误用 ACP `toolCallId`。
- 收到 `host_tool_cancel`：
  - 若有 active executor cancellation，触发 cancel，发 ACP failed update with `rawOutput.cancelled = true`，并回写 OMP error result；
  - 若 target 不存在，仍发明确 failed update 或记录 diagnostics，不能静默成功。

## Runtime adapter 变更

- `RuntimeAdapter` 增加 `send(frame: Record<string, unknown>): Promise<void>`。
- `OmpRpcClient.send(frame)` raw JSONL 写入 stdin，不创建 pending response，不写 stdout。
- Stage 2 `request()` 行为不变。

## Session integration

- `translateRuntimeEventToSessionUpdate` 支持 tool execution events；现有 `test/unit/translate/events-message.test.ts` 中 host_tool_call/host_tool_cancel 抛 unsupported 的断言必须删除或替换，host tool 通过 bridge/session path 测试。
- `session-prompt` 对 tool events 和 host bridge updates 使用同一个 update queue，保证 `session/update` 仍在 prompt response 前 drain，并能把 bridge write/executor failure 传播为 prompt failure 或 failed tool update。
- `host_tool_call` / `host_tool_cancel` 不再作为 unsupported runtime error；它们由 host bridge 处理，输出 ACP tool updates 并回写 OMP raw frames。
- Host bridge failure 本身不应伪装成 assistant message；应返回 failed tool update 并保持 prompt lifecycle 可继续，除非 raw-frame write 失败导致 runtime client failure。

## 文件范围

- 新增 `src/translate/tools.ts`
- 新增 `src/translate/diffs.ts`
- 新增 `src/runtime/omp/host-tools.ts`
- 修改 `src/translate/events.ts`
- 修改 `src/runtime/RuntimeAdapter.ts`
- 修改 `src/runtime/omp/rpc-client.ts`
- 修改 `src/acp/handlers/session-prompt.ts`
- 扩展 `src/testing/script-rpc-process.ts`
- 新增 `test/unit/translate/tools.test.ts`
- 新增 `test/unit/translate/diffs.test.ts`
- 新增 `test/unit/runtime/omp/host-tools.test.ts`
- 新增/扩展 `test/contract/omp-rpc/tool-events.test.ts`
- `test/contract/omp-rpc/tool-events.test.ts` 必须让 subprocess fixture 观察 stdin 中真实写出的 `host_tool_update` / `host_tool_result` raw frames，证明实现没有误用 `request()` 或等待 response。
- 扩展 `test/smoke/session-prompt.test.ts`
- 更新 README、capability matrix、plan。

## 验收标准

- 成功、失败、取消 tool event 都有测试覆盖。
- edit diff 覆盖 create、modify、delete、rename；delete 使用 `newText:""`，rename 使用 delete+create 或明确 failed unsupported，并有测试记录。
- Windows 与 POSIX path 字符串保持原样。
- tool failure 可见为 failed tool status，不作为普通文本 chunk。
- host_tool_call 未注册路径回写 OMP `host_tool_result` error；已注册路径回写成功 result；host_tool_cancel 不被吞掉；subprocess fixture 必须观察 raw frames。
- `npm run check` 通过。