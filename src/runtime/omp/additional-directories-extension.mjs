const ADDITIONAL_DIRS_ENV = "OMP_ACP_ADDITIONAL_DIRS_JSON";

export default function additionalDirectoriesInAcp(pi) {
  pi.on("before_agent_start", async (event) => {
    const directories = readAdditionalDirectories();
    if (directories.length === 0) return;
    const section = [
      "## Additional workspace roots",
      "",
      "Besides the working directory, the following directories are part of this workspace.",
      "Read and modify files inside them using absolute paths:",
      "",
      ...directories.map((directory) => `- ${directory}`),
    ].join("\n");
    return { systemPrompt: [...event.systemPrompt, section] };
  });
}

function readAdditionalDirectories() {
  const raw = process.env[ADDITIONAL_DIRS_ENV];
  if (raw === undefined || raw.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry) => typeof entry === "string" && entry.length > 0);
}
