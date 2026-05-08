# Zed 手工 smoke 清单

本文档用于在发布前验证 `omp-acp` 作为 Zed custom external agent 的真实交互行为。它不是自动化脚本；执行者需要在本机 Zed 中逐项记录结果。

## 前置条件

- 已运行 `npm install`。
- 已运行 `npm run build`，并确认 `dist/index.js` 存在。
- `omp --version` 可在启动 Zed 的环境中解析。
- 不使用 `OMP_ACP_RUNTIME_COMMAND`、`OMP_ACP_RUNTIME_ARGS_JSON` 或 `OMP_ACP_AGENT_DIR` fixture seam。
- Zed 配置使用本地 checkout 的 build output，而不是未发布的 `npx` 包。
- 如需隔离常用的汉化版 ZedG，使用官方 Zed 的 `--user-data-dir` 指向独立目录，例如 `C:/Users/34404/AppData/Local/Zed-OMP-ACP-Smoke`。

示例配置：

```json
{
  "agent_servers": {
    "omp-acp-local": {
      "type": "custom",
      "command": "node",
      "args": [
        "C:/Users/34404/source/repos/omp-acp/dist/index.js"
      ],
      "env": {}
    }
  }
}
```

隔离启动命令：

```bash
"C:/Users/34404/AppData/Local/Programs/Zed/bin/zed.exe" --user-data-dir "C:/Users/34404/AppData/Local/Zed-OMP-ACP-Smoke" "C:/Users/34404/source/repos/omp-acp"
```

## 执行步骤

1. 在 Zed 中打开 ACP 日志（`dev: open acp logs`）。
2. 新建 agent thread，选择 `omp-acp-local`。
3. 发送一个纯文本 prompt，例如：`Say hello from OMP ACP smoke.`
4. 触发一个只读工具调用，例如要求查看当前项目的 README。
5. 触发一个 edit diff，例如要求对临时测试文件做小改动；确认 Zed UI 展示结构化 diff。
6. 发起较长 prompt 后执行 cancel；确认 prompt 以 cancel 结束，且 late chunks 不继续写入当前 turn。
7. 打开历史 session 列表；确认可见 OMP session。
8. 对一个 session 执行 load；确认 text history replay 可见。
9. 对一个 session 执行 resume；确认不会 replay history，后续 prompt 仍进入同一 OMP session。
10. 打开模型 picker；确认可见模型列表来自 `session/new`/setup state，不显示 provider secret、API key、base URL 或完整 provider config。
11. 打开 thinking picker；切换不同模型时确认 thinking 选项按当前模型 metadata 动态裁剪，不支持 `xhigh` 的模型不得允许主动提交 `xhigh`。
12. 分别修改模型、thinking 和 default mode 后发送 prompt；确认 prompt 仍正常完成。
13. 检查 ACP/Zed 日志；不得把 `openclaw/acpx` draft assessment 记录或描述成 ACP 官方 conformance/full pass。

## 通过标准

- Zed ACP 日志中 `initialize` 的能力与 `docs/compatibility/capability-matrix.md` 一致。
- stdout 只包含 ACP JSON-RPC frame；诊断信息不得污染 stdout。
- `session/new`、`session/prompt`、`session/cancel`、`session/list`、`session/load`、`session/resume`、`session/fork` 和 Stage 8B session controls 均按当前能力矩阵表现。
- tool call、tool update、failed/cancelled tool status 和 structured diff 可被 Zed UI 正确展示。
- 不支持能力不会被显示成可用能力；尤其是 MCP HTTP/SSE、audio、session close、permission UX、usage update、多 OMP mode、sampling/service tier/tools toggles。

## 失败记录模板

```text
日期：
Zed 版本：
OMP 版本：
omp-acp commit：
失败步骤：
期望结果：
实际结果：
ACP 日志位置或摘录：
是否 stdout 污染：是 / 否
session controls（模型 / thinking / default mode）：通过 / 失败 / 未验证
是否存在 secret/base URL/provider config 泄漏：是 / 否
```