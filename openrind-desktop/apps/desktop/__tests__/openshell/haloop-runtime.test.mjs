import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

import {
  HALOOP_COLLECTOR_CONTAINER_NAME,
  HALOOP_COLLECTOR_IMAGE,
  HALOOP_COLLECTOR_IMAGE_CONTRACT,
  HALOOP_CONTAINER_NAME,
  HALOOP_IMAGE,
  HALOOP_IMAGE_CONTRACT,
  HALOOP_NETWORK_NAME,
  HALOOP_PACKAGED_COLLECTOR_IMAGE,
  HALOOP_PACKAGED_IMAGE,
  HALOOP_IMAGE_VERSION,
  HALOOP_SANDBOX_ENDPOINT,
  __testing,
  buildHaloopAgentLifecycleEvent,
  buildHaloopCaptureIdentity,
  buildHaloopProfilesDocument,
  buildTrustedHaloopAppSpan,
  createHaloopRuntimeManager,
  issueHaloopConversationContext,
  resolveHaloopImageConfig,
} from "../../electron/openshell/haloop-runtime.mjs";

const CAPTURE_CONFIG_HASH = createHash("sha256").update("W8_DESKTOP_CAPTURE_ONLY=1\n").digest("hex");
const CONTEXT_ID = "12".repeat(16);
const OPENSHELL_BRIDGE_IP = "172.30.0.1";
const OPENSHELL_BRIDGE_IPAM = `${JSON.stringify([{ Gateway: OPENSHELL_BRIDGE_IP }])}\n`;

test("authentication probe checks the configured inference edge and rejects an unconfigured deployment", async () => {
  const endpoint = new URL(HALOOP_SANDBOX_ENDPOINT);
  if (endpoint.hostname === "host.openshell.internal") endpoint.hostname = "127.0.0.1";
  endpoint.pathname = "/v1/messages";
  let calls = 0;
  await assert.rejects(__testing.requireAuthenticatedEdge(async (args) => {
    calls++;
    assert.ok(args.at(-1).includes(`fetch(${JSON.stringify(endpoint.href)},`));
    return { exitCode: 1, stdout: "", stderr: "unexpected status 200" };
  }), /Configure Desktop scoped client profiles/);
  assert.equal(calls, 1);
});

test("authentication probe accepts only the expected rejection statuses", async () => {
  let probe;
  await __testing.requireAuthenticatedEdge(async args => {
    probe = args.at(-1);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  for (const status of [200, 204, 302, 400, 401, 403, 404, 429, 500, 503]) {
    const exits = [];
    const requests = [];
    // Execute the generated probe with a fake HTTP peer, not a source-text regex.
    await vm.runInNewContext(probe, {
      fetch: async (...args) => { requests.push(args); return { status }; },
      process: { exit: code => exits.push(code) }, console: { error() {} },
    }, { timeout: 1000 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1].method, "POST");
    assert.equal(JSON.parse(requests[0][1].body).max_tokens, 1);
    assert.deepEqual(exits, [400, 401, 403].includes(status) ? [] : [1], `status ${status}`);
  }
  const exits = [];
  await vm.runInNewContext(probe, {
    fetch: async () => { throw new Error("unreachable"); },
    process: { exit: code => exits.push(code) }, console: { error() {} },
  }, { timeout: 1000 });
  assert.deepEqual(exits, [1]);
});

const scopedProfile = {
  scopeId: "a".repeat(64),
  id: `openrind-${"a".repeat(32)}`,
  providerName: `haloop-${"a".repeat(16)}`,
  clientToken: "orh_v1_scoped-token",
  sandboxName: "sandbox-a",
  workspaceId: "workspace-a",
  agentId: "claude",
};

const survivingProfile = {
  scopeId: "b".repeat(64),
  id: `openrind-${"b".repeat(32)}`,
  providerName: `haloop-${"b".repeat(16)}`,
  clientToken: "orh_v1_surviving-token",
  sandboxName: "sandbox-b",
  workspaceId: "workspace-b",
  agentId: "openclaw",
};

test("profile document hashes the client token and keeps routing server-owned", () => {
  const document = buildHaloopProfilesDocument([scopedProfile], "sk-ant-upstream");
  const profile = document.profiles[0];
  assert.equal(document.version, 1);
  assert.equal(
    profile.client_token_sha256,
    createHash("sha256").update(scopedProfile.clientToken).digest("hex"),
  );
  assert.equal(profile.config.provider, "anthropic");
  assert.equal(profile.config.api_key, "sk-ant-upstream");
  assert.equal(profile.config.strategy, undefined);
  assert.equal(profile.config.targets, undefined);
  assert.equal(profile.project, "sandbox-a");
  assert.deepEqual(profile.config.input_guardrails, [
    {
      "halo.mark": {
        collectorURL: `http://${HALOOP_COLLECTOR_CONTAINER_NAME}:8788`,
      },
      async: false,
      deny: false,
    },
  ]);
  assert.deepEqual(profile.config.output_guardrails, [
    {
      "halo.export": {
        collectorURL: `http://${HALOOP_COLLECTOR_CONTAINER_NAME}:8788`,
        defaultProject: profile.project,
      },
      async: false,
      deny: false,
    },
  ]);
  assert.equal(
    profile.session_hmac_key,
    createHash("sha256")
      .update("openrind-haloop-session-key-v1")
      .update("\0")
      .update(scopedProfile.clientToken)
      .digest("hex"),
  );
  assert.equal(profile.session_id_prefix, "claude");
  assert.equal(profile.trace_id, undefined);
  assert.equal(profile.parent_span_id, undefined);
  assert.equal(profile.session_id, undefined);
  assert.doesNotMatch(JSON.stringify(document), /orh_v1_scoped-token/);
});

test("packaged Haloop images are version-pinned as a matched pair", () => {
  assert.match(HALOOP_PACKAGED_IMAGE, new RegExp(`:${HALOOP_IMAGE_VERSION}$`));
  assert.match(HALOOP_PACKAGED_COLLECTOR_IMAGE, new RegExp(`:${HALOOP_IMAGE_VERSION}$`));
  assert.notEqual(HALOOP_PACKAGED_IMAGE, HALOOP_PACKAGED_COLLECTOR_IMAGE);
  assert.deepEqual(resolveHaloopImageConfig({ sourceCheckout: false, env: {} }), {
    image: HALOOP_PACKAGED_IMAGE,
    collectorImage: HALOOP_PACKAGED_COLLECTOR_IMAGE,
    pullPolicy: "missing",
  });
  assert.deepEqual(resolveHaloopImageConfig({ sourceCheckout: true, env: {} }), {
    image: "haloop-gateway:local",
    collectorImage: "haloop-collector:local",
    pullPolicy: "never",
  });
});

test("private collector control bridge only permits fixed control routes", async () => {
  let calls = 0;
  await assert.rejects(
    __testing.requestPrivateCollector(async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }, { requestPath: "http://attacker.invalid/halo/runs" }),
    /request path is invalid/i,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    __testing.requestPrivateCollector(async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }, { method: "GET", requestPath: "/evals/extract" }),
    /request path is invalid/i,
  );
  assert.equal(calls, 0);

  let invocation = null;
  const response = await __testing.requestPrivateCollector(async (args, options) => {
    invocation = { args, options };
    return {
      exitCode: 0,
      stdout: '{"status":200,"body":{"runs":[]}}',
      stderr: "",
    };
  }, { requestPath: "/halo/runs" });
  assert.deepEqual(response, { status: 200, body: { runs: [] } });
  assert.ok(invocation.args.includes(HALOOP_COLLECTOR_CONTAINER_NAME));
  assert.doesNotMatch(invocation.args.join(" "), /attacker\.invalid/);
  assert.deepEqual(JSON.parse(invocation.options.stdin), {
    method: "GET",
    path: "/halo/runs",
    body: null,
  });
});

test("managed diagnostics use a bounded private control request and retain unsupported status", async () => {
  let invocation;
  const body = { contract: "openrind-runtime-diagnostics/v1", sandboxName: "owner" };
  const response = await __testing.requestPrivateCollector(async (args, options) => {
    invocation = { args, options };
    return { exitCode: 0, stdout: '{"status":404,"body":{}}', stderr: "" };
  }, { method: "POST", requestPath: "/diagnostics/route", body, timeoutMs: 3000 });
  assert.equal(response.status, 404);
  assert.equal(invocation.options.timeout, 3000);
  assert.deepEqual(JSON.parse(invocation.options.stdin), { method: "POST", path: "/diagnostics/route", body });
  assert.ok(invocation.args.includes(HALOOP_COLLECTOR_CONTAINER_NAME));
  assert.match(invocation.args.at(-1), /urlopen\(query,timeout=2\)/);
  assert.match(invocation.args.at(-1), /decoded=\{\} if .*response.status!=200/);
  await assert.rejects(__testing.requestPrivateCollector(() => assert.fail("unexpected request"), {
    method: "GET", requestPath: "/diagnostics/route",
  }), /request path is invalid/);
});

test("trace and report validation payloads stay on stdin", async () => {
  const project = `openrind-${"c".repeat(24)}`;
  const report = `trace_id ${"1".repeat(32)} span_id ${"2".repeat(16)} secret-marker`;
  const invocations = [];
  const run = async (args, options) => {
    invocations.push({ args, options });
    const script = args.at(-1);
    if (script.includes("trace_citations")) {
      return {
        exitCode: 0,
        stdout: '{"valid":true,"trace_citations":1,"span_citations":1,"missing":0}',
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: '{"valid":true,"spans":2,"reason":null}',
      stderr: "",
    };
  };

  assert.deepEqual(await __testing.validateHaloopTraceProject(run, project), {
    valid: true,
    spans: 2,
    reason: null,
  });
  assert.deepEqual(await __testing.validateHaloopReportCitations(run, project, report), {
    valid: true,
    traceCitations: 1,
    spanCitations: 1,
    missing: 0,
  });
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.ok(invocation.args.includes(HALOOP_COLLECTOR_CONTAINER_NAME));
    assert.doesNotMatch(invocation.args.join(" "), new RegExp(project));
    assert.doesNotMatch(invocation.args.join(" "), /secret-marker/);
    assert.equal(JSON.parse(invocation.options.stdin).project, project);
  }
  assert.equal(JSON.parse(invocations[1].options.stdin).report, report);
});

test("signed conversation contexts isolate sessions and preserve resumed trace identity", () => {
  const first = issueHaloopConversationContext(scopedProfile, {
    agentSessionId: "desktop-session-a",
    issuedAtMs: 1_900_000_000_000,
  });
  const resumed = issueHaloopConversationContext(scopedProfile, {
    agentSessionId: "desktop-session-a",
    issuedAtMs: 1_900_000_001_000,
  });
  const second = issueHaloopConversationContext(scopedProfile, {
    agentSessionId: "desktop-session-b",
    issuedAtMs: 1_900_000_000_000,
  });

  assert.equal(first.contextId, resumed.contextId);
  assert.deepEqual(first.capture, resumed.capture);
  assert.notEqual(first.contextId, second.contextId);
  assert.notEqual(first.capture.traceId, second.capture.traceId);
  assert.match(first.assertion, /^v1\.[0-9a-f]{32}\.[0-9]+\.[0-9]+\.[0-9a-f]{64}$/);
  assert.doesNotMatch(first.assertion, /desktop-session|orh_v1_scoped-token/);
});

test("managed lifecycle stages profiles through stdin and requires authenticated health", async () => {
  const calls = [];
  const progress = [];
  const registrations = [];
  let container = null;
  let collector = null;
  let network = false;
  let profileHash = "";
  let currentProfile = scopedProfile;
  let profileRegistry = [scopedProfile, survivingProfile];
  let revocationActive = false;
  const revocationOrder = [];
  let analysisRun = null;
  let traceValidationValid = true;
  let reportCitationsValid = true;
  let analysisStarts = 0;
  let reportPrunes = 0;
  let evalArtifact = null;
  let evalExtractions = 0;
  const evalCopies = [];
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.join(" ");
    if (command.includes("docker image inspect")) {
      if (args.includes(HALOOP_COLLECTOR_IMAGE)) {
        return {
          exitCode: 0,
          stdout: `${HALOOP_COLLECTOR_IMAGE_CONTRACT}|test-version|sha256:collector-a\n`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: `${HALOOP_IMAGE_CONTRACT}|test-version|sha256:image-a\n`,
        stderr: "",
      };
    }
    if (command.includes("bash -lc")) {
      assert.equal(options.user, "root");
      if (options.stdin.startsWith("W8_DESKTOP_CAPTURE_ONLY=")) {
        assert.equal(options.stdin, "W8_DESKTOP_CAPTURE_ONLY=1\n");
      } else {
        assert.match(options.stdin, /halo\.mark/);
        assert.match(options.stdin, /halo\.export/);
        assert.match(options.stdin, new RegExp(`http:\\/\\/${HALOOP_COLLECTOR_CONTAINER_NAME}:8788`));
        assert.doesNotMatch(options.stdin, /orh_v1_scoped-token/);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("docker network inspect")) {
      if (args.includes(__testing.OPENSHELL_SANDBOX_NETWORK_NAME)) {
        return { exitCode: 0, stdout: OPENSHELL_BRIDGE_IPAM, stderr: "" };
      }
      return network
        ? { exitCode: 0, stdout: "true\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command.includes("docker network create")) {
      network = true;
      return { exitCode: 0, stdout: HALOOP_NETWORK_NAME, stderr: "" };
    }
    if (command.includes("docker container inspect")) {
      if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)) {
        if (!collector) return { exitCode: 1, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          stdout: `true|healthy||sha256:collector-a|true|${__testing.COLLECTOR_ANALYSIS_CONTRACT}|${CAPTURE_CONFIG_HASH}\n`,
          stderr: "",
        };
      }
      if (!container) return { exitCode: 1, stdout: "", stderr: "not found" };
      return {
        exitCode: 0,
        stdout: `true|healthy|${profileHash}|sha256:image-a|true\n`,
        stderr: "",
      };
    }
    if (command.includes("docker run")) {
      if (args.includes(HALOOP_COLLECTOR_IMAGE)) {
        assert.equal(options.user, "root");
        collector = true;
        return { exitCode: 0, stdout: "collector-id", stderr: "" };
      }
      assert.equal(options.user, undefined);
      const label = args.find((value) =>
        value.startsWith("com.openrind.desktop.haloop-profile-sha256="),
      );
      profileHash = label.split("=")[1];
      container = true;
      return { exitCode: 0, stdout: "container-id", stderr: "" };
    }
    if (command.includes("docker container rm --force")) {
      if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)) {
        if (revocationActive) revocationOrder.push("collector-removed");
        collector = null;
      }
      if (args.includes(HALOOP_CONTAINER_NAME)) {
        if (revocationActive) revocationOrder.push("gateway-removed");
        container = null;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("docker container stop")) {
      if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)) collector = null;
      if (args.includes(HALOOP_CONTAINER_NAME)) container = null;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME) && args.includes("exec")) {
      assert.equal(options.stdin.includes("sk-ant-upstream"), false);
      const [span] = JSON.parse(options.stdin);
      assert.equal(span.kind, "AGENT");
      assert.match(span.span_id, /^[0-9a-f]{16}$/);
      return {
        exitCode: 0,
        stdout: '{"written":1,"duplicates":0,"errors":[]}',
        stderr: "",
      };
    }
    if (command.includes(`docker exec ${HALOOP_CONTAINER_NAME}`)) {
      assert.match(command, /r\.status!==401|healthz/);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const manager = createHaloopRuntimeManager({
    run,
    ensureDistro: async () => undefined,
    registerProfile: async (input) => {
      registrations.push(input);
      currentProfile = profileRegistry.find(
        (profile) =>
          profile.sandboxName === input.sandboxName &&
          profile.workspaceId === input.workspaceId &&
          profile.agentId === input.agentId,
      );
      assert.ok(currentProfile, "registration must select an existing test profile");
      return { current: currentProfile, profiles: [...profileRegistry] };
    },
    rotateProfile: async (input) => {
      assert.deepEqual(input, {
        sandboxName: "sandbox-a",
        workspaceId: "workspace-a",
        agentId: "claude",
      });
      currentProfile = { ...scopedProfile, clientToken: "orh_v1_rotated-token" };
      profileRegistry = profileRegistry.map((profile) =>
        profile.scopeId === currentProfile.scopeId ? currentProfile : profile,
      );
      return { current: currentProfile, profiles: [...profileRegistry] };
    },
    revokeProfiles: async ({ sandboxName, beforePersist }) => {
      const revoked = profileRegistry.filter(
        (profile) => profile.sandboxName === sandboxName,
      );
      await beforePersist({ revoked });
      profileRegistry = profileRegistry.filter(
        (profile) => profile.sandboxName !== sandboxName,
      );
      if (revoked.length > 0) {
        revocationOrder.push(`credentials-removed:${sandboxName}`);
      }
      return { revoked, profiles: [...profileRegistry], unreadableProfiles: 0 };
    },
    collectorRequest: async (_run, request) => {
      if (request.requestPath.startsWith("/stats?project=")) {
        return {
          status: 200,
          body: {
            spans: 6,
            errors: 1,
            by_observation_kind: { AGENT: 1, LLM: 3, TOOL: 2 },
            by_model: { "claude-sonnet": { count: 3 } },
          },
        };
      }
      if (request.requestPath === "/halo/runs") {
        return { status: 200, body: { runs: analysisRun ? [analysisRun] : [] } };
      }
      if (request.requestPath === "/halo/analyze") {
        analysisStarts += 1;
        assert.equal(request.method, "POST");
        assert.equal(request.body.project, buildHaloopCaptureIdentity(scopedProfile, CONTEXT_ID).project);
        assert.equal(Object.hasOwn(request.body, "api_key"), false);
        assert.equal(Object.hasOwn(request.body, "base_url"), false);
        assert.equal(Object.hasOwn(request.body, "model"), false);
        analysisRun = {
          run_id: "a".repeat(12),
          status: "created",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          project: request.body.project,
          started_at: 1_900_000_000,
          finished_at: null,
          report_available: false,
          error: null,
        };
        return {
          status: 202,
          body: {
            run_id: analysisRun.run_id,
            project: analysisRun.project,
            provider: analysisRun.provider,
            model: analysisRun.model,
          },
        };
      }
      if (request.requestPath.startsWith(`/evals/artifacts/${"a".repeat(12)}/preview?project=`)) {
        return {
          status: 200,
          body: {
            artifact_id: evalArtifact.artifact_id,
            project: evalArtifact.project,
            halo_run_id: evalArtifact.halo_run_id,
            total_cases: 4,
            shown_cases: 1,
            truncated: true,
            contains_sensitive_content: true,
            cases: [{ id: "case-1", request: { messages: [{ role: "user", content: "hello" }] } }],
          },
        };
      }
      if (request.requestPath.startsWith("/evals/artifacts?project=")) {
        return { status: 200, body: { artifacts: evalArtifact ? [evalArtifact] : [] } };
      }
      if (request.requestPath === "/evals/extract") {
        evalExtractions += 1;
        assert.equal(request.method, "POST");
        assert.equal(request.body.project, buildHaloopCaptureIdentity(scopedProfile, CONTEXT_ID).project);
        assert.equal(request.body.run_id, "a".repeat(12));
        assert.deepEqual(Object.keys(request.body).sort(), ["project", "run_id"]);
        evalArtifact = {
          artifact_id: `eval-cases-${"a".repeat(12)}.jsonl`,
          project: request.body.project,
          halo_run_id: request.body.run_id,
          created_at: 1_900_000_200,
          cases: 4,
          by_tag: { "halo-cited": 2, golden: 2 },
          source_providers: ["anthropic"],
          source_models: ["claude-sonnet"],
          source_surfaces: ["anthropic-messages"],
          replay_surface: "chat-completions",
          contains_sensitive_content: true,
        };
        return { status: 201, body: evalArtifact };
      }
      if (request.requestPath === `/halo/runs/${"a".repeat(12)}?report=true`) {
        return {
          status: 200,
          body: {
            ...analysisRun,
            report: `# HALO analysis\n\ntrace_id ${"1".repeat(32)} span_id ${"2".repeat(16)}`,
          },
        };
      }
      throw new Error(`unexpected collector request ${request.requestPath}`);
    },
    validateTraceProject: async () => ({
      valid: traceValidationValid,
      spans: traceValidationValid ? 6 : 0,
      reason: traceValidationValid ? null : "invalid",
    }),
    validateReportCitations: async (_run, _project, report) => {
      assert.match(report, /trace_id/);
      return {
        valid: reportCitationsValid,
        traceCitations: 1,
        spanCitations: 1,
        missing: reportCitationsValid ? 0 : 1,
      };
    },
    pruneReports: async () => {
      reportPrunes += 1;
    },
    copyEvalArtifact: async (_run, input) => {
      evalCopies.push(input);
    },
  });

  const result = await manager.ensure({
    anthropicApiKey: "sk-ant-upstream",
    sandboxName: "sandbox-a",
    workspaceId: "workspace-a",
    agentId: "claude",
    issueConversation: true,
    haloopContextId: CONTEXT_ID,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.providerName, scopedProfile.providerName);
  assert.equal(result.clientToken, scopedProfile.clientToken);
  assert.equal(result.version, "test-version");
  assert.equal(result.routePolicy, "incumbent-only");
  assert.deepEqual(result.capture, buildHaloopCaptureIdentity(scopedProfile, CONTEXT_ID));
  assert.equal(result.haloopContextId, CONTEXT_ID);
  assert.match(
    result.sessionAssertion,
    new RegExp(`^v1\\.${CONTEXT_ID}\\.[0-9]+\\.[0-9]+\\.[0-9a-f]{64}$`),
  );
  assert.ok(calls.some(({ args }) => args.includes(HALOOP_IMAGE)));
  assert.ok(calls.some(({ args }) => args.includes(HALOOP_COLLECTOR_IMAGE)));
  const commandText = calls.map(({ args }) => args.join(" ")).join("\n");
  assert.doesNotMatch(commandText, /sk-ant-upstream|orh_v1_scoped-token/);
  assert.match(commandText, new RegExp(`${OPENSHELL_BRIDGE_IP}:8787:8787`));
  assert.doesNotMatch(commandText, /--publish 8787:8787/);
  assert.doesNotMatch(commandText, /8788:8788/);
  assert.match(commandText, new RegExp(`--network ${HALOOP_NETWORK_NAME}`));
  assert.match(commandText, /W8_KEEP_RAW=0/);
  assert.match(commandText, /collector-data/);
  assert.match(commandText, /analysis\.env/);
  assert.match(commandText, /W8_REPORTS_DIR/);
  assert.match(commandText, /haloop-analysis-contract/);
  assert.match(commandText, /W8_OPENRIND_PROFILES_FILE/);
  assert.deepEqual(progress.at(-1), {
    phase: "haloop",
    message: "Haloop test-version routing and private trace capture are healthy.",
  });

  const status = await manager.status();
  assert.equal(status.required, true);
  assert.equal(status.routePolicy, "incumbent-only");
  assert.equal(status.state, "ready");
  assert.equal(status.endpoint, "http://136.112.93.84:8787");
  assert.equal(status.version, "test-version");
  assert.equal(status.health, "healthy");
  assert.equal(status.collectorHealth, "healthy");
  assert.deepEqual(status.spanCapture, {
    written: 1,
    duplicates: 0,
    dropped: 0,
    redacted: 0,
    incomplete: 0,
    lastError: null,
    lastAttemptAt: status.spanCapture.lastAttemptAt,
  });
  assert.equal(typeof status.spanCapture.lastAttemptAt, "number");
  assert.deepEqual(status.activeRoute, {
    profileId: scopedProfile.id,
    providerName: scopedProfile.providerName,
    sandboxName: "sandbox-a",
    agentId: "claude",
  });
  assert.equal(status.lastConnectionError, null);
  assert.doesNotMatch(JSON.stringify(status), /sk-ant-upstream|orh_v1_scoped-token/);

  const analysisReady = await manager.analysisStatus();
  assert.equal(analysisReady.state, "ready");
  assert.equal(analysisReady.stats.spans, 6);
  assert.equal(analysisReady.stats.byObservationKind.LLM, 3);
  assert.equal(analysisReady.run, null);

  const analysisQueued = await manager.startAnalysis();
  assert.equal(analysisQueued.state, "queued");
  assert.equal(analysisStarts, 1);
  assert.equal(reportPrunes, 1);
  analysisRun = {
    ...analysisRun,
    status: "done",
    finished_at: 1_900_000_100,
    report_available: true,
  };
  const analysisDone = await manager.analysisStatus();
  assert.equal(analysisDone.state, "done");
  assert.deepEqual(analysisDone.run.citations, {
    valid: true,
    traceCitations: 1,
    spanCitations: 1,
    missing: 0,
  });
  reportCitationsValid = false;
  await assert.rejects(
    manager.loadAnalysisReport("a".repeat(12)),
    /cited trace evidence outside the active project/i,
  );
  reportCitationsValid = true;
  const report = await manager.loadAnalysisReport("a".repeat(12));
  assert.match(report.report, /HALO analysis/);
  const generatedEval = await manager.generateEvalCases("a".repeat(12));
  assert.equal(generatedEval.cases, 4);
  assert.equal(generatedEval.replaySurface, "chat-completions");
  assert.deepEqual(generatedEval.sourceProviders, ["anthropic"]);
  assert.equal(evalExtractions, 1);
  const evalPreview = await manager.loadEvalCases("a".repeat(12));
  assert.equal(evalPreview.totalCases, 4);
  assert.equal(evalPreview.shownCases, 1);
  assert.equal(evalPreview.truncated, true);
  assert.equal(evalPreview.cases[0].id, "case-1");
  await manager.exportEvalCases("a".repeat(12), "/mnt/c/Users/ANKUR/Downloads/evals.jsonl");
  assert.deepEqual(evalCopies, [
    {
      artifactId: `eval-cases-${"a".repeat(12)}.jsonl`,
      destinationPath: "/mnt/c/Users/ANKUR/Downloads/evals.jsonl",
    },
  ]);
  const analysisWithEval = await manager.analysisStatus();
  assert.deepEqual(analysisWithEval.evalArtifact, generatedEval);
  traceValidationValid = false;
  await assert.rejects(manager.startAnalysis(), /failed contract validation/i);
  assert.equal(analysisStarts, 1);

  collector = null;
  const degradedStatus = await manager.status();
  assert.equal(degradedStatus.state, "degraded");
  assert.deepEqual(degradedStatus.activeRoute, status.activeRoute);
  const degradedRollbackStart = calls.length;
  await assert.rejects(
    manager.restoreIncumbent({
      anthropicApiKey: "sk-ant-upstream",
      expectedProfileId: scopedProfile.id,
      expectedSandboxName: "sandbox-a",
    }),
    /collector must be healthy.*restart Haloop/i,
  );
  assert.doesNotMatch(
    calls
      .slice(degradedRollbackStart)
      .map(({ args }) => args.join(" "))
      .join("\n"),
    /docker container rm --force/,
  );
  collector = true;

  const restartStart = calls.length;
  const restarted = await manager.restart({ anthropicApiKey: "sk-ant-upstream" });
  assert.equal(restarted.providerName, scopedProfile.providerName);
  assert.deepEqual(registrations.at(-1), {
    deferCommit: true,
    sandboxName: "sandbox-a",
    workspaceId: "workspace-a",
    agentId: "claude",
  });
  const restartCommands = calls
    .slice(restartStart)
    .map(({ args }) => args.join(" "))
    .join("\n");
  assert.match(
    restartCommands,
    new RegExp(`docker container stop --time 45 ${HALOOP_CONTAINER_NAME}`),
  );
  assert.match(
    restartCommands,
    new RegExp(`docker container stop --time 45 ${HALOOP_COLLECTOR_CONTAINER_NAME}`),
  );
  assert.equal((restartCommands.match(/docker run/g) ?? []).length, 2);
  const restartedStatus = await manager.status();
  assert.equal(restartedStatus.state, "ready");
  assert.deepEqual(restartedStatus.activeRoute, status.activeRoute);

  await assert.rejects(
    manager.restoreIncumbent({ anthropicApiKey: "sk-ant-upstream" }),
    /exact active Haloop route identity is required/i,
  );
  await assert.rejects(
    manager.restoreIncumbent({
      anthropicApiKey: "sk-ant-upstream",
      expectedProfileId: "stale-profile",
      expectedSandboxName: "sandbox-a",
    }),
    /active Haloop route changed.*refresh/i,
  );

  const rollbackStart = calls.length;
  let rollbackRoute = null;
  const rollback = await manager.restoreIncumbent({
    anthropicApiKey: "sk-ant-upstream",
    expectedProfileId: scopedProfile.id,
    expectedSandboxName: "sandbox-a",
    beforeRollback: async (route) => {
      rollbackRoute = route;
    },
  });
  assert.deepEqual(rollbackRoute, {
    profileId: scopedProfile.id,
    providerName: scopedProfile.providerName,
    sandboxName: "sandbox-a",
    workspaceId: "workspace-a",
    agentId: "claude",
  });
  assert.equal(rollback.routePolicy, "incumbent-only");
  assert.equal(rollback.sessionsPreserved, true);
  assert.equal(rollback.clientToken, scopedProfile.clientToken);
  const rollbackCommands = calls
    .slice(rollbackStart)
    .map(({ args }) => args.join(" "))
    .join("\n");
  assert.match(
    rollbackCommands,
    new RegExp(`docker container rm --force ${HALOOP_CONTAINER_NAME}`),
  );
  assert.doesNotMatch(
    rollbackCommands,
    new RegExp(`(?:rm --force|stop --time 45) ${HALOOP_COLLECTOR_CONTAINER_NAME}`),
  );
  assert.equal((rollbackCommands.match(/docker run/g) ?? []).length, 1);
  assert.doesNotMatch(rollbackCommands, /sk-ant-upstream|orh_v1_scoped-token/);
  assert.deepEqual(manager.activeRoute(), {
    profileId: scopedProfile.id,
    providerName: scopedProfile.providerName,
    sandboxName: "sandbox-a",
    workspaceId: "workspace-a",
    agentId: "claude",
  });

  await assert.rejects(
    manager.rotate({ anthropicApiKey: "sk-ant-upstream" }),
    /exact active Haloop route identity is required/i,
  );
  await assert.rejects(
    manager.rotate({
      anthropicApiKey: "sk-ant-upstream",
      expectedProfileId: "stale-profile",
      expectedSandboxName: "sandbox-a",
    }),
    /active Haloop route changed.*refresh/i,
  );

  const rotationOrder = [];
  const rotated = await manager.rotate({
    anthropicApiKey: "sk-ant-upstream",
    expectedProfileId: scopedProfile.id,
    expectedSandboxName: "sandbox-a",
    beforeRotate: async (route) => {
      rotationOrder.push("sessions-ended");
      assert.deepEqual(route, {
        profileId: scopedProfile.id,
        providerName: scopedProfile.providerName,
        sandboxName: "sandbox-a",
        workspaceId: "workspace-a",
        agentId: "claude",
      });
      return 2;
    },
  });
  assert.equal(rotated.clientToken, "orh_v1_rotated-token");
  assert.equal(rotated.affectedSessions, 2);
  assert.equal(rotated.relaunchRequired, true);
  assert.deepEqual(rotationOrder, ["sessions-ended"]);
  assert.deepEqual(manager.activeRoute(), {
    profileId: scopedProfile.id,
    providerName: scopedProfile.providerName,
    sandboxName: "sandbox-a",
    workspaceId: "workspace-a",
    agentId: "claude",
  });

  revocationActive = true;
  const revokedFirst = await manager.revokeSandbox({
    sandboxName: "sandbox-a",
    anthropicApiKey: "sk-ant-upstream",
    beforeRevoke: async () => {
      revocationOrder.push("sessions-ended:sandbox-a");
      return 2;
    },
    beforeCredentialsRemoved: async ({ providerNames }) => {
      assert.deepEqual(providerNames, [scopedProfile.providerName]);
      revocationOrder.push(`provider-removed:${providerNames[0]}`);
    },
  });
  revocationActive = false;
  assert.deepEqual(revokedFirst, {
    revokedProfiles: 1,
    remainingProfiles: 1,
    affectedSessions: 2,
    routeReady: true,
  });
  assert.deepEqual(revocationOrder, [
    "sessions-ended:sandbox-a",
    "gateway-removed",
    `provider-removed:${scopedProfile.providerName}`,
    "credentials-removed:sandbox-a",
  ]);
  assert.deepEqual(manager.activeRoute(), {
    profileId: survivingProfile.id,
    providerName: survivingProfile.providerName,
    sandboxName: "sandbox-b",
    workspaceId: "workspace-b",
    agentId: "openclaw",
  });

  revocationOrder.length = 0;
  revocationActive = true;
  const revokedLast = await manager.revokeSandbox({
    sandboxName: "sandbox-b",
    anthropicApiKey: "sk-ant-upstream",
    beforeRevoke: async () => {
      revocationOrder.push("sessions-ended:sandbox-b");
      return 1;
    },
    beforeCredentialsRemoved: async ({ providerNames }) => {
      assert.deepEqual(providerNames, [survivingProfile.providerName]);
      revocationOrder.push(`provider-removed:${providerNames[0]}`);
    },
  });
  revocationActive = false;
  assert.deepEqual(revokedLast, {
    revokedProfiles: 1,
    remainingProfiles: 0,
    affectedSessions: 1,
    routeReady: false,
  });
  assert.deepEqual(revocationOrder, [
    "sessions-ended:sandbox-b",
    "gateway-removed",
    `provider-removed:${survivingProfile.providerName}`,
    "credentials-removed:sandbox-b",
    "collector-removed",
  ]);
  assert.equal(manager.activeRoute(), null);
  const stoppedStatus = await manager.status();
  assert.equal(stoppedStatus.state, "stopped");
  assert.equal(stoppedStatus.activeRoute, null);

  revocationOrder.length = 0;
  const repeatStart = calls.length;
  const repeatedRevocation = await manager.revokeSandbox({ sandboxName: "sandbox-b" });
  assert.deepEqual(repeatedRevocation, {
    revokedProfiles: 0,
    remainingProfiles: 0,
    affectedSessions: 0,
    routeReady: false,
  });
  assert.deepEqual(revocationOrder, []);
  assert.doesNotMatch(
    calls.slice(repeatStart).map(({ args }) => args.join(" ")).join("\n"),
    /docker container rm --force/,
  );

  await manager.stop();
  const shutdownCommands = calls.map(({ args }) => args.join(" ")).join("\n");
  assert.match(shutdownCommands, new RegExp(`docker container stop --time 45 ${HALOOP_CONTAINER_NAME}`));
  assert.match(shutdownCommands, new RegExp(`docker container stop --time 45 ${HALOOP_COLLECTOR_CONTAINER_NAME}`));
  assert.match(shutdownCommands, /rm -f .*openrind-profiles\.json/);
  const registryCleanup = calls.find(({ args }) =>
    args.join(" ").includes("rm -f /var/lib/openrind-desktop/haloop/openrind-profiles.json"),
  );
  assert.equal(registryCleanup.options.user, "root");
});

test("trusted Desktop spans use the route trace, redact secrets, and reject LLM duplication", () => {
  const capture = buildHaloopCaptureIdentity(scopedProfile, CONTEXT_ID);
  const span = buildTrustedHaloopAppSpan(capture, {
    kind: "TOOL",
    eventId: "tool-call-1",
    name: "read_file",
    startMs: 1_000,
    endMs: 1_250,
    input: { path: "README.md", api_key: "must-not-persist" },
    attributes: {
      "openrind.lifecycle": "completed",
      "inference.project_id": "attacker-project",
    },
  });

  assert.equal(span.trace_id, capture.traceId);
  assert.equal(span.parent_span_id, capture.rootSpanId);
  assert.match(span.span_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(span.input, { path: "README.md", api_key: "[REDACTED]" });
  assert.deepEqual(span.attributes, { "openrind.lifecycle": "completed" });
  assert.throws(
    () =>
      buildTrustedHaloopAppSpan(capture, {
        kind: "LLM",
        eventId: "duplicate-llm",
        startMs: 1,
        endMs: 2,
      }),
    /AGENT, TOOL, and CHAIN spans only/,
  );
});

test("agent lifecycle distinguishes completion, crash, cancellation, deletion, and shutdown", () => {
  const base = {
    id: "pty-1",
    openedAt: 1_000,
    endedAt: 2_000,
    signal: null,
    closeRequestedAt: null,
  };
  const completed = buildHaloopAgentLifecycleEvent("claude", {
    ...base,
    exitCode: 0,
    terminationCause: "completed",
  });
  const crashed = buildHaloopAgentLifecycleEvent("openclaw", {
    ...base,
    exitCode: 9,
    signal: "SIGKILL",
    terminationCause: "process-exit",
  });
  const cancelled = buildHaloopAgentLifecycleEvent("claude", {
    ...base,
    exitCode: null,
    signal: "SIGTERM",
    terminationCause: "desktop-close",
    closeRequestedAt: 1_900,
  });
  const sandboxDeleted = buildHaloopAgentLifecycleEvent("claude", {
    ...base,
    exitCode: null,
    signal: "SIGTERM",
    terminationCause: "sandbox-delete",
    closeRequestedAt: 1_900,
  });
  const shutdown = buildHaloopAgentLifecycleEvent("openclaw", {
    ...base,
    exitCode: null,
    signal: "SIGTERM",
    terminationCause: "app-shutdown",
    closeRequestedAt: 1_900,
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.attributes["openrind.lifecycle"], "completed");
  assert.equal(crashed.ok, false);
  assert.equal(crashed.name, "openclaw.session");
  assert.equal(crashed.attributes["openrind.lifecycle"], "crashed");
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.statusMessage, "Agent session was cancelled by Desktop.");
  assert.equal(cancelled.attributes["openrind.lifecycle"], "cancelled");
  assert.equal(cancelled.attributes["openrind.close.requested_at_ms"], 1_900);
  assert.equal(sandboxDeleted.ok, false);
  assert.equal(sandboxDeleted.attributes["openrind.lifecycle"], "sandbox-deleted");
  assert.equal(shutdown.ok, false);
  assert.equal(shutdown.attributes["openrind.lifecycle"], "app-shutdown");
  assert.throws(
    () => buildHaloopAgentLifecycleEvent("openrind-shell-claude", { ...base, exitCode: 0 }),
    /OPENRIND_SHELL_AGENT must be claude, openclaw, or openhands/,
  );
});

test("post-route Desktop capture is fail-open and reports dropped spans", async () => {
  const manager = createHaloopRuntimeManager({
    postSpans: async () => {
      throw new Error("collector restarted");
    },
  });
  const capture = buildHaloopCaptureIdentity(scopedProfile, CONTEXT_ID);
  const result = await manager.recordApplicationSpans(capture, [
    {
      kind: "AGENT",
      eventId: "pty-1",
      name: "claude.session",
      startMs: 1_000,
      endMs: 2_000,
    },
  ]);

  assert.deepEqual(result, {
    ok: false,
    written: 0,
    duplicates: 0,
    error: "collector restarted",
  });
});

test("reactivating an existing live route performs no runtime or credential work", async () => {
  let runtimeCalls = 0;
  let registrations = 0;
  const manager = createHaloopRuntimeManager({
    run: async () => {
      runtimeCalls += 1;
      throw new Error("route reactivation must not invoke WSL or Docker");
    },
    registerProfile: async () => {
      registrations += 1;
      throw new Error("route reactivation must not touch credentials");
    },
  });

  const route = await manager.activateExistingRoute({
    sandboxName: "sandbox-a",
    workspaceId: "workspace-a",
    agentId: "claude",
  });

  assert.equal(route.sandboxName, "sandbox-a");
  assert.equal(route.workspaceId, "workspace-a");
  assert.equal(route.agentId, "claude");
  assert.match(route.profileId, /^openrind-[0-9a-f]{32}$/);
  assert.match(route.providerName, /^haloop-[0-9a-f]{16}$/);
  assert.equal(runtimeCalls, 0);
  assert.equal(registrations, 0);
});

test("capture status reads counts only and trace export rejects arbitrary paths", async () => {
  const requests = [];
  const manager = createHaloopRuntimeManager({
    run: async () => ({ exitCode: 0, stdout: "true|healthy||sha256:collector|true\n", stderr: "" }),
    collectorRequest: async (_run, request) => {
      requests.push(request.requestPath);
      return { status: 200, body: { spans: 12, errors: 1, by_observation_kind: { LLM: 8 }, by_model: { test: 8 } } };
    },
  });
  await manager.activateExistingRoute({ sandboxName: "sandbox-a", workspaceId: "workspace-a", agentId: "claude" });
  const snapshot = await manager.traceCaptureStatus();
  assert.equal(snapshot.stats.spans, 12);
  assert.equal(snapshot.stats.byObservationKind.LLM, 8);
  assert.equal(snapshot.run, null);
  assert.equal(snapshot.evalArtifact, null);
  assert.deepEqual(requests, [`/stats?project=${snapshot.project}`]);
  await assert.rejects(manager.exportTraces(snapshot.project, "/mnt/c/../private"), /destination is invalid/);
  await assert.rejects(manager.exportTraces("../other", "/mnt/c/exports/traces.jsonl"), /project changed/);
});

test("analysis status recovers the latest durable project without an in-memory route", async () => {
  const project = `openrind-${"c".repeat(24)}`;
  const manager = createHaloopRuntimeManager({
    run: async (args) => {
      const command = args.join(" ");
      if (
        command.includes("docker container inspect") &&
        command.includes(HALOOP_COLLECTOR_CONTAINER_NAME)
      ) {
        return {
          exitCode: 0,
          stdout: "true|healthy||sha256:collector|true|openrind-halo-analysis-v2|config-hash\n",
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "not found" };
    },
    collectorRequest: async (_run, request) => {
      if (request.requestPath === "/halo/runs") {
        return {
          status: 200,
          body: {
            runs: [{
              project,
              run_id: "d".repeat(12),
              status: "running",
              provider: "anthropic",
              model: "analysis-model",
              started_at: 2_000,
            }],
          },
        };
      }
      if (request.requestPath === `/stats?project=${project}`) {
        return {
          status: 200,
          body: { spans: 9, errors: 0, by_observation_kind: { LLM: 4 }, by_model: {} },
        };
      }
      throw new Error(`Unexpected collector request: ${request.requestPath}`);
    },
  });

  const recovered = await manager.analysisStatus();
  assert.equal(recovered.project, project);
  assert.equal(recovered.state, "running");
  assert.equal(recovered.stats.spans, 9);
  assert.equal(recovered.run.runId, "d".repeat(12));
});

test("completed durable analysis is not selected as a new automatic run", async () => {
  const project = `openrind-${"e".repeat(24)}`;
  const completed = {
    project,
    run_id: "f".repeat(12),
    status: "done",
    provider: "anthropic",
    model: "analysis-model",
    started_at: 2_000,
    finished_at: 3_000,
    report_available: true,
  };
  const manager = createHaloopRuntimeManager({
    run: async (args) => {
      const command = args.join(" ");
      if (
        command.includes("docker container inspect") &&
        command.includes(HALOOP_COLLECTOR_CONTAINER_NAME)
      ) {
        return {
          exitCode: 0,
          stdout: "true|healthy||sha256:collector|true|openrind-halo-analysis-v2|config-hash\n",
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "not found" };
    },
    collectorRequest: async (_run, request) => {
      if (request.requestPath === "/halo/runs") {
        return { status: 200, body: { runs: [completed] } };
      }
      if (request.requestPath === `/stats?project=${project}`) {
        return {
          status: 200,
          body: { spans: 9, errors: 0, by_observation_kind: { LLM: 4 }, by_model: {} },
        };
      }
      throw new Error(`Unexpected collector request: ${request.requestPath}`);
    },
  });

  const status = await manager.analysisStatus();
  assert.equal(status.project, project);
  assert.equal(status.state, "ready");
  assert.equal(status.stats.spans, 9);
  assert.equal(status.run, null);
});

test("shutdown is a no-op when this Desktop process never started Haloop", async () => {
  let calls = 0;
  const manager = createHaloopRuntimeManager({
    run: async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await manager.stop();
  assert.equal(calls, 0);
  assert.equal((await manager.analysisStatus()).state, "unavailable");
  await assert.rejects(manager.startAnalysis(), /no active trace project/i);
  await assert.rejects(
    manager.restart({ anthropicApiKey: "sk-ant-upstream" }),
    /no active Desktop route to restart/,
  );
  await assert.rejects(
    manager.restoreIncumbent({
      anthropicApiKey: "sk-ant-upstream",
      expectedProfileId: scopedProfile.id,
      expectedSandboxName: scopedProfile.sandboxName,
    }),
    /no active Desktop route to restore/,
  );
  await assert.rejects(
    manager.rotate({ anthropicApiKey: "sk-ant-upstream" }),
    /no active Desktop route to rotate/,
  );
});

test("managed lifecycle rejects an image without a safe diagnostic version", async () => {
  const manager = createHaloopRuntimeManager({
    run: async (args) => {
      if (args.join(" ").includes("docker image inspect")) {
        return {
          exitCode: 0,
          stdout: `${HALOOP_IMAGE_CONTRACT}||sha256:image-a\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    ensureDistro: async () => undefined,
  });

  await assert.rejects(
    manager.ensure({
      anthropicApiKey: "sk-ant-upstream",
      sandboxName: "sandbox-a",
      workspaceId: "workspace-a",
      agentId: "claude",
    }),
    /invalid diagnostic version label/i,
  );
});

test("managed lifecycle does not stop or replace a foreign reserved-name container", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command.includes("docker image inspect")) {
      if (args.includes(HALOOP_COLLECTOR_IMAGE)) {
        return {
          exitCode: 0,
          stdout: `${HALOOP_COLLECTOR_IMAGE_CONTRACT}|test-version|sha256:collector-a\n`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: `${HALOOP_IMAGE_CONTRACT}|test-version|sha256:image-a\n`,
        stderr: "",
      };
    }
    if (command.includes("docker network inspect")) {
      if (args.includes(__testing.OPENSHELL_SANDBOX_NETWORK_NAME)) {
        return { exitCode: 0, stdout: OPENSHELL_BRIDGE_IPAM, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command.includes("docker container inspect")) {
      if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)) {
        return { exitCode: 1, stdout: "", stderr: "not found" };
      }
      return {
        exitCode: 0,
        stdout: `true|healthy|foreign-profile|sha256:image-a|false\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const manager = createHaloopRuntimeManager({
    run,
    ensureDistro: async () => undefined,
    registerProfile: async () => ({ current: scopedProfile, profiles: [scopedProfile] }),
  });

  await assert.rejects(
    manager.ensure({
      anthropicApiKey: "sk-ant-upstream",
      sandboxName: "sandbox-a",
      workspaceId: "workspace-a",
      agentId: "claude",
    }),
    /already exists but is not managed by Openrind Desktop/i,
  );

  const commandText = calls.map((args) => args.join(" ")).join("\n");
  assert.doesNotMatch(commandText, /docker container (?:rm|stop)/);
});

test("container inspection recognizes a managed container that never reached health startup", async () => {
  let format = "";
  const info = await __testing.inspectContainer(async (args) => {
    format = args.at(-1);
    return {
      exitCode: 0,
      stdout: "false|none|profile-a|sha256:image-a|true\n",
      stderr: "",
    };
  }, HALOOP_CONTAINER_NAME);

  assert.match(format, /\{\{if \.State\.Health\}\}/);
  assert.deepEqual(info, {
    running: false,
    health: "none",
    profileHash: "profile-a",
    imageId: "sha256:image-a",
    managed: true,
    analysisContract: null,
    analysisConfigHash: null,
  });
});

test("managed lifecycle reports a fixed-port conflict without choosing another endpoint", async () => {
  let collectorRunning = false;
  const run = async (args) => {
    const command = args.join(" ");
    if (command.includes("docker image inspect")) {
      if (args.includes(HALOOP_COLLECTOR_IMAGE)) {
        return {
          exitCode: 0,
          stdout: `${HALOOP_COLLECTOR_IMAGE_CONTRACT}|test-version|sha256:collector-a\n`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: `${HALOOP_IMAGE_CONTRACT}|test-version|sha256:image-a\n`,
        stderr: "",
      };
    }
    if (command.includes("docker network inspect")) {
      if (args.includes(__testing.OPENSHELL_SANDBOX_NETWORK_NAME)) {
        return { exitCode: 0, stdout: OPENSHELL_BRIDGE_IPAM, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command.includes("docker container inspect")) {
      if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME) && collectorRunning) {
        return {
          exitCode: 0,
          stdout: `true|healthy||sha256:collector-a|true|${__testing.COLLECTOR_ANALYSIS_CONTRACT}|${CAPTURE_CONFIG_HASH}\n`,
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command.includes("docker run")) {
      if (args.includes(HALOOP_COLLECTOR_IMAGE)) {
        collectorRunning = true;
        return { exitCode: 0, stdout: "collector-id", stderr: "" };
      }
      return { exitCode: 125, stdout: "", stderr: "Bind for 0.0.0.0:8787 failed: port is already allocated" };
    }
    if (
      command.includes("docker container stop") &&
      args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)
    ) {
      collectorRunning = false;
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const manager = createHaloopRuntimeManager({
    run,
    ensureDistro: async () => undefined,
    registerProfile: async () => ({ current: scopedProfile, profiles: [scopedProfile] }),
  });

  await assert.rejects(
    manager.ensure({
      anthropicApiKey: "sk-ant-upstream",
      sandboxName: "sandbox-a",
      workspaceId: "workspace-a",
      agentId: "claude",
    }),
    /port 8787 is already in use.*will not select a different endpoint/i,
  );

  const status = await manager.status();
  assert.equal(status.state, "stopped");
  assert.match(status.lastConnectionError, /port 8787 is already in use/i);
  assert.equal(status.activeRoute, null);
});

test("managed lifecycle blocks launch when the gateway cannot reach the collector", async () => {
  const calls = [];
  let collectorRunning = false;
  let gatewayRunning = false;
  let profileHash = "";
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.join(" ");
    if (command.includes("docker image inspect")) {
      return args.includes(HALOOP_COLLECTOR_IMAGE)
        ? {
            exitCode: 0,
            stdout: `${HALOOP_COLLECTOR_IMAGE_CONTRACT}|test-version|sha256:collector-a\n`,
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: `${HALOOP_IMAGE_CONTRACT}|test-version|sha256:image-a\n`,
            stderr: "",
          };
    }
    if (command.includes("bash -lc")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("docker network inspect")) {
      if (args.includes(__testing.OPENSHELL_SANDBOX_NETWORK_NAME)) {
        return { exitCode: 0, stdout: OPENSHELL_BRIDGE_IPAM, stderr: "" };
      }
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    if (command.includes("docker container inspect")) {
      if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)) {
        return collectorRunning
          ? {
              exitCode: 0,
              stdout: `true|healthy||sha256:collector-a|true|${__testing.COLLECTOR_ANALYSIS_CONTRACT}|${CAPTURE_CONFIG_HASH}\n`,
              stderr: "",
            }
          : { exitCode: 1, stdout: "", stderr: "not found" };
      }
      return gatewayRunning
        ? {
            exitCode: 0,
            stdout: `true|healthy|${profileHash}|sha256:image-a|true\n`,
            stderr: "",
          }
        : { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command.includes("docker run")) {
      if (args.includes(HALOOP_COLLECTOR_IMAGE)) {
        collectorRunning = true;
      } else {
        profileHash = args
          .find((value) => value.startsWith("com.openrind.desktop.haloop-profile-sha256="))
          .split("=")[1];
        gatewayRunning = true;
      }
      return { exitCode: 0, stdout: "container-id", stderr: "" };
    }
    if (
      command.includes(`docker exec ${HALOOP_CONTAINER_NAME}`) &&
      command.includes(HALOOP_COLLECTOR_CONTAINER_NAME)
    ) {
      return { exitCode: 1, stdout: "", stderr: "collector unreachable" };
    }
    if (command.includes("docker container stop")) {
      if (args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)) collectorRunning = false;
      if (args.includes(HALOOP_CONTAINER_NAME)) gatewayRunning = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const manager = createHaloopRuntimeManager({
    run,
    ensureDistro: async () => undefined,
    registerProfile: async () => ({ current: scopedProfile, profiles: [scopedProfile] }),
  });

  await assert.rejects(
    manager.ensure({
      anthropicApiKey: "sk-ant-upstream",
      sandboxName: "sandbox-a",
      workspaceId: "workspace-a",
      agentId: "claude",
    }),
    /cannot reach its private collector.*creation is blocked/i,
  );

  const commandText = calls.map(({ args }) => args.join(" ")).join("\n");
  assert.match(commandText, new RegExp(`container stop --time 45 ${HALOOP_CONTAINER_NAME}`));
  assert.match(
    commandText,
    new RegExp(`container stop --time 45 ${HALOOP_COLLECTOR_CONTAINER_NAME}`),
  );
  assert.doesNotMatch(commandText, /sk-ant-upstream|orh_v1_scoped-token/);

  const status = await manager.status();
  assert.equal(status.state, "stopped");
  assert.match(status.lastConnectionError, /cannot reach its private collector/i);
  assert.equal(status.collectorHealth, null);
});

test("a failed new launch does not interrupt an already-running Haloop route", async () => {
  const calls = [];
  const serialized = `${JSON.stringify(
    buildHaloopProfilesDocument([scopedProfile], "sk-ant-upstream"),
    null,
    2,
  )}\n`;
  const profileHash = createHash("sha256").update(serialized).digest("hex");
  const run = async (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command.includes("docker image inspect")) {
      return args.includes(HALOOP_COLLECTOR_IMAGE)
        ? {
            exitCode: 0,
            stdout: `${HALOOP_COLLECTOR_IMAGE_CONTRACT}|test-version|sha256:collector-a\n`,
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: `${HALOOP_IMAGE_CONTRACT}|test-version|sha256:image-a\n`,
            stderr: "",
          };
    }
    if (command.includes("docker network inspect")) {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    if (command.includes("docker container inspect")) {
      return args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)
        ? {
            exitCode: 0,
            stdout: `true|healthy||sha256:collector-a|true|${__testing.COLLECTOR_ANALYSIS_CONTRACT}|${CAPTURE_CONFIG_HASH}\n`,
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: `true|healthy|${profileHash}|sha256:image-a|true\n`,
            stderr: "",
          };
    }
    if (
      command.includes(`docker exec ${HALOOP_CONTAINER_NAME}`) &&
      command.includes(HALOOP_COLLECTOR_CONTAINER_NAME)
    ) {
      return { exitCode: 1, stdout: "", stderr: "collector unreachable" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const manager = createHaloopRuntimeManager({
    run,
    ensureDistro: async () => undefined,
    registerProfile: async () => ({ current: scopedProfile, profiles: [scopedProfile] }),
  });

  await assert.rejects(
    manager.ensure({
      anthropicApiKey: "sk-ant-upstream",
      sandboxName: "sandbox-a",
      workspaceId: "workspace-a",
      agentId: "claude",
    }),
    /cannot reach its private collector/i,
  );

  const commandText = calls.map((args) => args.join(" ")).join("\n");
  assert.doesNotMatch(commandText, /docker container stop/);
  assert.doesNotMatch(commandText, /docker container rm/);
});

test("integration revocation withdraws all Haloop identities and managed runtime state in order", async () => {
  const calls = [];
  const order = [];
  let gateway = true;
  let collector = true;
  let network = true;
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.join(" ");
    if (command.includes("docker network inspect")) {
      return network
        ? { exitCode: 0, stdout: "true\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command.includes("docker container inspect")) {
      const exists = args.includes(HALOOP_COLLECTOR_CONTAINER_NAME) ? collector : gateway;
      return exists
        ? { exitCode: 0, stdout: "true|healthy|hash|sha256:image|true\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command.includes("docker container rm") && args.includes(HALOOP_CONTAINER_NAME)) {
      gateway = false;
      order.push("gateway-removed");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("docker container rm") && args.includes(HALOOP_COLLECTOR_CONTAINER_NAME)) {
      collector = false;
      order.push("collector-removed");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[3] === "rm" && args.includes("-f")) {
      order.push("registry-removed");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("docker network rm")) {
      network = false;
      order.push("network-removed");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const manager = createHaloopRuntimeManager({
    run,
    ensureDistro: async () => undefined,
    revokeAllProfiles: async ({ beforePersist }) => {
      await beforePersist({ revoked: [scopedProfile, survivingProfile] });
      order.push("credentials-removed");
      return { revoked: [scopedProfile, survivingProfile], profiles: [] };
    },
  });

  const result = await manager.revokeIntegration({
    beforeRevoke: async () => {
      order.push("sessions-ended");
      return 2;
    },
    beforeCredentialsRemoved: async ({ providerNames }) => {
      assert.deepEqual(
        providerNames.sort(),
        [scopedProfile.providerName, survivingProfile.providerName].sort(),
      );
      order.push("providers-removed");
    },
  });

  assert.deepEqual(result, {
    revokedProfiles: 2,
    affectedSessions: 2,
    routeReady: false,
    runtimeRemoved: true,
  });
  assert.deepEqual(order, [
    "sessions-ended",
    "gateway-removed",
    "providers-removed",
    "credentials-removed",
    "collector-removed",
    "registry-removed",
    "network-removed",
  ]);
  assert.equal(gateway, false);
  assert.equal(collector, false);
  assert.equal(network, false);
  assert.doesNotMatch(
    calls.map(({ args }) => args.join(" ")).join("\n"),
    /orh_v1_|sk-ant-/,
  );
});
