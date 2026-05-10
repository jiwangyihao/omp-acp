# ACP adapter 架构硬化与发布门禁修复设计

## 背景

上一轮架构收敛已经把实时、历史、host tool、extension UI 和 session setup projection 的多个分叉点统一到共享模块，并通过了 `npm run check`、`npm run build` 与只读复审。随后进行的第二轮全面架构审查不再局限于消息转换，覆盖了 ACP session lifecycle、OMP runtime/RPC/history、translation safety、验证发布链路和横向模块边界。

本轮审查发现当前代码虽已通过自动化测试，但仍有几处会影响高可靠性边界的架构问题：session 发布 id 与 ask 禁用时机存在并发/生命周期缺口；发布门禁会把真实 OMP smoke 的 skip 误当成功；工具输出安全处理改变了普通 JSON 字符串 stdout 的语义；项目根目录还存在无用途的空目录。除此之外，还有一批建议级架构债务，包括 schema boundary、history store 拆分、ACP/OMP 依赖方向、错误模型、测试发现方式与真实 OMP fixture 边界。

本规格定义一次全面修复，目标是优先消除必须修复项，同时为建议级问题建立清晰边界和可执行的后续演进路径。实现仍采用 clean cutover，不保留旧路径或兼容别名。

## 目标

- 修复 `createSessionWithId()` 最终发布 `sessionId` 的并发 reservation 漏洞，避免 session 覆盖和 runtime 泄漏。
- 确保 `load` / `resume` / `fork` 在 `switch_session` 后仍执行 OMP Ask 禁用二层防护，发布前状态与最终 OMP session 一致。
- 修正工具输出策略：普通字符串输出保持字符串语义；只有明确结构化 payload 才按对象递归净化；JSON 字符串不再被无条件解析成对象。
- 修正发布门禁：`validate:standard` 使用 required real OMP smoke，真实 OMP 不可用或 skip 时必须失败；保留 optional smoke 供本地诊断。
- 改善测试发现方式，避免新增测试文件未加入 `npm run check`。
- 清理根目录无用途空目录：`testunittranslate`、`srctranslate`、`testunitruntimeomp`、`srcacptransport`、`testsmoke`。
- 为 schema boundary、history store 拆分、ACP/OMP 依赖方向、错误模型和真实 OMP fixture 边界写入明确的后续架构约束，避免继续扩大债务。

## 非目标

- 不新增 ACP initialize capability。
- 不实现 ACP elicitation、MCP、session/close、terminal/filesystem delegation 或新工具执行能力。
- 不重写整个 adapter，也不把所有建议级架构债务一次性大重构完成。
- 不改变 OMP session JSONL 持久化格式。
- 不把 provider-private payload、encrypted reasoning、signature、raw provider config、secret、token、base URL 或 key 暴露给 ACP client。
- 不声称真实 OMP RPC controls smoke 或 Zed/ZedG GUI smoke 已通过，除非实现后重新观察到通过输出。

## 必须修复项设计

### 1. Session 发布 id reservation 与 runtime cleanup

#### 现状

`src/session/manager.ts` 的 `createSessionWithId()` 会先用调用方传入的 `sessionId` 写入 `#pendingSessionIds`，随后 `beforePublish()` 可以返回新的 `sessionId` 覆盖 `publishedSessionId`。当前发布前只在 `publishedSessionId !== sessionId` 时检查 `#sessions.has(publishedSessionId)`，没有检查 `#pendingSessionIds`，也没有为最终发布 id 建立 reservation。

#### 风险

两个并发创建可出现交叉覆盖：

1. B 预留 `sessionId=B`，尚未发布。
2. A 的 runtime 返回 `runtimeSessionId=B`。
3. A 发布到 `#sessions[B]`。
4. B 发布时跳过冲突检查并覆盖 A。
5. A runtime 从管理表丢失，后续 `closeAll()` 无法关闭，ACP session 映射失真。

#### 设计

`SessionManager` 需要把“初始请求 id”和“最终发布 id”都纳入统一 reservation 规则：

- `#pendingSessionIds` 保留 `Map<string, symbol>`。
- 初始 `sessionId` 用 `initialReservation` 预留。
- `beforePublish()` 返回 `publishOverride.sessionId` 后，计算 `finalSessionId`。
- 发布前调用共享内部函数 `#reserveFinalSessionId(finalSessionId, initialSessionId, initialReservation)`：
  - 如果 `#sessions.has(finalSessionId)`，拒绝并关闭 runtime。
  - 如果 `#pendingSessionIds.has(finalSessionId)` 且不是当前 initial reservation，拒绝并关闭 runtime。
  - 如果 `finalSessionId !== initialSessionId`，写入一个 final reservation，防止发布窗口被其它创建抢占。
- 成功 `#sessions.set(finalSessionId, session)` 后，在 `finally` 中释放 initial 和 final reservation。
- 任何失败路径都必须关闭 runtime，并且不得删除其它创建持有的 reservation。

#### 验收

- 并发 `createSessionWithId("a")` 与 `createSessionWithId("b")` 时，如果 A 的 `beforePublish()` 返回 `sessionId:"b"`，A 必须失败且关闭 A runtime；B 仍可正常发布。
- 如果 `beforePublish()` 返回已发布 session id，必须失败且关闭 runtime。
- 如果 cleanup generation 在发布前变化，runtime 仍关闭，reservation 仍释放。
- 不允许 `#sessions.set()` 覆盖已有 session。

### 2. Ask 禁用必须作用于最终 OMP session

#### 现状

`createSessionWithId()` 当前顺序是：

1. 等待 `runtime.ready`。
2. 调用 `disableOmpAskTool(runtime)`。
3. 调用 `beforePublish(runtime)`。

但 `session/load`、`session/resume`、`session/fork` 的 `beforePublish()` 会调用 `switch_session`。因此 Ask 禁用可能作用在 switch 前的临时 session，而不是最终发布的目标 session。

#### 设计

调整 session creation lifecycle 为：

1. 创建 runtime。
2. 等待 `runtime.ready`。
3. 执行 `beforePublish(runtime)`，包括 `switch_session`、fork setup、setup state build 前的目标 session 切换。
4. 对最终 runtime state 调用 `disableOmpAskTool(runtime)`。
5. 构建 setup state 或要求 handler 在 post-guard 后构建 setup state。
6. 发布 session。

为了避免 handler 已在 `beforePublish()` 内构建 setup state 的现状被破坏，本轮采用更明确的 hook 分层：

```ts
export type CreateSessionHooks = {
  beforeGuard?: (runtime: RuntimeAdapter) => Promise<{ sessionId?: string } | undefined>;
  afterGuard?: (runtime: RuntimeAdapter) => Promise<{ sessionId?: string } | undefined>;
};
```

`SessionManager` 的固定顺序必须是：`runtime.ready` → `beforeGuard()` → `disableOmpAskTool()` → `afterGuard()` → 计算最终发布 id → final id reservation → publish。最终发布 id 的来源优先级为 `afterGuard.sessionId`、`beforeGuard.sessionId`、初始 `sessionId`；无论最终 id 来自哪个阶段，都必须经过同一 final reservation 检查。

可选实现方式：

- `session-new`：不需要 `beforeGuard`；`afterGuard` 在 Ask guard 后构建 setup state，并可返回 `get_state.sessionId` 作为真实 runtime id。
- `session-load/resume/fork`：`beforeGuard` 负责 `switch_session` 并可返回目标 session id；`afterGuard` 在 Ask guard 后构建 setup state，并可在发现 runtime 最终 id 时返回覆盖值。
- `SessionManager` 在 `beforeGuard` 后统一调用 `disableOmpAskTool()`，然后调用 `afterGuard()`，再统一解析最终发布 id。

如果为了减少 API 改动选择保留一个 callback，则 callback 必须内部先 switch，再由 manager 调用 ask guard，再由另一个 callback 构建 setup state。不能继续在 switch 前禁用 ask。

#### 验收

- `session/load` fake runtime：初始 `get_state.dumpTools` 无 `ask`，`switch_session` 后 `get_state.dumpTools` 含 `ask`。handler 必须调用 `set_active_tools` 去掉 `ask`，再构建 setup state。
- `session/resume` 和 `session/fork` 同样覆盖。
- `session/new` 仍禁用 ask，并继续返回真实 `get_state.sessionId`；该真实 id 必须来自 post-guard `afterGuard()` 返回值，并参与 final reservation 检查。
- 若 `set_active_tools` 失败，session 不发布，runtime 关闭，错误不伪装成成功。

### 3. 工具输出字符串语义与安全净化分离

#### 现状

`src/translate/tools.ts` 当前对 `rawOutput` / `output` / `result` 候选值调用 `parseToolInput()`。这会把任何合法 JSON 字符串解析成对象或数组，再递归净化。同时 `safeTextOutput()` 会因为字符串可解析为 JSON 而不再把它作为 visible text content 发送。

#### 风险

普通工具 stdout 如果恰好是 JSON 文本，例如 bash 输出 `{"ok":true}`，ACP client 会看到对象而不是原始文本，甚至因为 key 过滤导致输出被改写。这把“结构化工具 payload 净化”和“普通 stdout 展示”混为一谈。

#### 设计

拆分输出处理策略：

- `parseToolInput()` 继续用于工具输入参数、历史 `toolCall.arguments` 等结构化输入。
- 新增输出策略函数，例如：

```ts
export function sanitizeToolOutputForAcp(value: unknown, options?: { parseJsonString?: boolean }): unknown;
export function sanitizeTextForAcp(value: string): string;
```

- 默认 `sanitizeToolOutputForAcp(string)` 不解析 JSON，保持 string。
- 对明确结构化字段（例如 runtime 已经提供对象/数组的 `result`、`partialResult`、`rawOutput`）递归净化。
- 对字符串输出执行文本级 redaction，而不是类型转换：
  - 如果字符串包含明显敏感 JSON 字段名和高风险值，替换对应片段或返回保守 redacted 文本。
  - 如果没有高风险文本，原样保留。
- `content` 提取仍应把普通字符串输出作为 `text` content 发送。
- 字符串候选只能净化一次，`rawOutput` 与 visible text content 必须来自同一个 redacted string。实现不得先对 `rawOutput` 脱敏、再从原始 `raw.content/output/rawOutput` 生成可见文本。
- 历史 `toolResult.rawOutput` 如果是字符串，也遵循同一规则；如果是对象，则对象净化。

#### 验收

- `toolExecutionEndToUpdate({ rawOutput: '{"ok":true}' })` 的 ACP `rawOutput` 仍是字符串，content 包含同一文本。
- `toolExecutionEndToUpdate({ rawOutput: { ok:true, token:"secret" } })` 的 ACP `rawOutput` 是 `{ ok:true }`。
- `toolExecutionEndToUpdate({ rawOutput: '{"token":"secret","ok":true}' })` 不泄漏 `secret`，但也不把输出变成对象；`rawOutput` 与 `content[].content.text` 必须是同一个 redacted string 或同等脱敏文本。
- 历史 tool result 与实时 tool result 一致。

### 4. 发布门禁区分 optional 与 required real OMP smoke

#### 现状

`scripts/smoke-omp-rpc-controls.mjs` 找不到 `omp` 时输出 `{ skipped: true }`，退出码仍为 0。`package.json` 的 `validate:standard` 直接运行 `npm run smoke:omp-rpc-controls`，因此没有真实 OMP 的环境也可能通过标准验证。

#### 设计

新增 required 模式：

- 脚本支持环境变量：`OMP_ACP_REQUIRE_REAL_OMP=1`。
- 当 required 模式开启时：
  - `omp not found` 必须 exit 1。
  - `dumpTools` 缺失导致 set_active_tools 无法验证时必须 exit 1，除非脚本能证明当前 OMP 版本不支持该 contract 并把结果标为明确失败。
  - ready timeout 必须 exit 1。
- 保留默认 optional 模式，用于开发机诊断：找不到 `omp` 可 `{ skipped:true }` exit 0。
- `package.json` 增加脚本：
  - `smoke:omp-rpc-controls:optional`
  - `smoke:omp-rpc-controls:required`
- `validate:standard` 使用 required 版本。
- README 和 release checklist 同步更新：发布门禁必须使用 required 版本。

#### 验收

- helper 单测覆盖 optional skip exit 0 与 required skip exit 1。
- `validate:standard` 不再调用可 skip 的脚本。
- README 不再把 optional smoke 描述为发布门禁。

### 5. 测试发现方式收敛

#### 现状

`package.json` 的 `test` 与 `check` 显式枚举所有测试文件。新增测试文件时必须手工改两处长命令，容易漏进发布门禁。

#### 设计

改为跨平台测试发现脚本，同时保留需要独立运行的 `.mjs` smoke helper。不要把 shell glob 作为主路径；Windows `cmd`/PowerShell 与 Node 20 对 `**`/`*` 参数的行为不应成为发布门禁前提。

新增 `scripts/run-tests.mjs`（或等价 Node 脚本）作为唯一测试发现入口：

- 递归枚举 `test/` 下的 `*.test.ts` 和 `*.test.mjs`。
- 以稳定排序生成显式文件列表。
- 对 `.ts` 测试使用 `node --import tsx --test --test-concurrency=1 <files...>`。
- 对 `.mjs` 测试使用 `node --test <files...>`，或在同一脚本中按扩展名分批执行。
- 如果未发现测试文件，必须失败。

`package.json` 脚本改为：

```json
{
  "scripts": {
    "test": "node scripts/run-tests.mjs",
    "check": "npm run typecheck && npm test"
  }
}
```

#### 验收

- `scripts/run-tests.mjs` 发现并运行当前全部 `test/**/*.test.ts` 与 `test/**/*.test.mjs`；不得依赖 shell glob。
- `npm run check` 覆盖现有 226 个 TypeScript 测试和 3 个 smoke helper `.mjs` 测试。
- 后续新增 `test/**/*.test.ts` 或 `test/**/*.test.mjs` 不需要修改 `package.json` 即可被 `npm test` 覆盖。

### 6. 清理空目录

#### 现状

仓库根目录存在无文件目录：

- `testunittranslate`
- `srctranslate`
- `testunitruntimeomp`
- `srcacptransport`
- `testsmoke`

#### 设计

直接删除这些空目录。它们不属于源码、测试、文档或发布包结构，不需要迁移内容。

#### 验收

- `find` 或目录读取确认这些目录不存在。
- `npm run check` 不受影响。
- 不删除任何含文件目录，不删除 `src/`、`test/`、`docs/`。

## 建议级架构收敛设计

以下问题本轮不必全部完成大重构，但需要写入规格并在实现计划中至少安排边界测试或文档化约束，避免后续继续扩大债务。

### 7. OMP RPC schema / codec 边界

新增 `src/runtime/omp/schema.ts` 或 `codec.ts` 作为后续目标：

- 统一解析 ready、response、runtime event、host tool call/cancel、extension UI request。
- 对 outbound commands 提供 typed builder。
- `rpc-client.ts`、`host-tools.ts`、`translate/events.ts` 不再各自直接读 raw frame。

本轮可先增加规格和小范围测试，或只在实现计划中安排后续任务；不要求一次性替换全部 raw parsing。

### 8. SessionRepository / HistoryRepository 边界

后续应抽象：

- `SessionRepository.list(cwd)`
- `SessionRepository.findById(id, cwd)`
- `SessionRepository.loadHistory(sessionRef)`
- `SessionRepository.fork(sourceRef, forkId)`

ACP handler 不应直接知道 OMP JSONL 路径。`_meta.ompSessionPath` 应被评估是否继续暴露；若保留，必须在文档中标为调试信息且不稳定，不能作为客户端 contract。

### 9. History replay 文件拆分

`src/runtime/omp/sessions.ts` 后续应拆分为：

- scanner / metadata parser
- fork writer
- history parser
- history-to-ACP replay mapper
- diagnostics

本轮如果改动该文件，应避免继续增加职责；新增逻辑优先放入独立模块。

### 10. 错误模型统一

后续应统一 domain errors 与 ACP boundary mapping：

- domain 层抛 `UnknownSessionError`、`InvalidSessionStateError`、`RuntimeSetupError`、`UnsupportedRuntimeEventError` 等。
- ACP server boundary 统一转换为 `RequestError.resourceNotFound`、`invalidParams` 或 internal error。
- handler 内不再混用普通 `Error` 与 SDK `RequestError`。

本轮必须修复项如果触碰错误路径，应优先使用现有 `SessionManagerError`，不要新增另一套 ad hoc 错误。

### 11. Fixture 与真实 OMP contract 边界

`src/testing/script-rpc-process.ts` 必须继续定位为 adapter harness，不是 OMP contract source。后续应增加脱敏真实 frame 快照测试，覆盖：

- `message_update` 真实 assistant event。
- `agent_end.messages`。
- `get_state.dumpTools` / `set_active_tools`。
- extension UI request / response。

真实 OMP smoke timeout 不能作为通过结论。

## 测试策略

每个行为修复必须 TDD：先写失败测试，观察红灯，再实现，最后观察绿灯。

目标测试组：

- `test/unit/session/manager.test.ts`
  - final session id reservation collision。
  - final id 已发布冲突。
  - cleanup generation 与 reservation 释放。
- `test/unit/acp/session-list-load.test.ts`
  - load switch 后 ask 禁用。
- `test/unit/acp/session-resume.test.ts`
  - resume switch 后 ask 禁用。
- `test/unit/acp/session-fork.test.ts`
  - fork switch 后 ask 禁用。
- `test/unit/acp/session-config.test.ts`
  - setup state 在 ask guard 后构建，public projection 不泄漏。
- `test/unit/translate/tools.test.ts`
  - JSON 字符串 stdout 保持字符串语义。
  - 字符串中敏感 JSON 文本 redaction。
  - 结构化对象 output 仍递归净化。
- `test/unit/runtime/omp/sessions.test.ts`
  - 历史 tool result 字符串输出与实时一致。
- `test/smoke/omp-rpc-controls-smoke.test.mjs`
  - optional skip 与 required skip 的 exit/结果语义。
  - required 模式下缺少 `dumpTools` 或 `omp not found` 不被视为通过。
- package script 测试或静态检查：
  - `npm run check` 使用 test discovery 覆盖当前所有测试文件。

最终验证：

```bash
npm run check
npm run build
npm run smoke:omp-rpc-controls:optional
```

如果本机真实 OMP 可用，还需要运行：

```bash
npm run smoke:omp-rpc-controls:required
```

若 required 仍因环境 timeout 失败，不得声称发布门禁通过；只记录失败事实。

## 文档更新

需要更新：

- `README.md`
  - 区分 optional 与 required real OMP smoke。
  - 说明 `validate:standard` 使用 required gate。
  - 保持不声明 Zed GUI smoke 已完成。
- `docs/release-checklist.md`
  - 将真实 OMP RPC controls smoke 改为 required gate。
  - 更新历史快照，避免旧的“通过”误导当前状态。
- `docs/compatibility/capability-matrix.md`
  - 若 Ask guard 顺序修复影响边界说明，补充 `load/resume/fork` 最终 session 也执行 Ask 禁用。
- `docs/compatibility/zed.md`
  - 若验证脚本名称变更，更新命令。

## 验收清单

- `load` / `resume` / `fork` 最终目标 session 的 `ask` 会被禁用；失败时 session 不发布。
- 最终发布 session id 不会覆盖已发布或 pending session；冲突时 runtime 被关闭。
- 普通 JSON 字符串工具输出保持文本语义；结构化对象输出仍净化敏感字段。
- `validate:standard` 不会在真实 OMP smoke skip 时成功。
- `npm run check` 自动发现测试文件，不依赖手工枚举长列表。
- 指定空目录已删除。
- README、release checklist 与 capability 文档不夸大真实 OMP smoke、Zed GUI smoke 或 ACP conformance。
- `npm run check`、`npm run build` 通过；`git diff --check` 无输出。
- 至少 4 个只读 reviewer 子代理复审通过，覆盖 session lifecycle、translation safety、release/test architecture 与 cross-cutting boundaries。
