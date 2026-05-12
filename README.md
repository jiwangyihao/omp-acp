# omp-acp

[![npm](https://img.shields.io/npm/v/omp-acp)](https://www.npmjs.com/package/omp-acp)
[![Release](https://github.com/jiwangyihao/omp-acp/actions/workflows/release.yml/badge.svg)](https://github.com/jiwangyihao/omp-acp/actions/workflows/release.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](./LICENSE)

Use [Oh My Pi](https://github.com/jiwangyihao/oh-my-pi) from [Agent Client Protocol](https://agentclientprotocol.com/) compatible clients such as [Zed](https://zed.dev).

`omp-acp` is an independent OMP-native ACP adapter. It speaks ACP JSON-RPC over stdio to editors, launches `omp --mode rpc` as the runtime, and translates OMP RPC JSONL events into ACP session updates.

> 中文说明见下方 [中文概览](#中文概览)。

## What this is

- **An ACP adapter, not an OpenAI-compatible endpoint.** Zed ACP clients do not talk to OpenAI-compatible APIs directly; this adapter bridges ACP and OMP RPC.
- **An independent adapter, not a long-lived `pi-acp` fork.** `pi-acp`, OpenCode ACP, and other ACP adapters are useful references, but OMP behavior and tested ACP contracts are the source of truth here.
- **Truthful capability declaration.** `initialize` only declares capabilities implemented and covered by tests. Unsupported features fail clearly instead of being advertised optimistically.
- **Real OMP by default.** The default runtime command is OMP RPC mode. The adapter injects a small extension that removes only OMP's broad `ask` tool, avoiding generic interactive prompts that current ACP clients cannot answer while preserving the rest of OMP's tool discovery.

## Features

| Area | Status | Notes |
|---|---|---|
| ACP stdio transport | Implemented | stdout is reserved for ACP JSON-RPC frames; diagnostics go to stderr. |
| `session/new`, `session/prompt`, `session/cancel` | Implemented | Text, image, resource link, and embedded resource context are supported. |
| Assistant streaming | Implemented | Real OMP `text_delta` and `thinking_delta` stream as ACP message/thought chunks; `agent_end.messages` is a de-duplicated fallback. |
| Prompt lifecycle | Implemented | OMP `prompt` ACK is treated as command acceptance only; ACP `end_turn` waits for `agent_end` plus runtime idle. |
| Tool calls, updates, and diffs | Implemented | Runtime tool events, failures, cancellations, structured diffs, and host-tool results are surfaced as ACP updates. |
| Session list/load/resume | Implemented | Reads OMP JSONL session history and safely replays renderable content. |
| Session fork | Implemented, first phase | Forks from the source OMP session's persisted head; message-bound fork is not supported. |
| Model/thinking/default mode controls | Implemented | Built from OMP `get_state` / `get_available_models`; thinking choices are clipped to current model metadata. |
| OMP `confirm` | Partial | Bridged to ACP `session/request_permission`. |
| OMP `setWidget` | Implemented | `widgetLines` are shown as ACP thought/progress text. |
| OMP TODO state | Implemented | `todo_write` emits ACP `plan`; empty TODO state clears the client's old plan. |
| MCP passthrough, terminal delegation, filesystem delegation | Not implemented | Not declared in ACP capabilities. |

See the full [capability matrix](./docs/compatibility/capability-matrix.md) for the exact tested boundary.

## Installation

### Prerequisites

- Node.js >= 20.
- The `omp` CLI installed and visible to the PATH inherited by your editor. If not, set `OMP_ACP_RUNTIME_COMMAND` to the absolute executable path.
- An ACP-compatible client such as Zed / ZedG.

### npm

```bash
npx -y omp-acp
```

Or install globally:

```bash
npm install -g omp-acp
omp-acp
```

### From source

```bash
git clone https://github.com/jiwangyihao/omp-acp.git
cd omp-acp
npm install
npm run build
node dist/index.js
```

Development entry point:

```bash
node --import tsx src/index.ts
```

## Authentication setup

`omp-acp` does not collect provider API keys. It uses the local OMP configuration that the `omp` CLI already uses.

For clients or Registry checks that explicitly support ACP Terminal Auth setup, the adapter advertises one terminal setup method:

```bash
npx -y omp-acp --setup
```

For a local checkout, run the same setup flow through the built output:

```bash
node dist/index.js --setup
```

The setup command checks that OMP can start in RPC mode and that OMP can discover at least one usable model. If no model is available, it prints configuration guidance such as setting provider environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) or creating/editing `~/.omp/agent/models.yml`.

The setup flow is a check and guide only. It does not complete provider login for you, ask for provider secrets, store provider secrets, print provider secrets, or manage an OAuth callback flow.

## Zed / ZedG setup

Add a custom agent server to Zed `settings.json`:

```json
{
  "agent_servers": {
    "omp-acp": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "omp-acp"],
      "env": {}
    }
  }
}
```

If Zed cannot find `omp`, override only the OMP executable:

```json
{
  "agent_servers": {
    "omp-acp": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "omp-acp"],
      "env": {
        "OMP_ACP_RUNTIME_COMMAND": "C:/Users/you/AppData/Local/Programs/omp/omp.exe"
      }
    }
  }
}
```

For local checkout development:

```json
{
  "agent_servers": {
    "omp-acp-local": {
      "type": "custom",
      "command": "node",
      "args": ["C:/Users/you/source/repos/omp-acp/dist/index.js"],
      "env": {
        "OMP_ACP_RUNTIME_COMMAND": "C:/path/to/omp"
      }
    }
  }
}
```

Then open the Zed Agent Panel, start a new external agent thread, and select the configured `omp-acp` agent.

More editor notes are in [Zed compatibility notes](./docs/compatibility/zed.md).

## Runtime configuration

| Variable | Purpose |
|---|---|
| `OMP_ACP_RUNTIME_COMMAND` | Overrides only the OMP executable. The adapter still supplies default RPC arguments. |
| `OMP_ACP_RUNTIME_ARGS_JSON` | Advanced/test-only complete runtime argv override. Arguments are used as-is. |
| `OMP_ACP_AGENT_DIR` | Test/isolation override for the OMP agent directory. |

By default the adapter constructs this runtime shape:

```bash
omp --mode rpc --extension <adapter-disable-ask-extension.mjs>
```

Do not use a static `--tools` allowlist just to disable `ask`. Static allowlists can hide user settings, plugin tools, extension tools, MCP tools, or future OMP tools. `omp-acp` removes only active `ask` through its injected extension and session setup guard.

Use `OMP_ACP_RUNTIME_ARGS_JSON` only for fixtures, smoke tests, or unusual debugging. When provided, the adapter does not add `--mode rpc` for you; the full command must start a compatible OMP RPC runtime.

## Supported ACP surface

Supported:

- `initialize`
- `authMethods` Terminal Auth when the client explicitly supports ACP auth setup
- `authenticate` for the `omp-setup` Terminal Auth method
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/list`
- `session/load`
- `session/resume`
- `session/fork` from the current persisted head
- `session/set_model`
- `session/set_config_option` for `model` and `thinking`
- `session/set_mode` for the default mode only
- `agent_message_chunk` / `agent_thought_chunk`
- `tool_call` / `tool_call_update`
- Known OMP structured edit diff shapes
- OMP `confirm` → ACP `session/request_permission`
- OMP `setWidget` → ACP thought/progress text
- OMP `todo_write` → ACP `plan`

Unsupported or undeclared:

- `session/close`
- ACP HTTP/SSE MCP passthrough
- ACP filesystem delegation
- ACP terminal delegation
- ACP usage updates
- OMP `select`, `input`, and `editor`
- Broad Ask / elicitation flows
- OMP-specific runtime knobs as ACP config options: steering, follow-up, interrupt, auto compaction, sampling, provider config, base URL, secrets, and tool/MCP toggles
- Agent-managed OAuth Auth is not implemented; Terminal Auth is a setup/check guide, not an OAuth callback flow.
- Message-bound fork or `_meta.messageId` / `_meta.messageID` fork

## Prompt, concurrency, and cancellation semantics

An OMP RPC `prompt` response only acknowledges command acceptance. It does not mean the model turn has ended. `omp-acp` waits for:

1. OMP `agent_end`;
2. `get_state` showing the runtime is no longer busy;
3. queued ACP update delivery to finish;

before returning ACP `stopReason: "end_turn"`.

If a client sends another ordinary `session/prompt` while a turn is active, the adapter waits for the active prompt to clean up, then sends the next request as a new independent OMP `prompt`. It does not map ordinary concurrent ACP prompts to OMP `follow_up`, because ACP 0.21.0 has no standard follow-up, queue, or steer primitive.

Direct "interrupt and replace this prompt" is also not an ACP 0.21.0 primitive. Clients can approximate it with `session/cancel` followed by a new `session/prompt`; the adapter waits for the cancelled runtime turn to clean up before sending the next prompt, avoiding OMP `Agent is already processing` races.

## Safety and privacy boundary

ACP-visible data goes through shared sanitization boundaries:

- Provider-private payloads, raw provider config, API keys, tokens, secrets, signatures, encrypted reasoning, and base URLs are not sent to the ACP client.
- Historical `fileMention` messages replay only file path, URI, or name fields. File contents are not replayed.
- Tool `rawInput` and `rawOutput` are recursively sanitized before being exposed.
- History blocks that cannot be safely mapped are skipped instead of failing the whole `session/load`.

## Development and validation

Common commands:

```bash
npm install
npm run typecheck
npm test
npm run check
npm run build
```

ACP and runtime smoke tests:

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls:optional
npm run smoke:omp-rpc-controls:required
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

Notes:

- `smoke:omp-rpc-controls:optional` is a developer diagnostic. It may skip when a real `omp` executable is unavailable and is not a release pass.
- `smoke:omp-rpc-controls:required` is a release gate. Skip, timeout, or failure means the release gate failed.
- `validate:standard` runs the automated release gates, but excludes manual Zed GUI smoke.
- `openclaw/acpx` is a third-party draft assessment. It helps catch protocol-boundary issues, but it is not an official ACP full conformance suite and should not be described as a full pass.

## Troubleshooting

### The agent does not start in Zed

- Confirm `npx -y omp-acp` or `node dist/index.js` runs in a terminal.
- Confirm the PATH inherited by Zed can find both `node` and `omp`.
- If `omp` is not on that PATH, set `OMP_ACP_RUNTIME_COMMAND` to an absolute path.
- Use Zed's `dev: open acp logs` command to inspect ACP traffic and stderr diagnostics.

### The next prompt fails with `Agent is already processing`

Use `omp-acp@0.1.1` or newer, then restart/reload the Zed `omp-acp` agent. Existing processes do not hot-reload a new `dist/index.js` or npm package version.

### `select`, `input`, or `editor` fails as unsupported

This is intentional. The adapter currently bridges only OMP `confirm` to ACP permission requests. Broad Ask / elicitation is not supported, and the adapter does not disguise arbitrary input prompts as permissions.

### TODO state is missing or stale

Starting with v0.1.1, OMP `todo_write` synchronizes ACP `plan` updates. If stale data remains visible, restart the corresponding agent/session and confirm the new adapter version is loaded.

### Windows or ZedG path issues

Prefer absolute paths and avoid unescaped backslashes in JSON. Forward slashes are valid in Windows paths:

```json
{
  "OMP_ACP_RUNTIME_COMMAND": "C:/Users/you/AppData/Local/Programs/omp/omp.exe"
}
```

## Current release status

Current npm latest: `omp-acp@0.1.2`.

Release flow:

1. Run `npm run validate:standard` and `npm pack --dry-run --json` locally.
2. Create a `vX.Y.Z` Git tag and GitHub Release.
3. GitHub Actions publishes to npm through Trusted Publishing.

Manual Zed / ZedG GUI smoke is still a local/manual gate. Release notes do not claim it has passed unless it has been performed.

## 中文概览

`omp-acp` 是一个独立的 OMP-native ACP 适配器，用于让 Zed / ZedG 等 ACP 客户端通过 stdio 驱动 Oh My Pi coding agent。

关键点：

- 这不是 OpenAI-compatible API。Zed ACP 需要 ACP JSON-RPC server，因此需要本 adapter 做协议桥接。
- 默认通过 `omp --mode rpc` 启动真实 OMP runtime。
- 默认禁用 OMP 的通用 `ask` 工具，但不使用静态 `--tools` 白名单，因此不会屏蔽用户设置、插件、扩展、MCP 或未来工具发现。
- 支持 prompt streaming、tool updates、session list/load/resume/fork、模型和 thinking 控制、OMP `confirm` permission、`setWidget` 进度展示，以及 `todo_write` → ACP `plan` 同步。
- 暂不声明 MCP passthrough、filesystem delegation、terminal delegation、`session/close`、广义 Ask / elicitation 或 OMP-specific runtime knobs。
- `omp-acp --setup` 只检查并引导 OMP 本地模型认证配置，不收集、不保存、不打印 provider API key。
- v0.1.2 adds Terminal Auth setup for ACP Registry-compatible clients and maps active-turn follow-up `session/prompt` requests to OMP `steer`; v0.1.1 fixed the Zed busy-runtime race and OMP history `fileMention` loading.

最小 Zed 配置：

```json
{
  "agent_servers": {
    "omp-acp": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "omp-acp"],
      "env": {}
    }
  }
}
```

如果 Zed 找不到 `omp`，在 `env` 中添加：

```json
{
  "OMP_ACP_RUNTIME_COMMAND": "C:/path/to/omp"
}
```

升级后请重启或 reload Zed / ZedG 中的 `omp-acp` agent/session；已运行进程不会热加载新版本。

## License

`omp-acp` is distributed under the [Mozilla Public License 2.0](./LICENSE).
