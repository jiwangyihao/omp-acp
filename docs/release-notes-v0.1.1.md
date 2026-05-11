# omp-acp v0.1.1

Patch release focused on Zed/ZedG usability, prompt lifecycle correctness, safer OMP history replay, and TODO plan synchronization.

## Highlights

- Fixed the ACP prompt lifecycle race that could make Zed believe generation had ended while OMP was still cleaning up the turn.
  - OMP RPC `prompt` responses are treated as command-acceptance ACKs only.
  - ACP `session/prompt` now waits for OMP `agent_end` plus runtime idle state before returning `stopReason: "end_turn"`.
  - Ordinary concurrent ACP prompts are held until the active OMP turn has fully cleaned up, then sent as independent new OMP prompts.
  - Cancelled prompts also wait for bounded runtime cleanup before the next prompt is allowed through.
- Added ACP `messageId` echo support.
  - `PromptRequest.messageId` is returned as `PromptResponse.userMessageId` for normal and cancelled prompts.
  - `messageId` is explicitly not used for prompt scheduling, queueing, or interrupt semantics.
- Fixed real OMP history replay for non-chat roles such as `fileMention`.
  - `fileMention` history no longer fails `session/load` with `Unsupported OMP message role`.
  - Only safe file path/URI/name information is replayed; file contents and provider-private/raw/internal fields are skipped.
  - Unknown or unsafe history blocks are skipped or sanitized instead of breaking the entire load operation.
- Added OMP TODO state synchronization.
  - Runtime `todo_write` results emit ACP `plan` updates.
  - Historical `todo_write` tool results replay as ACP `plan` updates.
  - Empty TODO state emits `entries: []`, allowing clients to clear stale plans.
- Preserved the OMP `ask` disablement boundary without a static `--tools` allowlist.
  - Default runtime launch still injects the adapter extension to remove only broad `ask`.
  - Session setup also removes active `ask` from `dumpTools` when available.
  - OMP settings-derived tools, extension/plugin tools, MCP tools, and future tool discovery remain available.
- Hardened release automation.
  - Removed the GitHub runner npm self-upgrade step that could corrupt the runner npm install.
  - Switched the release workflow to Node 24 with `actions/setup-node@v6` for the npm Trusted Publishing path.

## Capability boundary

- ACP SDK remains pinned to `@agentclientprotocol/sdk@0.21.0`.
- ACP 0.21.0 has no standard follow-up, queue, steer, or single-step interrupt-and-replace prompt primitive.
  - Clients can approximate interruption with `session/cancel` followed by a new `session/prompt`.
  - Ordinary concurrent ACP prompts are adapter-queued and sent as independent OMP prompts; they are not mapped to OMP `follow_up`.
- OMP `confirm` remains the only interactive request bridged to ACP `session/request_permission`.
- OMP `setWidget` is displayed as ACP thought/progress text.
- OMP `select`, `input`, `editor`, and broad Ask/elicitation flows remain unsupported and undeclared.
- OMP-specific runtime knobs are still hidden from ACP `configOptions`: steering mode, follow-up mode, interrupt mode, auto compaction, sampling controls, provider config, base URLs, secrets, and tool/MCP toggles.
- This release does not claim official ACP full conformance. `openclaw/acpx` is a third-party draft assessment, not an official conformance suite or full-pass claim.
- Zed/ZedG GUI smoke remains a manual/local gate and is not claimed as completed by the automated release workflow.

## Verification

Local release verification included:

- `npm run validate:standard`
  - `npm run check`
  - `npm run smoke:acp`
  - `npm run smoke:sdk-client`
  - `npm run smoke:omp-rpc-controls:required`
  - `npm run validate:registry`
  - `npm run validate:acpx`
- `npm pack --dry-run --json`
- `git diff --check`
- Read-only review passes for the prompt lifecycle, history replay, TODO plan synchronization, and release/readme changes.

GitHub Release workflow for `v0.1.1` completed successfully and published `omp-acp@0.1.1` to npm through Trusted Publishing.

## Upgrade notes

Existing Zed / ZedG `omp-acp` agent processes do not hot-reload a new `dist/index.js` or npm package version. After upgrading, restart or reload the configured agent/session.

If you previously configured a local checkout, rebuild it with `npm run build` and make sure Zed points to the rebuilt `dist/index.js`.

## 中文摘要

本版本主要修复 Zed / ZedG 可用性问题：

- 修复 prompt 生命周期竞态，避免 Zed 认为生成结束后下一条消息打到仍 busy 的 OMP runtime。
- 修复 `fileMention` 等 OMP 历史消息导致 `session/load` 失败的问题。
- 新增 `todo_write` 到 ACP `plan` 的实时与历史同步。
- 保持禁用 OMP 通用 `ask`，但不使用静态 `--tools` 白名单。
- 修复并加固 npm Trusted Publishing 发布 workflow。

升级后请重启或 reload Zed / ZedG 中的 `omp-acp` agent/session。
