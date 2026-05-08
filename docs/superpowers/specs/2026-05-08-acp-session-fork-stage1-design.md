# Stage 8A: ACP `session/fork` 第一阶段设计

> 对应总体计划后续阶段。本阶段只实现 ACP 标准 `session/fork` 的最小可防御能力：从源 session 当前已持久化的 head fork 出一个新 session。OpenCode 原生的 message-bound fork 作为参考事实记录，但不在第一阶段通过非标准 ACP 字段实现。

## 目标

- 实现 ACP SDK 0.21.0 中的 `unstable_forkSession(params: ForkSessionRequest)`，并在 `initialize` 中声明 `sessionCapabilities.fork:{}`。
- fork 语义定义为：复制源 OMP session JSONL 中已经持久化的历史，创建一个新的 OMP session 文件，并把新 ACP session 绑定到该文件。
- fork 完成后，新 session 可以立即继续 `session/prompt`，并通过现有 `switch_session` runtime contract 指向 fork 后的新 session path。
- 保持当前 truthful 能力边界：不通过 `_meta` 伪造非标准 message-bound fork，不声明 MCP、permission、terminal/filesystem delegation、usage update 等无关能力。

## 非目标

- 不实现 OpenCode 原生 HTTP API 风格的 `messageID` fork。ACP `ForkSessionRequest` 当前没有 `messageId` 字段；第一阶段不读取 `_meta.messageId`、`_meta.messageID` 或其他私有字段。
- 不实现「从正在运行的 active prompt 中间状态」fork。源 session 有 active prompt 时必须明确失败，避免复制未稳定落盘的半成品状态。
- 不实现 OMP runtime 的新 `branch`、`fork` 或 `new_session parentSession` RPC 命令；第一阶段只基于已经验证过的 OMP session JSONL storage 与 `switch_session` contract。
- 不扩展 ACP response 的 model/mode/config option。`ForkSessionResponse` 第一阶段只返回 `{ sessionId }`。
- 不修改 Zed GUI smoke 范围。Zed 手工验证仍由 `scripts/smoke-zed.md` 负责。

## 已观察依据

### ACP SDK 0.21.0

- `ForkSessionRequest` 是 unstable capability，字段包括 `sessionId`、`cwd`、`mcpServers?`、`additionalDirectories?`、`_meta?`。
- `ForkSessionRequest` 没有标准 `messageId` 字段。
- `ForkSessionResponse` 必须包含新建的 `sessionId`，可选包含 `models`、`modes`、`configOptions`。
- `SessionForkCapabilities` 当前为空对象；声明 fork 的方式是 `sessionCapabilities.fork:{}`。
- SDK agent-side 方法名仍是 `unstable_forkSession`。

### OpenCode 参考实现

- OpenCode ACP adapter 在 `initialize` 中声明 `sessionCapabilities.fork:{}`。
- OpenCode ACP `unstable_forkSession(params)` 调用 `sdk.session.fork({ sessionID: params.sessionId, directory })`，没有从 ACP request 传入 message id。
- OpenCode 原生 session service 的 `fork({ sessionID, messageID? })` 支持可选 `messageID`：传入时复制到该消息之前；不传时复制整个 session。
- OpenCode TUI/Web 的「从时间线 fork」通过 OpenCode 自己的 HTTP API 传 `messageID`，不是 ACP 标准字段。

结论：OpenCode 证明 fork 能力可以成立，但 ACP 标准层第一阶段应实现「从 session head fork」，而不是把 OpenCode 私有 message-bound fork 直接塞进 ACP 标准方法。

### 当前 `omp-acp` 基础

- `listOmpSessions()` 与 `findOmpSessionById()` 已按 OMP JSONL header 扫描 session 文件。
- `loadSession()` 与 `resumeSession()` 已通过 `runtime.request("switch_session", { sessionPath })` 切换 OMP runtime session path。
- `SessionManager.createSessionWithId()` 已支持在 publish 前运行 `beforePublish(runtime)`，可复用来先 `switch_session` 再暴露 fork 后 session。
- 当前 `OmpSessionHeader` 只解析 `type`、`id`、`cwd`、`timestamp?`、`title?`；Stage 5 spec 已提到 OMP header 可能包含 `parentSession?`，但代码尚未保留该字段。

## 第一阶段语义

### 请求

`session/fork` 接收 ACP SDK 的 `ForkSessionRequest`：

```ts
type ForkSessionRequest = {
  sessionId: string;
  cwd: string;
  mcpServers?: McpServer[];
  additionalDirectories?: string[];
  _meta?: Record<string, unknown> | null;
};
```

第一阶段只使用：

- `sessionId`：源 session id；
- `cwd`：查找源 session 和创建 fork session 的 cwd；
- `mcpServers ?? []`：沿用 session manager 输入，当前仍不接入 MCP runtime。

`additionalDirectories` 与 `_meta` 保留但不改变行为。

### 源 session 选择

- 通过 `findOmpSessionById(params.sessionId, { cwd: params.cwd, agentDir })` 找源 OMP session 文件。
- 找不到时抛 `RequestError.resourceNotFound(params.sessionId)`。
- 如果源 session 当前在 `SessionManager` 中存在且 `activePrompt !== undefined`，抛 `RequestError.invalidParams(..., "Cannot fork a session with an active prompt")`。
- 如果源 session 在 manager 中不存在，但 JSONL 文件存在，可以 fork。这覆盖 session list/load/resume 后的历史 session。

### Fork 文件生成

新增 runtime helper：

```ts
export type ForkOmpSessionOptions = {
  sourcePath: string;
  sourceSessionId: string;
  forkSessionId: string;
  cwd: string;
  agentDir?: string;
  now?: () => Date;
};

export type ForkOmpSessionResult = {
  sessionId: string;
  path: string;
};

export async function forkOmpSessionFile(options: ForkOmpSessionOptions): Promise<ForkOmpSessionResult>;
```

行为：

1. 读取 `sourcePath` 的 JSONL。
2. 找到第一条有效 JSON object，要求它是源 session header，且 `id === sourceSessionId`、`cwd === cwd`。
3. 创建新 header：
   ```json
   {
     "type": "session",
     "id": "<forkSessionId>",
     "cwd": "<cwd>",
     "timestamp": "<now ISO>",
     "title": "<source title> (fork)",
     "parentSession": "<sourceSessionId>"
   }
   ```
   如果源 header 没有 `title`，则不写 `title`，避免编造用户可见标题。
4. 复制源文件中 header 之后的非空行。第一阶段不裁剪到 message id。
5. 如果复制的 JSON object 中存在明显的 session id 字段且值等于源 id，则改为 fork id：
   - top-level `sessionId`；
   - top-level `sessionID`；
   - nested `message.sessionId`；
   - nested `message.sessionID`。
   其他未知字段保持原样，避免破坏 OMP 自有历史格式。
6. 使用独占创建写入 `resolveAgentDir(agentDir)/sessions/<encodeOmpSessionCwd(cwd)>/<forkSessionId>.jsonl`，实现必须使用原子创建语义（例如 `writeFile(..., { flag: "wx" })` 或等价 `open("wx")` 后写入），禁止「先检查再覆盖写入」。
7. 如果目标文件已存在，必须失败而不是覆盖；测试要证明已有文件内容保持不变。

该 helper 是文件级 clone，不负责启动 runtime。

### ACP handler

新增 `src/acp/handlers/session-fork.ts`：

```ts
export async function handleSessionFork(
  params: ForkSessionRequest,
  manager: SessionManager,
  options: { agentDir?: string } = {},
): Promise<ForkSessionResponse>;
```

流程：

1. 如果 `manager.tryGetSession(params.sessionId)?.activePrompt` 存在，拒绝 fork。
2. 通过 `findOmpSessionById()` 找源 session path。
3. 生成 fork session id，使用 `SessionManager` 的 id generator，避免 handler 自己直接依赖 `randomUUID()`。
4. 调用 `forkOmpSessionFile()` 写新 JSONL。
5. 调用 `manager.createSessionWithId(forkId, params, beforePublish)`：
   - runtime factory 使用 fork id；
   - `beforePublish` 中发送 `runtime.request("switch_session", { sessionPath: forkPath })`；
   - publish 后 manager 中保存 fork 后 session。
6. 返回 `{ sessionId: forkId }`。

为支持第 3 步，`SessionManager` 需要新增两个小接口：

```ts
reserveSessionId(): string;
tryGetSession(sessionId: string): SessionRecord | undefined;
```

`reserveSessionId()` 只生成 id，不修改状态。重复检测仍由 `createSessionWithId()` 负责。

### Server wiring

`createOmpAcpAgent()` 增加：

```ts
async unstable_forkSession(params: ForkSessionRequest) {
  return handleSessionFork(params, manager, handlerOptions);
}
```

`buildInitialAgentCapabilities()` 增加：

```ts
sessionCapabilities: {
  list: {},
  resume: {},
  fork: {},
}
```

### 错误语义

| 场景 | ACP 错误 |
|---|---|
| 源 session 不存在或 cwd 不匹配 | `RequestError.resourceNotFound(params.sessionId)` |
| 源 session 有 active prompt | `RequestError.invalidParams(..., "Cannot fork a session with an active prompt")` |
| 源文件 header 不匹配或不是 session header | `RequestError.resourceNotFound(params.sessionId)` |
| fork 文件目标已存在 | `RequestError.internalError(...)`，同时测试确保 id generator 不重复；真实重复属于内部一致性问题 |
| runtime `switch_session` 失败 | session 创建失败，不发布 fork 后 session；返回 SDK 包装后的明确 error |

## 测试策略

必须使用 TDD。每个生产代码变更前先写失败测试并确认红灯。

### Unit: OMP session fork helper

文件：`test/unit/runtime/omp/sessions.test.ts`

新增测试：

- `forkOmpSessionFile clones a session at head with parentSession metadata`
  - 源 JSONL 包含 header、user message、assistant message；
  - fork 后文件 header id 为新 id；
  - header `parentSession` 为源 id；
  - title 为源标题加 ` (fork)`；
  - message entries 保持顺序；
  - `sessionId/sessionID` 字段按规则改写。
- `forkOmpSessionFile rejects a source whose header does not match the requested session`
  - header id 或 cwd 不匹配时失败。
- `listOmpSessions preserves fork metadata only as private file content`
  - 第一阶段不要求 `ListSessionsResponse` 暴露 parent 信息，避免扩展 ACP schema。

### Unit: ACP fork handler

文件：`test/unit/acp/session-fork.test.ts`

新增测试：

- `forkSession creates an OMP fork file, switches runtime before publishing, and returns the fork id`
  - 使用 fake runtime；
  - 断言 `runtime.request("switch_session", { sessionPath })` 发生在返回前；
  - 断言 manager 中 fork session 可继续 prompt。
- `forkSession rejects unknown source session clearly`
  - 期望 `RequestError.resourceNotFound`。
- `forkSession rejects active source prompt`
  - 先创建源 session 并开始 prompt；
  - fork 返回 invalid params；
  - 不创建 fork 文件。
- `forkSession does not publish session when switch_session fails`
  - fake runtime `switch_session` reject；
  - manager 中没有 fork id。

测试门禁还必须同步更新 `package.json`：当前 `test` / `check` 脚本显式枚举测试文件，新增 `test/unit/acp/session-fork.test.ts` 后必须加入枚举列表，否则关键 fork handler 单测不会被 `npm run check` 执行。

### Unit: initialize capability

文件：`test/unit/acp/initialize.test.ts`

更新测试：

- `buildInitialAgentCapabilities` 断言 `sessionCapabilities.fork` 精确为 `{}`。
- 继续断言 `sessionCapabilities.close` 仍未声明。

### Smoke: JSON-RPC fork

文件：`test/smoke/session-prompt.test.ts`

新增 smoke：

- 在临时 `OMP_ACP_AGENT_DIR` 写源 session JSONL；
- initialize；
- 发送 `session/fork`，用 `nextResponse(forkRequestId)` 断言 response id 与请求 id 一致、无 error，result 包含新 `sessionId`；
- 读取 fork 后文件，确认 header `parentSession`；
- 对 fork 后 session 发送 `session/prompt`；
- 先用 `nextMessage()` 断言 forked prompt 的 `session/update` notification 归属 fork 后 `sessionId`，再用 `nextResponse(promptRequestId)` 断言 response id 与请求 id 一致且 result 为 `{ stopReason:"end_turn" }`；
- 断言 `acp.stderr === ""`，保持 stdout 只含 ACP JSON-RPC/NDJSON frame 的既有 smoke 边界。

### Registry-style validation

文件：`scripts/probe-registry-matrix.mjs`

更新预期：

- `capabilities.sessionFork === true`；
- `session/fork` probe 从 `method_not_found` 改为 `success`；
- probe 后可选发送一次 forked prompt，确认 forked session 可继续使用。

## 文档更新

实现阶段必须同步更新：

- `docs/compatibility/capability-matrix.md`
  - `session/fork` 从「不支持」改为「已实现」；
  - 声明策略写明「ACP 标准 fork 到 source head；不支持 message-bound fork」。
- `docs/compatibility/acp-validation.md`
  - Registry-style probe 中 fork 从 unsupported method 改为 supported probe。
- `docs/compatibility/zed.md`
  - 去掉「`session/fork` 未声明」；补充第一阶段 fork 语义。
- `docs/release-checklist.md`
  - 自动化门禁快照重新记录。
- `README.md`
  - Stage 状态补充 fork 已实现后再更新；spec 阶段不提前更新。
- `docs/superpowers/plans/2026-05-07-omp-acp-implementation.md`
  - 更新 Stage 6 / 后续阶段中关于 `session/fork` 不声明的旧边界，避免长期计划与 capability matrix、实际 `initialize` 输出矛盾。

## 开放问题与决策

第一阶段直接决策如下：

1. **Fork 边界：** 从 source head fork，不支持 message-bound fork。
2. **Active prompt：** 明确拒绝，不做 best-effort clone。
3. **History clone：** 文件级 clone，保留未知 JSON fields；只改写明显 session id 字段。
4. **Response：** 只返回 `{ sessionId }`。
5. **Capability：** 只有完整 unit、smoke、registry-style validation 通过后才声明 `fork:{}`。

这些决策保证第一阶段可测试、可回滚，并且不把 OpenCode 私有 API 误当作 ACP 标准能力。

## 验收标准

- `session/fork` 有 runtime helper、ACP handler、server wiring 和 capability declaration。
- fork 后 session 文件存在，header 包含 `parentSession`，且消息历史顺序保留。
- fork 后 session 通过 `switch_session` 绑定 runtime，并能继续 prompt。
- active prompt fork 被明确拒绝。
- unknown source fork 返回明确 not found。
- `initialize` 声明 fork，仍不声明 close/MCP/permission/terminal/filesystem/usage/audio。
- `npm run check` 通过，并确认新增 `test/unit/acp/session-fork.test.ts` 已接入 `package.json` 的显式测试枚举。
- `npm run smoke:acp`、`npm run smoke:sdk-client`、`npm run validate:registry` 通过。
- `npm run validate:standard` 通过；它是除 Zed 外的聚合自动门禁。
- 如果 `npm run validate:acpx` 仍无 fork case，则结果不得被用来证明 fork 行为；fork 正确性以新增 unit/smoke/registry probe 为准。
