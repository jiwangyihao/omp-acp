# ACP stdio transport 与 initialize 设计规格

> 本规格对应总体计划中的「阶段 1：ACP stdio transport 与 initialize」。阶段 1 只交付 ACP 外壳、协议握手和能力声明，不启动 OMP，不处理真实 prompt，不声明未实现能力。

## 目标

让 `omp-acp` 可以作为 ACP subprocess 被编辑器启动，并通过 JSON-RPC over stdio 完成 `initialize` 握手。该阶段的产物是后续 OMP RPC client 和 session 层的稳定协议入口，不是可发布的完整 ACP agent。

## 非目标

- 不启动 `omp --mode rpc`。
- 不创建真实 OMP session。
- 不处理真实 `session/prompt`。
- 不实现 MCP、terminal delegation、filesystem delegation、permission request、session list/load/fork/resume/close。
- 不从 `pi-acp` 复制 runtime 语义。
- 不移除 `package.json` 中的 `private: true`。

## 背景与约束

- 当前仓库已安装 `@agentclientprotocol/sdk@0.12.0`。
- SDK 提供 `AgentSideConnection`、`ndJsonStream`、`PROTOCOL_VERSION`、`RequestError` 和 ACP schema 类型。
- SDK 的 `Agent` 接口要求实现 `initialize`、`newSession`、`authenticate`、`prompt`、`cancel`；可选接口成员为 `loadSession?`、`unstable_listSessions?`、`unstable_forkSession?`、`unstable_resumeSession?`，它们分别由 SDK 分发协议方法 `session/load`、`session/list`、`session/fork`、`session/resume`。
- ACP schema 规定 baseline agent 应支持 `session/new`、`session/prompt`、`session/cancel` 和 `session/update`。阶段 1 只是内部里程碑，因此这些方法只提供明确的「尚不可用」错误保护；项目在阶段 3 前不得声称 ACP agent 可用。
- stdout 必须只输出 JSON-RPC / NDJSON frame。所有日志、诊断、异常说明只能写入 stderr 或测试断言中。
- 阶段 1 在当前 `omp-acp` 仓库工作区和主分支上实现。禁止创建 git worktree、禁止创建实现分支，除非用户在后续对话中显式改变该约束。
- 阶段 1 实现前必须验证本地依赖可从 `@agentclientprotocol/sdk` 导入 `AgentSideConnection`、`ndJsonStream`、`PROTOCOL_VERSION`、`RequestError` 和所需 schema 类型。若 SDK runtime 或 types 不可导入，必须先修正依赖或更新本规格并重新审查；不得临时退回手写 JSON-RPC transport。

## 方案比较

### 方案 A：完全手写 JSON-RPC transport

手写 stdin line reader、JSON parser、request dispatcher、schema validation 和 response encoder。

优点：

- 控制力最高。
- 可以完全按项目想要的错误边界组织代码。

缺点：

- 容易重复 SDK 已有功能。
- schema 校验和错误码更容易偏离 ACP。
- 第一阶段会消耗在协议基础设施上，无法尽快进入 OMP RPC contract。

### 方案 B：直接使用 SDK 的 `AgentSideConnection` 和 `ndJsonStream`

用 SDK 负责 JSON-RPC framing、incoming request schema validation、method dispatch 和标准错误封装。项目只实现 `OmpAcpAgent`，并在 `initialize` 中返回 truthful capabilities；response shape 由 TypeScript 类型、单元测试和 smoke test 共同约束。

优点：

- 遵循 ACP SDK 的 schema 和错误行为。
- 代码量小，阶段边界清楚。
- smoke test 可以直接验证与 SDK client 的互通。

缺点：

- 必须满足 SDK `Agent` 接口，即使阶段 1 尚不支持真实 session。
- 某些底层解析错误由 SDK 控制，项目只验证外部行为。

### 方案 C：包装 SDK，但在外层增加自定义 NDJSON pre-parser

项目先解析 stdin，再交给 SDK。

优点：

- 可以提前加入自定义诊断和 transcript logging。

缺点：

- 重复 framing 逻辑，容易污染 stdout。
- 第一阶段没有必要引入双层解析。

### 推荐方案

采用方案 B。阶段 1 的目标是建立最小、正确、可测试的 ACP 入口；自定义 transport 和 transcript diagnostics 留到发现 SDK 行为不足时再加。当前没有证据表明需要绕开 SDK。

## 设计

### 入口：`src/index.ts`

`src/index.ts` 是 CLI 入口。它负责：

1. 将 `process.stdout` 转为 Web `WritableStream`，命名为 `stdoutWritable`。
2. 将 `process.stdin` 转为 Web `ReadableStream`，命名为 `stdinReadable`。
3. 调用 `createStdioAcpStream(stdoutWritable, stdinReadable)` 创建 ACP stream。
4. 调用 `startAcpServer({ stream })` 创建 `AgentSideConnection`。
5. 等待 `connection.closed`，避免进程在 stdin 打开时提前退出。

入口不得在 stdout 写任何 banner、日志或调试信息。

### Stdio transport 薄封装：`src/acp/transport/stdio.ts`

`stdio.ts` 只负责把已经转成 Web stream 的 output/input 交给 SDK：

```ts
export function createStdioAcpStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream;
```

实现必须调用 SDK `ndJsonStream(output, input)`。本模块不得解析 JSON、不得分发 method、不得自定义 JSON-RPC 错误响应、不得写日志。这样既保留总体计划中的 transport 文件边界，也避免重复实现 SDK framing。


### Agent 组合根：`src/acp/server.ts`

`server.ts` 暴露：

```ts
export interface StartAcpServerOptions {
  stream: Stream;
}

export function startAcpServer(options: StartAcpServerOptions): AgentSideConnection;
export function createOmpAcpAgent(connection: AgentSideConnection): Agent;
```

`startAcpServer` 只接受已经创建好的 ACP `Stream`，不直接读取 `process.stdin`，也不直接写入 `process.stdout`。`src/index.ts` 负责把 process stream 适配成 Web stream，并通过 `createStdioAcpStream` 生成 `Stream` 后传入 `startAcpServer`。diagnostics 不属于该接口；如需输出，只能由调用方写入 stderr，不能通过 ACP output stream 输出。

阶段 1 中，`createOmpAcpAgent` 创建一个最小 agent：

- `initialize`：返回协议版本、agent info、最小 capability set。
- `newSession`：抛出明确错误，表示阶段 1 尚未接入 session manager。
- `authenticate`：阶段 1 不声明 `authMethods`，因此任何 `authenticate` 请求都必须返回 JSON-RPC error。不得返回 `{}`、`undefined` 或任何成功结果。
- `prompt`：抛出明确错误，表示尚未接入 OMP runtime。
- `cancel`：安全 no-op 或明确记录到 stderr；因为没有 active prompt，不能抛出会导致连接崩溃的异常。

`newSession`、`authenticate` 和 `prompt` 的错误必须是 JSON-RPC error，不得返回成功结果。

### 能力声明：`src/acp/capabilities.ts`

`capabilities.ts` 暴露：

```ts
export function buildInitialAgentCapabilities(): AgentCapabilities;
export function buildAgentInfo(): Implementation;
```

阶段 1 的 `AgentCapabilities` 必须显式返回保守 false 值：

```ts
{
  loadSession: false,
  promptCapabilities: {
    image: false,
    audio: false,
    embeddedContext: false
  },
  mcpCapabilities: {
    http: false,
    sse: false
  }
}
```

不要声明：

- `sessionCapabilities.list`
- `sessionCapabilities.fork`
- `sessionCapabilities.resume`
- session close（当前 SDK schema 没有在 `SessionCapabilities` 中观察到 close 字段）
- model / mode / config option
- permission request
- terminal / filesystem delegation

若未来升级 SDK 导致这些字段类型变化，必须先更新本规格和测试，再修改实现。核心要求是不得把未实现能力声明为可用。

### `initialize` handler：`src/acp/handlers/initialize.ts`

`initialize` handler 接收 `InitializeRequest`，返回 `InitializeResponse`。

行为：

- `protocolVersion` 返回 SDK 导出的 `PROTOCOL_VERSION`（当前观察为 `1`）。测试同时断言该值与客户端使用的版本一致。
- `agentInfo.name` 使用 `omp-acp`。
- `agentInfo.version` 从 `package.json` 读取，避免手写漂移。
- `agentCapabilities` 由 `buildInitialAgentCapabilities()` 生成。
- 不返回 `authMethods`，因为阶段 1 不实现认证。
- `_meta` 不写入业务语义。

### 错误边界

阶段 1 的错误策略：

| 场景 | 行为 |
|---|---|
| 未知 request method | SDK 返回 JSON-RPC `-32601 Method not found` |
| 未知 notification method | SDK 返回或记录 method-not-found，不中断进程 |
| malformed JSON | SDK `ndJsonStream` 记录 parse failure 到 stderr、stdout 不输出非 JSON-RPC 内容、连接保持可用；测试必须在 malformed line 后继续发送合法 `initialize` 并收到响应 |
| `session/new` | JSON-RPC error，说明 session 尚未实现 |
| `session/prompt` | JSON-RPC error，说明 prompt 尚未实现 |
| `session/cancel` 且无 active prompt | no-op，不写 stdout |
| handler 抛出未预期异常 | JSON-RPC internal error；stderr 可记录 diagnostics |

### TDD 红灯顺序

阶段 1 实现必须按以下顺序先写失败测试，再写最少实现：

1. `buildInitialAgentCapabilities` 不声明未实现能力，尤其 MCP、session list/load/fork/resume、filesystem、terminal、image、embedded context。
2. `buildAgentInfo` 从 `package.json` 读取 `name` 和 `version`。
3. `initialize` 返回 SDK `PROTOCOL_VERSION`、`agentInfo.name === "omp-acp"`、不返回 `authMethods`、capabilities 来自 builder。
4. stdio initialize smoke 使用真实 subprocess，断言 response id、无 error、stdout 每行都是 JSON-RPC、stderr 无常规启动日志。
5. unknown method negative smoke 返回同 id 的 `-32601 Method not found`。
6. `session/new` guard negative smoke 返回 JSON-RPC error。
7. `session/prompt` guard negative smoke 返回 JSON-RPC error。
8. `authenticate` guard negative smoke 返回 JSON-RPC error。
9. malformed JSON smoke 断言 stdout 不污染，且连接在随后合法 `initialize` 后仍可用。

### 测试设计

#### 单元测试：`test/unit/acp/initialize.test.ts`

覆盖：

- `buildInitialAgentCapabilities()` 不声明未实现能力。
- `buildAgentInfo()` 从 `package.json` 读取 `name` 和 `version`。
- `initialize` 返回 SDK 导出的 `PROTOCOL_VERSION`，并与测试客户端使用的版本一致。
- `initialize` 不返回 `authMethods`。
- capability matrix 中阶段 1 仍未实现的能力不会在 `initialize` 响应中声明为 true。

#### Smoke test：`test/smoke/acp-stdio.test.ts`

使用真实 subprocess 启动：

```bash
node --import tsx src/index.ts
```

测试通过 stdin 写入一行 NDJSON request：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
```

期望 stdout 返回一行 JSON-RPC response：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"omp-acp","version":"0.0.0"},"agentCapabilities":{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":false,"sse":false}}}}
```

断言：

- stdout 每一行都能被解析为 JSON。
- response `id` 与 request `id` 一致。
- response 没有 `error`。
- stderr 没有常规启动日志。
- 子进程可通过关闭 stdin 或 kill 正常结束。

#### 负向 smoke

至少覆盖：

- 发送未知 method，收到同 `id` 的 JSON-RPC `-32601 Method not found` error。
- 发送 malformed JSON，stdout 不输出非 JSON-RPC 内容；随后发送合法 `initialize`，连接仍能返回合法响应。
- 发送 `session/new`，收到 JSON-RPC error，而不是伪造成功 session。
- 发送 `session/prompt`，收到 JSON-RPC error，而不是伪造成功 turn。
- 发送 `authenticate`，收到 JSON-RPC error，而不是伪造成功认证。

## 数据流

```text
Zed / test client
  -> stdin NDJSON request
  -> createStdioAcpStream
  -> AgentSideConnection
  -> OmpAcpAgent.initialize
  -> buildInitialAgentCapabilities
  -> stdout NDJSON response
```

阶段 1 没有 runtime data flow：不会创建 OMP process，也不会读取 OMP config。

## 文档更新

阶段 1 完成时需要同步更新：

- `docs/compatibility/capability-matrix.md`：把 ACP stdio transport 和 `initialize` 标为已实现。
- `README.md`：增加本地开发启动和 smoke test 命令，但继续说明项目尚不可发布。

不得添加 `npx -y omp-acp` 安装指令，因为 package 尚未发布。

## 验收标准

- `npm run check` 通过。
- `node --import tsx src/index.ts` 可作为 ACP subprocess 启动。
- stdio smoke test 发送 `initialize` 后收到合法 JSON-RPC response。
- stdout 没有任何非 JSON-RPC 内容。
- `initialize` 不声明 MCP、session list/load/fork/resume、filesystem、terminal、image、embedded context 等未实现能力。
- 未知 method 和未实现 session method 不会静默成功。
- `docs/compatibility/capability-matrix.md` 与实际 `initialize` 输出一致。

## 后续衔接
本规格经审查修正并通过后，阶段 1 可直接进入 TDD 实现；实现者不得再扩展阶段 1 范围。如审查发现 Critical/Important 问题，必须先更新本规格，再进入实现。

阶段 1 完成后，阶段 2 可以独立实现 OMP RPC client。阶段 3 再把 `OmpAcpAgent.newSession`、`prompt` 和 `cancel` 从 guard handler 切换到真实 session manager。切换前必须先写 session 层测试，不能直接把 guard handler 改成半实现。