# omp-acp v0.1.1

补丁版本，聚焦 Zed/ZedG 可用性与历史回放稳定性。

## 重点

- 修复 ACP prompt 生命周期竞态：OMP `prompt` RPC ACK 不再被当作 turn 完成，adapter 会等待 `agent_end` 和 runtime idle 后再返回 `end_turn`，避免下一条 prompt 打入仍 busy 的 OMP runtime。
- 补齐 ACP `messageId` 回显语义：`PromptRequest.messageId` 会作为 `PromptResponse.userMessageId` 回显，但不参与调度、队列或中断语义。
- 修复 OMP 历史 `fileMention` 等非聊天角色导致的 loadSession 回放失败；只回放安全路径信息，不暴露文件内容或 provider-private/raw/internal 内容。
- 新增 OMP `todo_write` → ACP `plan` 同步，实时工具结果和历史 `toolResult` 都会同步任务状态；空 TODO 会发送 `entries: []` 清空客户端旧计划。
- 保持 OMP `ask` 工具禁用边界，同时不使用静态 `--tools` allowlist，保留 OMP 设置、插件、扩展、MCP 和未来工具发现行为。

## 能力边界

- ACP SDK 固定为 `@agentclientprotocol/sdk@0.21.0`。
- 普通并发 ACP `session/prompt` 由 adapter 内部排队，在前一个 prompt 清理完成后作为新的独立 OMP `prompt` 发送；不映射为 OMP `follow_up`。
- ACP 0.21.0 没有标准的 follow-up、queue、steer 或「中断并替换 prompt」原语；客户端可用 `session/cancel` + 下一次 `session/prompt` 近似中断。
- `confirm` 仍映射为 ACP `session/request_permission`；`setWidget` 显示为 thought/progress 文本；`select`、`input`、`editor` 和广义 elicitation 仍未声明支持。
- 本版本不声明官方 ACP full conformance。`openclaw/acpx` 是第三方 draft assessment，不是官方完整一致性证明。
- Zed/ZedG GUI 手工 smoke 仍需用户本地执行；自动发布门禁不声称 GUI 手工验证已完成。

## 发布门禁

本地发布前已重新验证：

- `npm run check`
- `npm run build`
- `npm run smoke:omp-rpc-controls:required`
- `git diff --check`
- 多轮只读代码审查

GitHub Release workflow 会在发布时继续运行：

- `npm run check`
- `npm run smoke:acp`
- `npm run smoke:sdk-client`
- `npm run validate:registry`
- `npm run validate:acpx`
- `npm pack --dry-run --json`

## 升级提示

Zed / ZedG 中已运行的 `omp-acp-local` agent/session 不会热加载新的 `dist/index.js` 或 npm 包版本。升级后请重启或 reload 对应 agent/session。
