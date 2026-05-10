# ACP adapter 架构硬化与发布门禁修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。必须直接在当前 `main` 工作区开发，不创建 git worktree。所有行为变更必须先写失败测试并观察红灯，再实现最小代码使其通过。审查循环已由用户提前批准，所有 review 子代理通过后可以继续下一阶段。

**目标：** 修复 ACP adapter 第二轮架构审查发现的 session 发布、Ask 禁用、工具输出语义、发布门禁、测试发现与空目录清理问题。

**架构：** `SessionManager` 改为 beforeGuard / afterGuard 两阶段发布流程，在最终 OMP session 上执行 Ask 禁用并统一 final session id reservation；工具输出安全策略区分结构化对象与普通文本 stdout；发布验证拆分 optional/required real OMP smoke；测试入口改为跨平台 Node discovery script；清理无用途空目录并更新文档边界。

**技术栈：** Node.js >= 20、TypeScript、`@agentclientprotocol/sdk@0.21.0`、`node:test`、OMP RPC JSONL、ACP stdio。

**规格来源：** `C:\Users\34404\source\repos\omp-acp\docs\superpowers\specs\2026-05-10-acp-architecture-hardening-design.md`。

---

## 文件结构与职责

- 修改：`src/session/manager.ts` — session 创建生命周期、final id reservation、Ask 禁用顺序。
- 修改：`src/acp/handlers/session-new.ts` — 使用 afterGuard 构建 setup state 并返回真实 runtime session id。
- 修改：`src/acp/handlers/session-load.ts` — switch 放入 beforeGuard，setup state 放入 afterGuard。
- 修改：`src/acp/handlers/session-resume.ts` — switch 放入 beforeGuard，setup state 放入 afterGuard。
- 修改：`src/acp/handlers/session-fork.ts` — switch 放入 beforeGuard，setup state 放入 afterGuard，fork cleanup 不变。
- 修改：`src/translate/safety.ts` — 增加文本输出 redaction，默认字符串输出不 JSON parse。
- 修改：`src/translate/tools.ts` — rawOutput 与 content 使用同一个净化后字符串；结构化输出仍递归净化。
- 修改：`src/runtime/omp/sessions.ts` — 历史 tool result 复用新的输出策略。
- 修改：`scripts/smoke-omp-rpc-controls.mjs` — 增加 required 模式和可测试的 skip/fail 语义。
- 创建：`scripts/run-tests.mjs` — 跨平台递归发现并运行 `test/**/*.test.ts` 与 `test/**/*.test.mjs`。
- 修改：`package.json` — 测试入口、optional/required smoke 脚本、`validate:standard`。
- 修改：`README.md`、`docs/release-checklist.md`、`docs/compatibility/capability-matrix.md`、`docs/compatibility/zed.md` — 更新验证与能力边界。
- 删除空目录：`testunittranslate/`、`srctranslate/`、`testunitruntimeomp/`、`srcacptransport/`、`testsmoke/`。
- 测试：`test/unit/session/manager.test.ts`、`test/unit/acp/session-list-load.test.ts`、`test/unit/acp/session-resume.test.ts`、`test/unit/acp/session-fork.test.ts`、`test/unit/acp/session-config.test.ts`、`test/unit/translate/tools.test.ts`、`test/unit/runtime/omp/sessions.test.ts`、`test/smoke/omp-rpc-controls-smoke.test.mjs`、`test/smoke/test-discovery.test.mjs`。

---
## 并行执行边界

- 任务 1A 必须先独占修改 `src/session/manager.ts` 与 `test/unit/session/manager.test.ts`，产出 `CreateSessionHooks` 合同和 final id reservation 行为。
- 任务 1B、1C、1D 必须在 1A 完成并通过目标测试后执行；它们只消费 1A 的合同，不再改 `src/session/manager.ts`。
- 任务 2、任务 3、任务 4 可与生命周期批次分开并行执行，因为文件边界不同；若任务 3 修改 `package.json`，最终由主协调者统一运行 `npm run check`。
- 最终复审固定至少 4 个只读 reviewer，少于 4 个不得视为通过。


## 任务 1A：SessionManager 合同与 final id reservation

**文件：**
- 修改：`src/session/manager.ts`
- 测试：`test/unit/session/manager.test.ts`

### 步骤 1：失败测试 — final session id 不得覆盖 pending id

在 `test/unit/session/manager.test.ts` 增加测试：

```ts
test("createSessionWithId rejects a final runtime session id reserved by another pending session", async () => {
  const runtimes: FakeRuntime[] = [];
  const manager = new SessionManager({
    runtimeFactory: (input) => {
      const runtime = new FakeRuntime(input.sessionId);
      runtimes.push(runtime);
      return runtime;
    },
  });

  let releaseB!: () => void;
  const pendingB = manager.createSessionWithId("session-b", request(), async () => {
    await new Promise<void>((resolve) => { releaseB = resolve; });
  });

  await assert.rejects(
    manager.createSessionWithId("session-a", request(), {
      afterGuard: async () => ({ sessionId: "session-b" }),
    }),
    /Session already exists: session-b/,
  );

  assert.equal(runtimes[1]?.closed, true);
  releaseB();
  await pendingB;
  assert.equal(manager.tryGetSession("session-b")?.sessionId, "session-b");
});
```

如果现有 helper 不是 `request()` / `FakeRuntime` 形状，按当前测试文件 helper 改写，但断言必须覆盖：A 的 final id 等于 B 的 pending id，A 失败并关闭 runtime，B 后续可发布。

### 步骤 2：失败测试 — final id 已发布时关闭 runtime

在 `test/unit/session/manager.test.ts` 增加：

```ts
test("createSessionWithId closes runtime when final runtime session id already exists", async () => {
  const runtimes: FakeRuntime[] = [];
  const manager = new SessionManager({ runtimeFactory: makeRuntimeFactory(runtimes) });

  await manager.createSessionWithId("existing", request());

  await assert.rejects(
    manager.createSessionWithId("new-id", request(), {
      afterGuard: async () => ({ sessionId: "existing" }),
    }),
    /Session already exists: existing/,
  );

  assert.equal(runtimes.at(-1)?.closed, true);
  assert.equal(manager.tryGetSession("existing")?.sessionId, "existing");
});
```

### 步骤 3：失败测试 — Ask guard 失败不发布并关闭 runtime

在 `test/unit/session/manager.test.ts` 增加：

```ts
test("createSessionWithId does not publish when post-switch ask disable fails", async () => {
  const runtime = new FakeRuntime("session-1", {
    getStateResponses: [{ dumpTools: [{ name: "ask" }] }],
    failSetActiveTools: true,
  });
  const manager = new SessionManager({ runtimeFactory: () => runtime });

  await assert.rejects(
    manager.createSessionWithId("session-1", request(), {
      beforeGuard: async () => ({ sessionId: "session-1" }),
      afterGuard: async () => undefined,
    }),
    /Runtime failed to become ready for session session-1/,
  );

  assert.equal(runtime.closed, true);
  assert.equal(manager.tryGetSession("session-1"), undefined);
});
```

### 步骤 4：运行红灯测试

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/session/manager.test.ts
```

预期：新增 final id collision / Ask guard ordering 相关测试失败，原因是当前 `createSessionWithId()` 不支持 hook object、仍在 callback 前禁用 Ask、且未检查 pending final id。

### 步骤 5：实现 CreateSessionHooks 与 final reservation

在 `src/session/manager.ts` 中：

1. 替换旧类型：

```ts
type SessionPublishOverride = { sessionId?: string } | undefined;
export type CreateSessionHooks = {
  beforeGuard?: (runtime: RuntimeAdapter) => Promise<SessionPublishOverride>;
  afterGuard?: (runtime: RuntimeAdapter) => Promise<SessionPublishOverride>;
};
type BeforePublishRuntime = (runtime: RuntimeAdapter) => Promise<{ sessionId?: string } | void>;
type CreateSessionPublishHooks = BeforePublishRuntime | CreateSessionHooks;
```

2. 在 `createSessionWithId()` 支持旧 callback 兼容内部迁移，但新 handlers 必须使用 object hooks：

```ts
const hooks = normalizeCreateSessionHooks(beforePublish);
```

3. 固定顺序：

```ts
await runtime.ready;
const beforeOverride = await hooks.beforeGuard?.(runtime);
await disableOmpAskTool(runtime);
const afterOverride = await hooks.afterGuard?.(runtime);
publishedSessionId = afterOverride?.sessionId ?? beforeOverride?.sessionId ?? sessionId;
```

4. 增加 final reservation：

```ts
let finalReservation: { sessionId: string; token: symbol } | undefined;
...
finalReservation = this.#reserveFinalSessionId(publishedSessionId, sessionId, pendingSessionReservation);
```

5. 实现私有方法：

```ts
#reserveFinalSessionId(finalSessionId: string, initialSessionId: string, initialReservation: symbol) {
  if (this.#sessions.has(finalSessionId)) {
    throw new SessionManagerError(`Session already exists: ${finalSessionId}`);
  }
  const existingPending = this.#pendingSessionIds.get(finalSessionId);
  if (existingPending !== undefined && !(finalSessionId === initialSessionId && existingPending === initialReservation)) {
    throw new SessionManagerError(`Session already exists: ${finalSessionId}`);
  }
  if (finalSessionId === initialSessionId) return undefined;
  const token = Symbol(finalSessionId);
  this.#pendingSessionIds.set(finalSessionId, token);
  return { sessionId: finalSessionId, token };
}
```

6. `finally` 释放 initial 与 final reservation，仅删除 token 匹配的 reservation。

7. 发布前即使 `publishedSessionId === sessionId`，也必须经过 `#sessions.has()` 检查，避免覆盖。

### 步骤 6：运行 SessionManager 目标测试

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/session/manager.test.ts
```

预期：全部通过。

---

## 任务 1B：session-new 调用点迁移

**依赖：** 必须等待任务 1A 完成。

**文件：**
- 修改：`src/acp/handlers/session-new.ts`
- 测试：`test/unit/acp/session-config.test.ts`

### 步骤 1：失败测试 — session-new 真实 id 来自 post-guard afterGuard

在 `test/unit/acp/session-config.test.ts` 中确认或新增断言：fake runtime 的 `get_state` 返回 `sessionId:"omp-runtime-session"` 且 `dumpTools` 含 `ask` 时，`handleSessionNew()` 必须先调用 `set_active_tools` 去掉 ask，再返回 `sessionId:"omp-runtime-session"`，并且 response 不包含 `runtimeSessionId`。

### 步骤 2：迁移 session-new

将 `src/acp/handlers/session-new.ts` 改为使用 object hooks：

```ts
const record = await manager.createSessionWithId(sessionId, params, {
  afterGuard: async (runtime) => {
    setupState = await buildSessionSetupState(runtime);
    return setupState.runtimeSessionId !== undefined ? { sessionId: setupState.runtimeSessionId } : undefined;
  },
});
```

### 步骤 3：运行目标测试

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts
```

---

## 任务 1C：session-load 与 session-resume 调用点迁移

**依赖：** 必须等待任务 1A 完成。

**文件：**
- 修改：`src/acp/handlers/session-load.ts`
- 修改：`src/acp/handlers/session-resume.ts`
- 测试：`test/unit/acp/session-list-load.test.ts`
- 测试：`test/unit/acp/session-resume.test.ts`

### 步骤 1：失败测试 — load/resume 在 switch 后禁用 ask

在两个测试文件中让 fake runtime 初始 `get_state.dumpTools` 无 `ask`，`switch_session` 后 `get_state.dumpTools` 含 `ask` 和 `bash`。断言请求顺序中 `set_active_tools({ toolNames:["bash"] })` 出现在 `switch_session` 之后、setup state 的最终 `get_state/get_available_models` 之前。

### 步骤 2：迁移 load/resume

`session-load.ts` 和 `session-resume.ts` 使用：

```ts
const record = await manager.createSessionWithId(params.sessionId, params, {
  beforeGuard: async (runtime) => {
    await runtime.request("switch_session", { sessionPath: session.path });
    return { sessionId: params.sessionId };
  },
  afterGuard: async (runtime) => {
    setupState = await buildSessionSetupState(runtime);
  },
});
```

`session-load.ts` replay history 使用 `record.sessionId`。

### 步骤 3：运行目标测试

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts
```

---

## 任务 1D：session-fork 调用点迁移

**依赖：** 必须等待任务 1A 完成。

**文件：**
- 修改：`src/acp/handlers/session-fork.ts`
- 测试：`test/unit/acp/session-fork.test.ts`

### 步骤 1：失败测试 — fork 在 switch 后禁用 ask

在 `test/unit/acp/session-fork.test.ts` 中让 fork fake runtime 初始 `get_state.dumpTools` 无 `ask`，`switch_session` 到 fork file 后 `get_state.dumpTools` 含 `ask` 和 `bash`。断言 `set_active_tools` 在 `switch_session` 后调用；若 `set_active_tools` 或 setup state 失败，fork session 不发布且 fork 文件被清理。

### 步骤 2：迁移 fork

`session-fork.ts` 的 `createSessionWithId(forkId, params, ...)` 改为：

```ts
await manager.createSessionWithId(forkId, params, {
  beforeGuard: async (runtime) => {
    await runtime.request("switch_session", { sessionPath: fork!.path });
    return { sessionId: fork!.sessionId };
  },
  afterGuard: async (runtime) => {
    setupState = await buildSessionSetupState(runtime);
  },
});
```

响应仍为 `{ sessionId: fork.sessionId, ...toPublicSessionSetupState(...) }`。

### 步骤 3：运行目标测试

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-fork.test.ts
```

---

## 任务 1E：生命周期集成回归

**依赖：** 必须等待任务 1B、1C、1D 完成。

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/session/manager.test.ts test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts
```

预期：全部通过。

---

## 任务 2：工具输出文本语义与安全 redaction

**文件：**
- 修改：`src/translate/safety.ts`
- 修改：`src/translate/tools.ts`
- 修改：`src/runtime/omp/sessions.ts`（仅在历史 payload 仍调用旧 parse 语义时）
- 测试：`test/unit/translate/tools.test.ts`
- 测试：`test/unit/runtime/omp/sessions.test.ts`

### 步骤 1：失败测试 — JSON 字符串输出保持文本

在 `test/unit/translate/tools.test.ts` 增加：

```ts
test("toolExecutionEndToUpdate keeps JSON string output as text", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "json-text",
    status: "completed",
    rawOutput: '{"ok":true}',
  }));

  assert.equal(update.rawOutput, '{"ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"ok":true}' } }]);
});
```

### 步骤 2：失败测试 — 敏感 JSON 文本 rawOutput/content 同源脱敏

在同文件增加：

```ts
test("toolExecutionEndToUpdate redacts sensitive JSON text output consistently in rawOutput and content", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "json-secret-text",
    status: "completed",
    rawOutput: '{"token":"secret-token","ok":true,"config":{"baseURL":"https://private"}}',
  }));

  assert.equal(typeof update.rawOutput, "string");
  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("https://private"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("baseURL"), false);
  assert.equal(update.content?.[0]?.type, "content");
  assert.equal((update.content?.[0] as { content: { text?: string } }).content.text, update.rawOutput);
});
```

### 步骤 3：失败测试 — 结构化对象输出仍递归净化

保留或新增：

```ts
test("toolExecutionEndToUpdate still sanitizes structured object output", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "structured-output",
    status: "completed",
    rawOutput: { ok: true, token: "secret", data: { value: 1 }, config: { baseURL: "https://private" } },
  }));

  assert.deepEqual(update.rawOutput, { ok: true, data: { value: 1 } });
});
```

```ts
test("toolExecutionEndToUpdate keeps JSON string result output as text rawOutput", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "json-result-text",
    status: "completed",
    result: '{"ok":true}',
  }));

  assert.equal(update.rawOutput, '{"ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"ok":true}' } }]);
});
```

```ts
test("toolExecutionUpdateToUpdate keeps JSON string partialResult output as text rawOutput", () => {
  const update = assertToolCallUpdate(toolExecutionUpdateToUpdate({
    type: "tool_execution_update",
    toolCallId: "json-partial-text",
    status: "running",
    partialResult: '{"ok":true}',
  }));

  assert.equal(update.rawOutput, '{"ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"ok":true}' } }]);
});
```

### 步骤 4：失败测试 — 历史 tool result 字符串输出一致

在 `test/unit/runtime/omp/sessions.test.ts` 增加：

```ts
it("keeps replayed JSON string tool output as redacted text", async () => {
  const agentDir = await tempAgentDir();
  const path = await writeSessionFile(agentDir, "json-output", "history.jsonl", [
    { type: "session", id: "json-output", cwd: "/project" },
    { type: "toolResult", id: "tool-1", toolCallId: "tool-1", rawOutput: '{"token":"secret-token","ok":true}' },
  ]);

  const updates = await loadOmpSessionHistory(path);
  const result = updates.find((update) => update.sessionUpdate === "tool_call_update");
  assert.ok(result);
  assert.equal(typeof result.rawOutput, "string");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});
```

### 步骤 5：运行红灯测试

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/tools.test.ts test/unit/runtime/omp/sessions.test.ts
```

预期：JSON 字符串输出当前会被 parse 成对象，测试失败。

### 步骤 6：实现文本输出 redaction

在 `src/translate/safety.ts` 增加：

```ts
const SENSITIVE_JSON_TEXT_KEY_PATTERN = /"(?:[^"\\]|\\.)*(?:signature|encrypted|provider|apiKey|api_key|key|authorization|auth|config|token|secret|baseURL|base_url)(?:[^"\\]|\\.)*"\s*:/i;

export function sanitizeTextForAcp(value: string): string {
  if (!SENSITIVE_JSON_TEXT_KEY_PATTERN.test(value)) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    const sanitized = sanitizeAcpVisibleValue(parsed);
    return sanitized === undefined ? "[redacted]" : JSON.stringify(sanitized);
  } catch {
    return "[redacted]";
  }
}
```

注意：该函数返回字符串，即使内部临时 parse，也不能把 ACP `rawOutput` 变成对象。

调整 `sanitizeToolOutputForAcp(value)`：

```ts
export function sanitizeToolOutputForAcp(value: unknown): unknown {
  if (typeof value === "string") return sanitizeTextForAcp(value);
  return sanitizeAcpVisibleValue(value);
}
```

`sanitizeToolInput()` 仍可对 JSON 字符串先 `parseToolInput()`，调用处保持不变。

### 步骤 7：调整 tools.ts 输出路径同源

在 `src/translate/tools.ts`：

- `sanitizeRawOutputCandidate(value)` 不再调用 `parseToolInput(value)`。
- `safeTextOutput(value)` 改为返回 `sanitizeTextForAcp(value)`，不再因 JSON parse 成功而丢弃。
- 为避免 rawOutput/content 分别净化产生不一致，引入局部 helper：

```ts
function normalizedOutputCandidates(raw: Record<string, unknown>): { rawOutput: unknown; text?: string } {
  const candidate = raw.rawOutput ?? raw.output ?? raw.partialResult ?? raw.result ?? raw.content;
  const sanitized = candidate === undefined ? undefined : sanitizeToolOutputForAcp(candidate);
  return { rawOutput: sanitized, text: typeof sanitized === "string" ? sanitized : undefined };
}
```

- `toolExecutionProgressToUpdate()` 使用该 helper，同一个 `text` 同时驱动 `rawOutput` 和 visible content。
- `extractContent()` 接收已净化 text candidate，不能重新从原始 raw 字段生成第一段文本。
- `partialResult` / `result` 若是对象或数组，仍调用 `contentItemsToToolCallContent()`；若是字符串，先 `sanitizeTextForAcp()`，且若它们是 rawOutput 候选来源，rawOutput 与 content 必须同源。

### 步骤 8：运行目标测试

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/translate/tools.test.ts test/unit/runtime/omp/sessions.test.ts
```

预期：全部通过。

---

## 任务 3：真实 OMP smoke required gate 与跨平台测试发现

**文件：**
- 修改：`scripts/smoke-omp-rpc-controls.mjs`
- 创建：`scripts/run-tests.mjs`
- 修改：`package.json`
- 测试：`test/smoke/omp-rpc-controls-smoke.test.mjs`

### 步骤 1：失败测试 — required 模式 skip 必须失败

在 `test/smoke/omp-rpc-controls-smoke.test.mjs` 增加纯 helper 测试。先从脚本中计划导出 helper：

```js
import { classifySmokeFailure } from "../../scripts/smoke-omp-rpc-controls.mjs";

test("required real OMP smoke treats skipped result as failure", () => {
  assert.deepEqual(
    classifySmokeFailure({ skipped: true, reason: "omp not found" }, { requireRealOmp: true }),
    { exitCode: 1, failed: true },
  );
});

test("optional real OMP smoke allows skipped result", () => {
  assert.deepEqual(
    classifySmokeFailure({ skipped: true, reason: "omp not found" }, { requireRealOmp: false }),
    { exitCode: 0, failed: false },
  );
});

test("required real OMP smoke treats skipped set_active_tools verification as failure", () => {
  assert.deepEqual(
    classifySmokeFailure({ skipped: false, set_active_tools: { skipped: true, reason: "dumpTools not available" } }, { requireRealOmp: true }),
    { exitCode: 1, failed: true },
  );
});
```

### 步骤 2：失败测试 — run-tests 发现当前测试文件

新增固定测试文件 `test/smoke/test-discovery.test.mjs`，测试 `scripts/run-tests.mjs` 导出的 `discoverTestFiles(root)`：

```js
import { discoverTestFiles } from "../../scripts/run-tests.mjs";

test("discoverTestFiles includes TypeScript and mjs tests", async () => {
  const files = await discoverTestFiles(new URL("../..", import.meta.url));
  assert.ok(files.some((file) => file.endsWith("test/unit/translate/tools.test.ts")));
  assert.ok(files.some((file) => file.endsWith("test/smoke/omp-rpc-controls-smoke.test.mjs")));
});
```

### 步骤 3：运行红灯测试

运行：

```bash
node --test test/smoke/omp-rpc-controls-smoke.test.mjs test/smoke/test-discovery.test.mjs
```

预期：缺少 `classifySmokeFailure` 或 `discoverTestFiles` 导出导致失败。

### 步骤 4：实现 smoke required 模式

在 `scripts/smoke-omp-rpc-controls.mjs`：

- 增加：

```js
const requireRealOmp = process.env.OMP_ACP_REQUIRE_REAL_OMP === "1";
```

- 导出 helper：

```js
export function classifySmokeFailure(result, { requireRealOmp }) {
  if (result?.skipped === true && requireRealOmp) return { failed: true, exitCode: 1 };
  if (result?.set_active_tools?.skipped === true && requireRealOmp) return { failed: true, exitCode: 1 };
  if (result?.skipped === true) return { failed: false, exitCode: 0 };
  if (result?.success === false) return { failed: true, exitCode: 1 };
  return { failed: false, exitCode: 0 };
}
```

- `main()` 中 `omp not found` 时构造 result，输出 JSON，然后按 `classifySmokeFailure()` 设置 `process.exitCode`。
- ready timeout 和 request 失败继续 exit 1。
- `verifySetActiveToolsRoundTrip()` 在 required 模式下若因为缺少 `dumpTools` skip，main 必须 exit 1；helper 可返回 `{ skipped:true, reason:"dumpTools not available" }`，由 classifier 决定 exit。

### 步骤 5：实现 run-tests.mjs

创建 `scripts/run-tests.mjs`：

```js
#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, relative, sep } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await discoverTestFiles(repoRoot);
  if (files.length === 0) {
    console.error("No test files discovered");
    process.exit(1);
  }
  await runDiscoveredTests(files);
}

export async function discoverTestFiles(root = repoRoot) {
  const testRoot = resolve(root, "test");
  const files = [];
  await walk(testRoot, files);
  return files
    .filter((file) => /\.test\.(ts|mjs)$/.test(file))
    .sort()
    .map((file) => relative(root, file).split(sep).join("/"));
}

async function walk(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

async function runDiscoveredTests(files) {
  const tsFiles = files.filter((file) => file.endsWith(".test.ts"));
  const mjsFiles = files.filter((file) => file.endsWith(".test.mjs"));
  if (tsFiles.length > 0) await run(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...tsFiles]);
  if (mjsFiles.length > 0) await run(process.execPath, ["--test", ...mjsFiles]);
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}
```

### 步骤 6：更新 package.json scripts

修改：

```json
"smoke:omp-rpc-controls": "npm run smoke:omp-rpc-controls:optional",
"smoke:omp-rpc-controls:optional": "node scripts/smoke-omp-rpc-controls.mjs",
"smoke:omp-rpc-controls:required": "node scripts/smoke-omp-rpc-controls.mjs --require-real-omp",
"test": "node scripts/run-tests.mjs",
"check": "npm run typecheck && npm test",
"validate:standard": "npm run check && npm run smoke:acp && npm run smoke:sdk-client && npm run smoke:omp-rpc-controls:required && npm run validate:registry && npm run validate:acpx"
```

`smoke-omp-rpc-controls.mjs` 同时支持 `--require-real-omp` 和环境变量 `OMP_ACP_REQUIRE_REAL_OMP=1`；`package.json` 只能使用 `--require-real-omp`，不得使用 POSIX-only inline env 写法。

### 步骤 7：运行目标测试

运行：

```bash
node --test test/smoke/omp-rpc-controls-smoke.test.mjs test/smoke/test-discovery.test.mjs
node scripts/run-tests.mjs
```

预期：发现并运行全部测试。注意 `node scripts/run-tests.mjs` 会替代旧 `npm test`，耗时接近完整测试集。

---

## 任务 4：文档更新与空目录清理

**文件：**
- 修改：`README.md`
- 修改：`docs/release-checklist.md`
- 修改：`docs/compatibility/capability-matrix.md`
- 修改：`docs/compatibility/zed.md`
- 删除目录：`testunittranslate/`、`srctranslate/`、`testunitruntimeomp/`、`srcacptransport/`、`testsmoke/`

### 步骤 1：更新 README

修改验证段落，明确：

- `npm run smoke:omp-rpc-controls:optional` 用于开发机诊断，可 skip。
- `npm run smoke:omp-rpc-controls:required` 是发布门禁，skip/timeout/failure 均失败。
- `validate:standard` 使用 required gate。
- 如果本机 required gate 失败，不得声称发布验证通过。
- 不声明 Zed/ZedG GUI smoke 已完成。

### 步骤 2：更新 release checklist

修改 `docs/release-checklist.md`：

- 将当前快照中旧的 “real OMP RPC controls smoke 通过” 改成历史 v0.1.0 快照或明确标注过期。
- 发布前自动化门禁使用 `npm run smoke:omp-rpc-controls:required`。
- optional smoke 只用于诊断，不是发布通过条件。

### 步骤 3：更新 compatibility docs

在 `docs/compatibility/capability-matrix.md` 与 `docs/compatibility/zed.md` 中补充：

- `load/resume/fork` 发布前会在最终 OMP session 上执行 Ask 禁用二层防护。
- 验证脚本名称区分 optional/required。
- 不改变 initialize capability。

### 步骤 4：清理空目录

删除以下空目录：

```text
testunittranslate/
srctranslate/
testunitruntimeomp/
srcacptransport/
testsmoke/
```

必须先确认目录为空。若目录含文件，停止并报告，不得删除。

### 步骤 5：自检文档与目录

运行专用工具检查：

- 使用 `find` 确认上述目录不存在或无文件。
- 使用 `search` 检查文档没有未解决的模板残留或空泛标记。

---

## 任务 5：最终验证与审查循环

**文件：**
- 不预期修改；只做验证与必要修复。

### 步骤 1：运行目标验证

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/session/manager.test.ts test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts
node --import tsx --test --test-concurrency=1 test/unit/translate/tools.test.ts test/unit/runtime/omp/sessions.test.ts
node --test test/smoke/omp-rpc-controls-smoke.test.mjs test/smoke/test-discovery.test.mjs
```

`test/smoke/test-discovery.test.mjs` 是固定新增测试文件，不使用可选分支。

### 步骤 2：运行完整验证

运行：

```bash
npm run check
npm run build
npm run smoke:omp-rpc-controls:optional
git diff --check
```

`npm run smoke:omp-rpc-controls:optional` 如果输出 skip，只能记录为 optional smoke skip，不代表发布门禁通过。

如果本机真实 OMP 可用，再运行：

```bash
npm run smoke:omp-rpc-controls:required
```

如果 required 失败或 timeout，记录事实，不得声称通过。

### 步骤 3：只读复审

并发启动至少 4 个只读 reviewer 子代理：

1. session lifecycle / reservation / Ask guard 顺序。
2. tool output safety / history parity。
3. release gates / test discovery / docs truthfulness。
4. cross-cutting architecture /空目录清理。

复审必须显式考虑 untracked 文件和删除目录。所有 review 子代理 approve 后，才能进入提交/发布后续阶段。

---

## 自检清单

- 每个必须修复项都有测试与实现任务。
- 规格中的 optional/required smoke 差异已落实到 package scripts。
- Windows 上不依赖 shell glob。
- 空目录清理有确认空目录的前置条件。
- 文档更新不夸大真实 OMP smoke、Zed GUI smoke 或 ACP conformance。
- 行为变更均要求 TDD 红绿。
