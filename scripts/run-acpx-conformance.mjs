import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACXP_REF = "d46e1561020aafb4b88c4bad314fe4c883829a5a";
const PROFILE_ID = "acp-core-v1";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const adapterEntry = process.env.OMP_ACP_SMOKE_ENTRY ?? resolve(repoRoot, "dist/index.js");
const fixtureEntry = resolve(repoRoot, "src/testing/script-rpc-process.ts");
const timeoutMs = Number.parseInt(process.env.OMP_ACP_ACPX_TIMEOUT_MS ?? "120000", 10);

const expectedDraftFailures = new Map([
  [
    "acp.v1.session.cancel.in_flight",
    "fixture runtime returns immediately for `sleep 5000`, so the draft cancellation case cannot observe an in-flight turn",
  ],
  [
    "acp.v1.errors.permission_denied",
    "adapter does not currently declare or implement ACP client-authority file permission flows",
  ],
  [
    "acp.v1.errors.unknown_session",
    "adapter returns SDK resource-not-found (-32002), while this draft case currently accepts only -32603/-32000 for unknown session",
  ],
  [
    "acp.v1.errors.permission_denied.write",
    "adapter does not currently declare or implement ACP client-authority file write permission flows",
  ],
  [
    "acp.v1.session.prompt.unrecognized",
    "fixture runtime is deterministic for adapter validation and does not emulate acpx's mock-agent text for unknown commands",
  ],
  [
    "acp.v1.session.prompt.structured_blocks",
    "adapter translates structured prompt blocks into OMP prompt text; it does not echo raw ACP block JSON back to the client",
  ],
  [
    "acp.v1.permissions.read.approved",
    "adapter does not currently declare or implement ACP client-authority file permission flows",
  ],
  [
    "acp.v1.permissions.write.approved",
    "adapter does not currently declare or implement ACP client-authority file write permission flows",
  ],
  [
    "acp.v1.session.cancel.followup_prompt",
    "fixture runtime returns immediately for `sleep 5000`, so cancellation cannot produce the draft case's required cancelled result",
  ],
  [
    "acp.v1.session.prompt.post_success_drain",
    "fixture runtime does not emit acpx mock-agent late tool-call frames after prompt success",
  ],
]);

const tempRoot = await mkdtemp(resolve(repoRoot, ".tmp-omp-acp-acpx-"));
const acpxRoot = resolve(tempRoot, "acpx");
const profilePath = resolve(acpxRoot, "conformance/profiles/acp-core-v1.json");
const casesDir = resolve(acpxRoot, "conformance/cases");
const runnerPath = resolve(acpxRoot, "conformance/runner/run.ts");
const agentDir = resolve(tempRoot, "agent");
const reportPath = resolve(tempRoot, "acpx-report.json");

try {
  await mkdir(agentDir, { recursive: true });
  await downloadAcpxSuite(acpxRoot);

  const report = await runAcpxRunner({ profilePath, casesDir, runnerPath, agentDir, reportPath });
  assert.equal(report.profileId, PROFILE_ID);

  const failed = report.results.filter((result) => !result.passed);
  const passed = report.results.filter((result) => result.passed);
  const unexpectedFailures = failed.filter((result) => !expectedDraftFailures.has(result.id));
  const expectedButPassed = passed.filter((result) => expectedDraftFailures.has(result.id));

  if (unexpectedFailures.length > 0) {
    const details = unexpectedFailures.map((result) => `- ${result.id}: ${result.error}`).join("\n");
    throw new Error(`Unexpected acpx draft conformance failures:\n${details}`);
  }

  const summary = {
    acpxRef: ACXP_REF,
    profile: report.profileId,
    totals: report.totals,
    expectedDraftFailures: failed.map((result) => ({
      id: result.id,
      reason: expectedDraftFailures.get(result.id),
      error: result.error,
    })),
    expectedFailureCasesThatNowPass: expectedButPassed.map((result) => result.id),
  };

  console.log(`ACP acpx draft conformance assessment completed using ${adapterEntry}`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function downloadAcpxSuite(root) {
  await Promise.all([
    downloadRaw("conformance/runner/run.ts", resolve(root, "conformance/runner/run.ts")),
    downloadRaw("conformance/profiles/acp-core-v1.json", resolve(root, "conformance/profiles/acp-core-v1.json")),
  ]);

  const caseFiles = await listCaseFiles();
  for (const fileName of caseFiles) {
    await downloadRaw(`conformance/cases/${fileName}`, resolve(root, "conformance/cases", fileName));
  }
}

async function listCaseFiles() {
  const url = `https://api.github.com/repos/openclaw/acpx/contents/conformance/cases?ref=${ACXP_REF}`;
  const response = await fetchWithRetries(url);
  if (!response.ok) {
    throw new Error(`Failed to list acpx cases from ${url}: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("GitHub contents API returned a non-array response for acpx cases");
  }
  const caseFiles = payload
    .filter((entry) => entry.type === "file" && typeof entry.name === "string" && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (caseFiles.length === 0) {
    throw new Error("No acpx case files found");
  }
  return caseFiles;
}

async function downloadRaw(relativePath, destination) {
  const url = `https://raw.githubusercontent.com/openclaw/acpx/${ACXP_REF}/${relativePath}`;
  const response = await fetchWithRetries(url);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await response.text(), "utf8");
}

async function fetchWithRetries(url) {
  const maxAttempts = 4;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headers = { "User-Agent": "omp-acp-validation", ...authorizationHeaders() };
      const response = await fetch(url, { headers });
      if (response.ok) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolveAttempt) => setTimeout(resolveAttempt, attempt * 250));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message ?? String(lastError)}`);
}

function authorizationHeaders() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined || token.length === 0) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

async function runAcpxRunner({ profilePath, casesDir, runnerPath, agentDir, reportPath }) {
  const agentCommand = quoteCommand([process.execPath, adapterEntry]);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      runnerPath,
      "--profile",
      profilePath,
      "--cases-dir",
      casesDir,
      "--agent-command",
      agentCommand,
      "--format",
      "json",
      "--report",
      reportPath,
      "--cwd",
      repoRoot,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OMP_ACP_AGENT_DIR: agentDir,
        OMP_ACP_RUNTIME_COMMAND: process.execPath,
        OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--import", "tsx", fixtureEntry, "session-happy"]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const { stdout, stderr, exitCode } = await collectChild(child, timeoutMs, "acpx conformance runner");
  const report = parseReport(stdout);
  if (report === undefined) {
    throw new Error(
      [
        `acpx conformance runner exited with code ${exitCode} but did not emit JSON report`,
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return report;
}

function collectChild(child, timeout, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      rejectPromise(new Error(`${label} timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code });
    });
  });
}

function parseReport(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.results)) {
        return parsed;
      }
    } catch {
      // Keep scanning; the runner may print diagnostics before the JSON line.
    }
  }
  return undefined;
}

function quoteCommand(parts) {
  return parts.map(quoteCommandPart).join(" ");
}

function quoteCommandPart(part) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(part)) {
    return part;
  }
  return `"${part.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}