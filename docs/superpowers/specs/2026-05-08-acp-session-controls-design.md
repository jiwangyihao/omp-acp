# Stage 8B: ACP session 配置与真实 OMP RPC 控制设计

> 本规格用于准备实现 `omp-acp` 的模型选择、推理强度与 OMP session 控制项。它建立在 Stage 1–8A 已完成的 ACP 基线能力之上，但先修正一个更底层的问题：adapter 必须与真实 OMP `--mode rpc` 的 JSONL command contract 对齐，不能继续只依赖 fixture 的 `{ method, params }` 形状。

## 目标

- 让 ZedG / ACP client 能在 `omp-acp-local` 中看到并设置 OMP 当前可用模型。
- 让 ZedG / ACP client 能看到并设置当前模型支持范围内的推理强度（thought level / thinking effort）。
- 通过 ACP `configOptions` 暴露一组真实可动态控制的 OMP session 选项，首批只包含已有 `get_state` 可读且有 RPC setter 的项目。
- 修正 `omp-acp` 与真实 OMP `--mode rpc` 的 command/response contract：对外仍保持 ACP JSON-RPC，内部对 OMP 使用真实 JSONL `{ id, type, ... }` 命令。
- 保持 truthful capability：只有真实 OMP RPC 已观察支持并且有自动化测试覆盖的配置项才出现在 ACP response 或 `initialize` 行为中。

## 非目标

- 不把 OMP 全局配置文件写入当作 Zed per-session UI 的 setter。`temperature`、`topP`、`serviceTier`、`modelRoles` 等只观察到 CLI/config schema，未观察到 per-session RPC setter，本阶段不暴露。
- 不把 OMP task subagent、skills、commands 或 `agents/*.md` 伪装成 ACP session mode / Agent selector。当前未观察到主会话可切换 Agent 的稳定 RPC contract。
- 不声明或实现 ACP `session/close`、MCP HTTP/SSE、permission、filesystem/terminal delegation、usage update。
- 不通过 `_meta` 私有字段扩展 ACP config 协议。
- 不把所有模型固定暴露同一组推理强度；尤其不能给只支持到 `high` 的模型提交 `xhigh`。
- 不泄漏 OMP provider secret、API key、base URL 或完整 provider config 到 ACP model/config 描述。

## 已观察事实

### ACP SDK 0.21.0

- `NewSessionResponse`、`LoadSessionResponse`、`ResumeSessionResponse`、`ForkSessionResponse` 均可包含：
  - `configOptions?: SessionConfigOption[] | null`
  - `models?: SessionModelState | null`
  - `modes?: SessionModeState | null`
- `models` 与 `unstable_setSessionModel` 标注为 unstable / experimental；`modes` 与 `configOptions` 是当前 SDK 中的正式 session setup/control surface。
- Agent-side 方法名为：
  - `setSessionMode(params: SetSessionModeRequest)`
  - `unstable_setSessionModel(params: SetSessionModelRequest)`
  - `setSessionConfigOption(params: SetSessionConfigOptionRequest)`
- `SessionConfigOption.category` 的标准语义 hint 包括 `mode`、`model`、`thought_level`；该字段只用于 UX，client 不能依赖它保证正确性。
- `session/update` 支持 `config_option_update`，payload 为完整 `configOptions` 列表。切换模型或推理强度后应发送该 update，因为可选项和 currentValue 可能联动变化。

### 当前 `omp-acp`

- `handleSessionNew()` 仅调用 `manager.createSession(params)`，当前 `SessionManager.createSession()` 返回 `{ sessionId }`。
- `createOmpAcpAgent()` 当前未实现 `setSessionMode`、`unstable_setSessionModel`、`setSessionConfigOption`。
- `RuntimeAdapter.request(method, params)` 与 `OmpRpcClient.request(method, params)` 当前发送 `{ id, method, params }`。
- `translatePromptToOmpRequest()` 当前产生 `method: "prompt"` 与 `params.sessionId/prompt/images`。
- 现有 fixture `src/testing/script-rpc-process.ts` 也按 `{ method, params }` 响应，因此未覆盖真实 OMP RPC command shape。

### 真实 OMP 14.7.7 RPC

本机只读探测使用临时 `--session-dir` 启动：

```bash
omp --mode rpc --session-dir <temp> --no-title --no-extensions --no-skills --no-rules
```

已观察到：

- ready frame 为 `{ "type": "ready" }`。
- 真实命令使用 `{ "id": "...", "type": "get_state" }`，不是 `{ "method": "get_state" }`。
- 用 `{ "id":"bad", "method":"get_state" }` 会返回 `Unknown command: undefined`。
- `get_state` 返回当前 `model`、`thinkingLevel`、`steeringMode`、`followUpMode`、`interruptMode`、`autoCompactionEnabled` 等字段。
- `get_available_models` 返回当前可用模型列表；本机返回 23 个模型，每个模型包含 `provider`、`id`、`name`、`thinking`、`input`、`contextWindow`、`maxTokens` 等。
- `set_model` 支持 `{ type:"set_model", provider, modelId }` 并返回当前模型对象。
- `set_thinking_level` 支持 `{ type:"set_thinking_level", level }`；设置 `low` 后再次 `get_state` 可观察到 `thinkingLevel:"low"`。
- `set_steering_mode` 支持 `{ type:"set_steering_mode", mode:"all" }`；再次 `get_state` 可观察到 `steeringMode:"all"`。

### OMP native ACP 参考

本机 OMP 包内 `src/modes/acp/acp-agent.ts` 已有直接基于 `AgentSession` 的参考实现：

- `newSession/loadSession/resumeSession/forkSession` 返回 `configOptions`、`models`、`modes`。
- `configOptions` 包含 `mode`、`model`、`thinking`。
- `unstable_setSessionModel()` 调用 `session.setModel()`。
- `setSessionConfigOption()` 支持 `model` 与 `thinking`，并发送 `config_option_update`。
- thinking 选项通过 session/model 能力构造，而不是固定全局列表。

该实现证明 ACP 映射方向成立；`omp-acp` 不能直接操作 `AgentSession`，必须通过真实 OMP RPC 命令实现同等语义。

## 用户可见语义

### 创建、加载、恢复、fork session

以下 ACP 方法成功后，response 必须携带当前 session control state：

- `session/new`
- `session/load`
- `session/resume`
- `session/fork`

返回结构在原有字段基础上增加：

```ts
{
  sessionId?: string; // new/fork 才有
  models?: SessionModelState;
  modes?: SessionModeState;
  configOptions?: SessionConfigOption[];
}
```

`session/load/resume/fork` 只有在 runtime 已 `switch_session` 到目标 OMP session path 后，才能读取并返回 control state。

### 模型选择

- ACP `models.availableModels` 来源于 OMP `get_available_models`。
- ACP `models.currentModelId` 来源于 OMP `get_state.model`。
- ACP `ModelInfo.modelId` 使用稳定编码：`${provider}/${id}`，例如 `sub2api-openai/gpt-5.5-Sys`。
- `configOptions` 同时提供 `id:"model"`、`category:"model"` 的 select，以兼容偏好 config option UI 的 client。
- `unstable_setSessionModel({ sessionId, modelId })` 与 `setSessionConfigOption({ configId:"model", value:modelId })` 必须走同一条实现路径。
- 设置模型时，adapter 必须解析 `modelId` 得到 `provider` 与 `modelId`，调用 OMP RPC `set_model`，然后重新读取 `get_state` 与 `get_available_models`，重建 `models` 与 `configOptions`。

### 推理强度 / thought level

- `configOptions` 提供 `id:"thinking"`、`category:"thought_level"` 的 select。
- 选项必须按当前模型能力动态生成：
  - 永远包含 `off`。
  - 如果当前模型含 `thinking.minLevel/maxLevel`，在固定顺序 `minimal < low < medium < high < xhigh` 中取闭区间。
  - 如果当前模型没有 thinking metadata，除非 `get_state.thinkingLevel` 已明确给出可用值，否则只暴露 `off`。
- `currentValue` 来源于 `get_state.thinkingLevel`；`undefined`、`null`、`inherit` 映射为 `off`。
- 如果当前值不在当前模型支持区间，adapter 不得静默裁剪成另一个值。为保持 ACP select 的 `currentValue` 可显示，应把 OMP 实际返回的 current value 追加到 options，并在 description 中标明「当前 runtime 值；不在当前模型 metadata 支持范围内」。setter 仍必须拒绝用户主动提交超范围值。
- `setSessionConfigOption({ configId:"thinking", value })` 必须在调用 OMP 前校验当前模型支持范围；例如 `gpt-5-codex` 支持 `minimal/low/medium/high`，不得提交 `xhigh`。
- `value:"off"` 调用 OMP RPC `set_thinking_level` 时传 `level:"off"`。
- 切换模型后必须重建 thinking 选项并发送 `config_option_update`，因为可用推理强度可能变化。

### ACP mode / Agent selector

- 本阶段可返回 `modes`，但只包含一个 `Default`：
  - `availableModes: [{ id:"default", name:"Default", description:"Standard OMP ACP mode" }]`
  - `currentModeId:"default"`
- `setSessionMode()` 只接受 `modeId:"default"`，返回 `{}` 并可发送 `current_mode_update`。
- 不声明或伪造多个 Agent/mode。若未来 OMP 提供主会话 agent selector，再单独设计。

### OMP-specific config options

首批可作为 `configOptions` 暴露的 OMP-specific 项：

| configId | 类型 | 值 | 来源 | Setter | category |
|---|---|---|---|---|---|
| `model` | select | `${provider}/${id}` | `get_available_models` + `get_state.model` | `set_model` | `model` |
| `thinking` | select | `off` + 当前模型支持区间 | `get_state.thinkingLevel` + model thinking metadata | `set_thinking_level` | `thought_level` |
| `_omp.steeringMode` | select | `all` / `one-at-a-time` | `get_state.steeringMode` | `set_steering_mode` | `_omp_interaction` |
| `_omp.followUpMode` | select | `all` / `one-at-a-time` | `get_state.followUpMode` | `set_follow_up_mode` | `_omp_interaction` |
| `_omp.interruptMode` | select | `immediate` / `wait` | `get_state.interruptMode` | `set_interrupt_mode` | `_omp_interaction` |
| `_omp.autoCompaction` | boolean | true / false | `get_state.autoCompactionEnabled` | `set_auto_compaction` | `_omp_context` |

明确暂缓：

- `_omp.autoRetry`：OMP RPC 有 `set_auto_retry`，但当前 `RpcSessionState` 未观察到 `autoRetryEnabled`，无法构造 truthful currentValue。
- sampling 与 service tier：只观察到 settings schema，未观察到 per-session setter。
- tools、extensions、skills、rules、MCP：范围独立，且涉及安全边界。

## 内部架构

### 真实 OMP RPC command contract

保持 `RuntimeAdapter` 对 ACP handler 的简洁接口，但修正 `OmpRpcClient` 内部序列化：

```ts
type OmpRpcCommandType =
  | "prompt"
  | "abort"
  | "switch_session"
  | "get_state"
  | "get_available_models"
  | "set_model"
  | "set_thinking_level"
  | "set_steering_mode"
  | "set_follow_up_mode"
  | "set_interrupt_mode"
  | "set_auto_compaction";
```

`RuntimeAdapter.request(method, params)` 可以暂时保留，但 `OmpRpcClient` 必须发送真实 OMP JSONL：

```ts
// prompt
{ id, type: "prompt", message, images? }

// switch session
{ id, type: "switch_session", sessionPath }

// get state
{ id, type: "get_state" }

// set model
{ id, type: "set_model", provider, modelId }
```

`cancelPrompt()` 不再发送 `{ type:"cancel" }`。它应调用 OMP `abort`：

```ts
runtime.request("abort")
```

`translatePromptToOmpRequest()` 应生成 `message` 而不是 `prompt` 字段，且不再把 ACP `sessionId` 放入 OMP prompt command。OMP RPC process 已经绑定到单个 session；`sessionId` 是 ACP adapter 层的管理字段，不是 OMP `prompt` command 字段。

### 真实 OMP RPC response contract

`OmpRpcClient` 必须接受真实 response frame：

```ts
{ id, type: "response", command, success: true, data? }
{ id, type: "response", command, success: false, error }
```

行为：

- `success:true` 时 resolve `data`；如果没有 `data`，resolve `undefined`。
- `success:false` 时 reject `OmpRpcResponseError`，错误对象保留 `command` 与 `error`。
- 其他非 response frame 继续作为 runtime event 发送给 listeners。
- 旧 fixture 的 `{ type:"response", id, result }` 形状不再作为生产 contract；测试 fixture 应改成真实 OMP shape。

### Session control state builder

新增小模块，建议路径：`src/acp/session-controls.ts`。

职责：

- 从 runtime 读取 `get_state` 与 `get_available_models`。
- 将 OMP model/state 映射为 ACP `models`、`modes`、`configOptions`。
- 校验 config option 输入。
- 执行 setter RPC 后重新读取并返回最新 `configOptions`。

建议类型：

```ts
export type OmpModelSummary = {
  provider: string;
  id: string;
  name?: string;
  thinking?: { minLevel?: string; maxLevel?: string };
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
};

export type OmpSessionControlState = {
  model?: OmpModelSummary;
  thinkingLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  interruptMode?: "immediate" | "wait";
  autoCompactionEnabled?: boolean;
};
```

所有从 OMP RPC 返回的 unknown data 必须先做 runtime validation；不能用 `as` 直接信任外部进程输出。

### SessionManager 与 response 构造

`SessionManager` 不应理解 ACP `models/configOptions`。它只管理 runtime lifecycle。

建议改造：

- 将 `createSession(params)` 改为返回 `SessionRecord`，或新增 `createSessionRecord(params)` 并让 handler 使用它。
- `handleSessionNew()` 创建 record 后调用 `buildSessionSetupState(record.runtime)`，返回：

```ts
{
  sessionId: record.sessionId,
  ...sessionSetupState
}
```

- `handleSessionLoad()`、`handleSessionResume()`、`handleSessionFork()` 在完成 `switch_session` 并发布 session 后，调用同一个 state builder，把结果附加到各自 response。

### ACP setters

在 `src/acp/server.ts` wiring：

```ts
async setSessionMode(params) {
  return handleSetSessionMode(params, manager, connection);
},

async unstable_setSessionModel(params) {
  return handleSetSessionModel(params, manager, connection);
},

async setSessionConfigOption(params) {
  return handleSetSessionConfigOption(params, manager, connection);
}
```

建议新增 handler 文件：

- `src/acp/handlers/session-config.ts`

错误语义：

| 场景 | ACP 错误 |
|---|---|
| 未知 session | `RequestError.resourceNotFound(sessionId)` |
| 未知 configId | `RequestError.invalidParams(...)` |
| config type/value 与 option 不匹配 | `RequestError.invalidParams(...)` |
| 未知 modelId | `RequestError.invalidParams(...)` |
| thinking level 不被当前模型支持 | `RequestError.invalidParams(...)`，message 包含模型与支持范围 |
| OMP RPC setter 返回 `success:false` | 映射为明确 error，保留 OMP command/error，不伪造成功 |

setter 成功后：

1. 重新读取 control state。
2. 通过 `connection.sessionUpdate({ sessionId, update:{ sessionUpdate:"config_option_update", configOptions } })` 推送最新配置。
3. 返回 ACP setter response：
   - `setSessionConfigOption` 返回 `{ configOptions }`。
   - `unstable_setSessionModel` 返回 `{}`。
   - `setSessionMode` 返回 `{}`。

## 测试策略

必须 TDD：先写失败测试，确认红灯，再实现。

### Unit: OMP RPC command/response contract

文件：`test/contract/omp-rpc/rpc-client.test.ts`

新增或修改测试：

- `request serializes prompt using OMP type/message command shape`
  - fixture 捕获 stdin frame；断言 `{ id, type:"prompt", message:"hello" }`，不包含 `method`、`params`、`sessionId`。
- `request serializes switch_session using top-level sessionPath`
- `request resolves real OMP success response data`
  - fixture 返回 `{ id, type:"response", command:"get_state", success:true, data:{ thinkingLevel:"low" } }`。
- `request rejects real OMP failure response`
  - fixture 返回 `{ id, type:"response", command:"set_model", success:false, error:"Model not found" }`。
- `cancelPrompt sends abort command`
  - manager cancel 通过 fixture 观察 `{ type:"abort" }`。

### Unit: prompt translation

文件：`test/unit/translate/prompt.test.ts`

- text prompt 输出 OMP `message` 字段。
- image prompt 输出 `images`，仍不污染 message text。
- 不再输出 ACP `sessionId` 到 OMP prompt command。

### Unit: session control state builder

文件：`test/unit/acp/session-controls.test.ts`

覆盖：

- model list 映射为 ACP `SessionModelState` 与 `configOptions(model)`。
- modelId 使用 `provider/id`，description 不包含 baseUrl、apiKey 或 provider raw config。
- thinking options 按 `minLevel/maxLevel` 裁剪：
  - `minimal..high` 不包含 `xhigh`。
  - `low..xhigh` 包含 `xhigh` 且不包含 `minimal`。
  - 缺少 thinking metadata 时只暴露 `off` 或已验证 currentValue。
- `set thinking xhigh` 在当前模型只支持到 `high` 时失败，且不会调用 runtime setter。
- 切换 model 后重建 thinking options。
- `_omp.steeringMode`、`_omp.followUpMode`、`_omp.interruptMode`、`_omp.autoCompaction` 映射 currentValue。

### Unit: ACP handlers

文件：`test/unit/acp/session-config.test.ts`

覆盖：

- `newSession` 返回 `models`、`modes`、`configOptions`。
- `loadSession/resumeSession/forkSession` 在 `switch_session` 后返回同样 state。
- `unstable_setSessionModel` 对有效 model 调用 `set_model`，发送 `config_option_update`。
- `setSessionConfigOption(model)` 与 `unstable_setSessionModel` 行为一致。
- `setSessionConfigOption(thinking)` 先校验当前模型范围，再调用 `set_thinking_level`。
- `setSessionConfigOption(_omp.steeringMode)` 调用 `set_steering_mode`。
- 未知 session、未知 configId、错误 value type 都返回明确 ACP error。

### Smoke / validation

扩展：

- `test/smoke/session-prompt.test.ts`：raw JSON-RPC `session/new` response 断言包含 `configOptions`，并通过 `session/set_config_option` 设置 fixture thinking 后继续 prompt。
- `scripts/smoke-acp.mjs`：summary 增加 `sessionConfigOptions:true`、`sessionSetConfigOption:true`。
- `scripts/smoke-sdk-client.mjs`：覆盖 SDK client 调用 setter。
- `scripts/probe-registry-matrix.mjs`：把 `session/set_model`、`session/set_config_option` 从 `method_not_found` 更新为已实现，并验证 fork 后 session 也返回 config state。
- 新增真实 OMP RPC 控制 smoke（建议 `scripts/smoke-omp-rpc-controls.mjs`）：当本机有 `omp` 时，用临时 `--session-dir` 验证 `get_state/get_available_models/set_thinking_level`。该脚本可作为 release gate；CI 无 OMP 时必须明确 skip 并输出原因，不能假 pass。

## 文档与能力声明

更新：

- `docs/compatibility/capability-matrix.md`
  - `session/set_model`：从未实现改为已实现（标注 SDK unstable）。
  - `session/set_config_option`：新增已实现行。
  - `session/set_mode`：仅 `default` 已实现；不得声称多 mode。
  - OMP-specific config options：列出首批支持项。
- `docs/compatibility/zed.md`
  - 说明 ZedG 中 `omp-acp-local` 的模型/推理强度来源。
  - 说明推理强度会按模型动态变化，某些模型不显示 `xhigh` 是正确行为。
- `README.md`
  - 更新本地 custom agent 能力说明。
- `docs/release-checklist.md`
  - 增加真实 OMP RPC control smoke 与 ZedG 手工 UI 检查项。

`initialize` 不需要新增单独 capability flag 来声明 `models/configOptions`；这些能力通过 session setup response 与对应 agent-side methods 体现。必须保证 matrix、docs 与实际 method support 一致。

## 验收标准

- 真实 OMP RPC command shape 已修正；adapter 不再向 OMP 发送 `{ method, params }`。
- `session/new/load/resume/fork` response 包含真实 control state。
- ZedG 能看到模型与推理强度配置；推理强度按当前模型动态裁剪。
- `session/set_model` 与 `session/set_config_option` 可用，且设置后可继续 `session/prompt`。
- 对不支持的 thinking effort 返回明确错误；不得把 runtime failure 当成功。
- 不暴露 API key、baseUrl 或 provider raw config。
- `npm run check`、`npm run smoke:acp`、`npm run smoke:sdk-client`、`npm run validate:registry` 通过。
- 真实 OMP RPC control smoke 在本机通过，或在无 OMP 环境明确 skip。
- ZedG 手工 smoke 仍是发布阻塞项；本阶段不能声明 Zed GUI 已完成验证，除非实际执行并记录结果。

## 风险与处理

| 风险 | 处理 |
|---|---|
| ACP model API 仍是 unstable | 文档标注；测试固定 SDK 0.21.0；不泛化到未知 SDK minor。 |
| OMP model id 使用 `provider/id` 编码，model id 本身可能含 `/` | 按第一个 `/` 分割 provider；若未来 provider 允许 `/`，需改为 `_meta` 或 JSON-safe encoding。当前 OMP provider id 未观察到 `/`。 |
| 当前用户配置的默认 thinking 可能超出默认模型支持范围 | session setup 读取真实 `get_state`；setter 严格校验；若 OMP 启动阶段直接失败，adapter 应保留 runtime ready failure，不伪造 config state。 |
| `get_state` 未返回某些 setter 的 current state | 不暴露该项。例如 `set_auto_retry` 暂缓。 |
| 真实 OMP 会输出与 prompt 无关的 extension UI event | 不在本阶段伪造支持；若事件发生在 active prompt 中，沿用现有 unsupported event 失败语义，后续单独设计。 |
| ZedG custom agent UI 对 `models` 与 `configOptions` 展示策略可能不同于预期 | 自动验证只能证明 ACP response/method；ZedG 手工 smoke 必须检查 UI。 |

## 实现顺序约束

1. 先修真实 OMP RPC contract，并更新 fixture/contract tests。
2. 再实现只读 control state builder，并让 session setup responses 返回 state。
3. 再实现 model/thinking setters。
4. 最后扩展 OMP-specific options 与文档/验证矩阵。

不得先声明 `session/set_model` 或返回 config options 后再补 runtime contract。配置 UI 必须建立在真实 OMP RPC 可用性的证据上。