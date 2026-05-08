# OMP ACP 实现方案与阶段计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐阶段实现此计划。阶段使用复选框（`- [ ]`）语法跟踪进度。每个阶段必须先补测试，再写实现；不得声明未实现能力。

**目标：** 构建一个独立的 `omp-acp`，让 OMP 通过 Agent Client Protocol（ACP）在 Zed 等编辑器中稳定运行，并逐步达到 OpenCode ACP 的成熟度。

**架构：** 项目不 fork `pi-acp` 作为长期主干。实现采用「ACP 协议层 → 会话编排层 → OMP runtime adapter → OMP RPC client」分层结构；`pi-acp` 只作为参考实现和可选择移植的补丁来源，OpenCode ACP 作为成熟度标杆。

**技术栈：** Node.js >= 20、TypeScript、`@agentclientprotocol/sdk`、`node:test`、JSON-RPC over stdio、OMP JSONL RPC（`omp --mode rpc`）。

---

## 1. 设计原则

### 1.1 Clean cutover

`omp-acp` 是独立实现，不以持续 merge `pi-acp` 为目标。`pi-acp` 后续变更只在满足以下条件时吸收：

- 属于 ACP / Zed 通用兼容修复；
- 属于 session update、tool call、structured diff 等协议通用行为修复；
- 可以先转化为 OMP contract test；
- 不引入 Pi config、Pi sessionDir、`pi.extensions` 或 Pi runtime 语义。

### 1.2 Capability truthful

ACP `initialize` 只声明已经实现并测试过的能力。未实现或半实现能力不得为了「看起来完整」而提前声明。

能力声明分 3 类：

| 类别 | 策略 |
|---|---|
| 已实现且有测试 | 在 `initialize` 中声明 |
| OMP 支持但 adapter 未接通 | 不声明，在文档中列入待实现 |
| OMP 不支持或语义不确定 | 不声明，并记录原因 |

### 1.3 错误必须像错误

runtime crash、RPC parse error、tool failure、permission denial、user cancel 都必须映射成可区分的 ACP 错误或 session update。禁止把失败包装成普通 assistant message。

### 1.4 先做 OMP-native，再做兼容层

以下逻辑必须以 OMP 为准：

- `omp --mode rpc` 启动、ready frame、请求和响应；
- `.omp`、`.claude` 等 OMP 配置发现；
- OMP session 目录和 session 元数据；
- `omp.extensions`、skills、slash commands；
- OMP host tool call、host tool cancel、extension UI request。

Pi 行为只能作为对照，不能作为默认假设。

---

## 2. 目标架构

```text
Editor / ACP Client（Zed、JetBrains、Avante.nvim）
        |
        | JSON-RPC 2.0 over stdio
        v
src/acp/transport/*
        | 负责 stdio、request/notification、错误边界
        v
src/acp/handlers/*
        | initialize、session/new、session/prompt、cancel、list/load/close/fork/resume
        v
src/session/*
        | ACP session 状态机、队列、取消、usage、diagnostics
        v
src/runtime/RuntimeAdapter.ts
        | runtime-neutral 接口
        v
src/runtime/omp/*
        | OMP RPC process、JSONL protocol、config、commands、sessions
        v
omp --mode rpc
```

### 2.1 目录规划

```text
src/
  index.ts                         # CLI 入口，启动 ACP server
  acp/
    transport/stdio.ts             # JSON-RPC stdio transport
    server.ts                      # ACP server 组合根
    capabilities.ts                # truthful capability builder
    handlers/
      initialize.ts
      session-new.ts
      session-prompt.ts
      session-cancel.ts
      session-list.ts
      session-load.ts
      session-close.ts
      session-fork.ts
      session-resume.ts
  runtime/
    RuntimeAdapter.ts              # runtime-neutral contract
    RuntimeEvents.ts               # runtime event union
    omp/
      command.ts                   # 已存在：构造 `omp --mode rpc`
      process.ts                   # 子进程生命周期
      rpc-client.ts                # JSONL request/response/event client
      frames.ts                    # OMP RPC frame schema 和 parser
      prompt.ts                    # ACP prompt -> OMP request
      sessions.ts                  # OMP session list/load
      commands.ts                  # OMP slash/skill/extension commands
      config.ts                    # OMP config discovery
  translate/
    prompt.ts                      # ACP content blocks -> OMP prompt
    events.ts                      # OMP events -> ACP sessionUpdate
    tools.ts                       # tool call/update translation
    diffs.ts                       # structured edit diff translation
    errors.ts                      # runtime errors -> ACP errors
  session/
    manager.ts                     # session map、queue、lifecycle
    cancellation.ts                # cancel token 与 runtime cancel bridge
    diagnostics.ts                 # transcript/debug metadata
  testing/
    script-rpc-process.ts          # 测试用真实 subprocess fixture
```

```text
test/
  unit/
    acp/
    runtime/omp/
    translate/
    session/
  contract/
    omp-rpc/
      fixtures/*.jsonl             # 真实或最小化 OMP RPC transcript
      *.test.ts
  smoke/
    acp-stdio.test.ts              # 启动 dist/index.js 做 stdio smoke
    real-omp.test.ts               # 可选，检测本机有 omp 后运行
scripts/
  smoke-acp.mjs                    # 手工/CI smoke driver
docs/
  references/                      # 已存在：pi-acp、OpenCode 参考记录
  compatibility/                   # capability matrix、Zed 配置、已知限制
```

---

## 3. 测试策略

### 3.1 单元测试

覆盖纯函数和状态机：

- capability builder；
- OMP frame parser；
- ACP prompt 到 OMP prompt 的转换；
- OMP event 到 ACP update 的转换；
- structured diff 生成；
- session queue 和 cancellation 状态。

### 3.2 Contract tests

用 JSONL transcript 固定 OMP RPC 行为。测试必须验证：

- ready frame 之前不发送 prompt；
- response 与 event 可以交错；
- malformed frame 会产生明确错误；
- runtime exit 会通知等待中的 request；
- cancel 后不会继续把过期 event 写入 active session。

### 3.3 Subprocess fixture tests

需要模拟 OMP 子进程时，不用内存 mock。使用真实 Node subprocess 运行 fixture script，通过 stdin/stdout JSONL 交互，覆盖 Windows 引号、stdio buffering 和进程退出行为。

### 3.4 Smoke tests

每个可运行里程碑至少保留一个 smoke：

```bash
npm run build
node scripts/smoke-acp.mjs
```

真实 OMP smoke 只有在本机检测到 `omp` 时运行；否则跳过并输出 `SKIP: omp executable not found`，不能伪造通过。

---

## 4. 主要自治阶段

每个阶段都应能由独立代理执行。阶段之间只通过明确接口交付，不共享未记录假设。

### 阶段 0：项目基线与参考资料

**状态：** 已完成。

**目标：** 建立独立仓库、测试基线和参考资料边界。

**文件：**

- 已创建：`package.json`
- 已创建：`tsconfig.json`
- 已创建：`.gitignore`
- 已创建：`.gitattributes`
- 已创建：`README.md`
- 已创建：`docs/references/pi-acp.md`
- 已创建：`docs/references/opencode-acp.md`
- 已创建：`src/runtime/omp/command.ts`
- 已创建：`test/runtime/omp/command.test.ts`
- 已创建：`docs/compatibility/capability-matrix.md`

**验收标准：**

- [x] `npm run check` 通过；
- [x] README 明确项目不是 `pi-acp` 长期 fork；
- [x] capability matrix 明确初始能力全部为未实现或待验证；
- [x] `private: true` 保留，直到完成真实 ACP server 和 smoke test。

### 阶段 1：ACP stdio transport 与 initialize

**状态：** 已完成。README 与 capability matrix 已同步记录 ACP stdio transport 和 `initialize` 为已实现；本阶段仍不代表完整可用的 ACP agent。

**目标：** 让 `omp-acp` 能作为 ACP subprocess 启动，完成 JSON-RPC stdio 握手和 truthful `initialize`。

**自治边界：** 本阶段不启动 OMP，不处理 prompt，只实现 ACP 外壳和能力声明。

**文件：**

- 新增：`src/index.ts`
- 新增：`src/acp/transport/stdio.ts`
- 新增：`src/acp/server.ts`
- 新增：`src/acp/capabilities.ts`
- 新增：`src/acp/handlers/initialize.ts`
- 新增：`test/unit/acp/initialize.test.ts`
- 新增：`test/smoke/acp-stdio.test.ts`

**核心行为：**

- 通过 `src/acp/transport/stdio.ts` 的薄封装读取 stdin JSON-RPC request；该封装内部只调用 SDK `ndJsonStream`，不得自定义解析或分发；
- 写出 stdout JSON-RPC response / notification；
- stderr 只用于 diagnostics，不污染 stdout；
- `initialize` 返回最小 truthful capability set；
- 不支持的方法返回 JSON-RPC method-not-found，不静默成功。

**验收标准：**

- [x] `node --import tsx src/index.ts` 可启动并等待 stdin；
- [x] smoke test 发送 `initialize` 后收到合法 JSON-RPC response；
- [x] `initialize` 不声明 MCP、session fork/resume/close、filesystem、terminal 等未实现能力；
- [x] malformed JSON 不污染 stdout，且连接在随后合法 `initialize` 后仍可用；该行为有测试覆盖。

### 阶段 2：OMP RPC client 与进程生命周期

**状态：** 已完成。已交付 OMP RPC frame parser、runtime event 类型、process wrapper、JSONL RPC client、真实 subprocess fixture 和 contract tests；本阶段仍不接入 ACP session/prompt。

**目标：** 建立可靠的 `omp --mode rpc` client，处理 ready、request/response、异步 event、stderr、exit 和 cancellation 基础设施。

**自治边界：** 本阶段不做 ACP prompt 语义，只交付 runtime client API 和事件流。

**文件：**

- 修改：`src/runtime/omp/command.ts`
- 新增：`src/runtime/RuntimeAdapter.ts`
- 新增：`src/runtime/RuntimeEvents.ts`
- 新增：`src/runtime/omp/process.ts`
- 新增：`src/runtime/omp/rpc-client.ts`
- 新增：`src/runtime/omp/frames.ts`
- 新增：`src/testing/script-rpc-process.ts`
- 新增：`test/unit/runtime/omp/frames.test.ts`
- 新增：`test/contract/omp-rpc/rpc-client.test.ts`

**核心行为：**

- 默认启动命令为 `omp --mode rpc`；
- 等待 `{ "type": "ready" }` 后才允许发送请求；
- stdout 按 JSONL frame 解析；
- request id 与 response 精确匹配；
- `agent_start`、`message_update`、`host_tool_call`、`extension_error` 等作为 runtime event 输出；
- 子进程异常退出时，所有 pending request 失败；
- stderr 纳入 diagnostics，不污染 ACP stdout。

**验收标准：**

- [x] ready 前发送请求会被排队或明确失败；
- [x] malformed JSONL frame 有测试覆盖；
- [x] response/event 交错顺序有测试覆盖；
- [x] process exit 会 reject pending request；
- [x] Windows 路径 executable 配置有测试覆盖。

### 阶段 3：session/new、session/prompt 与消息流

**状态：** 已完成。已交付 session manager、prompt/resource_link 转换、message/thought event 转换、session/new/prompt/cancel handlers、runtime fixture seam、session prompt smoke tests 与 cwd 传递修复；tool/edit/commands 仍留到后续阶段。

**目标：** 实现最小可用会话：Zed 可创建新 thread，发送 prompt，并看到 OMP message/thought stream。

**自治边界：** 本阶段只处理文本 prompt、消息流和取消。tool、edit、commands 暂不完整映射。

**文件：**

- 新增：`src/session/manager.ts`
- 新增：`src/session/cancellation.ts`
- 新增：`src/translate/prompt.ts`
- 新增：`src/translate/events.ts`
- 新增：`src/translate/errors.ts`
- 新增：`src/acp/handlers/session-new.ts`
- 新增：`src/acp/handlers/session-prompt.ts`
- 新增：`src/acp/handlers/session-cancel.ts`
- 新增：`test/unit/translate/prompt.test.ts`
- 新增：`test/unit/translate/events-message.test.ts`
- 新增：`test/unit/session/manager.test.ts`
- 新增：`test/smoke/session-prompt.test.ts`

**核心行为：**

- ACP text content 转为 OMP RPC prompt；
- OMP agent message 映射为 `agent_message_chunk`；
- OMP thought 映射为 `agent_thought_chunk`；
- prompt lifecycle 有 started/completed/failed/cancelled 终态；
- 用户取消会传递到 OMP RPC cancel 能力；若 OMP 不支持对应 cancel，则明确返回不可取消或本地停止转发。

**验收标准：**

- [x] 新 session 可接受一个文本 prompt；
- [x] message chunk 与 thought chunk 不混流；
- [x] runtime error 不会伪装为 assistant message；
- [x] cancel 后不会继续向已取消 prompt 推送普通完成事件；
- [x] `initialize` 只在本阶段完成后声明对应 prompt 能力。

### 阶段 4：tool call、edit diff 与 host tool bridge

**目标：** 补齐 coding agent 的核心可用性：工具调用、工具状态更新、文件编辑 diff、host tool call/cancel。

**自治边界：** 本阶段不实现 MCP HTTP/SSE，不实现 terminal/filesystem delegation 的完整 ACP 版本；只忠实映射 OMP runtime 已经发出的 tool/edit 事件。

**文件：**

- 新增：`src/translate/tools.ts`
- 新增：`src/translate/diffs.ts`
- 新增：`src/runtime/omp/host-tools.ts`
- 修改：`src/translate/events.ts`
- 修改：`src/runtime/RuntimeAdapter.ts`
- 修改：`src/runtime/omp/rpc-client.ts`
- 修改：`src/acp/handlers/session-prompt.ts`
- 修改：`src/acp/server.ts`
- 扩展：`src/testing/script-rpc-process.ts`
- 新增：`test/unit/translate/tools.test.ts`
- 新增：`test/unit/translate/diffs.test.ts`
- 新增：`test/unit/runtime/omp/host-tools.test.ts`
- 新增：`test/contract/omp-rpc/tool-events.test.ts`
- 扩展：`test/unit/acp/session-handlers.test.ts`
- 扩展：`test/smoke/session-prompt.test.ts`
**核心行为：**

- OMP tool start/update/end 映射为 ACP `tool_call` / `tool_call_update`；
- 编辑类工具产生 structured diff，而不是纯文本说明；
- tool location 包含 file path 和 line hint；
- host tool call 需要清晰区分「由 OMP 执行」和「需要 ACP client delegation」；
- host tool cancel 可传递取消，不能吞掉取消失败。

**验收标准：**

- [x] 成功 tool、失败 tool、取消 tool 都有测试；
- [x] edit diff 覆盖 create、modify、delete、rename 或明确记录不支持项；
- [x] 文件路径在 Windows 与 POSIX 风格下都不损坏；
- [x] tool failure 会成为可见失败状态，不是普通文本 chunk。

### 阶段 5：OMP session、config、commands 与 extension 集成

**目标：** 让 adapter 具备 OMP-native 体验：session list/load、配置发现、slash commands、skills、`omp.extensions`。

**自治边界：** 本阶段只读取 OMP 现有配置和命令；不改变 OMP 配置，不安装插件。

**文件：**

- 新增：`src/runtime/omp/config.ts`
- 新增：`src/runtime/omp/sessions.ts`
- 新增：`src/runtime/omp/commands.ts`
- 新增：`src/acp/handlers/session-list.ts`
- 新增：`src/acp/handlers/session-load.ts`
- 新增：`test/unit/runtime/omp/config.test.ts`
- 新增：`test/unit/runtime/omp/sessions.test.ts`
- 新增：`test/unit/runtime/omp/commands.test.ts`
- 新增：`test/unit/acp/session-list-load.test.ts`
- 新增：`docs/compatibility/zed.md`

**核心行为：**

- OMP config discovery 遵循 OMP 规则，不复用 Pi 的 sessionDir 假设；
- session list/load 能读取 OMP session metadata；
- slash commands 区分 built-in、file-based、skills、extension commands；
- unsupported command 返回明确错误；
- `/clear` 等特殊命令要么实现，要么不暴露。

**验收标准：**

- [x] `session/list` 与 `session/load` 有 fixture 覆盖；
- [x] `.omp` 与 `.claude` 相关发现规则有测试；
- [x] `omp.extensions` manifest discovery 有测试；
- [x] 未支持的 extension UI request 不会被静默丢弃；
- [x] 文档给出 Zed 配置和当前限制。

### 阶段 6：OpenCode parity 功能层

**目标：** 补齐 OpenCode ACP 成熟能力：MCP、permissions、session close/fork/resume、embedded context、image prompt、usage update。

**自治边界：** 每个能力必须单独开发、单独更新 capability matrix。不能一次性声明「OpenCode parity」。

**子阶段：**

- [x] **6A：session lifecycle**
  - 实现：`session/resume`（switch OMP session path, no history replay）。
  - 不声明：`session/fork`（ACP request 与 OMP branch/new-session 语义不足以保证等价 fork）、`session/close`（SDK 0.21.0 已有 agent-side method，但 adapter 尚无可防御的 OMP close 语义）。
- [x] **6B：embedded context 与 image prompt**
  - 文件：`src/translate/prompt.ts`
  - 验收：text、resource_link、image、embedded text/blob context 均有转换测试；audio/unknown resource 返回明确错误。
- [x] **6C：MCP HTTP/SSE**
  - 决策：不声明；尚无测试过的 OMP RPC/launch contract 将 ACP HTTP/SSE MCP server 接入 runtime session。
- [x] **6D：permission request**
  - 决策：不声明；尚无 OMP runtime permission request event/policy contract。
- [x] **6E：usage update**
  - 决策：不声明/不伪造；SDK 0.21.0 已有 usage update session update 类型，但 OMP usage event 未 contract-tested。

### 阶段 7：Zed smoke、发布准备与回归矩阵

**目标：** 从「能跑」进入「可发布」。

**自治边界：** 本阶段不新增核心协议能力，只做验证、文档、打包、发布门禁。

**文件：**

- 新增：`scripts/smoke-acp.mjs`
- 新增：`scripts/smoke-zed.md`
- 修改：`docs/compatibility/capability-matrix.md`
- 新增：`docs/release-checklist.md`
- 修改：`README.md`
- 修改：`package.json`

**发布前门禁：**

- [x] `npm run check` 通过；
- [x] `npm run build` 通过；
- [x] stdio smoke 通过（`npm run smoke:acp`）；
- [x] 真实 `omp --mode rpc` ready smoke 通过（`omp/14.7.6`）；
- [ ] Zed 手工 smoke 覆盖：new thread、prompt、tool call、edit diff、cancel、session list/load（已安装隔离用官方 Zed 1.1.6；GUI 手工步骤尚未执行，见 `docs/release-checklist.md`）；
- [x] capability matrix 与实际 `initialize` 输出一致；
- [x] `private: true` 只在决定发布时移除；
- [x] README 不包含未发布 npm 包的误导性 `npx -y omp-acp` 指令。

---

## 5. 并行化建议

阶段 1 和阶段 2 可以并行：

- 阶段 1 以 fake runtime adapter 验证 ACP transport；
- 阶段 2 以 subprocess fixture 验证 OMP RPC client；
- 合并点是 `RuntimeAdapter` 接口。

阶段 3 必须等待阶段 1 和阶段 2 的接口稳定。

阶段 4 和阶段 5 可以在阶段 3 后并行：

- 阶段 4 关注 runtime event 到 ACP update；
- 阶段 5 关注 OMP config/session/commands；
- 两者都不应修改 ACP transport。

阶段 6 必须按能力逐项实现，不能并行修改同一个 capability builder。阶段 7 必须最后执行。

---

## 6. 风险与控制

| 风险 | 控制 |
|---|---|
| ACP stdout 被日志污染 | 所有 diagnostics 走 stderr 或文件；stdout 只允许 JSON-RPC |
| OMP RPC frame 与 Pi 不完全一致 | 先写 OMP contract test，再映射，不复用 Pi 假设 |
| 取消语义竞态 | session manager 记录 prompt generation，过期 event 丢弃并计入 diagnostics |
| tool failure 被伪装成功 | tool 状态必须有 success/failure/cancelled 终态 |
| capability 提前声明 | capability matrix 与 initialize test 双向校验 |
| Windows 启动失败 | command builder、subprocess fixture、路径测试必须覆盖 Windows 风格路径 |
| 上游参考代码污染 OMP 语义 | 所有参考移植必须先写 OMP 测试，不做 wholesale merge |

---

## 7. 当前下一步

阶段 1 至阶段 6 已完成。阶段 7 的自动化发布门禁、build-output smoke、真实 OMP RPC ready smoke 和发布文档已完成；隔离用官方 Zed 1.1.6 已安装，但 Zed 手工 smoke 仍需按 `scripts/smoke-zed.md` 在 GUI 中执行。