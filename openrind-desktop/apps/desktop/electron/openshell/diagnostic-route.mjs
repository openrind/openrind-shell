export const DIAGNOSTIC_CONTRACT = "openrind-runtime-diagnostics/v1";
export const MAX_DIAGNOSTIC_TOKEN_LIFETIME_MS = 5 * 60_000;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function validateRoute(body, sandboxName, now) {
  let url;
  try { url = new URL(body?.endpoint); } catch { throw failure("route_invalid"); }
  if (body.contract !== DIAGNOSTIC_CONTRACT || body.protocol !== "http/protobuf" ||
      !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash ||
      body.sandboxName !== sandboxName || body.project !== sandboxName ||
      !Array.isArray(body.signals) || !["traces", "logs", "metrics"].every(signal => body.signals.includes(signal)) ||
      !Number.isSafeInteger(body.expiresAtMs) || body.expiresAtMs <= now ||
      body.expiresAtMs - now > MAX_DIAGNOSTIC_TOKEN_LIFETIME_MS ||
      typeof body.authorization !== "string" || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(body.authorization) ||
      body.authorization.length > 8192) {
    throw failure("route_invalid");
  }
  return { endpoint: url.origin, project: body.project, sandboxName,
    authorization: body.authorization, expiresAtMs: body.expiresAtMs };
}

// The private control plane supplies a host address. It is never inferred from
// a sandbox/inference URL. The supplied Haloop source has no route here.
export async function resolveDiagnosticRoute({ sandboxName, requestRoute, now = Date.now }) {
  if (typeof sandboxName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,18}$/.test(sandboxName)) {
    throw failure("route_invalid");
  }
  async function read() {
    let response;
    try {
      response = await requestRoute({ method: "POST", requestPath: "/diagnostics/route",
        body: { contract: DIAGNOSTIC_CONTRACT, sandboxName }, timeoutMs: 3000 });
    } catch { throw failure("route_unavailable"); }
    if (response.status === 404 || response.status === 501) return null;
    if (response.status === 401 || response.status === 403) throw failure("route_unauthorized");
    if (response.status !== 200) throw failure("route_unavailable");
    return validateRoute(response.body, sandboxName, now());
  }
  let route = await read();
  if (!route) return null;
  const endpoint = route.endpoint;
  let refresh;
  let revokeTask;
  let closing = false;
  return {
    endpoint, project: route.project, sandboxName,
    headers: async () => {
      if (closing) throw failure("route_unauthorized");
      if (route.expiresAtMs - now() <= 30_000) {
        refresh ??= read().then(next => {
          if (!next || next.endpoint !== endpoint) throw failure("route_invalid");
          route = next;
        }).finally(() => { refresh = undefined; });
        await refresh;
      }
      if (route.expiresAtMs <= now()) throw failure("route_unauthorized");
      return { authorization: route.authorization };
    },
    revoke() {
      if (revokeTask) return revokeTask;
      closing = true;
      revokeTask = (async () => {
        try {
          // Finish an in-flight renewal before revoking the newest token.
          if (refresh) {
            try { await refresh; } catch { /* Revoke the last known token. */ }
          }
          const authorization = route.authorization;
          const response = await requestRoute({ method: "POST", requestPath: "/diagnostics/revoke",
            timeoutMs: 3000, body: { contract: DIAGNOSTIC_CONTRACT, sandboxName,
              project: route.project, authorization } });
          if (response.status === 200 || response.status === 204) return "revoked";
          if (response.status === 404 || response.status === 501) return "unsupported";
          if (response.status === 401 || response.status === 403) return "unauthorized";
          return "unavailable";
        } catch { return "unavailable"; }
        finally { route = { ...route, authorization: "" }; }
      })();
      return revokeTask;
    },
  };
}
