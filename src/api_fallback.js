/**
 * Optional Hot-Standby API Fallback (JustOneAPI primary, OneBound secondary)
 * Zero hardcoded secrets: resolves credentials from environment variables or 1Password unattended vault.
 *
 * 1Password field truth (verified 2026-11-13 against the live item):
 *   - `username`   = the login account name (hxsmyxxx) — NOT the API key
 *   - `apiKey`     = the actual OneBound API key passed as `key`
 *   - `credential` = the API secret passed as `secret`
 * The older code read `username` as the key, which silently sent the login name to the API
 * gateway. This is fixed here and guarded by a unit test that asserts the field names requested
 * (no live API call is made by the test).
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

export const ONEBOUND_ITEM_TITLE = 'OneBound · 万邦开放平台 · Production · API · hxsmyxxx';
/** Stable item ID — more reliable than the display title when the item is renamed. */
export const ONEBOUND_ITEM_ID = 'up3jwujwc4oho44jmnto4n6emu';
export const ONEBOUND_ITEM_REFS = [ONEBOUND_ITEM_ID, ONEBOUND_ITEM_TITLE];
export const JUSTONEAPI_ITEM_TITLE = 'Just One API · Commercial Data Gateway · Production · User · yanghxmail@gmail.com';

/** 1Password fields that must never be used as the OneBound API key. */
export const ONEBOUND_FORBIDDEN_KEY_FIELDS = ['username', 'password'];

/** Fields, in priority order, that genuinely hold the OneBound API key. */
export const ONEBOUND_KEY_FIELDS = ['apiKey', 'API Key'];
/** Field that genuinely holds the OneBound API secret. */
export const ONEBOUND_SECRET_FIELDS = ['credential'];

/**
 * Fields, in priority order, that hold the JustOneAPI token.
 * `api_token` is the real field id (label "API Token"); `credential` is empty on that item.
 */
export const JUSTONEAPI_TOKEN_FIELDS = ['api_token', 'credential', 'token'];

/**
 * Resolve fallback-provider credentials without ever hardcoding a secret.
 *
 * @param {'justoneapi'|'onebound'} provider
 * @param {{ lookup?: (itemTitle: string, fieldName: string) => (string|null) }} [options]
 *   `lookup` is injectable so tests can assert the exact 1Password field names requested
 *   without touching 1Password or the network.
 * @returns {{ token?: string, key?: string, secret?: string }}
 */
export function resolveCredentials(provider, options = {}) {
  const lookup = options.lookup || lookupOpField;
  const lookupOneboundField = (fieldName) => {
    for (const itemRef of ONEBOUND_ITEM_REFS) {
      const value = lookup(itemRef, fieldName);
      if (value) return value;
    }
    return null;
  };

  if (provider === 'justoneapi') {
    const token = process.env.JUSTONEAPI_TOKEN || '';
    if (token) return { token };
    for (const field of JUSTONEAPI_TOKEN_FIELDS) {
      const value = lookup(JUSTONEAPI_ITEM_TITLE, field);
      if (value) return { token: value };
    }
    return { token: null };
  }

  if (provider === 'onebound') {
    const key = process.env.ONEBOUND_API_KEY || '';
    const secret = process.env.ONEBOUND_API_SECRET || '';
    if (key && secret) return { key, secret };

    let resolvedKey = key || null;
    if (!resolvedKey) {
      for (const field of ONEBOUND_KEY_FIELDS) {
        const value = lookupOneboundField(field);
        if (value) {
          resolvedKey = value;
          break;
        }
      }
    }

    let resolvedSecret = secret || null;
    if (!resolvedSecret) {
      for (const field of ONEBOUND_SECRET_FIELDS) {
        const value = lookupOneboundField(field);
        if (value) {
          resolvedSecret = value;
          break;
        }
      }
    }

    // Hard guard: the login account name / password are never API credentials.
    // Only probed when a key resolved (keeps --diagnose fast on a dead 1Password route).
    for (const forbidden of resolvedKey ? ONEBOUND_FORBIDDEN_KEY_FIELDS : []) {
      const forbiddenValue = lookupOneboundField(forbidden);
      if (forbiddenValue && forbiddenValue === resolvedKey) {
        throw new Error(
          `Refusing to use 1Password field "${forbidden}" as the OneBound API key; ` +
            'expected field "apiKey". Fix the credential mapping instead of degrading to a login account.'
        );
      }
    }

    return { key: resolvedKey, secret: resolvedSecret };
  }

  throw new Error(`Unsupported fallback provider: ${provider}`);
}

/**
 * Build a cached 1Password field reader (one `op` call per item+field, per process).
 * Never logs the value. `timeoutMs` keeps diagnostic commands fast on a dead op route.
 * @param {{timeoutMs?: number}} [options]
 * @returns {(itemTitle: string, fieldName: string) => (string|null)}
 */
export function createOpLookup(options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const onError = options.onError || null;
  const cache = new Map();
  const scriptPath = path.join(os.homedir(), '.agents/skills/1password/scripts/op_unattended.py');
  return (itemTitle, fieldName) => {
    const cacheKey = `${itemTitle}::${fieldName}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let value = null;
    try {
      const out = execFileSync(
        'python3',
        [scriptPath, 'item', 'get', itemTitle, '--vault', 'Agent Automation', '--fields', fieldName, '--reveal'],
        { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      value = out || null;
    } catch (err) {
      value = null;
      if (onError) {
        onError({
          itemTitle,
          fieldName,
          code: err?.code || 'ERROR',
          timedOut: err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM',
        });
      }
    }
    cache.set(cacheKey, value);
    return value;
  };
}

const defaultOpLookup = createOpLookup();

/**
 * Read one field from the unattended 1Password vault. Never logs the value.
 * @param {string} itemTitle
 * @param {string} fieldName
 * @returns {string|null}
 */
export function lookupOpField(itemTitle, fieldName) {
  return defaultOpLookup(itemTitle, fieldName);
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
