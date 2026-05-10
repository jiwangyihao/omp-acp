# omp-acp

`omp-acp` is an independent Agent Client Protocol adapter for the Oh My Pi coding agent.

The adapter is intended to run OMP as an ACP-compatible subprocess for editors such as Zed. It is not a long-lived fork of `pi-acp`; `pi-acp` and OpenCode ACP are reference implementations for behavior, tests, and compatibility checks.

## Design direction

- Keep ACP protocol handling separate from OMP runtime integration.
- Treat OMP behavior as the source of truth: launch `omp --mode rpc`, parse OMP RPC frames, and expose only capabilities that are actually implemented.
- Prefer tested OMP-native behavior over compatibility shims that silently mimic Pi semantics.
- Use `pi-acp` as a reference and selective patch source, not as a merge upstream.

## Development

```bash
npm install
npm test
npm run typecheck
npm run check
npm run build
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls:optional
npm run smoke:omp-rpc-controls:required
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

### Current implementation status

Stage 1 implemented ACP stdio transport and truthful `initialize`; Stage 2 added the OMP JSONL RPC client and process lifecycle; Stage 3 wired `session/new`, baseline prompt streaming, and cancel; Stage 4 maps runtime tool events/diffs/host-tool results; Stage 5 adds OMP session list/load and config/command discovery helpers; Stage 6 adds `session/resume`, image prompt forwarding, and embedded resource context while explicitly keeping unsupported parity items undeclared. Stage 7 adds build and smoke gates plus release checklists; Stage 8A implements the first phase of ACP `session/fork` from the source OMP session's currently persisted head. Stage 8B aligns the adapter to the real OMP RPC command/response contract and exposes ACP session setup state plus controls for model selection, thinking level, and default mode.

Session controls are intentionally conservative. Model and thinking selectors come from OMP `get_state` / `get_available_models`; thinking values are clipped to the current model metadata, so a model that does not support `xhigh` will not offer it and active setters reject unsupported values. OMP-specific runtime knobs such as steering mode, follow-up mode, interrupt mode, and auto compaction are intentionally hidden from ACP `configOptions` so they do not appear in Zed. The adapter does not expose provider secrets, base URLs, raw provider config, sampling knobs, tools/MCP, or multiple OMP agent modes as per-session ACP controls.

The adapter disables OMP's general `ask` tool without passing a static `--tools` allowlist. Default launches inject a small adapter extension that removes only `ask` from OMP's current active tools before agent execution, and session setup performs the same difference-based removal from OMP `dumpTools`. This preserves OMP settings-derived built-in tools, extension/plugin tools, MCP tools, and future tool discovery behavior while keeping broad Ask/elicitation unsupported.

`extension_ui_request` support is deliberately narrow. OMP `confirm` is bridged to ACP `session/request_permission`; OMP `setWidget` string `widgetLines` are surfaced as progress/thought text. OMP `select`, `input`, `editor`, and broad Ask/elicitation flows remain unsupported until target clients provide stable elicitation support.

Assistant streaming 复用共享 message 映射。实时路径支持真实 OMP `assistantMessageEvent.text_delta` / `thinking_delta`；如果 runtime 只在 `agent_end.messages` 提供最终 assistant 内容，adapter 会在返回 `end_turn` 前补发未被 streaming 覆盖的文本或思考内容，并避免重复展示已发送的 chunk。ACP-visible content、tool `rawInput` 和 `rawOutput` 复用共享净化边界，provider-private payload、config、key、token、signature、encrypted 字段和 encrypted reasoning 不会发送给 ACP client。

Prompt lifecycle handling is intentionally stricter than the raw OMP RPC acknowledgement. The adapter treats OMP `prompt` responses as acceptance only, waits for `agent_end` plus idle `get_state` before returning ACP `end_turn`, and holds concurrent ordinary ACP prompts until the active prompt has fully cleaned up before sending the next OMP `prompt`. Direct interrupt-and-replace is not an ACP 0.21.0 primitive; clients can approximate it with `session/cancel` followed by a new `session/prompt`, which the adapter holds until the cancelled runtime turn has cleaned up.

The adapter is still not a complete coding-agent bridge: `session/close`, MCP, filesystem and terminal delegation, command execution, usage updates, and broad real-OMP parity remain unimplemented or unsupported and are not declared as supported capabilities. `session/fork` does not support message-bound fork or `_meta.messageId` / `_meta.messageID`.

## Installation

The published CLI entry point is intended for local ACP custom-agent configuration:

```bash
npx -y omp-acp
```

For Zed/ZedG local development against a real OMP runtime, let the adapter construct the default OMP RPC args unless you intentionally need a custom fixture command. Users do not need to maintain a tool list:

```json
{
  "command": "node",
  "args": ["/path/to/omp-acp/dist/index.js"],
  "env": {
    "OMP_ACP_RUNTIME_COMMAND": "/path/to/omp"
  }
}
```

`OMP_ACP_RUNTIME_COMMAND` only overrides the OMP executable. The adapter still supplies `--mode rpc --extension <disable-ask-extension.mjs>` by default, so Ask is disabled without a static `--tools` allowlist. Set `OMP_ACP_RUNTIME_ARGS_JSON` only for fixtures or advanced cases where you intentionally replace the entire runtime argv; those custom args are used as-is, and the session setup guard still removes active `ask` when OMP reports it in `dumpTools`.

## License

`omp-acp` is distributed under the Mozilla Public License 2.0 (MPL-2.0).

Run the development subprocess entry point with:

```bash
node --import tsx src/index.ts
```

Run targeted Stage 6 checks with:

```bash
node --import tsx --test test/unit/acp/initialize.test.ts test/unit/acp/session-resume.test.ts test/unit/translate/prompt.test.ts test/smoke/session-prompt.test.ts
```

Run build-output ACP compatibility checks with the raw JSON-RPC harness, the official TypeScript SDK client, the registry-style method probe, the real OMP RPC controls smoke, and the pinned `openclaw/acpx` draft assessment. The raw, SDK, and registry-style checks cover first-phase `session/fork` and session controls; `openclaw/acpx` remains a third-party draft assessment and does not prove fork, controls behavior, official ACP conformance, or full conformance.

The real OMP RPC controls smoke has two modes:

- `npm run smoke:omp-rpc-controls:optional` is a development-machine diagnostic. It may skip when a real `omp` executable is unavailable and must not be counted as a release pass.
- `npm run smoke:omp-rpc-controls:required` is the release gate. Skip, timeout, and command failure are all failures.
- `npm run validate:standard` uses the required gate. If the required gate fails on the local release machine, do not claim release verification has passed.

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls:optional
npm run smoke:omp-rpc-controls:required
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

`validate:standard` runs the automated gates above plus `npm run check`; it intentionally excludes Zed GUI smoke. Current verification must record the observed result of `npm run smoke:omp-rpc-controls:required` separately; a timeout, skip, or failure means the release gate is not passed. The `openclaw/acpx` script reports the draft profile result and treats only documented, capability-boundary mismatches as expected draft failures; it is not an official full conformance pass.

## Current status

`omp-acp` is published as an early OMP-native ACP adapter. The automated ACP, SDK-client, registry-style, required real OMP RPC controls, and pinned `openclaw/acpx` draft assessment gates are part of the release process. The optional real OMP RPC controls smoke is only a local diagnostic and may skip; it is not a release pass. Zed/custom-agent configuration is documented in `docs/compatibility/zed.md`; Zed/ZedG GUI smoke remains a manual gate and is not claimed as completed here.

The package is not an official full ACP conformance claim. `openclaw/acpx` is a third-party draft assessment, and documented expected draft failures are not a full pass.