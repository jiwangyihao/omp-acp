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
```

### Stage 4 status

Stage 1 implemented ACP stdio transport and truthful `initialize`; Stage 2 added the OMP JSONL RPC client and process lifecycle; Stage 3 wired `session/new`, baseline text/resource-link `session/prompt`, message/thought streaming, and best-effort `session/cancel`; Stage 4 now maps runtime tool execution events, structured edit diffs, and explicit host-tool raw-frame results into the ACP prompt lifecycle.

The adapter is still not a complete coding-agent bridge: session list/load/resume/fork/close, MCP, filesystem and terminal delegation, permission request UX, image input, embedded context, slash commands, usage updates, and broad real-OMP parity remain unimplemented or unverified and are not declared as supported capabilities.

Run the development subprocess entry point with:

```bash
node --import tsx src/index.ts
```

Run targeted Stage 4 checks with:

```bash
node --import tsx --test test/unit/translate/diffs.test.ts test/unit/translate/tools.test.ts test/unit/translate/events-message.test.ts test/unit/runtime/omp/host-tools.test.ts test/contract/omp-rpc/tool-events.test.ts test/unit/acp/session-handlers.test.ts test/smoke/session-prompt.test.ts
```

Do not use npm or npx installation commands for this package yet. The package remains `private` and has not been published.

## Current status

This repository is in active development and is not ready for publication. Zed/user-facing configuration documentation should wait until tool/edit and permission behavior are implemented and verified.