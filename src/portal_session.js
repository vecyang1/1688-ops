/**
 * OneBound trend portal client — 商品比价 (image-compare) via captured Inertia session.
 *
 * The portal (https://trend.onebound.cn) is a Laravel/Inertia app. Calls can be made
 * out-of-browser with the session cookies captured once by the browser owner. This module
 * NEVER prints or logs cookie values, tokens or XSRF secrets: all error paths pass through
 * `redactSecrets()` and the public `describe()` returns only booleans/counts.
 *
 * Session file shape (mode 0600):
 *   { captured_at, origin, user_agent, inertia_version,
 *     cookies: [ { name, value, domain, path, ... }, ... ] | "name=value; name2=value2" }
 *
 * Contract (verified live 2026-11-13, see data/portal_e2e.json):
 *   GET  /portal/image-compare                       -> props.quota / recentRequests / selectedRequest / results
 *   POST /portal/image-compare (form-urlencoded)     -> 302 Location: /portal/image-compare?request_id=N
 *   GET  /portal/image-compare?request_id=N&page=N   -> poll request / paginate results
 *   GET  /portal/shop-monitor/resolve-shop-from-item -> shop_name / seller_nick (free)
 *   GET  /portal/image-compare/image-proxy?url=      -> free image proxy
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const PORTAL_ORIGIN = 'https://trend.onebound.cn';
export const PORTAL_BASE_PATH = '/portal/image-compare';
export const DEFAULT_SESSION_PATH = path.join(
  process.env.PROVIDER_RADAR_DIR ||
    path.resolve(process.env.HOME || '.', 'Documents/Cowork/Antigravity Cowork/26.11.13 OneBound Provider Radar'),
  'tmp/trend_session.json'
);

export class PortalError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human message (never contains a secret)
   * @param {{actionable?: string, status?: number, details?: object}} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
    this.actionable = meta.actionable || null;
    this.status = meta.status ?? null;
    this.details = meta.details || null;
  }
}

const SECRET_KEY_RE = /(cookie|session|token|xsrf|csrf|secret|authorization)/i;

/**
 * Recursively replace sensitive values with a shape-only placeholder.
 * Used on anything that may reach a log, an error message or stdout.
 */
export function redactSecrets(value, depth = 0) {
  if (depth > 6) return '<max-depth>';
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '<redacted>' : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Normalize cookies to a `name=value; name2=value2` header string.
 * @param {Array<{name:string,value:string}>|string} cookies
 * @returns {string}
 */
export function buildCookieHeader(cookies) {
  if (!cookies) return '';
  if (typeof cookies === 'string') return cookies.trim();
  if (Array.isArray(cookies)) {
    return cookies
      .filter((c) => c && c.name && c.value !== undefined && c.value !== null)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
  if (typeof cookies === 'object') {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  return '';
}

/**
 * Laravel XSRF-TOKEN cookie is URL-encoded; the X-XSRF-TOKEN header must be decoded.
 * @param {Array<{name:string,value:string}>|string} cookies
 * @returns {string|null}
 */
export function extractXsrfToken(cookies) {
  const header = buildCookieHeader(cookies);
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === 'XSRF-TOKEN') {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/**
 * Load and validate a captured portal session file.
 * Enforces the 0600-or-tighter file mode so a world-readable cookie file fails loudly.
 * @param {string} [sessionPath]
 * @returns {{captured_at?:string,origin?:string,user_agent:string,inertia_version:string,cookies:Array<object>|string}}
 */
export function loadSession(sessionPath = DEFAULT_SESSION_PATH) {
  if (!fs.existsSync(sessionPath)) {
    throw new PortalError(
      'PORTAL_SESSION_MISSING',
      `未找到 OneBound 门户会话文件: ${sessionPath}`,
      {
        actionable:
          '请由浏览器负责人重新捕获 trend.onebound.cn 的登录态会话（cookies + user_agent + inertia_version）并写入该路径，权限 0600；本工具不自行登录。',
      }
    );
  }

  const stat = fs.statSync(sessionPath);
  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    throw new PortalError(
      'PORTAL_SESSION_INSECURE',
      `会话文件权限过宽 (mode ${mode.toString(8).padStart(3, '0')}): ${sessionPath}`,
      { actionable: `请执行 chmod 600 "${sessionPath}" 后重试。` }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (err) {
    throw new PortalError('PORTAL_SESSION_INVALID', `会话文件不是合法 JSON，无法解析: ${sessionPath}`, {
      actionable: '重新捕获会话文件；不要手工拼接 JSON。',
    });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new PortalError('PORTAL_SESSION_INVALID', '会话文件内容为空或类型错误。');
  }
  if (!parsed.cookies || (Array.isArray(parsed.cookies) && parsed.cookies.length === 0)) {
    throw new PortalError('PORTAL_SESSION_INVALID', '会话文件缺少 cookies 字段。', {
      actionable: '检查捕获脚本是否把 XSRF-TOKEN 与 -session cookie 一并写入。',
    });
  }
  if (!parsed.inertia_version) {
    throw new PortalError('PORTAL_SESSION_INVALID', '会话文件缺少 inertia_version（Inertia 请求头必需）。', {
      actionable: '捕获页面时读取 data-page 属性或 X-Inertia-Version 响应头并写入会话文件。',
    });
  }

  return {
    captured_at: parsed.captured_at || null,
    origin: parsed.origin || PORTAL_ORIGIN,
    user_agent: parsed.user_agent || 'Mozilla/5.0 (compatible; 1688-ops-provider-radar)',
    inertia_version: String(parsed.inertia_version),
    cookies: parsed.cookies,
  };
}

/** Safe, secret-free session description suitable for stdout/JSON. */
export function describeSession(session, sessionPath = DEFAULT_SESSION_PATH) {
  const cookies = Array.isArray(session.cookies) ? session.cookies : [];
  return {
    path: sessionPath,
    captured_at: session.captured_at,
    origin: session.origin,
    user_agent: session.user_agent,
    inertia_version: session.inertia_version,
    cookie_names: cookies.map((c) => c.name).filter(Boolean),
    cookie_count: cookies.length,
  };
}

/** Extract `request_id` from a redirect Location or a URL string. */
export function extractRequestId(location) {
  if (!location) return null;
  const match = String(location).match(/[?&]request_id=(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Laravel flash strings that mean the portal quota is exhausted. */
const QUOTA_FLASH_RE = /(quota|额度|配额|次数已用完|免费.*用完|升级.*pro)/i;

/** Normalize an Inertia page payload into `{props, quota, results, selectedRequest, flash}`. */
export function parseInertiaPage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const props = payload.props || {};
  const quota = props.quota || null;
  const results = props.results || null;
  const selectedRequest = props.selectedRequest || props.selected_request || null;
  const flash = props.flash || props.session?.flash || null;
  return { props, quota, results, selectedRequest, flash, errors: props.errors || {} };
}

/**
 * Detect an exhausted quota from either the quota prop or the flash bag.
 * @returns {null | {remaining:number|null, reason:string}}
 */
export function detectQuotaExhausted(page) {
  if (!page) return null;
  const remaining =
    page.quota && typeof page.quota.searchesRemaining === 'number' ? page.quota.searchesRemaining : null;
  const flashHints = [];
  if (page.flash && page.flash.quota_exhausted === true) flashHints.push('flash.quota_exhausted=true');
  if (page.flash && typeof page.flash.status === 'string' && QUOTA_FLASH_RE.test(page.flash.status)) {
    flashHints.push('flash.status=quota-ish');
  }
  if (remaining !== null && remaining <= 0) {
    return {
      remaining,
      reason: `门户比价免费额度已用尽 (searchesRemaining=${remaining}); 商品比价属于 Pro 功能，免费版仅 2 次试用。`,
    };
  }
  if (flashHints.length > 0) {
    return {
      remaining,
      reason: `门户返回额度耗尽信号 (${flashHints.join(', ')})。`,
    };
  }
  return null;
}

/**
 * Client for the OneBound trend portal image-compare API.
 *
 * All methods throw `PortalError` with a stable `code` and an `actionable` hint instead of
 * leaking raw HTML/cookies. `fetchImpl` is injectable for fixture-based tests (no live call).
 */
export class PortalSessionClient {
  /**
   * @param {{
   *   session?: object,
   *   sessionPath?: string,
   *   fetchImpl?: typeof fetch,
   *   baseUrl?: string,
   *   timeoutMs?: number,
   *   pollIntervalMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.session = options.session || loadSession(options.sessionPath);
    this.sessionPath = options.sessionPath || DEFAULT_SESSION_PATH;
    this.baseUrl = options.baseUrl || this.session.origin || PORTAL_ORIGIN;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.cookieHeader = buildCookieHeader(this.session.cookies);
    this.xsrfToken = extractXsrfToken(this.session.cookies);
  }

  /** Secret-free description. */
  describe() {
    return describeSession(this.session, this.sessionPath);
  }

  /** Headers for Inertia requests. Never contains a raw cookie in any serialized output. */
  buildHeaders(extra = {}) {
    const headers = {
      Accept: 'text/html, application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': this.session.user_agent,
      'X-Inertia': 'true',
      'X-Inertia-Version': this.session.inertia_version,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${this.baseUrl}${PORTAL_BASE_PATH}`,
      ...(this.cookieHeader ? { Cookie: this.cookieHeader } : {}),
      ...(this.xsrfToken ? { 'X-XSRF-TOKEN': this.xsrfToken } : {}),
      ...extra,
    };
    return headers;
  }

  /** Low-level request. Handles Inertia JSON, redirects and version conflicts. */
  async request(method, pathname, { query, form } = {}) {
    const url = new URL(pathname, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers = this.buildHeaders(
      form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}
    );
    const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) };
    if (form) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
      }
      init.body = body.toString();
    }

    let res;
    try {
      res = await this.fetchImpl(url.toString(), init);
    } catch (err) {
      throw new PortalError('PORTAL_NETWORK', `门户请求失败 (${method} ${url.pathname}): ${err.message}`, {
        actionable: '检查网络/代理；门户会话可能过期，由浏览器负责人重新捕获即可。',
      });
    }

    const status = res.status;
    const location = res.headers?.get?.('location') || null;
    const inertiaLocation = res.headers?.get?.('x-inertia-location') || null;

    // 409 = Inertia asset-version mismatch; the client must refresh the captured version.
    if (status === 409) {
      throw new PortalError(
        'PORTAL_INERTIA_VERSION_STALE',
        '门户 Inertia 版本已变化 (HTTP 409)，捕获的 inertia_version 过期。',
        {
          actionable: '由浏览器负责人重新捕获会话文件（含最新 inertia_version）后重试。',
          status,
          details: { redirect_to: inertiaLocation ? String(inertiaLocation).split('?')[0] : null },
        }
      );
    }

    if (status === 302 || status === 303 || status === 301 || status === 307) {
      return { status, location, payload: null, requestId: extractRequestId(location) };
    }

    if (status === 401 || status === 419 || status === 403) {
      throw new PortalError(
        'PORTAL_SESSION_EXPIRED',
        `门户会话失效或 CSRF 校验失败 (HTTP ${status})。`,
        {
          actionable: '由浏览器负责人重新捕获 trend.onebound.cn 会话（cookie + XSRF），不要尝试在命令行登录。',
          status,
        }
      );
    }

    let payload = null;
    const text = await res.text();
    const contentType = res.headers?.get?.('content-type') || '';
    if (contentType.includes('json') || (text && text.trim().startsWith('{'))) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (status === 422) {
      const errors = payload?.errors || payload?.props?.errors || {};
      throw new PortalError('PORTAL_VALIDATION', '门户参数校验失败 (HTTP 422)。', {
        actionable: flattenValidation(errors),
        status,
        details: { errors: redactSecrets(errors) },
      });
    }
    if (status === 429) {
      throw new PortalError('PORTAL_RATE_LIMITED', '门户请求被限流 (HTTP 429)。', {
        actionable: '降低频率，稍后重试；不要循环重试。',
        status,
      });
    }
    if (status >= 500) {
      throw new PortalError('PORTAL_UPSTREAM', `门户服务端错误 (HTTP ${status})。`, {
        actionable: '门户自身故障，稍后重试；此错误不消耗比价额度。',
        status,
      });
    }

    return { status, location: null, payload, requestId: null };
  }

  /** GET /portal/image-compare — free read of quota / recent requests / results. */
  async quota() {
    const { payload } = await this.request('GET', PORTAL_BASE_PATH);
    const page = parseInertiaPage(payload);
    if (!page) {
      throw new PortalError('PORTAL_CONTRACT', '门户返回内容不是 Inertia JSON，无法读取额度。', {
        actionable: '会话可能退化为 HTML 登录页；重新捕获会话，或检查 X-Inertia 请求头。',
        details: { payload_kind: payload === null ? 'html' : typeof payload },
      });
    }
    return {
      quota: page.quota,
      membership: page.props?.membership || null,
      exhausted: detectQuotaExhausted(page),
      captured_at: new Date().toISOString(),
    };
  }

  /**
   * POST /portal/image-compare — dispatch a comparison search.
   * @param {{
   *   mode: 'item_id'|'image',
   *   platform_scope?: 'all'|'1688'|'taobao',
   *   item_url?: string,
   *   image_url?: string,
   *   image_file?: string,
   *   checkQuota?: boolean,
   * }} params
   */
  async search(params) {
    const mode = params.mode;
    if (mode !== 'item_id' && mode !== 'image') {
      throw new PortalError('PORTAL_INVALID_MODE', `不支持的 query_mode: ${mode}`, {
        actionable: "query_mode 只能是 'item_id'（链接比价）或 'image'（以图比价）。",
      });
    }
    const platformScope = params.platform_scope || 'all';
    if (!['all', '1688', 'taobao'].includes(platformScope)) {
      throw new PortalError('PORTAL_INVALID_SCOPE', `不支持的 platform_scope: ${platformScope}`, {
        actionable: "platform_scope 只能是 'all' | '1688' | 'taobao'。",
      });
    }
    if (mode === 'item_id' && !params.item_url) {
      throw new PortalError('PORTAL_MISSING_INPUT', 'item_id 模式缺少 item_url。', {
        actionable: '提供 1688/淘宝商品链接，例如 https://detail.1688.com/offer/<id>.html',
      });
    }
    if (mode === 'image' && !params.image_url && !params.image_file) {
      throw new PortalError('PORTAL_MISSING_INPUT', 'image 模式缺少 image_url 或 image_file。', {
        actionable: '提供公网可访问的图片 URL（协议相对 //img.alicdn.com/... 需补 https:），或本地图片路径。',
      });
    }
    if (params.image_url && params.image_url.startsWith('//')) {
      throw new PortalError('PORTAL_INVALID_IMAGE_URL', 'image_url 是协议相对地址，门户 URL 校验会拒绝。', {
        actionable: '在 //img.alicdn.com/... 前补上 https: 后重试。',
      });
    }

    if (params.checkQuota !== false) {
      const q = await this.quota();
      if (q.exhausted) {
        throw new PortalError('PORTAL_QUOTA_EXHAUSTED', q.exhausted.reason, {
          actionable:
            '免费额度已用尽且不会每日重置。渠道替代方案：用 `1688-ops image-search <本地图片>`（拍立淘，走浏览器登录态）或 JustOneAPI `product-search-by-image-v1`（约 ¥0.04/次）。升级 Pro（¥1,500/月）后可重试 query_mode=image。',
          details: { remaining: q.exhausted.remaining, quota: q.quota },
        });
      }
    }

    if (params.image_file) {
      throw new PortalError('PORTAL_MULTIPART_NOT_IMPLEMENTED', 'image_file 多部件上传尚未实现。', {
        actionable: '改用 image_url（公网图片链接）或 item_id 模式。',
      });
    }

    const form = {
      query_mode: mode,
      platform_scope: platformScope,
      ...(mode === 'item_id' ? { item_url: params.item_url } : { image_url: params.image_url }),
    };

    const { status, location, payload, requestId } = await this.request('POST', PORTAL_BASE_PATH, { form });

    if (requestId !== null) {
      return {
        status,
        request_id: requestId,
        state: 'dispatched',
        poll: `GET ${PORTAL_BASE_PATH}?request_id=${requestId}`,
      };
    }

    // Some deployments answer the POST with the Inertia page directly (no redirect).
    const page = parseInertiaPage(payload);
    if (page) {
      const exhausted = detectQuotaExhausted(page);
      if (exhausted) {
        throw new PortalError('PORTAL_QUOTA_EXHAUSTED', exhausted.reason, {
          actionable: '免费试用次数已用完；改用 `1688-ops image-search`（浏览器登录态）或 JustOneAPI 以图搜款。',
          details: { remaining: exhausted.remaining },
        });
      }
      if (page.errors && Object.keys(page.errors).length > 0) {
        throw new PortalError('PORTAL_VALIDATION', '门户参数校验失败。', {
          actionable: flattenValidation(page.errors),
          status,
          details: { errors: redactSecrets(page.errors) },
        });
      }
      return {
        status,
        request_id: page.selectedRequest?.id ?? null,
        state: page.selectedRequest?.status || 'completed',
        page,
      };
    }

    throw new PortalError('PORTAL_UNEXPECTED_RESPONSE', '门户 POST 返回了无法识别的内容。', {
      actionable: '检查会话是否过期；不要循环重试，避免消耗额度。',
      status,
      details: { location: location ? String(location).split('?')[0] : null },
    });
  }

  /** GET /portal/image-compare?request_id=N[&page=N] — poll one request / paginate results. */
  async getRequest(requestId, { page } = {}) {
    if (!requestId) {
      throw new PortalError('PORTAL_MISSING_INPUT', '缺少 request_id。');
    }
    const { payload } = await this.request('GET', PORTAL_BASE_PATH, {
      query: { request_id: requestId, page },
    });
    const parsed = parseInertiaPage(payload);
    if (!parsed) {
      throw new PortalError('PORTAL_CONTRACT', `读取 request ${requestId} 失败：返回内容不是 Inertia JSON。`, {
        actionable: '会话可能已过期；重新捕获会话后重试。',
      });
    }
    return {
      request: parsed.selectedRequest,
      results: parsed.results,
      quota: parsed.quota,
      exhausted: detectQuotaExhausted(parsed),
      status: parsed.selectedRequest?.status || (parsed.results ? 'completed' : 'unknown'),
    };
  }

  /**
   * Poll a request until it reaches a terminal status.
   * @param {number} requestId
   * @param {{timeoutMs?: number, intervalMs?: number}} [options]
   */
  async waitForRequest(requestId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000;
    const intervalMs = options.intervalMs ?? this.pollIntervalMs;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const state = await this.getRequest(requestId);
      if (['completed', 'failed', 'error'].includes(state.status)) return state;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new PortalError('PORTAL_POLL_TIMEOUT', `等待 request ${requestId} 完成超时 (${timeoutMs}ms)。`, {
      actionable: '稍后用 provider-radar 的请求轮询重试；不要重复 POST，避免重复扣额度。',
    });
  }

  /** GET /portal/shop-monitor/resolve-shop-from-item — free shop-name resolver. */
  async resolveShop(platform, productId) {
    if (!platform || !productId) {
      throw new PortalError('PORTAL_MISSING_INPUT', 'resolveShop 需要 platform 与 product_id。');
    }
    const { payload } = await this.request(
      'GET',
      '/portal/shop-monitor/resolve-shop-from-item',
      { query: { platform, product_id: productId } }
    );
    if (!payload) {
      throw new PortalError('PORTAL_CONTRACT', '店铺解析返回空内容。', { actionable: '稍后重试或手动查询。' });
    }
    const data = payload.data || payload.props?.data || payload;
    return {
      platform,
      product_id: String(productId),
      shop_name: data.shop_name ?? null,
      seller_nick: data.seller_nick ?? null,
      shop_id: data.shop_id ?? null,
      seller_id: data.seller_id ?? null,
    };
  }

  /** GET /portal/image-compare/image-proxy?url= — free image proxy URL (no fetch performed). */
  imageProxyUrl(imageUrl) {
    if (!imageUrl) throw new PortalError('PORTAL_MISSING_INPUT', 'imageProxyUrl 需要图片 URL。');
    const normalized = String(imageUrl).startsWith('//') ? `https:${imageUrl}` : String(imageUrl);
    const url = new URL('/portal/image-compare/image-proxy', this.baseUrl);
    url.searchParams.set('url', normalized);
    return url.toString();
  }
}

/** Turn Laravel `props.errors` into one actionable line. */
function flattenValidation(errors) {
  if (!errors || typeof errors !== 'object') return '检查请求参数。';
  const parts = [];
  for (const [field, messages] of Object.entries(errors)) {
    const list = Array.isArray(messages) ? messages : [messages];
    parts.push(`${field}: ${list.filter(Boolean).join(' / ')}`);
  }
  return parts.length > 0 ? `修正参数后重试: ${parts.join('; ')}` : '检查请求参数。';
}
