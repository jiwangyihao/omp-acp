export type CliMode =
  | { kind: "acp" }
  | { kind: "setup" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export function parseCliMode(argv: readonly string[]): CliMode {
  if (argv.length === 0) {
    return { kind: "acp" };
  }

  if (argv.length === 1) {
    const arg = argv[0];
    if (arg === "--setup") {
      return { kind: "setup" };
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--version" || arg === "-v") {
      return { kind: "version" };
    }
  }

  return { kind: "error", message: `Unknown omp-acp argument: ${argv.join(" ")}` };
}
