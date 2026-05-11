# 发布前检查清单

`omp-acp` v0.1.0 已进入发布任务。本清单用于记录发布前后门禁、npm 包配置和 GitHub Release 状态；后续版本仍应在发布前重新跑 fresh 验证。

## 当前验证快照（2026-05-08）

| 门禁 | 当前结果 | 证据 |
|---|---|---|
| `npm run check` | 通过 | 2026-05-08 发布前 fresh run：164 tests pass；包含 prompt lifecycle 回归、session controls、fork、load/resume 与 expanded smoke tests |
| `npm run build` | 通过 | `tsup src/index.ts --format esm --platform node --target node20 --clean` 生成 `dist/index.js` |
| stdio smoke | 通过 | `npm run smoke:acp` 使用 build output 和 fixture runtime 完成 initialize/new/prompt、`session/fork`、session controls 与 setter 后 prompt |
| official SDK client smoke | 通过 | `npm run smoke:sdk-client` 使用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 驱动 build output，覆盖 initialize/new/prompt/list/resume/fork、setup state、session controls 与 setter 后 prompt |
| real OMP RPC controls smoke | 历史 v0.1.0 快照；当前状态需重新验证 | 2026-05-08 发布前 fresh `npm run validate:standard` 内执行并记录为通过；该记录属于历史快照，不能代表当前发布门禁状态。当前发布必须重新运行 `npm run smoke:omp-rpc-controls:required`；顶层 skip、timeout、failure、`dumpTools` 不可用，或 `ask` 存在但无法验证移除/恢复，均不得视为通过。若 active tools 已不含 `ask`，记录 `set_active_tools.skipped` 并视为已满足 ask 禁用边界 |
| Registry-style probe | 通过 | 2026-05-08 发布前 fresh `npm run validate:standard` 内执行；覆盖 capability discovery、session controls probes 与 unsupported-method 边界 |
| `openclaw/acpx` draft assessment | 通过（有 expected draft failures） | 2026-05-08 发布前 fresh `npm run validate:standard` 内执行；固定 `d46e156...`，21 cases，11 passed，10 expected draft failures，0 unexpected；这不是 full pass |
| Zed 手工 smoke | 未执行 | GUI 手工 smoke 未自动化；发布说明不得声称已完成 Zed GUI 手工验证 |

本次发布按用户明确指令进入 GitHub 与 npm 发布任务。自动门禁必须重新跑 fresh 结果；其中 `openclaw/acpx` 仅表示 0 unexpected failure，不表示官方完整 conformance 或 full pass。Zed GUI 手工 smoke 未执行时，只能如实记录未验证，不能在发布说明中声称通过。上表中的 real OMP RPC controls smoke 仅是 v0.1.0 历史快照；当前发布状态以重新运行 required gate 的结果为准。

## 发布边界

`private: true` 只能在明确发布任务中移除；README 和兼容性文档可以在 npm 包发布后提供 `npx -y omp-acp` 路径，但不得暗示未实现能力或 Zed GUI 已人工验证。
- `initialize` 只能声明能力矩阵中已实现且已测试的能力。
- stdout 只能输出 ACP JSON-RPC frame；日志、诊断和 smoke 脚本说明必须走 stderr 或脚本自身 stdout，不得来自 adapter stdout。
- 发布许可证采用 MPL-2.0。发布前已核对参考上游：`pi-acp`、OpenCode ACP 参考实现与 OMP coding agent 均为 MIT；`@agentclientprotocol/sdk` 为 Apache-2.0；未观察到阻止本项目采用 MPL-2.0 的上游许可证约束。

## 发布前自动化门禁

- [ ] 运行 `npm run check`，确认 typecheck 和完整测试集通过。
- [ ] 运行 `npm run build`，确认 build output 可用。
- [ ] 运行 `npm run smoke:acp`，确认 build output 的 ACP stdio smoke 通过。
- [ ] 运行 `npm run smoke:sdk-client`，确认官方 TypeScript SDK client smoke 通过。
- [ ] 运行 `npm run smoke:omp-rpc-controls:required`，确认发布机器真实 OMP RPC controls smoke 通过；顶层 skip、timeout、failure、`dumpTools` 不可用，或 `ask` 存在但无法验证移除/恢复，均为发布门禁失败；active tools 已不含 `ask` 时记录 `set_active_tools.skipped` 并视为通过。
- [ ] 如需开发机诊断，可运行 `npm run smoke:omp-rpc-controls:optional`；optional smoke 可 skip，不是发布通过条件。
- [ ] 运行 `npm run validate:registry`，确认 Registry-style capability discovery、session controls probes 与 unsupported-method 边界通过。
- [ ] 运行 `npx -y omp-acp@<version> --setup` 或本地 `node dist/index.js --setup`，确认 setup flow 不打印 secret，并记录退出码；如果当前机器无真实 OMP 或无模型，必须如实记录，不得把它当成真实 OMP 认证通过。
- [ ] 对 Registry-ready release，确认 `initialize` 在 Registry-style `_meta["terminal-auth"]` 下返回 Terminal Auth，且默认客户端不返回 `authMethods`。
- [ ] 运行 `npm run validate:acpx`，确认 acpx draft assessment 无 unexpected failure，并复核 expected draft failures 是否仍与能力矩阵一致。
- [ ] 如需一次性执行除 Zed 外的自动化门禁，运行 `npm run validate:standard`；该命令必须使用 required real OMP gate。
- [ ] 记录真实 `omp --mode rpc` controls smoke 的版本、PATH 和结果；如果本机 required gate 失败，不得声称发布验证通过。
- [ ] 对照 `docs/compatibility/capability-matrix.md` 检查 `initialize` 输出。

## GitHub Actions 发布流

`.github/workflows/release.yml` 用于 npm Trusted Publisher 后续发布。GitHub 托管 runner 默认没有真实 `omp`，因此 workflow 跑 `check`、stdio smoke、SDK client smoke、registry-style probe 和 `openclaw/acpx` draft assessment；真实 OMP RPC controls smoke 仍必须通过本地 `npm run smoke:omp-rpc-controls:required` 发布前门禁并记录。optional smoke 只用于诊断。

## Zed 手工门禁

执行 `scripts/smoke-zed.md`，并记录：

本机隔离执行建议使用官方 Zed 的独立 user data 目录，避免影响常用的汉化版 ZedG：

```bash
"C:/Users/34404/AppData/Local/Programs/Zed/bin/zed.exe" --user-data-dir "C:/Users/34404/AppData/Local/Zed-OMP-ACP-Smoke" "C:/Users/34404/source/repos/omp-acp"
```

如果当前 shell 无法解析 `zed`，使用上面的绝对路径。

- [ ] new thread。
- [ ] text prompt。
- [ ] tool call / tool update。
- [ ] edit diff。
- [ ] cancel。
- [ ] session list。
- [ ] session load。
- [ ] session resume。
- [ ] 模型 picker 可见，且来自 `session/new` setup state。
- [ ] thinking picker 随当前模型 metadata 动态裁剪；不支持 `xhigh` 的模型不得允许主动提交 `xhigh`。
- [ ] 修改模型、thinking、default mode 后继续 prompt 成功。
- [ ] ACP/Zed 日志不得把 `openclaw/acpx` draft assessment 记为官方 conformance 或 full pass。
- [ ] unsupported capability 不被声明或不被误导性展示。

## 发布决策

本次发布任务由用户明确触发。发布时至少需要重新评估：

1. 是否移除 `private: true`；
2. npm package name 是否可用；
3. package metadata、license、README、files allowlist 是否完整；
4. 是否需要 ACP registry 或 Zed 文档入口；
5. 是否已经覆盖真实 OMP prompt、tool、diff、cancel、session lifecycle 的端到端场景。