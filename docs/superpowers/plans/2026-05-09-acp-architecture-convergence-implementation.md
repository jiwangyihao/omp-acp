# ACP adapter 架构收敛与分叉消除实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。必须直接在当前 `main` 工作区开发，不创建 git worktree。每项行为变更必须先写失败测试并观察红灯，再实现最小代码使其通过。审查循环已由用户提前批准，所有 review 子代理通过后可以继续下一阶段。

**目标：** 消除 ACP adapter 中实时、历史、host tool、session lifecycle 和 extension UI 的重复转换边界，修复真实实时 Assistant 消息不展示 / 提前 `end_turn` 的问题，并统一 ACP-visible 数据净化。

**架构：** 新增共享转换模块：`src/translate/safety.ts` 负责 ACP 可见输入/输出净化，`src/translate/content.ts` 负责 ACP `ContentBlock` 与 tool result content 白名单转换，`src/translate/messages.ts` 负责实时 `message_update`、`agent_end.messages` fallback 和历史 message replay 的统一映射，`src/translate/extension-ui.ts` 负责 `extension_ui_request` 分类与格式化。现有实时工具、历史回放、host tool bridge、session handlers 改为调用这些共享边界。`session/prompt` 在收到 `agent_end` 时先补发未 streamed 的 assistant 文本/思考，并 drain 完成后再返回 `end_turn`。

**技术栈：** Node.js >= 20、TypeScript、`@agentclientprotocol/sdk@0.21.0`、`node:test`、JSON-RPC over stdio、OMP RPC JSONL、现有 fake runtime 与 smoke harness。

**规格来源：** `C:\Users\34404\source\repos\omp-acp\docs\superpowers\specs\2026-05-09-acp-architecture-convergence-design.md`。

---
## 当前执行状态

本文档最初是架构收敛实施计划。当前代码实现已推进到最终审查修复阶段；下方大量 `- [ ]` 复选框保留为原始计划模板和执行脚本，不代表当前仓库仍未开始或全未完成。

已观察到的验证事实：

- 目标测试已按各行为变更执行红灯 / 绿灯验证。
- `npm run check` 曾观察到 `219 pass / 0 fail`。
- `npm run build` 曾观察到成功。
- `git diff --check` 曾观察到无输出。
- 真实 OMP RPC controls smoke 未通过：`npm run smoke:omp-rpc-controls` 在本机观察到 `Timed out waiting for OMP RPC ready frame`。这是发布门禁之一，当前状态应视为未完成 / 环境待修复，不能作为已通过项。

维护者阅读下方步骤时，应以本节和当前代码 / 测试结果判断实际状态；复选框仅记录原始计划拆解。


## 文件结构与职责

- 创建：`src/translate/safety.ts` — 共享 ACP-visible 安全净化：`parseToolInput()`、`isPrivateAcpVisibleKey()`、`sanitizeToolInput()`、`sanitizeToolOutputForAcp()`。
- 创建：`src/translate/content.ts` — 共享 `ContentBlock` 白名单、tool result content 提取、未知文本策略、可安全摘要。
- 创建：`src/translate/messages.ts` — 共享 OMP message → ACP `SessionUpdate` 映射，支持真实 `assistantMessageEvent`、历史 replay、`agent_end.messages` fallback 去重。
- 创建：`src/translate/extension-ui.ts` — 共享 `extension_ui_request` classifier 与格式化。
- 修改：`src/translate/events.ts` — 使用 `messages.ts` 和 `extension-ui.ts`，保留 tool event 转发。
- 修改：`src/translate/tools.ts` — 使用 `safety.ts` / `content.ts` 净化 `rawInput`、`rawOutput` 和 result content。
- 修改：`src/runtime/omp/sessions.ts` — 删除本地 message/content/tool input 净化分叉，复用共享模块。
- 修改：`src/runtime/omp/host-tools.ts` — 使用共享 `rawInput` / `rawOutput` 净化，并维护原始 host call id 与 ACP `toolCallId` 双索引。
- 修改：`src/acp/handlers/session-prompt.ts` — 记录 streamed assistant content key，`agent_end` 时补发 fallback update，并 drain 后返回。
- 修改：`src/acp/extension-ui.ts` — 使用共享 `extension-ui` classifier 与 formatter。
- 修改：`src/acp/session-controls.ts` — 导出 public/internal setup state helpers。
- 修改：`src/acp/handlers/session-new.ts`、`src/acp/handlers/session-load.ts`、`src/acp/handlers/session-resume.ts`、`src/acp/handlers/session-fork.ts` — 统一 public projection。
- 修改：`scripts/smoke-omp-rpc-controls.mjs` — 增加真实 OMP `dumpTools` / `set_active_tools` round-trip 或安全 skip。
- 修改测试：`test/unit/translate/tools.test.ts`、`test/unit/translate/events-message.test.ts`、`test/unit/acp/session-handlers.test.ts`、`test/unit/runtime/omp/sessions.test.ts`、`test/unit/runtime/omp/host-tools.test.ts`、`test/unit/acp/session-config.test.ts`、`test/unit/acp/session-list-load.test.ts`、`test/unit/acp/session-resume.test.ts`、`test/unit/acp/session-fork.test.ts`、`test/unit/acp/extension-ui.test.ts`。
- 可能修改文档：`docs/compatibility/capability-matrix.md`、`docs/compatibility/zed.md`、`README.md`，仅记录实际行为边界，不声明未验证 GUI smoke。

---

## 任务 1：共享安全、content 与实时 message 映射基础

**文件：**
- 创建：`src/translate/safety.ts`
- 创建：`src/translate/content.ts`
- 创建：`src/translate/messages.ts`
- 修改：`src/translate/events.ts`
- 测试：`test/unit/translate/events-message.test.ts`

- [ ] **步骤 1：失败测试：真实 OMP `assistantMessageEvent` 映射**

在 `test/unit/translate/events-message.test.ts` 增加测试，直接调用 `translateRuntimeEventToSessionUpdate()`：

```ts
test("translateRuntimeEventToSessionUpdate maps OMP assistant text_delta to an agent message chunk", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(event("message_update", {
      message: { role: "assistant", content: [{ type: "text", text: "final" }], responseId: "r1", timestamp: 1 },
      assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
    })),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
  );
});

test("translateRuntimeEventToSessionUpdate maps OMP assistant thinking_delta to a thought chunk", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(event("message_update", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "final" }], responseId: "r1", timestamp: 1 },
      assistantMessageEvent: { type: "thinking_delta", delta: "reason", contentIndex: 0 },
    })),
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reason" } },
  );
});

test("translateRuntimeEventToSessionUpdate ignores assistant toolcall message events", () => {
  for (const type of ["toolcall_start", "toolcall_delta", "toolcall_end"]) {
    assert.equal(
      translateRuntimeEventToSessionUpdate(event("message_update", {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc_1", name: "bash" }] },
        assistantMessageEvent: { type, contentIndex: 0 },
      })),
      undefined,
    );
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/events-message.test.ts
```

预期：新增 `text_delta` / `thinking_delta` 测试失败，因为当前 `translateMessageUpdate()` 不读取 `assistantMessageEvent.delta`。

- [ ] **步骤 3：创建共享安全模块**

创建 `src/translate/safety.ts`，实现：

```ts
export function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

export function isPrivateAcpVisibleKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("signature")
    || normalized.includes("encrypted")
    || normalized.includes("provider")
    || normalized.includes("apikey")
    || normalized.includes("api_key")
    || normalized === "key"
    || normalized.endsWith("key")
    || normalized.includes("_key")
    || normalized.includes("-key")
    || normalized === "authorization"
    || normalized === "auth"
    || normalized === "config"
    || normalized.endsWith("config")
    || normalized === "token"
    || normalized.endsWith("token")
    || normalized.includes("secret")
    || normalized.includes("baseurl")
    || normalized.includes("base_url");
}

export function sanitizeToolInput(value: unknown): unknown {
  return sanitizeAcpVisibleValue(value);
}

export function sanitizeToolOutputForAcp(value: unknown): unknown {
  return sanitizeAcpVisibleValue(value);
}

function sanitizeAcpVisibleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sanitized = value.map(sanitizeAcpVisibleValue).filter((item) => item !== undefined);
    return sanitized.length > 0 ? sanitized : undefined;
  }
  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isPrivateAcpVisibleKey(key)) continue;
      const sanitizedValue = sanitizeAcpVisibleValue(nested);
      if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **步骤 4：创建共享 content 模块**

创建 `src/translate/content.ts`，导出：

```ts
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { isPrivateAcpVisibleKey } from "./safety.ts";

export type UnknownTextPolicy = "drop" | "summarize";
export type MessageRole = "user" | "assistant";
export type ToolCallContent = NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]>[number];

export function sanitizeContentBlock(value: unknown): ContentBlock | undefined { /* text/image/resource_link/resource whitelist */ }
export function contentItemsToToolCallContent(items: unknown, options: { unknownText?: UnknownTextPolicy } = {}): ToolCallContent[] { /* normalize array/object/string; wrap as {type:"content", content:block} */ }
export function summarizeUnknownContentBlock(block: Record<string, unknown>): string | undefined { /* skip private type/key, use text/summary/message/content */ }
```

实现要求：

- `text` 只保留 `type`、`text`。
- `image` 只保留 `type`、`data`、`mimeType`、可选 `uri`。
- `resource_link` 只保留 `type`、`uri`、`name`、可选 `title`、`description`、`mimeType`、`size`。
- `resource` 只保留 `resource.uri` + `resource.text` 或 `resource.blob` + 可选 `mimeType`。
- `summarizeUnknownContentBlock()` 对 `type` 或 key 命中 provider/signature/encrypted/secret/config/key/token/baseURL 的 block 返回 `undefined`。

- [ ] **步骤 5：创建共享 message 模块**

创建 `src/translate/messages.ts`，导出：

```ts
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { sanitizeContentBlock, summarizeUnknownContentBlock } from "./content.ts";

export type StreamedAssistantMessageIndex = {
  has(key: string): boolean;
  add(key: string): void;
};

export function messageUpdateEventToSessionUpdate(raw: Record<string, unknown>): SessionUpdate | undefined { /* assistantMessageEvent + legacy shape */ }
export function messageToSessionUpdates(message: unknown, options?: { role?: "user" | "assistant"; unknownText?: "drop" | "summarize"; includeToolCalls?: boolean }): SessionUpdate[] { /* shared history/fallback mapping */ }
export function agentEndMessagesToFallbackUpdates(raw: Record<string, unknown>, emitted: StreamedAssistantMessageIndex): SessionUpdate[] { /* assistant only, no toolCall */ }
export function streamedAssistantMessageKey(raw: Record<string, unknown>): string | undefined { /* responseId/timestamp/contentIndex/type fallback */ }
```

实现要求：

- `assistantMessageEvent.type === "text_delta"` 使用 `delta` 生成 `agent_message_chunk`。
- `thinking_delta` 使用 `delta` 生成 `agent_thought_chunk`。
- `error` 使用 `assistantMessageEvent.error.errorMessage` 或 `error.message` 生成 `agent_message_chunk`；没有文本则忽略。
- `toolcall_start` / `toolcall_delta` / `toolcall_end` 返回 `undefined`。
- 保留旧 fixture 形状：`raw.content`、`raw.text`、`raw.message` 字符串，以及嵌套 `raw.message.content/text/message` 字符串。
- `messageToSessionUpdates()` 对 user/assistant 文本、安全 content block、assistant thinking block 生成 ACP update；`includeToolCalls` 默认 `false`，历史回放接入 toolCall 时可由调用方保留既有 tool replay 或显式处理。
- `agentEndMessagesToFallbackUpdates()` 只看 `raw.messages` 中 `role === "assistant"` 的消息，忽略 user、toolResult、assistant toolCall。

- [ ] **步骤 6：接入 `src/translate/events.ts`**

修改 `translateRuntimeEventToSessionUpdate()`：

```ts
case "message_update":
  return messageUpdateEventToSessionUpdate(event.raw);
```

删除本地 `translateMessageUpdate()`、`extractMessageText()`、`isThought()` 等重复逻辑，或改为只在 `messages.ts` 中维护。

- [ ] **步骤 7：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/events-message.test.ts
```

预期：该文件全部通过。

---

## 任务 2：实时 prompt lifecycle 的 `agent_end.messages` fallback

**文件：**
- 修改：`src/acp/handlers/session-prompt.ts`
- 测试：`test/unit/acp/session-handlers.test.ts`
- 依赖：任务 1 已创建 `src/translate/messages.ts`

- [ ] **步骤 1：失败测试：handler 级真实 `text_delta` drain**

在 `test/unit/acp/session-handlers.test.ts` 增加测试：

```ts
test("prompt drains real OMP assistant text_delta before returning end_turn", async () => {
  const { manager, connection, runtime } = await createSession();
  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });

  runtime.emit({
    type: "event",
    eventType: "message_update",
    raw: {
      message: { role: "assistant", content: [{ type: "text", text: "final" }], responseId: "r1", timestamp: 1 },
      assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
    },
  });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: { messages: [] } });

  assert.deepEqual(connection.updates.at(-1), {
    sessionId: "session-1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
  });

  let settled = false;
  promptPromise.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  connection.resolveAllUpdates();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});
```

- [ ] **步骤 2：失败测试：`agent_end.messages` fallback 不重放 user/toolResult，按 content 维度去重且不漏第二个 assistant**

增加测试：

```ts
test("prompt fallbacks only unstreamed assistant messages from agent_end", async () => {
  const { manager, connection, runtime } = await createSession();
  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });

  runtime.emit({
    type: "event",
    eventType: "message_update",
    raw: {
      message: { role: "assistant", content: [{ type: "text", text: "streamed final" }], responseId: "streamed", timestamp: 1 },
      assistantMessageEvent: { type: "text_delta", delta: "streamed", contentIndex: 0 },
    },
  });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({
    type: "event",
    eventType: "agent_end",
    raw: {
      messages: [
        { role: "user", content: "do not replay" },
        { role: "toolResult", toolCallId: "tc", content: "do not replay" },
        { role: "assistant", content: [{ type: "text", text: "streamed final" }], responseId: "streamed", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "fallback final" }], responseId: "fallback", timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "first content streamed" }, { type: "text", text: "second content fallback" }], responseId: "partial", timestamp: 3 },
      ],
    },
  });

  await waitForCondition(() => connection.updates.length === 3);
  assert.deepEqual(connection.updates.map((entry) => entry.update), [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "streamed" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fallback final" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second content fallback" } },
  ]);

  connection.resolveAllUpdates();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

再增加同一 responseId 的部分流式场景：emit `message_update` 时 `responseId:"partial"`、`assistantMessageEvent.contentIndex:0`、`delta:"first content streamed"`，`agent_end.messages` 中同一 assistant message 包含 content[0] 和 content[1]；断言只补发 content[1]。该断言防止实现者用 message 级 key 跳过整条消息。
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-handlers.test.ts
```

预期：fallback 测试失败，因为当前 `agent_end` 不读取 `raw.messages`。

- [ ] **步骤 4：实现 streamed index 与 fallback emit**

修改 `src/acp/handlers/session-prompt.ts`：

1. 从 `src/translate/messages.ts` 导入 `agentEndMessagesToFallbackUpdates`、`streamedAssistantMessageKey`。
2. 在 `handleSessionPrompt()` 内创建 `const streamedAssistantMessages = new Set<string>();`，包装成 `{ has, add }`。
3. 每次 `message_update` 成功翻译并准备 emit 前，如果 `streamedAssistantMessageKey(event.raw)` 返回 key，并且 update 是 `agent_message_chunk` 或 `agent_thought_chunk`，将 key 加入 set；key 必须包含 assistant message identity、`assistantMessageEvent.contentIndex` 和 chunk 类型，不能只用 `responseId` / `timestamp`。
4. 收到 `agent_end` 时，先调用 `agentEndMessagesToFallbackUpdates(event.raw, streamedIndex)`，逐条 `emitUpdate()`，再 `completeTurn()`。
5. `agent_end` fallback 的 update 必须进入同一个 `updatePromises` 数组，让后续 drain 逻辑等待它们完成。

- [ ] **步骤 5：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-handlers.test.ts
```

预期：该文件全部通过。

---

## 任务 3A：实时工具转换接入输入/输出净化与共享 content

**文件：**
- 修改：`src/translate/tools.ts`
- 测试：`test/unit/translate/tools.test.ts`
- 依赖：任务 1 已创建 `src/translate/safety.ts` 与 `src/translate/content.ts`

- [ ] **步骤 1：失败测试：实时 tool start 净化 rawInput**

在 `test/unit/translate/tools.test.ts` 增加测试：

```ts
test("toolExecutionStartToUpdate sanitizes ACP-visible rawInput", () => {
  const update = toolExecutionStartToUpdate({
    type: "tool_execution_start",
    toolCallId: "call-secret",
    toolName: "bash",
    args: {
      command: "npm test",
      cwd: "/repo",
      providerApiKey: "secret",
      token: "secret",
      config: { baseURL: "https://secret.example", retries: 1 },
      accessKey: "secret",
      plain_key: "secret",
      "api-key": "secret",
      key: "secret",
    },
  });
  assert.deepEqual(update.rawInput, { command: "npm test", cwd: "/repo" });
  assert.equal(update.title, "Bash: npm test");
});
```

- [ ] **步骤 2：失败测试：实时 tool result 净化 rawOutput**

增加测试：

```ts
test("toolExecutionEndToUpdate sanitizes ACP-visible rawOutput", () => {
  const update = toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-output-secret",
    status: "completed",
    result: {
      content: [{ type: "text", text: "done", providerPayload: { token: "secret" } }],
      details: { exitCode: 0, token: "secret", config: { baseURL: "https://secret.example" } },
      providerPayload: { secret: "hidden" },
    },
  });
  assert.deepEqual(update.rawOutput, { content: [{ type: "text", text: "done" }], details: { exitCode: 0 } });
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: "done" } }]);
});

test("toolExecutionEndToUpdate sanitizes unsupported diff rawOutput", () => {
  const update = toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-diff-secret",
    diff: { operation: "rename", oldPath: "/repo/old.ts", newPath: "/repo/new.ts", token: "secret", config: { baseURL: "https://secret.example" } },
  });
  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.status, "failed");
  assert.deepEqual(update.rawOutput, {
    error: "Unsupported rename diff payload: rename requires string newText",
    diff: { operation: "rename", oldPath: "/repo/old.ts", newPath: "/repo/new.ts" },
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/tools.test.ts
```

预期：新增测试失败，因为当前 `rawInput` / `rawOutput` 原样透传。

- [ ] **步骤 4：实现 `tools.ts` 接入共享模块**

修改 `src/translate/tools.ts`：

- 导入 `parseToolInput`、`sanitizeToolInput`、`sanitizeToolOutputForAcp`。
- 导入 `contentItemsToToolCallContent`。
- `extractRawInput()` 返回 `sanitizeToolInput(parseToolInput(raw.rawInput ?? raw.input ?? raw.args))`。
- `normalizeRawOutput()` 对 cancelled/error 仍生成 `{ cancelled: true }` / `{ error }`，但返回前通过 `sanitizeToolOutputForAcp()`。
- `partialResult` / `result` / `output` / `content` 原始候选值统一净化，净化为 `undefined` 时不设置 `rawOutput`。
- `extractToolResultContent()` 改用 `contentItemsToToolCallContent(value, { unknownText: "drop" })`。
- unsupported diff 分支返回 `diff.rawOutput` 前也必须调用 `sanitizeToolOutputForAcp()`；净化为空时至少保留安全错误文本，不得把原始 `diff` 作为旁路泄漏到 ACP `rawOutput`。
- 删除本地 `toSafeContentBlock()` / `toSafeEmbeddedResource()` 重复实现。

- [ ] **步骤 5：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/tools.test.ts
```

预期：该文件全部通过。

---

## 任务 3B：历史回放接入共享 message/content/safety

**文件：**
- 修改：`src/runtime/omp/sessions.ts`
- 测试：`test/unit/runtime/omp/sessions.test.ts`
- 依赖：任务 1、任务 3A 的共享模块与工具转换已完成

- [ ] **步骤 1：失败测试：历史工具 rawOutput 使用共享净化**

在 `test/unit/runtime/omp/sessions.test.ts` 增加或扩展现有 rich history 测试，写入 JSONL：

```ts
{
  type: "message",
  role: "toolResult",
  toolCallId: "call-secret-result",
  content: [{ type: "text", text: "safe result", providerPayload: { token: "secret" } }],
  details: { exitCode: 0, token: "secret", config: { baseURL: "https://secret.example" } }
}
```

断言 `loadOmpSessionHistory()` 对应 `tool_call_update.rawOutput` 为：

```ts
{ content: [{ type: "text", text: "safe result" }], details: { exitCode: 0 } }
```

且字符串化结果不包含 `secret`、`baseURL`、`providerPayload`。

- [ ] **步骤 2：失败测试：历史 assistant/user message replay 使用共享 message sanitizer**

增加测试：assistant content 包含 text、安全 image/resource_link/resource、unknown safe note、private provider block；断言：

- text → `agent_message_chunk`。
- thinking → `agent_thought_chunk`。
- safe unknown 在历史策略下摘要。
- provider/private/signature/encrypted block 不出现。

- [ ] **步骤 3：运行测试验证失败或确认当前分叉存在**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/sessions.test.ts
```

预期：至少 rawOutput 或共享映射相关断言失败；如果某个断言已因任务 3A 间接通过，仍继续执行步骤 4 删除本地重复实现。

- [ ] **步骤 4：实现 `sessions.ts` 接入共享模块**

修改 `src/runtime/omp/sessions.ts`：

- 从 `src/translate/messages.ts` 导入 `messageToSessionUpdates`。
- 从 `src/translate/safety.ts` 导入 `parseToolInput`、`sanitizeToolInput`。
- 从 `src/translate/content.ts` 导入 `contentItemsToToolCallContent` 或 `sanitizeContentBlock` / `summarizeUnknownContentBlock`。
- 删除本地 `sanitizeToolInput()`、`parseToolInput()`、`isPrivateHistoryKey()`、`sanitizeRenderableContentBlock()`、`sanitizeEmbeddedResource()`、`summarizeUnknownContentBlock()` 等重复实现；若有少量历史专用 wrapper，必须只调用共享函数。
- `messageToSessionUpdates(message, path, line)` 对 `role === "user" || "assistant"` 改为调用共享 `messageToSessionUpdates(message, { unknownText: "summarize", includeToolCalls: true })`，并保留 unknown role 明确抛错。
- 历史 `toolCall` 继续使用 `toolExecutionStartToUpdate()`，但输入来自共享 `sanitizeToolInput(parseToolInput(...))`。
- 历史 `toolResult` 继续使用 `toolExecutionEndToUpdate()`，让任务 3A 的共享 rawOutput 净化生效。

- [ ] **步骤 5：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/sessions.test.ts
```

预期：该文件全部通过。

---

## 任务 3C：host tool 输入/输出净化与 cancel id 归一化

**文件：**
- 修改：`src/runtime/omp/host-tools.ts`
- 测试：`test/unit/runtime/omp/host-tools.test.ts`
- 依赖：任务 1 已创建 `src/translate/safety.ts`

- [ ] **步骤 1：失败测试：host tool rawInput 净化**

在 `test/unit/runtime/omp/host-tools.test.ts` 增加测试：

```ts
test("host tool ACP rawInput is sanitized while raw OMP frame keeps original input", async () => {
  const { bridge, frames, updates } = createBridge({
    lookup: async ({ arguments: input }) => ({ ok: true, input }),
  });
  await bridge.handle({
    type: "host_tool_call",
    id: "host_secret",
    toolCallId: "tc_secret",
    toolName: "lookup",
    arguments: { query: "abc", token: "secret", config: { baseURL: "https://secret.example" } },
  });
  assert.deepEqual(updates[0], {
    sessionUpdate: "tool_call",
    toolCallId: "tc_secret",
    title: "lookup",
    kind: "other",
    status: "pending",
    rawInput: { query: "abc" },
  });
  assert.deepEqual(frames.at(-1), {
    type: "host_tool_result",
    id: "host_secret",
    result: { ok: true, input: { query: "abc", token: "secret", config: { baseURL: "https://secret.example" } } },
  });
});
```

该测试要求 ACP visible rawInput 净化，但 OMP host tool executor/回写语义不被破坏。

- [ ] **步骤 2：失败测试：host tool rawOutput 净化**

增加测试：host executor 返回 `{ ok: true, token: "secret", data: { value: 1 } }`，断言 ACP `tool_call_update.rawOutput` 为 `{ ok: true, data: { value: 1 } }`，但回写 OMP `host_tool_result.result` 仍是原始 executor result。

- [ ] **步骤 3：失败测试：cancel by `toolCallId` 回写原始 host id**

增加测试：

```ts
test("cancel by toolCallId aborts active host tool and replies with original host call id", async () => {
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const { bridge, frames, updates } = createBridge({
    long: async ({ signal }) => {
      signal.addEventListener("abort", release);
      await started;
      return { shouldNotWin: true };
    },
  });
  const call = bridge.handle({ type: "host_tool_call", id: "host_1", toolCallId: "tc_1", toolName: "long" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await bridge.handle({ type: "host_tool_cancel", id: "cancel_1", toolCallId: "tc_1" });
  await call;
  assert.deepEqual(updates.at(-1), { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "failed", rawOutput: { cancelled: true } });
  assert.deepEqual(frames.at(-1), {
    type: "host_tool_result",
    id: "host_1",
    isError: true,
    result: { content: [{ type: "text", text: "Host tool call cancelled" }] },
  });
});
```

- [ ] **步骤 4：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/host-tools.test.ts
```

预期：新增净化与 cancel by `toolCallId` 测试失败。

- [ ] **步骤 5：实现 host tool bridge 修复**

修改 `src/runtime/omp/host-tools.ts`：

- `ActiveCall` 增加 `id: string`。
- 将 `activeCalls` 拆为 `activeCallsById` 与 `activeCallIdByToolCallId`。
- pending ACP `tool_call.rawInput` 使用 `sanitizeToolInput(input)`；executor 仍接收原始 `input`。
- completed/failed/cancelled ACP `rawOutput` 使用 `sanitizeToolOutputForAcp()`；OMP `host_tool_result` 仍使用原始 result/error contract。
- cancel 时优先用 `targetId` 查原始 id；未命中再用 `toolCallId` 查映射；回写 OMP frame 的 `id` 必须是原始 host call id。
- cleanup 删除两个索引。

- [ ] **步骤 6：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/host-tools.test.ts
```

预期：该文件全部通过。

---

## 任务 4：extension UI classifier 共享化

**文件：**
- 创建：`src/translate/extension-ui.ts`
- 修改：`src/acp/extension-ui.ts`
- 修改：`src/translate/events.ts`
- 测试：`test/unit/acp/extension-ui.test.ts`
- 测试：`test/unit/translate/events-message.test.ts`

- [ ] **步骤 1：失败测试：classifier 分类矩阵**

在 `test/unit/acp/extension-ui.test.ts` 或 `test/unit/translate/events-message.test.ts` 增加对共享 classifier 的断言：

```ts
assert.equal(classifyExtensionUiRequest({ method: "confirm" }), "confirm");
assert.equal(classifyExtensionUiRequest({ method: "setWidget" }), "widget");
assert.equal(classifyExtensionUiRequest({ method: "notify" }), "fire_and_forget");
assert.equal(classifyExtensionUiRequest({ method: "setStatus" }), "fire_and_forget");
assert.equal(classifyExtensionUiRequest({ method: "select" }), "unsupported_interactive");
assert.equal(classifyExtensionUiRequest({ method: "input" }), "unsupported_interactive");
assert.equal(classifyExtensionUiRequest({ method: "editor" }), "unsupported_interactive");
assert.equal(classifyExtensionUiRequest({ method: "unknown" }), "unsupported");
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/extension-ui.test.ts test/unit/translate/events-message.test.ts
```

预期：导入 `classifyExtensionUiRequest` 失败或分类函数不存在。

- [ ] **步骤 3：创建共享 classifier**

创建 `src/translate/extension-ui.ts`：

```ts
export type ExtensionUiRequestClass = "confirm" | "widget" | "fire_and_forget" | "unsupported_interactive" | "unsupported";

export function classifyExtensionUiRequest(raw: Record<string, unknown>): ExtensionUiRequestClass {
  switch (raw.method) {
    case "confirm": return "confirm";
    case "setWidget": return "widget";
    case "cancel":
    case "notify":
    case "setStatus":
    case "setTitle":
    case "set_editor_text":
      return "fire_and_forget";
    case "select":
    case "input":
    case "editor":
      return "unsupported_interactive";
    default:
      return "unsupported";
  }
}

export function isFireAndForgetExtensionUiRequest(raw: Record<string, unknown>): boolean {
  return classifyExtensionUiRequest(raw) === "fire_and_forget";
}

export function formatExtensionUiRequest(raw: Record<string, unknown>): string { /* existing formatter */ }
```

- [ ] **步骤 4：接入 bridge 与 translator**

- `src/acp/extension-ui.ts` 使用 `classifyExtensionUiRequest()` 和 `formatExtensionUiRequest()`；删除本地 formatter。
- `src/translate/events.ts` 使用同一 classifier；`widget` 在通用 fallback 中返回 `undefined`，并注释 widget 只有 prompt bridge 路径负责可见展示；unsupported interactive/unsupported 抛 `UnsupportedRuntimeEventError(formatExtensionUiRequest(raw))`。

- [ ] **步骤 5：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/extension-ui.test.ts test/unit/translate/events-message.test.ts
```

预期：两个测试文件全部通过。

---

## 任务 5A：SessionSetupState public projection 核心与 new/load

**文件：**
- 修改：`src/acp/session-controls.ts`
- 修改：`src/acp/handlers/session-new.ts`
- 修改：`src/acp/handlers/session-load.ts`
- 测试：`test/unit/acp/session-config.test.ts`
- 测试：`test/unit/acp/session-list-load.test.ts`

- [ ] **步骤 1：失败测试：load response 不包含 `runtimeSessionId`**

在 `test/unit/acp/session-list-load.test.ts` 的 fake runtime/control state 中确保 `get_state` 返回非空 `sessionId`，例如 `"omp-runtime-session"`，再对 `handleSessionLoad()` 的 response 增加断言：`Object.hasOwn(response, "runtimeSessionId") === false`。如果已有 load 测试返回 setup state，必须先让 fake state 包含 `sessionId`，否则红灯无法证明泄漏存在。

- [ ] **步骤 2：失败测试：shared projection helper 可用**

在 `test/unit/acp/session-config.test.ts` 增加对 `toPublicSessionSetupState()` 的行为断言：

```ts
assert.deepEqual(
  toPublicSessionSetupState({ models, modes, configOptions, runtimeSessionId: "internal" }),
  { models, modes, configOptions },
);
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts
```

预期：helper 导入失败或 load 泄漏内部字段。

- [ ] **步骤 4：实现 shared projection**

修改 `src/acp/session-controls.ts`：

```ts
export type SessionSetupStatePublic = Pick<NewSessionResponse, "models" | "modes" | "configOptions">;
export type SessionSetupState = SessionSetupStatePublic & { runtimeSessionId?: string };

export function requireSessionSetupState(setupState: SessionSetupState | undefined): SessionSetupState {
  if (setupState === undefined) throw new Error("Session setup state was not built before publish");
  return setupState;
}

export function toPublicSessionSetupState(setupState: SessionSetupState): SessionSetupStatePublic {
  const { runtimeSessionId: _runtimeSessionId, ...publicState } = setupState;
  return publicState;
}
```

- [ ] **步骤 5：接入 new/load**

- `session-new.ts` 删除私有 `requireSetupState()` 和 `toPublicSetupState()`，改用 shared helpers。
- `session-load.ts` 返回 `toPublicSessionSetupState(requireSessionSetupState(setupState))`。

- [ ] **步骤 6：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts
```

预期：两个测试文件全部通过。

---

## 任务 5B：SessionSetupState public projection 覆盖 resume/fork

**文件：**
- 修改：`src/acp/handlers/session-resume.ts`
- 修改：`src/acp/handlers/session-fork.ts`
- 测试：`test/unit/acp/session-resume.test.ts`
- 测试：`test/unit/acp/session-fork.test.ts`
- 依赖：任务 5A 已导出 `requireSessionSetupState()` 与 `toPublicSessionSetupState()`

- [ ] **步骤 1：失败测试：resume response 不包含 `runtimeSessionId`**

在 `test/unit/acp/session-resume.test.ts` 的 fake runtime/control state 中确保 `get_state` 返回非空 `sessionId`，例如 `"omp-runtime-session"`，再对 resume response 增加：

```ts
assert.equal(Object.hasOwn(response, "runtimeSessionId"), false);
```

- [ ] **步骤 2：失败测试：fork response 不包含 `runtimeSessionId`**

在 `test/unit/acp/session-fork.test.ts` 的 fake runtime/control state 中确保 `get_state` 返回非空 `sessionId`，再对 fork response 增加同样断言。保留 `session/new` 返回真实 runtime session id 的既有断言，不要把 public projection 用到 `sessionId` 本身。

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts
```

预期：当前 handlers 直接返回 `requireSetupState(setupState)`，可能包含 `runtimeSessionId`。

- [ ] **步骤 4：接入 shared projection**

- `session-resume.ts` 删除私有 `requireSetupState()`，返回 `toPublicSessionSetupState(requireSessionSetupState(setupState))`。
- `session-fork.ts` 删除私有 `requireSetupState()`，返回 `{ sessionId: fork.sessionId, ...toPublicSessionSetupState(requireSessionSetupState(setupState)) }`。

- [ ] **步骤 5：运行目标测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts
```

预期：两个测试文件全部通过。

---

## 任务 6：真实 OMP `set_active_tools` smoke 覆盖

**文件：**
- 修改：`scripts/smoke-omp-rpc-controls.mjs`
- 可能修改：`package.json`（仅当脚本名或输出契约需要更新；默认不需要）

- [ ] **步骤 1：失败测试：抽出 deterministic `set_active_tools` smoke helper**

先把脚本中的 set-active-tools 逻辑设计为可测试 helper，例如导出或内部测试入口 `verifySetActiveToolsRoundTrip(initialState, request, rereadState)`；在 `test/smoke/omp-rpc-controls-smoke.test.mjs` 或同等脚本测试中覆盖三类红灯：

```js
// 无 dumpTools：返回 skipped true，reason 包含 dumpTools unavailable，不调用 request。
// dumpTools 含 ask：调用 set_active_tools 去掉 ask，reread 验证 ask 消失，再恢复原列表并验证 restored true。
// set_active_tools request 抛错：helper 必须抛出，不能转成 skip。
```

运行：

```bash
node --test test/smoke/omp-rpc-controls-smoke.test.mjs
```

预期：新增测试失败，因为当前脚本没有可注入 helper，也没有覆盖 `set_active_tools` 分支。

- [ ] **步骤 2：实现可测试 helper 与安全 round-trip / skip**

修改 `scripts/smoke-omp-rpc-controls.mjs`：

1. `initialState` 读取后从 `dumpTools` 提取 `toolNames`。
2. 如果 `dumpTools` 不是数组，输出 JSON 中添加：

```json
"set_active_tools": { "skipped": true, "reason": "get_state.dumpTools unavailable" }
```

3. 如果 `dumpTools` 中包含 `ask`：
   - 保存原始 tool names。
   - 请求 `set_active_tools` 为去掉 `ask` 的列表。
   - 再次 `get_state`，断言 `ask` 不存在且其他工具仍存在。
   - 恢复原始列表。
   - 再次 `get_state`，断言恢复成功。
   - 输出 `set_active_tools: { skipped:false, success:true, removed:"ask", restored:true }`。
4. 如果不包含 `ask`：输出 skip，reason 为 `active tools do not include ask; mutation skipped to avoid disturbing user tools`。
5. 如果 `set_active_tools` 命令返回失败，脚本必须 fail，不允许 skip。

- [ ] **步骤 3：运行 smoke helper 测试与静态目标检查**

运行：

```bash
node --test test/smoke/omp-rpc-controls-smoke.test.mjs
node --check scripts/smoke-omp-rpc-controls.mjs
```

预期：helper 测试通过，脚本语法检查 exit 0。

- [ ] **步骤 4：真实 smoke（环境可用时）**

运行：

```bash
npm run smoke:omp-rpc-controls
```

预期：

- 如果 `omp` 不存在，输出 `{ "skipped": true, "reason": "omp not found" }`，exit 0。
- 如果 `dumpTools` 不可用或不含 `ask`，输出 `set_active_tools.skipped: true`，exit 0。
- 如果 `dumpTools` 含 `ask`，执行 mutation、验证、恢复，exit 0。
- 如果命令不支持或恢复失败，exit 非 0。

---

## 任务 7：文档边界与最终验证

**文件：**
- 修改：`docs/compatibility/capability-matrix.md`
- 修改：`docs/compatibility/zed.md`
- 可能修改：`README.md`

- [ ] **步骤 1：文档更新**

仅记录已经实现并自动化验证的边界：

- 实时 Assistant streaming 支持真实 OMP `assistantMessageEvent.text_delta` / `thinking_delta`。
- `agent_end.messages` 是去重 fallback，避免 prompt 返回 `end_turn` 前漏掉最终 assistant 文本。
- ACP-visible `rawInput` / `rawOutput` 经过共享净化，不暴露 provider/private/config/key/token/signature/encrypted 字段。
- 不新增 ACP elicitation，不把 `select/input/editor` 映射为 permission。
- GUI Zed/ZedG 手工 smoke 仍是发布门禁，若未执行不得声称通过。

- [ ] **步骤 2：运行目标回归测试组**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/tools.test.ts test/unit/translate/events-message.test.ts test/unit/acp/session-handlers.test.ts test/unit/runtime/omp/sessions.test.ts test/unit/runtime/omp/host-tools.test.ts
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts test/unit/acp/extension-ui.test.ts
```

预期：所有目标测试通过。

- [ ] **步骤 3：运行完整检查**

运行：

```bash
npm run check
npm run build
git diff --check
```

预期：`npm run check` exit 0，`npm run build` exit 0，`git diff --check` 无输出。

- [ ] **步骤 4：验证构建资产**

构建后确认：

```bash
node -e "const fs=require('node:fs'); for (const p of ['dist/index.js','dist/disable-ask-extension.mjs']) { if (!fs.existsSync(p)) throw new Error(`${p} missing`); }"
```

预期：exit 0。

- [ ] **步骤 5：最终只读审查**

分派 3 个以上 read-only reviewer 子代理并发审查：

1. 安全边界：`rawInput` / `rawOutput` / content 是否仍有敏感泄漏旁路。
2. 实时 prompt lifecycle：真实 assistant streaming、fallback 去重、drain 与 cancel 是否正确。
3. lifecycle / extension UI / smoke：public projection、classifier、set_active_tools smoke 是否符合规格。

所有 reviewer approve 后才可宣称完成。
