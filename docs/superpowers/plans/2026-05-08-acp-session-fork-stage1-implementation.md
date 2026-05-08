# ACP `session/fork` 第一阶段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。必须直接在当前 `main` 工作区开发，不创建 git worktree。每个任务必须先写失败测试，再写实现；不得提前声明未实现能力。

**目标：** 实现 ACP 标准 `session/fork` 第一阶段能力：从源 OMP session 当前已持久化 head fork 出新 session，并允许 fork 后继续 prompt。

**架构：** 在 OMP session JSONL storage 层新增文件级 fork helper；在 ACP handler 层新增 `session/fork` 处理器；在 server/capability 层接入 SDK 0.21.0 的 `unstable_forkSession` 和 `sessionCapabilities.fork:{}`。第一阶段不实现非标准 message-bound fork，不使用 `_meta.messageId`，不新增 OMP RPC `branch/fork` contract。

**技术栈：** Node.js >= 20、TypeScript、`@agentclientprotocol/sdk@0.21.0`、`node:test`、JSON-RPC over stdio、OMP JSONL session files、现有 fixture runtime。

**规格来源：** `docs/superpowers/specs/2026-05-08-acp-session-fork-stage1-design.md`。

---

## 文件结构与职责

- 修改：`src/runtime/omp/sessions.ts` — 新增 `forkOmpSessionFile()`、`ForkOmpSessionOptions`、`ForkOmpSessionResult`，负责文件级 fork。
- 修改：`test/unit/runtime/omp/sessions.test.ts` — 覆盖 fork helper 的 happy path、header mismatch、目标文件已存在不覆盖。
- 修改：`src/session/manager.ts` — 新增 `reserveSessionId()` 和 `tryGetSession()`，供 fork handler 生成 fork id 和只读检查 active prompt。
- 创建：`src/acp/handlers/session-fork.ts` — 负责 ACP `ForkSessionRequest` 到 OMP JSONL fork、runtime `switch_session`、session publish 的编排。
- 创建：`test/unit/acp/session-fork.test.ts` — 覆盖 handler happy path、unknown source、active prompt 拒绝、`switch_session` 失败不发布。
- 修改：`src/acp/server.ts` — 接入 `unstable_forkSession(params)`。
- 修改：`src/acp/capabilities.ts` — 在已有 `sessionCapabilities` 中添加 `fork:{}`。
- 修改：`test/unit/acp/initialize.test.ts`、`test/smoke/acp-stdio.test.ts` — 更新 capability 断言。
- 修改：`test/smoke/session-prompt.test.ts`、`scripts/smoke-sdk-client.mjs`、`scripts/probe-registry-matrix.mjs` — 补齐 headless smoke 与 Registry-style probe。
- 修改：`package.json` — 将 `test/unit/acp/session-fork.test.ts` 加入显式测试枚举。
- 修改：`README.md`、`docs/compatibility/*.md`、`docs/release-checklist.md`、`docs/superpowers/plans/2026-05-07-omp-acp-implementation.md` — 同步能力边界与验证状态。

---

## 任务 1：实现 OMP JSONL fork helper

**文件：**
- 修改：`src/runtime/omp/sessions.ts`
- 测试：`test/unit/runtime/omp/sessions.test.ts`

- [ ] **步骤 1：编写失败测试：fork helper 复制 head 并写 parentSession**

在 `test/unit/runtime/omp/sessions.test.ts` 的 import 中加入 `forkOmpSessionFile`、`OmpSessionForkSourceError` 和 `readFile`。新增测试：

```ts
it("forkOmpSessionFile clones a session at head with parentSession metadata", async () => {
  const agentDir = await tempAgentDir();
  const sourcePath = await writeSessionFile(agentDir, "source", "source.jsonl", [
    { type: "session", id: "source-session", cwd: "/project", timestamp: "2026-05-08T00:00:00.000Z", title: "Source" },
    { type: "message", role: "user", content: "hello", sessionId: "source-session" },
    { type: "message", message: { role: "assistant", content: "world", sessionID: "source-session" } },
  ]);

  const result = await forkOmpSessionFile({
    sourcePath,
    sourceSessionId: "source-session",
    forkSessionId: "fork-session",
    cwd: "/project",
    agentDir,
    now: () => new Date("2026-05-08T01:00:00.000Z"),
  });

  assert.equal(result.sessionId, "fork-session");
  assert.match(result.path, /fork-session\.jsonl$/);
  const lines = (await readFile(result.path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], {
    type: "session",
    id: "fork-session",
    cwd: "/project",
    timestamp: "2026-05-08T01:00:00.000Z",
    title: "Source (fork)",
    parentSession: "source-session",
  });
  assert.equal(lines[1].sessionId, "fork-session");
  assert.equal(lines[2].message.sessionID, "fork-session");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/sessions.test.ts
```

预期：FAIL，原因是 `forkOmpSessionFile` 未导出或未定义。

- [ ] **步骤 3：编写失败测试：源 header 错误与目标文件存在不覆盖**

在同一测试文件继续新增：

```ts
it("forkOmpSessionFile rejects invalid source headers", async (t) => {
  const cases = [
    { name: "missing header", entries: [{ type: "message", role: "user", content: "no header" }] },
    { name: "non-session header", entries: [{ type: "metadata", id: "source-session", cwd: "/project" }] },
    { name: "mismatched id", entries: [{ type: "session", id: "other-session", cwd: "/project" }] },
    { name: "mismatched cwd", entries: [{ type: "session", id: "source-session", cwd: "/other" }] },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const agentDir = await tempAgentDir();
      const sourcePath = await writeSessionFile(agentDir, "source", "source.jsonl", testCase.entries);

      await assert.rejects(
        forkOmpSessionFile({
          sourcePath,
          sourceSessionId: "source-session",
          forkSessionId: "fork-session",
          cwd: "/project",
          agentDir,
        }),
        OmpSessionForkSourceError,
      );
    });
  }
});

it("forkOmpSessionFile uses exclusive creation and does not overwrite existing fork files", async () => {
  const agentDir = await tempAgentDir();
  const sourcePath = await writeSessionFile(agentDir, encodeOmpSessionCwd("/project"), "source.jsonl", [
    { type: "session", id: "source-session", cwd: "/project" },
    { type: "message", role: "user", content: "hello" },
  ]);
  const existingPath = await writeSessionFile(agentDir, encodeOmpSessionCwd("/project"), "fork-session.jsonl", [
    { type: "session", id: "fork-session", cwd: "/project", title: "Existing" },
  ]);

  await assert.rejects(
    forkOmpSessionFile({
      sourcePath,
      sourceSessionId: "source-session",
      forkSessionId: "fork-session",
      cwd: "/project",
      agentDir,
    }),
    /already exists/,
  );
  assert.match(await readFile(existingPath, "utf8"), /Existing/);
});
```

- [ ] **步骤 4：运行测试验证失败原因正确**

运行同一步骤 2 命令。预期仍 FAIL，失败原因仍是 helper 未实现，而不是测试语法错误。

- [ ] **步骤 5：实现最少 runtime helper**

在 `src/runtime/omp/sessions.ts` 中把 fs import 调整为：

```ts
import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
```

新增 `ForkOmpSessionOptions`、`ForkOmpSessionResult`、`OmpSessionForkSourceError` 和 `forkOmpSessionFile()`。实现必须使用 `open(targetPath, "wx")` 或等价独占创建，禁止覆盖已有 fork 文件。辅助函数保持在同一文件内：`parseForkSourceHeader()`、`buildForkSessionLines()`、`rewriteForkEntrySessionIds()`。只改写 spec 中列出的明显 session id 字段；非 JSON 行在源历史中按原样复制。源 header 缺失、类型不是 session、id/cwd 不匹配时必须抛 `OmpSessionForkSourceError`，供 ACP handler 映射为 `resourceNotFound`。

- [ ] **步骤 6：运行 runtime unit tests 验证通过**

```bash
node --import tsx --test --test-concurrency=1 test/unit/runtime/omp/sessions.test.ts
```

预期：PASS。

- [ ] **步骤 7：Commit runtime helper**

```bash
git add src/runtime/omp/sessions.ts test/unit/runtime/omp/sessions.test.ts
git commit -m "feat(runtime): 添加 OMP session fork 文件克隆"
```

---

## 任务 2：实现 SessionManager fork 支撑接口与 ACP handler

**文件：**
- 修改：`src/session/manager.ts`
- 创建：`src/acp/handlers/session-fork.ts`
- 测试：`test/unit/acp/session-fork.test.ts`
- 修改：`package.json`

- [ ] **步骤 1：编写失败测试：handler happy path**

创建 `test/unit/acp/session-fork.test.ts`。测试文件可复用 `test/unit/acp/session-handlers.test.ts` 中 fake runtime 的模式，但要保持本文件自包含。核心断言：`handleSessionFork()` 返回 `{ sessionId:"fork-session" }`、fake runtime 收到 `switch_session`、manager 中可以 `requireSession("fork-session")`。

- [ ] **步骤 2：运行测试验证失败**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-fork.test.ts
```

预期：FAIL，原因是 `src/acp/handlers/session-fork.ts` 或 `handleSessionFork` 不存在。

- [ ] **步骤 3：编写失败测试：unknown source、active prompt、fork guard、header mismatch、switch failure**

继续新增测试：

- `forkSession rejects unknown source session clearly`：期望 not found。
- `forkSession rejects active source prompts`：先 `createSessionWithId("source-session")`，再 `beginPrompt("source-session")`，fork 应抛 `RequestError.invalidParams(..., "Cannot fork a session with an active prompt")` 或等价 `-32602`，且不创建 fork 文件。
- `forkSession rejects prompt that races with source fork guard`：通过 `manager.beginForkSource("source-session")` 持有 guard，即使 guard 创建时源 session 尚未在 manager 中，后续同 id session 创建后，同源 `beginPrompt("source-session")` 也必须抛错；调用 guard `finish()` 后同源 prompt 可正常开始并 finish。
- `forkSession maps source helper errors to not found`：先准备一个可被 `findOmpSessionById()` 找到的有效源 session，再通过 handler options 注入 `forkSessionFile`，令其抛 `new OmpSessionForkSourceError("bad source")`；handler 必须返回 `RequestError.resourceNotFound(params.sessionId)`，不得变成 internal error。runtime helper 自身对 missing header、non-session header、id/cwd mismatch 的覆盖由任务 1 表驱动测试负责。
- `forkSession does not publish a fork when switch_session fails`：fake runtime 对 `switch_session` reject，之后 `manager.requireSession("fork-session")` 必须抛 unknown session，且 `findOmpSessionById("fork-session", { agentDir })` 返回 `undefined`。

- [ ] **步骤 4：实现 SessionManager 最小接口与源 fork guard**

在 `src/session/manager.ts` 添加：

```ts
readonly #activeForkSources = new Set<string>();

reserveSessionId(): string {
  return this.#idGenerator();
}

tryGetSession(sessionId: string): SessionRecord | undefined {
  return this.#sessions.get(sessionId);
}

beginForkSource(sessionId: string): { finish: () => void } {
  if (this.#activeForkSources.has(sessionId)) throw new SessionManagerError(`Session is already being forked: ${sessionId}`);
  const session = this.#sessions.get(sessionId);
  if (session?.activePrompt !== undefined) throw new SessionManagerError(`Session has an active prompt: ${sessionId}`);
  this.#activeForkSources.add(sessionId);
  return { finish: () => this.#activeForkSources.delete(sessionId) };
}
```

同时修改 `beginPrompt()`：在 `requireSession()` 后、设置 `activePrompt` 前，如果 `#activeForkSources.has(sessionId)`，抛 `SessionManagerError("Session is being forked: ...")`。`beginForkSource()` 必须对不存在于 manager 的历史 session 也登记 guard，覆盖 fork 期间并发 resume/load 后再 prompt 的竞态。`closeAll()` 必须清空 `#activeForkSources`。`tryGetSession()` 只能只读使用，不得让 handler 修改返回的 `SessionRecord`。

- [ ] **步骤 5：实现 `handleSessionFork()`**

创建 `src/acp/handlers/session-fork.ts`，导入 `RequestError`、`ForkSessionRequest`、`ForkSessionResponse`、`SessionManager`、`SessionManagerError`、`findOmpSessionById()`、`forkOmpSessionFile()`、`OmpSessionForkSourceError` 和 `rm`。`SessionForkHandlerOptions` 包含 `agentDir?: string` 和测试注入用 `forkSessionFile?: typeof forkOmpSessionFile`，生产默认使用真实 helper。流程：先调用 `manager.beginForkSource(params.sessionId)` 并在 `finally` 中释放 guard；如果该调用或 fork 期间同源 prompt/fork guard 冲突抛出 active-prompt/being-forked 类 `SessionManagerError`，映射为 `RequestError.invalidParams("Cannot fork a session with an active prompt")`；查找源 OMP session；生成 fork id；写 fork 文件；如果 `forkSessionFile()` 抛 `OmpSessionForkSourceError`，映射为 `RequestError.resourceNotFound(params.sessionId)`；调用 `createSessionWithId(forkId, params, beforePublish)`，其中 `beforePublish` 执行 `runtime.request("switch_session", { sessionPath: fork.path })`；如果 `createSessionWithId()` 或 `switch_session` 失败，必须删除本次独占创建的 `fork.path` 后重新抛错，避免 API 返回失败但 `session/list` 能看到 orphan fork；成功后返回 `{ sessionId: fork.sessionId }`。

- [ ] **步骤 6：运行 handler unit tests 验证通过**

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/session-fork.test.ts
```

预期：PASS。`switch_session` 失败测试还必须断言 `findOmpSessionById("fork-session", { agentDir })` 返回 `undefined`，证明失败 fork 不会留下可被 list/resume 发现的 JSONL。

- [ ] **步骤 7：接入 `package.json` 显式测试枚举**

当前 `package.json` 的 `test` 和 `check` 是两份独立显式列表。必须把 `test/unit/acp/session-fork.test.ts` 同时加入 `test` 脚本和 `check` 脚本，位置放在 `test/unit/acp/session-handlers.test.ts` 附近。

- [ ] **步骤 8：Commit handler 与测试枚举**

```bash
git add src/session/manager.ts src/acp/handlers/session-fork.ts test/unit/acp/session-fork.test.ts package.json
git commit -m "feat(acp): 添加 session fork handler"
```

---

## 任务 3：接入 ACP server、capability 与 unit 门禁

**文件：**
- 修改：`src/acp/server.ts`
- 修改：`src/acp/capabilities.ts`
- 修改：`test/unit/acp/initialize.test.ts`
- 修改：`test/smoke/acp-stdio.test.ts`
- 不修改：`package.json`（新增 fork 单测已在任务 2 接入 `test` 和 `check`）

- [ ] **步骤 1：先更新测试断言并验证失败**

在 `test/unit/acp/initialize.test.ts` 中把 fork 断言改成：

```ts
assert.deepEqual(capabilities?.sessionCapabilities?.fork, {});
assert.equal(Object.hasOwn(capabilities?.sessionCapabilities ?? {}, "close"), false);
```

在 `test/smoke/acp-stdio.test.ts` 中把 initialize smoke 的 fork 断言改成：

```ts
assert.equal(typeof result.agentCapabilities?.sessionCapabilities?.fork, "object");
```

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/initialize.test.ts test/smoke/acp-stdio.test.ts
```

预期：FAIL，原因是当前 `initialize` 尚未声明 fork。

- [ ] **步骤 2：接入 capability 和 server method**

在 `src/acp/capabilities.ts` 中：

```ts
sessionCapabilities: {
  list: {},
  resume: {},
  fork: {},
},
```

在 `src/acp/server.ts` 中导入类型与 handler：

```ts
type ForkSessionRequest,
import { handleSessionFork } from "./handlers/session-fork.ts";
```

在 `createOmpAcpAgent()` 返回对象中添加：

```ts
async unstable_forkSession(params: ForkSessionRequest) {
  return handleSessionFork(params, manager, handlerOptions);
},
```

不要声明 `closeSession`，不要改变 MCP/audio/permission/usage 能力。

- [ ] **步骤 3：确认测试枚举已接入**

检查 `package.json` 中 `test` 和 `check` 两个脚本都包含 `test/unit/acp/session-fork.test.ts`。如果缺失，停止并补齐；不要只改其中一个。

- [ ] **步骤 4：运行相关 unit/smoke 验证通过**

运行：

```bash
node --import tsx --test --test-concurrency=1 test/unit/acp/initialize.test.ts test/unit/acp/session-fork.test.ts test/smoke/acp-stdio.test.ts
```

预期：PASS。

- [ ] **步骤 5：保留改动进入任务 4，不单独提交**

不要在此处提交。此时 `initialize` 已声明 fork，但 smoke/probe 与文档尚未同步；为避免 `main` 上出现能力声明与验证/文档短暂不一致，任务 3、任务 4、任务 5 的改动必须作为一个 clean cutover 集成提交。

---

## 任务 4：补齐 headless smoke、SDK smoke 与 Registry-style probe

**文件：**
- 修改：`test/smoke/session-prompt.test.ts`
- 修改：`scripts/smoke-sdk-client.mjs`
- 修改：`scripts/probe-registry-matrix.mjs`

- [ ] **步骤 1：新增 JSON-RPC fork smoke 并验证通过**

在 `test/smoke/session-prompt.test.ts` 新增 serial smoke：

```ts
serialSmokeTest("session/fork clones an OMP session and allows prompt on the fork", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-acp-smoke-fork-agent-"));
  const cwd = repoRoot;
  await writeSmokeSession(agentDir, cwd, "fork-source", [
    { type: "session", id: "fork-source", cwd, timestamp: "2026-05-08T01:00:00.000Z", title: "Fork Source" },
    { type: "message", role: "user", content: "before fork", timestamp: "2026-05-08T01:01:00.000Z" },
  ]);

  await withAcpSubprocess("session-happy", async (acp) => {
    acp.send(initializeRequest(60));
    await acp.nextResponse(60);

    acp.send({ jsonrpc: "2.0", id: 61, method: "session/fork", params: { sessionId: "fork-source", cwd, mcpServers: [] } });
    const forkResponse = await acp.nextResponse(61);
    assert.equal(forkResponse.error, undefined);
    assert.equal(forkResponse.id, 61);
    const forkSessionId = (forkResponse.result as { sessionId: string }).sessionId;

    acp.send({ jsonrpc: "2.0", id: 62, method: "session/prompt", params: { sessionId: forkSessionId, prompt: [{ type: "text", text: "after fork" }] } });
    const promptUpdate = await acp.nextMessage();
    const promptResponse = await acp.nextResponse(62);
    assert.equal((promptUpdate.params as { sessionId?: string }).sessionId, forkSessionId);
    assert.equal(updateKind(promptUpdate), "agent_message_chunk");
    assert.equal(textFromUpdate(promptUpdate), "after fork");
    assert.equal(promptResponse.id, 62);
    assert.deepEqual(promptResponse.result, { stopReason: "end_turn" });
    assert.equal(acp.stderr, "");
  }, { OMP_ACP_AGENT_DIR: agentDir });
});
```

运行：

```bash
node --import tsx --test --test-concurrency=1 test/smoke/session-prompt.test.ts
```

预期：PASS。任务 1-3 已经实现 runtime helper、handler、server method 和 capability；此 smoke 是补充端到端验证，不再期待红灯。

- [ ] **步骤 2：更新 SDK client smoke**

在 `scripts/smoke-sdk-client.mjs` 中，在 list/resume 附近加入 fork 调用。方法名必须以 `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` 的实际 client 类型为准；如果 SDK client 暴露的是 `unstable_forkSession`，断言示例：

```js
const fork = await withRpcTimeout(client.unstable_forkSession({ sessionId: sourceSessionId, cwd: repoRoot, mcpServers: [] }), "session/fork");
assert.equal(typeof fork.sessionId, "string");
```

随后对 `fork.sessionId` 发送 prompt，断言收到 `agent_message_chunk` 和 `end_turn`。

- [ ] **步骤 3：更新 Registry-style probe**

在 `scripts/probe-registry-matrix.mjs` 中：

- capability expected 改为 `sessionFork: true`；
- `session/fork` expected outcome 改为 `success`；
- 使用预置 source session 执行 fork probe；
- 对 fork 后 session 发送 prompt，确认 forked session 可继续使用；
- summary 中记录 fork result。

- [ ] **步骤 4：运行 smoke/probe 验证通过**

运行：

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run validate:registry
```

预期：全部退出码 0。

- [ ] **步骤 5：保留 smoke/probe 改动进入任务 5，不单独提交**

不要在此处提交。任务 4 的 smoke/probe 与任务 5 的文档、最终验证一起形成 fork capability 的 clean cutover 集成提交。

---

## 任务 5：同步文档并执行除 Zed 外完整验证

**文件：**
- 修改：`docs/compatibility/capability-matrix.md`
- 修改：`docs/compatibility/acp-validation.md`
- 修改：`docs/compatibility/zed.md`
- 修改：`docs/release-checklist.md`
- 修改：`docs/superpowers/plans/2026-05-07-omp-acp-implementation.md`
- 修改：`README.md`

- [ ] **步骤 1：更新 capability matrix**

把 `session/fork` 行改为：

```md
| `session/fork` | 已实现 | 声明 `sessionCapabilities.fork:{}`；第一阶段支持按 ACP 标准从 source session head fork，不支持 OpenCode 私有 message-bound fork | `test/unit/acp/session-fork.test.ts` + `test/smoke/session-prompt.test.ts` + `scripts/probe-registry-matrix.mjs` |
```

同时确认 `session/close`、MCP、permission、filesystem、terminal、usage、audio 仍未声明。

- [ ] **步骤 2：更新验证文档**

在 `docs/compatibility/acp-validation.md` 中把 Registry-style probe 描述改为 fork supported：`session/fork` probe success，并说明 fork 正确性由新增 unit/smoke/registry probe 证明，`openclaw/acpx` 当前不证明 fork。

- [ ] **步骤 3：更新 Zed / release / README / 总体计划**

最小更新：

- `docs/compatibility/zed.md`：删除「`session/fork` 未声明」，补充「第一阶段 fork 从 source head fork」。
- `docs/release-checklist.md`：更新当前验证快照，保留 Zed GUI smoke 未执行。
- `README.md`：Stage 状态加入 `session/fork` 第一阶段能力。
- `docs/superpowers/plans/2026-05-07-omp-acp-implementation.md`：更新 Stage 6 旧边界或新增 Stage 8A 完成记录，避免继续说 fork 不支持。

- [ ] **步骤 4：运行完整自动验证**

运行：

```bash
npm run validate:standard
```

预期：退出码 0。若 `validate:acpx` 仍为 21 cases / 11 pass / 10 expected draft failures / 0 unexpected，文档中不得把它描述成 full pass。

- [ ] **步骤 5：Commit 集成改动和文档**

```bash
git add README.md docs/compatibility/capability-matrix.md docs/compatibility/acp-validation.md docs/compatibility/zed.md docs/release-checklist.md docs/superpowers/plans/2026-05-07-omp-acp-implementation.md src/acp/server.ts src/acp/capabilities.ts test/unit/acp/initialize.test.ts test/smoke/acp-stdio.test.ts test/smoke/session-prompt.test.ts scripts/smoke-sdk-client.mjs scripts/probe-registry-matrix.mjs
git commit -m "feat(acp): 完成 session fork 第一阶段能力"
```

---

## 最终审查与交付要求

- [ ] 至少 3 个只读 review 子代理并发审查实现结果。
- [ ] 每个新启动的 review 子代理提示词必须不少于 2000 字，并包含完整 plan 路径 `C:\Users\34404\source\repos\omp-acp\docs\superpowers\plans\2026-05-08-acp-session-fork-stage1-implementation.md`、完整 spec 路径 `C:\Users\34404\source\repos\omp-acp\docs\superpowers\specs\2026-05-08-acp-session-fork-stage1-design.md`、只读边界、不使用 worktree、不运行项目级命令的约束。
- [ ] 所有 blocker/major/important 反馈已修复并复审通过。
- [ ] `git status --short` 干净。
- [ ] 最终回复必须列出实际运行并观察到的验证命令，不得声称未运行的 Zed GUI smoke 已完成。

## 子代理并发建议

- 任务 1 可由一个子代理独立执行，范围只含 `sessions.ts` 与 `sessions.test.ts`。
- 任务 2 依赖任务 1 的 helper，应在任务 1 完成后执行。
- 任务 3 依赖任务 2 的 handler，应在任务 2 完成后执行。
- 任务 4 依赖任务 3 的 server/capability 接入，应在任务 3 完成后执行。
- 任务 5 依赖任务 4 的验证结果，应最后执行。

虽然当前设施支持并发写入，但本计划前 4 个任务有明确顺序依赖，不应并发修改同一能力链路。只读 review 可以 3 个以上并发运行。