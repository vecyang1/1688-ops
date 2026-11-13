/**
 * Provider Radar — seed product → provider candidates → scored ranking.
 *
 * CANONICAL SCORING: `data/scoring.json` v1.1.0 (onebound-provider-radar/scoring/v1,
 * spec-analyst 2026-11-13) is executed literally by this module:
 *   - criteria weights A 0.20 / B 0.22 / C 0.16 / D 0.30 / E 0.12, sub-weights from the file;
 *   - formula mini-language: piecewise_linear, piecewise_linear_log10, categorical,
 *     ratio_piecewise, boolean, count_true_score, coverage_score, cert_tier_score,
 *     family_override (per-family anchor overrides);
 *   - missing policy: unavailable → neutral per file; detail read + field absent → absent value;
 *   - declarative red flags (`when` conditions with eq/ne/lt/lte/gt/gte/in/not_in/empty,
 *     all/any, {ref} expressions, cap_tier_rule), auto_avoid rules, confidence caps;
 *   - verdict tiers A/B/C/AVOID/UNRANKABLE + toy disambiguation.
 *
 * Everything is data-driven: when the rubric file changes, this engine follows it. No network IO;
 * `loadRadarDatasets()` is the only IO (local files) and `runProviderRadar()` is pure.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const RADAR_SCHEMA_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// 1. Small utilities
// ---------------------------------------------------------------------------

const round = (n, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(Number(n) * factor) / factor;
};
const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const median = (values) => {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
};
const firstNumber = (text) => {
  const match = String(text || '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};
const dedupe = (values) => [...new Set(values.filter(Boolean))];

export function normalizeShopKey(shop) {
  if (!shop) return null;
  return String(shop).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Map a saved market-scan class or short family label to a scoring family id (long form). */
export const SHORT_FAMILY_TO_SCAN_CLASS = {
  e_skate: 'electric_skateboard',
  e_scooter: 'electric_scooter',
  hoverboard: 'hoverboard_balance',
  drift_trike: 'electric_drift_trike',
  freeline: 'motorized_freeline_board',
  part: 'parts_accessories',
  other: 'unrelated_noise',
};

const SHORT_FAMILY_TO_LONG = {
  electric_skateboard: 'electric_skateboard',
  electric_scooter: 'electric_scooter',
  hoverboard_self_balancing: 'hoverboard_self_balancing',
  drift_trike_kart: 'drift_trike_kart',
  motorized_freeline_board: 'motorized_freeline_board',
};

// ---------------------------------------------------------------------------
// 2. scoring.json ingestion + validation
// ---------------------------------------------------------------------------

/** Load and validate the canonical scoring spec. Throws with actionable text when unusable. */
export function loadScoringSpec(rawSpec) {
  if (!rawSpec || typeof rawSpec !== 'object') {
    throw new Error(
      '缺少可执行评分规则 data/scoring.json；本命令拒绝用"拍脑袋权重"排供应商。请先把 scoring.json 放回数据目录。'
    );
  }
  if (!Array.isArray(rawSpec.criteria) || rawSpec.criteria.length === 0) {
    throw new Error('scoring.json 缺少 criteria[] 数组，无法评分。');
  }
  if (!Array.isArray(rawSpec.red_flags)) {
    throw new Error('scoring.json 缺少 red_flags[] 数组，无法执行硬红线。');
  }
  if (!rawSpec.verdict_tiers || typeof rawSpec.verdict_tiers !== 'object') {
    throw new Error('scoring.json 缺少 verdict_tiers 对象，无法分档。');
  }

  const warnings = [];
  const criteria = rawSpec.criteria.map((criterion) => {
    const metrics = Array.isArray(criterion.metrics) ? criterion.metrics : [];
    if (metrics.length === 0) warnings.push(`criterion ${criterion.id} 无 metrics`);
    const metricSum = metrics.reduce((sum, m) => sum + (Number(m.local_weight) || 0), 0);
    if (Math.abs(metricSum - 1) > 0.001) {
      warnings.push(`criterion ${criterion.id} 子权重和 = ${round(metricSum, 4)} ≠ 1.0`);
    }
    const normalizedMetrics = metrics.map((metric) => ({
      ...metric,
      local_weight: (Number(metric.local_weight) || 0) / (metricSum || 1),
    }));
    return {
      id: criterion.id,
      letter: String(criterion.id).split('_')[0],
      name_zh: criterion.name_zh || criterion.name || criterion.id,
      name_en: criterion.name_en || '',
      weight: Number(criterion.weight) || 0,
      evidence_grade: criterion.evidence_grade || null,
      rationale_zh: criterion.rationale_zh || null,
      metrics: normalizedMetrics,
    };
  });

  const weightSum = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (Math.abs(weightSum - 1) > 0.001) warnings.push(`criteria 权重和 = ${round(weightSum, 4)} ≠ 1.0`);
  const normalizedCriteria = criteria.map((criterion) => ({ ...criterion, weight: criterion.weight / (weightSum || 1) }));

  return {
    raw: rawSpec,
    version: rawSpec.version || 'unknown',
    schema_version: rawSpec.schema_version || null,
    product: rawSpec.product || {},
    families: rawSpec.families || {},
    criteria: normalizedCriteria,
    criteria_weights_sum: round(weightSum, 4),
    red_flags: rawSpec.red_flags,
    verdict_tiers: rawSpec.verdict_tiers,
    cert_evidence_tiers: rawSpec.cert_evidence_tiers || null,
    recall_seed: rawSpec.recall_seed || [],
    toy_disambiguation: rawSpec.toy_vs_family_disambiguation || null,
    validation: rawSpec.validation || {},
    buy_modes: rawSpec.buy_modes || {},
    warnings,
  };
}

/** Safe sum check used by --diagnose and the provenance panel. */
export function validateScoringSpec(spec) {
  const criteria = spec.criteria.map((criterion) => {
    const metricWeights = criterion.metrics.reduce((sum, m) => sum + (Number(m.local_weight) || 0), 0);
    return {
      id: criterion.id,
      weight: round(criterion.weight, 4),
      metrics: criterion.metrics.length,
      metric_weights_sum: round(metricWeights, 4),
      ok: Math.abs(metricWeights - 1) <= 0.001,
    };
  });
  return {
    version: spec.version,
    criterion_weights_sum: spec.criteria_weights_sum,
    criteria,
    red_flags: spec.red_flags.length,
    families: Object.keys(spec.families).length,
    warnings: spec.warnings,
    ok:
      Math.abs(spec.criteria_weights_sum - 1) <= 0.001 &&
      criteria.every((c) => c.ok) &&
      spec.red_flags.length > 0,
  };
}

// ---------------------------------------------------------------------------
// 3. Family / age classification
// ---------------------------------------------------------------------------

const RE_PART = /电机|马达|轮毂|控制器|充电器|电池包|电池组|内胎|外胎|轮胎|砂轮|轴承|霍尔|配件|零配件|护边|贴纸|扳手|螺丝|灯珠/;
const RE_COMPLETE = /整车|全套|整机|成品/;
const RE_ELECTRIC = /电动|电机|驱动|遥控|电瓶|电能|电池|e-?skate|electric/i;
const RE_HUMAN_POWERED = /人力|无动力|脚蹬|脚踩|活力板|分体滑板|freeline/i;
const RE_CHILD = /儿童|小孩|宝宝|幼儿园|少儿|幼儿|学生|童车|玩具|kids|toy|child/i;
const RE_ADULT = /成人|成年|大人|通用|青少年|adult|unisex/i;

/**
 * Resolve an offer/title to a canonical scoring family id.
 * Precedence: market-scan class map (authoritative for dataset rows) → dataset short family →
 * family detect regexes. Returns null for parts / noise / non-electric boards (not rankable).
 */
export function resolveScoringFamily(title, { scanCategory, shortFamily } = {}, spec) {
  const marketMap = spec.product?.market_scan_class_map || {};
  const knownFamilies = Object.keys(spec.families);

  if (scanCategory && Object.prototype.hasOwnProperty.call(marketMap, scanCategory)) {
    const mapped = marketMap[scanCategory];
    return mapped ? { family: mapped, basis: 'market_scan_class_map' } : { family: null, basis: 'market_scan_class_map_excluded' };
  }

  const shortMapped = shortFamily && SHORT_FAMILY_TO_SCAN_CLASS[shortFamily];
  if (shortMapped && Object.prototype.hasOwnProperty.call(marketMap, shortMapped)) {
    const mapped = marketMap[shortMapped];
    if (mapped) {
      if (mapped === 'motorized_freeline_board' && !RE_ELECTRIC.test(String(title || ''))) {
        return { family: null, basis: 'human_powered_freeline' };
      }
      return { family: mapped, basis: 'dataset_short_family' };
    }
    return { family: null, basis: 'dataset_short_family_excluded' };
  }

  const text = String(title || '');
  if (!text.trim()) return { family: null, basis: 'empty_title' };

  if (RE_PART.test(text) && !RE_COMPLETE.test(text)) return { family: null, basis: 'parts' };
  if (RE_HUMAN_POWERED.test(text) && !RE_ELECTRIC.test(text)) return { family: null, basis: 'non_electric' };

  const hits = [];
  for (const [familyId, family] of Object.entries(spec.families)) {
    if (!knownFamilies.includes(familyId)) continue;
    const include = family.detect?.include_regex_any || [];
    const exclude = family.detect?.exclude_regex_any || [];
    const includeHits = include.filter((pattern) => regexTest(pattern, text)).length;
    const excluded = exclude.some((pattern) => regexTest(pattern, text));
    if (includeHits > 0 && !excluded) hits.push({ familyId, includeHits, order: familyOrderIndex(familyId, spec) });
  }
  if (hits.length === 0) return { family: null, basis: 'no_family_match' };
  hits.sort((a, b) => b.includeHits - a.includeHits || a.order - b.order);
  const winner = hits[0].familyId;
  // "电子漂移板"/"电动滑板" families require electric propulsion; a title that only says
  // 漂移板/滑板 without any electric token is a human-powered board (or toy), not this family.
  if (winner === 'motorized_freeline_board' && !RE_ELECTRIC.test(text)) {
    return { family: null, basis: 'human_powered_freeline' };
  }
  if (winner === 'electric_skateboard' && !RE_ELECTRIC.test(text)) {
    return { family: null, basis: 'non_electric' };
  }
  return { family: winner, basis: 'title_regex' };
}

function familyOrderIndex(familyId, spec) {
  const fallback = spec.product?.fallback_family_order || [];
  const idx = fallback.indexOf(familyId);
  return idx === -1 ? 100 + Object.keys(spec.families).indexOf(familyId) : idx;
}

function regexTest(pattern, text) {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return false;
  }
}

/** Age/a Audience target per scoring.json toy_vs_family_disambiguation. */
export function classifyAgeTarget(title, detailAttributes = {}) {
  const attrs = detailAttributes || {};
  const childOnly = attrValue(attrs, ['儿童专用']);
  if (childOnly === '是') return { age_target: 'child', basis: 'detail_child_attr' };
  const audience = attrValue(attrs, ['适用人群']);
  if (audience) {
    if (/儿童|小孩|幼儿|宝宝/.test(audience)) return { age_target: 'child', basis: 'detail_audience' };
    if (/成人|成年/.test(audience)) return { age_target: 'adult', basis: 'detail_audience' };
    if (/通用/.test(audience)) return { age_target: 'unisex', basis: 'detail_audience' };
    if (/青少年/.test(audience)) return { age_target: 'teen', basis: 'detail_audience' };
  }
  const text = String(title || '');
  const child = (text.match(new RegExp(RE_CHILD.source, 'gi')) || []).length;
  const adult = (text.match(new RegExp(RE_ADULT.source, 'gi')) || []).length;
  if (child > 0 && adult > 0) return { age_target: 'family', basis: 'title_both' };
  if (child > 0) return { age_target: 'child', basis: 'title_child' };
  if (adult > 0) return { age_target: 'adult', basis: 'title_adult' };
  return { age_target: 'unknown', basis: 'no_signal' };
}

// ---------------------------------------------------------------------------
// 4. Signal extraction (title + detail attributes) → scoring input fields
// ---------------------------------------------------------------------------

function attrValue(attributes, names) {
  if (!attributes) return null;
  for (const name of names) {
    if (attributes[name] !== undefined && attributes[name] !== null && String(attributes[name]).trim() !== '') {
      return String(attributes[name]).trim();
    }
  }
  return null;
}

const CERT_SYSTEM_STANDARDS = [
  { id: 'UL2272', label: 'UL 2272', re: /UL\s*[- ]?2272|UL2272/i, families: ['hoverboard_self_balancing', 'electric_skateboard'] },
  { id: 'GB34668', label: 'GB 34668-2024', re: /GB\s*\/?\s*T?\s*34668|GB34668/i, families: ['hoverboard_self_balancing'] },
  { id: 'GBT34667', label: 'GB/T 34667-2023', re: /GB\s*\/?\s*T?\s*34667|GB34667/i, families: ['hoverboard_self_balancing'] },
  { id: 'CQC', label: 'CQC13-469391', re: /CQC\s*13|CQC认证|CQC/i, families: ['hoverboard_self_balancing'] },
  { id: 'EN17128', label: 'EN 17128', re: /EN\s*[- ]?17128/i, families: [] },
  { id: 'IEC60335', label: 'IEC 60335-2-114', re: /60335\s*[-]?\s*2\s*[-]?\s*114/i, families: [] },
  { id: 'UN383', label: 'UN38.3', re: /UN\s*38\.?3/i, families: [] },
  { id: 'GB42825', label: 'GB/T 42825-2023', re: /GB\s*\/?\s*T?\s*42825|GB42825/i, families: ['electric_scooter'] },
];
const CERT_NOISE = [
  { id: 'CE', label: 'CE（自我声明）', re: /(^|[^A-Za-z])CE([^A-Za-z]|$)/i },
  { id: 'RoHS', label: 'RoHS', re: /RoHS/i },
  { id: 'FCC', label: 'FCC', re: /FCC/i },
  { id: 'ISO9001', label: 'ISO 9001', re: /ISO\s*9001/i },
  { id: 'MSDS', label: 'MSDS/SDS', re: /MSDS|SDS\b/i },
  { id: 'SGS', label: 'SGS/BV/TÜV 报告', re: /SGS|TÜV|TUV|BV认证|BureauVeritas/i },
];
const CERT_OUT_OF_SCOPE = [
  { id: 'UL2849', label: 'UL 2849（电助力自行车，错配）', re: /UL\s*[- ]?2849|UL2849/i },
  { id: 'EN15194', label: 'EN 15194（电助力自行车，错配）', re: /EN\s*[- ]?15194/i },
];
const CELL_TIER1 = /三星|LG|松下|三洋|村田|Samsung|Panasonic|Murata|Sanyo/i;
const CELL_CHINESE = /宁德时代|亿纬|力神|比亚迪|星恒|天能|超威|国轩|中航锂电|EVE|CATL/i;
const CELL_GENERIC = /A品电芯|A级电芯|汽车级电芯|进口电芯|大容量电芯|优质电芯|动力电芯/i;
const RE_LEAD_ACID = /铅酸|铅蓄电池/i;
const RE_BMS = /BMS|电池管理系统|保护板/i;
const RE_UN38 = /UN\s*38\.?3|运输鉴定|海运鉴定|空运鉴定|电池报告/i;
const RE_FCC = /FCC/i;
const RE_RADIO = /遥控|蓝牙|APP|app控制|蓝牙音箱|无线/i;
const RE_DIY = /散件|套件|DIY|自行组装|自己组装|改装|无检测|组装件/i;
const RE_USED = /二手|翻新|样品机|尾货|库存机|库存清仓|外贸尾单/i;
const RE_SPEED = /(\d{1,2}(?:\.\d)?)\s*(?:km\/h|kmh|公里\/小时|千米\/小时|码|迈)/i;
const RE_RANGE_OFFICIAL = [
  /(?:续航|里程)[^0-9]{0,8}(\d{1,3})\s*(?:km|公里|千米)/i,
  /(\d{1,3})\s*(?:km|公里|千米)\s*(?:续航|里程)/i,
];
const RE_RANGE_ANY = /(\d{1,3})\s*(?:km|公里|千米)/gi;
const RE_VOLT = /(\d{2,3})\s*V(?![a-zA-Z])/i;
const RE_AH = /(\d{1,3}(?:\.\d)?)\s*(?:Ah|安时)/i;
const RE_WH = /(\d{2,4})\s*Wh\b/i;
const RE_WATT = /(?:(\d+)\s*\*\s*)?(\d{2,4})\s*(?:W|瓦)(?![A-Za-z])/i;
const RE_WHEEL = /(\d{1,2}(?:\.\d)?)\s*(?:英寸|寸|inch)/i;
const RE_LOAD = /(?:承重|载重|最大负载|载重量)[^0-9]{0,8}(\d{2,3})\s*(?:kg|公斤|千克)/i;
const RE_CHARGE = /(?:充电|充满)[^0-9]{0,10}(\d{1,2}(?:\.\d)?)\s*(?:小时|h)/i;
const RE_HILL_DEG = /(?:爬坡|坡度)[^0-9]{0,8}(\d{1,2})\s*(?:°|度)/i;
const RE_HILL_PCT = /(\d{1,2})\s*%\s*(?:坡度|爬坡)/i;
const RE_MODES = /(\d)\s*档|(\d)\s*个?模式/i;
const RE_IP = /IP\s?([0-9X]{2})/i;

const PROTECTION_SIGNALS = [
  { id: 'over_speed', re: /超速保护|限速保护|限速/ },
  { id: 'low_battery', re: /低电量保护|欠压保护/ },
  { id: 'charge_lock', re: /充电锁止|充电保护/ },
  { id: 'anti_spin', re: /防飞转|防打滑/ },
  { id: 'slope_hold', re: /驻坡|防溜坡|坡道辅助/ },
];

/**
 * Extract rubric input fields from title text + 1688 detail attributes.
 * Every return value records whether it came from title or detail for provenance.
 */
export function extractSignals(title, detailAttributes = {}, { family = null } = {}) {
  const text = String(title || '');
  const attrs = detailAttributes || {};
  const attrText = Object.values(attrs).filter((v) => typeof v === 'string').join(' ');
  const combined = `${text} ${attrText}`;
  const sources = {};
  const set = (field, value, source) => {
    sources[field] = source;
    return value;
  };

  let topSpeed = null;
  const titleSpeed = text.match(RE_SPEED);
  if (titleSpeed) topSpeed = set('top_speed_kmh', Number(titleSpeed[1]), 'title');
  else {
    const attrSpeed = attrValue(attrs, ['最高时速', '时速', '最高速度']);
    if (attrSpeed) {
      const num = firstNumber(attrSpeed.replace(/小时/g, ''));
      if (num !== null) topSpeed = set('top_speed_kmh', num, 'detail');
    }
  }

  let claimedRange = null;
  for (const re of RE_RANGE_OFFICIAL) {
    const match = text.match(re);
    if (match) {
      claimedRange = set('claimed_range_km', Number(match[1]), 'title');
      break;
    }
  }
  if (claimedRange === null) {
    const attrRange = attrValue(attrs, ['续航里程', '续航', '里程', '续航公里数']);
    if (attrRange) {
      const nums = (attrRange.match(/\d{1,3}/g) || []).map(Number).filter((n) => n > 0 && n <= 200);
      if (nums.length > 0) claimedRange = set('claimed_range_km', Math.min(...nums), 'detail_min_band');
    }
  }
  let variantMaxRange = null;
  if (claimedRange === null) {
    const variants = attrValue(attrs, ['颜色', '规格', '型号']) || '';
    const nums = [...variants.matchAll(RE_RANGE_ANY)].map((m) => Number(m[1])).filter((n) => n >= 5 && n <= 120);
    if (nums.length > 0) {
      variantMaxRange = Math.max(...nums);
      claimedRange = set('claimed_range_km', variantMaxRange, 'detail_variant_max');
    }
  }

  const voltMatch = combined.match(RE_VOLT);
  const batteryV = voltMatch ? set('battery_v', Number(voltMatch[1]), text.match(RE_VOLT) ? 'title' : 'detail') : null;
  const ahMatch = combined.match(RE_AH);
  const batteryAh = ahMatch ? set('battery_ah', Number(ahMatch[1]), text.match(RE_AH) ? 'title' : 'detail') : null;
  let batteryWh = null;
  const whMatch = combined.match(RE_WH);
  if (whMatch) batteryWh = set('battery_wh', Number(whMatch[1]), text.match(RE_WH) ? 'title' : 'detail');
  else if (batteryV && batteryAh) batteryWh = set('battery_wh', Math.round(batteryV * batteryAh), 'derived');

  let motorW = null;
  const wattMatch = combined.match(RE_WATT);
  if (wattMatch) {
    const count = wattMatch[1] ? Number(wattMatch[1]) : 1;
    motorW = set('motor_w_total', Number(wattMatch[2]) * count, text.match(RE_WATT) ? 'title' : 'detail');
  }

  let wheelIn = null;
  const wheelMatch = text.match(RE_WHEEL);
  if (wheelMatch) wheelIn = set('wheel_in', Number(wheelMatch[1]), 'title');

  let loadKg = null;
  const loadMatch = text.match(RE_LOAD);
  if (loadMatch) loadKg = set('max_load_kg', Number(loadMatch[1]), 'title');
  else {
    const attrLoad = attrValue(attrs, ['最大载重量', '载重量', '载重', '承重']);
    if (attrLoad) {
      const num = firstNumber(attrLoad);
      if (num !== null) loadKg = set('max_load_kg', num, 'detail');
    }
  }

  let chargeTimeH = null;
  const chargeMatch = text.match(RE_CHARGE);
  if (chargeMatch) chargeTimeH = set('charge_time_h', Number(chargeMatch[1]), 'title');
  else {
    const attrCharge = attrValue(attrs, ['充电时间', '充电时长', '充电']);
    if (attrCharge) {
      const num = firstNumber(attrCharge);
      if (num !== null) chargeTimeH = set('charge_time_h', num, 'detail');
    }
  }

  let hillDeg = null;
  const hillDegMatch = combined.match(RE_HILL_DEG);
  if (hillDegMatch) hillDeg = set('hill_climb_deg', Number(hillDegMatch[1]), 'title_or_detail');
  else {
    const hillPctMatch = combined.match(RE_HILL_PCT);
    if (hillPctMatch) {
      const pct = Number(hillPctMatch[1]);
      hillDeg = set('hill_climb_deg', round((Math.atan(pct / 100) * 180) / Math.PI, 1), 'derived_from_percent');
    }
  }

  const modesMatch = combined.match(RE_MODES);
  const rideModesCount = modesMatch ? set('ride_modes_count', Number(modesMatch[1] || modesMatch[2]), 'title_or_detail') : null;

  // tire type
  let tireType = null;
  if (/越野充气|充气越野/.test(combined)) tireType = set('tire_type', 'offroad_pneumatic', 'title_or_detail');
  else if (/真空胎/.test(combined)) tireType = set('tire_type', 'vacuum', 'title_or_detail');
  else if (/充气胎|充气轮/.test(combined)) tireType = set('tire_type', 'pneumatic', 'title_or_detail');
  else if (/蜂窝/.test(combined)) tireType = set('tire_type', 'honeycomb', 'title_or_detail');
  else if (/实心胎|实心|PU轮/.test(combined)) tireType = set('tire_type', 'solid_pu', 'title_or_detail');

  // control mode
  let controlMode = null;
  if (/方向盘|油门|漂移拉杆/.test(combined)) controlMode = set('control_mode', 'steering_wheel_pedal_drift_bar', 'title_or_detail');
  else if (/腿控|重心|体感/.test(combined)) controlMode = set('control_mode', 'lean_body_control_self_balancing', 'title_or_detail');
  else if (/APP|手机/.test(combined)) controlMode = set('control_mode', 'app_only', 'title_or_detail');
  else if (/遥控/.test(combined)) {
    controlMode = set(
      'control_mode',
      /屏|显示|档|模式/.test(combined) ? 'remote_display_multi_mode' : 'remote_basic',
      'title_or_detail'
    );
  }

  // brake type
  let brakeType = null;
  const brakeAttr = attrValue(attrs, ['制动系统', '刹车系统', '刹车']);
  if (/双.*(油压|液压)|油压|液压/.test(brakeAttr || '') || /油压碟刹|液压碟刹/.test(combined)) {
    brakeType = set('brake_type', /双/.test(brakeAttr || '') ? 'dual_independent_hydraulic' : 'single_hydraulic_disc', 'title_or_detail');
  } else if (/双碟|前后碟|前碟后碟/.test(combined)) brakeType = set('brake_type', 'front_rear_disc', 'title_or_detail');
  else if (/碟刹|盘刹|碟式/.test(combined)) brakeType = set('brake_type', 'single_mechanical_disc', 'title_or_detail');
  else if (/鼓刹/.test(combined)) brakeType = set('brake_type', 'drum_brake', 'title_or_detail');
  else if (/电子刹车|电磁刹车|能量回收|电子制动/.test(combined)) brakeType = set('brake_type', 'electronic_regen_only', 'title_or_detail');
  else if (/松手刹|断电刹车|电机断电/.test(combined)) brakeType = set('brake_type', 'motor_cutoff_only', 'title_or_detail');
  else if (/无刹|不带刹/.test(combined)) brakeType = set('brake_type', 'none', 'title_or_detail');
  else if (/(?:^|[\s:：])电动$/.test((brakeAttr || '').trim()) || brakeAttr === '电动') {
    brakeType = set('brake_type', 'electronic_regen_only', 'detail_attr');
  }

  // protections
  const protectionFlags = {};
  for (const signal of PROTECTION_SIGNALS) protectionFlags[signal.id] = signal.re.test(combined);

  // certification
  const certMentions = [];
  const systemCerts = [];
  for (const standard of CERT_SYSTEM_STANDARDS) {
    if (standard.re.test(combined)) {
      const inScope = !standard.families.length || !family || standard.families.includes(family);
      const label = `${standard.label}${inScope ? '' : '（错配品类）'}`;
      certMentions.push(label);
      if (inScope && standard.id !== 'UN383') systemCerts.push({ id: standard.id, label, textOnly: true });
    }
  }
  const noiseCerts = [];
  for (const noise of CERT_NOISE) {
    if (noise.re.test(combined)) {
      certMentions.push(noise.label);
      noiseCerts.push(noise.id);
    }
  }
  for (const oos of CERT_OUT_OF_SCOPE) {
    if (oos.re.test(combined)) {
      certMentions.push(oos.label);
      noiseCerts.push(oos.id);
    }
  }
  const exportCertAttr = attrValue(attrs, ['外贸出口认证', '出口认证', '认证']);
  if (exportCertAttr) certMentions.push(`外贸出口认证=${exportCertAttr}`);
  const reportNoAttr = attrValue(attrs, ['质检报告编号', '证书编号', '检测报告编号']);
  if (reportNoAttr) certMentions.push(`质检报告=${reportNoAttr}`);
  const explicitNoCert = /^(无|没有|暂无|其他|\/|-)$/.test((exportCertAttr || '').trim());

  // cell tier
  let cellTier = null;
  const hasBms = RE_BMS.test(combined);
  const leadAcid = RE_LEAD_ACID.test(combined);
  const batteryTypeAttr = attrValue(attrs, ['电池类型', '电芯类型']);
  if (leadAcid) cellTier = 'lead_acid';
  else if (CELL_TIER1.test(combined)) cellTier = hasBms ? 'tier1_named_bms' : 'tier1_named';
  else if (CELL_CHINESE.test(combined)) cellTier = hasBms ? 'chinese_named_bms' : 'chinese_named';
  else if (CELL_GENERIC.test(combined)) cellTier = hasBms ? 'generic_claim_bms' : 'generic_claim';
  else if (batteryTypeAttr || batteryWh) cellTier = null; // capacity known but no cell provenance → absent handling
  const batteryInfoPresent = Boolean(batteryTypeAttr || batteryV || batteryAh || batteryWh || leadAcid);

  // IP rating
  const ipMatch = combined.match(RE_IP);
  const ipRating = ipMatch ? `IP${ipMatch[1].toUpperCase()}` : null;

  const age = classifyAgeTarget(text, attrs);
  const remoteRadio = RE_RADIO.test(combined);
  const fccMentioned = RE_FCC.test(combined);
  const shippingDocs = RE_UN38.test(combined);
  const recallHits = [];
  const disclaimer =
    '证书真伪需在发证机构数据库复核（UL Product iQ / CQC / NSW 登记）；此处只记录"卖家声明了什么"。';

  return {
    top_speed_kmh: topSpeed,
    claimed_range_km: claimedRange,
    variant_max_range_km: variantMaxRange,
    battery_v: batteryV,
    battery_ah: batteryAh,
    battery_wh: batteryWh,
    motor_w_total: motorW,
    wheel_in: wheelIn,
    max_load_kg: loadKg,
    charge_time_h: chargeTimeH,
    hill_climb_deg: hillDeg,
    ride_modes_count: rideModesCount,
    tire_type: tireType,
    control_mode: controlMode,
    brake_type: brakeType,
    protection_flags: protectionFlags,
    protection_count: Object.values(protectionFlags).filter(Boolean).length,
    cert_mentions: dedupe(certMentions),
    cert_system: systemCerts,
    cert_noise: noiseCerts,
    explicit_no_cert: explicitNoCert,
    cell_tier: cellTier,
    battery_info_present: batteryInfoPresent,
    ip_rating: ipRating,
    age_target: age.age_target,
    age_basis: age.basis,
    has_radio: remoteRadio,
    fcc_mentioned: fccMentioned,
    shipping_doc_offered: shippingDocs,
    text_has_diy_kit: RE_DIY.test(combined),
    text_has_used: RE_USED.test(combined),
    detail_attribute_keys: Object.keys(attrs),
    sources,
    cert_disclaimer: disclaimer,
    recall_hits: recallHits,
  };
}

// ---------------------------------------------------------------------------
// 5. Candidate building
// ---------------------------------------------------------------------------

const SHOP_FACTORY_RE = /市.*厂$|器材厂|制品厂|冲件厂|加工厂|工厂|工贸|实业|制造/;
const SHOP_TECH_RE = /科技/;
const SHOP_TRADER_RE = /商行|贸易|电子商务|商贸|销售|贸易商/;

function inferBizType(shop, marketItem) {
  if (marketItem?.biz_type) {
    const biz = marketItem.biz_type;
    if (/工贸/.test(shop || '')) return '工贸一体';
    if (biz === '生产加工' && /工贸/.test(shop || '')) return '工贸一体';
    return biz;
  }
  const name = String(shop || '');
  if (/工贸/.test(name)) return '工贸一体';
  if (SHOP_FACTORY_RE.test(name)) return '生产加工';
  if (SHOP_TRADER_RE.test(name)) return '经销批发';
  if (SHOP_TECH_RE.test(name)) return '生产加工';
  return null;
}

/**
 * Build one normalized candidate from a saved 1688 search row.
 * @param {object} offer offers_classified.json row
 * @param {{marketItem?: object, providerDetail?: object, spec: object}} options
 */
export function buildOfferCandidate(offer, { marketItem = null, providerDetail = null, spec }) {
  const title = offer.title || providerDetail?.title || '';
  const scanCategory = marketItem?.category || null;
  const familyResolution = resolveScoringFamily(
    title,
    { scanCategory, shortFamily: offer.family },
    spec
  );
  const detailAttrs = providerDetail?.attributes || {};
  const detailAvailable = Boolean(providerDetail && providerDetail.attributes && Object.keys(detailAttrs).length > 0);
  const signals = extractSignals(title, detailAttrs, { family: familyResolution.family });

  const priceSearch = typeof offer.price === 'number' ? offer.price : null;
  const priceDetail = providerDetail?.price !== null && providerDetail?.price !== undefined ? Number(providerDetail.price) : null;
  // scoring.json price_cny source = search list price | price_info.sale_price | quantity_prices[0].
  // Detail current price is kept as separate evidence, not silently substituted.
  const priceCny = priceSearch;
  const priceBasis = priceSearch !== null ? 'search_default' : Number.isFinite(priceDetail) ? 'detail_page_only' : 'unknown';
  const salesDetail = providerDetail?.saled_count;
  const sales = typeof offer.sales === 'number' ? offer.sales : Number.isFinite(salesDetail) ? salesDetail : null;
  const rrFraction = typeof offer.rr === 'number' ? round(offer.rr / 100, 4) : null;

  const moq = parseMoq(marketItem);

  const candidate = {
    id: `1688:${offer.offer_id}`,
    provider_key: `1688:${normalizeShopKey(offer.shop) || `offer:${offer.offer_id}`}`,
    platform: '1688',
    sources: dedupe(['justoneapi-search', detailAvailable ? 'justoneapi-detail' : null]),
    offer_id: String(offer.offer_id),
    title,
    shop: offer.shop || providerDetail?.company || null,
    province: offer.province || null,
    url: offer.url || `https://detail.1688.com/offer/${offer.offer_id}.html`,
    image_url: offer.pic || null,
    keyword: offer.keyword || null,
    price_cny: priceCny,
    price_search_cny: priceSearch,
    price_detail_cny: Number.isFinite(priceDetail) ? priceDetail : null,
    price_basis: priceBasis,
    sales,
    rr_percent: typeof offer.rr === 'number' ? offer.rr : null,
    repurchase_rate_fraction: rrFraction,
    moq,
    family: familyResolution.family,
    family_basis: familyResolution.basis,
    dataset_family: offer.family || null,
    scan_class: scanCategory,
    rideable: offer.rideable ?? null,
    audience: signals.age_target,
    evidence_scope: detailAvailable ? 'detail' : 'search',
    detail_available: detailAvailable,
    detail_attributes: detailAttrs,
    evidence_scope_note: detailAvailable
      ? '详情页属性已读取（detail_text_available=true）'
      : '仅搜索列表行；未读详情 → 缺失字段按 unknown 处理',
    signals,
    fields: {},
    evidence: [
      {
        kind: 'search-row',
        platform: '1688',
        keyword: offer.keyword || null,
        offer_id: String(offer.offer_id),
        url: offer.url || null,
      },
      ...(detailAvailable
        ? [{ kind: 'detail-page', platform: '1688', offer_id: String(offer.offer_id), url: providerDetail.detail_url || null }]
        : []),
    ],
    market_item: marketItem || null,
    raw: offer,
  };

  candidate.fields = assembleFields(candidate, { spec, marketContext: null });
  return candidate;
}

function parseMoq(marketItem) {
  const tiers = marketItem?.quantity_prices;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const first = tiers[0];
  const num = firstNumber(first?.quantity ?? first?.quantity_text ?? '');
  return num !== null ? num : null;
}

function assembleFields(candidate, { spec, marketContext }) {
  const signals = candidate.signals;
  const familyConfig = candidate.family ? spec.families[candidate.family] : null;
  const derate = familyConfig?.range_derate_factor ?? 0.65;
  const market = (marketContext?.families || {})[candidate.family] || {};

  const fields = {
    title: candidate.title,
    detail_text: candidate.detail_available ? JSON.stringify(candidate.detail_attributes) : null,
    detail_text_available: candidate.detail_available,
    age_target: signals.age_target,
    top_speed_kmh: signals.top_speed_kmh,
    hill_climb_deg: signals.hill_climb_deg,
    tire_type: signals.tire_type,
    wheel_in: signals.wheel_in,
    max_load_kg: signals.max_load_kg,
    control_mode: signals.control_mode,
    ride_modes_count: signals.ride_modes_count,
    claimed_range_km: signals.claimed_range_km,
    battery_v: signals.battery_v,
    battery_ah: signals.battery_ah,
    battery_wh: signals.battery_wh,
    charge_time_h: signals.charge_time_h,
    price_cny: candidate.price_cny,
    moq: candidate.moq,
    family_median_price_cny: market.median_price_cny ?? null,
    family_median_motor_w: market.median_motor_w ?? null,
    cert_best_tier: deriveCertTier(signals, candidate.family, candidate.detail_available||false),
    cert_mentions: signals.cert_mentions,
    brake_type: signals.brake_type,
    protection_flags:
      candidate.detail_available || signals.protection_count > 0 ? signals.protection_flags : null,
    cell_tier: signals.cell_tier,
    ip_rating: signals.ip_rating,
    orders_count: candidate.sales,
    repurchase_rate_fraction: candidate.repurchase_rate_fraction,
    rating_star: null,
    dispute_score: null,
    shop_years: candidate.market_item?.tp_year ?? null,
    biz_type: inferBizType(candidate.shop, candidate.market_item),
    factory_inspection: candidate.market_item?.factory_inspection ?? null,
    is_super_factory: candidate.market_item?.super_factory ?? null,
    spec_field_count: null,
    motor_w_total: signals.motor_w_total,
    is_ad: candidate.market_item?.is_p4p ?? null,
    destination_country: null,
    has_radio: signals.has_radio,
    fcc_mentioned: signals.fcc_mentioned,
    shipping_doc_offered: signals.shipping_doc_offered,
    brand_model_matches_recall_seed: false,
    implied_wh_per_km: null,
    text_has_diy_kit: signals.text_has_diy_kit,
    text_has_used: signals.text_has_used,
    family: candidate.family,
  };

  if (fields.claimed_range_km !== null) {
    fields.effective_range_km = round(fields.claimed_range_km * derate, 2);
  } else fields.effective_range_km = null;
  if (fields.battery_wh !== null && fields.claimed_range_km) {
    fields.implied_wh_per_km = round(fields.battery_wh / fields.claimed_range_km, 2);
  }
  // Detail page read but no cell brand/BMS evidence ⇒ affirmative no_cell_info (drives RF03),
  // never assume a good cell from silence.
  if (candidate.detail_available && fields.cell_tier === null) fields.cell_tier = 'no_cell_info';
  fields.spec_field_count = countSpecFields(fields);
  fields.brand_model_matches_recall_seed = recallMatch(candidate.title, spec);
  return fields;
}

function countSpecFields(fields) {
  const checks = [
    fields.motor_w_total !== null,
    fields.battery_v !== null,
    fields.battery_ah !== null || fields.battery_wh !== null,
    fields.claimed_range_km !== null,
    fields.top_speed_kmh !== null,
    fields.max_load_kg !== null,
    fields.brake_type !== null,
    fields.charge_time_h !== null,
  ];
  return checks.filter(Boolean).length;
}

function recallMatch(title, spec) {
  const text = String(title || '');
  for (const entry of spec.recall_seed || []) {
    const keys = entry.match_keys || [];
    const matched = keys.filter((key) => key && text.toLowerCase().includes(String(key).toLowerCase()));
    if (matched.length >= Math.min(2, keys.length) && matched.length > 0) return true;
  }
  return false;
}

/**
 * Cert evidence tier A-E per scoring.json cert_evidence_tiers.
 * Search-only: a named in-scope standard is C; noise only is D; nothing is unknown (null).
 * Detail read: no mention ⇒ E (affirmative absence), explicit “无/其他” ⇒ E.
 */
export function deriveCertTier(signals, family, detailAvailable = false) {
  const system = (signals.cert_system || []).filter((c) => c.id !== 'UN383');
  const noise = signals.cert_noise || [];
  if (system.length > 0) {
    // Text-only claim cannot reach A/B (needs certificate number + issuing body verification).
    return 'C';
  }
  if (noise.length > 0) return 'D';
  // Detail page was fully read: "no certification text anywhere" is affirmative absence (tier E).
  if (signals.explicit_no_cert || detailAvailable) return 'E';
  return null; // search-only: absence of a claim is NOT evidence of absence
}

// ---------------------------------------------------------------------------
// 6. Market context (family medians from the live scan)
// ---------------------------------------------------------------------------

export function buildMarketContext(offers, { spec, candidates = [], scoringFamilies }) {
  const buckets = {};
  for (const candidate of candidates) {
    if (!candidate.family) continue;
    if (!buckets[candidate.family]) buckets[candidate.family] = { prices: [], motors: [], sales: [], rr: [] };
    if (typeof candidate.price_cny === 'number') buckets[candidate.family].prices.push(candidate.price_cny);
    if (typeof candidate.signals?.motor_w_total === 'number') buckets[candidate.family].motors.push(candidate.signals.motor_w_total);
    if (typeof candidate.sales === 'number') buckets[candidate.family].sales.push(candidate.sales);
    if (typeof candidate.rr_percent === 'number') buckets[candidate.family].rr.push(candidate.rr_percent);
  }
  const families = {};
  for (const familyId of Object.keys(spec.families)) {
    const bucket = buckets[familyId] || { prices: [], motors: [], sales: [], rr: [] };
    const prior = spec.families[familyId]?.price_prior_cny?.p50 ?? null;
    const medianPrice = bucket.prices.length >= 3 ? median(bucket.prices) : prior;
    families[familyId] = {
      family: familyId,
      label_zh: spec.families[familyId]?.label_zh || familyId,
      offer_count: bucket.prices.length,
      median_price_cny: medianPrice === null ? null : round(medianPrice, 2),
      median_price_basis: bucket.prices.length >= 3 ? 'live_scan_median' : prior !== null ? 'price_prior_p50' : 'unavailable',
      median_motor_w: bucket.motors.length >= 3 ? median(bucket.motors) : null,
      median_sales: median(bucket.sales),
      median_rr_percent: median(bucket.rr),
    };
  }
  return { families, generated_from: 'live scan (offers_classified + market_items)' };
}

// ---------------------------------------------------------------------------
// 7. Formula mini-language executor
// ---------------------------------------------------------------------------

/** Resolve a `{ref}` value expression: literal, bare field, dotted spec path, or `k * path`. */
export function resolveRefValue(ref, context) {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === 'number' || typeof ref === 'boolean') return ref;
  if (Array.isArray(ref)) {
    return ref.map((item) =>
      item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'ref')
        ? resolveRefValue(item.ref, context)
        : item
    );
  }
  if (typeof ref === 'object') {
    if (Object.prototype.hasOwnProperty.call(ref, 'ref')) return resolveRefValue(ref.ref, context);
    return null;
  }
  let expression = String(ref).trim();
  const confirmedFamily = context.family || context.confirmedFamily;
  expression = expression.replace(/<confirmed_family>/g, confirmedFamily || '');

  const multiply = expression.match(/^(-?\d+(?:\.\d+)?)\s*\*\s*([A-Za-z0-9_.<>]+)$/);
  if (multiply) {
    const factor = Number(multiply[1]);
    const value = resolveRefValue(multiply[2], context);
    return typeof value === 'number' ? factor * value : null;
  }
  const divide = expression.match(/^([A-Za-z0-9_.<>]+)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (divide) {
    const value = resolveRefValue(divide[1], context);
    return typeof value === 'number' && Number(divide[2]) !== 0 ? value / Number(divide[2]) : null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression);
  if (/^true$/i.test(expression)) return true;
  if (/^false$/i.test(expression)) return false;

  if (expression.startsWith('families.')) {
    const parts = expression.split('.');
    const familyId = parts[1];
    let node = context.spec?.families?.[familyId];
    for (const key of parts.slice(2)) {
      if (node === null || node === undefined) return null;
      node = node[key];
    }
    return node === undefined ? null : node;
  }
  if (Object.prototype.hasOwnProperty.call(context.fields || {}, expression)) return context.fields[expression];
  return null;
}

/** Condition values are literals by default; only `{ref: ...}` objects are evaluated. */
function literalOrRef(value, context) {
  if (Array.isArray(value)) return value.map((item) => literalOrRef(item, context));
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ref')) {
    return resolveRefValue(value, context);
  }
  return value;
}

function resolveMissingValue(valueOrRef, context) {
  if (valueOrRef && typeof valueOrRef === 'object' && Object.prototype.hasOwnProperty.call(valueOrRef, 'ref')) {
    return resolveRefValue(valueOrRef.ref, context);
  }
  // missing_behavior values like "families.<confirmed_family>.brake_design_default" are refs too.
  if (typeof valueOrRef === 'string') return resolveRefValue(valueOrRef, context);
  return valueOrRef;
}

/**
 * Evaluate one metric formula to `{score, known, missing, evidence}`.
 */
export function evaluateFormula(formula, metric, context) {
  const fields = context.fields || {};
  const missingBehavior = metric.missing_behavior || {};
  const readInput = (name) => {
    if (!name) return null;
    const value = Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : null;
    return value === undefined ? null : value;
  };

  const finish = (score, known, missing = null, evidence = '') => ({
    score: round(clamp(Number.isFinite(score) ? score : 0), 2),
    known,
    missing,
    evidence,
  });

  const handleMissing = () => {
    const detailAvailable = Boolean(fields.detail_text_available);
    const hasAbsent =
      missingBehavior.absent_value !== undefined ||
      missingBehavior.absent_value_ref !== undefined ||
      missingBehavior.absence_override !== undefined;
    if (detailAvailable && hasAbsent) {
      const absent =
        missingBehavior.absent_value !== undefined
          ? missingBehavior.absent_value
          : resolveMissingValue(missingBehavior.absent_value_ref, context);
      const score = typeof absent === 'number' ? absent : 20;
      return finish(score, true, 'absent', '字段在已读详情中未出现 → 采用 absent_value（缺失本身是弱信号，非证明）');
    }
    const unavailable =
      missingBehavior.unavailable_value !== undefined
        ? missingBehavior.unavailable_value
        : resolveMissingValue(missingBehavior.unavailable_value_ref, context);
    const score = typeof unavailable === 'number' ? unavailable : 50;
    return finish(score, false, 'unavailable', '字段不可用（未读详情/搜索响应无此字段）→ 中性值');
  };

  if (!formula || !formula.type) return handleMissing();

  switch (formula.type) {
    case 'family_override': {
      const base = { ...(formula.base_formula || {}) };
      const overridePath = formula.override_path;
      const override = context.family && overridePath
        ? context.spec?.families?.[context.family]?.anchor_overrides?.[overridePath]
        : null;
      if (Array.isArray(override)) base.anchors = override;
      return evaluateFormula(base, metric, context);
    }
    case 'piecewise_linear':
    case 'piecewise_linear_log10': {
      const raw = readInput(formula.input);
      if (raw === null || raw === undefined || raw === '') return handleMissing();
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return handleMissing();
      const x = formula.type === 'piecewise_linear_log10' ? Math.log10(Math.max(numeric, 1)) : numeric;
      const score = interpolateAnchors(formula.anchors || [], x);
      if (score === null) return handleMissing();
      return finish(clamp(score, ...(formula.clamp || [0, 100])), true, null, `${formula.type}(${raw})→${round(score, 2)}`);
    }
    case 'categorical': {
      const raw = readInput(formula.input);
      if (raw === null || raw === undefined || raw === '') return handleMissing();
      const key = String(raw);
      const map = formula.map || {};
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        const known = key !== 'unknown';
        return finish(map[key], known, null, `map[${key}]=${map[key]}`);
      }
      const fallback = formula.default !== undefined ? formula.default : 50;
      return finish(fallback, key !== 'unknown', null, `categorical ${key} 未映射 → default ${fallback}`);
    }
    case 'ratio_piecewise': {
      const numerator = readMultiple(formula.numerator, fields);
      const denominator = readMultiple(formula.denominator, fields);
      if (
        numerator === null ||
        denominator === null ||
        denominator === undefined ||
        denominator === 0 ||
        !Number.isFinite(Number(numerator)) ||
        !Number.isFinite(Number(denominator))
      ) {
        const fallback = formula.fallback;
        if (typeof fallback === 'number') return finish(fallback, false, 'fallback', '比值不可算 → fallback 中性值');
        if (typeof fallback === 'string') {
          const fallbackFormula = resolveRefValue(fallback, context);
          if (fallbackFormula && fallbackFormula.type) {
            return evaluateFormula(fallbackFormula, metric, { ...context, fields: { ...fields, price_cny: numerator ?? fields.price_cny } });
          }
        }
        return handleMissing();
      }
      const ratio = Number(numerator) / Number(denominator);
      const score = interpolateAnchors(formula.anchors || [], ratio);
      if (score === null) return handleMissing();
      return finish(clamp(score, ...(formula.clamp || [0, 100])), true, null, `ratio=${round(ratio, 3)}→${round(score, 2)}`);
    }
    case 'boolean': {
      const raw = readInput(formula.input);
      if (raw === null || raw === undefined) return handleMissing();
      const truthy = raw === true || raw === 'true' || raw === '是';
      const score = truthy ? formula.true_value : formula.false_value;
      return finish(score, true, null, `boolean(${raw})→${score}`);
    }
    case 'count_true_score': {
      const flags = readInput(formula.input);
      if (flags === null || flags === undefined || typeof flags !== 'object') return handleMissing();
      const names = formula.fields || Object.keys(flags);
      const count = names.filter((name) => flags[name] === true).length;
      if (count === 0 && fields.detail_text_available && missingBehavior.absence_override) {
        const absent = resolveMissingValue(missingBehavior.absent_value, context);
        return finish(typeof absent === 'number' ? absent : 20, true, 'absent', '详情已读但仍无任何保护项声明 → absent_value（弱证据）');
      }
      const unit = formula.unit_points ?? 20;
      const max = formula.max ?? 100;
      return finish(Math.min(max, unit * count), true, null, `${count} 项保护功能 → ${Math.min(max, unit * count)}`);
    }
    case 'coverage_score': {
      const raw = readInput(formula.input);
      if (raw === null || raw === undefined) return handleMissing();
      const expected = formula.expected_count || 8;
      const max = formula.max ?? 100;
      const score = (Number(raw) / expected) * max;
      return finish(score, true, null, `coverage ${raw}/${expected}`);
    }
    case 'cert_tier_score': {
      const raw = readInput(formula.input);
      if (raw === null || raw === undefined || raw === '') return handleMissing();
      const tier = String(raw);
      const score = formula.tier_scores?.[tier];
      if (score === undefined) return handleMissing();
      return finish(score, true, null, `cert tier ${tier} → ${score}`);
    }
    default:
      return handleMissing();
  }
}

function readMultiple(names, fields) {
  if (!names) return null;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = fields[name];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Piecewise-linear interpolation with clamping outside the anchor range. */
export function interpolateAnchors(anchors, x) {
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  const points = anchors
    .map((pair) => (Array.isArray(pair) ? { x: Number(pair[0]), y: Number(pair[1]) } : { x: Number(pair.value), y: Number(pair.score) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (points.length === 0) return null;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[points.length - 1].x) return points[points.length - 1].y;
  for (let i = 1; i < points.length; i += 1) {
    const left = points[i - 1];
    const right = points[i];
    if (x >= left.x && x <= right.x) {
      const span = right.x - left.x;
      if (span === 0) return right.y;
      return left.y + ((x - left.x) / span) * (right.y - left.y);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 8. Declarative red flags + verdict tiers
// ---------------------------------------------------------------------------

/** Evaluate a red-flag `when` condition tree against candidate fields. */
export function evaluateCondition(condition, context) {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition.all)) return condition.all.every((child) => evaluateCondition(child, context));
  if (Array.isArray(condition.any)) return condition.any.some((child) => evaluateCondition(child, context));
  const { field, op } = condition;
  if (!op) return false;
  const actual = context.fields ? context.fields[field] : undefined;
  const expected = literalOrRef(condition.value, context);

  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'lt':
      return actual !== null && actual !== undefined && typeof expected === 'number' && actual < expected;
    case 'lte':
      return actual !== null && actual !== undefined && typeof expected === 'number' && actual <= expected;
    case 'gt':
      return actual !== null && actual !== undefined && typeof expected === 'number' && actual > expected;
    case 'gte':
      return actual !== null && actual !== undefined && typeof expected === 'number' && actual >= expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(actual);
    case 'empty':
      return actual === null || actual === undefined || actual === '';
    case 'not_empty':
      return !(actual === null || actual === undefined || actual === '');
    default:
      return false;
  }
}

/** Fire red flags and compute total penalty + tier caps. */
export function evaluateRedFlags(candidate, spec) {
  const context = {
    fields: candidate.fields,
    family: candidate.family,
    confirmedFamily: spec.product?.confirmed_family,
    spec,
  };
  const fired = [];
  for (const flag of spec.red_flags) {
    if (!evaluateCondition(flag.when, context)) continue;
    let capTier = flag.cap_tier ?? null;
    for (const rule of flag.cap_tier_rule || []) {
      if (evaluateCondition(rule.when, context)) {
        capTier = worseTier(capTier, rule.cap_tier);
      }
    }
    fired.push({
      id: flag.id,
      name_zh: flag.name_zh || flag.id,
      penalty: Math.abs(Number(flag.penalty) || 0),
      cap_tier: capTier,
      reason_zh: flag.reason_zh || '',
      citations: flag.citations || [],
    });
  }
  const totalPenalty = Math.min(Number(spec.raw?.score_assembly?.penalty_cap) || 45, fired.reduce((sum, f) => sum + f.penalty, 0));
  return { fired, total_penalty: round(totalPenalty, 2) };
}

const TIER_ORDER = ['A', 'B', 'C', 'AVOID', 'UNRANKABLE'];
function tierRank(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? TIER_ORDER.length : idx;
}
function worseTier(a, b) {
  if (!a) return b;
  if (!b) return a;
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** Tier from final score + caps + confidence caps + auto_avoid rules. */
export function assignVerdictTier({ finalScore, safetyScore, confidence, redFlags, spec, rankability }) {
  const tiers = spec.verdict_tiers || {};
  const confidenceCaps = tiers.confidence_caps || [];
  const autoAvoid = tiers.auto_avoid || { rules: [] };
  const firedIds = redFlags.map((flag) => flag.id);

  let autoAvoided = false;
  for (const rule of autoAvoid.rules || []) {
    if (Array.isArray(rule.any_flag_in) && rule.any_flag_in.some((id) => firedIds.includes(id))) autoAvoided = true;
    if (rule.at_least && rule.flags && rule.flags.filter((id) => firedIds.includes(id)).length >= rule.at_least) {
      autoAvoided = true;
    }
  }

  let capTier = null;
  for (const flag of redFlags) capTier = worseTier(capTier, flag.cap_tier || null);
  for (const cap of confidenceCaps) {
    if (confidence < Number(cap.below_confidence)) capTier = worseTier(capTier, cap.max_tier);
  }

  if (rankability && rankability.rankable === false) {
    return { tier: 'UNRANKABLE', label_zh: tiers.UNRANKABLE?.label_zh || '不参与排名', reason: rankability.reason, auto_avoid: false };
  }

  let tier;
  const scoreThresholdA = Number((tiers.A?.condition || '').match(/final_score >= (\d+)/)?.[1] ?? 75);
  const scoreThresholdB = Number((tiers.B?.condition || '').match(/(\d+) <= final_score/)?.[1] ?? 60);
  const scoreThresholdC = Number((tiers.C?.condition || '').match(/(\d+) <= final_score/)?.[1] ?? 45);
  const safetyThresholdA = Number((tiers.A?.condition || '').match(/D_safety >= (\d+)/)?.[1] ?? 60);
  const confidenceThresholdA = Number((tiers.A?.condition || '').match(/confidence >= ([\d.]+)/)?.[1] ?? 0.6);
  const capAppliedByA = Boolean(capTier);

  if (autoAvoided) tier = 'AVOID';
  else if (
    finalScore >= scoreThresholdA &&
    (safetyScore === null || safetyScore >= safetyThresholdA) &&
    confidence >= confidenceThresholdA &&
    !capAppliedByA
  ) {
    tier = 'A';
  } else if (finalScore >= scoreThresholdB) tier = 'B';
  else if (finalScore >= scoreThresholdC) tier = 'C';
  else tier = 'AVOID';

  const beforeCap = tier;
  tier = worseTier(tier, capTier);

  const reasons = [];
  if (autoAvoided) reasons.push('命中 auto_avoid 规则');
  if (beforeCap === 'A' && tier !== 'A') reasons.push('A 档条件未全部满足或触发封顶');
  if (capTier) reasons.push(`红线/置信度封顶 ${capTier}`);
  reasons.push(`final=${round(finalScore, 1)}, D_safety=${safetyScore === null ? 'unknown' : round(safetyScore, 1)}, confidence=${round(confidence, 3)}`);

  return {
    tier,
    label_zh: tiers[tier]?.label_zh || tier,
    label_en: tiers[tier]?.label_en || '',
    reason: reasons.join('；'),
    auto_avoid: autoAvoided,
    cap_tier: capTier,
  };
}

// ---------------------------------------------------------------------------
// 9. Rankability gate (toy-vs-family disambiguation + family matching)
// ---------------------------------------------------------------------------

export function determineRankability(candidate, spec) {
  const fields = candidate.fields || {};
  if (!candidate.family) {
    const basis = candidate.family_basis || 'family_mismatch';
    const reasonByBasis = {
      parts: '配件/零部件，不是可骑乘整车',
      parts_accessories: '配件/零部件，不是可骑乘整车',
      human_powered_freeline: '人力漂移板（无电机/无续航），不属于电动品类',
      non_electric: '人力/无动力产品，不属于电动品类',
      dataset_short_family_excluded: '市场扫描判定为配件/噪音/人力板，不参与排名',
      market_scan_class_map_excluded: '市场扫描判定为配件/噪音/人力板，不参与排名',
      unrelated_noise: '与产品家族无关的噪音商品',
      no_family_match: '无法归入任何产品家族',
    };
    return { rankable: false, code: 'FAMILY_MISMATCH', reason: reasonByBasis[basis] || '与产品家族不匹配' };
  }

  const speed = typeof fields.top_speed_kmh === 'number' ? fields.top_speed_kmh : null;
  const load = typeof fields.max_load_kg === 'number' ? fields.max_load_kg : null;
  const ageTarget = fields.age_target;

  // scoring.json toy_vs_family_disambiguation: TOY_CLASS → exclude for adult buyer.
  const toyClass =
    ageTarget === 'child' &&
    (speed === null || speed <= 16) &&
    (load === null || load < 60);
  if (toyClass) {
    return {
      rankable: false,
      code: 'TOY_CLASS',
      reason: '儿童/玩具类乘骑产品（成人买家类目错配，不是"差"）',
    };
  }

  if (fields.text_has_diy_kit === true) {
    return { rankable: true }; // auto_avoid AVOID handles it, keep visible in ranking as AVOID
  }
  return { rankable: true };
}

// ---------------------------------------------------------------------------
// 10. Candidate scoring
// ---------------------------------------------------------------------------

/** Score one candidate under the canonical spec. */
export function scoreCandidate(candidate, spec) {
  const context = {
    fields: candidate.fields,
    family: candidate.family,
    confirmedFamily: spec.product?.confirmed_family,
    spec,
  };
  const criteria = [];
  let weightedBase = 0;
  let confidence = 0;

  for (const criterion of spec.criteria) {
    const metrics = criterion.metrics.map((metric) => {
      const result = evaluateFormula(metric.formula, metric, context);
      let score = result.score;
      // formula_extensions.bonus_rule (optional post-processing)
      const bonus = metric.formula?.bonus_rule;
      if (bonus && bonus.field && Object.prototype.hasOwnProperty.call(context.fields, bonus.field)) {
        const value = context.fields[bonus.field];
        if (typeof value === 'number' && value >= bonus.gte) {
          score = clamp(score + (bonus.add || 0), 0, bonus.cap ?? 100);
        }
      }
      return {
        id: metric.id,
        name_zh: metric.name_zh || metric.id,
        local_weight: round(metric.local_weight, 4),
        score: round(score, 2),
        known: result.known,
        missing: result.missing,
        evidence: result.evidence,
        input_fields: metric.input_fields || [],
        formula_type: metric.formula?.type || null,
      };
    });
    const criterionScore = metrics.reduce((sum, m) => sum + m.local_weight * m.score, 0);
    const knownRatio = metrics.reduce((sum, m) => sum + (m.known ? m.local_weight : 0), 0);
    criteria.push({
      id: criterion.id,
      letter: criterion.letter,
      name_zh: criterion.name_zh,
      name_en: criterion.name_en,
      weight: round(criterion.weight, 4),
      score: round(criterionScore, 2),
      known_ratio: round(knownRatio, 3),
      evidence_grade: criterion.evidence_grade,
      metrics,
    });
    weightedBase += criterion.weight * criterionScore;
    confidence += criterion.weight * knownRatio;
  }

  const flags = evaluateRedFlags(candidate, spec);
  const finalScore = round(clamp(weightedBase - flags.total_penalty, 0, 100), 1);
  const safetyCriterion = criteria.find((criterion) => criterion.letter === 'D');
  const safetyScore = safetyCriterion ? safetyCriterion.score : null;
  const rankability = candidate.rankability || determineRankability(candidate, spec);
  const verdict = assignVerdictTier({
    finalScore,
    safetyScore,
    confidence: round(confidence, 3),
    redFlags: flags.fired,
    spec,
    rankability,
  });

  return {
    criteria,
    weighted_score: round(weightedBase, 2),
    penalty_total: flags.total_penalty,
    final_score: finalScore,
    safety_score: safetyScore === null ? null : round(safetyScore, 2),
    confidence: round(confidence, 3),
    red_flags: flags.fired,
    tier: verdict.tier,
    tier_label: verdict.label_zh,
    tier_label_en: verdict.label_en,
    tier_reason: verdict.reason,
    auto_avoid: verdict.auto_avoid,
    cap_tier: verdict.cap_tier,
  };
}

// ---------------------------------------------------------------------------
// 11. Portal rows, provider aggregation, orchestration
// ---------------------------------------------------------------------------

/** Map a OneBound trend portal result row to a candidate. */
export function candidateFromPortalRow(row, { spec, offerCandidate = null, requestId = null } = {}) {
  const title = row.product_title || '';
  const shopRaw = row.shop_name || row.seller_nick || null;
  const maskedShop = Boolean(shopRaw && /^_sopid@/i.test(shopRaw));
  if (offerCandidate) {
    return {
      ...offerCandidate,
      id: `portal:${row.platform || 'unknown'}:${row.product_id}`,
      platform: row.platform || '1688',
      sources: dedupe([...(offerCandidate.sources || []), 'onebound-trend-portal']),
      url: row.product_url || offerCandidate.url,
      image_url: row.image_url || offerCandidate.image_url,
      shop: offerCandidate.shop || shopRaw,
      shop_masked: maskedShop && !offerCandidate.shop,
      platform_price_cny: typeof row.price === 'number' ? row.price : null,
      portal_row_id: row.id ?? null,
      request_id: requestId,
      joined_with: 'justoneapi-search+detail',
      effective_scope: 'portal search (rows have no specs)',
      evidence: [
        ...(offerCandidate.evidence || []),
        {
          kind: 'portal-result-row',
          platform: row.platform || null,
          product_id: row.product_id || null,
          portal_row_id: row.id ?? null,
          request_id: requestId,
          url: row.product_url || null,
        },
      ],
    };
  }

  const familyResolution = resolveScoringFamily(title, {}, spec);
  const signals = extractSignals(title, {}, { family: familyResolution.family });
  const candidate = {
    id: `portal:${row.platform || 'unknown'}:${row.product_id || row.id}`,
    provider_key: `${row.platform || 'unknown'}:${normalizeShopKey(shopRaw) || `product:${row.product_id}`}`,
    platform: row.platform || 'unknown',
    sources: ['onebound-trend-portal'],
    offer_id: row.product_id ? String(row.product_id) : null,
    title,
    shop: shopRaw,
    shop_masked: maskedShop,
    province: null,
    url: row.product_url || null,
    image_url: row.image_url || null,
    keyword: null,
    price_cny: typeof row.price === 'number' ? row.price : null,
    price_basis: 'portal_row',
    sales: null,
    rr_percent: null,
    moq: null,
    family: familyResolution.family,
    family_basis: familyResolution.basis,
    dataset_family: null,
    scan_class: null,
    rideable: null,
    audience: signals.age_target,
    evidence_scope: 'portal-row',
    detail_available: false,
    detail_attributes: {},
    signals,
    fields: {},
    evidence: [
      {
        kind: 'portal-result-row',
        platform: row.platform || null,
        product_id: row.product_id || null,
        portal_row_id: row.id ?? null,
        request_id: requestId,
        url: row.product_url || null,
      },
    ],
    portal_row_id: row.id ?? null,
    request_id: requestId,
    raw: row,
  };
  candidate.fields = assembleFields(candidate, { spec, marketContext: null });
  return candidate;
}

/** Group scored candidates into providers (one row per shop / platform identity). */
export function aggregateProviders(candidates, spec) {
  const groups = new Map();
  for (const candidate of candidates) {
    // Scores are only comparable within one family (scoring_mode=per_offer_family), so a
    // provider is ranked per (platform, family, shop) — the same shop can appear in two families.
    const key = `${candidate.platform || 'unknown'}::${candidate.family || 'unknown'}::${
      normalizeShopKey(candidate.shop) || candidate.provider_key
    }`;
    if (!groups.has(key)) {
      groups.set(key, {
        provider_key: key,
        shop: candidate.shop,
        shop_masked: Boolean(candidate.shop_masked),
        platform: candidate.platform,
        province: candidate.province,
        family: candidate.family,
        candidates: [],
      });
    }
    const group = groups.get(key);
    group.candidates.push(candidate);
    if (!group.province && candidate.province) group.province = candidate.province;
  }

  const providers = [];
  for (const group of groups.values()) {
    // Representative listing: prefer the listing we actually read (detail evidence) so a provider
    // is not represented by its least-documented listing; then highest score; then lowest price.
    const sortedCandidates = [...group.candidates].sort(
      (a, b) =>
        Number(Boolean(b.detail_available)) - Number(Boolean(a.detail_available)) ||
        (b.score?.final_score ?? -1) - (a.score?.final_score ?? -1) ||
        (a.price_cny ?? Infinity) - (b.price_cny ?? Infinity)
    );
    const representative = sortedCandidates[0];
    providers.push({
      ...group,
      family: representative.family,
      representative,
      candidates: sortedCandidates,
      best_score: representative.score?.final_score ?? null,
      offer_count: sortedCandidates.length,
      price_min: minOf(sortedCandidates.map((c) => c.price_cny)),
      price_max: maxOf(sortedCandidates.map((c) => c.price_cny)),
      sales_sum: sortedCandidates.reduce((sum, c) => sum + (c.sales || 0), 0),
      detail_enriched: sortedCandidates.some((c) => c.detail_available),
      sources: dedupe(sortedCandidates.flatMap((c) => c.sources || [])),
    });
  }
  return providers;
}

function minOf(values) {
  const nums = values.filter((v) => typeof v === 'number');
  return nums.length ? Math.min(...nums) : null;
}
function maxOf(values) {
  const nums = values.filter((v) => typeof v === 'number');
  return nums.length ? Math.max(...nums) : null;
}

/** Collect portal result rows from a saved E2E receipt. */
export function collectPortalRows(portal) {
  if (!portal) return [];
  const rows = [];
  for (const receipt of portal.search_receipts || []) {
    for (const row of receipt.rows || []) {
      rows.push({ row, request_id: receipt.request_id ?? null });
    }
  }
  return rows;
}

function buildQuotaLedger(portal) {
  if (!portal) {
    return {
      available: false,
      note: '未提供 OneBound 门户 E2E 回执（data/portal_e2e.json）；门户比价额度与命中情况未知。',
      receipts: [],
    };
  }
  const receipts = (portal.search_receipts || []).map((receipt) => ({
    request_id: receipt.request_id ?? null,
    seed: receipt.seed ?? null,
    mode: receipt.request?.query_mode ?? null,
    platform_scope: receipt.request?.platform_scope ?? null,
    status: receipt.request?.status ?? null,
    http: receipt.http ?? null,
    results_total: receipt.results_total ?? (receipt.rows || []).length,
    quota_after: receipt.quota_after ?? null,
  }));
  const quotaAfter = portal.quota_after || {};
  const remaining = typeof quotaAfter.searchesRemaining === 'number' ? quotaAfter.searchesRemaining : null;
  return {
    available: true,
    source_file: 'data/portal_e2e.json',
    plan: portal.membership?.plan ?? null,
    plan_label: portal.membership?.label ?? null,
    is_pro: quotaAfter.isPro ?? null,
    searches_remaining: remaining,
    monitors_remaining: quotaAfter.monitorsRemaining ?? null,
    exhausted: remaining !== null && remaining <= 0,
    free_tier_note:
      portal.free_quota_note ||
      '商品比价在免费版属 Pro 功能，仅 2 次试用且不每日重置；额度 0 时 POST 会返回 quota_exhausted flash。',
    receipts,
  };
}

/** Provenance info for the run (data files + scoring + family selection). */
function buildProvenance(input, spec) {
  return {
    generated_by: '1688-ops provider-radar',
    schema_version: RADAR_SCHEMA_VERSION,
    scoring: {
      source_file: 'data/scoring.json',
      version: spec.version,
      schema_version: spec.schema_version,
      criteria_weights: Object.fromEntries(spec.criteria.map((c) => [c.id, round(c.weight, 2)])),
      families: Object.keys(spec.families),
      red_flag_count: spec.red_flags.length,
      validation: validateScoringSpec(spec),
    },
    files: input.provenance?.files || [],
    notes: input.provenance?.notes || [],
    portal_contract: input.portal?.contract ? { captured_at: input.portal.captured_at || null, endpoint_base: input.portal.endpoint_base || null } : null,
    provider_detail_note:
      'data/provider_details.json = 4 家供应商的真实 1688 详情属性（Lead 采集）；其余 offer 只有搜索行，缺失字段按 unknown 处理。',
  };
}

/**
 * Run the provider radar over local datasets (pure).
 */
export function runProviderRadar(input) {
  const spec = input.spec || loadScoringSpec(input.scoring);
  const generatedAt = input.generatedAt || new Date().toISOString();
  const options = input.options || {};
  const confirmedFamily = spec.product?.confirmed_family || spec.product?.fallback_family_order?.[0] || null;
  const fallbackOrder = spec.product?.fallback_family_order || [confirmedFamily].filter(Boolean);
  const offers = input.classified?.offers || [];
  const marketItems = input.marketItems || [];
  const providerDetails = input.providerDetails || [];
  const detailsById = new Map(providerDetails.filter((d) => d && d.offer_id).map((d) => [String(d.offer_id), d]));
  const marketItemsById = new Map(marketItems.filter((item) => item && item.offer_id).map((item) => [String(item.offer_id), item]));

  // ---- portal rows first (they prove the OneBound path), joined with 1688 dataset ----
  const offerPreview = offers.map((offer) => {
    const marketItem = marketItemsById.get(String(offer.offer_id)) || null;
    const detail = detailsById.get(String(offer.offer_id)) || null;
    return buildOfferCandidate(offer, { marketItem, providerDetail: detail, spec });
  });
  const offerById = new Map(offerPreview.filter((c) => c.offer_id).map((c) => [String(c.offer_id), c]));

  const portalRows = collectPortalRows(input.portal);
  const portalByProduct = new Map();
  for (const entry of portalRows) {
    if (entry.row.product_id) portalByProduct.set(String(entry.row.product_id), entry);
  }

  // Attach OneBound portal evidence to the matching 1688 offer (same product_id) — the task's
  // "1688 matches joined with JustOneAPI data where present".
  let portalJoined = 0;
  for (const candidate of offerPreview) {
    const hit = portalByProduct.get(String(candidate.offer_id));
    if (!hit) continue;
    candidate.sources = dedupe([...(candidate.sources || []), 'onebound-trend-portal']);
    candidate.joined_with = 'onebound-trend-portal+justoneapi';
    candidate.platform_price_cny = typeof hit.row.price === 'number' ? hit.row.price : null;
    candidate.evidence.push({
      kind: 'portal-result-row',
      platform: hit.row.platform || null,
      product_id: hit.row.product_id || null,
      portal_row_id: hit.row.id ?? null,
      request_id: hit.request_id,
      url: hit.row.product_url || null,
    });
    portalJoined += 1;
  }
  const portalOnlyCandidates = portalRows
    .filter(({ row }) => !offerById.has(String(row.product_id || '')))
    .map(({ row, request_id }) => candidateFromPortalRow(row, { spec, requestId: request_id }));

  // ---- market context: medians per scoring family from the scan ----
  const allCandidates = [...offerPreview, ...portalOnlyCandidates];
  const marketContext = buildMarketContext(offers, { spec, candidates: allCandidates });
  const withContext = allCandidates.map((candidate) => ({
    ...candidate,
    fields: assembleFields(candidate, { spec, marketContext }),
  }));

  // ---- destination country context (default CN wholesale buy) ----
  const destination = options.destinationCountry || spec.product?.destination_country || 'CN';
  const contextFields = { destination_country: destination };

  // ---- rankability + scoring ----
  const scored = [];
  const unrankable = [];
  for (const candidate of withContext) {
    candidate.fields = { ...candidate.fields, ...contextFields };
    const rankability = determineRankability(candidate, spec);
    candidate.rankability = rankability;
    if (!rankability.rankable) {
      unrankable.push({
        id: candidate.id,
        provider_key: candidate.provider_key,
        shop: candidate.shop,
        shop_masked: Boolean(candidate.shop_masked),
        platform: candidate.platform,
        title: candidate.title,
        family: candidate.family,
        dataset_family: candidate.dataset_family,
        price_cny: candidate.price_cny,
        code: rankability.code,
        reason: rankability.reason,
        url: candidate.url,
      });
      continue;
    }
    candidate.score = scoreCandidate(candidate, spec);
    if (candidate.score.tier === 'UNRANKABLE') {
      unrankable.push({
        id: candidate.id,
        provider_key: candidate.provider_key,
        shop: candidate.shop,
        shop_masked: Boolean(candidate.shop_masked),
        platform: candidate.platform,
        title: candidate.title,
        family: candidate.family,
        dataset_family: candidate.dataset_family,
        price_cny: candidate.price_cny,
        code: 'UNRANKABLE',
        reason: candidate.score.tier_reason,
        url: candidate.url,
      });
      continue;
    }
    scored.push(candidate);
  }

  const providers = aggregateProviders(scored, spec);
  const familyGroups = buildFamilyGroups(providers, { spec, confirmedFamily, fallbackOrder });
  const ranked = familyGroups.flatMap((group) => group.providers);

  return {
    schema_version: RADAR_SCHEMA_VERSION,
    generated_at: generatedAt,
    seed: normalizeSeed(input.seed, offerPreview),
    product: {
      human_term: spec.product?.human_term || '电子漂移板',
      confirmed_family: confirmedFamily,
      confirmed_family_label: spec.families[confirmedFamily]?.label_zh || confirmedFamily,
      confirmed_family_basis: spec.product?.confirmed_family_basis_zh || null,
      confirmed_family_status: spec.product?.confirmed_family_status || null,
      secondary_family: spec.product?.secondary_family || null,
      fallback_family_order: fallbackOrder,
      scoring_mode: spec.product?.scoring_mode || 'per_offer_family',
      buy_mode: options.buyMode || spec.product?.purchase_mode || 'retail_single',
      destination_country: destination,
      families: Object.entries(spec.families).map(([familyId, family]) => ({
        family: familyId,
        label_zh: family.label_zh,
        label_en: family.label_en,
        range_derate_factor: family.range_derate_factor,
        plausible_max_speed_kmh: family.plausible_max_speed_kmh,
        brake_design_default: family.brake_design_default,
        median_price_cny: marketContext.families[familyId]?.median_price_cny ?? null,
        median_price_basis: marketContext.families[familyId]?.median_price_basis ?? 'unavailable',
        scan_offers: marketContext.families[familyId]?.offer_count ?? 0,
        ranked_providers: familyGroups.find((group) => group.family === familyId)?.providers.length ?? 0,
      })),
    },
    scoring: {
      source: 'data/scoring.json',
      version: spec.version,
      schema_version: spec.schema_version,
      validation: validateScoringSpec(spec),
      criteria: spec.criteria.map((criterion) => ({
        id: criterion.id,
        letter: criterion.letter,
        name_zh: criterion.name_zh,
        weight: round(criterion.weight, 4),
        metrics: criterion.metrics.map((metric) => ({ id: metric.id, name_zh: metric.name_zh, local_weight: round(metric.local_weight, 4) })),
      })),
      red_flags: spec.red_flags.map((flag) => ({
        id: flag.id,
        name_zh: flag.name_zh,
        penalty: flag.penalty,
        cap_tier: flag.cap_tier ?? null,
        reason_zh: flag.reason_zh,
      })),
      verdict_tiers: spec.verdict_tiers,
    },
    provenance: buildProvenance(input, spec),
    quota_ledger: buildQuotaLedger(input.portal),
    market_context: marketContext,
    stats: {
      offers_total: offers.length,
      offers_with_market_item: offerPreview.filter((c) => c.market_item).length,
      offers_detail_enriched: offerPreview.filter((c) => c.detail_available).length,
      portal_rows: portalRows.length,
      portal_rows_joined: portalJoined,
      candidates_scored: scored.length,
      providers_ranked: ranked.length,
      providers_unrankable: new Set(unrankable.map((item) => item.provider_key)).size,
      unrankable_listings: unrankable.length,
      ranked_returned: Math.min(options.maxRanked ?? ranked.length, ranked.length),
    },
    family_groups: familyGroups,
    ranked: ranked.slice(0, options.maxRanked ?? ranked.length),
    unrankable: {
      summary: summarizeUnrankable(unrankable),
      sample: unrankable.slice(0, options.unrankableSampleLimit ?? 25),
      sample_limit: options.unrankableSampleLimit ?? 25,
    },
    warnings: [
      ...(input.provenance?.notes || []),
      destination === 'CN'
        ? 'destination_country 默认 CN（国内批发采购）；跨境评分需 --destination US/EU 才会触发 RF12/RF13。'
        : `destination_country=${destination}，已启用跨境运输/射频红线。`,
    ],
  };
}

function buildFamilyGroups(providers, { spec, confirmedFamily, fallbackOrder }) {
  const familyIds = dedupe([
    confirmedFamily,
    ...fallbackOrder,
    ...providers.map((provider) => provider.family),
  ]).filter((familyId) => familyId && spec.families[familyId]);
  const groups = [];
  let overallRank = 0;
  for (const familyId of familyIds) {
    const familyProviders = providers
      .filter((provider) => provider.family === familyId)
      .sort((a, b) => (b.best_score ?? -1) - (a.best_score ?? -1) || (a.price_min ?? Infinity) - (b.price_min ?? Infinity));
    if (familyProviders.length === 0) continue;
    const role = familyId === confirmedFamily ? 'primary' : fallbackOrder.includes(familyId) ? 'secondary' : 'other';
    const familyConfig = spec.families[familyId];
    const providersOut = familyProviders.map((provider, index) => {
      overallRank += 1;
      return toRankedProvider(provider, {
        spec,
        overallRank,
        familyRank: index + 1,
        familyId,
        familyLabel: familyConfig.label_zh,
        familyRole: role,
      });
    });
    groups.push({
      family: familyId,
      label_zh: familyConfig.label_zh,
      label_en: familyConfig.label_en,
      role,
      range_derate_factor: familyConfig.range_derate_factor,
      plausible_max_speed_kmh: familyConfig.plausible_max_speed_kmh,
      median_price_cny: null,
      providers: providersOut,
    });
  }
  return groups;
}

function toRankedProvider(provider, { spec, overallRank, familyRank, familyId, familyLabel, familyRole }) {
  const representative = provider.representative;
  const score = representative.score;
  return {
    overall_rank: overallRank,
    family_rank: familyRank,
    family: familyId,
    family_label: familyLabel,
    family_role: familyRole,
    provider_key: provider.provider_key,
    shop: provider.shop,
    shop_masked: provider.shop_masked,
    platform: provider.platform,
    sources: provider.sources,
    province: provider.province,
    tier: score.tier,
    tier_label: score.tier_label,
    tier_label_en: score.tier_label_en,
    tier_reason: score.tier_reason,
    auto_avoid: score.auto_avoid,
    final_score: score.final_score,
    weighted_score: score.weighted_score,
    penalty_total: score.penalty_total,
    safety_score: score.safety_score,
    confidence: score.confidence,
    criteria: score.criteria,
    red_flags: score.red_flags,
    offer_count: provider.offer_count,
    price_min: provider.price_min,
    price_max: provider.price_max,
    sales_sum: provider.sales_sum,
    detail_enriched: provider.detail_enriched,
    offer_id: representative.offer_id,
    title: representative.title,
    url: representative.url,
    image_url: representative.image_url,
    price_cny: representative.price_cny,
    price_search_cny: representative.price_search_cny,
    price_detail_cny: representative.price_detail_cny,
    price_basis: representative.price_basis,
    sales: representative.sales,
    rr_percent: representative.rr_percent,
    moq: representative.moq,
    joined_with: representative.joined_with || null,
    evidence_scope: representative.evidence_scope,
    fields: publicFields(representative.fields, representative.signals),
    data_gaps: dataGaps(representative),
    evidence: representative.evidence,
    detail_attributes: representative.detail_available ? representative.detail_attributes : null,
    listing_candidates: provider.candidates.map((candidate) => ({
      offer_id: candidate.offer_id,
      title: candidate.title,
      price_cny: candidate.price_cny,
      sales: candidate.sales,
      rr_percent: candidate.rr_percent,
      family: candidate.family,
      score: candidate.score.final_score,
      tier: candidate.score.tier,
      url: candidate.url,
      sources: candidate.sources,
      detail_available: candidate.detail_available,
    })),
  };
}

function publicFields(fields) {
  const keys = [
    'top_speed_kmh',
    'claimed_range_km',
    'effective_range_km',
    'variant_max_range_km',
    'battery_v',
    'battery_ah',
    'battery_wh',
    'implied_wh_per_km',
    'motor_w_total',
    'max_load_kg',
    'wheel_in',
    'brake_type',
    'tire_type',
    'control_mode',
    'protection_count',
    'cert_best_tier',
    'cert_mentions',
    'cell_tier',
    'ip_rating',
    'charge_time_h',
    'age_target',
    'spec_field_count',
    'shop_years',
    'biz_type',
    'factory_inspection',
    'is_super_factory',
    'is_ad',
    'moq',
  ];
  const out = {};
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) out[key] = value;
  }
  return out;
}

function dataGaps(candidate) {
  const fields = candidate.fields || {};
  const gaps = [];
  if (fields.top_speed_kmh === null) gaps.push('车速未知（未在标题/详情出现）');
  if (fields.claimed_range_km === null) gaps.push('续航未知');
  if (fields.battery_wh === null) gaps.push('电池能量未知（需 V×Ah）');
  if (fields.brake_type === null) gaps.push('制动形式未知（按家族设计默认值处理）');
  if (fields.cert_best_tier === null) gaps.push('认证未验证（只有搜索行数据）');
  if (fields.max_load_kg === null) gaps.push('载重未知');
  if (!candidate.detail_available) gaps.push('详情页未读取 → 所有详情类证据缺失');
  return gaps;
}

function normalizeSeed(seed, offerCandidates) {
  const rawInput = seed?.input || seed?.offer_id || seed?.url || null;
  const offerId =
    seed?.offer_id ||
    (rawInput && String(rawInput).match(/(\d{6,})/) ? String(rawInput).match(/(\d{6,})/)[1] : null);
  const match = offerId ? offerCandidates.find((candidate) => String(candidate.offer_id) === String(offerId)) : null;
  return {
    input: rawInput,
    kind: seed?.kind || (offerId ? 'offer_id' : rawInput ? 'url' : 'unknown'),
    offer_id: offerId,
    url: seed?.url || (offerId ? `https://detail.1688.com/offer/${offerId}.html` : null),
    title: seed?.title || match?.title || null,
    image_url: seed?.image_url || match?.image_url || null,
    family: match?.family || null,
    detail_available: Boolean(match?.detail_available),
  };
}

function summarizeUnrankable(unrankable) {
  const byCode = {};
  for (const item of unrankable) {
    if (!byCode[item.code]) byCode[item.code] = { code: item.code, reason: item.reason, count: 0, providers: new Set() };
    byCode[item.code].count += 1;
    byCode[item.code].providers.add(item.provider_key);
  }
  return Object.values(byCode)
    .map((entry) => ({ code: entry.code, reason: entry.reason, listings: entry.count, providers: entry.providers.size }))
    .sort((a, b) => b.listings - a.listings);
}

// ---------------------------------------------------------------------------
// 12. Dataset loading (local files only)
// ---------------------------------------------------------------------------

export const RADAR_FILE_NAMES = {
  session: 'tmp/trend_session.json',
  portal: 'data/portal_e2e.json',
  classified: 'data/offers_classified.json',
  marketItems: 'data/market_items.json',
  providerDetails: 'data/provider_details.json',
  scoring: 'data/scoring.json',
  rankingReference: 'data/provider_ranking.json',
};

export function resolveRadarDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);
  if (process.env.PROVIDER_RADAR_DIR) return path.resolve(process.env.PROVIDER_RADAR_DIR);
  return path.resolve(process.env.HOME || '.', 'Documents/Cowork/Antigravity Cowork/26.11.13 OneBound Provider Radar');
}

function readJson(filePath, role, files, notes, { required = false } = {}) {
  if (!fs.existsSync(filePath)) {
    notes.push(`${required ? '缺少必需' : '缺少可选'}数据文件 (${role}): ${filePath}`);
    if (required) throw new Error(`缺少必需数据文件: ${filePath} (${role})`);
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath);
    const data = JSON.parse(raw.toString('utf8'));
    files.push({
      role,
      path: filePath,
      bytes: raw.byteLength,
      sha256_12: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
      modified_at: fs.statSync(filePath).mtime.toISOString(),
    });
    return data;
  } catch (err) {
    notes.push(`读取失败 (${role}) ${filePath}: ${err.message}`);
    if (required) throw new Error(`无法解析必需数据文件: ${filePath} — ${err.message}`);
    return null;
  }
}

/** Load all radar datasets from disk. Never performs network IO. */
export function loadRadarDatasets(options = {}) {
  const radarDir = resolveRadarDir(options.dataDir);
  const files = [];
  const notes = [];
  const portal = readJson(options.portalPath || path.join(radarDir, RADAR_FILE_NAMES.portal), 'portal-e2e', files, notes);
  const classified = readJson(
    options.classifiedPath || path.join(radarDir, RADAR_FILE_NAMES.classified),
    'offers-classified',
    files,
    notes,
    { required: true }
  );
  const marketItems = readJson(path.join(radarDir, RADAR_FILE_NAMES.marketItems), 'market-items', files, notes);
  const providerDetails = readJson(path.join(radarDir, RADAR_FILE_NAMES.providerDetails), 'provider-details', files, notes);
  const scoring = readJson(options.scoringPath || path.join(radarDir, RADAR_FILE_NAMES.scoring), 'scoring-rubric', files, notes, {
    required: true,
  });
  return { radarDir, files, notes, portal, classified, marketItems, providerDetails, scoring };
}
