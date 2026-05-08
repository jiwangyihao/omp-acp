# ACP session 配置与真实 OMP RPC 控制实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。必须直接在当前 `main` 工作区开发，不创建 git worktree。每个任务必须先写失败测试，再写实现；不得提前声明未实现能力。实现任务按依赖顺序执行，review 任务可并发。

**目标：** 修正 `omp-acp` 到真实 OMP `--mode rpc` JSONL contract，并通过 ACP `models`、`modes`、`configOptions` 与对应 setters 暴露模型、推理强度和首批 OMP session 控制项。

**架构：** 先 clean cutover runtime OMP RPC frame：内部向 OMP 发送 `{ id, type, command-specific fields }`，接收 `{ id, type:"response", command, success, data?/error? }`。再新增 `session-controls` 映射层，从 runtime 的 `get_state` / `get_available_models` 构造 ACP setup state，并提供 setter 校验与 post-read validation。最后在 ACP handlers/server/smoke/docs 中接入 session setup response 与 `session/set_model`、`session/set_config_option`、`session/set_mode(default)`。

**技术栈：** Node.js >= 20、TypeScript、`@agentclientprotocol/sdk@0.21.0`、`node:test`、JSON-RPC over stdio、真实 OMP RPC JSONL、现有 fake runtime 与 smoke harness。

**规格来源：** `docs/superpowers/specs/2026-05-08-acp-session-controls-design.md`。

---

## 文件结构与职责

- 修改：`src/runtime/omp/rpc-client.ts`、`src/runtime/omp/frames.ts` — 把 `RuntimeAdapter.request(method, params)` 序列化为真实 OMP `{ id, type, command fields }` command frame，并让 frame parser/response handler 接受真实 OMP response frame。
- 修改：`src/translate/prompt.ts` — 将 ACP prompt 翻译为 OMP `message` / `images` command params，不再把 ACP `sessionId` 放进 OMP prompt command。
- 修改：`src/session/manager.ts` — 将 cancel runtime command 改为 `abort`；为 active prompt 下 config mutation 提供可观察状态；支持 publish 前 build setup state 的 handler 编排。
- 修改：`src/testing/script-rpc-process.ts` — fixture 切换到真实 OMP response shape，并支持观察新 command frames。
- 修改：`test/contract/omp-rpc/rpc-client.test.ts`、`test/unit/runtime/omp/frames.test.ts`、`test/unit/translate/prompt.test.ts`、`test/unit/session/manager.test.ts`、`test/unit/acp/session-list-load.test.ts`、`test/unit/acp/session-resume.test.ts`、`test/unit/acp/session-fork.test.ts` — 覆盖 runtime cutover 与 publish 前 state build 语义。
- 创建：`src/acp/session-controls.ts` — OMP control state runtime validation、ACP `models/modes/configOptions` 映射、setter 输入校验与 post-read validation。
- 创建：`test/unit/acp/session-controls.test.ts` — 覆盖 model/thinking/options/state validation。
- 创建：`src/acp/handlers/session-config.ts` — 实现 `setSessionMode`、`unstable_setSessionModel`、`setSessionConfigOption`。
- 修改：`src/acp/handlers/session-new.ts`、`session-load.ts`、`session-resume.ts`、`session-fork.ts`、`src/acp/server.ts` — setup response 和 setter wiring。
- 修改：`test/unit/acp/session-handlers.test.ts` 或创建 `test/unit/acp/session-config.test.ts` — handler 级测试。
- 修改：`test/smoke/session-prompt.test.ts`、`scripts/smoke-acp.mjs`、`scripts/smoke-sdk-client.mjs`、`scripts/probe-registry-matrix.mjs` — headless 验证新增 controls。
- 创建：`scripts/smoke-omp-rpc-controls.mjs` — 真实 OMP RPC controls smoke。
- 修改：`package.json` — 加入 `smoke:omp-rpc-controls`，并纳入 `validate:standard`；把新增 tests 加入 `test` / `check` 显式枚举。
- 修改：`README.md`、`docs/compatibility/capability-matrix.md`、`docs/compatibility/zed.md`、`docs/compatibility/acp-validation.md`、`docs/release-checklist.md`、`scripts/smoke-zed.md` — 同步能力边界与验证门禁。

---

## 任务 1：真实 OMP RPC contract clean cutover

**文件：**
- 修改：`src/runtime/omp/rpc-client.ts`
- 修改：`src/runtime/omp/frames.ts`
- 修改：`src/translate/prompt.ts`
- 修改：`src/session/manager.ts`
- 修改：`src/testing/script-rpc-process.ts`
- 测试：`test/contract/omp-rpc/rpc-client.test.ts`
- 测试：`test/unit/runtime/omp/frames.test.ts`
- 测试：`test/unit/translate/prompt.test.ts`
- 测试：`test/unit/session/manager.test.ts`

- [ ] **步骤 1：编写失败测试：prompt / switch / state / setter command frame 序列化**

在 `test/contract/omp-rpc/rpc-client.test.ts` 添加 frame observer 场景，断言 `client.request()` 写入真实 OMP command shape：

```ts
test("request serializes prompt using OMP type/message command shape", async () => {
  const client = startFixture("raw-frame-observer");
  await client.ready;
  const result = await client.request("prompt", { message: "hello", images: [{ type: "image", data: "abc", mimeType: "image/png" }] });
  assert.deepEqual(result, {
    observed: { id: 1, type: "prompt", message: "hello", images: [{ type: "image", data: "abc", mimeType: "image/png" }] },
  });
  await client.close();
});
```

同文件继续覆盖：

```ts
await client.request("switch_session", { sessionPath: "C:/tmp/session.jsonl" });
// observed: { id: 1, type: "switch_session", sessionPath: "C:/tmp/session.jsonl" }

await client.request("get_state");
// observed: { id: 1, type: "get_state" }

await client.request("get_available_models");
// observed: { id: 1, type: "get_available_models" }

await client.request("set_model", { provider: "p", modelId: "m" });
// observed: { id: 1, type: "set_model", provider: "p", modelId: "m" }

await client.request("set_thinking_level", { level: "low" });
await client.request("set_steering_mode", { mode: "all" });
await client.request("set_follow_up_mode", { mode: "one-at-a-time" });
await client.request("set_interrupt_mode", { mode: "wait" });
await client.request("set_auto_compaction", { enabled: false });
```

预期每个 observed frame 都没有 `method`、`params` 字段。

- [ ] **步骤 2：编写失败测试：真实 OMP response shape 与 frame parser**

在 `test/unit/runtime/omp/frames.test.ts` 添加 parser 单元测试，断言 `parseOmpRpcFrame()` 接受真实 response：

```json
{ "id": 1, "type": "response", "command": "get_state", "success": true, "data": { "thinkingLevel": "low" } }
```

并接受 failure response：

```json
{ "id": 1, "type": "response", "command": "set_model", "success": false, "error": "Model not found" }
```

同一批测试必须断言生产 parser 不再要求旧 `result` 字段，且真实 response 不会在进入 `OmpRpcClient.handleFrame()` 前被拒绝。再在 `test/contract/omp-rpc/rpc-client.test.ts` 中添加 fixture 场景：`client.request("get_state")` resolve 为 `{ thinkingLevel:"low" }`；`success:false` reject `OmpRpcResponseError` 且 `responseError` 保留 command/error。

- [ ] **步骤 3：编写失败测试：prompt translation 不输出 ACP sessionId**

在 `test/unit/translate/prompt.test.ts` 更新断言：

```ts
assert.deepEqual(translatePromptToOmpRequest({ sessionId:"s1", prompt:[{ type:"text", text:"hello" }] }), {
  method: "prompt",
  params: { message: "hello" },
});
```

image case 断言 `params.images` 保留，且无 `params.sessionId` / `params.prompt`。

- [ ] **步骤 4：编写失败测试：cancel 使用 abort 但保留本地取消语义**

在 `test/unit/session/manager.test.ts` 或现有 ACP cancel handler 测试中断言 `cancelPrompt()` 调用 runtime request `abort`，并保留 `activePrompt.cancellation.cancel()` 与 finish cleanup。fake runtime requests 应等于：

```ts
[{ method: "abort", params: undefined }]
```

- [ ] **步骤 5：运行目标测试确认红灯**

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/frames.test.ts test/contract/omp-rpc/rpc-client.test.ts test/unit/translate/prompt.test.ts test/unit/session/manager.test.ts
```

预期：FAIL，原因是现有实现仍发送 `{ method, params }`、prompt params 仍含 `prompt/sessionId`、cancel 仍调用 `cancel`。

- [ ] **步骤 6：实现 runtime cutover**

在 `src/runtime/omp/rpc-client.ts` 新增 command builder：

```ts
function buildOmpCommandFrame(id: OmpRpcRequestId, method: string, params: unknown): Record<string, unknown> {
  switch (method) {
    case "prompt": {
      const input = requireRecord(params, method);
      return { id, type: "prompt", message: requireString(input.message, "message"), ...(Array.isArray(input.images) ? { images: input.images } : {}) };
    }
    case "switch_session":
      return { id, type: "switch_session", sessionPath: requireString(requireRecord(params, method).sessionPath, "sessionPath") };
    case "get_state":
    case "get_available_models":
    case "abort":
      return { id, type: method };
    case "set_model": {
      const input = requireRecord(params, method);
      return { id, type: "set_model", provider: requireString(input.provider, "provider"), modelId: requireString(input.modelId, "modelId") };
    }
    case "set_thinking_level":
      return { id, type: "set_thinking_level", level: requireString(requireRecord(params, method).level, "level") };
    case "set_steering_mode":
    case "set_follow_up_mode":
    case "set_interrupt_mode":
      return { id, type: method, mode: requireString(requireRecord(params, method).mode, "mode") };
    case "set_auto_compaction":
      return { id, type: "set_auto_compaction", enabled: requireBoolean(requireRecord(params, method).enabled, "enabled") };
    default:
      throw new OmpRpcClientError(`Unsupported OMP RPC method: ${method}`);
  }
}
```

`request()` 写入 `buildOmpCommandFrame(id, method, params)`。`src/runtime/omp/frames.ts` 的 `OmpRpcResponseFrame` 与 parser 识别真实 OMP response：`type === "response" && id`、`command` 为 string、`success` 为 boolean；`success:false` 必须有 string `error`，`success:true` 可有 `data` 或无 data。`handleFrame()` 对 `success:false` reject；对 `success:true` resolve `data` 或 `undefined`。生产路径不得继续依赖旧 `{ result }` response contract；旧 contract 只允许在被删除或重写前的测试失败信息中出现。

在 `src/translate/prompt.ts` 将 `OmpPromptRequest.params.prompt` 改为 `message`，移除 `sessionId`。在 `src/session/manager.ts` 将 runtime cancel request 改为 `runtime.request("abort")`。

- [ ] **步骤 7：更新 fixture 到真实 OMP response shape**

`src/testing/script-rpc-process.ts` 的 `writeFrame({ type:"response", id, result })` 改为 `writeFrame({ id, type:"response", command:<request.type>, success:true, data })`。raw observer 场景直接回显 observed frame：

```ts
writeFrame({ id: request.id, type: "response", command: request.type, success: true, data: { observed: request } });
```

prompt happy path、switch_session、cancel/abort、host tool result 等场景同步使用真实 shape。

- [ ] **步骤 8：运行任务测试并提交**

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/frames.test.ts test/contract/omp-rpc/rpc-client.test.ts test/contract/omp-rpc/tool-events.test.ts test/unit/translate/prompt.test.ts test/unit/session/manager.test.ts
```

预期：PASS。

```bash
git add src/runtime/omp/rpc-client.ts src/runtime/omp/frames.ts src/translate/prompt.ts src/session/manager.ts src/testing/script-rpc-process.ts test/contract/omp-rpc/rpc-client.test.ts test/contract/omp-rpc/tool-events.test.ts test/unit/runtime/omp/frames.test.ts test/unit/translate/prompt.test.ts test/unit/session/manager.test.ts
git commit -m "fix(runtime): 对齐真实 OMP RPC 协议"
```

---

## 任务 2：实现 session controls state builder

**文件：**
- 创建：`src/acp/session-controls.ts`
- 测试：`test/unit/acp/session-controls.test.ts`

- [ ] **步骤 1：编写失败测试：models 与 model config option**

创建 `test/unit/acp/session-controls.test.ts`，使用 fake runtime：

```ts
class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics = { stderr: "" };
  requests: Array<{ method: string; params?: unknown }> = [];
  state = { model: { provider:"p", id:"m1", name:"Model One", baseUrl:"secret-url" }, thinkingLevel:"high" };
  models = [
    { provider:"p", id:"m1", name:"Model One", baseUrl:"secret-url", thinking:{ minLevel:"minimal", maxLevel:"high" } },
    { provider:"p", id:"m2", name:"Model Two", apiKey:"secret-key", thinking:{ minLevel:"low", maxLevel:"xhigh" } },
  ];
  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") return structuredClone(this.state);
    if (method === "get_available_models") return structuredClone(this.models);
    throw new Error(`Unexpected method ${method}`);
  }
  send(): Promise<void> { return Promise.resolve(); }
  onEvent(): () => void { return () => {}; }
  close(): Promise<void> { return Promise.resolve(); }
}
```

测试 `buildSessionSetupState(runtime)` 返回：

```ts
assert.equal(state.models.currentModelId, "p/m1");
assert.deepEqual(state.models.availableModels.map((m) => m.modelId), ["p/m1", "p/m2"]);
assert.ok(!JSON.stringify(state).includes("secret-url"));
assert.ok(!JSON.stringify(state).includes("secret-key"));
```

- [ ] **步骤 2：编写失败测试：thinking options 动态裁剪和 current-only**

覆盖：

```ts
// m1 minimal..high 不包含 xhigh
assert.deepEqual(thinking.options.map((o) => o.value), ["off", "minimal", "low", "medium", "high"]);

// m2 low..xhigh 不包含 minimal，包含 xhigh
runtime.state.model = runtime.models[1];
runtime.state.thinkingLevel = "xhigh";
assert.deepEqual(thinking.options.map((o) => o.value), ["off", "low", "medium", "high", "xhigh"]);

// current value 超出 metadata 时追加 current-only option
runtime.state.model = runtime.models[0];
runtime.state.thinkingLevel = "xhigh";
assert.ok(thinking.options.some((o) => o.value === "xhigh" && /当前 runtime 值/.test(o.description ?? "")));
```

- [ ] **步骤 3：编写失败测试：current model 不在 model list 时合并**

设置 `get_state.model = { provider:"p", id:"missing", name:"Missing" }`，`get_available_models` 不含该模型。断言 `models.availableModels` 和 `model` config option 都包含 `p/missing`，且 description 标明 current-only。

- [ ] **步骤 4：编写失败测试：setter validation helpers**

覆盖 `setOmpSessionModel()`、`setOmpThinkingLevel()`、`setOmpConfigOption()`：

- unknown model id -> `RequestError.invalidParams`；不调用 runtime setter。
- `thinking:xhigh` 在当前模型只支持到 `high` -> invalid params；不调用 runtime setter。
- `thinking:low` -> 调用 `set_thinking_level`，reread 后校验 state。
- `_omp.steeringMode` / `_omp.followUpMode` / `_omp.interruptMode` / `_omp.autoCompaction` -> 调用对应 setter 并校验 state。
- setter success 后 reread state 不匹配 -> 明确 error。

- [ ] **步骤 5：运行测试验证失败**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-controls.test.ts
```

预期：FAIL，原因是 `src/acp/session-controls.ts` 不存在。

- [ ] **步骤 6：实现 `src/acp/session-controls.ts`**

导出：

```ts
export type SessionSetupState = Pick<NewSessionResponse, "models" | "modes" | "configOptions">;
export async function buildSessionSetupState(runtime: RuntimeAdapter): Promise<SessionSetupState>;
export async function setSessionModelControl(runtime: RuntimeAdapter, modelId: string): Promise<SessionSetupState>;
export async function setSessionConfigControl(runtime: RuntimeAdapter, request: SetSessionConfigOptionRequest): Promise<SessionSetupState>;
export function buildDefaultModeState(): SessionModeState;
```

实现要求：

- 所有 unknown RPC data 先 runtime validation。
- `modelId` 编码为 `provider/id`，按第一个 `/` 解码 provider；provider/id 必须非空。
- thinking order 固定：`minimal`, `low`, `medium`, `high`, `xhigh`。
- `off` 永远是 thinking option 第一项。
- ACP descriptions 不包含 `baseUrl`、`apiKey`、raw provider config。
- `setSessionConfigControl()` 支持 `model`、`thinking`、`_omp.steeringMode`、`_omp.followUpMode`、`_omp.interruptMode`、`_omp.autoCompaction`；未知 configId invalid params。

- [ ] **步骤 7：运行测试并提交**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-controls.test.ts
```

预期：PASS。

```bash
git add src/acp/session-controls.ts test/unit/acp/session-controls.test.ts
git commit -m "feat(acp): 构建 OMP session 控制状态"
```

---

## 任务 3：setup responses 与 publish 前 state build

**文件：**
- 修改：`src/session/manager.ts`
- 修改：`src/acp/handlers/session-new.ts`
- 修改：`src/acp/handlers/session-load.ts`
- 修改：`src/acp/handlers/session-resume.ts`
- 修改：`src/acp/handlers/session-fork.ts`
- 测试：`test/unit/acp/session-list-load.test.ts`
- 测试：`test/unit/acp/session-resume.test.ts`
- 测试：`test/unit/acp/session-fork.test.ts`
- 测试：新增或修改 `test/unit/acp/session-config.test.ts`

- [ ] **步骤 1：编写失败测试：newSession 返回 setup state 且 state build 失败不发布**

在 `test/unit/acp/session-config.test.ts` 添加 fake runtime factory，runtime 对 `get_state/get_available_models` 返回固定 state。断言：

```ts
const response = await handleSessionNew({ cwd, mcpServers: [] }, manager);
assert.equal(response.sessionId, "session-1");
assert.ok(response.models);
assert.ok(response.modes);
assert.ok(response.configOptions?.some((option) => option.id === "model"));
```

再设置 fake runtime 的 `get_state` 抛错，断言 `handleSessionNew()` reject，且 `manager.tryGetSession("session-1") === undefined`。

- [ ] **步骤 2：编写失败测试：load/resume/fork 在 switch 后、publish 前 build state**

扩展现有 load/resume/fork handler tests：fake runtime requests 顺序必须为：

```ts
[
  { method: "switch_session", params: { sessionPath } },
  { method: "get_state", params: undefined },
  { method: "get_available_models", params: undefined },
]
```

state build failure 时：

- load/resume 不发布 session。
- fork 不发布 session，并删除本次 fork 文件。
- fork 文件已创建后，如果 `switch_session` 或 `buildSessionSetupState(runtime)` 失败，且删除本次 fork 文件也失败，测试必须断言不发布 session，并抛出包含主失败和 cleanup 失败的 `AggregateError`（或现有等价结构）。该路径必须保留现有 `removeForkFileAfterFailure` 语义，不能让 cleanup 错误覆盖主错误，也不能吞掉 cleanup 错误。

- [ ] **步骤 3：运行目标测试确认红灯**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts
```

预期：FAIL，原因是 handlers 仍返回空 setup state 或 build 时机不对。

- [ ] **步骤 4：实现 publish 前 setup state capture**

优先不让 `SessionManager` 理解 ACP types。新增或调整 handler 内 closure：

```ts
let setupState: SessionSetupState | undefined;
const session = await manager.createSessionWithId(sessionId, params, async (runtime) => {
  await runtime.request("switch_session", { sessionPath }); // load/resume/fork only
  setupState = await buildSessionSetupState(runtime);
});
return { sessionId: session.sessionId, ...requireSetupState(setupState) };
```

`session/new` 同样通过 `beforePublish` 只执行 `buildSessionSetupState(runtime)`。如果 `createSession(params)` 当前直接返回 `NewSessionResponse`，改为新增 `createSessionRecord(params, beforePublish?)` 或让 `createSession()` 内部支持 setup capture；不要让 `SessionManager` 直接构造 ACP `models/configOptions`。fork 相关 handler 改造时必须复用现有 failure cleanup helper；新增 setup state build 失败路径必须纳入 cleanup helper，保持 `AggregateError([primaryError, cleanupError], ...)` 诊断。

- [ ] **步骤 5：运行测试并提交**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts
```

预期：PASS。

```bash
git add src/session/manager.ts src/acp/handlers/session-new.ts src/acp/handlers/session-load.ts src/acp/handlers/session-resume.ts src/acp/handlers/session-fork.ts test/unit/acp/session-config.test.ts test/unit/acp/session-list-load.test.ts test/unit/acp/session-resume.test.ts test/unit/acp/session-fork.test.ts
git commit -m "feat(acp): 返回 session 控制状态"
```

---

## 任务 4：ACP session control setters 与 server wiring

**文件：**
- 创建：`src/acp/handlers/session-config.ts`
- 修改：`src/acp/server.ts`
- 测试：`test/unit/acp/session-config.test.ts`

- [ ] **步骤 1：编写失败测试：model / config / mode setters**

在 `test/unit/acp/session-config.test.ts` 继续覆盖：

```ts
await agent.unstable_setSessionModel?.({ sessionId:"s1", modelId:"p/m2" });
assert.deepEqual(runtime.requests.at(-2), { method:"set_model", params:{ provider:"p", modelId:"m2" } });
assert.equal(connection.updates.at(-1)?.update.sessionUpdate, "config_option_update");

const configResponse = await agent.setSessionConfigOption?.({ sessionId:"s1", configId:"thinking", value:"low" });
assert.ok(configResponse?.configOptions.some((option) => option.id === "thinking"));

await agent.setSessionMode?.({ sessionId:"s1", modeId:"default" });
assert.deepEqual(connection.updates.at(-1)?.update, { sessionUpdate:"current_mode_update", currentModeId:"default" });
await assert.rejects(agent.setSessionMode?.({ sessionId:"s1", modeId:"other" }), /Unsupported/);
```

再覆盖 active prompt：先 `manager.beginPrompt("s1")`，再调用 model/thinking setter，断言 invalid params 且 runtime requests 不包含 setter。

- [ ] **步骤 2：运行测试确认红灯**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts
```

预期：FAIL，原因是 server 未 wiring setters 或 handler 不存在。

- [ ] **步骤 3：实现 `session-config` handlers**

`src/acp/handlers/session-config.ts` 导出：

```ts
export async function handleSetSessionMode(params: SetSessionModeRequest, manager: SessionManager, connection: AgentSideConnection): Promise<SetSessionModeResponse>;
export async function handleSetSessionModel(params: SetSessionModelRequest, manager: SessionManager, connection: AgentSideConnection): Promise<SetSessionModelResponse>;
export async function handleSetSessionConfigOption(params: SetSessionConfigOptionRequest, manager: SessionManager, connection: AgentSideConnection): Promise<SetSessionConfigOptionResponse>;
```

实现要求：

- `manager.requireSession()` unknown -> `RequestError.resourceNotFound(sessionId)`。
- mutating setters 若 `session.activePrompt` 存在 -> `RequestError.invalidParams("Cannot change session controls during an active prompt")`。
- model/config setter 调用 `session-controls` setter helper；成功后发送 `config_option_update`。
- `setSessionMode(default)` 发送符合 SDK 0.21.0 schema 的 `{ sessionUpdate:"current_mode_update", currentModeId:"default" }`；非 default invalid params。若实现选择不发送 mode update，必须同步调整测试和文档说明，但不得发送缺少 `currentModeId` 的裸 `current_mode_update`。

- [ ] **步骤 4：server wiring**

在 `src/acp/server.ts` 添加：

```ts
async setSessionMode(params) {
  return handleSetSessionMode(params, manager, connection);
},
async unstable_setSessionModel(params) {
  return handleSetSessionModel(params, manager, connection);
},
async setSessionConfigOption(params) {
  return handleSetSessionConfigOption(params, manager, connection);
},
```

- [ ] **步骤 5：运行测试并提交**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-config.test.ts test/unit/acp/session-handlers.test.ts
```

预期：PASS。

```bash
git add src/acp/handlers/session-config.ts src/acp/server.ts test/unit/acp/session-config.test.ts
git commit -m "feat(acp): 支持 session 控制 setters"
```

---

## 任务 5：Headless smoke、registry probe 与真实 OMP controls smoke

**文件：**
- 修改：`test/smoke/session-prompt.test.ts`
- 修改：`scripts/smoke-acp.mjs`
- 修改：`scripts/smoke-sdk-client.mjs`
- 修改：`scripts/probe-registry-matrix.mjs`
- 创建：`scripts/smoke-omp-rpc-controls.mjs`
- 修改：`package.json`

- [ ] **步骤 1：编写失败 smoke assertions**

在 `test/smoke/session-prompt.test.ts` 的 session/new 路径断言 response result 包含 `models`、`modes`、`configOptions`。新增 raw JSON-RPC 流程：

```ts
acp.send({ jsonrpc:"2.0", id:70, method:"session/set_model", params:{ sessionId, modelId:"p/m2" } });
await acp.nextResponse(70);
acp.send({ jsonrpc:"2.0", id:71, method:"session/prompt", params:{ sessionId, prompt:[{ type:"text", text:"after model" }] } });
await acp.nextResponse(71);

acp.send({ jsonrpc:"2.0", id:72, method:"session/set_config_option", params:{ sessionId, configId:"thinking", value:"low" } });
await acp.nextResponse(72);
acp.send({ jsonrpc:"2.0", id:73, method:"session/prompt", params:{ sessionId, prompt:[{ type:"text", text:"after thinking" }] } });
await acp.nextResponse(73);

acp.send({ jsonrpc:"2.0", id:74, method:"session/set_mode", params:{ sessionId, modeId:"default" } });
await acp.nextResponse(74);
acp.send({ jsonrpc:"2.0", id:75, method:"session/prompt", params:{ sessionId, prompt:[{ type:"text", text:"after mode" }] } });
await acp.nextResponse(75);

acp.send({ jsonrpc:"2.0", id:76, method:"session/set_mode", params:{ sessionId, modeId:"other" } });
assert.equal((await acp.nextResponse(76)).error?.code, -32602);
```

Fixture runtime 需要支持 `get_state/get_available_models/set_model/set_thinking_level` 等 commands。

- [ ] **步骤 2：扩展脚本 smoke 与 registry probe**

`scripts/smoke-acp.mjs` summary 增加：

```js
sessionConfigOptions: "success",
sessionSetModel: "success",
sessionSetConfigOption: "success",
sessionSetMode: "success",
```

逐脚本验收要求：`scripts/smoke-acp.mjs`、`scripts/smoke-sdk-client.mjs`、`scripts/probe-registry-matrix.mjs` 都必须断言 `session/new` setup response 包含 `models`、`modes`、`configOptions`；都必须覆盖 `session/set_model`、`session/set_config_option(thinking)`、`session/set_mode(default)` 与每个 setter 成功后的 `session/prompt`。`scripts/smoke-acp.mjs` summary 增加上述 `success` 字段。`scripts/smoke-sdk-client.mjs` 使用 SDK client 方法覆盖相同流程。`scripts/probe-registry-matrix.mjs` 将 `session/set_model`、`session/set_config_option`、`session/set_mode` 从 method_not_found 改为 success probe，并额外断言 setter response shape、fork response 仍包含 setup state、fork 后 setter/prompt 可用、adapter stdout 只包含 ACP JSON-RPC/NDJSON；summary 中保留 unsupported capabilities 的 conservative reporting。

- [ ] **步骤 3：新增真实 OMP controls smoke**

创建 `scripts/smoke-omp-rpc-controls.mjs`。脚本逻辑：

1. 查找 `omp`；不可用则输出 JSON summary `{ skipped:true, reason:"omp not found" }` 并 exit 0。
2. 用临时 `--session-dir` 启动 `omp --mode rpc --session-dir <tmp> --no-title --no-extensions --no-skills --no-rules`。
3. 读取 `{type:"ready"}`。
4. 发送 `get_state`、`get_available_models`、`set_thinking_level`、`set_steering_mode`、`set_follow_up_mode`、`set_interrupt_mode`、`set_auto_compaction`。
5. 再次 `get_state` 校验 state 生效。
6. 输出 summary；脚本 stdout 是脚本自己的 summary，不是 adapter stdout。失败时带 command/error 并 exit non-zero。

- [ ] **步骤 4：更新 `package.json` scripts 和 test/check 枚举**

添加：

```json
"smoke:omp-rpc-controls": "node scripts/smoke-omp-rpc-controls.mjs",
"validate:standard": "npm run check && npm run smoke:acp && npm run smoke:sdk-client && npm run smoke:omp-rpc-controls && npm run validate:registry && npm run validate:acpx"
```

把 `test/unit/acp/session-controls.test.ts`、`test/unit/acp/session-config.test.ts` 加入 `test` 和 `check` 显式测试列表。

- [ ] **步骤 5：运行目标验证并提交**

```bash
node --import tsx --test --test-concurrency=1 test/smoke/session-prompt.test.ts
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls
npm run validate:registry
```

预期：全部 PASS；若 `smoke:omp-rpc-controls` skip，必须确认 summary 明确 `skipped:true` 与 reason。当前本机已观察 `omp/14.7.7` 可用，目标应为非 skip success。

```bash
git add test/smoke/session-prompt.test.ts scripts/smoke-acp.mjs scripts/smoke-sdk-client.mjs scripts/probe-registry-matrix.mjs scripts/smoke-omp-rpc-controls.mjs package.json package-lock.json
git commit -m "test(acp): 验证 session 控制能力"
```

---

## 任务 6：文档、能力矩阵与最终验证

**文件：**
- 修改：`README.md`
- 修改：`docs/compatibility/capability-matrix.md`
- 修改：`docs/compatibility/zed.md`
- 修改：`docs/compatibility/acp-validation.md`
- 修改：`docs/release-checklist.md`
- 修改：`scripts/smoke-zed.md`

- [ ] **步骤 1：更新能力矩阵与验证文档**

`docs/compatibility/capability-matrix.md` 增加：

- `session/set_model`：已实现，标注 SDK unstable；验证包括 unit/smoke/sdk/registry。
- `session/set_config_option`：已实现；支持 `model`、`thinking`、`_omp.steeringMode`、`_omp.followUpMode`、`_omp.interruptMode`、`_omp.autoCompaction`。
- `session/set_mode`：已实现 default-only；非 default 拒绝；不得声称多 mode。

`docs/compatibility/acp-validation.md` 更新 registry probe 说明，删除 `session/set_model: method_not_found` 的旧结论，继续说明 `openclaw/acpx` 是第三方 draft assessment，不是官方完整 conformance。

- [ ] **步骤 2：更新 Zed/README/release docs**

`docs/compatibility/zed.md` 和 `README.md` 说明：

- ZedG custom agent 的模型与推理强度来自 ACP setup response。
- 推理强度按当前模型动态裁剪；不支持 `xhigh` 的模型不显示或会被 setter 拒绝。
- OMP-specific controls 是 adapter 暴露的 session config options，不代表 Zed registry agent 的全部 UI 行为。

`scripts/smoke-zed.md` 加入手工检查：模型 picker 可见、thinking picker 随模型变化、设置后继续 prompt、Zed log 不把 acpx draft assessment 写成官方 conformance。

`docs/release-checklist.md` 加入 `npm run smoke:omp-rpc-controls`，并要求发布机器非 skip success；Zed GUI 手工 smoke 仍是发布阻塞项。

- [ ] **步骤 3：运行文档相关验证与全量门禁**

```bash
npm run check
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls
npm run validate:registry
npm run validate:standard
git diff --check
```

预期：全部 PASS；`validate:acpx` 允许 expected draft failures，但不得出现 unexpected draft failures；不得声称官方 conformance full pass。

- [ ] **步骤 4：提交文档与验证更新**

```bash
git add README.md docs/compatibility/capability-matrix.md docs/compatibility/zed.md docs/compatibility/acp-validation.md docs/release-checklist.md scripts/smoke-zed.md
git commit -m "docs(acp): 记录 session 控制能力边界"
```

---

## 最终审查与收尾

- [ ] **步骤 1：并发发起 3 个最终 review 子代理**
  - 协议/SDK reviewer：核对 SDK 0.21.0、ACP method wiring、capability matrix。
  - Runtime/data-safety reviewer：核对真实 OMP RPC contract、publish 前失败清理、active prompt guard、secret 不泄漏。
  - Validation/docs reviewer：核对 package scripts、smoke、registry、docs、Zed 手工 smoke 边界。

- [ ] **步骤 2：按 review 反馈修复并复审**

任何 Critical/Important/blocking issue 必须修复并复审通过。若 review 只给出 non-blocking 建议，记录但不阻塞。每轮 review 修复后必须按修复范围重跑受影响测试；若修改 validation、docs、package scripts、smoke 或 registry probe，必须重跑 `npm run validate:standard`；无论修复范围如何，最终状态检查前必须再次运行 `git diff --check`。

- [ ] **步骤 3：最终状态检查**

```bash
git status --short
git log --oneline -5
```

预期：工作区干净；最近提交清晰体现 runtime、ACP controls、validation/docs 的阶段性变更。