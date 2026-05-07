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

### Stage 1 status

Stage 1 implements the ACP stdio transport and a truthful `initialize` response. In local development, the adapter can run as an ACP subprocess and complete the `initialize` smoke path over stdout JSON-RPC.

It is still not a complete usable ACP agent: session creation, prompts, cancellation, MCP, filesystem and terminal delegation, image input, embedded context, and other runtime capabilities are not implemented or not declared.

Run the development subprocess entry point with:

```bash
node --import tsx src/index.ts
```

Run the targeted Stage 1 tests with:

```bash
node --import tsx --test test/unit/acp/initialize.test.ts
node --import tsx --test test/smoke/acp-stdio.test.ts
```

Do not use npm or npx installation commands for this package yet. The package remains `private` and has not been published.

## Current status

This repository is in active development and is not ready for publication. Zed smoke coverage and user-facing configuration documentation will be added in later stages after real session and prompt support exist.