# ACP extension UI 交互桥实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。必须直接在当前 `main` 工作区开发，不创建 git worktree。每个任务先写失败测试，再写实现；不得声明未实现的 ACP elicitation 或通用 Ask 能力。

**目标：** 在 OMP ACP 模式中禁用通用 `ask` 工具，同时尊重 OMP settings、插件/extension 工具、MCP 工具和未来工具发现；桥接 OMP `confirm` 到 ACP `session/request_permission`；把 `setWidget` 作为可见进度展示输出。

**架构：** 不使用静态 `--tools` 白名单。默认 `buildOmpRpcCommand()` 启动 `omp --mode rpc` 时注入 adapter 自带的 `disable-ask-extension.mjs`。该 extension 在 `before_agent_start` 中读取当前 active tools，若存在 `ask`，调用 `setActiveTools()` 移除 `ask` 并保留其他所有工具。adapter 的 `SessionManager` 在 runtime ready 后再执行一层 `get_state` / `set_active_tools` 防线：基于 OMP 返回的 `dumpTools` 做差集，只移除 `ask`。之后 `ExtensionUiBridge` 处理 `extension_ui_request`：`confirm` 通过 ACP permission request 后回写 OMP `extension_ui_response`，`setWidget` 发送限长/去重的 thought update，`select/input/editor` 保持 unsupported。

**技术栈：** Node.js >= 20、TypeScript、`@agentclientprotocol/sdk@0.21.0`、`node:test`、JSON-RPC over stdio、OMP RPC JSONL、现有 fake runtime 与 smoke harness。

**规格来源：** `docs/superpowers/specs/2026-05-09-acp-extension-ui-bridge-design.md`。

---

## 文件结构与职责

- 修改：`src/runtime/omp/command.ts` — 默认 OMP 命令注入 Ask-disabling extension，但不传 `--tools`。
- 新增：`src/runtime/omp/disable-ask-extension.mjs` — OMP extension，在 `before_agent_start` 中从当前 active tools 移除 `ask`。
- 修改：`src/runtime/omp/rpc-client.ts` — 支持 OMP RPC `set_active_tools` request。
- 修改：`src/session/manager.ts` — runtime ready 后读取 `dumpTools`，仅移除 active `ask`。
- 修改：`test/runtime/omp/command.test.ts` — 覆盖默认命令不含 `--tools`、注入 extension、extra args 行为。
- 修改：`test/contract/omp-rpc/rpc-client.test.ts` — 覆盖 `set_active_tools` frame。
- 修改：`test/unit/session/manager.test.ts` — 覆盖只移除 `ask`、保留插件/MCP/其他工具。
- 新增：`src/acp/extension-ui.ts` — prompt-scoped OMP extension UI bridge。
- 新增：`test/unit/acp/extension-ui.test.ts` — 覆盖 bridge 的 permission 回写、widget 展示、去重、失败路径。
- 修改：`src/acp/handlers/session-prompt.ts` — 将 `extension_ui_request` 事件先交给 `ExtensionUiBridge`。
- 修改：`test/unit/acp/session-handlers.test.ts` — 覆盖 prompt 生命周期与 active prompt guard。
- 修改：`src/testing/script-rpc-process.ts` — 增加 confirm / setWidget 场景、raw `extension_ui_response` 和 `set_active_tools` fixture 支持。
- 修改：`test/smoke/session-prompt.test.ts` — raw ACP subprocess smoke 覆盖 permission request/response 和 `setWidget` 展示。
- 修改：`package.json` / `scripts/run-tests.mjs` — 当前硬化后测试入口由 `node scripts/run-tests.mjs` 自动发现 `test/**/*.test.ts` 与 `test/**/*.test.mjs`，无需维护显式测试枚举。
- 修改：`README.md`、`docs/compatibility/capability-matrix.md`、`docs/compatibility/zed.md`、`scripts/smoke-zed.md` — 记录 Ask 禁用边界、`confirm` permission 子集、`setWidget` 展示和不支持 elicitation 的边界。

---

## 任务 1：无白名单禁用 `ask`

**文件：**
- 修改：`src/runtime/omp/command.ts`
- 新增：`src/runtime/omp/disable-ask-extension.mjs`
- 修改：`src/runtime/omp/rpc-client.ts`
- 修改：`src/session/manager.ts`
- 修改：`src/testing/script-rpc-process.ts`
- 测试：`test/runtime/omp/command.test.ts`、`test/contract/omp-rpc/rpc-client.test.ts`、`test/unit/session/manager.test.ts`

- [ ] **步骤 1：失败测试：默认命令不使用静态 `--tools`，而是注入 extension**

`test/runtime/omp/command.test.ts` 断言：

- args 前缀为 `--mode rpc`。
- 不包含 `--tools`。
- 包含 `--extension <...disable-ask-extension.mjs>`。
- `extraArgs` 仍追加在末尾。

- [ ] **步骤 2：失败测试：RPC client 支持 `set_active_tools`**

`test/contract/omp-rpc/rpc-client.test.ts` 断言：

```ts
client.request("set_active_tools", { toolNames: ["read", "plugin_tool"] })
```

写出真实 OMP frame：

```json
{ "type": "set_active_tools", "toolNames": ["read", "plugin_tool"] }
```

- [ ] **步骤 3：失败测试：SessionManager 只移除 `ask`**

`test/unit/session/manager.test.ts` 使用 fake runtime：

- `get_state` 返回 `dumpTools: [{name:"read"}, {name:"ask"}, {name:"plugin_tool"}, {name:"mcp__server__tool"}]`。
- 期望 `set_active_tools` 参数为 `read,plugin_tool,mcp__server__tool`。
- 当 `dumpTools` 不含 `ask` 时，不调用 `set_active_tools`。

- [ ] **步骤 4：实现 default extension 注入**

`src/runtime/omp/command.ts`：

```ts
args: ["--mode", "rpc", "--extension", DISABLE_ASK_EXTENSION_PATH, ...(options.extraArgs ?? [])]
```

不得引入 `--tools`。

`src/runtime/omp/disable-ask-extension.mjs`：

```js
export default function disableAskInAcp(pi) {
  pi.on("before_agent_start", async () => {
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes("ask")) return;
    await pi.setActiveTools(activeTools.filter((name) => name !== "ask"));
  });
}
```

- [ ] **步骤 5：实现 RPC `set_active_tools`**

`src/runtime/omp/rpc-client.ts` 新增 request method：

```ts
case "set_active_tools":
  return { id, type: method, toolNames: requireStringArray(...) };
```

- [ ] **步骤 6：实现 session setup 防线**

`src/session/manager.ts` 在 `runtime.ready` 后、session publish 前：

1. `runtime.request("get_state")`
2. 从 `dumpTools` 提取 active tool names。
3. 如果含 `ask`，调用 `runtime.request("set_active_tools", { toolNames: namesWithoutAsk })`。
4. 如果不含 `ask`，不 mutation。

该逻辑失败应导致 session 创建失败，不能发布一个 Ask 状态未知的 session。

- [ ] **步骤 7：运行目标测试**

```bash
node --import tsx --test --test-concurrency=1 test/runtime/omp/command.test.ts test/contract/omp-rpc/rpc-client.test.ts test/unit/session/manager.test.ts
```

预期全部 PASS。

---

## 任务 2：新增 `ExtensionUiBridge`

创建 `src/acp/extension-ui.ts` 与 `test/unit/acp/extension-ui.test.ts`。

行为：

- `confirm`：发起 `connection.requestPermission()`，根据 outcome 用 `runtime.send()` 写入 raw `{ type:"extension_ui_response", id, confirmed|cancelled }`。
- `setWidget`：将非空 `widgetLines` 输出为限长、按 `widgetKey` 去重的 `agent_thought_chunk`。
- `setStatus` / `setTitle` / `notify` / `set_editor_text` / `cancel`：继续作为 fire-and-forget 状态事件处理，不需要 OMP response。
- `select` / `input` / `editor`：抛 `UnsupportedRuntimeEventError`，错误信息包含 method 与 id。

---

## 任务 3：接入 prompt 生命周期

修改 `src/acp/handlers/session-prompt.ts` 与 `test/unit/acp/session-handlers.test.ts`。

`extension_ui_request` 事件必须在通用 translator 前交给 `ExtensionUiBridge`。bridge promise 纳入现有 update/drain 队列和 `eventFailure` race，保证：

- confirm permission 未完成时 active prompt 不释放。
- OMP `extension_ui_response` 写入失败会让 prompt 失败。
- `setWidget` update delivery 未完成时 prompt response 不提前返回。
- 仍等待 OMP prompt ack + `agent_end`。

---

## 任务 4：fixture 与 smoke 覆盖

修改 `src/testing/script-rpc-process.ts` 和 `test/smoke/session-prompt.test.ts`。

新增场景：

- `extension-ui-confirm`：fixture 发出 confirm request；ACP smoke 模拟 client 回复 allow；fixture 观察 `extension_ui_response.confirmed:true` 后输出 `confirm accepted`。
- `extension-ui-confirm-reject`：模拟 reject；fixture 输出 `confirm rejected`。
- `extension-ui-set-widget-display`：fixture 发出 `setWidget`，smoke 断言收到 thought/progress 文本。

同时确认 `test/unit/acp/extension-ui.test.ts` 能被 `scripts/run-tests.mjs` 自动发现；当前 `package.json` 不维护 `test` / `check` 显式测试列表。

---

## 任务 5：文档与能力边界

更新：

- `README.md`
- `docs/compatibility/capability-matrix.md`
- `docs/compatibility/zed.md`
- `scripts/smoke-zed.md`

记录：

- adapter 默认不用 `--tools` 白名单；Ask 通过 runtime active-tool 差集移除。
- 用户不需要手动维护 tool 列表。
- 插件/extension 工具、MCP 工具和 OMP settings 派生工具会被保留。
- Permission request 只实现 OMP `confirm` 子集。
- `setWidget` 显示为 thought/progress 文本。
- 不支持 ACP elicitation；`select/input/editor` 仍明确失败。
- Zed/ZedG GUI smoke 仍需手工验证，不得声明已完成。

---

## 任务 6：最终验证与审查

目标验证：

```bash
node --import tsx --test --test-concurrency=1 test/runtime/omp/command.test.ts test/contract/omp-rpc/rpc-client.test.ts test/unit/session/manager.test.ts test/unit/acp/extension-ui.test.ts test/unit/acp/session-handlers.test.ts test/unit/translate/events-message.test.ts test/smoke/session-prompt.test.ts
npm run check
npm run build
git diff --check
```

完成实现后并发启动至少 3 个只读 reviewer，分别审查：

1. ACP permission/request lifecycle 正确性。
2. OMP RPC raw frame、Ask 禁用策略和插件/设置保留边界正确性。
3. UX/docs 边界是否如实、不误声明 elicitation 或通用 Ask 支持。

## 验收标准

- 默认 `buildOmpRpcCommand()` 不生成静态 `--tools` 白名单。
- 默认 `buildOmpRpcCommand()` 注入 Ask-disabling extension。
- Session setup 会移除 active `ask`，但保留所有其他 active tools，包括插件/extension/MCP 工具。
- 仅设置 `OMP_ACP_RUNTIME_COMMAND` 不会绕过默认 `--extension`；只有显式设置 `OMP_ACP_RUNTIME_ARGS_JSON` 时才完整替换 runtime argv，session setup 防线仍尽力移除 active `ask`。
- `confirm` allow/reject/cancel 都会回写 OMP `extension_ui_response`，runtime 不悬挂。
- `setWidget` 有可见 ACP 展示，限长并按 widgetKey 去重。
- `select/input/editor` 仍明确失败。
- `session/prompt` 不因 confirm 或 widget bridge 提前释放 active prompt。
- 自动测试、smoke、`npm run check`、`npm run build` 和 `git diff --check` 通过。
- 文档只声明实际实现的 confirm permission 子集，不声称 ACP elicitation 或完整通用 Ask。
