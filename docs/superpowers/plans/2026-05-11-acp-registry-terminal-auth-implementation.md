# ACP Registry Terminal Auth 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按 `docs/superpowers/specs/2026-05-11-acp-registry-auth-gap-design.md` 实现 Registry 可接受的 Terminal Auth 声明、`omp-acp --setup` 入口、auth/registry smoke 更新和文档同步。

**架构：** 保持 ACP server 默认无参 stdio 行为不变；新增 adapter 自身 CLI mode parser，在读取 stdin / 写 ACP stdout 前分流 `--setup`、`--help`、`--version`。ACP auth 声明集中在 initialize/auth handler；setup 检查复用 OMP RPC 只读 discovery 路径，不收集或打印 secret。

**技术栈：** Node.js 20 ESM、TypeScript、`@agentclientprotocol/sdk@0.21.0`、Node test runner、现有 OMP RPC fixture、现有 smoke 脚本。

---

## 文件职责

- 修改：`src/acp/handlers/initialize.ts`
  - 增加 `buildAuthMethods()` 和 `OMP_SETUP_AUTH_METHOD_ID`。
  - 根据 `clientCapabilities.auth.terminal` 或 `_meta["terminal-auth"]` 返回 Terminal Auth。
  - 默认仍不返回 `authMethods`。
- 修改：`src/acp/server.ts`
  - 将 `authenticate` 从全局 method-not-found 改为 known method 成功、unknown method invalid params。
- 创建：`src/cli/mode.ts`
  - 解析 adapter 自身 argv：ACP / setup / help / version。
  - 不处理 OMP runtime args；未知 adapter args 失败，避免静默改变协议行为。
- 创建：`src/cli/setup.ts`
  - 实现 `runSetupCli()`、help/version 文本和 setup 状态检查。
  - setup 模式允许向 stdout 输出人类可读文本；ACP 模式不调用它。
  - 通过 OMP RPC `get_state` / `get_available_models` 做只读检查。
- 修改：`src/index.ts`
  - 在创建 Web stdio stream 之前解析 CLI mode。
  - `--setup` / `--help` / `--version` 直接运行并 `process.exit()`；无参数进入现有 ACP server。
- 修改：`test/unit/acp/initialize.test.ts`
  - 覆盖默认无 auth、SDK terminal auth、Registry `_meta` terminal auth、terminal request-only 负向。
- 创建：`test/unit/acp/authenticate.test.ts`
  - 覆盖 `createOmpAcpAgent().authenticate()` known/unknown method 行为。
- 创建：`test/unit/cli/mode.test.ts`
  - 覆盖 CLI mode parser。
- 创建：`test/unit/cli/setup.test.ts`
  - 覆盖 setup 检查结果、退出码、输出边界和 secret redaction 边界。
- 修改：`test/smoke/acp-stdio.test.ts`
  - 覆盖 Registry-style `initialize.authMethods` 和 `authenticate` stdio 行为。
- 修改：`scripts/smoke-sdk-client.mjs`
  - 增加 terminal auth initialize request，默认 request 仍不返回 authMethods。
- 修改：`scripts/probe-registry-matrix.mjs`
  - Registry-style capability 下期望 `terminal` auth。
  - 增加负向 raw initialize：只有 `clientCapabilities.terminal` 不返回 authMethods。
- 修改：`scripts/smoke-acp.mjs`
  - 在 raw smoke 中断言默认 initialize 不返回 authMethods，Registry-style initialize 返回 terminal auth。
- 修改：`README.md`
  - 增加 setup / Terminal Auth / Registry readiness 文档。
- 修改：`docs/compatibility/acp-validation.md`
  - 更新 `validate:registry` auth 覆盖说明。
- 修改：`docs/release-checklist.md`
  - 增加 Registry Terminal Auth / setup 检查门禁。
- 创建：`docs/release-notes-v0.1.2.md`
  - 记录 Terminal Auth、setup 不收集 secret、Registry PR 状态仍以实际提交为准。

## 共享设计细节

### Terminal Auth 常量

`initialize.ts` 中定义并导出：

```ts
export const OMP_SETUP_AUTH_METHOD_ID = "omp-setup";

const OMP_SETUP_AUTH_METHOD = {
  id: OMP_SETUP_AUTH_METHOD_ID,
  type: "terminal" as const,
  name: "Set up Oh My Pi",
  description: "Open an interactive terminal guide to configure Oh My Pi credentials and models.",
  args: ["--setup"],
};
```

`buildAuthMethods(clientCapabilities)` 的返回规则：

```ts
const terminalAuthSupported =
  clientCapabilities?.auth?.terminal === true ||
  clientCapabilities?._meta?.["terminal-auth"] === true;
return terminalAuthSupported ? [OMP_SETUP_AUTH_METHOD] : undefined;
```

不要把 `clientCapabilities.terminal === true` 当作 auth support。

### Authenticate handler

建议在 `src/acp/handlers/authenticate.ts` 创建小 handler，或直接在 `server.ts` 中调用 helper。若创建 helper，签名为：

```ts
import { RequestError, type AuthenticateRequest, type AuthenticateResponse } from "@agentclientprotocol/sdk";
import { OMP_SETUP_AUTH_METHOD_ID } from "./initialize.ts";

export function handleAuthenticate(params: AuthenticateRequest): AuthenticateResponse {
  if (params.methodId === OMP_SETUP_AUTH_METHOD_ID) return {};
  throw RequestError.invalidParams(undefined, `Unsupported authentication method: ${params.methodId}`);
}
```

### CLI mode parser

`parseCliMode(argv: readonly string[])`：

- `[]` → `{ kind: "acp" }`
- `["--setup"]` → `{ kind: "setup" }`
- `["--help"]` / `["-h"]` → `{ kind: "help" }`
- `["--version"]` / `["-v"]` → `{ kind: "version" }`
- 其它任意 argv → `{ kind: "error", message: "Unknown omp-acp argument: ..." }`

`src/index.ts` 必须先调用 parser，再创建 `Writable.toWeb(process.stdout)` / `Readable.toWeb(process.stdin)`。错误 / help / version / setup 可以写 stdout/stderr；ACP mode 不能写人类文本。

### Setup checker

`runSetupCli(options)` 不直接读取 process 全局，便于测试。建议接口：

```ts
export type SetupCliIO = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type SetupCliOptions = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  io: SetupCliIO;
  startRuntime?: (options: { command: string; args: string[]; cwd: string; readyTimeoutMs?: number }) => SetupRuntime;
  readyTimeoutMs?: number;
};

export async function runSetupCli(options: SetupCliOptions): Promise<number>;
```

行为：

- 默认 executable 来自 `OMP_ACP_RUNTIME_COMMAND?.trim() || "omp"`。
- 不使用 `OMP_ACP_RUNTIME_ARGS_JSON`。
- 启动临时 RPC runtime：先构造不含 `undefined` 的 runtime options，再调用 `startRuntime(runtimeOptions)`。
- 等待 ready，随后请求 `get_state` 和 `get_available_models`。
- `get_available_models` 正常且模型数组非空 → stdout 打印检查通过和下一步 reload 提醒，返回 `0`。
- 启动失败 / ready 失败，且错误像 spawn ENOENT → stderr 打印 OMP 未找到、PATH / `OMP_ACP_RUNTIME_COMMAND` 建议，返回 `1`。
- 模型数组为空 → stdout 打印配置建议，返回 `2`。
- 任意路径都 close runtime。
- 输出不得包含环境变量值；只允许打印环境变量名和配置文件路径。

模型 normalization 可复用脚本中的逻辑：数组直接返回；对象中 `models` 数组返回 `models`；其它视为无模型。

### 测试命令惯例

目标测试命令示例：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/initialize.test.ts test/unit/acp/authenticate.test.ts test/unit/cli/mode.test.ts test/unit/cli/setup.test.ts
node --import tsx --test --test-concurrency=1 test/smoke/acp-stdio.test.ts
npm run smoke:acp
npm run smoke:sdk-client
npm run validate:registry
```

---

## 任务 1：ACP authMethods 与 authenticate handler

**文件：**
- 修改：`src/acp/handlers/initialize.ts`
- 修改：`src/acp/server.ts`
- 创建：`src/acp/handlers/authenticate.ts`（推荐）
- 测试：`test/unit/acp/initialize.test.ts`
- 测试：`test/unit/acp/authenticate.test.ts`
- 测试：`test/smoke/acp-stdio.test.ts`（不在本任务修改；统一由任务 2B 串行处理）

- [ ] **步骤 1：编写失败的 initialize 单元测试**

在 `test/unit/acp/initialize.test.ts` 现有测试后添加：

```ts
test("handleInitialize advertises terminal auth for SDK auth capability", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { auth: { terminal: true } },
  });

  assert.deepEqual(response.authMethods, [
    {
      id: "omp-setup",
      type: "terminal",
      name: "Set up Oh My Pi",
      description: "Open an interactive terminal guide to configure Oh My Pi credentials and models.",
      args: ["--setup"],
    },
  ]);
});

test("handleInitialize advertises terminal auth for Registry meta capability", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { terminal: true, _meta: { "terminal-auth": true } },
  });

  assert.equal(response.authMethods?.[0]?.type, "terminal");
  assert.equal(response.authMethods?.[0]?.id, "omp-setup");
});

test("handleInitialize does not treat terminal request support as terminal auth support", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { terminal: true },
  });

  assert.equal(response.authMethods, undefined);
});
```

保留现有 “without authMethods” 测试，确保默认仍无 auth。

- [ ] **步骤 2：运行 initialize 测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/initialize.test.ts
```

预期：新增 terminal auth 测试失败，默认测试仍通过；失败原因是 `authMethods` 为 `undefined`。

- [ ] **步骤 3：编写失败的 authenticate 单元测试**

创建 `test/unit/acp/authenticate.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { createOmpAcpAgent } from "../../../src/acp/server.ts";
import { SessionManager } from "../../../src/session/manager.ts";

function createAgent() {
  const manager = new SessionManager({
    runtimeFactory: () => {
      throw new Error("runtime factory should not be called by authenticate");
    },
  });
  const connection = {} as AgentSideConnection;
  return createOmpAcpAgent(connection, manager);
}

test("authenticate accepts the terminal setup method without starting runtime", async () => {
  const agent = createAgent();

  await assert.doesNotReject(async () => {
    assert.deepEqual(await agent.authenticate({ methodId: "omp-setup" }), {});
  });
});

test("authenticate rejects unknown methods", async () => {
  const agent = createAgent();

  await assert.rejects(
    () => agent.authenticate({ methodId: "unknown" }),
    /Unsupported authentication method: unknown/,
  );
});
```

- [ ] **步骤 4：运行 authenticate 测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/authenticate.test.ts
```

预期：`omp-setup` case 因当前 method-not-found 失败。

- [ ] **步骤 5：编写最少实现**

在 `src/acp/handlers/initialize.ts` 中：

```ts
import {
  PROTOCOL_VERSION,
  type AuthMethod,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";

export const OMP_SETUP_AUTH_METHOD_ID = "omp-setup";

const OMP_SETUP_AUTH_METHOD: AuthMethod = {
  id: OMP_SETUP_AUTH_METHOD_ID,
  type: "terminal",
  name: "Set up Oh My Pi",
  description: "Open an interactive terminal guide to configure Oh My Pi credentials and models.",
  args: ["--setup"],
};

export function buildAuthMethods(clientCapabilities: ClientCapabilities | undefined): AuthMethod[] | undefined {
  if (clientCapabilities?.auth?.terminal === true || clientCapabilities?._meta?.["terminal-auth"] === true) {
    return [OMP_SETUP_AUTH_METHOD];
  }
  return undefined;
}
```

并在 `handleInitialize()` 返回对象中仅当有 auth methods 时展开：

```ts
const authMethods = buildAuthMethods(_params.clientCapabilities);
return {
  protocolVersion: PROTOCOL_VERSION,
  agentInfo: buildAgentInfo(),
  ...(authMethods !== undefined ? { authMethods } : {}),
  agentCapabilities: buildInitialAgentCapabilities(),
};
```

创建 `src/acp/handlers/authenticate.ts`：

```ts
import { RequestError, type AuthenticateRequest, type AuthenticateResponse } from "@agentclientprotocol/sdk";
import { OMP_SETUP_AUTH_METHOD_ID } from "./initialize.ts";

export function handleAuthenticate(params: AuthenticateRequest): AuthenticateResponse {
  if (params.methodId === OMP_SETUP_AUTH_METHOD_ID) {
    return {};
  }
  throw RequestError.invalidParams(undefined, `Unsupported authentication method: ${params.methodId}`);
}
```

在 `src/acp/server.ts` 中导入并调用 `handleAuthenticate(params)`。

- [ ] **步骤 6：运行单元测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/initialize.test.ts test/unit/acp/authenticate.test.ts
```

预期：全部通过。



## 任务 2：adapter CLI mode 与 `omp-acp --setup`

**文件：**
- 创建：`src/cli/mode.ts`
- 创建：`src/cli/setup.ts`
- 修改：`src/index.ts`
- 测试：`test/unit/cli/mode.test.ts`
- 测试：`test/unit/cli/setup.test.ts`


- [ ] **步骤 1：编写失败的 CLI mode parser 测试**

创建 `test/unit/cli/mode.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseCliMode } from "../../../src/cli/mode.ts";

test("parseCliMode defaults to ACP mode", () => {
  assert.deepEqual(parseCliMode([]), { kind: "acp" });
});

test("parseCliMode recognizes setup help and version", () => {
  assert.deepEqual(parseCliMode(["--setup"]), { kind: "setup" });
  assert.deepEqual(parseCliMode(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliMode(["-h"]), { kind: "help" });
  assert.deepEqual(parseCliMode(["--version"]), { kind: "version" });
  assert.deepEqual(parseCliMode(["-v"]), { kind: "version" });
});

test("parseCliMode rejects unknown adapter arguments", () => {
  const mode = parseCliMode(["--model", "opus"]);
  assert.equal(mode.kind, "error");
  assert.match(mode.kind === "error" ? mode.message : "", /Unknown omp-acp argument: --model/);
});
```

- [ ] **步骤 2：运行 mode parser 测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/cli/mode.test.ts
```

预期：模块不存在失败。

- [ ] **步骤 3：实现 `src/cli/mode.ts`**

```ts
export type CliMode =
  | { kind: "acp" }
  | { kind: "setup" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export function parseCliMode(argv: readonly string[]): CliMode {
  if (argv.length === 0) return { kind: "acp" };
  if (argv.length === 1) {
    const [arg] = argv;
    if (arg === "--setup") return { kind: "setup" };
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
  }
  return { kind: "error", message: `Unknown omp-acp argument: ${argv.join(" ")}` };
}
```

- [ ] **步骤 4：运行 mode parser 测试验证通过**

运行同上，预期通过。

- [ ] **步骤 5：编写失败的 setup 测试**

创建 `test/unit/cli/setup.test.ts`。测试使用 fake runtime，不启动真实 OMP：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runSetupCli } from "../../../src/cli/setup.ts";

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function createRuntime(models: unknown[], options: { readyReject?: Error } = {}) {
  let closed = false;
  return {
    get closed() { return closed; },
    runtime: {
      ready: options.readyReject === undefined ? Promise.resolve() : Promise.reject(options.readyReject),
      request: async (method: string) => {
        if (method === "get_state") return { sessionId: "setup-test" };
        if (method === "get_available_models") return models;
        throw new Error(`unexpected method: ${method}`);
      },
      close: async () => { closed = true; },
    },
  };
}

test("runSetupCli exits 0 when OMP RPC is reachable and models are available", async () => {
  const io = createIo();
  const fixture = createRuntime([{ provider: "fixture", id: "model", name: "Fixture" }]);

  const exitCode = await runSetupCli({
    env: {},
    cwd: process.cwd(),
    io: io.io,
    startRuntime: () => fixture.runtime,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Oh My Pi setup/);
  assert.match(io.stdout, /models available/i);
  assert.equal(io.stderr, "");
  assert.equal(fixture.closed, true);
});

test("runSetupCli exits 2 when no models are available", async () => {
  const io = createIo();
  const fixture = createRuntime([]);

  const exitCode = await runSetupCli({ env: {}, cwd: process.cwd(), io: io.io, startRuntime: () => fixture.runtime });

  assert.equal(exitCode, 2);
  assert.match(io.stdout, /No available OMP models/i);
  assert.match(io.stdout, /ANTHROPIC_API_KEY/);
  assert.match(io.stdout, /OPENAI_API_KEY/);
  assert.match(io.stdout, /GEMINI_API_KEY/);
  assert.equal(fixture.closed, true);
});

test("runSetupCli exits 1 when OMP runtime cannot start", async () => {
  const io = createIo();
  const fixture = createRuntime([], { readyReject: Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }) });

  const exitCode = await runSetupCli({ env: {}, cwd: process.cwd(), io: io.io, startRuntime: () => fixture.runtime });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /Could not start OMP/);
  assert.match(io.stderr, /OMP_ACP_RUNTIME_COMMAND/);
  assert.equal(fixture.closed, true);
});

test("runSetupCli never prints environment secret values", async () => {
  const io = createIo();
  const fixture = createRuntime([]);

  await runSetupCli({
    env: { ANTHROPIC_API_KEY: "sk-ant-sensitive-value" },
    cwd: process.cwd(),
    io: io.io,
    startRuntime: () => fixture.runtime,
  });

  assert.equal(io.stdout.includes("sk-ant-sensitive-value"), false);
  assert.equal(io.stderr.includes("sk-ant-sensitive-value"), false);
});
```

- [ ] **步骤 6：运行 setup 测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/cli/setup.test.ts
```

预期：模块不存在失败。

- [ ] **步骤 7：实现 `src/cli/setup.ts`**

实现要点：

```ts
import { buildOmpRpcCommand } from "../runtime/omp/command.ts";
import { startOmpRpcClient } from "../runtime/omp/rpc-client.ts";

export type SetupRuntime = {
  ready: Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
};

export type SetupCliOptions = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  io: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } };
  startRuntime?: (options: { command: string; args: string[]; cwd: string; readyTimeoutMs?: number }) => SetupRuntime;
  readyTimeoutMs?: number;
};
```

`runSetupCli()`：

- 写 stdout 标题：`Oh My Pi setup for omp-acp`。
- `const command = options.env.OMP_ACP_RUNTIME_COMMAND?.trim() || "omp"`。
- `const runtimeCommand = buildOmpRpcCommand({ executable: command })`。
- 构造 runtime options 时避免传入 `undefined`：`const readyTimeoutMs = options.readyTimeoutMs ?? 10_000; const runtimeOptions = { command: runtimeCommand.command, args: runtimeCommand.args, cwd: options.cwd, ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}) }; const runtime = (options.startRuntime ?? startOmpRpcClient)(runtimeOptions)`。
- `try { await runtime.ready; await runtime.request("get_state"); const models = normalizeModels(await runtime.request("get_available_models")); ... } finally { await runtime.close().catch(() => {}) }`。
- `normalizeModels(value)` 支持数组和 `{ models: [] }`。
- 有模型：stdout 写 `OMP RPC is reachable`、`N models available`、`Restart or reload your ACP client after setup.`，返回 0。
- 无模型：stdout 写 `No available OMP models were found.`、环境变量名和 `~/.omp/agent/models.yml`，返回 2。
- ready / request 报错：stderr 写 `Could not start OMP for setup.`、`Ensure omp is on PATH or set OMP_ACP_RUNTIME_COMMAND.`，返回 1。

不要打印 `options.env` 的任何值。

- [ ] **步骤 8：运行 setup/mode 单元测试验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/cli/mode.test.ts test/unit/cli/setup.test.ts
```

预期：全部通过。

- [ ] **步骤 9：修改 `src/index.ts` 分流 CLI mode**

在文件顶部导入：

```ts
import { parseCliMode } from "./cli/mode.ts";
import { runSetupCli, writeHelp, writeVersion } from "./cli/setup.ts";
```

在创建 Web streams 前：

```ts
const cliMode = parseCliMode(process.argv.slice(2));

if (cliMode.kind === "help") {
  writeHelp(process.stdout);
  process.exit(0);
}
if (cliMode.kind === "version") {
  writeVersion(process.stdout);
  process.exit(0);
}
if (cliMode.kind === "setup") {
  process.exit(await runSetupCli({ env: process.env, cwd: process.cwd(), io: { stdout: process.stdout, stderr: process.stderr } }));
}
if (cliMode.kind === "error") {
  process.stderr.write(`${cliMode.message}\nRun omp-acp --help for usage.\n`);
  process.exit(2);
}
```

然后保留现有 ACP server 初始化逻辑不变。

- [ ] **步骤 10：运行 CLI 相关单元验证**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/cli/mode.test.ts test/unit/cli/setup.test.ts
npm run typecheck
```

预期：全部通过。`test/smoke/acp-stdio.test.ts` 的 CLI subprocess smoke 由任务 2B 串行统一添加，避免并发修改同一 smoke 文件。

## 任务 2B：stdio 集成 smoke 串行更新

**文件：**
- 修改：`test/smoke/acp-stdio.test.ts`

> 调度约束：本任务必须在任务 1 和任务 2 都完成后由单个子代理或主控串行执行。不要与任务 1/2 并行修改 `test/smoke/acp-stdio.test.ts`。

- [ ] **步骤 1：更新 authenticate stdio 测试**

将 `test/smoke/acp-stdio.test.ts` 的 `authenticate returns JSON-RPC method-not-found over stdio` 改为：

```ts
test("authenticate accepts setup method and rejects unknown methods over stdio", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({ jsonrpc: "2.0", id: 5, method: "authenticate", params: { methodId: "omp-setup" } });
    const accepted = await acp.nextResponse();
    assert.equal(accepted.id, 5);
    assert.deepEqual(accepted.result, {});
    assert.equal(accepted.error, undefined);

    acp.send({ jsonrpc: "2.0", id: 6, method: "authenticate", params: { methodId: "unknown" } });
    const rejected = await acp.nextResponse();
    assert.equal(rejected.id, 6);
    assert.equal(rejected.result, undefined);
    assert.equal(typeof rejected.error?.code, "number");
  });
});
```

- [ ] **步骤 2：添加 Registry-style initialize stdio 测试**

追加：

```ts
test("initialize advertises terminal auth only for auth-capable clients over stdio", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          terminal: true,
          fs: { readTextFile: true, writeTextFile: true },
          _meta: { "terminal-auth": true },
        },
      },
    });
    const response = await acp.nextResponse();
    const result = response.result as { authMethods?: Array<{ id?: string; type?: string; args?: string[] }> };
    assert.equal(response.error, undefined);
    assert.equal(result.authMethods?.[0]?.id, "omp-setup");
    assert.equal(result.authMethods?.[0]?.type, "terminal");
    assert.deepEqual(result.authMethods?.[0]?.args, ["--setup"]);
    assert.equal(acp.stderr, "");
  });
});
```

- [ ] **步骤 3：添加 CLI help/version subprocess smoke**

追加一个小 helper 收集子进程输出，避免只监听第一段 data：

```ts
async function runSubprocess(args: string[]) {
  const child = spawn(process.execPath, [...subprocessArgs, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, "close") as [number];
  return { code, stdout, stderr };
}
```

再添加：

```ts
test("help and version modes do not start ACP server", async () => {
  const help = await runSubprocess(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: omp-acp/);
  assert.equal(help.stderr, "");

  const version = await runSubprocess(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(version.stderr, "");
});
```

- [ ] **步骤 4：运行 stdio smoke 测试**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/smoke/acp-stdio.test.ts
```

预期：全部通过，且 ACP server 模式 stdout parser 不收到 help/version 人类文本。

## 任务 3：Registry / SDK / raw smoke 脚本更新

**文件：**
- 修改：`scripts/smoke-acp.mjs`
- 修改：`scripts/smoke-sdk-client.mjs`
- 修改：`scripts/probe-registry-matrix.mjs`

- [ ] **步骤 1：更新 `scripts/smoke-acp.mjs` 断言 auth 边界**

在默认 initialize 断言后加：

```js
assert.equal(initialize.result?.authMethods, undefined);
```

随后发送第二个 initialize request（同一进程允许重复 initialize；若 SDK/adapter 不允许，则在脚本中启动另一个 subprocess helper，优先先试同一进程）：

```js
acp.send({
  jsonrpc: "2.0",
  id: 10,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: { terminal: true, fs: { readTextFile: true, writeTextFile: true }, _meta: { "terminal-auth": true } },
  },
});
const registryInitialize = await acp.nextResponse(10);
assert.equal(registryInitialize.error, undefined);
assert.equal(registryInitialize.result?.authMethods?.[0]?.type, "terminal");
assert.equal(registryInitialize.result?.authMethods?.[0]?.id, "omp-setup");
```

- [ ] **步骤 2：运行 raw smoke 验证当前实现**

运行：

```bash
npm run build
npm run smoke:acp
```

预期：如果任务 1 已完成，应通过；如果在任务 1 前运行应因 authMethods 缺失失败。

- [ ] **步骤 3：更新 `scripts/smoke-sdk-client.mjs`**

保留默认 `clientCapabilities: {}` 的 `assert.equal(initialize.authMethods, undefined)`。

在默认 initialize 之后添加：

```js
const terminalAuthInitialize = await acp.request("initialize terminal auth", () => acp.connection.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: "omp-acp SDK smoke", version: "1.0.0" },
  clientCapabilities: { auth: { terminal: true } },
}));
assert.equal(terminalAuthInitialize.authMethods?.[0]?.id, "omp-setup");
assert.equal(terminalAuthInitialize.authMethods?.[0]?.type, "terminal");
assert.deepEqual(terminalAuthInitialize.authMethods?.[0]?.args, ["--setup"]);
```

如果 SDK connection 不允许第二次 initialize，则新增单独 helper `startSdkClient()` 第二实例执行该断言并 close；不要移除默认 initialize 边界。

- [ ] **步骤 4：运行 SDK smoke**

运行：

```bash
npm run build
npm run smoke:sdk-client
```

预期：通过。

- [ ] **步骤 5：更新 `scripts/probe-registry-matrix.mjs`**

将：

```js
assert.deepEqual(authTypes(initResult.authMethods), []);
```

改为：

```js
assert.deepEqual(authTypes(initResult.authMethods), ["terminal"]);
```

将 summary 中：

```js
authMethods: [],
```

改为：

```js
authMethods: authTypes(initResult.authMethods),
```

新增负向 auth probe。可以在主 initialize 之后、`session/new` 前启动第二个 subprocess，避免重复 initialize 状态问题：

```js
const terminalOnlyAcp = startAcpSubprocess(agentDir);
try {
  const terminalOnlyInitialize = await terminalOnlyAcp.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "ACP Registry terminal-only negative", version: "0.1.0" },
    clientCapabilities: { terminal: true },
  });
  assert.equal(terminalOnlyInitialize.outcome.status, "success");
  assert.deepEqual(authTypes(terminalOnlyInitialize.message.result.authMethods), []);
} finally {
  await terminalOnlyAcp.close().catch(() => {});
}
```

- [ ] **步骤 6：运行 Registry probe**

运行：

```bash
npm run build
npm run validate:registry
```

预期：通过，summary authMethods 为 `["terminal"]`。

## 任务 4：文档同步

**文件：**
- 修改：`README.md`
- 修改：`docs/compatibility/acp-validation.md`
- 修改：`docs/release-checklist.md`
- 创建：`docs/release-notes-v0.1.2.md`

- [ ] **步骤 1：更新 README**

在 `Installation` 或 `Zed / ZedG setup` 前后新增 English primary 内容：

```md
### Authentication setup

`omp-acp` does not collect provider API keys itself. It uses the local OMP configuration that the `omp` CLI already uses.

For clients or registry flows that support ACP Terminal Auth, the adapter advertises a setup entry:

```bash
npx -y omp-acp --setup
```

The setup command checks that `omp` can start in RPC mode and that OMP can discover at least one usable model. If no model is available, it prints configuration guidance such as setting provider environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) or configuring `~/.omp/agent/models.yml`. It does not ask for or store secrets.
```

在 `Supported ACP surface` Supported list 加：

```md
- `authMethods` Terminal Auth when the client explicitly supports ACP auth setup
- `authenticate` for the `omp-setup` Terminal Auth method
```

在 Unsupported list 或 Safety boundary 加：

```md
- Agent-managed OAuth Auth is not implemented; Terminal Auth is a setup/check guide, not an OAuth callback flow.
```

在中文概览中补一句：

```md
`omp-acp --setup` 只检查并引导 OMP 本地模型认证配置，不收集、不保存、不打印 provider API key。
```

- [ ] **步骤 2：更新 ACP validation 文档**

在 `docs/compatibility/acp-validation.md` 的 `validate:registry` 段落中，将“当前包没有实现 ACP auth flow”改为新的边界：

- `validate:registry` 现在检查 Registry-style terminal auth signal。
- 当前支持的是 Terminal Auth setup/check guide。
- 仍不是完整官方 Registry CI；Registry PR 还需要 registry repo 的 schema/icon/auth checker。

- [ ] **步骤 3：更新 release checklist**

在自动化门禁列表中增加：

```md
- [ ] 运行 `npx -y omp-acp@<version> --setup` 或本地 `node dist/index.js --setup`，确认 setup flow 不打印 secret，并记录退出码；如果当前机器无真实 OMP 或无模型，必须如实记录，不得把它当成真实 OMP 认证通过。
- [ ] 对 Registry-ready release，确认 `initialize` 在 Registry-style `_meta["terminal-auth"]` 下返回 Terminal Auth，且默认客户端不返回 `authMethods`。
```

同时保留 Zed GUI 未执行不得声称通过的边界。

- [ ] **步骤 4：新增下一版 release notes**

创建 `docs/release-notes-v0.1.2.md`，至少包含：

```md
# omp-acp v0.1.2 Release Notes

## Highlights

- Adds ACP Terminal Auth advertisement for clients and Registry checks that explicitly support terminal authentication setup.
- Adds `omp-acp --setup`, a terminal setup/check guide for local Oh My Pi credentials and models.
- The setup flow does not ask for, store, or print provider API keys, tokens, base URLs, or raw provider configuration.
- ACP Registry listing is still pending until the registry PR is prepared, validated, submitted, and merged.

## 中文摘要

- 新增 ACP Terminal Auth 设置入口，用于 Registry / 客户端支持的终端认证设置流程。
- `omp-acp --setup` 只检查并引导本地 OMP 模型认证配置，不收集、不保存、不打印 provider API key。
- 是否已进入官方 ACP Registry，以后续 registry PR 合并状态为准。
```

- [ ] **步骤 5：运行文档验证**

运行：

```bash
git diff --check -- README.md docs/compatibility/acp-validation.md docs/release-checklist.md docs/release-notes-v0.1.2.md
```

预期：无 whitespace error。不要在文档子代理中运行 `npm run check`；完整测试由最终集成任务执行，避免与并发代码任务的红灯阶段互相干扰。

## 任务 4B：Registry manifest 草案准备（不提交到本仓库）

**文件：**
- 输出草案内容到实现总结或临时说明，不在本仓库创建 `agentclientprotocol/registry` 目录。

> 调度约束：本任务在代码、脚本和文档任务完成后执行。它只准备可复制到 Registry fork 的草案，不改变本仓库源代码；Registry PR 仍必须在 `agentclientprotocol/registry` fork 中验证和提交。

- [ ] **步骤 1：准备 `agent.json` 草案**

使用下一版已发布版本替换示例中的 `0.1.2`；如果尚未发布，只能标记为草案，不得声称可直接提交：

```json
{
  "id": "omp-acp",
  "name": "Oh My Pi",
  "version": "0.1.2",
  "description": "ACP adapter for the Oh My Pi coding agent.",
  "repository": "https://github.com/jiwangyihao/omp-acp",
  "website": "https://github.com/jiwangyihao/omp-acp#readme",
  "authors": ["jiwangyihao"],
  "license": "MPL-2.0",
  "distribution": {
    "npx": {
      "package": "omp-acp@0.1.2"
    }
  }
}
```

- [ ] **步骤 2：准备 16x16 monochrome `icon.svg` 草案**

示例必须只使用 `currentColor` 或 `none`，不能写硬编码颜色：

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
  <path fill="currentColor" d="M8 1.25 13.85 4.6v6.8L8 14.75 2.15 11.4V4.6L8 1.25Zm0 1.85L3.75 5.55v4.9L8 12.9l4.25-2.45v-4.9L8 3.1Z"/>
  <path fill="currentColor" d="M8 5.1a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Zm0 1.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/>
</svg>
```

- [ ] **步骤 3：记录 Registry fork 验证命令**

在实现总结中记录后续需要在 Registry fork 运行：

```bash
uv run --with jsonschema .github/workflows/build_registry.py
python3 .github/workflows/verify_agents.py --auth-check --agent omp-acp
```

预期：schema/icon/auth checker 均通过后，才能提交 Registry PR。

## 任务 5：最终集成验证（仅主控执行）

**文件：**
- 所有上述变更。

- [ ] **步骤 1：运行目标测试组合**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/initialize.test.ts test/unit/acp/authenticate.test.ts test/unit/cli/mode.test.ts test/unit/cli/setup.test.ts test/smoke/acp-stdio.test.ts
```

预期：全部通过。

- [ ] **步骤 2：运行完整自动化验证**

运行：

```bash
npm run typecheck
npm run check
npm run build
npm run smoke:acp
npm run smoke:sdk-client
npm run validate:registry
npm run validate:acpx
npm run smoke:omp-rpc-controls:required
```

预期：所有命令 exit 0。`validate:acpx` 允许 expected draft failures，但不得有 unexpected failure。`smoke:omp-rpc-controls:required` 必须满足真实 OMP gate；如果 active tools 已无 `ask`，允许记录 already-absent skip。

- [ ] **步骤 3：运行 setup 手工命令**

运行：

```bash
node dist/index.js --setup
```

预期：命令输出 setup 检查结果，不输出 secret。若当前环境真实 OMP 无模型，允许 exit 2，但必须记录；若命令 exit 1，需要判断是否真实 OMP 不可用。对于实现提交，单元测试已覆盖 fixture 路径；release 前仍需真实环境通过或如实记录。

- [ ] **步骤 4：审查 diff**

运行：

```bash
git diff --check
git status --short --branch
```

确认只有本计划范围内文件变更。

- [ ] **步骤 5：主控提交**

本步骤仅由主控在所有实现任务完成、3 个以上只读 review 子代理通过、完整验证通过后执行；不要分派给并发实现子代理。

提交信息：

```bash
git add src/acp/handlers/initialize.ts src/acp/handlers/authenticate.ts src/acp/server.ts src/cli/mode.ts src/cli/setup.ts src/index.ts test/unit/acp/initialize.test.ts test/unit/acp/authenticate.test.ts test/unit/cli/mode.test.ts test/unit/cli/setup.test.ts test/smoke/acp-stdio.test.ts scripts/smoke-acp.mjs scripts/smoke-sdk-client.mjs scripts/probe-registry-matrix.mjs README.md docs/compatibility/acp-validation.md docs/release-checklist.md docs/release-notes-v0.1.2.md docs/superpowers/plans/2026-05-11-acp-registry-terminal-auth-implementation.md
git commit -m "feat(registry): 新增 Terminal Auth 设置入口"
```

预期：提交成功。
