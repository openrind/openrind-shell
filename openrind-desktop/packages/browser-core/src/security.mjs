import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BrowserFault, Principal, ProviderKind, LIMITS, Url, id } from '@openrind/browser-contract';

export const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const ownerKey = principal => hash(canonical([principal.tenantId, principal.workspaceId, principal.sandboxId, principal.conversationId]));
export class Grants {
  constructor(repository, { clock = Date.now } = {}) { this.repo = repository; this.clock = clock; }
  // Trusted host API only. Neither provisioning nor refresh is an MCP tool.
  issue(scope, policy) {
    const principal = Principal.parse({ ...scope, grantId: newId('bg'), expiresAt: this.clock() + LIMITS.grantMs });
    const allowed = validatePolicy(policy);
    const token = randomBytes(32).toString('base64url');
    this.repo.db.prepare('INSERT INTO grants VALUES(?,?,?,?,?,1)').run(principal.grantId, hash(token), ownerKey(principal),
      JSON.stringify({ principal, policy: allowed }), principal.expiresAt);
    return { token, principal };
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BrowserFault('UNAUTHORIZED');
    const row = this.repo.db.prepare('SELECT * FROM grants WHERE token_hash=?').get(hash(token));
    if (!row || !row.active || row.expires <= this.clock()) throw new BrowserFault('UNAUTHORIZED');
    const data = JSON.parse(row.data);
    return { ...data, owner: row.owner };
  }
  refresh(grantId) {
    const row = this.repo.db.prepare('SELECT * FROM grants WHERE id=?').get(grantId);
    if (!row || !row.active || row.expires <= this.clock()) throw new BrowserFault('UNAUTHORIZED');
    const data = JSON.parse(row.data), token = randomBytes(32).toString('base64url');
    data.principal.expiresAt = this.clock() + LIMITS.grantMs;
    this.repo.db.prepare('UPDATE grants SET token_hash=?,expires=?,data=? WHERE id=?').run(hash(token), data.principal.expiresAt, JSON.stringify(data), grantId);
    return { token, principal: data.principal };
  }
  // Trusted live-controller renewal keeps the inherited per-process token valid.
  // It cannot resurrect a revoked/expired grant; rotation remains refresh().
  renew(token) {
    const auth = this.authenticate(token);
    const expiresAt = this.clock() + LIMITS.grantMs;
    const data = { principal: { ...auth.principal, expiresAt }, policy: auth.policy };
    const changed = this.repo.db.prepare('UPDATE grants SET expires=?,data=? WHERE id=? AND active=1 AND expires>?')
      .run(expiresAt, JSON.stringify(data), auth.principal.grantId, this.clock());
    if (changed.changes !== 1) throw new BrowserFault('UNAUTHORIZED');
    return data.principal;
  }
  assertActive(auth) {
    const row = this.repo.db.prepare('SELECT active,expires,data FROM grants WHERE id=? AND owner=?').get(auth.principal.grantId, auth.owner);
    if (!row?.active || row.expires <= this.clock()) throw new BrowserFault('UNAUTHORIZED');
    if (JSON.parse(row.data).policy.revision !== auth.policy.revision) throw new BrowserFault('POLICY_DENIED');
  }
  revoke(grantId) { this.repo.db.prepare('UPDATE grants SET active=0 WHERE id=?').run(grantId); }
  revokeOwner(owner) { this.repo.db.prepare('UPDATE grants SET active=0 WHERE owner=?').run(owner); }
}
export function validatePolicy(input) {
  if (!input || !Array.isArray(input.providers) || !input.providers.length || input.providers.length > 3 ||
      !Array.isArray(input.origins) || input.origins.length > 128 ||
      !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('Explicit browser policy required');
  const providers = [...new Set(input.providers.map(value => ProviderKind.parse(value)))];
  const origins = input.origins.map(value => {
    const url = new URL(Url.parse(value));
    if (url.origin !== value) throw new Error('Policy requires normalized origins');
    return value;
  });
  const profiles = (input.profiles || []).map(value => id.parse(value));
  if (profiles.length > 32) throw new Error('Profile policy limit');
  return { revision: input.revision, providers, origins, profiles, approveMutations: input.approveMutations !== false };
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Restrict IPv6 to global unicast; exclude mapped/transition/documentation ranges.
  return isIP(address) === 6 && /^[23]/i.test(address) &&
    !/^(2001:|2002:|3fff:)/i.test(address);
}
export async function validateDestination(value, policy, resolver = lookup) {
  let url; try { url = new URL(Url.parse(value)); } catch { throw new BrowserFault('POLICY_DENIED'); }
  const originAllowed = policy.origins.length === 0 || policy.origins.includes(url.origin);
  if (!originAllowed || url.hostname.endsWith('.localhost') || url.hostname === 'localhost') throw new BrowserFault('POLICY_DENIED');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = isIP(hostname) ? [{ address: hostname }] : await resolver(hostname, { all: true, verbatim: true }); }
  catch { throw new BrowserFault('POLICY_DENIED'); }
  if (!addresses.length || !addresses.every(item => publicAddress(item.address))) throw new BrowserFault('POLICY_DENIED');
  return Object.freeze({ href: url.href, origin: url.origin });
}
export class Approvals {
  constructor(repo, { clock = Date.now } = {}) { this.repo = repo; this.clock = clock; }
  issue(binding, expiresAt) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.clock() || expiresAt > this.clock() + LIMITS.grantMs) throw new BrowserFault('INVALID_ARGUMENT');
    const record = { ...binding, expiresAt, id: newId('ba') };
    this.repo.db.prepare('INSERT INTO approvals(id,owner,data) VALUES(?,?,?)').run(record.id, binding.owner, JSON.stringify(record));
    return record.id;
  }
  consume(binding) {
    const candidates = this.repo.db.prepare('SELECT * FROM approvals WHERE owner=? AND consumed=0').all(binding.owner);
    const row = candidates.find(row => { const value = JSON.parse(row.data);
      return value.expiresAt > this.clock() && Object.entries(binding).every(([key, expected]) => value[key] === expected); });
    if (!row) throw new BrowserFault('APPROVAL_REQUIRED');
    if (this.repo.db.prepare('UPDATE approvals SET consumed=1 WHERE id=? AND consumed=0').run(row.id).changes !== 1) throw new BrowserFault('APPROVAL_REQUIRED');
  }
}
