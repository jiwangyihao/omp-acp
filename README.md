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

### Stage 3 status

Stage 1 implemented ACP stdio transport and truthful `initialize`; Stage 2 added the OMP JSONL RPC client and process lifecycle; Stage 3 now wires `session/new`, baseline text/resource-link `session/prompt`, message/thought streaming, and best-effort `session/cancel` through the OMP runtime adapter.

The adapter is still not a complete coding-agent bridge: tool calls, edit diffs, host tool bridging, session list/load/resume/fork/close, MCP, filesystem and terminal delegation, image input, embedded context, slash commands, and usage updates remain unimplemented or unverified and are not declared as supported capabilities.

Run the development subprocess entry point with:

```bash
node --import tsx src/index.ts
```

Run targeted Stage 3 checks with:

```bash
node --import tsx --test test/unit/acp/session-handlers.test.ts test/unit/session/manager.test.ts test/unit/translate/prompt.test.ts test/unit/translate/events-message.test.ts
node --import tsx --test test/smoke/session-prompt.test.ts test/smoke/acp-stdio.test.ts
```

Do not use npm or npx installation commands for this package yet. The package remains `private` and has not been published.

## Current status

This repository is in active development and is not ready for publication. Zed/user-facing configuration documentation should wait until tool/edit and permission behavior are implemented and verified.