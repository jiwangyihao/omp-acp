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
npm run smoke:omp-rpc-controls
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

### Stage 8B status

Stage 1 implemented ACP stdio transport and truthful `initialize`; Stage 2 added the OMP JSONL RPC client and process lifecycle; Stage 3 wired `session/new`, baseline prompt streaming, and cancel; Stage 4 maps runtime tool events/diffs/host-tool results; Stage 5 adds OMP session list/load and config/command discovery helpers; Stage 6 adds `session/resume`, image prompt forwarding, and embedded resource context while explicitly keeping unsupported parity items undeclared. Stage 7 adds build and smoke gates plus release checklists; Stage 8A implements the first phase of ACP `session/fork` from the source OMP session's currently persisted head. Stage 8B aligns the adapter to the real OMP RPC command/response contract and exposes ACP session setup state plus controls for model selection, thinking level, and default mode.

Session controls are intentionally conservative. Model and thinking selectors come from OMP `get_state` / `get_available_models`; thinking values are clipped to the current model metadata, so a model that does not support `xhigh` will not offer it and active setters reject unsupported values. OMP-specific runtime knobs such as steering mode, follow-up mode, interrupt mode, and auto compaction are intentionally hidden from ACP `configOptions` so they do not appear in Zed. The adapter does not expose provider secrets, base URLs, raw provider config, sampling knobs, tools/MCP, or multiple OMP agent modes as per-session ACP controls.

The adapter is still not a complete coding-agent bridge: `session/close`, MCP, filesystem and terminal delegation, permission request UX, command execution, usage updates, and broad real-OMP parity remain unimplemented or unsupported and are not declared as supported capabilities. `session/fork` does not support message-bound fork or `_meta.messageId` / `_meta.messageID`.

## Installation

The published CLI entry point is intended for local ACP custom-agent configuration:

```bash
npx -y omp-acp
```

For Zed/ZedG local development against a real OMP runtime, configure the adapter command and set the runtime environment explicitly, for example:

```json
{
  "command": "node",
  "args": ["/path/to/omp-acp/dist/index.js"],
  "env": {
    "OMP_ACP_RUNTIME_COMMAND": "/path/to/omp",
    "OMP_ACP_RUNTIME_ARGS_JSON": "[\"--mode\",\"rpc\"]"
  }
}
```

When using the npm package directly, set the same `OMP_ACP_RUNTIME_COMMAND` and `OMP_ACP_RUNTIME_ARGS_JSON` values in the host editor configuration.

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

Run build-output ACP compatibility checks with the raw JSON-RPC harness, the official TypeScript SDK client, the registry-style method probe, the real OMP RPC controls smoke, and the pinned `openclaw/acpx` draft assessment. The raw, SDK, and registry-style checks cover first-phase `session/fork` and session controls; `openclaw/acpx` remains a third-party draft assessment and does not prove fork or controls behavior.

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

`validate:standard` runs the automated gates above plus `npm run check`; it intentionally excludes Zed GUI smoke. The `openclaw/acpx` script reports the full draft profile result and treats only documented, capability-boundary mismatches as expected draft failures; it is not an official full conformance pass.

## Current status

`omp-acp` is published as an early OMP-native ACP adapter. The automated ACP, SDK-client, registry-style, real OMP RPC controls, and pinned `openclaw/acpx` draft assessment gates are part of the release process. Zed/custom-agent configuration is documented in `docs/compatibility/zed.md`; ACP validation strategy is documented in `docs/compatibility/acp-validation.md`.

The package is not an official full ACP conformance claim. `openclaw/acpx` is a third-party draft assessment, and documented expected draft failures are not a full pass.