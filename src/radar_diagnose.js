/**
 * `1688-ops provider-radar --diagnose` — diagnostic-first checks for the provider radar wheel.
 *
 * Everything here is read-only and secret-free:
 *   - never prints cookie values / tokens / secrets (only booleans, counts, file modes);
 *   - OneBound portal live quota check is opt-in (`--live`) and performs exactly one free GET;
 *   - the known-broken OneBound open-platform API (error 4003 IP block) is never called.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadScoringSpec, validateScoringSpec, RADAR_FILE_NAMES, resolveRadarDir } from './provider_radar.js';
import { PortalError, PortalSessionClient, loadSession, describeSession } from './portal_session.js';
import { resolveCredentials, createOpLookup } from './api_fallback.js';

function check(id, label, status, detail, actionable = null) {
  return { id, label, status, detail, actionable };
}

function fileStat(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return { path: filePath, bytes: stat.size, mode: (stat.mode & 0o777).toString(8).padStart(3, '0'), modified_at: stat.mtime.toISOString() };
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run all radar diagnostics.
 * @param {{radarDir?: string, live?: boolean, portalFetchImpl?: typeof fetch, skipCredentials?: boolean}} [options]
 */
export async function diagnoseProviderRadar(options = {}) {
  const radarDir = resolveRadarDir(options.radarDir);
  const checks = [];

  // 1. data directory
  const dirStat = fs.existsSync(radarDir) ? fs.statSync(radarDir) : null;
  checks.push(
    check(
      'radar_dir',
      'Provider Radar 数据目录',
      dirStat ? 'ok' : 'fail',
      dirStat ? radarDir : `目录不存在: ${radarDir}`,
      dirStat ? null : '用 --data-dir 指向 26.11.13 OneBound Provider Radar 目录。'
    )
  );

  // 2. scoring.json — canonical executable rubric
  const scoringPath = path.join(radarDir, RADAR_FILE_NAMES.scoring);
  const rawScoring = safeReadJson(scoringPath);
  let spec = null;
  let validation = null;
  if (!rawScoring) {
    checks.push(
      check('scoring', 'data/scoring.json 评分规则', 'fail', '缺失或 JSON 不可解析', '先把 spec-analyst 的可执行评分文件放回 data/scoring.json。')
    );
  } else {
    try {
      spec = loadScoringSpec(rawScoring);
      validation = validateScoringSpec(spec);
      checks.push(
        check(
          'scoring',
          'data/scoring.json 评分规则',
          validation.ok ? 'ok' : 'warn',
          `版本 ${spec.version} · ${spec.criteria.length} 准则 · ${spec.red_flags.length} 红线 · 权重和 ${validation.criterion_weights_sum} · ${
            validation.ok ? '权重/子权重校验通过' : '校验警告: ' + (validation.warnings.join('；') || 'unknown')
          }`,
          validation.ok ? null : '检查 criteria 权重与 metrics.local_weight 是否各为 1.0。'
        )
      );
    } catch (err) {
      checks.push(check('scoring', 'data/scoring.json 评分规则', 'fail', err.message, '修复 scoring.json 结构后重试。'));
    }
  }

  // 3. datasets
  const classifiedPath = path.join(radarDir, RADAR_FILE_NAMES.classified);
  const classified = safeReadJson(classifiedPath);
  const offers = classified?.offers || [];
  checks.push(
    check(
      'offers_classified',
      'data/offers_classified.json 供应商候选集',
      offers.length > 0 ? 'ok' : 'fail',
      offers.length > 0 ? `${offers.length} 条 offer（family/rideable 已分类）` : '缺失或无 offers[]',
      offers.length > 0 ? null : '该文件由市场扫描产出；缺失时无法构建供应商排名。'
    )
  );

  const marketItems = safeReadJson(path.join(radarDir, RADAR_FILE_NAMES.marketItems));
  checks.push(
    check(
      'market_items',
      'data/market_items.json 店铺/MOQ 字段',
      Array.isArray(marketItems) && marketItems.length > 0 ? 'ok' : 'warn',
      Array.isArray(marketItems) ? `${marketItems.length} 条（biz_type / 验厂 / P4P / MOQ）` : '缺失（E 供应商可靠性部分字段只能中性）'
    )
  );

  const providerDetails = safeReadJson(path.join(radarDir, RADAR_FILE_NAMES.providerDetails));
  const enriched = Array.isArray(providerDetails) ? providerDetails.filter((d) => d && d.attributes && Object.keys(d.attributes).length > 0) : [];
  checks.push(
    check(
      'provider_details',
      'data/provider_details.json 详情属性',
      enriched.length > 0 ? 'ok' : 'warn',
      Array.isArray(providerDetails)
        ? `${providerDetails.length} 条记录，${enriched.length} 条有真实详情属性（其余为 601 余额中断占位）`
        : '缺失 → 全部按“仅搜索行未知”评分',
      enriched.length > 0 ? null : '详情属性是 A/B/D 维度唯一硬证据；缺失时这些维度只能中性 50。'
    )
  );

  // 4. portal E2E receipt + quota ledger
  const portalPath = path.join(radarDir, RADAR_FILE_NAMES.portal);
  const portalStat = fileStat(portalPath);
  const portal = safeReadJson(portalPath);
  if (!portal) {
    checks.push(
      check('portal_receipt', 'data/portal_e2e.json OneBound 门户回执', 'warn', '缺失', '无门户回执时仍可只用 JustOneAPI 数据排名，但无法展示门户口径。')
    );
  } else {
    const quota = portal.quota_after || {};
    const receipts = portal.search_receipts || [];
    const exhausted = typeof quota.searchesRemaining === 'number' && quota.searchesRemaining <= 0;
    checks.push(
      check(
        'portal_receipt',
        'data/portal_e2e.json OneBound 门户回执',
        exhausted ? 'warn' : 'ok',
        `${receipts.length} 条比价回执 (request ${receipts.map((r) => r.request_id).join(', ')}) · 剩余搜索 ${quota.searchesRemaining ?? '未知'} · 方案 ${portal.membership?.label || portal.membership?.plan || '未知'}`,
        exhausted
          ? '免费额度已用尽（商品比价为 Pro 功能，2 次试用不重置）。POST 会返回 quota_exhausted；不要循环重试。可用替代：`1688-ops image-search`（浏览器登录态）或 JustOneAPI 以图搜款（约 ¥0.04/次，注意当前 601 余额不足）。'
          : null
      )
    );
    checks.push(
      check(
        'portal_contract',
        '门户 Inertia/API 契约',
        portal.contract ? 'ok' : 'warn',
        portal.contract ? `捕获于 ${portal.captured_at || '未知'} · base ${portal.endpoint_base || '未知'}` : '未记录契约'
      )
    );
  }
  if (portalStat) {
    checks.push(check('portal_receipt_file', '门户回执文件权限', (Number(portalStat.mode) & 0o077) === 0 ? 'ok' : 'warn', `${portalStat.mode} · ${portalStat.bytes} bytes`));
  }

  // 5. portal session file (cookies never printed)
  const sessionPath = path.join(radarDir, RADAR_FILE_NAMES.session);
  let session = null;
  try {
    session = loadSession(sessionPath);
    const description = describeSession(session, sessionPath);
    // Laravel session cookies (XSRF-TOKEN / -session) have Max-Age 7200s = 120 min.
    const capturedMs = description.captured_at ? Date.parse(description.captured_at) : NaN;
    const ageMinutes = Number.isFinite(capturedMs) ? Math.floor((Date.now() - capturedMs) / 60000) : null;
    const stale = ageMinutes !== null && ageMinutes > 110;
    checks.push(
      check(
        'portal_session',
        'OneBound 门户会话文件 (tmp/trend_session.json)',
        stale ? 'warn' : 'ok',
        `captured_at ${description.captured_at || '未知'}${
          ageMinutes !== null ? `（约 ${ageMinutes} 分钟前捕获，cookie Max-Age 7200s）` : ''
        } · cookie 数 ${description.cookie_count}（${description.cookie_names.join(', ')}）· inertia_version 存在 · UA 存在${
          stale ? ' — 会话很可能已过期' : ''
        }`,
        stale
          ? '刷新配方：由浏览器负责人重新捕获 trend.onebound.cn 登录态（cookies + user_agent + inertia_version）写入 tmp/trend_session.json 并 chmod 600，见 reports/portal_capability.md；本工具不自行登录。'
          : null
      )
    );
  } catch (err) {
    checks.push(
      check(
        'portal_session',
        'OneBound 门户会话文件 (tmp/trend_session.json)',
        err instanceof PortalError && err.code === 'PORTAL_SESSION_MISSING' ? 'warn' : 'fail',
        err.message,
        err.actionable || '由浏览器负责人重新捕获会话文件（0600）；本工具不自行登录。'
      )
    );
  }

  // 6. credentials presence only (never values)
  if (!options.skipCredentials) {
    // Bounded, cached 1Password probes: --diagnose must stay fast and never prompt.
    // We also record lookup failures so a dead unattended route is not misreported as "empty".
    const lookupErrors = [];
    const fastLookup =
      options.credentialLookup ||
      createOpLookup({
        timeoutMs: 3000,
        onError: (entry) => lookupErrors.push(entry),
      });
    const routeProblem = () =>
      lookupErrors.some((entry) => entry.timedOut)
        ? '1Password unattended 读取超时（本 CLI 进程无法完成 op 调用，属于路由问题，不是字段错误；请在能访问 1Password 的终端复核）'
        : lookupErrors.length > 0
          ? `1Password 读取失败 ${lookupErrors.length} 次（${lookupErrors.map((entry) => entry.code).join(',')}）`
          : null;

    try {
      const just = resolveCredentials('justoneapi', { lookup: fastLookup });
      checks.push(
        check(
          'justoneapi_credential',
          'JustOneAPI token 可解析',
          just.token ? 'ok' : 'warn',
          just.token
            ? 'token 已在内存中解析（值不打印），字段顺序 api_token → credential → token'
            : `未发现 JUSTONEAPI_TOKEN 环境变量，且 1Password 未返回 token。${routeProblem() || ''}`,
          just.token
            ? '注意：JustOneAPI 账户余额已耗尽（code 601），当前任何调用都会失败；需充值 ¥5+ 后再跑付费检索。这不是 token 问题。'
            : '检查 1Password「Agent Automation」Just One API · … · yanghxmail@gmail.com 的字段 api_token（label “API Token”；credential 为空）或设置 JUSTONEAPI_TOKEN。'
        )
      );
    } catch (err) {
      checks.push(check('justoneapi_credential', 'JustOneAPI token 可解析', 'warn', err.message));
    }
    try {
      const onebound = resolveCredentials('onebound', { lookup: fastLookup });
      const present = Boolean(onebound.key && onebound.secret);
      checks.push(
        check(
          'onebound_credential_mapping',
          'OneBound 开放平台凭据字段映射',
          'warn',
          present
            ? 'key/secret 已按 apiKey + credential 解析（item up3jwujwc4oho44jmnto4n6emu；值不打印）——但开放平台仍返回 4003 未授权/IP 记录，勿重试'
            : `key 或 secret 未解析（正确字段应为 apiKey + credential；username 只是登录名，绝不能当 API key）。${routeProblem() || ''}`,
          '4003 是账号/订单层封禁（不是凭据形状错误）：需向 OneBound 购买正版授权；当前改用 trend 门户会话或 JustOneAPI。'
        )
      );
    } catch (err) {
      checks.push(check('onebound_credential_mapping', 'OneBound 开放平台凭据字段映射', 'warn', err.message));
    }
  }

  // 7. optional live portal quota probe (exactly one free GET; never a paid search)
  if (options.live) {
    if (!session) {
      checks.push(check('portal_live_quota', '门户实时额度探测', 'fail', '无可用会话，跳过 live GET'));
    } else {
      try {
        const client = new PortalSessionClient({ session, sessionPath, fetchImpl: options.portalFetchImpl });
        const result = await client.quota();
        checks.push(
          check(
            'portal_live_quota',
            '门户实时额度探测 (1 次免费 GET)',
            result.exhausted ? 'warn' : 'ok',
            `searchesRemaining=${result.quota?.searchesRemaining ?? '未知'} · monitorsRemaining=${result.quota?.monitorsRemaining ?? '未知'} · isPro=${result.quota?.isPro ?? '未知'}${
              result.exhausted ? ' — 额度已用尽，POST 将返回 quota_exhausted' : ''
            }`,
            result.exhausted
              ? '不要再发起 POST 比价；用 `1688-ops image-search`（浏览器登录态）或升级 Pro 后以 query_mode=image 重试。'
              : '额度可用时可执行 POST /portal/image-compare（每次消耗 1 次搜索额度）。'
          )
        );
      } catch (err) {
        const isPortal = err instanceof PortalError;
        checks.push(
          check(
            'portal_live_quota',
            '门户实时额度探测 (1 次免费 GET)',
            'fail',
            `${isPortal ? err.code : 'ERROR'}: ${err.message}`,
            isPortal ? err.actionable : '检查网络与代理。'
          )
        );
      }
    }
  }

  const fails = checks.filter((entry) => entry.status === 'fail').length;
  const warns = checks.filter((entry) => entry.status === 'warn').length;
  return {
    tool: '1688-ops provider-radar --diagnose',
    generated_at: new Date().toISOString(),
    radar_dir: radarDir,
    scoring_version: spec?.version || null,
    scoring_validation: validation,
    checks,
    summary: { ok: fails === 0, fail: fails, warn: warns, pass: checks.filter((c) => c.status === 'ok').length },
  };
}

/** Human-readable diagnose report (secret-free). */
export function formatDiagnoseReport(report) {
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  const lines = [
    '════════ Provider Radar 诊断 (diagnostic-first) ════════',
    `数据目录: ${report.radar_dir}`,
    `评分规则版本: ${report.scoring_version || '缺失'} · 时间: ${report.generated_at}`,
    '',
  ];
  for (const entry of report.checks) {
    lines.push(`${icon[entry.status] || '·'} ${entry.label}`);
    lines.push(`   ${entry.detail}`);
    if (entry.actionable) lines.push(`   → ${entry.actionable}`);
  }
  lines.push('');
  lines.push(
    `汇总: ${report.summary.pass} 通过 / ${report.summary.warn} 警告 / ${report.summary.fail} 失败 — ${
      report.summary.ok ? '核心依赖就绪，可执行 provider-radar。' : '存在失败项，先按 → 指引修复。'
    }`
  );
  lines.push('提示: 以上不包含任何 cookie/token 值；--live 只做 1 次免费额度 GET，不消耗比价次数。');
  lines.push('═══════════════════════════════════════════════════════');
  return lines.join('\n');
}
