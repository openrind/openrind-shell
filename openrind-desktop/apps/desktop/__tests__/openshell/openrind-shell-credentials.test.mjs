// Unit tests for apps/desktop/electron/openshell/openrind-shell-credentials.mjs.
//
// Uses OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR (the test seam baked into the
// module) to read/write plain files instead of going through Electron's
// safeStorage — which isn't available outside the Electron runtime
// and which a Linux dev box wouldn't have a keyring for anyway.
//
// The encrypted-at-rest behavior is covered by manual testing on each
// platform and the Phase 10 E2E spec on Windows.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir;
let testDir;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openrind-shell-creds-test-"));
  testDir = join(workDir, "creds");
  process.env.OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR = testDir;
  // Belt-and-suspenders: also point the production-file env to a
  // temp path so an accidental fallback doesn't write to the dev's
  // real home directory.
  process.env.OPENRIND_DESKTOP_CREDENTIALS_FILE = join(workDir, "production-creds.json");
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR;
  delete process.env.OPENRIND_DESKTOP_CREDENTIALS_FILE;
});

const creds = await import("../../electron/openshell/openrind-shell-credentials.mjs");

test("staged Haloop registration does not persist before a healthy route commits", async () => {
  const options = { sandboxName: "sandbox-review", workspaceId: "workspace-review", agentId: "claude" };
  const staged = await creds.registerHaloopClientProfile({ ...options, deferCommit: true });
  const registry = join(testDir, "haloop-client-profiles.json");
  assert.equal(existsSync(registry), false);
  await staged.commit();
  const saved = JSON.parse(readFileSync(registry, "utf8"));
  assert.equal(saved.profiles[staged.current.scopeId].clientToken, staged.current.clientToken);
});

// ── setCredential ──────────────────────────────────────────────────────

test("setCredential: rejects unknown keys", async () => {
  await assert.rejects(
    () => creds.setCredential("notARealKey", "value"),
    /Unknown Openrind Shell credential key/,
  );
});

test("setCredential: rejects empty values", async () => {
  await assert.rejects(
    () => creds.setCredential("databaseUrl", ""),
    /value is empty/i,
  );
  await assert.rejects(
    () => creds.setCredential("databaseUrl", "   "),
    /value is empty/i,
  );
});

test("setCredential: writes plain file in test mode", async () => {
  await creds.setCredential("databaseUrl", "postgresql://test/db");
  const written = readFileSync(join(testDir, "databaseUrl"), "utf8");
  assert.equal(written, "postgresql://test/db");
});

test("setCredential: overwrites an existing value", async () => {
  await creds.setCredential("databaseUrl", "postgresql://first");
  await creds.setCredential("databaseUrl", "postgresql://second");
  const written = readFileSync(join(testDir, "databaseUrl"), "utf8");
  assert.equal(written, "postgresql://second");
});

test("setCredential: each key writes to its own file", async () => {
  await creds.setCredential("databaseUrl", "DB");
  await creds.setCredential("anthropicApiKey", "AK");
  await creds.setCredential("openrindGatewayApiKey", "SK");
  assert.equal(readFileSync(join(testDir, "databaseUrl"), "utf8"), "DB");
  assert.equal(readFileSync(join(testDir, "anthropicApiKey"), "utf8"), "AK");
  assert.equal(readFileSync(join(testDir, "openrindGatewayApiKey"), "utf8"), "SK");
});

// ── getCredential ──────────────────────────────────────────────────────

test("getCredential: returns null when unset", async () => {
  const value = await creds.getCredential("databaseUrl");
  assert.equal(value, null);
});

test("getCredential: round-trips a stored value", async () => {
  await creds.setCredential("anthropicApiKey", "sk-ant-test-xyz");
  const value = await creds.getCredential("anthropicApiKey");
  assert.equal(value, "sk-ant-test-xyz");
});

test("getCredential: rejects unknown keys", async () => {
  await assert.rejects(
    () => creds.getCredential("notARealKey"),
    /Unknown Openrind Shell credential key/,
  );
});

// ── clearCredential ────────────────────────────────────────────────────

test("clearCredential: removes a stored value", async () => {
  await creds.setCredential("databaseUrl", "DB");
  assert.ok(existsSync(join(testDir, "databaseUrl")));
  await creds.clearCredential("databaseUrl");
  assert.ok(!existsSync(join(testDir, "databaseUrl")));
});

test("clearCredential: is idempotent when the value was never set", async () => {
  // Should not throw.
  await creds.clearCredential("openrindGatewayApiKey");
  await creds.clearCredential("openrindGatewayApiKey");
});

test("clearCredential: only affects the named key", async () => {
  await creds.setCredential("databaseUrl", "DB");
  await creds.setCredential("anthropicApiKey", "AK");
  await creds.clearCredential("databaseUrl");
  const stillThere = await creds.getCredential("anthropicApiKey");
  assert.equal(stillThere, "AK");
});

// ── getCredentialStatus ────────────────────────────────────────────────

test("getCredentialStatus: all unset on a fresh dir", async () => {
  const status = await creds.getCredentialStatus();
  assert.equal(status.databaseUrl, "unset");
  assert.equal(status.anthropicApiKey, "unset");
  assert.equal(status.openrindGatewayApiKey, "unset");
});

test("getCredentialStatus: reflects mixed state", async () => {
  await creds.setCredential("databaseUrl", "DB");
  await creds.setCredential("openrindGatewayApiKey", "sk-st-gateway-key-1234");
  const status = await creds.getCredentialStatus();
  assert.equal(status.databaseUrl, "set");
  assert.equal(status.anthropicApiKey, "unset");
  assert.equal(status.openrindGatewayApiKey, "set");
  assert.equal(status.databaseUrl_masked, "••••••");
  assert.equal(status.openrindGatewayApiKey_masked, "sk••••34");
  assert.ok(status.databaseUrl_updatedAt > 0);
  assert.ok(status.openrindGatewayApiKey_updatedAt > 0);
});

test("getCredentialStatus: encryptionAvailable is true in test mode", async () => {
  // In test mode (OPENRIND_DESKTOP_TEST_CREDENTIALS_DIR set), we bypass
  // safeStorage entirely. The renderer treats encryptionAvailable=true
  // as "fine to save." The real safeStorage check kicks in only when
  // production-file mode is active.
  const status = await creds.getCredentialStatus();
  assert.equal(status.encryptionAvailable, true);
});

test("Haloop profiles use stable, distinct scoped client tokens", async () => {
  const first = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-a",
    workspaceId: "workspace-1",
    agentId: "claude",
  });
  const repeated = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-a",
    workspaceId: "workspace-1",
    agentId: "claude",
  });
  const second = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-a",
    workspaceId: "workspace-1",
    agentId: "openclaw",
  });

  assert.match(first.current.clientToken, /^orh_v1_[A-Za-z0-9_-]+$/);
  assert.equal(repeated.current.clientToken, first.current.clientToken);
  assert.notEqual(second.current.clientToken, first.current.clientToken);
  assert.equal(second.profiles.length, 2);
  assert.notEqual(second.current.providerName, first.current.providerName);

  const stored = readFileSync(join(testDir, "haloop-client-profiles.json"), "utf8");
  assert.doesNotMatch(stored, /sk-ant-/);
});

test("Haloop token rotation replaces only the exact existing scoped token", async () => {
  const claudeInput = {
    sandboxName: "workspace-rotate",
    workspaceId: "workspace-rotate-id",
    agentId: "claude",
  };
  const openclawInput = { ...claudeInput, agentId: "openclaw" };
  const claude = await creds.registerHaloopClientProfile(claudeInput);
  const openclaw = await creds.registerHaloopClientProfile(openclawInput);

  const rotated = await creds.rotateHaloopClientProfile(claudeInput);
  const retainedOpenClaw = rotated.profiles.find(
    (profile) => profile.scopeId === openclaw.current.scopeId,
  );

  assert.equal(rotated.current.id, claude.current.id);
  assert.equal(rotated.current.providerName, claude.current.providerName);
  assert.notEqual(rotated.current.clientToken, claude.current.clientToken);
  assert.equal(retainedOpenClaw.clientToken, openclaw.current.clientToken);
  const stored = JSON.parse(
    readFileSync(join(testDir, "haloop-client-profiles.json"), "utf8"),
  );
  assert.equal(stored.profiles[claude.current.scopeId].clientToken, rotated.current.clientToken);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(claude.current.clientToken));
});

test("Haloop token rotation refuses to create a missing scope", async () => {
  await assert.rejects(
    () => creds.rotateHaloopClientProfile({
      sandboxName: "workspace-missing",
      workspaceId: "workspace-missing-id",
      agentId: "claude",
    }),
    /does not exist.*launch the sandbox/i,
  );
  assert.equal(existsSync(join(testDir, "haloop-client-profiles.json")), false);
});

test("Haloop sandbox revocation removes every matching scope after the teardown callback", async () => {
  const claude = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-revoke",
    workspaceId: "workspace-revoke-id",
    agentId: "claude",
  });
  const openclaw = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-revoke",
    workspaceId: "workspace-revoke-id",
    agentId: "openclaw",
  });
  const survivor = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-survives",
    workspaceId: "workspace-survives-id",
    agentId: "claude",
  });
  const profilePath = join(testDir, "haloop-client-profiles.json");
  let callbackObservedStoredCredentials = false;

  const revoked = await creds.revokeHaloopClientProfilesForSandbox({
    sandboxName: "workspace-revoke",
    beforePersist: async ({ revoked: pending }) => {
      assert.deepEqual(
        pending.map((profile) => profile.providerName).sort(),
        [claude.current.providerName, openclaw.current.providerName].sort(),
      );
      assert.ok(pending.every((profile) => !("clientToken" in profile)));
      const before = readFileSync(profilePath, "utf8");
      assert.match(before, new RegExp(claude.current.clientToken));
      assert.match(before, new RegExp(openclaw.current.clientToken));
      callbackObservedStoredCredentials = true;
    },
  });

  assert.equal(callbackObservedStoredCredentials, true);
  assert.equal(revoked.revoked.length, 2);
  assert.equal(revoked.profiles.length, 1);
  assert.equal(revoked.profiles[0].scopeId, survivor.current.scopeId);
  assert.equal(revoked.profiles[0].clientToken, survivor.current.clientToken);
  const after = readFileSync(profilePath, "utf8");
  assert.doesNotMatch(after, new RegExp(claude.current.clientToken));
  assert.doesNotMatch(after, new RegExp(openclaw.current.clientToken));
  assert.match(after, new RegExp(survivor.current.clientToken));

  const repeated = await creds.revokeHaloopClientProfilesForSandbox({
    sandboxName: "workspace-revoke",
  });
  assert.equal(repeated.revoked.length, 0);
  assert.equal(repeated.profiles[0].clientToken, survivor.current.clientToken);
});

test("Haloop sandbox revocation preserves stored credentials when teardown fails", async () => {
  const registered = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-retry",
    workspaceId: "workspace-retry-id",
    agentId: "claude",
  });
  const profilePath = join(testDir, "haloop-client-profiles.json");

  await assert.rejects(
    creds.revokeHaloopClientProfilesForSandbox({
      sandboxName: "workspace-retry",
      beforePersist: async () => {
        throw new Error("provider cleanup failed");
      },
    }),
    /provider cleanup failed/,
  );

  const stored = readFileSync(profilePath, "utf8");
  assert.match(stored, new RegExp(registered.current.clientToken));
});

test("Haloop integration revocation removes every scoped profile only after teardown", async () => {
  const claude = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-all-a",
    workspaceId: "workspace-all-a-id",
    agentId: "claude",
  });
  const openclaw = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-all-b",
    workspaceId: "workspace-all-b-id",
    agentId: "openclaw",
  });
  const profilePath = join(testDir, "haloop-client-profiles.json");
  let callbackObservedStoredCredentials = false;

  const revoked = await creds.revokeAllHaloopClientProfiles({
    beforePersist: async ({ revoked: pending }) => {
      assert.deepEqual(
        pending.map((profile) => profile.providerName).sort(),
        [claude.current.providerName, openclaw.current.providerName].sort(),
      );
      assert.ok(pending.every((profile) => !("clientToken" in profile)));
      const before = readFileSync(profilePath, "utf8");
      assert.match(before, new RegExp(claude.current.clientToken));
      assert.match(before, new RegExp(openclaw.current.clientToken));
      callbackObservedStoredCredentials = true;
    },
  });

  assert.equal(callbackObservedStoredCredentials, true);
  assert.equal(revoked.revoked.length, 2);
  assert.deepEqual(revoked.profiles, []);
  assert.equal(existsSync(profilePath), false);
  const repeated = await creds.revokeAllHaloopClientProfiles();
  assert.deepEqual(repeated.revoked, []);
});

test("Haloop integration revocation preserves every profile when teardown fails", async () => {
  const registered = await creds.registerHaloopClientProfile({
    sandboxName: "workspace-all-retry",
    workspaceId: "workspace-all-retry-id",
    agentId: "claude",
  });
  const profilePath = join(testDir, "haloop-client-profiles.json");

  await assert.rejects(
    creds.revokeAllHaloopClientProfiles({
      beforePersist: async () => {
        throw new Error("integration provider cleanup failed");
      },
    }),
    /integration provider cleanup failed/,
  );
  assert.match(readFileSync(profilePath, "utf8"), new RegExp(registered.current.clientToken));
});

test("Haloop sandbox revocation rejects an invalid sandbox identity", () => {
  assert.throws(
    () => creds.revokeHaloopClientProfilesForSandbox({ sandboxName: "../escape" }),
    /valid sandbox name is required/i,
  );
});

test("Haloop profile registration rejects unsupported agents", async () => {
  assert.throws(
    () => creds.registerHaloopClientProfile({
      sandboxName: "workspace-a",
      workspaceId: "workspace-1",
      agentId: "generic",
    }),
    /Claude, OpenClaw, Codex, and OpenHands only/,
  );
});
