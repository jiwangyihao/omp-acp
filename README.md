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

### Stage 5 status

Stage 1 implemented ACP stdio transport and truthful `initialize`; Stage 2 added the OMP JSONL RPC client and process lifecycle; Stage 3 wired `session/new`, baseline text/resource-link `session/prompt`, message/thought streaming, and best-effort `session/cancel`; Stage 4 maps runtime tool execution events, structured edit diffs, and explicit host-tool raw-frame results; Stage 5 adds OMP session list/load with text-history replay, OMP config/command discovery helpers, and explicit failure for unsupported extension UI requests.

The adapter is still not a complete coding-agent bridge: session resume/fork/close, MCP, filesystem and terminal delegation, permission request UX, image input, embedded context, command execution, usage updates, and broad real-OMP parity remain unimplemented or unverified and are not declared as supported capabilities.

Run the development subprocess entry point with:

```bash
node --import tsx src/index.ts
```

Run targeted Stage 5 checks with:

```bash
node --import tsx --test test/unit/runtime/omp/config.test.ts test/unit/runtime/omp/commands.test.ts test/unit/runtime/omp/sessions.test.ts test/unit/acp/initialize.test.ts test/unit/acp/session-list-load.test.ts test/unit/translate/events-message.test.ts test/smoke/session-prompt.test.ts
```

Do not use npm or npx installation commands for this package yet. The package remains `private` and has not been published.

## Current status

This repository is in active development and is not ready for publication. Zed/custom-agent configuration is documented for local development in `docs/compatibility/zed.md`; registry or npm installation should wait until permission behavior, broader real-OMP parity, and release packaging are verified.