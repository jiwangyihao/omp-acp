# OMP ACP 能力矩阵

本文档记录 `omp-acp` 对 ACP 能力的真实支持状态。`initialize` 输出必须与本表一致；没有实现和测试的能力不得声明。

## 状态说明

| 状态 | 含义 |
|---|---|
| 未实现 | adapter 当前没有实现该能力 |
| 待验证 | OMP runtime 可能支持，但 adapter 尚未完成 contract test |
| 已实现 | adapter 已实现并有自动化测试覆盖 |
| 不支持 | OMP runtime 或 ACP client 语义当前无法支持 |

## 当前矩阵

| 能力 | 当前状态 | 声明策略 | 验证要求 |
|---|---|---|---|
| ACP stdio transport | 已实现 | 内部可用；发布仍需后续阶段 | `test/smoke/acp-stdio.test.ts` |
| `initialize` | 已实现 | 声明已实现的 baseline session/new + text/resource_link prompt；optional `promptCapabilities.image/audio/embeddedContext` 仍为 `false`，`loadSession`/MCP/session lifecycle 仍不声明或为 `false` | `test/unit/acp/initialize.test.ts` + smoke tests |
| `session/new` | 已实现 | baseline ACP method 可用；不声明 session list/load/resume/fork/close | `test/smoke/session-prompt.test.ts` |
| `session/prompt` text/resource_link | 已实现 | baseline text 与 resource_link 可用；image/audio/embedded context 不声明 | `test/unit/translate/prompt.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/cancel` | 已实现 | baseline ACP notification 可用；best-effort 传递 runtime cancel 并本地抑制 late chunks | `test/unit/acp/session-handlers.test.ts` + `test/smoke/session-prompt.test.ts` |
| `session/list` | 未实现 | 不声明 | OMP session fixture test |
| `session/load` | 未实现 | 不声明 | OMP session fixture test |
| `session/close` | 未实现 | 不声明 | lifecycle contract test |
| `session/fork` | 未实现 | 不声明 | lifecycle contract test |
| `session/resume` | 未实现 | 不声明 | lifecycle contract test |
| `agent_message_chunk` | 已实现 | runtime `message_update` 文本输出映射为 ACP message chunk | `test/unit/translate/events-message.test.ts` + `test/smoke/session-prompt.test.ts` |
| `agent_thought_chunk` | 已实现 | runtime thought/reasoning 标记映射为 ACP thought chunk | `test/unit/translate/events-message.test.ts` + `test/smoke/session-prompt.test.ts` |
| `tool_call` | 未实现 | 不声明 | tool event contract test |
| `tool_call_update` | 未实现 | 不声明 | tool event contract test |
| Structured edit diff | 未实现 | 不声明 | diff unit test + smoke edit |
| Image prompt | 待验证 | 不声明 | OMP prompt contract test |
| Embedded context | 待验证 | 不声明 | ACP content block conversion test |
| MCP HTTP | 未实现 | 不声明 | real MCP integration test |
| MCP SSE | 未实现 | 不声明 | real MCP integration test |
| Permission request | 未实现 | 不声明 | allow/deny/timeout tests |
| Filesystem delegation | 未实现 | 不声明 | Zed delegation smoke test |
| Terminal delegation | 未实现 | 不声明 | Zed delegation smoke test |
| Usage update | 待验证 | 不声明 | OMP usage event fixture test |
| OMP slash commands | 未实现 | 不声明 | command discovery fixture test |
| OMP skills commands | 未实现 | 不声明 | skills fixture test |
| `omp.extensions` commands | 未实现 | 不声明 | extension manifest fixture test |

## 更新规则

每次把能力从「未实现」或「待验证」改为「已实现」时，必须同时提交：

1. 实现代码；
2. 对应自动化测试；
3. `initialize` 能力声明变更；
4. 本表状态更新；
5. 如涉及用户可见行为，同步更新 README 或 Zed 兼容文档。