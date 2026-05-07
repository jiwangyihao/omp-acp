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
| `initialize` | 已实现 | 只声明 conservative false capabilities；不声明额外能力 | `test/unit/acp/initialize.test.ts` + `test/smoke/acp-stdio.test.ts` |
| `session/new` | 未实现 | 不声明 | session smoke test |
| `session/prompt` text | 未实现 | 不声明 | prompt contract test |
| `session/cancel` | 未实现 | 不声明 | cancel race test |
| `session/list` | 未实现 | 不声明 | OMP session fixture test |
| `session/load` | 未实现 | 不声明 | OMP session fixture test |
| `session/close` | 未实现 | 不声明 | lifecycle contract test |
| `session/fork` | 未实现 | 不声明 | lifecycle contract test |
| `session/resume` | 未实现 | 不声明 | lifecycle contract test |
| `agent_message_chunk` | 未实现 | 不声明 | OMP event translation test |
| `agent_thought_chunk` | 未实现 | 不声明 | OMP event translation test |
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