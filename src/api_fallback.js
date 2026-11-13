/**
 * Optional Hot-Standby API Fallback (JustOneAPI primary, OneBound secondary)
 * Zero hardcoded secrets: resolves credentials from environment variables or 1Password unattended vault.
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

export function resolveCredentials(provider) {
  if (provider === 'justoneapi') {
    const token = process.env.JUSTONEAPI_TOKEN || '';
    if (token) return { token };
    return { token: lookupOpField('Just One API', 'credential') || lookupOpField('JustOneAPI', 'token') };
  }
  if (provider === 'onebound') {
    const key = process.env.ONEBOUND_API_KEY || '';
    const secret = process.env.ONEBOUND_API_SECRET || '';
    if (key && secret) return { key, secret };
    return {
      key: key || lookupOpField('OneBound · 万邦开放平台 · Production · API · hxsmyxxx', 'username') || lookupOpField('OneBound · 万邦开放平台 · Production · API · hxsmyxxx', 'API Key'),
      secret: secret || lookupOpField('OneBound · 万邦开放平台 · Production · API · hxsmyxxx', 'credential'),
    };
  }
  throw new Error(`Unsupported fallback provider: ${provider}`);
}

function lookupOpField(itemTitle, fieldName) {
  const scriptPath = path.join(os.homedir(), '.agents/skills/1password/scripts/op_unattended.py');
  try {
    const out = execFileSync(
      'python3',
      [scriptPath, 'item', 'get', itemTitle, '--vault', 'Agent Automation', '--fields', fieldName, '--reveal'],
      { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function buildProviderRequest(provider, platform, action, params = {}, creds = {}) {
  if (provider === 'justoneapi') {
    if (!creds.token) throw new Error('Missing JUSTONEAPI_TOKEN (and 1Password unattended lookup returned empty).');
    const url = new URL(`https://api.justoneapi.com/api/${platform}/${action}`);
    url.searchParams.set('token', creds.token);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
  if (provider === 'onebound') {
    if (!creds.key || !creds.secret) throw new Error('Missing ONEBOUND_API_KEY / ONEBOUND_API_SECRET.');
    const url = new URL(`https://api-gw.onebound.cn/${platform}/${action}/`);
    url.searchParams.set('key', creds.key);
    url.searchParams.set('secret', creds.secret);
    url.searchParams.set('result_type', 'json');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

export async function callProviderApi(provider, platform, action, params = {}) {
  const creds = resolveCredentials(provider);
  const url = buildProviderRequest(provider, platform, action, params, creds);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    throw new Error(`${provider} ${platform}/${action} HTTP ${res.status}`);
  }
  return await res.json();
}
