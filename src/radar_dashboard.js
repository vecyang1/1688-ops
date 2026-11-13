/**
 * Provider Radar — self-contained HTML observability dashboard.
 *
 * - one self-contained HTML file: NO CDN, no external CSS/JS, no fetch();
 * - ranked provider cards per family with score breakdown, price/sales/return-rate,
 *   safety flags, seed product, platform/source, evidence links;
 * - quota ledger + provenance panel (scoring.json validation, data files, request ids);
 * - explicit "未知 / 无数据" state — never renders an invented value;
 * - desktop + mobile readable.
 */

const TIER_CLASS = {
  A: 'tier-a',
  B: 'tier-b',
  C: 'tier-c',
  AVOID: 'tier-avoid',
  UNRANKABLE: 'tier-unrank',
};

const CRITERION_CN = { A: '性能', B: '续航', C: '价格', D: '安全', E: '供应商' };
const ROLE_LABEL = { primary: '主家族排名', secondary: '替代家族（相邻品类参考）', other: '其他家族（参考）' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeUrl(url) {
  if (!url) return null;
  const text = String(url).trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

function fmtNumber(value, digits = 0) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return digits > 0 ? num.toFixed(digits) : String(Math.round(num));
}

export function valueOrUnknown(value, { suffix = '', digits = 0, unknownText = '未知' } = {}) {
  const formatted = fmtNumber(value, digits);
  if (formatted === null) return `<span class="unknown" title="无数据：未知不作好">${escapeHtml(unknownText)}</span>`;
  return `<strong>${escapeHtml(formatted)}${escapeHtml(suffix)}</strong>`;
}

function formatDateTime(iso) {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(String(iso));
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

function knownLabel(knownRatio) {
  const pct = Math.round((knownRatio ?? 0) * 100);
  const cls = pct >= 60 ? 'known-high' : pct > 0 ? 'known-mid' : 'known-low';
  return `<span class="known ${cls}">已知参数覆盖 ${pct}%</span>`;
}

function criteriaGrid(item) {
  const rows = (item.criteria || [])
    .map((criterion) => {
      const letter = criterion.letter || String(criterion.id).split('_')[0];
      const label = criterion.name_zh || CRITERION_CN[letter] || criterion.id;
      const score = Math.max(0, Math.min(100, criterion.score ?? 0));
      return `
      <div class="criterion" data-criterion="${escapeHtml(criterion.id)}">
        <div class="criterion-head">
          <span class="criterion-name"><b>${escapeHtml(letter)}</b> · ${escapeHtml(label)}</span>
          <span class="criterion-score">${score.toFixed(1)}<small>/100</small></span>
        </div>
        <div class="bar" role="img" aria-label="${escapeHtml(label)} 得分 ${score.toFixed(1)} / 100">
          <div class="bar-fill" style="width:${score.toFixed(1)}%"></div>
        </div>
        <div class="criterion-meta">
          <span>权重 ${((criterion.weight ?? 0) * 100).toFixed(0)}%</span>
          ${knownLabel(criterion.known_ratio)}
        </div>
      </div>`;
    })
    .join('');
  return `<div class="criteria-grid">${rows}</div>`;
}

function metricDetails(item) {
  const rows = (item.criteria || []).flatMap((criterion) =>
    (criterion.metrics || []).map((metric) => {
      const known = metric.known
        ? '<span class="tag tag-known">已知</span>'
        : '<span class="tag tag-unknown">未知 → 中性</span>';
      return `<tr>
        <td>${escapeHtml(criterion.letter || criterion.id)}</td>
        <td>${escapeHtml(metric.name_zh || metric.id)}</td>
        <td class="num">${Number(metric.score ?? 50).toFixed(1)}</td>
        <td class="num">${((metric.local_weight ?? 0) * 100).toFixed(0)}%</td>
        <td>${known}</td>
        <td class="reason">${escapeHtml(metric.evidence || '')}</td>
      </tr>`;
    })
  );
  if (rows.length === 0) return '';
  return `<details class="metric-details">
      <summary>评分明细（逐指标，可复算）</summary>
      <table class="metric-table">
        <thead><tr><th>准则</th><th>指标</th><th>得分</th><th>子权重</th><th>数据状态</th><th>推导依据</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </details>`;
}

function redFlagList(item) {
  const flags = item.red_flags || [];
  if (flags.length === 0) {
    return '<p class="flag-none">未触发红线。<b>未触发 ≠ 已证实安全</b>：未知项仍需人工核验证书编号与电池文件。</p>';
  }
  return `<ul class="flag-list">${flags
    .map(
      (flag) => `<li class="flag">
        <span class="flag-id">${escapeHtml(flag.id)}</span>
        <span class="flag-label">${escapeHtml(flag.name_zh || '')}</span>
        <span class="flag-penalty">−${escapeHtml(flag.penalty)}</span>
        ${flag.cap_tier ? `<span class="flag-cap">封顶 ${escapeHtml(flag.cap_tier)}</span>` : ''}
        <div class="flag-evidence">${escapeHtml(flag.reason_zh || '')}</div>
      </li>`
    )
    .join('')}</ul>`;
}

function evidenceLinks(item) {
  const links = [];
  const productUrl = safeUrl(item.url);
  if (productUrl) links.push({ href: productUrl, label: '商品详情页' });
  for (const evidence of item.evidence || []) {
    const href = safeUrl(evidence.url);
    if (!href || links.some((link) => link.href === href)) continue;
    const label =
      evidence.kind === 'portal-result-row'
        ? `OneBound 门户比价行 request#${evidence.request_id ?? '?'}`
        : evidence.kind === 'detail-page'
          ? '1688 详情属性'
          : `JustOneAPI 检索行${evidence.keyword ? `「${evidence.keyword}」` : ''}`;
    links.push({ href, label });
  }
  if (item.image_url && safeUrl(item.image_url)) {
    links.push({ href: item.image_url, label: '主图' });
  }
  if (links.length === 0) return '<span class="unknown">无可用证据链接</span>';
  return links
    .map((link) => `<a class="evidence-link" href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a>`)
    .join('');
}

function fieldChips(item) {
  const fields = item.fields || {};
  const chips = [
    ['车速', fields.top_speed_kmh, ' km/h'],
    ['续航(宣称)', fields.claimed_range_km, ' km'],
    ['有效续航', fields.effective_range_km, ' km'],
    ['电池', fields.battery_wh, ' Wh'],
    ['电压', fields.battery_v, ' V'],
    ['载重', fields.max_load_kg, ' kg'],
    ['轮径', fields.wheel_in, ' 英寸'],
    ['制动', fields.brake_type, ''],
    ['认证', fields.cert_best_tier, ''],
    ['电芯', fields.cell_tier, ''],
    ['防护', fields.ip_rating, ''],
    ['年龄定位', fields.age_target, ''],
    ['规格字段', fields.spec_field_count, '/8'],
    ['店铺年限', fields.shop_years, ' 年'],
    ['经营模式', fields.biz_type, ''],
    ['起订量', fields.moq, ' 件'],
  ];
  const shown = chips
    .map(([label, value, suffix]) => {
      const formatted = fmtNumber(value, 0);
      if (formatted === null) return `<span class="chip chip-unknown"><i>${escapeHtml(label)}</i> 未知</span>`;
      return `<span class="chip" title="${escapeHtml(label)}"><i>${escapeHtml(label)}</i> ${escapeHtml(formatted)}${escapeHtml(suffix)}</span>`;
    })
    .join('');
  const ad = fields.is_ad === true ? '<span class="chip chip-warn"><i>付费推广位</i> P4P</span>' : '';
  return `<div class="chips">${shown}${ad}</div>`;
}

function detailAttributes(item) {
  const attributes = item.detail_attributes;
  if (!attributes || Object.keys(attributes).length === 0) {
    return '<p class="small unknown">该供应商未读取详情页属性（JustOneAPI 余额 601 中断 / 仅搜索行）。未知不作好。</p>';
  }
  const rows = Object.entries(attributes)
    .filter(([, value]) => value !== null && String(value).trim() !== '')
    .slice(0, 14)
    .map(([key, value]) => {
      const text = String(value);
      return `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(text.length > 180 ? `${text.slice(0, 180)}…` : text)}</td></tr>`;
    })
    .join('');
  return `<details class="detail-attrs"><summary>1688 详情属性（${escapeHtml(Object.keys(attributes).length)} 项，店家声明原文）</summary>
    <table class="kv-table"><tbody>${rows}</tbody></table>
    <p class="small">证书真伪需在 UL Product iQ / CQC / NSW 登记库复核；“外贸出口认证=无”是明确否定证据（→ 认证 E 级），不是未知。</p>
  </details>`;
}

function providerCard(item) {
  const tierClass = TIER_CLASS[item.tier] || 'tier-unrank';
  const shopLabel = item.shop_masked ? '加密店铺标识（门户已脱敏）' : item.shop || '店铺名未知';
  const image = safeUrl(item.image_url);
  const priceRange =
    item.price_min !== null && item.price_min !== undefined
      ? item.price_max && item.price_max !== item.price_min
        ? `¥${fmtNumber(item.price_min)} – ¥${fmtNumber(item.price_max)}`
        : `¥${fmtNumber(item.price_min)}`
      : null;
  const sources = (item.sources || []).map((source) => `<span class="tag tag-source">${escapeHtml(source)}</span>`).join('');
  const gaps = (item.data_gaps || []).map((gap) => `<li>${escapeHtml(gap)}</li>`).join('');
  const listingCandidates = (item.listing_candidates || [])
    .slice(0, 6)
    .map((candidate) => {
      const url = safeUrl(candidate.url);
      return `<tr>
        <td class="num">${escapeHtml(candidate.offer_id || '')}</td>
        <td class="title-cell">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(candidate.title || '')}</a>` : escapeHtml(candidate.title || '')}</td>
        <td>${valueOrUnknown(candidate.price_cny, { suffix: ' 元' })}</td>
        <td>${valueOrUnknown(candidate.sales, { suffix: ' 件' })}</td>
        <td>${valueOrUnknown(candidate.rr_percent, { suffix: '%', digits: 1 })}</td>
        <td class="num">${escapeHtml(candidate.score ?? '')}</td>
        <td>${escapeHtml(candidate.tier || '')}</td>
      </tr>`;
    })
    .join('');

  return `
  <article class="card ${tierClass}" data-tier="${escapeHtml(item.tier)}" data-shop="${escapeHtml(shopLabel)}">
    <header class="card-head">
      <div class="rank-badge">#${escapeHtml(item.overall_rank)}</div>
      ${image ? `<img class="thumb" src="${escapeHtml(image)}" alt="${escapeHtml(item.title || '商品图')}" loading="lazy" referrerpolicy="no-referrer">` : '<div class="thumb thumb-empty">无图</div>'}
      <div class="card-title">
        <h3>${escapeHtml(shopLabel)}</h3>
        <p class="listing-title" title="${escapeHtml(item.title || '')}">${escapeHtml(item.title || '标题未知')}</p>
        <div class="tags">
          <span class="tag tag-family">${escapeHtml(item.family_label || item.family)} · 家族第 ${escapeHtml(item.family_rank)}</span>
          <span class="tag tag-platform">${escapeHtml(item.platform || '平台未知')}</span>
          ${item.detail_enriched ? '<span class="tag tag-detail">详情页已读</span>' : '<span class="tag tag-adjacent">仅搜索行</span>'}
          ${item.joined_with ? '<span class="tag tag-joined">门户比价行 + JustOneAPI 已合并</span>' : ''}
          ${sources}
        </div>
      </div>
      <div class="score-badge">
        <span class="score-value">${escapeHtml(item.final_score)}</span>
        <span class="score-unit">/100</span>
        <span class="tier-pill ${tierClass}">${escapeHtml(item.tier)} · ${escapeHtml(item.tier_label || '')}</span>
        <span class="tier-label">${escapeHtml(item.tier_label_en || '')}</span>
      </div>
    </header>

    <div class="metrics-strip">
      <div class="metric"><span class="metric-label">报价</span>${valueOrUnknown(item.price_cny, { suffix: ' 元' })}</div>
      <div class="metric"><span class="metric-label">已售</span>${valueOrUnknown(item.sales, { suffix: ' 件' })}</div>
      <div class="metric"><span class="metric-label">回头率</span>${valueOrUnknown(item.rr_percent, { suffix: '%', digits: 1 })}</div>
      <div class="metric"><span class="metric-label">省份</span>${item.province ? `<strong>${escapeHtml(item.province)}</strong>` : '<span class="unknown">未知</span>'}</div>
      <div class="metric"><span class="metric-label">在售款数</span>${valueOrUnknown(item.offer_count, { suffix: ' 款' })}</div>
      <div class="metric"><span class="metric-label">置信度</span>${valueOrUnknown((item.confidence ?? 0) * 100, { suffix: '%' })}</div>
    </div>

    <div class="card-body">
      <section class="panel">
        <h4>评分构成 <small>加权 ${escapeHtml(item.weighted_score)} − 红线罚分 ${escapeHtml(item.penalty_total)} = ${escapeHtml(item.final_score)}</small></h4>
        ${criteriaGrid(item)}
        <p class="tier-reason">判定依据：${escapeHtml(item.tier_reason || '')}</p>
        ${metricDetails(item)}
      </section>

      <section class="panel">
        <h4>安全与红线</h4>
        <p class="safety-line">安全分 D：${item.safety_score === null || item.safety_score === undefined ? '<span class="unknown">未知</span>' : `<strong>${escapeHtml(item.safety_score)}</strong>/100`} · 置信度 ${escapeHtml(item.confidence)}</p>
        ${redFlagList(item)}
        <h5>观测到的规格字段</h5>
        ${fieldChips(item)}
        <h5>数据缺口（未知项不会当好数据）</h5>
        ${gaps ? `<ul class="gaps">${gaps}</ul>` : '<p class="small">主要字段均有观测值。</p>'}
        ${detailAttributes(item)}
      </section>
    </div>

    <footer class="card-foot">
      <div class="foot-row">
        <span class="foot-label">证据</span>
        <div class="links">${evidenceLinks(item)}</div>
      </div>
      <div class="foot-row">
        <span class="foot-label">价格带</span>
        <span>${priceRange ? escapeHtml(priceRange) : '<span class="unknown">未知</span>'}
        · 价格口径 ${escapeHtml(item.price_basis || 'unknown')}${
          item.price_search_cny && item.price_detail_cny && item.price_search_cny !== item.price_detail_cny
            ? `（搜索行 ¥${escapeHtml(item.price_search_cny)} / 详情 ¥${escapeHtml(item.price_detail_cny)}）`
            : ''
        }</span>
      </div>
      ${
        listingCandidates
          ? `<details class="listing-details"><summary>本店 ${escapeHtml(item.offer_count)} 款候选明细</summary>
              <table class="table table-compact">
                <thead><tr><th class="num">offer</th><th>标题</th><th>报价</th><th>已售</th><th>回头率</th><th class="num">得分</th><th>档</th></tr></thead>
                <tbody>${listingCandidates}</tbody>
              </table>
            </details>`
          : ''
      }
    </footer>
  </article>`;
}

/**
 * Headline cross-family comparison strip (Lead request): the human asked for "the best provider",
 * and the primary family may contain only AVOID candidates. Show the best provider per family —
 * clearly labelled "参考，不参与排名" because scores are only comparable within one family.
 */
function crossFamilyStrip(result) {
  const groups = (result.family_groups || []).filter((group) => (group.providers || []).length > 0);
  if (groups.length === 0) return '';
  const entries = groups.slice(0, 5).map((group) => {
    const nonAvoid = group.providers.find((item) => item.tier !== 'AVOID' && item.tier !== 'UNRANKABLE');
    const best = nonAvoid || group.providers[0];
    return { group, best, hasNonAvoid: Boolean(nonAvoid) };
  });
  const items = entries
    .map(({ group, best, hasNonAvoid }) => {
      const tierClass = TIER_CLASS[best.tier] || 'tier-unrank';
      return `<div class="xfam-item ${group.role === 'primary' ? 'xfam-primary' : ''}">
        <div class="xfam-fam">${escapeHtml(group.label_zh)} <span class="xfam-role">${escapeHtml(
          group.role === 'primary' ? '主家族' : group.role === 'secondary' ? '替代' : '其他'
        )}</span></div>
        <div class="xfam-shop">${escapeHtml(best.shop || (best.shop_masked ? '加密店铺' : '店铺未知'))}</div>
        <div class="xfam-score">
          <span class="xfam-num">${escapeHtml(best.final_score)}</span><small>/100</small>
          <span class="tier-pill ${tierClass} xfam-tier">${escapeHtml(best.tier)} · ${escapeHtml(best.tier_label || '')}</span>
        </div>
        <div class="xfam-note">${hasNonAvoid ? '本家族最高且非 AVOID' : '本家族无 A/B/C 档，显示最高分（仍 AVOID）'}</div>
      </div>`;
    })
    .join('');
  return `<section class="section xfam">
      <h2>跨家族对照（仅参考，不参与排名）</h2>
      <p class="method">你问的是“最好的供应商”。主家族若全是 AVOID，这里同时给出其他家族的最佳候选，<b>但分数只能在同家族内比较</b>（scoring_mode=per_offer_family），不要跨家族直接比大小。</p>
      <div class="xfam-grid">${items}</div>
      <p class="small">读法：先看主家族档位与红线；“替代家族”只回答“如果换品类还有什么更可行的选择”。主家族 ${escapeHtml(
        result.product?.confirmed_family || ''
      )} 的家族中位价 ${valueOrUnknown(result.product?.families?.find((f) => f.family === result.product?.confirmed_family)?.median_price_cny, { suffix: ' 元' })}。</p>
    </section>`;
}

function familySection(group) {
  const cards = (group.providers || []).map((item) => providerCard(item)).join('');
  const roleLabel = ROLE_LABEL[group.role] || '家族排名';
  const roleNote =
    group.role === 'primary'
      ? '评分规则确认的主家族（product.confirmed_family）'
      : group.role === 'secondary'
        ? '评分规则 fallback_family_order 内的替代解读，分数可参考但不能与主家族直接比较'
        : '扫描中出现、但不在主/替代家族顺序里的家族';
  return `
  <section class="family-block" data-family="${escapeHtml(group.family)}" data-role="${escapeHtml(group.role)}">
    <div class="section-fam">
      <h2>${escapeHtml(roleLabel)} · ${escapeHtml(group.label_zh)}</h2>
      <span class="sub">${escapeHtml(group.role === 'primary' ? '当前主结论家族' : '参考')}｜${escapeHtml(group.providers.length)} 家可排名供应商｜家族内分数可比</span>
    </div>
    <p class="small family-note">${escapeHtml(roleNote)} · 去水系数 ${escapeHtml(group.range_derate_factor)} · 可信速度上限 ${escapeHtml(group.plausible_max_speed_kmh)} km/h</p>
    ${cards ? `<div class="cards">${cards}</div>` : '<div class="empty-state">该家族没有可排名供应商。未知/无数据时本工具不会编造分数。</div>'}
  </section>`;
}

function unrankableSection(result) {
  const summary = result.unrankable?.summary || [];
  const sample = result.unrankable?.sample || [];
  if (summary.length === 0) return '';
  const summaryRows = summary
    .map(
      (entry) => `<tr>
        <td><code>${escapeHtml(entry.code)}</code></td>
        <td>${escapeHtml(entry.reason)}</td>
        <td class="num">${escapeHtml(entry.listings)}</td>
        <td class="num">${escapeHtml(entry.providers)}</td>
      </tr>`
    )
    .join('');
  const sampleRows = sample
    .slice(0, 14)
    .map((item) => {
      const url = safeUrl(item.url);
      return `<tr>
        <td>${escapeHtml(item.shop || (item.shop_masked ? '加密店铺' : '未知'))}</td>
        <td class="title-cell">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(item.title || '')}</a>` : escapeHtml(item.title || '')}</td>
        <td>${escapeHtml(item.family || item.dataset_family || '')}</td>
        <td>${valueOrUnknown(item.price_cny, { suffix: ' 元' })}</td>
        <td><code>${escapeHtml(item.code)}</code></td>
      </tr>`;
    })
    .join('');
  return `
  <details class="section details-unrankable">
    <summary><span class="section-title">未参与排名的条目</span>
      <span class="section-sub">${summary.reduce((sum, entry) => sum + entry.listings, 0)} 条 / ${summary.reduce((sum, entry) => sum + entry.providers, 0)} 家供应商 · 点开查看原因</span>
    </summary>
    <p class="small">这些条目不是“差”，而是类目错配：配件、儿童玩具、人力漂移板或无关噪音不参与“成人可骑乘电子漂移板”排名（scoring.json toy_vs_family_disambiguation）。</p>
    <table class="table">
      <thead><tr><th>排除代码</th><th>原因</th><th class="num">条目数</th><th class="num">供应商数</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
    <h4>样本（前 ${sample.length} 条）</h4>
    <table class="table table-compact">
      <thead><tr><th>店铺</th><th>标题</th><th>家族</th><th>报价</th><th>代码</th></tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>
  </details>`;
}

function provenancePanel(result) {
  const scoring = result.scoring || {};
  const validation = scoring.validation || {};
  const files = result.provenance?.files || [];
  const notes = result.provenance?.notes || [];
  const quota = result.quota_ledger || {};
  const fileRows =
    files.length === 0
      ? '<tr><td colspan="4" class="unknown">未记录来源文件（fixture 渲染）</td></tr>'
      : files
          .map(
            (file) => `<tr>
              <td><code>${escapeHtml(file.role || '')}</code></td>
              <td class="path">${escapeHtml(file.path || '')}</td>
              <td class="num">${file.bytes ? escapeHtml((file.bytes / 1024).toFixed(1)) : '-'} KB</td>
              <td><code>${escapeHtml(file.sha256_12 || '')}</code></td>
            </tr>`
          )
          .join('');
  const criteriaRows = (scoring.criteria || [])
    .map(
      (criterion) => `<tr>
        <td><b>${escapeHtml(criterion.letter || '')}</b> ${escapeHtml(criterion.name_zh || criterion.id)}</td>
        <td class="num">${((criterion.weight ?? 0) * 100).toFixed(0)}%</td>
        <td class="num">${escapeHtml((criterion.metrics || []).length)}</td>
        <td>${escapeHtml((criterion.metrics || []).map((m) => m.id).join(', '))}</td>
      </tr>`
    )
    .join('');
  const redFlags = (scoring.red_flags || [])
    .map(
      (flag) =>
        `<li><code>${escapeHtml(flag.id)}</code> ${escapeHtml(flag.name_zh || '')} — −${escapeHtml(flag.penalty)}${
          flag.cap_tier ? `，封顶 ${escapeHtml(flag.cap_tier)}` : ''
        }</li>`
    )
    .join('');
  const receipts = (quota.receipts || [])
    .map(
      (receipt) => `<tr>
        <td class="num">${escapeHtml(receipt.request_id ?? '?')}</td>
        <td class="path">${escapeHtml(receipt.seed || '')}</td>
        <td>${escapeHtml(receipt.mode || '-')}</td>
        <td>${escapeHtml(receipt.platform_scope || '-')}</td>
        <td>${escapeHtml(receipt.status || '-')}</td>
        <td class="num">${escapeHtml(receipt.results_total ?? '-')}</td>
        <td class="num">${escapeHtml(receipt.quota_after?.searchesRemaining ?? '-')}</td>
      </tr>`
    )
    .join('');
  const families = (result.product?.families || [])
    .map(
      (family) => `<tr>
        <td>${escapeHtml(family.label_zh || family.family)}</td>
        <td><code>${escapeHtml(family.family)}</code></td>
        <td class="num">${escapeHtml(family.scan_offers)}</td>
        <td>${family.median_price_cny === null ? '<span class="unknown">未知</span>' : `¥${escapeHtml(family.median_price_cny)}`}</td>
        <td>${escapeHtml(family.median_price_basis)}</td>
        <td class="num">${escapeHtml(family.ranked_providers)}</td>
      </tr>`
    )
    .join('');

  return `
  <details class="section details-provenance" open>
    <summary><span class="section-title">溯源面板 (provenance)</span>
      <span class="section-sub">数据从哪来、额度花了多少、评分规则是哪一版、每个分数怎么复算</span></summary>
    <div class="provenance-grid">
      <div class="prov-block">
        <h4>评分规则 data/scoring.json</h4>
        <p>版本 <code>${escapeHtml(scoring.version || 'unknown')}</code> · schema <code>${escapeHtml(scoring.schema_version || '-')}</code>
          · 总权重和 <b>${escapeHtml(validation.criterion_weights_sum ?? '?')}</b>
          · ${validation.ok ? '<span class="tag tag-ok">权重/子权重校验通过</span>' : '<span class="tag tag-warn">校验异常</span>'}
          · 红线 ${escapeHtml((scoring.red_flags || []).length)} 条</p>
        <table class="table table-compact">
          <thead><tr><th>准则</th><th class="num">权重</th><th class="num">指标数</th><th>指标</th></tr></thead>
          <tbody>${criteriaRows}</tbody>
        </table>
        ${
          (validation.warnings || []).length > 0
            ? `<p class="small warn">校验警告：${escapeHtml((validation.warnings || []).join('；'))}</p>`
            : ''
        }
      </div>
      <div class="prov-block">
        <h4>输入数据文件</h4>
        <table class="table table-compact">
          <thead><tr><th>角色</th><th>路径</th><th class="num">大小</th><th>sha256</th></tr></thead>
          <tbody>${fileRows}</tbody>
        </table>
        <p class="small">${escapeHtml(result.provenance?.provider_detail_note || '')}</p>
        ${notes.length > 0 ? `<ul class="notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="prov-block">
        <h4>门户比价额度台账 (quota ledger)</h4>
        ${
          quota.available
            ? `<p>方案 <strong>${escapeHtml(quota.plan_label || quota.plan || '未知')}</strong>
                · 剩余搜索 ${valueOrUnknown(quota.searches_remaining, { suffix: ' 次' })}
                · 剩余监控 ${valueOrUnknown(quota.monitors_remaining, { suffix: ' 个' })}
                ${quota.exhausted ? '<span class="tag tag-warn">免费额度已用尽</span>' : ''}</p>
               <p class="small">${escapeHtml(quota.free_tier_note || '')}</p>`
            : `<p class="unknown">${escapeHtml(quota.note || '未提供门户额度回执')}</p>`
        }
        ${
          receipts
            ? `<table class="table table-compact">
                 <thead><tr><th>request</th><th>seed</th><th>模式</th><th>范围</th><th>状态</th><th class="num">命中</th><th class="num">额度后</th></tr></thead>
                 <tbody>${receipts}</tbody>
               </table>`
            : ''
        }
        <h5>16 条红线（触发即罚分/封顶）</h5>
        <ul class="notes redflags">${redFlags}</ul>
      </div>
    </div>
    <div class="prov-block">
      <h4>家族与市场基准（来自本次扫描）</h4>
      <table class="table table-compact">
        <thead><tr><th>家族</th><th>id</th><th class="num">扫描 offer</th><th>家族中位价</th><th>中位价口径</th><th class="num">可排名供应商</th></tr></thead>
        <tbody>${families}</tbody>
      </table>
    </div>
  </details>`;
}

const CSS = `
:root{
  --bg:#0f1115; --panel:#161a21; --panel-2:#1c222b; --border:#2a323f;
  --text:#e8edf4; --muted:#aab6c6; --dim:#94a3b8;
  --accent:#5b9dff; --accent-2:#8b7bff;
  --ok:#3ecf8e; --warn:#f5b942; --bad:#ff6b6b; --neutral:#7c8899;
  --a:#3ecf8e; --b:#5b9dff; --c:#f5b942; --avoid:#ff6b6b; --unrank:#7c8899;
  --radius:14px; --shadow:0 8px 28px rgba(0,0,0,.35);
}
@media (prefers-color-scheme: light){
  :root{ --bg:#f4f6fa; --panel:#ffffff; --panel-2:#f0f3f8; --border:#dfe5ee; --text:#1b2330; --muted:#5a677a; --dim:#8a95a5; --shadow:0 8px 24px rgba(20,30,60,.08); }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;padding:24px 16px 64px}
.wrap{max-width:1180px;margin:0 auto}
h1,h2,h3,h4,h5{margin:0 0 .4em;line-height:1.25}
h1{font-size:clamp(22px,3.2vw,32px);letter-spacing:.2px}
h2{font-size:clamp(18px,2.4vw,24px)}
h3{font-size:17px}
h4{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
h5{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-top:14px}
small{font-size:12px;color:var(--muted);font-weight:400}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:1px 5px}
.unknown{color:var(--warn);font-style:italic;font-size:13px}
.hero{background:linear-gradient(135deg,rgba(91,157,255,.14),rgba(139,123,255,.10));border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;margin-bottom:18px}
.hero-top{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;align-items:flex-start}
.seed-box{flex:1 1 320px;min-width:260px}
.seed-title{font-size:16px;font-weight:600;margin:6px 0}
.pill-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.pill{background:var(--panel-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:12.5px;color:var(--muted)}
.pill b{color:var(--text)}
.unknown-pill{color:var(--warn);border-color:rgba(245,185,66,.4)}
.runmeta{font-size:13px;color:var(--muted);margin-top:8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.kpi .label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.kpi .value{font-size:22px;font-weight:700;margin-top:4px}
.kpi .sub{font-size:12px;color:var(--dim);margin-top:2px}
.section{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);margin:16px 0;padding:18px 20px}
details.section>summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
details.section>summary::-webkit-details-marker{display:none}
details.section>summary::before{content:"▸";color:var(--muted);margin-right:6px;transition:transform .15s}
details.section[open]>summary::before{transform:rotate(90deg)}
.section-title{font-size:18px;font-weight:700}
.section-sub{font-size:13px;color:var(--muted)}
.section-fam{margin:26px 0 8px;display:flex;flex-wrap:wrap;gap:10px;align-items:baseline}
.section-fam h2{margin:0}
.section-fam .sub{color:var(--muted);font-size:13px}
.family-note{margin:0 0 12px}
.cards{display:grid;gap:16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;border-top:3px solid var(--neutral)}
.card.tier-a{border-top-color:var(--a)}
.card.tier-b{border-top-color:var(--b)}
.card.tier-c{border-top-color:var(--c)}
.card.tier-avoid{border-top-color:var(--avoid)}
.card.tier-unrank{border-top-color:var(--unrank)}
.card-head{display:grid;grid-template-columns:44px 84px minmax(0,1fr) auto;gap:14px;align-items:start;padding:16px 18px;background:var(--panel-2)}
.rank-badge{font-size:20px;font-weight:800;color:var(--muted);padding-top:6px}
.thumb{width:84px;height:84px;object-fit:cover;border-radius:10px;border:1px solid var(--border);background:var(--panel)}
.thumb-empty{display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px}
.card-title{min-width:0}
.card-title h3{margin:0 0 2px;font-size:17px;word-break:break-word}
.listing-title{margin:0;color:var(--muted);font-size:13px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.tag{font-size:11.5px;border-radius:999px;padding:2px 8px;border:1px solid var(--border);background:var(--panel);color:var(--muted);white-space:nowrap}
.tag-family{border-color:rgba(91,157,255,.45);color:var(--accent)}
.tag-platform{border-color:rgba(139,123,255,.45);color:var(--accent-2)}
.tag-joined{border-color:rgba(62,207,142,.45);color:var(--ok)}
.tag-detail{border-color:rgba(62,207,142,.45);color:var(--ok)}
.tag-adjacent{border-color:rgba(245,185,66,.45);color:var(--warn)}
.tag-warn{border-color:rgba(245,185,66,.5);color:var(--warn)}
.tag-ok{border-color:rgba(62,207,142,.5);color:var(--ok)}
.tag-known{color:var(--ok);border-color:rgba(62,207,142,.4)}
.tag-unknown{color:var(--warn);border-color:rgba(245,185,66,.4)}
.score-badge{text-align:right;min-width:116px;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:baseline;gap:4px}
.score-value{font-size:30px;font-weight:800;letter-spacing:-.02em}
.score-unit{color:var(--muted);font-size:12px}
.tier-pill{display:inline-block;width:100%;text-align:center;border-radius:8px;padding:3px 8px;font-weight:700;font-size:13px;margin-top:4px;background:var(--panel);border:1px solid var(--border)}
.tier-pill.tier-a{color:var(--a);border-color:var(--a)}
.tier-pill.tier-b{color:var(--b);border-color:var(--b)}
.tier-pill.tier-c{color:var(--c);border-color:var(--c)}
.tier-pill.tier-avoid{color:var(--avoid);border-color:var(--avoid)}
.tier-pill.tier-unrank{color:var(--unrank);border-color:var(--unrank)}
.tier-label{width:100%;text-align:right;font-size:11.5px;color:var(--muted)}
.metrics-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:1px;background:var(--border)}
.metrics-strip .metric{background:var(--panel);padding:10px 14px;display:flex;flex-direction:column;gap:2px;font-size:14px}
.metric-label{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.card-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:18px;padding:18px}
.panel{min-width:0}
.criteria-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 16px}
.criterion-head{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}
.criterion-name{color:var(--muted)}
.criterion-score{font-variant-numeric:tabular-nums;font-weight:700}
.criterion-score small{font-weight:400}
.bar{height:7px;background:var(--panel-2);border:1px solid var(--border);border-radius:999px;overflow:hidden;margin:5px 0}
.bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.criterion-meta{display:flex;justify-content:space-between;font-size:11px;color:var(--dim)}
.known-high{color:var(--ok)}
.known-mid{color:var(--warn)}
.known-low{color:var(--dim)}
.tier-reason{font-size:12.5px;color:var(--muted);margin:12px 0 0}
.metric-details{margin-top:10px;border-top:1px dashed var(--border);padding-top:10px}
.metric-details summary{cursor:pointer;font-size:12.5px;color:var(--accent)}
.metric-table,.table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
.table-scroll{width:100%;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
.table-scroll>table{margin-top:8px}
.metric-table th,.metric-table td,.table th,.table td{border-bottom:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}
.metric-table th,.table th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
.metric-table .num,.table .num{text-align:right;font-variant-numeric:tabular-nums}
.metric-table .reason{color:var(--dim)}
.safety-line{font-size:14px;margin:.2em 0 .8em}
.flag-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.flag{background:rgba(255,107,107,.07);border:1px solid rgba(255,107,107,.3);border-radius:10px;padding:8px 10px;font-size:13px}
.flag-id{font-weight:800;color:var(--bad);margin-right:6px}
.flag-label{color:var(--text)}
.flag-penalty{float:right;font-weight:700;color:var(--bad)}
.flag-cap{display:inline-block;margin-left:6px;font-size:11px;color:var(--avoid);border:1px solid var(--avoid);border-radius:6px;padding:0 5px}
.flag-evidence{font-size:11.5px;color:var(--dim);margin-top:3px}
.flag-none{font-size:12.5px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.chip{font-size:12px;border:1px solid var(--border);border-radius:8px;padding:2px 8px;background:var(--panel-2)}
.chip i{font-style:normal;color:var(--dim);font-size:11px;margin-right:3px}
.chip-unknown{border-style:dashed;border-color:rgba(245,185,66,.45);color:var(--warn)}
.chip-unknown i{color:var(--warn)}
.chip-warn{border-color:rgba(245,185,66,.5);color:var(--warn)}
.gaps{margin:0;padding-left:18px;font-size:12.5px;color:var(--muted)}
.gaps li{margin:3px 0}
.detail-attrs{margin-top:12px;border-top:1px dashed var(--border);padding-top:10px;font-size:12.5px}
.detail-attrs summary{cursor:pointer;color:var(--accent);font-size:12.5px}
.kv-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.kv-table th,.kv-table td{border-bottom:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top}
.kv-table th{color:var(--muted);width:130px;font-weight:500}
.card-foot{padding:12px 18px 16px;border-top:1px solid var(--border);font-size:12.5px}
.foot-row{display:flex;gap:10px;padding:3px 0;align-items:baseline}
.foot-label{color:var(--dim);min-width:44px;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.links{display:flex;flex-wrap:wrap;gap:6px 12px}
.evidence-link{font-size:12.5px}
.listing-details{margin-top:10px;font-size:12.5px}
.listing-details summary{cursor:pointer;color:var(--accent)}
.small{font-size:12.5px;color:var(--muted)}
.path{font-size:11.5px;color:var(--dim);word-break:break-all}
.title-cell{max-width:420px}
.warn{color:var(--warn)}
.provenance-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;margin-top:10px}
.prov-block{min-width:0;margin-top:10px}
.notes{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--muted)}
.redflags{max-height:220px;overflow:auto}
.empty-state{background:var(--panel);border:1px dashed var(--border);border-radius:var(--radius);padding:20px;color:var(--muted)}
.footer{margin-top:26px;color:var(--dim);font-size:12px;text-align:center}
.method{font-size:13px;color:var(--muted)}
.method b{color:var(--text)}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--muted);margin-top:8px}
.legend span{display:inline-flex;align-items:center;gap:5px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.xfam-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:12px 0}
.xfam-item{background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.xfam-primary{border-color:rgba(91,157,255,.5);box-shadow:0 0 0 1px rgba(91,157,255,.15) inset}
.xfam-fam{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.xfam-role{font-size:10.5px;border:1px solid var(--border);border-radius:999px;padding:0 6px;margin-left:4px;color:var(--dim)}
.xfam-shop{font-size:15px;font-weight:700;margin:4px 0;word-break:break-word}
.xfam-score{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.xfam-num{font-size:22px;font-weight:800}
.xfam-tier{width:auto;margin-top:0;font-size:12px;padding:2px 8px}
.xfam-note{font-size:11.5px;color:var(--dim);margin-top:6px}
@media (max-width:860px){
  .card-body{grid-template-columns:1fr}
  .card-head{grid-template-columns:38px 64px minmax(0,1fr);}
  .thumb{width:64px;height:64px}
  .score-badge{grid-column:1/-1;flex-direction:row;justify-content:flex-start;align-items:baseline;gap:8px;text-align:left}
  .tier-pill{width:auto}
  .tier-label{width:auto;text-align:left}
  body{padding:14px 10px 48px}
}
`;

/**
 * Render the full dashboard HTML from a runProviderRadar() result.
 * @param {object} result
 * @param {{title?: string}} [options]
 * @returns {string}
 */
export function renderRadarDashboard(result, options = {}) {
  if (!result || typeof result !== 'object') throw new Error('renderRadarDashboard: result 不能为空');
  const title = options.title || 'Provider Radar — 电子漂移板供应商雷达';
  const product = result.product || {};
  const seed = result.seed || {};
  const scoring = result.scoring || {};
  const stats = result.stats || {};
  const groups = result.family_groups || [];
  const primaryGroup = groups.find((group) => group.role === 'primary') || groups[0] || null;
  const primaryProviders = primaryGroup?.providers || [];
  const top = primaryProviders[0] || (result.ranked || [])[0] || null;
  const allProviders = groups.flatMap((group) => group.providers || []);
  const buyReady = allProviders.filter((item) => item.tier === 'A' || item.tier === 'B');
  // Highest-scoring non-AVOID provider across families — comparison is explicitly non-canonical.
  const crossBest = allProviders
    .filter((item) => item.tier !== 'AVOID' && item.tier !== 'UNRANKABLE')
    .sort((a, b) => b.final_score - a.final_score)[0] || null;

  const seedLinks = [];
  const seedUrl = safeUrl(seed.url);
  if (seedUrl) seedLinks.push(`<a href="${escapeHtml(seedUrl)}" target="_blank" rel="noopener">商品页</a>`);
  if (safeUrl(seed.image_url)) seedLinks.push(`<a href="${escapeHtml(seed.image_url)}" target="_blank" rel="noopener">主图</a>`);

  const kpis = `
    <div class="kpis">
      <div class="kpi"><div class="label">可排名供应商</div><div class="value">${escapeHtml(stats.providers_ranked ?? 0)}</div><div class="sub">另有 ${escapeHtml(stats.providers_unrankable ?? 0)} 家被类目规则排除</div></div>
      <div class="kpi"><div class="label">已评分 listing</div><div class="value">${escapeHtml(stats.candidates_scored ?? 0)}</div><div class="sub">来自 ${escapeHtml(stats.offers_total ?? 0)} 条 1688 检索行（${escapeHtml(stats.offers_detail_enriched ?? 0)} 条有详情属性）</div></div>
      <div class="kpi"><div class="label">OneBound 门户行</div><div class="value">${escapeHtml(stats.portal_rows ?? 0)}</div><div class="sub">${escapeHtml(stats.portal_rows_joined ?? 0)} 条已与 JustOneAPI 合并</div></div>
      <div class="kpi"><div class="label">评分规则</div><div class="value">${escapeHtml(scoring.version || '未知')}</div><div class="sub">scoring.json · 权重和 ${escapeHtml(scoring.validation?.criterion_weights_sum ?? '?')}</div></div>
      <div class="kpi"><div class="label">主家族</div><div class="value">${escapeHtml(product.confirmed_family || '未知')}</div><div class="sub">${escapeHtml(product.confirmed_family_status || '')}</div></div>
    </div>`;

  const body = `
  <div class="wrap">
    <header class="hero">
      <div class="hero-top">
        <div class="seed-box">
          <h1>${escapeHtml(title)}</h1>
          <div class="seed-title">种子商品：${seed.title ? escapeHtml(seed.title) : '<span class="unknown">标题未知（仅知 seed id）</span>'}</div>
          <div class="runmeta">seed ${escapeHtml(seed.kind || 'unknown')} · ${seed.offer_id ? `offer ${escapeHtml(seed.offer_id)}` : 'offer id 未识别'} · 生成于 ${escapeHtml(formatDateTime(result.generated_at))}</div>
          <div class="pill-row">
            <span class="pill">主家族 <b>${escapeHtml(product.confirmed_family_label || product.confirmed_family || '未知')}</b></span>
            <span class="pill">替代家族 <b>${escapeHtml(product.secondary_family || '无')}</b></span>
            <span class="pill">模式 <b>${escapeHtml(product.scoring_mode || '')}</b></span>
            <span class="pill">目的地 <b>${escapeHtml(product.destination_country || '未知')}</b></span>
            ${seedLinks.length ? `<span class="pill">${seedLinks.join(' · ')}</span>` : ''}
          </div>
        </div>
        <div class="score-badge" style="min-width:200px">
          <div class="section-sub" style="width:100%;text-align:left">${top ? '主家族最高分供应商' : '暂无排名'}</div>
          <span class="score-value">${top ? escapeHtml(top.final_score) : '—'}</span>
          <span class="score-unit">/100</span>
          ${top ? `<span class="tier-pill ${TIER_CLASS[top.tier] || ''}" style="width:100%">${escapeHtml(top.tier)} · ${escapeHtml(top.tier_label || '')}</span>` : ''}
          <span class="tier-label" style="text-align:left;width:100%">${top ? escapeHtml(top.shop || (top.shop_masked ? '加密店铺' : '')) : ''}</span>
        </div>
      </div>
    </header>

    ${kpis}

    ${crossFamilyStrip(result)}

    <section class="section">
      <h2>一句话结论</h2>
      <p class="method">
        ${
          top
            ? `主家族 <b>${escapeHtml(product.confirmed_family_label || product.confirmed_family)}</b> 内排名第一的是 <b>${escapeHtml(top.shop || '加密店铺')}</b>（${escapeHtml(top.final_score)}/100，<b>${escapeHtml(top.tier)}</b> 档：${escapeHtml(top.tier_label || '')}）。`
            : '没有可排名供应商。未知/无数据时本工具不会编造排名。'
        }
        ${escapeHtml(product.confirmed_family_basis || '')}
      </p>
      <p class="method">
        ${
          buyReady.length === 0
            ? '<b>结论：本轮没有任何 A/B 档"可直接下单"的供应商。</b>'
            : `<b>结论：</b>本轮有 ${buyReady.length} 家进入 B 档及以上（A 档需人工复核证书编号后确认）。`
        }
        ${
          crossBest
            ? `主家族最高分 ${escapeHtml(top?.shop || '未知')}（${escapeHtml(top?.final_score)}/100，${escapeHtml(top?.tier)}）；跨家族分数最高的非 AVOID 候选是 ${escapeHtml(crossBest.shop || '未知')}（${escapeHtml(crossBest.family_label)}，${escapeHtml(crossBest.final_score)}/100，${escapeHtml(crossBest.tier)}），仅作品类替代参考，不能与主家族直接比大小。`
            : ''
        }
      </p>
      <p class="method">
        <b>诚实边界：</b>1688 搜索行不含电池/制动/认证等硬指标，本次只有 ${escapeHtml(stats.offers_detail_enriched ?? 0)} 条 offer 读到详情属性；
        详情未读时缺失字段按 <b>unknown → 中性 50</b> 处理，<b>未知不代表好</b>。红线（召回、无刹车高速、DIY/二手）会罚分或直接封顶。
        A 档要求 final ≥75 且安全 ≥60 且置信度 ≥0.60 且无封顶；当前数据下出现 A 档应被视为异常。
      </p>
      <div class="legend">
        <span><span class="dot" style="background:var(--a)"></span>A 推荐采购</span>
        <span><span class="dot" style="background:var(--b)"></span>B 可考虑先核验</span>
        <span><span class="dot" style="background:var(--c)"></span>C 备选观望</span>
        <span><span class="dot" style="background:var(--avoid)"></span>AVOID 回避</span>
        <span><span class="dot" style="background:var(--warn)"></span>未知 / 无数据</span>
      </div>
    </section>

    ${groups.map((group) => familySection(group)).join('') || '<div class="empty-state">没有可排名的供应商候选：检查 data/offers_classified.json、data/scoring.json、data/portal_e2e.json 是否就位。未知时本工具不编造排名。</div>'}

    <section class="section">
      <h2>产品家族判定</h2>
      <p class="method">评分规则要求先判家族再评分：<b>分数只在同一家族内可比</b>；玩具类、配件、人力板、无关噪音不参与主排名。主家族 = <code>${escapeHtml(product.confirmed_family || '')}</code>（${escapeHtml(product.confirmed_family_status || '')}）。</p>
      <table class="table">
        <thead><tr><th>家族</th><th>id</th><th class="num">可排名供应商</th><th class="num">扫描 offer</th><th>安全默认值</th><th class="num">去水系数</th></tr></thead>
        <tbody>${(product.families || [])
          .map(
            (family) => `<tr>
              <td>${escapeHtml(family.label_zh || family.family)}</td>
              <td><code>${escapeHtml(family.family)}</code></td>
              <td class="num">${escapeHtml(family.ranked_providers)}</td>
              <td class="num">${escapeHtml(family.scan_offers)}</td>
              <td>${escapeHtml(family.brake_design_default)}</td>
              <td class="num">${escapeHtml(family.range_derate_factor)}</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>
    </section>

    ${provenancePanel(result)}
    ${unrankableSection(result)}

    <p class="footer">
      由 <code>1688-ops provider-radar</code> 生成 · ${escapeHtml(formatDateTime(result.generated_at))} ·
      自包含单文件（无 CDN / 无外部资源）· 不打印任何 cookie/token · 逐指标可复算见每张卡片“评分明细”
    </p>
  </div>`;

  // Mobile safety: every wide table becomes horizontally scrollable inside its own container so a
  // 390px viewport never overflows the page (Lead audit defect #1).
  const scrollableBody = body
    .replace(/<table\b([^>]*)>/g, '<div class="table-scroll"><table$1>')
    .replace(/<\/table>/g, '</table></div>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="1688-ops provider-radar ${escapeHtml(result.schema_version || '')}">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>${scrollableBody}</body>
</html>`;
}
