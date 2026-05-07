# pi-acp reference notes

- Upstream repository: <https://github.com/svkozak/pi-acp>
- Reviewed commit: `399a758fb6aa6229385aae6ee7a08a8b8814fed0`
- Reviewed date: 2026-05-07
- Package observed: `pi-acp@0.0.26`

## Use as reference

- ACP JSON-RPC server structure.
- Session update ordering.
- Tool call and tool update mapping.
- Structured edit diff presentation.
- Session listing edge cases that are protocol-generic.

## Do not inherit as OMP semantics

- Pi config discovery.
- Pi session directory handling.
- `pi.extensions` command discovery.
- Pi auth and installation flows.
- Pi runtime event assumptions unless confirmed against `omp --mode rpc`.

## Upstream intake rule

Cherry-pick or reimplement changes only when they are ACP/Zed-generic or can be converted into OMP contract tests. Do not merge upstream wholesale.