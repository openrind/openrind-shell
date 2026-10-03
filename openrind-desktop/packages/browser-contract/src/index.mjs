import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({ sessionsPerConversation: 2, sessionsPerWorker: 4, pages: 8,
  queue: 32, creationMs: 60_000, actionMs: 30_000, maxActionMs: 120_000,
  snapshotNodes: 2000, snapshotTextBytes: 65_536, bodyBytes: 1_048_576,
  artifactBytes: 104_857_600, screenshotBytes: 16_777_216, grantMs: 900_000,
  sessionMs: 7_200_000, idleMs: 900_000, operationRetentionMs: 86_400_000 });
export const ProviderKind = z.enum(['local-chromium', 'browserbase', 'desktop-webview']);
export const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,127}$/);
const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const session = { sessionId: id, sessionEpoch: epoch };
const page = { ...session, pageId: id };
const operation = { operationId: id };
const strict = shape => z.object(shape).strict();
export const Url = z.string().min(1).max(4096).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }
  catch { return false; }
}, 'An HTTPS URL without credentials or a fragment is required');
export const WorkspacePath = z.string().min(1).max(1024).refine(value =>
  !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') &&
  value.split('/').every(part => part && part !== '.' && part !== '..'), 'Workspace-relative path required');
const ProfileMode = z.enum(['ephemeral', 'host-retained', 'provider-context']);
const Region = strict({ x: z.number().int().min(0).max(16384), y: z.number().int().min(0).max(16384),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) });
export const ToolSchemas = Object.freeze({
  browser_capabilities: strict({ sessionId: id.optional() }),
  browser_start: strict({ ...operation, provider: ProviderKind, profileMode: ProfileMode.default('ephemeral'),
    profileId: id.optional(), url: Url.optional(), networkEnforcement: z.enum(['application-guardrails', 'enforced-backend-policy']).default('application-guardrails') })
    .refine(v => (v.profileMode === 'host-retained' ? Boolean(v.profileId) : !v.profileId), 'Retained profiles require an approved profile ID'),
  browser_status: strict({ sessionId: id, sessionEpoch: epoch.optional() }),
  browser_tabs: strict({ ...session, action: z.enum(['list', 'open', 'close']),
    operationId: id.optional(), pageId: id.optional(), url: Url.optional() }).refine(v =>
    v.action === 'list' ? v.operationId === undefined && v.pageId === undefined && v.url === undefined :
    v.action === 'open' ? v.operationId !== undefined && v.url !== undefined && v.pageId === undefined :
    v.operationId !== undefined && v.pageId !== undefined && v.url === undefined,
    'List takes only session fields; open requires operationId and url; close requires operationId and pageId'),
  browser_navigate: strict({ ...page, ...operation, url: Url }),
  browser_snapshot: strict({ ...page, depth: z.number().int().min(1).max(32).default(8),
    maxNodes: z.number().int().min(1).max(LIMITS.snapshotNodes).default(LIMITS.snapshotNodes),
    maxTextBytes: z.number().int().min(1).max(LIMITS.snapshotTextBytes).default(LIMITS.snapshotTextBytes) }),
  browser_click: strict({ ...page, ...operation, ref: id }),
  browser_fill: strict({ ...page, ...operation, ref: id, text: z.string().max(65_536).optional(), secretId: id.optional() })
    .refine(v => (v.text !== undefined) !== (v.secretId !== undefined), 'Exactly one input value source is required'),
  browser_select: strict({ ...page, ...operation, ref: id, values: z.array(z.string().max(4096)).min(1).max(32) }),
  browser_press: strict({ ...page, ...operation, key: z.enum(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Control+A', 'Meta+A']) }),
  browser_scroll: strict({ ...page, ...operation, direction: z.enum(['up', 'down', 'left', 'right']), distance: z.number().int().min(1).max(4096) }),
  browser_screenshot: strict({ ...page, ...operation, region: Region.optional() }),
  browser_upload_file: strict({ ...page, ...operation, ref: id, artifactId: id }),
  browser_downloads: strict({ ...session }),
  browser_take_control: strict({ ...session, ...operation }),
  browser_resume: strict({ ...session, ...operation, handoffId: id }),
  browser_close: strict({ ...session, ...operation }),
  browser_import_file: strict({ ...session, ...operation, path: WorkspacePath }),
  browser_save_artifact: strict({ ...session, ...operation, artifactId: id, destination: WorkspacePath, overwrite: z.boolean().default(false) }),
});
export const LOCAL_TOOLS = Object.freeze(['browser_import_file', 'browser_save_artifact']);
export const REMOTE_TOOLS = Object.freeze(Object.keys(ToolSchemas).filter(name => !LOCAL_TOOLS.includes(name)));
export const ERROR_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Invalid browser request.', UNAUTHORIZED: 'Browser grant is invalid or expired.',
  FORBIDDEN: 'This browser resource is not available to this caller.', SESSION_LOST: 'The browser session is unavailable.',
  STALE_EPOCH: 'Refresh browser status before continuing.', CAPABILITY_UNAVAILABLE: 'This capability is unavailable.',
  STALE_REF: 'Take a fresh snapshot before using this reference.', POLICY_DENIED: 'Browser policy denied this operation.',
  APPROVAL_REQUIRED: 'Trusted approval is required for this operation.', ACTION_NOT_POSSIBLE: 'The action cannot be performed in the current state.',
  OUTCOME_UNKNOWN: 'The action may have completed. Inspect and reconcile before continuing.',
  TIMEOUT: 'The browser operation deadline expired.', RATE_LIMITED: 'Browser resource limits were reached.',
  ARTIFACT_EXPIRED: 'The artifact is unavailable or expired.', BACKEND_UNAVAILABLE: 'The browser backend is unavailable.',
  OPERATION_CONFLICT: 'This operation ID was already used with different inputs.', CANCELLED: 'The operation was cancelled before dispatch.',
});
export class BrowserFault extends Error {
  constructor(code, outcome = 'not-started') { super(ERROR_MESSAGES[code] || ERROR_MESSAGES.BACKEND_UNAVAILABLE); this.code = code in ERROR_MESSAGES ? code : 'BACKEND_UNAVAILABLE'; this.outcome = outcome; }
}
export function failure(error, operationId) {
  const fault = error instanceof BrowserFault ? error : new BrowserFault('BACKEND_UNAVAILABLE');
  return { ok: false, code: fault.code, message: fault.message, ...(operationId ? { operationId } : {}),
    outcome: fault.outcome, retry: fault.outcome === 'unknown' ? 'inspect-first' :
      ['TIMEOUT', 'RATE_LIMITED', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(fault.code) ? 'safe' : 'never' };
}
export function parseTool(name, input, { local = false } = {}) {
  if (!Object.hasOwn(ToolSchemas, name) || (!local && LOCAL_TOOLS.includes(name))) throw new BrowserFault('INVALID_ARGUMENT');
  let size; try { size = Buffer.byteLength(JSON.stringify(input)); } catch { throw new BrowserFault('INVALID_ARGUMENT'); }
  if (size > LIMITS.bodyBytes) throw new BrowserFault('INVALID_ARGUMENT');
  const result = ToolSchemas[name].safeParse(input);
  if (!result.success) throw new BrowserFault('INVALID_ARGUMENT');
  return result.data;
}
export function toolDefinitions({ local = false } = {}) {
  return (local ? Object.keys(ToolSchemas) : REMOTE_TOOLS).map(name => ({ name,
    description: `Openrind ${name.slice(8).replaceAll('_', ' ')}. Explicit session ownership and capability checks apply.`,
    inputSchema: z.toJSONSchema(ToolSchemas[name], { unrepresentable: 'any' }) }));
}
export const Principal = strict({ tenantId: id, workspaceId: id, sandboxId: id, conversationId: id,
  grantId: id, expiresAt: z.number().int().positive() });
export const Capabilities = strict({ protocol: z.literal(1), provider: ProviderKind,
  driver: z.enum(['playwright', 'electron-debugger']), browserVersion: z.string().max(128),
  navigation: z.boolean(), semanticSnapshot: z.boolean(), elementActions: z.boolean(), crossOriginFrames: z.boolean(),
  screenshots: z.boolean(), fileUpload: z.boolean(), fileDownload: z.boolean(), managedPopups: z.boolean(), backgroundAutomation: z.boolean(),
  manualControl: z.enum(['local-window', 'provider-viewer', 'sidebar', 'none']), profiles: ProfileMode,
  reconnect: z.enum(['existing-session', 'new-session-only']), networkEnforcement: z.enum(['application-guardrails', 'enforced-backend-policy']) });
export const PrivateRequest = strict({ protocol: z.literal(1), requestId: id, method: z.enum(['dispatch', 'status', 'cancel']),
  sessionId: id, sessionEpoch: epoch, operationId: id.optional() });
