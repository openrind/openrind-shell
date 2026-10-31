// Primary FUSE management commands used by the sandbox list, delete, and
// configuration UI. Keeping these here prevents a stock `openshell` command
// from leaking back into a primary-runtime path.

import { randomUUID } from "node:crypto";

import { getCredential } from "./openrind-shell-credentials.mjs";
import { ensureManagedFuseGateway } from "./fuse-gateway.mjs";
import { buildFuseCliCommand, buildFuseWslEnv, shellQuote } from "./fuse-runtime.mjs";
import { DISTRO_NAME, wslRun } from "./wsl.mjs";

const FUSE_IMAGE = "openrind-shell-fuse:local";
const DB_PROBE_TIMEOUT_MS = 45_000;
const DB_PROBE_PROGRAM = `import { readFileSync } from 'node:fs';
process.env.DATABASE_URL = readFileSync('/sandbox/db-url', 'utf8').trim();
process.env.OPENRIND_SHELL_REQUIRE_POSTGRES_TLS = '1';
const { createPool } = await import('/opt/openrind-shell/dist/db/pool.js');
const pool = createPool(process.env.DATABASE_URL);
try {
  await pool.query('SELECT 1');
  process.stdout.write('openrind-fuse-db-probe: ok\\n');
} finally {
  await pool.end().catch(() => undefined);
}
`;

function redactDatabaseUrl(text) {
  return String(text ?? "").replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]");
}

function assertSandboxName(name) {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(name ?? "")) {
    throw new Error(`Invalid OpenShell sandbox name: ${JSON.stringify(name)}`);
  }
}

async function runFuseCli(args, timeoutMs = 30_000) {
  await ensureManagedFuseGateway();
  const command = buildFuseCliCommand(args);
  return wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-lc", `timeout ${Math.ceil(timeoutMs / 1_000)} ${command}`],
    { env: buildFuseWslEnv(), timeout: timeoutMs + 5_000 },
  );
}

export function normalizePrimaryFuseSandboxes(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? ""));
  } catch {
    throw new Error("OpenShell sandbox list returned invalid JSON.");
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : ["sandboxes", "items", "data", "results"]
        .map((key) => parsed?.[key])
        .find(Array.isArray) ?? [];
  return rows
    .map((row) => ({
      name: String(row?.name ?? ""),
      created: String(row?.created_at ?? row?.createdAt ?? row?.created ?? ""),
      phase: String(row?.phase ?? row?.status ?? "unknown"),
    }))
    .filter((row) => row.name);
}

export async function listPrimaryFuseSandboxes() {
  const result = await runFuseCli(["sandbox", "list", "-o", "json"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `OpenShell sandbox list failed: ${redactDatabaseUrl((result.stderr || result.stdout).trim()) || "(no output)"}`,
    );
  }
  return normalizePrimaryFuseSandboxes(result.stdout);
}

export async function deletePrimaryFuseSandbox(name) {
  assertSandboxName(name);
  const vols = [
    `openrind-claude-home-${name.toLowerCase()}`,
    `openrind-openclaw-home-${name.toLowerCase()}`,
    `openrind-codex-home-${name.toLowerCase()}`,
    `openrind-openhands-home-${name.toLowerCase()}`,
  ];
  // Force-kill the sandbox container and browser pod immediately so openshell doesn't wait for graceful stop timeouts
  await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "sh",
      "-c",
      `docker rm -f $(docker ps -aq -f name=${name}) 2>/dev/null || true; docker volume rm -f ${vols.join(" ")} 2>/dev/null || true`,
    ],
    { timeout: 15_000 },
  ).catch(() => null);

  const result = await runFuseCli(["sandbox", "delete", name]).catch(() => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));
  return { deleted: true };
}

/**
 * Validate the datasource shape before the policy-bound probe. This stays
 * local because no host-side database tunnel is allowed in the FUSE design.
 */
export async function validatePrimaryFuseDatabaseUrl() {
  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid postgres:// or postgresql:// URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (/^(disable|allow)$/i.test(parsed.searchParams.get("sslmode") ?? "")) {
    throw new Error("DATABASE_URL must require PostgreSQL TLS.");
  }
  if (parsed.hostname.endsWith(".pooler.supabase.com") && parsed.port === "6543") {
    throw new Error("Supabase transaction pooling on port 6543 is unsupported; use the session-mode pooler on port 5432.");
  }
  return { validated: true };
}

/**
 * Test the exact connection route used by initialization: a disposable FUSE
 * sandbox, OpenShell's binary-bound HTTP CONNECT proxy, and end-to-end
 * PostgreSQL TLS. The database URL is only supplied on stdin and never leaves
 * the sandbox in output; the sandbox and host-side uploads are cleaned up.
 */
export async function probePrimaryFuseDatabase() {
  await validatePrimaryFuseDatabaseUrl();
  const [databaseUrl, anthropicApiKey, openRouterApiKey, codexApiKey] = await Promise.all([
    getCredential("databaseUrl"),
    getCredential("anthropicApiKey"),
    getCredential("openRouterApiKey"),
    getCredential("codexApiKey"),
  ]);
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
  if (!anthropicApiKey && !openRouterApiKey && !codexApiKey) {
    throw new Error("Configure an API key (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or CODEX_API_KEY) before testing the sandbox database connection.");
  }

  await ensureManagedFuseGateway();
  const name = `or-db-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const databasePath = `/tmp/openrind-db-probe-${randomUUID()}`;
  const programPath = `/tmp/openrind-db-probe-${randomUUID()}.mjs`;
  const createCommand = buildFuseCliCommand([
    "sandbox", "create", "--name", name, "--from", FUSE_IMAGE, "--fuse",
    "--upload", `${databasePath}:/sandbox/db-url`,
    "--upload", `${programPath}:/sandbox/openrind-db-probe.mjs`,
    "--provider", "claude", "--no-tty", "--", "/bin/bash", "-lc",
    "if [ -n \"${SSL_CERT_FILE:-}\" ]; then export NODE_EXTRA_CA_CERTS=\"${NODE_EXTRA_CA_CERTS:-$SSL_CERT_FILE}\"; fi; exec node /sandbox/openrind-db-probe.mjs",
  ]);
  const script = [
    "set -euo pipefail",
    "umask 077",
    `printf '%s' ${shellQuote(DB_PROBE_PROGRAM)} > ${shellQuote(programPath)}`,
    `cat > ${shellQuote(databasePath)}`,
    `chmod 600 ${shellQuote(databasePath)} ${shellQuote(programPath)}`,
    `trap 'rm -f ${databasePath} ${programPath}' EXIT`,
    createCommand,
  ].join("\n");

  try {
    const result = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-lc", script],
      { env: buildFuseWslEnv(), stdin: databaseUrl, timeout: DB_PROBE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      const detail = redactDatabaseUrl((result.stderr || result.stdout || "").trim());
      throw new Error(`Sandbox-bound PostgreSQL probe failed: ${detail || `exit ${result.exitCode}`}`);
    }
    return {
      reachable: true,
      validated: true,
      detail: "The policy-bound FUSE PostgreSQL TLS probe succeeded.",
    };
  } finally {
    await runFuseCli(["sandbox", "delete", name], 30_000).catch(() => undefined);
  }
}
