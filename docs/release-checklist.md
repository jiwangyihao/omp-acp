# 发布前检查清单

`omp-acp` 当前仍是 `private` 包。本清单用于决定何时可以从本地开发状态进入发布准备；未完成所有发布门禁前，不应移除 `private: true`，也不应发布或文档化 `npx -y omp-acp`。

## 当前验证快照（2026-05-08）

| 门禁 | 当前结果 | 证据 |
|---|---|---|
| `npm run check` | 通过 | `tests 114, pass 114, fail 0` |
| `npm run build` | 通过 | `tsup src/index.ts --format esm --platform node --target node20 --clean` 生成 `dist/index.js` |
| stdio smoke | 通过 | `npm run smoke:acp` 使用 build output 和 fixture runtime 完成 initialize/new/prompt |
| official SDK client smoke | 通过 | `npm run smoke:sdk-client` 使用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 驱动 build output，覆盖 initialize/new/prompt/list/resume |
| 真实 `omp --mode rpc` ready smoke | 通过 | `omp --version` 输出 `omp/14.7.6`；`omp --mode rpc` 输出 ready frame |
| Zed 手工 smoke | 未执行 | 已安装隔离用官方 Zed：`C:/Users/34404/AppData/Local/Programs/Zed/bin/zed.exe --version` 输出 `Zed 1.1.6 ...`；`zed` 仍未加入当前 PATH；GUI 手工步骤尚未执行 |

## 必须保持的发布边界

- `package.json` 必须保留 `private: true`，直到明确进入发布任务。
- README 和兼容性文档不得提供未发布包的 `npx -y omp-acp` 安装路径。
- `initialize` 只能声明能力矩阵中已实现且已测试的能力。
- stdout 只能输出 ACP JSON-RPC frame；日志、诊断和 smoke 脚本说明必须走 stderr 或脚本自身 stdout，不得来自 adapter stdout。

## 发布前自动化门禁

- [ ] 运行 `npm run check`，确认 typecheck 和完整测试集通过。
- [ ] 运行 `npm run build`，确认 build output 可用。
- [ ] 运行 `npm run smoke:acp`，确认 build output 的 ACP stdio smoke 通过。
- [ ] 运行 `npm run smoke:sdk-client`，确认官方 TypeScript SDK client smoke 通过。
- [ ] 运行真实 `omp --mode rpc` ready smoke；如果本机不可用，记录版本、PATH 和失败原因。
- [ ] 对照 `docs/compatibility/capability-matrix.md` 检查 `initialize` 输出。

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
- [ ] unsupported capability 不被声明或不被误导性展示。

## 发布决策

只有当自动化门禁和 Zed 手工门禁全部通过后，才可以开始单独的发布任务。发布任务至少需要重新评估：

1. 是否移除 `private: true`；
2. npm package name 是否可用；
3. package metadata、license、README、files allowlist 是否完整；
4. 是否需要 ACP registry 或 Zed 文档入口；
5. 是否已经覆盖真实 OMP prompt、tool、diff、cancel、session lifecycle 的端到端场景。