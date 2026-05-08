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
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

### Stage 8A status

Stage 1 implemented ACP stdio transport and truthful `initialize`; Stage 2 added the OMP JSONL RPC client and process lifecycle; Stage 3 wired `session/new`, baseline prompt streaming, and cancel; Stage 4 maps runtime tool events/diffs/host-tool results; Stage 5 adds OMP session list/load and config/command discovery helpers; Stage 6 adds `session/resume`, image prompt forwarding, and embedded resource context while explicitly keeping unsupported parity items undeclared. Stage 7 adds build and smoke gates plus release checklists; it does not add protocol capabilities. Stage 8A implements the first phase of ACP `session/fork`: fork from the source OMP session's currently persisted head, bind the new session to the forked JSONL file, and allow prompts on the forked session.

The adapter is still not a complete coding-agent bridge: `session/close`, MCP, filesystem and terminal delegation, permission request UX, command execution, usage updates, and broad real-OMP parity remain unimplemented or unsupported and are not declared as supported capabilities. `session/fork` does not support message-bound fork or `_meta.messageId` / `_meta.messageID`. Release is blocked until the checklist in `docs/release-checklist.md` is satisfied, including manual Zed smoke from `scripts/smoke-zed.md`.

Run the development subprocess entry point with:

```bash
node --import tsx src/index.ts
```

Run targeted Stage 6 checks with:

```bash
node --import tsx --test test/unit/acp/initialize.test.ts test/unit/acp/session-resume.test.ts test/unit/translate/prompt.test.ts test/smoke/session-prompt.test.ts
```

Run build-output ACP compatibility checks with the raw JSON-RPC harness, the official TypeScript SDK client, the registry-style method probe, and the pinned `openclaw/acpx` draft assessment. The raw, SDK, and registry-style checks cover first-phase `session/fork`; `openclaw/acpx` remains a third-party draft assessment and does not prove fork behavior.

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

`validate:standard` runs the automated gates above plus `npm run check`; it intentionally excludes Zed GUI smoke. The `openclaw/acpx` script reports the full draft profile result and treats only documented, capability-boundary mismatches as expected draft failures.

Do not use npm or npx installation commands for this package yet. The package remains `private` and has not been published.

## Current status

This repository is in active development and is not ready for publication. Zed/custom-agent configuration is documented for local development in `docs/compatibility/zed.md`; ACP validation strategy is documented in `docs/compatibility/acp-validation.md`; registry or npm installation should wait until permission behavior, broader real-OMP parity, and release packaging are verified.