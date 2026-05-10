# ACP 交互桥与 Ask 工具禁用设计

## 背景

`omp-acp` 已处理 OMP RPC 的普通消息、工具事件、host tool bridge，以及非交互的 `extension_ui_request` 状态事件。真实 OMP extension 仍可能发出需要宿主 UI 回答的请求，例如 `confirm`、`select`、`input`、`editor`。同时 OMP 内置 `ask` 工具会生成通用提问请求，在 Zed/ZedG 当前不支持 ACP `elicitation/create` 的情况下会导致 prompt 中断或 runtime 等待。

需要禁用 OMP 内置 `ask`，但不能用静态 `--tools` 白名单实现：`--tools` 会把 OMP 当前 settings 派生的内置工具集合重写成 adapter 写死的集合，可能隐藏插件/extension/MCP 工具，也可能启用用户配置中原本关闭的内置工具。

## 目标

- 默认 ACP-launched OMP runtime 不向模型暴露内置 `ask` 工具。
- 保留 OMP 自己的工具启用逻辑：settings 派生的内置工具、插件/extension 注册工具、MCP 工具、未来发现机制都不由 adapter 静态枚举。
- 对 OMP RPC `extension_ui_request method="confirm"` 建立稳定桥接：向 ACP client 发出 `session/request_permission`，根据用户选择回写 OMP `extension_ui_response`。
- 对 OMP RPC `extension_ui_request method="setWidget"` 建立展示映射：将 `widgetLines` 以限长、去重的文本 update 展示给 ACP client。
- 保持 `select` / `input` / `editor` 的明确失败语义，避免 runtime indefinite wait 或错误地使用 permission 表达通用输入。
- 保持 stdout 只输出 ACP JSON-RPC/NDJSON。

## 非目标

- 不实现 ACP `elicitation/create`，也不声明客户端通用结构化输入能力。
- 不把 OMP `select`、`input`、`editor` 或 Ask 工具问题映射为 `session/request_permission`。
- 不实现 OMP extension 的复杂 React/TUI widget 组件渲染；RPC `setWidget` 当前只有 `widgetLines` 文本数组输入。
- 不新增 MCP、filesystem delegation、terminal delegation 或新的 ACP initialize 能力声明。
- 不用静态 `--tools` 白名单禁用 Ask。

## 已确认的 OMP RPC 契约

来自本机安装的 `@oh-my-pi/pi-coding-agent` 源码：

- `RpcExtensionUIRequest` 包含：
  - 交互型：`select`、`confirm`、`input`、`editor`。
  - 展示/状态型：`cancel`、`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`。
- `RpcExtensionUIResponse` 的合法形状为：
  - `{ "type": "extension_ui_response", "id": string, "value": string }`
  - `{ "type": "extension_ui_response", "id": string, "confirmed": boolean }`
  - `{ "type": "extension_ui_response", "id": string, "cancelled": true, "timedOut"?: boolean }`
- OMP RPC 主循环从 stdin JSONL 读取 `extension_ui_response`，按 `id` resolve pending UI request。
- `confirm()` 解析规则：
  - `cancelled` 或缺少 `confirmed` → `false`。
  - `confirmed: true` → `true`。
  - `confirmed: false` → `false`。
- `get_state` 返回的 `dumpTools` 是当前 active tools 快照。
- OMP RPC extension API 暴露 `getActiveTools()` / `setActiveTools()`，可在 runtime 内移除某个 active tool，而不需要 adapter 静态列出全部工具。

## Ask 禁用策略

### 默认 OMP 命令

`buildOmpRpcCommand()` 默认启动：

```text
omp --mode rpc --extension <adapter disable-ask extension>
```

关键点：

- 不传 `--tools`，避免覆盖 OMP 自己的工具启用设置。
- 注入 adapter 自带的 `disable-ask-extension.mjs`。
- 该 extension 在 `before_agent_start` 中读取 `pi.getActiveTools()`；若其中包含 `ask`，调用 `pi.setActiveTools(active.filter(name => name !== "ask"))`。
- 因为它基于当前 active tools 做差集，所以会保留插件/extension 工具、MCP 工具，以及用户 settings 启用的其他内置工具。

### Session setup 防线

adapter 在 `SessionManager.createSessionWithId()` 中等待 runtime ready 后读取 `get_state`：

1. 从 `dumpTools` 提取当前 active tool names。
2. 如果包含 `ask`，调用 OMP RPC `set_active_tools`，传入原列表去掉 `ask` 后的工具名。
3. 如果不包含 `ask`，不做任何 mutation。

这层防线保证即使默认 extension 被用户自定义 args 绕过，adapter-managed session setup 仍会尽力移除 `ask`，且同样只做差集，不维护静态工具列表。

### 用户显式 runtime 覆盖

`OMP_ACP_RUNTIME_COMMAND` 只覆盖 OMP executable；adapter 仍会提供默认 args：`--mode rpc --extension <adapter disable-ask extension>`。只有设置 `OMP_ACP_RUNTIME_ARGS_JSON` 时，才视为用户明确要替换完整 runtime argv，adapter 按原样启动，不隐式拼接默认 args。之后 session setup 的 `get_state` / `set_active_tools` 防线仍会移除 active `ask`。

不建议用户手动维护 `--tools` 白名单；这会破坏插件、MCP 与 OMP settings 派生工具集合。

## `confirm` → ACP `session/request_permission`

### 映射条件

`extension_ui_request` 事件满足以下条件时进入 permission bridge：

- `eventType === "extension_ui_request"`
- `raw.method === "confirm"`
- `raw.id` 是非空 string 或 number，可转为 string。
- `raw.title` / `raw.message` 至少一个是非空 string。

不满足必填字段时，prompt 必须失败，错误信息包含 `extension_ui_request`、`confirm` 和可用的 `id`，不能静默忽略。

### ACP request

`ExtensionUiBridge` 调用 connection：

```ts
connection.requestPermission({
  sessionId,
  toolCall: {
    toolCallId: id,
    title,
    status: "pending",
    kind: "other",
    content: [{ type: "content", content: { type: "text", text: message } }],
  },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow" },
    { optionId: "reject_once", kind: "reject_once", name: "Reject" },
  ],
})
```

不要在 title/content 中泄漏 provider secret、API key、base URL 或完整 provider config。

### 回写 OMP

- ACP allow outcome → `runtime.send({ type:"extension_ui_response", id, confirmed:true })`
- ACP reject outcome → `runtime.send({ type:"extension_ui_response", id, confirmed:false })`
- ACP cancelled / no selected option → `runtime.send({ type:"extension_ui_response", id, cancelled:true })`

`requestPermission()` 自身失败或 `runtime.send()` 写入失败是 transport/bridge failure，必须 reject prompt，不能伪装成用户拒绝。

## `setWidget` → ACP thought/progress

`setWidget` 是展示/状态事件，不需要 OMP response。

- 只处理 `widgetLines: string[]`。
- `widgetLines` 为空或不是数组 → 不发 update。
- 文本格式：可包含 `[widgetKey]` 前缀，后接行内容。
- 每个 prompt 内按 `widgetKey` 去重：同 key 相同文本不重复发送。
- 文本上限约 4000 字符，超出截断并追加 `…`。
- 发送为 `agent_thought_chunk`，不是 `agent_message_chunk`。

## Unsupported 交互

以下 method 仍明确失败：

- `select`
- `input`
- `editor`
- 未知 method

错误信息需要包含 `extension_ui_request`、method、id（若存在）。失败后 prompt 结束，不得让 OMP pending request 悬挂到下一个 turn。

以下展示/状态 method 不需要 response，可忽略或转为有限展示：

- `cancel`
- `notify`
- `setStatus`
- `setTitle`
- `set_editor_text`

## 测试要求

- Runtime command 测试：
  - 默认命令不包含 `--tools`。
  - 默认命令注入 `disable-ask-extension.mjs`。
  - `extraArgs` 仍追加在末尾。
- OMP RPC client contract 测试：
  - `set_active_tools` 序列化为 `{ type:"set_active_tools", toolNames:[...] }`。
  - 非字符串数组参数明确失败。
- Session manager 测试：
  - runtime ready 后读取 `get_state`。
  - `dumpTools` 包含 `ask` 时，仅调用 `set_active_tools` 移除 `ask`，保留插件/MCP/其他工具。
  - `dumpTools` 不包含 `ask` 时不 mutation。
- Bridge 单元测试：
  - `confirm` allow/reject/cancel 回写正确 OMP frame。
  - `requestPermission` reject 与 `runtime.send` reject 传播失败。
  - `setWidget` 发送 thought update、限长、去重。
  - `select` / `input` / `editor` 抛 `UnsupportedRuntimeEventError`。
- Handler / smoke：
  - prompt 收到 confirm 时保持 active prompt，直到 permission response、OMP response 写入、runtime ack、`agent_end` 都完成。
  - setWidget update 进入同一个 update drain，prompt response 不早于 widget update delivery。
  - raw ACP subprocess smoke 覆盖 client-side `session/request_permission` request/response。

## 文档要求

- `README.md`：说明 adapter 默认不用 `--tools` 白名单；Ask 通过 runtime active-tool 差集移除，保留 OMP settings/plugin/MCP 工具。
- `docs/compatibility/capability-matrix.md`：permission request 仅支持 OMP `confirm` 子集；通用 Ask / elicitation 不支持。
- `docs/compatibility/zed.md`：说明 Zed/ZedG 当前可处理 permission approval，但不依赖 `elicitation`；UI 中 `setWidget` 以 thought/progress 文本展示。
- `scripts/smoke-zed.md`：新增手工 smoke 项：触发 confirm 时出现 permission UI；触发 widget 时看到展示文本；不出现 Ask 通用表单；不要要求用户维护 `--tools` 白名单。

## 验收标准

- 默认本地 OMP RPC 启动不使用静态 `--tools` 白名单。
- 默认本地 OMP RPC 启动注入 adapter Ask-disabling extension。
- Session setup 会移除 active `ask`，但保留所有其他 active tools，包括插件/extension/MCP 工具。
- 仅设置 `OMP_ACP_RUNTIME_COMMAND` 不会绕过默认 `--extension`；只有显式设置 `OMP_ACP_RUNTIME_ARGS_JSON` 时才完整替换 runtime argv，session setup 防线仍尽力移除 active `ask`。
- `confirm` permission allow/reject/cancel 都会回写 OMP `extension_ui_response`，runtime 不悬挂。
- `setWidget` 有可见 ACP 展示，限长并按 widgetKey 去重。
- `select` / `input` / `editor` 仍明确失败。
- `session/prompt` 不因 confirm bridge 过早释放 active prompt。
- 所有新增行为有 TDD 红绿测试；`npm run check`、`npm run build` 通过。
