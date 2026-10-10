import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTIC_CONTRACT, resolveDiagnosticRoute } from "../../electron/openshell/diagnostic-route.mjs";

const now = 100_000;
const valid = { contract: DIAGNOSTIC_CONTRACT, protocol: "http/protobuf",
  endpoint: "https://telemetry.example.test", project: "owner", sandboxName: "owner",
  signals: ["traces", "logs", "metrics"], authorization: "Bearer fixture-only", expiresAtMs: now + 60_000 };

test("managed route uses the private control contract and never infers an inference address", async () => {
  let request;
  const config = await resolveDiagnosticRoute({ sandboxName: "owner", now: () => now,
    requestRoute: async value => { request = value; return { status: 200, body: valid }; } });
  assert.deepEqual(request, { method: "POST", requestPath: "/diagnostics/route", timeoutMs: 3000,
    body: { contract: DIAGNOSTIC_CONTRACT, sandboxName: "owner" } });
  assert.equal(config.endpoint, valid.endpoint);
  assert.deepEqual(await config.headers(), { authorization: valid.authorization });
  assert.equal(JSON.stringify(config).includes("fixture-only"), false);
});

test("old receivers remain explicitly unsupported", async () => {
  for (const status of [404, 501]) {
    assert.equal(await resolveDiagnosticRoute({ sandboxName: "owner", requestRoute: async () => ({ status }) }), null);
  }
});

test("rejects mismatched scope, expired tokens, unsupported contracts and non-origin URLs", async () => {
  for (const change of [
    { project: "other" }, { sandboxName: "other" }, { expiresAtMs: now }, { contract: "unknown" },
    { protocol: "grpc" }, { signals: ["traces"] }, { authorization: "Bearer secret\r\n" },
    { endpoint: "https://secret@example.test" }, { endpoint: "https://example.test/v1/messages" },
    { endpoint: "https://example.test?secret=1" }, { endpoint: "file:///tmp/receiver" },
  ]) {
    await assert.rejects(resolveDiagnosticRoute({ sandboxName: "owner", now: () => now,
      requestRoute: async () => ({ status: 200, body: { ...valid, ...change } }) }),
    error => error.code === "route_invalid" && !error.message.includes("secret"));
  }
});

test("authentication and transport failures stay distinct and redact underlying errors", async () => {
  for (const status of [401, 403, 503]) {
    await assert.rejects(resolveDiagnosticRoute({ sandboxName: "owner",
      requestRoute: async () => ({ status, body: { secret: "private" } }) }),
    error => error.code === (status === 503 ? "route_unavailable" : "route_unauthorized"));
  }
  await assert.rejects(resolveDiagnosticRoute({ sandboxName: "owner",
    requestRoute: async () => { throw new Error("private-token"); } }),
  error => error.message === "route_unavailable");
});

test("concurrent export attempts share renewal without changing scope or destination", async () => {
  let clock = now;
  let requests = 0;
  const config = await resolveDiagnosticRoute({ sandboxName: "owner", now: () => clock,
    requestRoute: async () => {
      requests++;
      return { status: 200, body: { ...valid, expiresAtMs: clock + 60_000, authorization: `Bearer fixture-${requests}` } };
    } });
  clock += 31_000;
  const results = await Promise.all([config.headers(), config.headers()]);
  assert.equal(requests, 2);
  assert.deepEqual(results, [{ authorization: "Bearer fixture-2" }, { authorization: "Bearer fixture-2" }]);
});

test("renewal failure never exports with an expired token or a changed destination", async () => {
  for (const renewal of [{ status: 404 }, { status: 401 },
    { status: 200, body: { ...valid, endpoint: "https://different.test", expiresAtMs: now + 180_000 } }]) {
    let clock = now;
    let calls = 0;
    const config = await resolveDiagnosticRoute({ sandboxName: "owner", now: () => clock,
      requestRoute: async () => ++calls === 1 ? { status: 200, body: valid } : renewal });
    clock += 70_000;
    await assert.rejects(config.headers());
  }
});
