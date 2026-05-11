# ACP Registry 认证差距补齐设计规格

## 背景

`omp-acp` 已发布为 `omp-acp@0.1.1`，并且当前 README、release notes、npm 包和 GitHub Release 已具备公开使用的基础。项目现在仍未达到 public ACP Registry 的收录门槛：ACP Registry 不只是检查包是否能启动和完成基础 `initialize` / `session/new`，还会检查 agent 是否在 ACP handshake 中返回 Registry 接受的 `authMethods`。

当前实现保持了较保守且真实的边界：`src/acp/handlers/initialize.ts` 不返回 `authMethods`；`src/acp/server.ts` 的 `authenticate` 返回 JSON-RPC `method_not_found`。这与现有能力矩阵一致，但会被 Registry auth checker 判定为不合格。

本规格定义补齐 Registry 差距的最小可防御方案。重点是让 ACP handshake 真实表达 `omp-acp` 的认证入口，而不是为了通过 CI 伪造 OAuth 或暴露 provider secrets。

## 当前事实

### 当前仓库事实

- 包名：`omp-acp`。
- 当前版本：`0.1.1`。
- 入口：`dist/index.js`，`package.json` 的 `bin` 暴露 `omp-acp`。
- 当前 ACP server：`src/acp/server.ts`。
- 当前 initialize handler：`src/acp/handlers/initialize.ts`。
- 当前默认 OMP runtime 命令：`omp --mode rpc --extension <disable-ask-extension>`。
- 当前 `validate:registry` 是本仓库的 registry-style protocol matrix 探测，不等同于官方 `agentclientprotocol/registry` CI。
- 当前测试显式断言：
  - `handleInitialize` 不返回 `authMethods`。
  - stdio `authenticate` 返回 JSON-RPC method-not-found。
  - `scripts/probe-registry-matrix.mjs` 期望 `authMethods` 为空。
  - `scripts/smoke-sdk-client.mjs` 期望 `initialize.authMethods === undefined`。

### Registry 要求

来自 `agentclientprotocol/registry` 当前文档与 CI 逻辑：

- Registry 维护的是支持用户认证的 agent 列表。
- agent 必须至少支持一种 Registry 接受的认证方法：Agent Auth 或 Terminal Auth。
- Registry 当前不接受只有 Environment Variable Auth 的 agent。
- auth checker 会启动 agent distribution，发送 `initialize`，并检查 response 中 `authMethods` 至少包含一个 `type: "agent"` 或 `type: "terminal"` 的方法。
- auth checker 同时验证 stdout 只能输出 ACP JSON-RPC / NDJSON frame。
- Registry entry 还需要：
  - `<id>/agent.json`；
  - `<id>/icon.svg`；
  - icon 为 16x16 SVG，使用 `currentColor` / `none` / `inherit`，不能写硬编码颜色；
  - distribution 需至少包含 `binary`、`npx` 或 `uvx` 之一；
  - npm package 版本必须精确匹配 entry version，不能使用 `latest`。

### ACP SDK 0.21.0 类型事实

`@agentclientprotocol/sdk@0.21.0` 的 `InitializeResponse` 支持：

```ts
authMethods?: Array<AuthMethod>;
```

`AuthMethod` 包括：

- Agent Auth：`{ id, name, description? }`，`type` 缺省时按 `agent` 处理；
- Terminal Auth：`{ type: "terminal", id, name, description?, args?, env? }`；
- Env Var Auth：`{ type: "env_var", id, name, vars, link? }`。

Terminal Auth 在 RFD 中要求客户端通过 `clientCapabilities.auth.terminal === true` opt in；Registry auth checker 目前用 `_meta.terminal-auth` 表示终端认证能力。实现需要兼容二者，不能只看单一路径。

### OMP 认证事实

当前 Oh My Pi CLI 没有观察到独立的 `login` 命令。其模型认证主要来自：

- 环境变量，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等；
- `~/.omp/agent/models.yml` 等模型配置文件；
- OMP 自身已有的 OAuth / provider auth storage；
- `--api-key` 运行时覆盖，但该方式不持久化，且需要指定模型。

OMP 已有 `setup` 子命令，但当前 `omp setup` 仅用于安装可选组件（如 `python`、`stt`），不是 provider 登录或模型凭据配置入口。因此不能把 `omp setup` 直接声明为 `omp-acp` 的 Registry Terminal Auth，除非后续确认 OMP 上游扩展了真实登录/setup 流程。

## 目标

- 让 `omp-acp` 具备可被 ACP Registry 接受的真实认证声明。
- 首选 Terminal Auth：提供 `omp-acp --setup` 之类的 terminal setup 入口，用于检查并引导用户完成 OMP 模型认证配置。
- 保持 ACP stdio 模式 stdout 纯净：非 ACP JSON-RPC 内容只能出现在 setup terminal 流程，不能在标准 ACP server 模式输出。
- 保持能力声明真实：不声明未实现 OAuth Agent Auth；不声明无法由 client 独立完成的 env-var-only auth 作为 Registry 通过路径。
- 让本仓库 `validate:registry` 与官方 Registry auth checker 的关键要求对齐，避免本地通过但 Registry PR 失败。
- 在准备 Registry PR 前提供 `agent.json` 和 `icon.svg` 的可验证草案。

## 非目标

- 不实现 OAuth Agent Auth，不启动本地 OAuth callback server。
- 不让 `omp-acp` 持有、打印、收集、持久化或转发 provider secret、token、base URL、raw provider config。
- 不把 OMP provider / model / sampling knob 暴露进 ACP session controls。
- 不新增 ACP MCP、terminal delegation、filesystem delegation、session/close 或 elicitation 能力。
- 不改变 OMP 本体认证存储格式。
- 不把 Registry entry 合入本仓库后就声称已被官方 Registry 收录；收录必须以 `agentclientprotocol/registry` PR 合并为准。
- 不用 env-var-only auth 作为 Registry 合格路径；可作为文档补充，但不能替代 Agent Auth / Terminal Auth。

## 方案比较

### 方案 A：声明 Agent Auth，`authenticate` 返回空成功

在 `initialize.authMethods` 中声明 `{ id: "agent", name: "Agent-managed authentication" }`，并让 `authenticate` 返回 `{}`。

优点：

- 实现代码最少。
- 很可能通过 Registry 当前仅检查 `initialize.authMethods` 的 auth checker。

缺点：

- 语义不真实。`omp-acp` 没有实现自主管理的 OAuth / browser / local callback 认证流程。
- 用户点击认证后没有实际动作，会误导客户端和用户。
- 与项目一贯的 truthful capability 原则冲突。

结论：拒绝。

### 方案 B：只声明 Env Var Auth

在 `initialize.authMethods` 中声明 OpenAI / Anthropic / Gemini 等环境变量。

优点：

- 接近 OMP 当前模型凭据来源。
- 能给支持 env-var UI 的 ACP client 提供提示。

缺点：

- Registry 当前不接受 env-var-only auth。
- OMP 支持的 provider 与用户配置可能动态变化；静态列出容易泄漏或误导。
- 需要处理多个 provider、custom models、OAuth 与本地模型，范围变大。

结论：不作为 Registry gap 的首选方案。未来可以单独设计为附加提示，但不能阻塞当前 Registry 路径。

### 方案 C：实现 `omp-acp --setup` 并声明 Terminal Auth

`omp-acp` 标准无参启动仍是 ACP server。新增 terminal setup mode，例如：

```bash
omp-acp --setup
```

该模式不启动 ACP JSON-RPC server，而是在终端中执行可读的检查和引导：

1. 检查 `omp` 是否在 PATH，或提示用户通过 `OMP_ACP_RUNTIME_COMMAND` / 系统 PATH 修正；
2. 使用已确认存在的只读模型发现入口判断当前是否存在可用模型；若 OMP 暂无可依赖的顶层 CLI 命令，则通过 OMP RPC `get_available_models` / `get_state` 做检查；
3. 如果无可用模型，输出 OMP 当前支持的认证配置入口：设置 provider API key 环境变量，或创建 / 编辑 OMP 模型配置文件；
4. 不要求用户在 `omp-acp` 内输入 secret；不把 secret 写入 adapter 自己的文件；
5. 返回明确退出码：检查通过为 0；缺少 OMP 或无可用模型为非 0，除非用户只请求帮助文本。

ACP handshake 仅在客户端支持 terminal auth 时声明：

```json
{
  "id": "omp-setup",
  "type": "terminal",
  "name": "Set up Oh My Pi",
  "description": "Open an interactive terminal guide to configure Oh My Pi credentials and models.",
  "args": ["--setup"]
}
```

优点：

- 符合 Registry 接受的 Terminal Auth。
- 不伪造 OAuth，不接触 provider secret。
- 与 `omp-acp` 作为 adapter 的职责匹配：adapter 引导用户准备底层 `omp`，而不是重写 OMP 登录系统。
- 可以保持 ACP server stdout 纯净，因为 setup mode 是独立 terminal flow。

缺点：

- 需要新增 CLI mode 和测试。
- Terminal Auth 的 `args` 在 ACP RFD 与 Registry 文档中有“追加到默认 args”与“替换默认 args”的表述差异；本仓库需要实测 Zed / Registry 现有行为并在文档中保守描述。
- `omp-acp --setup` 本身只是引导和检查，不等于替用户完成所有 provider 登录。

结论：采用。

### 方案 D：等待 OMP 上游实现真实 `omp login`

不在 adapter 中做 setup flow，等待上游提供统一 login command 后再接入。

优点：

- 长期语义最干净。
- 避免 adapter 维护 provider 引导文案。

缺点：

- 无法解决当前 Registry gap。
- 上游时间表不可控。

结论：不作为当前路径。若 OMP 后续新增 `omp login` / `omp auth`，可把 `omp-acp --setup` 改为委托上游命令。

## 推荐设计

采用方案 C：`omp-acp --setup` + Terminal Auth。

### 1. CLI 模式拆分

`src/index.ts` 当前无条件创建 stdio ACP stream。需要在读取 stdio 前解析最小 adapter 自身参数：

- `--setup`：进入 terminal setup mode；
- `--help` / `-h`：输出 adapter 自身帮助；
- `--version` / `-v`：输出 `package.json` 版本；
- 无参数：保持现有 ACP stdio server 行为。

约束：

- 只有 setup/help/version 模式可以向 stdout 写人类可读文本。
- ACP server 模式仍不得写 banner、日志或帮助文本。
- 未知参数在 ACP server 模式下不应被静默当作 runtime 参数；如果未来需要支持 adapter 自身参数，应先设计。Registry `npx` distribution 应不传额外 args。

建议拆分：

```ts
export type CliMode =
  | { kind: "acp" }
  | { kind: "setup" }
  | { kind: "help" }
  | { kind: "version" };
```

并把 setup 实现放入独立模块，例如 `src/cli/setup.ts` 或 `src/setup.ts`，避免污染 ACP server 组合根。

### 2. Terminal setup 行为

`omp-acp --setup` 的职责是“验证并引导 OMP 认证状态”，不是“收集 secret”。

最小流程：

1. 打印 `omp-acp` 与 OMP runtime 关系说明。
2. 解析 runtime command：
   - 默认使用 `omp`；
   - 如果用户设置 `OMP_ACP_RUNTIME_COMMAND`，使用该 executable 做检查；
   - 不使用 `OMP_ACP_RUNTIME_ARGS_JSON` 作为 setup 入口，因为它是 ACP runtime fixture / advanced override，不一定能用于人类 terminal setup。
3. 检查命令是否可启动：
   - 可通过 child process 调用 `omp --version` 或 `omp --help`；
   - 失败时给出 PATH / `OMP_ACP_RUNTIME_COMMAND` 修复建议。
4. 检查模型可用性：
   - 首选复用 OMP RPC 的只读 discovery / state 路径，例如启动临时 `--mode rpc` 并请求 `get_available_models` / `get_state`；
   - 只有在当前 OMP 版本确认提供稳定 CLI 时，才可使用 `omp --list-models` 或等效只读命令；
   - 解析策略以结构化 RPC response 或退出码为主，输出文本只用于用户说明；
   - 若命令返回无模型或失败，提示用户配置 OMP 模型凭据。
5. 给出配置路径和方式：
   - 设置 provider 环境变量，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`；
   - 或按 OMP 文档创建 / 编辑 `~/.omp/agent/models.yml`；
   - 若用户使用 OAuth / provider auth storage，提示在 OMP TUI 中完成对应 provider 登录（如果当前 OMP 版本支持）。
6. 最终打印下一步：回到 ACP client，重新启动 / reload `omp-acp` agent。

退出码：

- OMP 可启动且发现可用模型：`0`。
- OMP 不可启动：`1`。
- OMP 可启动但没有可用模型：`2`。
- setup 命令内部异常：`1`。

安全边界：

- 不提示用户把 API key 输入给 `omp-acp`。
- 不把环境变量值打印到 stdout / stderr。
- 不读取或打印 real OMP session history。
- 不写 adapter 自己的 credential file。
- 如果需要显示配置文件路径，只显示路径，不显示文件内容。

### 3. `initialize.authMethods` 声明

新增 builder，例如：

```ts
export function buildAuthMethods(clientCapabilities: InitializeRequest["clientCapabilities"]): AuthMethod[] | undefined;
```

规则：

- 仅当客户端明确支持 terminal auth 时返回 Terminal Auth；否则返回 `undefined`。
- 支持信号：
  - `clientCapabilities.auth?.terminal === true`；
  - `clientCapabilities._meta?.["terminal-auth"] === true`（兼容当前 Registry checker）；
  - `clientCapabilities.terminal === true` 只能说明客户端支持 ACP terminal request，不等同于支持 Terminal Auth；不得单独用它触发 `authMethods`。
  - 如后续 SDK / Registry 改为新的稳定字段，优先使用稳定字段。
- 返回值只包含一个 Terminal Auth 方法：
  - `id: "omp-setup"`；
  - `type: "terminal"`；
  - `name: "Set up Oh My Pi"`；
  - `description` 说明它会打开终端检查并引导配置 OMP credentials / models；
  - `args: ["--setup"]`；
  - `env` 不设置，避免把敏感或用户特定配置固化到 handshake。
- 当客户端不声明 terminal auth 支持时，继续不返回 `authMethods`，避免让不支持 terminal auth 的客户端展示不可用入口。

注意：Registry 的 Python auth checker 会在 `clientCapabilities._meta` 中发送 `"terminal-auth": true`，但不会发送 SDK RFD 中的 `clientCapabilities.auth.terminal`。同一个请求还会包含 `clientCapabilities.terminal === true`，但该字段在 SDK 0.21.0 中表示客户端支持 ACP `terminal*` 方法，不是认证 opt-in。本仓库测试必须覆盖 `_meta` 兼容路径和 SDK 稳定路径。

### 4. `authenticate` 方法语义

当前 `authenticate` method-not-found 的行为与“不返回 authMethods”匹配。一旦返回 `authMethods`，`authenticate` 不能继续全局 method-not-found，否则支持该方法的 client 可能出现不一致体验。

设计：

- `authenticate({ methodId: "omp-setup" })` 返回 `{}`。
- 语义：Terminal Auth 的实际交互由 client 另起 terminal process 执行 `omp-acp --setup`，`authenticate` 只是确认该 method id 是 adapter 声明的 setup 方法。它不得启动 setup 子进程，也不得写 stdout。
- 未知 `methodId` 返回 JSON-RPC invalid params 或 method-specific error，而不是成功。
- 如果客户端未在当前 `initialize` 中声明 terminal auth support，但仍调用 `authenticate({ methodId: "omp-setup" })`，可返回成功或 invalid params。推荐保持无状态简单实现：只根据 known method id 返回 `{}`，因为 ACP server 当前没有按 connection 保存 initialize capabilities。该决策需要在测试中明确。

如果后续确认 ACP SDK / Registry 不要求 `authenticate` handler，则仍应实现该 handler，因为声明 `authMethods` 后继续 method-not-found 是不可维护的协议边界。

### 5. Registry manifest 草案

在实现和发布新版本后，Registry PR 目录形态应为：

```text
agentclientprotocol/registry/
  omp-acp/
    agent.json
    icon.svg
```

`agent.json` 草案：

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

版本号必须替换为已经发布到 npm 的版本。不要使用 `latest`。如果 Registry 后续要求 `args`，再显式填入；当前 `omp-acp` 默认无参就是 ACP stdio server，因此 npx distribution 不需要额外 args。

`icon.svg` 要求：

- `width="16" height="16" viewBox="0 0 16 16"`；
- 只使用 `fill="currentColor"`、`stroke="currentColor"`、`fill="none"` 或 `stroke="none"`；
- 不使用硬编码颜色；
- 文件应放在 Registry fork 的 `omp-acp/icon.svg`，不是本仓库发布包的必要文件。

### 6. 文档更新

实现时需要更新：

- `README.md`：
  - Registry readiness；
  - `omp-acp --setup` 用法；
  - Terminal Auth 边界；
  - Zed / ZedG reload 提醒。
- `docs/compatibility/acp-validation.md`：
  - `validate:registry` 覆盖 authMethods；
  - 明确它仍不是完整官方 CI，但对齐 auth checker 的关键行为。
- `docs/release-checklist.md`：
  - 发布 Registry-ready 版本前必须跑 auth / setup / registry probes。
- 下一版 release notes：
  - 说明新增 Terminal Auth；
  - 说明不收集 secret；
  - 说明 Registry PR 状态。

## 测试与验收

### 单元测试

更新 `test/unit/acp/initialize.test.ts`：

- 默认 client capabilities 不返回 `authMethods`。
- `clientCapabilities.auth.terminal === true` 时返回 `omp-setup` Terminal Auth。
- `clientCapabilities._meta["terminal-auth"] === true` 时返回 `omp-setup` Terminal Auth。
- 不返回 env-var-only auth。
- 不改变 `agentCapabilities`。

新增或更新 authenticate handler 测试：

- `authenticate({ methodId: "omp-setup" })` 返回 `{}`。
- `authenticate({ methodId: "unknown" })` 返回明确 JSON-RPC error。

新增 setup CLI 测试：

- `--help` / `--version` 不启动 ACP stream。
- `--setup` 在 deterministic setup fixture 或临时 OMP RPC fixture 可用且模型可用时 exit 0。
- `--setup` 在 runtime command 不存在时 exit 1。
- `--setup` 在无可用模型时 exit 2。
- setup 输出不包含 API key / token / secret 形态的环境变量值。

### Smoke / script 验收

更新 `test/smoke/acp-stdio.test.ts`：

- `initialize` 在 Registry-style terminal capability 下返回 Terminal Auth。
- stdio stdout 仍全是 JSON-RPC frame。
- `authenticate` known method 成功，unknown method 失败。

更新 `scripts/smoke-sdk-client.mjs`：

- 默认 SDK smoke 仍可不传 terminal auth，并期望 `authMethods` 为 `undefined`。
- 另加 terminal-auth initialize request，验证 SDK 能解析 `authMethods`。

更新 `scripts/probe-registry-matrix.mjs`：

- 当前 Registry-style capabilities 下期望 `authMethods` 包含 `terminal`。
- summary 输出真实 auth type，不再写死空数组。

新增 Registry auth checker 近似验证（可放入 `validate:registry` 或单独脚本）：

- 启动 `dist/index.js`；
- 发送与 Registry Python client 同形的 `initialize`：
  - `clientCapabilities.terminal === true`；
  - `clientCapabilities.fs`；
  - `_meta.terminal-auth === true`；
- 断言 `authMethods` 至少一个 method type 是 `terminal` 或 `agent`；
- 另加负向用例：只有 `clientCapabilities.terminal === true`、但没有 `auth.terminal` 或 `_meta.terminal-auth` 时，不返回 `authMethods`；
- 断言 stdout 无非 JSON 内容。

### 发布前验证

实现完成并准备 release / Registry PR 前必须运行：

```bash
npm run typecheck
npm run check
npm run build
npm run smoke:acp
npm run smoke:sdk-client
npm run validate:registry
npm run validate:acpx
npm run smoke:omp-rpc-controls:required
git diff --check
```

也可以直接运行 `npm run validate:standard` 作为聚合门禁；如果单独列命令，必须包含当前 `validate:standard` 覆盖的 `validate:acpx`。

如果新增 `--setup` 行为影响真实 OMP 检查，还必须运行：

```bash
node dist/index.js --setup
```

并记录观察到的退出码和关键输出。不得把该命令的成功等同于 Registry PR 成功；Registry PR 仍需在 fork 中运行 `python3 .github/workflows/verify_agents.py --auth-check --agent omp-acp` 或等效 CI。

## 迁移与发布顺序

1. 实现 `omp-acp --setup` 和 CLI mode split。
2. 实现 `buildAuthMethods()`，在 `initialize` 中按 client capability 声明 Terminal Auth。
3. 实现 `authenticate` known method 成功 / unknown method 失败。
4. 更新测试和 smoke。
5. 更新 README、兼容性文档、release checklist。
6. 运行自动化验证。
7. 只读复审 auth / registry 变更。
8. commit 到 `main`。
9. bump 版本并发布 npm / GitHub Release。
10. 在 `agentclientprotocol/registry` fork 中添加 `omp-acp/agent.json` 和 `omp-acp/icon.svg`。
11. 在 Registry fork 中运行 schema / auth checker。
12. 提交 Registry PR。

## 风险与缓解

### 风险：Terminal Auth `args` 追加/替换语义不一致

RFD 说 terminal auth args 会追加到默认 args；Registry 文档说 setup args 会替换默认 args。当前 `omp-acp` distribution 无默认 args，因此 `args: ["--setup"]` 在两种解释下都能工作。不要在 Registry `agent.json` 的 npx distribution 中加入默认 ACP args。

### 风险：Zed / ZedG 尚不支持 terminal auth UI

Registry 支持并不等于所有客户端支持。`initialize` 仅在客户端声明 terminal auth support 时返回该方法；Zed / ZedG 若不支持，不应看到该入口。README 需要明确：用户仍可手动运行 `npx omp-acp@<version> --setup` 或本地 `node dist/index.js --setup`。

### 风险：setup flow 无法自动完成 provider 登录

这是刻意边界。`omp-acp` 不能变成 provider secret 管理器；它只检查并引导 OMP 本体配置。若 OMP 上游以后提供 `omp login` / `omp auth`，再把 setup flow 委托给上游。

### 风险：authMethods 声明与 `authenticate` 状态不一致

声明 Terminal Auth 后必须实现 `authenticate` known method 成功，避免 client 调用时得到 method-not-found。测试必须覆盖 stdio 行为。

### 风险：Registry checker 与 SDK RFD capability 字段不同步

实现同时支持稳定字段 `clientCapabilities.auth.terminal` 和 Registry 当前 `_meta.terminal-auth`。不要把 `clientCapabilities.terminal` 误判为认证能力；它只表示客户端支持 ACP terminal request。测试必须覆盖三种输入：稳定 auth 字段、Registry `_meta` 字段、terminal request-only 字段。

## 完成定义

此 gap 只有在以下条件全部满足后才算补齐：

- `initialize` 在 Registry-style terminal capability 下返回 Terminal Auth。
- 标准 ACP server 模式 stdout 仍只输出 JSON-RPC / NDJSON。
- `omp-acp --setup` 可单独运行，不启动 ACP server，不读取或打印 secret。
- `authenticate("omp-setup")` 行为与声明一致。
- 本仓库 registry-style probe 不再把 authMethods 视为空，而是验证 terminal auth。
- README 和兼容性文档说明 Terminal Auth 的真实边界。
- 新版本已发布到 npm，Registry `agent.json` 使用精确版本。
- Registry fork 的 `agent.json` / `icon.svg` 通过 schema、icon 和 auth checker。
- 未声称官方 Registry 收录，除非 PR 已合并并能从 registry CDN 查询到 `omp-acp`。
