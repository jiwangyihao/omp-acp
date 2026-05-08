# omp-acp v0.1.0

首个公开 npm / GitHub Release 版本。

## 许可证

- 本版本采用 Mozilla Public License 2.0 (MPL-2.0)。
- 已核对参考上游：`pi-acp`、OpenCode ACP 参考实现与 OMP coding agent 均为 MIT；`@agentclientprotocol/sdk` 为 Apache-2.0。未观察到阻止本项目采用 MPL-2.0 的上游许可证约束。

## 重点

- 提供独立 OMP-native ACP adapter，可通过 stdio 连接 ACP 客户端。
- 对齐真实 OMP RPC JSONL command/response contract。
- 支持 `session/new`、`session/list`、`session/load`、`session/resume` 与第一阶段 `session/fork`。
- 暴露保守的 session setup state：模型、thinking 和 default mode。
- 修复 prompt 生命周期：OMP RPC `prompt` response 只作为命令接收确认，ACP turn 会等到 runtime `agent_end` 后才返回，避免下一条消息打进仍 busy 的 OMP runtime。

## 能力边界

- `session/close`、MCP、文件系统和终端委托、权限请求 UX、命令执行、usage updates 与更完整的真实 OMP parity 仍未声明为支持能力。
- `session/fork` 不支持 message-bound fork 或 `_meta.messageId` / `_meta.messageID`。
- `openclaw/acpx` 是第三方 draft assessment，不是官方完整 conformance suite；expected draft failures 不是 full pass。
- Zed GUI 手工 smoke 未在自动化发布门禁中声明为已完成。

## 验证

- `npm run check`
- `npm run smoke:acp`
- `npm run smoke:sdk-client`
- `npm run smoke:omp-rpc-controls`
- `npm run validate:registry`
- `npm run validate:acpx`
- `npm pack --dry-run --json`
