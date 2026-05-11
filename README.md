# omp-acp

[![npm](https://img.shields.io/npm/v/omp-acp)](https://www.npmjs.com/package/omp-acp)
[![Release](https://github.com/jiwangyihao/omp-acp/actions/workflows/release.yml/badge.svg)](https://github.com/jiwangyihao/omp-acp/actions/workflows/release.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](./LICENSE)

Use [Oh My Pi](https://github.com/jiwangyihao/oh-my-pi) from [Agent Client Protocol](https://agentclientprotocol.com/) compatible clients such as [Zed](https://zed.dev).

`omp-acp` 是一个独立的 OMP-native ACP adapter。它通过 stdio 对外说 ACP，通过 `omp --mode rpc` 对内驱动 OMP，让支持 ACP 的编辑器可以把 OMP 作为外部 coding agent 使用。

## 这是什么

- **ACP adapter，而不是 OpenAI-compatible 端点。** OpenAI-compatible API 不能直接接入 Zed ACP；`omp-acp` 负责把 ACP JSON-RPC 与 OMP RPC JSONL 互相转换。
- **独立实现，而不是 `pi-acp` 的长期 fork。** `pi-acp`、OpenCode ACP 和其他 ACP adapter 只是行为与测试参考。
- **能力声明保守。** `initialize` 只声明已经实现并测试过的 ACP 能力；未实现能力不会为了兼容 UI 而伪装支持。
- **默认适配真实 OMP。** 默认 runtime 命令由 adapter 构造为 OMP RPC 模式，并注入一个小扩展来移除通用 `ask` 工具，避免当前 ACP 客户端无法回答的泛化交互请求挂住会话。

## 功能概览

| 能力 | 状态 | 说明 |
|---|---|---|
| ACP stdio transport | 已实现 | stdout 只输出 ACP JSON-RPC frame；诊断走 stderr。 |
| `session/new` / `session/prompt` / `session/cancel` | 已实现 | 支持文本、图片、resource link 与 embedded resource context。 |
| Assistant streaming | 已实现 | 支持真实 OMP `text_delta` / `thinking_delta`，并用 `agent_end.messages` 做去重 fallback。 |
| Prompt 生命周期 | 已实现 | OMP `prompt` ACK 只作为接收确认；adapter 等待 `agent_end` + runtime idle 后才返回 ACP `end_turn`。 |
| Tool call / update / diff | 已实现 | 工具事件、失败/取消状态、结构化 diff 与 host-tool result 都会转换为 ACP update。 |
| `session/list` / `session/load` / `session/resume` | 已实现 | 读取 OMP JSONL session，并安全回放可渲染历史。 |
| `session/fork` | 已实现（第一阶段） | 从源 OMP session 当前持久化 head fork；不支持 message-bound fork。 |
| Model / thinking / default mode controls | 已实现 | 来自 OMP `get_state` / `get_available_models`；thinking 选项按当前模型 metadata 动态裁剪。 |
| OMP `confirm` | 部分实现 | 映射到 ACP `session/request_permission`。 |
| OMP `setWidget` | 已实现 | `widgetLines` 显示为 ACP thought/progress 文本。 |
| OMP TODO 状态 | 已实现 | `todo_write` 同步为 ACP `plan`；空 TODO 会清空客户端旧计划。 |
| MCP passthrough / terminal delegation / filesystem delegation | 未实现 | 不在 ACP capability 中声明。 |

完整、逐项可追溯的状态见 [能力矩阵](./docs/compatibility/capability-matrix.md)。

## 安装

### 前置条件

- Node.js >= 20。
- 已安装 `omp` CLI，并且 Zed 启动时继承的 PATH 能找到它；如果找不到，请用 `OMP_ACP_RUNTIME_COMMAND` 指定绝对路径。
- 一个支持 ACP external agent 的客户端，例如 Zed / ZedG。

### 通过 npm 使用

```bash
npx -y omp-acp
```

也可以全局安装：

```bash
npm install -g omp-acp
omp-acp
```

### 从源码运行

```bash
git clone https://github.com/jiwangyihao/omp-acp.git
cd omp-acp
npm install
npm run build
node dist/index.js
```

开发模式：

```bash
node --import tsx src/index.ts
```

## Zed / ZedG 配置

在 Zed `settings.json` 中添加自定义 agent：

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

如果 Zed 找不到 `omp`，只覆盖 OMP 可执行文件路径：

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

本地 checkout 开发配置：

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

启动后，在 Zed Agent Panel 中创建外部 agent thread，选择 `omp-acp` 或你配置的名称。

更多 Zed / ZedG 说明见 [Zed 兼容文档](./docs/compatibility/zed.md)。

## Runtime 配置

| 环境变量 | 用途 |
|---|---|
| `OMP_ACP_RUNTIME_COMMAND` | 只覆盖 OMP 可执行文件。adapter 仍会自动提供默认 RPC 参数。 |
| `OMP_ACP_RUNTIME_ARGS_JSON` | 高级/测试用：完整替换 runtime argv。传入后参数按原样使用。 |
| `OMP_ACP_AGENT_DIR` | 测试或隔离调试用：覆盖 OMP agent directory。 |

默认情况下，adapter 会自行构造 OMP runtime：

```bash
omp --mode rpc --extension <adapter-disable-ask-extension.mjs>
```

不要为了禁用 `ask` 写静态 `--tools` 白名单。静态 allowlist 容易隐藏用户通过 OMP settings、插件、扩展、MCP 或未来版本提供的工具。`omp-acp` 的默认扩展和 session setup guard 只移除 active `ask`，保留其他工具发现行为。

`OMP_ACP_RUNTIME_ARGS_JSON` 仅适合 fixture、smoke 或非常规调试。使用它时，adapter 不会自动补默认 `--mode rpc` 参数；你必须确保完整命令能启动兼容的 OMP RPC runtime。

## 能力边界

### 已支持

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/list`
- `session/load`
- `session/resume`
- `session/fork`（从当前持久化 head fork）
- `session/set_model`
- `session/set_config_option`（当前只支持 `model` / `thinking`）
- `session/set_mode`（当前只支持 `default`）
- `agent_message_chunk` / `agent_thought_chunk`
- `tool_call` / `tool_call_update`
- 结构化 edit diff 的已知 OMP shape
- OMP `confirm` → ACP `session/request_permission`
- OMP `setWidget` → ACP thought/progress text
- OMP `todo_write` → ACP `plan`

### 暂不支持或不声明

- `session/close`
- ACP MCP HTTP / SSE passthrough
- ACP filesystem delegation
- ACP terminal delegation
- ACP usage update
- OMP `select` / `input` / `editor`
- 广义 Ask / elicitation
- OMP-specific runtime knobs 作为 ACP config options：steering、follow-up、interrupt、auto compaction、sampling、provider config、base URL、secrets、tool/MCP toggles
- message-bound fork 或 `_meta.messageId` / `_meta.messageID` fork

## Prompt、并发与取消语义

OMP RPC 的 `prompt` response 只是命令接收确认，不代表模型 turn 已结束。`omp-acp` 会等待：

1. OMP runtime 发出 `agent_end`；
2. `get_state` 确认 runtime 不再 busy；
3. 已排队的 ACP update delivery 完成；

然后才向 ACP client 返回 `stopReason: "end_turn"`。

如果客户端在生成中发送新的普通 `session/prompt`，adapter 会等当前活动 prompt 完全清理后，再作为新的独立 OMP `prompt` 发送。它不会把普通并发 ACP prompt 映射为 OMP `follow_up`，因为 ACP 0.21.0 没有标准 follow-up / queue / steer 原语。

直接「中断并替换 prompt」也不是 ACP 0.21.0 标准能力。客户端可以用 `session/cancel` + 下一次 `session/prompt` 近似实现；adapter 会等待被取消的 runtime turn 清理完成，避免触发 OMP 的 `Agent is already processing`。

## 安全与隐私边界

ACP 可见内容统一经过共享净化边界：

- 不向 ACP client 暴露 provider-private payload、raw provider config、API key、token、secret、signature、encrypted reasoning 或 base URL。
- 历史 `fileMention` 只回放文件路径、URI 或名称，不回放文件内容。
- 工具 `rawInput` / `rawOutput` 会递归净化可见结构。
- 无法安全映射的历史块会跳过，而不是让整次 `session/load` 崩溃。

## 开发与验证

常用命令：

```bash
npm install
npm run typecheck
npm test
npm run check
npm run build
```

ACP 与 runtime smoke：

```bash
npm run smoke:acp
npm run smoke:sdk-client
npm run smoke:omp-rpc-controls:optional
npm run smoke:omp-rpc-controls:required
npm run validate:registry
npm run validate:acpx
npm run validate:standard
```

说明：

- `smoke:omp-rpc-controls:optional` 是开发机诊断；找不到真实 `omp` 时可以 skip，不能作为发布通过依据。
- `smoke:omp-rpc-controls:required` 是发布门禁；skip、timeout、失败都会让发布失败。
- `validate:standard` 会运行自动发布门禁，但不包含 Zed GUI 手工 smoke。
- `openclaw/acpx` 是第三方 draft assessment。它有助于发现协议边界问题，但不是官方 ACP full conformance 证明，也不是 full pass 声明。

## 故障排查

### Zed 里 agent 没启动

- 确认 `npx -y omp-acp` 或 `node dist/index.js` 在终端可运行。
- 确认 Zed 继承的 PATH 能找到 `node` 和 `omp`。
- 如果找不到 `omp`，设置 `OMP_ACP_RUNTIME_COMMAND` 为绝对路径。
- 在 Zed 中运行 `dev: open acp logs` 查看 ACP 日志。

### 下一条消息报 `Agent is already processing`

请确认正在使用 v0.1.1 或更新版本，并重启 / reload Zed 的 `omp-acp` agent。旧进程不会热加载新的 `dist/index.js` 或 npm 包。

### `select` / `input` / `editor` 报 unsupported

这是预期边界。当前只把 OMP `confirm` 映射为 ACP permission；广义 Ask / elicitation 暂不支持，避免把任意交互伪装成权限请求。

### TODO 不显示或显示旧状态

v0.1.1 起，`todo_write` 会同步 ACP `plan`。如果客户端仍显示旧状态，请重启对应 agent/session，确认加载的是新版本。

### ZedG 或 Windows 路径问题

优先使用绝对路径，并避免在 JSON 字符串中漏转义反斜杠。Windows 示例可以使用正斜杠：

```json
{
  "OMP_ACP_RUNTIME_COMMAND": "C:/Users/you/AppData/Local/Programs/omp/omp.exe"
}
```

## 发布状态

当前 npm latest：`omp-acp@0.1.1`。

发布流程：

1. 本地运行 `npm run validate:standard` 和 `npm pack --dry-run --json`。
2. 创建 `vX.Y.Z` Git tag 与 GitHub Release。
3. GitHub Actions 使用 npm Trusted Publishing 发布到 npm。

Zed / ZedG GUI smoke 仍是手工门禁；未执行时不会在发布说明中声称已通过。

## 许可证

`omp-acp` 使用 [Mozilla Public License 2.0](./LICENSE) 发布。
