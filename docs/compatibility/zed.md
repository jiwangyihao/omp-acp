# Zed local compatibility notes

`omp-acp` can be run as a Zed custom external agent. Published npm package usage is supported via `npx -y omp-acp`; local checkout configuration remains useful for development and testing.

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

If `omp` is not on the PATH inherited by Zed, set `OMP_ACP_RUNTIME_COMMAND` to the absolute OMP executable path. That variable overrides only the executable; the adapter still supplies the default runtime args: `--mode rpc --extension <adapter disable-ask extension>`. It intentionally does not pass a static `--tools` allowlist; the injected extension and session setup remove only active `ask`, preserving OMP settings-derived built-in tools, extension/plugin tools, MCP tools, and future tool discovery behavior. For `session/load`, `session/resume`, and `session/fork`, the release path also removes active `ask` after switching to the final OMP session, before publishing that ACP session.

For fixture-only development, the adapter also supports these local test seams:

```json
{
  "OMP_ACP_RUNTIME_COMMAND": "node",
  "OMP_ACP_RUNTIME_ARGS_JSON": "[\"--import\",\"tsx\",\"C:/Users/34404/source/repos/omp-acp/src/testing/script-rpc-process.ts\",\"session-happy\"]",
  "OMP_ACP_AGENT_DIR": "C:/tmp/omp-acp-test-agent"
}
```

Do not use those fixture seams for real Zed usage; they exist to make smoke tests deterministic.
If a local ZedG setup overrides the complete runtime args with `OMP_ACP_RUNTIME_ARGS_JSON`, those args are used as-is. Only use that for fixtures or advanced debugging. Do not use a static `--tools` allowlist merely to disable Ask; it can hide extension/plugin tools and force built-ins that the user's OMP settings would otherwise keep inactive. The adapter's session setup still removes active `ask` when OMP reports it in `dumpTools`, including after load/resume/fork switches to the final OMP session on the release path.

For build-output smoke before opening Zed, run the raw JSON-RPC harness, the official TypeScript SDK client smoke, and the real OMP RPC controls smoke in the mode appropriate to the decision:

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls:optional   # local diagnostic; may skip and is not a release pass
npm run smoke:omp-rpc-controls:required   # release gate; skip/timeout/failure fail
```

`npm run validate:standard` uses the required real OMP gate. If the required gate fails locally, do not claim release verification passed.

For the manual Zed release gate, follow `scripts/smoke-zed.md`.

## Currently declared ACP support

- `session/new`
- `session/prompt` 支持 `text`、`resource_link`、`image` 和 embedded `resource` context；真实 OMP `assistantMessageEvent.text_delta` / `thinking_delta` 会分别流式输出为 message/thought chunk，`agent_end.messages` 只作为去重 fallback，收到 `agent_end` 后还会确认 OMP runtime 已 idle 再返回 `end_turn`。生成中收到新的普通 prompt 时，adapter 会先等待当前活动 prompt cleanup，再把该请求作为独立的新 OMP `prompt` 发送，而不是把第二条直接打到 busy runtime。
- `session/cancel` best-effort cancellation；取消后的下一条 prompt 会等旧 runtime cleanup 完成后再发往 OMP。ACP 0.21.0 没有标准单步“打断并发送新消息”方法，当前只能通过 `session/cancel` + 下一条 `session/prompt` 组合模拟。
- message 与 thought chunk，包括真实 OMP Assistant streaming delta。
- tool call、tool update、failed/cancelled tool status，以及已测试 OMP event shape 的 structured diff content；ACP-visible content、`rawInput`、`rawOutput` 会先经过共享安全边界净化，再发送给 client。
- `session/list`, `session/load`, and `session/resume`
- `session/fork` first phase: forks from the source OMP session's currently persisted head; message-bound fork and `_meta.messageId` / `_meta.messageID` are not supported
- `session/load` 的 rich OMP JSONL history replay：按顺序回放文本、image/resource content、assistant thinking、tool call/result、session metadata，以及安全可见的 control/custom event；provider-private payload、signature、encrypted reasoning、secret、token、key、encrypted 和 raw config 会被净化或跳过。
- ACP setup state for `models`, `modes`, and `configOptions`; supported session controls are `session/set_model`, `session/set_config_option`, and default-only `session/set_mode`


Zed 和 ZedG 可以处理 permission approval prompt，因此 adapter 只把 OMP `extension_ui_request method=confirm` 桥接到 ACP `session/request_permission`。adapter 不依赖 ACP `elicitation`；OMP `select`、`input`、`editor` 和通用 Ask flow 仍会失败，而不是被声明为支持。OMP extension `setWidget` 输出会从 `widgetLines` 显示为 thought/progress text。
Zed custom-agent model and thinking pickers come from the adapter's ACP setup response. The adapter builds those values from OMP `get_state` and `get_available_models`; thinking options are dynamically clipped to the current model metadata, so a model that does not support `xhigh` will not offer it and active setters reject unsupported values. OMP-specific runtime knobs such as steering mode, follow-up mode, interrupt mode, and auto compaction are intentionally not exposed as ACP config options, so Zed should only show model, thinking, and the default mode control for this adapter.

## Current limits

- Published npm package usage is supported via `npx -y omp-acp`; local checkout configuration remains useful for development and testing.
- ACP `session/close` is not declared.
- Permission request UX beyond OMP `confirm`, audio prompt blocks, usage updates, OMP-specific runtime knobs, sampling controls, service tiers, tools/MCP toggles, and multiple OMP agent modes are not declared.
- Zed GUI and ZedG GUI smoke have not been claimed as completed; the release gate still requires `scripts/smoke-zed.md`.
- Slash commands, skills, and `omp.extensions` are discovered as metadata only; the adapter does not expose or execute them as ACP commands yet.
- Extension UI support 仅限 OMP `confirm` permission prompt 和 `setWidget` thought/progress text；`select`、`input`、`editor` 和通用 Ask/elicitation 均不支持。

## Debugging

Use Zed's `dev: open acp logs` command to inspect ACP JSON-RPC traffic when testing this custom agent. stdout from `omp-acp` must contain only ACP JSON-RPC frames; diagnostics must go to stderr or tests.