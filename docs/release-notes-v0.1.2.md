# omp-acp v0.1.2 Release Notes

> Released 2026-05-12. npm package availability depends on the GitHub release publishing workflow for `v0.1.2`.

## Highlights

- Adds ACP Terminal Auth advertisement for clients and Registry checks that explicitly support terminal authentication setup.
  - The adapter returns `authMethods` only when the client opts in through ACP auth terminal support or the Registry-style `_meta["terminal-auth"]` signal.
  - Default clients that do not opt in still do not receive `authMethods`.
- Adds `omp-acp --setup`, a terminal setup/check guide for local Oh My Pi credentials and models.
  - Published package path: `npx -y omp-acp --setup`.
  - Local checkout path: `node dist/index.js --setup` after `npm run build`.
  - The setup flow checks OMP RPC startup and whether OMP can discover usable models.
  - If no model is available, it points users to provider environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or to `~/.omp/agent/models.yml`.
  - Set `OMP_ACP_SETUP_READY_TIMEOUT_MS` if local OMP startup takes longer than the default setup probe window.
- Keeps provider secrets outside the adapter.
  - The setup flow does not ask for, store, or print provider API keys, tokens, base URLs, or raw provider configuration.
  - Terminal Auth is a setup/check guide, not an Agent-managed OAuth callback flow.
- Aligns local Registry-style validation with the Terminal Auth signal while keeping the boundary clear.
  - `npm run validate:registry` is still a local approximation, not the official ACP Registry CI.
  - ACP Registry listing is still pending until the registry PR is prepared, validated, submitted, and merged.
- Fixes active-turn prompt handling to match OMP-native steering semantics.
  - A new ACP `session/prompt` received while an owner prompt is active now maps to OMP RPC `steer` instead of replacing the owner turn.
  - The owner prompt keeps the runtime event lifecycle until `agent_end`; the steered ACP prompt returns after the `steer` acknowledgement.
  - `abort_and_prompt` remains a recovery path for OMP busy-state divergence, not the normal active-turn mapping.
  - Explicit `session/cancel` continues to use OMP RPC `abort`.

## Compatibility notes

- ACP stdio server mode still reserves stdout for JSON-RPC / NDJSON frames only.
- Active-turn `session/prompt` now follows OMP steer semantics; clients that send concurrent prompts should expect the owner ACP prompt to continue receiving runtime updates until the underlying OMP turn ends.
- `authenticate({ methodId: "omp-setup" })` acknowledges the declared setup method; it does not launch setup or handle secrets inside the ACP server process.
- Environment-variable-only authentication is documented as OMP configuration guidance, not as the Registry-qualified auth method.

## 中文摘要

- 新增 ACP Terminal Auth 设置入口，用于 Registry / 客户端支持的终端认证设置流程；默认客户端不声明 terminal auth 支持时，仍不会收到 `authMethods`。
- 新增 `omp-acp --setup`，用于检查 OMP RPC 是否可启动、是否能发现可用模型，并引导配置本地 OMP 模型认证。
- 无可用模型时，setup 会提示配置 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 或 `~/.omp/agent/models.yml`。
- `omp-acp --setup` 只检查并引导本地 OMP 模型认证配置，不收集、不保存、不打印 provider API key，也不会自动完成 provider 登录。
- 活跃 ACP prompt 期间收到新的 `session/prompt` 时，现在映射为 OMP `steer`，不再默认替换 owner turn；显式 `session/cancel` 仍使用 OMP `abort`。
- 当前还不能声称已进入官方 ACP Registry；是否收录以 registry PR 准备、验证、提交并合并为准。
