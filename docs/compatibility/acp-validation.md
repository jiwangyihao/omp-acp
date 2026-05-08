# ACP 标准化验证策略

本文档记录 `omp-acp` 当前采用的 ACP 正确性验证层级。目标是避免只用自写 smoke 来证明协议兼容性，同时明确哪些验证具有官方性质，哪些只是外部草案或 UI 集成门禁。

## 结论

截至 2026-05-08，未发现 ACP 官方发布的稳定、完整 conformance test suite。当前可防御的验证分层如下：

1. **官方 TypeScript SDK client smoke**：`npm run smoke:sdk-client` 使用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 驱动本地 adapter，降低手写 JSON-RPC 客户端造成的理解偏差。
2. **raw JSON-RPC stdio smoke**：`npm run smoke:acp` 继续验证 stdout 纯净性、构建产物入口、低层 JSON-RPC 行为和错误处理。
3. **ACP Registry / Protocol Matrix 风格探测**：`npm run validate:registry` 复刻 registry matrix 的 capability discovery 与方法探测思路；它是官方生态参考，不是完整行为 conformance。
4. **`openclaw/acpx` draft conformance 评估**：`npm run validate:acpx` 运行固定 commit 的第三方草案 profile，并把与当前能力矩阵不适用或草案差异明确列为 expected draft failures；不能当作 ACP 官方发布门禁。
5. **Zed GUI smoke**：验证真实客户端 UI 集成，不替代协议正确性验证。本轮“除 Zed 外”的自动化验证不包含该项。

## 本仓库自动化门禁与探测

### `npm run smoke:sdk-client`

该脚本先构建 `dist/index.js`，再通过官方 SDK 创建 `ClientSideConnection`，覆盖：

- `initialize`：校验 protocol version、agent info、已声明能力和未声明能力边界；
- `session/new`：通过 SDK client 创建新会话；
- `session/prompt`：接收并校验 SDK 解析后的 `session/update` notification；
- `session/list`：校验 OMP JSONL session discovery；
- `session/resume`：确认 resume 不回放历史，后续 prompt 可继续；
- stdout 纯净性：adapter stderr 必须为空，协议输出由 SDK stream 消费。

这不是官方 conformance suite，但它使用官方 SDK 的连接层和 notification schema validation，比只使用手写 JSON-RPC harness 更接近 ACP 官方客户端语义。

### `npm run smoke:acp`

该脚本仍保留。它使用手写 JSON-RPC/NDJSON harness 直接观察 stdout，重点覆盖：

- build output 是否可启动；
- stdout 是否只包含 JSON-RPC frame；
- initialize/new/prompt 的最小端到端路径；
- adapter 进程 stderr 是否保持为空。

两类 smoke 互补：SDK smoke 降低协议理解偏差，raw smoke 保留低层传输和 stdout 污染检测。

### `npm run validate:registry`

该脚本先构建 `dist/index.js`，再使用 raw JSON-RPC/NDJSON harness 按 ACP Registry Protocol Matrix 的风格执行：

- `initialize` 使用 registry matrix 风格的 `clientInfo`、terminal 与 fs capability 参数；
- 校验当前 truthful capability signal：`loadSession:true`、`sessionCapabilities.list:{}`、`sessionCapabilities.resume:{}`，并确认 fork/stop/set_model 未声明；
- `session/new` 基础创建通过；
- `session/list` 与一个预置 OMP JSONL session 的 `session/resume` probe 通过；
- `session/fork`、`session/stop`、`session/set_model` 返回 `method_not_found`，与未声明能力一致；
- stdout 逐行校验为 JSON-RPC frame，避免 adapter stdout 污染。

这不是直接运行 `agentclientprotocol/registry` CI；当前包仍为 `private`，没有 registry manifest，也没有实现 ACP auth flow。它用于在本地覆盖 registry matrix 最关键的 capability discovery 与 unsupported-method 边界。

## ACP Registry / Protocol Matrix

官方 `agentclientprotocol/registry` 的 protocol matrix 会启动 registry 中的 agent，并探测：

- `initialize`；
- 基础 `session/new`；
- `session/list`、`session/fork`、`session/resume`、`session/stop`、`session/set_model` 等方法探测。

Registry 的 auth checker 还会检查 `authMethods`，并明确要求 agent 不得向 stdout 写入非 ACP JSON-RPC 内容。

当前 `omp-acp` 仍是 `private` 本地 adapter，且没有实现 ACP auth flow，因此不把 Registry CI 作为当前本地发布门禁。若未来准备 registry 入口，必须先单独设计并实现 truthful auth 能力，再用 registry manifest 和官方 CI 验证。

## `openclaw/acpx` conformance draft

`openclaw/acpx` 提供 `ACP Conformance Suite (Draft)`，当前 v1 scope 包括：

- `initialize`；
- `session/new`；
- `session/prompt`；
- `session/update`；
- `session/cancel`；
- baseline error semantics。

该套件更像行为 conformance runner，但它不是 ACP 官方仓库，并且明确标注为 draft。后续可以把它作为外部压力测试引入，但必须区分：

- adapter 未声明的能力不能因为 draft profile 要求而被临时伪造；
- permission 相关 case 在当前阶段应标记为 unsupported 或 expected non-applicable；
- 失败结论必须按 case 与当前 capability matrix 逐项解释。

当前已通过 `npm run validate:acpx` 执行固定版本：

- `openclaw/acpx` commit：`d46e1561020aafb4b88c4bad314fe4c883829a5a`；
- profile：`acp-core-v1`；
- 结果：21 个 case，11 个通过，10 个 expected draft failures，未出现 unexpected failure。

expected draft failures 的边界如下：

- cancellation/background 类 case 依赖 acpx mock-agent 对 `sleep 5000` 的长运行语义；当前 adapter 使用 deterministic fixture runtime，无法用该 fixture 证明 in-flight cancel；
- permission read/write 类 case 依赖 ACP client-authority permission flow；当前 adapter 不声明、不实现该能力；
- structured blocks case 期望 agent update 中回显原始 ACP resource block JSON；当前 adapter 的已声明 embedded context 语义是把 embedded text/blob resource 转为稳定 OMP prompt text sections；
- unknown-session case 的 draft 期望错误码只包含 `-32603`/`-32000`；adapter 现在返回 SDK `resourceNotFound`（`-32002`），这比此前的 internal error 更明确，但仍与该第三方草案 case 的 code allowlist 不一致；
- mock-agent 文本类 case（例如 unknown command、late tool update）验证的是 acpx 自带 mock-agent 行为，不是当前 OMP fixture runtime 的承诺。

本次验证中发现并修复了一个真实错误语义问题：`session/prompt` 指向未知 session 时不再被 SDK 包装成 `Internal error`，而是返回显式 `Resource not found`。对应覆盖见 `test/smoke/session-prompt.test.ts`。

## Zed GUI smoke 的位置

Zed GUI smoke 仍是发布前门禁，用于确认真实客户端体验：

- new thread；
- prompt；
- tool call / tool update；
- edit diff；
- cancel；
- session list / load / resume；
- unsupported capability 不被展示为可用。

它验证 UI 集成和真实客户端行为，但不是 headless ACP conformance。当前隔离 Zed 手工 smoke 仍未执行，发布仍因此阻塞。