# OpenCode ACP reference notes

- Documentation: <https://opencode.ai/docs/acp>
- Reviewed date: 2026-05-07

## Compatibility target

OpenCode exposes ACP through `opencode acp` and documents editor configuration using JSON-RPC over stdio. Its ACP support is the practical maturity target for this project.

Observed documented capabilities include:

- Built-in file and terminal tools.
- Custom tools and slash commands.
- MCP servers from OpenCode config.
- Project-specific rules.
- Agents and permissions.

## OMP-specific bar

`omp-acp` should not claim parity until equivalent behavior is implemented and covered by automated tests or Zed smoke tests. OMP-specific extensions, skills, config discovery, and RPC error semantics should be first-class behavior, not compatibility fallbacks.