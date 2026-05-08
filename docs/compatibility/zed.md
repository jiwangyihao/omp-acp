# Zed local compatibility notes

`omp-acp` can be run as a Zed custom external agent during local development. It is not published to npm or the ACP registry yet.

## Local custom-agent configuration

Zed custom agents are configured under `agent_servers` with `type: "custom"`, `command`, `args`, and `env`.

Example for this checkout:

```json
{
  "agent_servers": {
    "omp-acp-local": {
      "type": "custom",
      "command": "node",
      "args": [
        "--import",
        "tsx",
        "C:/Users/34404/source/repos/omp-acp/src/index.ts"
      ],
      "env": {}
    }
  }
}
```

If `omp` is not on the PATH inherited by Zed, set the environment used by Zed so `omp --mode rpc` is resolvable before starting a thread. The adapter's default runtime launch is `omp --mode rpc` in the ACP session working directory.

For fixture-only development, the adapter also supports these local test seams:

```json
{
  "OMP_ACP_RUNTIME_COMMAND": "node",
  "OMP_ACP_RUNTIME_ARGS_JSON": "[\"--import\",\"tsx\",\"C:/Users/34404/source/repos/omp-acp/src/testing/script-rpc-process.ts\",\"session-happy\"]",
  "OMP_ACP_AGENT_DIR": "C:/tmp/omp-acp-test-agent"
}
```

Do not use those fixture seams for real Zed usage; they exist to make smoke tests deterministic.

For build-output smoke before opening Zed, run the raw JSON-RPC harness, the official TypeScript SDK client smoke, and the real OMP RPC controls smoke:

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls
```

For the manual Zed release gate, follow `scripts/smoke-zed.md`.

## Currently declared ACP support

- `session/new`
- `session/prompt` for `text`, `resource_link`, `image`, and embedded `resource` context
- `session/cancel` best-effort cancellation
- message and thought chunks
- tool calls, tool updates, failed/cancelled tool statuses, and structured diff content for tested OMP event shapes
- `session/list`, `session/load`, and `session/resume`
- `session/fork` first phase: forks from the source OMP session's currently persisted head; message-bound fork and `_meta.messageId` / `_meta.messageID` are not supported
- text-only OMP JSONL history replay for `session/load`; unsupported roles/content fail the load rather than silently dropping history
- ACP setup state for `models`, `modes`, and `configOptions`; supported session controls are `session/set_model`, `session/set_config_option`, and default-only `session/set_mode`

Zed custom-agent model and thinking pickers come from the adapter's ACP setup response. The adapter builds those values from OMP `get_state` and `get_available_models`; thinking options are dynamically clipped to the current model metadata, so a model that does not support `xhigh` will not offer it and active setters reject unsupported values. OMP-specific runtime knobs such as steering mode, follow-up mode, interrupt mode, and auto compaction are intentionally not exposed as ACP config options, so Zed should only show model, thinking, and the default mode control for this adapter.

## Current limits

- Published npm package usage is supported via `npx -y omp-acp`; local checkout configuration remains useful for development and testing.
- ACP `session/close` is not declared.
- MCP HTTP/SSE, terminal delegation, filesystem delegation, permission request UX, audio prompt blocks, usage updates, OMP-specific runtime knobs, sampling controls, service tiers, tools/MCP toggles, and multiple OMP agent modes are not declared.
- Zed GUI has not manually validated `session/fork` or the Stage 8B session controls; the release gate still requires `scripts/smoke-zed.md`.
- Slash commands, skills, and `omp.extensions` are discovered as metadata only; the adapter does not expose or execute them as ACP commands yet.
- Extension UI requests fail the active prompt explicitly because adapter-side UI delegation is not implemented.

## Debugging

Use Zed's `dev: open acp logs` command to inspect ACP JSON-RPC traffic when testing this custom agent. stdout from `omp-acp` must contain only ACP JSON-RPC frames; diagnostics must go to stderr or tests.