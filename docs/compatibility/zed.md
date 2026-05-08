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

## Currently declared ACP support

- `session/new`
- `session/prompt` for `text` and `resource_link`
- `session/cancel` best-effort cancellation
- message and thought chunks
- tool calls, tool updates, failed/cancelled tool statuses, and structured diff content for tested OMP event shapes
- `session/list`
- `session/load` for text-only OMP JSONL history; unsupported roles/content fail the load rather than silently dropping history

## Current limits

- The package remains `private`; there is no supported `npx -y omp-acp` install path.
- `session/resume`, `session/fork`, and ACP `session/close` are not declared.
- MCP HTTP/SSE, terminal delegation, filesystem delegation, permission request UX, image prompt blocks, and embedded context are not declared.
- Slash commands, skills, and `omp.extensions` are discovered as metadata only; the adapter does not expose or execute them as ACP commands yet.
- Extension UI requests fail the active prompt explicitly because adapter-side UI delegation is not implemented.

## Debugging

Use Zed's `dev: open acp logs` command to inspect ACP JSON-RPC traffic when testing this custom agent. stdout from `omp-acp` must contain only ACP JSON-RPC frames; diagnostics must go to stderr or tests.