import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadScoringSpec,
  validateScoringSpec,
  interpolateAnchors,
  evaluateFormula,
  evaluateCondition,
  evaluateRedFlags,
  assignVerdictTier,
  resolveScoringFamily,
  classifyAgeTarget,
  deriveCertTier,
  extractSignals,
  buildOfferCandidate,
  candidateFromPortalRow,
  runProviderRadar,
  aggregateProviders,
} from '../src/provider_radar.js';
import { renderRadarDashboard, escapeHtml, safeUrl } from '../src/radar_dashboard.js';
import {
  resolveCredentials,
  ONEBOUND_ITEM_TITLE,
  ONEBOUND_KEY_FIELDS,
  ONEBOUND_SECRET_FIELDS,
  ONEBOUND_FORBIDDEN_KEY_FIELDS,
} from '../src/api_fallback.js';
import {
  PortalSessionClient,
  PortalError,
  buildCookieHeader,
  extractXsrfToken,
  parseInertiaPage,
  detectQuotaExhausted,
  loadSession,
  describeSession,
  extractRequestId,
} from '../src/portal_session.js';

// ---------------------------------------------------------------------------
// Fixtures — a compact but structurally faithful copy of data/scoring.json v1.1.0
// ---------------------------------------------------------------------------

const FIXTURE_SPEC = {
  version: 'test-1.0.0',
  schema_version: 'test/scoring/v1',
  product: {
    human_term: '电子漂移板',
    confirmed_family: 'electric_skateboard',
    confirmed_family_status: 'fixture',
    confirmed_family_basis_zh: 'fixture basis',
    secondary_family: 'electric_scooter',
    fallback_family_order: ['electric_skateboard', 'electric_scooter', 'hoverboard_self_balancing'],
    scoring_mode: 'per_offer_family',
    purchase_mode: 'retail_single',
    destination_country: null,
    market_scan_class_map: {
      electric_skateboard: 'electric_skateboard',
      electric_scooter: 'electric_scooter',
      hoverboard_balance: 'hoverboard_self_balancing',
      electric_drift_trike: 'drift_trike_kart',
      non_electric_drift_board: null,
      parts_accessories: null,
      unrelated_noise: null,
    },
  },
  families: {
    electric_skateboard: {
      label_zh: '电动滑板',
      label_en: 'electric skateboard',
      detect: { include_regex_any: ['电动滑板', 'e-?skate'], exclude_regex_any: ['滑板车', '平衡车'] },
      range_derate_factor: 0.65,
      plausible_max_speed_kmh: 45,
      brake_design_default: 40,
      anchor_overrides: { A1_top_speed: [[0, 0], [10, 20], [20, 60], [35, 90], [45, 100]] },
      price_prior_cny: { p50: 800 },
      fallback_price_formula: {
        type: 'piecewise_linear',
        input: 'price_cny',
        anchors: [[200, 100], [800, 70], [2000, 40]],
      },
    },
    electric_scooter: {
      label_zh: '电动滑板车',
      label_en: 'electric scooter',
      detect: { include_regex_any: ['滑板车', 'scooter'], exclude_regex_any: ['平衡车', '三轮'] },
      range_derate_factor: 0.65,
      plausible_max_speed_kmh: 40,
      brake_design_default: 50,
      anchor_overrides: { A1_top_speed: [[0, 0], [15, 30], [25, 70], [40, 100]] },
      price_prior_cny: { p50: 570 },
    },
    hoverboard_self_balancing: {
      label_zh: '体感平衡车',
      label_en: 'hoverboard',
      detect: { include_regex_any: ['平衡车', '体感'], exclude_regex_any: ['滑板车', '卡丁'] },
      range_derate_factor: 0.65,
      plausible_max_speed_kmh: 25,
      brake_design_default: 50,
      anchor_overrides: { A1_top_speed: [[0, 0], [8, 20], [15, 60], [22, 100]] },
      price_prior_cny: { p50: 494 },
    },
    drift_trike_kart: {
      label_zh: '漂移卡丁车',
      label_en: 'drift trike',
      detect: { include_regex_any: ['卡丁', '三轮'], exclude_regex_any: ['平衡车'] },
      range_derate_factor: 0.7,
      plausible_max_speed_kmh: 60,
      brake_design_default: 30,
      anchor_overrides: {},
      price_prior_cny: { p50: 400 },
    },
    motorized_freeline_board: {
      label_zh: '电动漂移板',
      label_en: 'freeline',
      detect: { include_regex_any: ['分体', '漂移板'], exclude_regex_any: ['平衡车', '卡丁'] },
      range_derate_factor: 0.6,
      plausible_max_speed_kmh: 18,
      brake_design_default: 40,
      anchor_overrides: {},
      price_prior_cny: { p50: 2000 },
    },
  },
  criteria: [
    {
      id: 'A_performance',
      name_zh: '性能',
      name_en: 'performance',
      weight: 0.2,
      evidence_grade: 'B',
      metrics: [
        {
          id: 'A1_top_speed',
          name_zh: '最高速度',
          local_weight: 0.5,
          input_fields: ['top_speed_kmh'],
          formula: {
            type: 'family_override',
            base_formula: {
              type: 'piecewise_linear',
              input: 'top_speed_kmh',
              anchors: [[0, 0], [10, 30], [20, 75], [45, 100]],
              clamp: [0, 100],
            },
            override_path: 'A1_top_speed',
          },
          missing_behavior: { unavailable_value: 50, absent_value: 35 },
        },
        {
          id: 'A2_load',
          name_zh: '载重',
          local_weight: 0.5,
          input_fields: ['max_load_kg'],
          formula: {
            type: 'piecewise_linear',
            input: 'max_load_kg',
            anchors: [[60, 0], [85, 40], [100, 70], [150, 100]],
            clamp: [0, 100],
          },
          missing_behavior: { unavailable_value: 50, absent_value: 30 },
        },
      ],
    },
    {
      id: 'B_range',
      name_zh: '续航',
      name_en: 'range',
      weight: 0.22,
      metrics: [
        {
          id: 'B1_effective_range',
          name_zh: '有效续航',
          local_weight: 0.6,
          input_fields: ['effective_range_km'],
          formula: {
            type: 'piecewise_linear',
            input: 'effective_range_km',
            anchors: [[0, 0], [10, 40], [20, 75], [40, 100]],
            clamp: [0, 100],
          },
          missing_behavior: { unavailable_value: 50, absent_value: 30 },
        },
        {
          id: 'B2_battery_energy',
          name_zh: '电池能量',
          local_weight: 0.4,
          input_fields: ['battery_wh'],
          formula: {
            type: 'piecewise_linear',
            input: 'battery_wh',
            anchors: [[0, 0], [160, 50], [320, 85], [700, 100]],
            clamp: [0, 100],
          },
          missing_behavior: { unavailable_value: 50, absent_value: 30 },
        },
      ],
    },
    {
      id: 'C_affordability',
      name_zh: '价格',
      name_en: 'affordability',
      weight: 0.16,
      metrics: [
        {
          id: 'C1_relative_price',
          name_zh: '相对价格',
          local_weight: 1,
          input_fields: ['price_cny', 'family_median_price_cny'],
          formula: {
            type: 'ratio_piecewise',
            numerator: 'price_cny',
            denominator: 'family_median_price_cny',
            anchors: [[0, 100], [0.5, 95], [1, 70], [2, 20], [3, 0]],
            clamp: [0, 100],
            fallback: 50,
          },
          missing_behavior: { unavailable_value: 50, absent_value: 50 },
        },
      ],
    },
    {
      id: 'D_safety',
      name_zh: '安全',
      name_en: 'safety',
      weight: 0.3,
      evidence_grade: 'A',
      metrics: [
        {
          id: 'D1_certification',
          name_zh: '认证',
          local_weight: 0.5,
          input_fields: ['cert_best_tier'],
          formula: { type: 'cert_tier_score', input: 'cert_best_tier', tier_scores: { A: 100, B: 80, C: 55, D: 30, E: 10 } },
          missing_behavior: { unavailable_value: 50, absent_value: 10, absent_triggers_red_flag: 'RF05_no_cert_at_all' },
        },
        {
          id: 'D2_brake',
          name_zh: '制动',
          local_weight: 0.3,
          input_fields: ['brake_type'],
          formula: {
            type: 'categorical',
            input: 'brake_type',
            map: { front_rear_disc: 95, single_mechanical_disc: 70, electronic_regen_only: 40, none: 0, unknown: 50 },
            default: 50,
          },
          missing_behavior: {
            unavailable_value_ref: 'families.<confirmed_family>.brake_design_default',
            absent_value_ref: 'families.<confirmed_family>.brake_design_default',
          },
        },
        {
          id: 'D3_protection',
          name_zh: '保护项',
          local_weight: 0.2,
          input_fields: ['protection_flags'],
          formula: {
            type: 'count_true_score',
            input: 'protection_flags',
            fields: ['over_speed', 'low_battery', 'charge_lock'],
            unit_points: 33,
            max: 100,
          },
          missing_behavior: { unavailable_value: 50, absent_value: 20, absence_override: 'fixture absence override' },
        },
      ],
    },
    {
      id: 'E_reliability',
      name_zh: '供应商',
      name_en: 'reliability',
      weight: 0.12,
      metrics: [
        {
          id: 'E1_sales',
          name_zh: '销量',
          local_weight: 1,
          input_fields: ['orders_count'],
          formula: {
            type: 'piecewise_linear_log10',
            input: 'orders_count',
            anchors: [[0, 0], [1, 30], [2, 50], [3, 70], [4, 90], [5, 100]],
            clamp: [0, 100],
          },
          missing_behavior: { unavailable_value: 50, absent_value: 35 },
        },
      ],
    },
  ],
  red_flags: [
    {
      id: 'RF01_recalled_model',
      name_zh: '命中召回',
      when: { field: 'brand_model_matches_recall_seed', op: 'eq', value: true },
      penalty: 40,
      cap_tier: 'AVOID',
      reason_zh: '召回',
    },
    {
      id: 'RF02_no_brake_fast',
      name_zh: '无有效刹车却高速',
      when: {
        all: [
          { field: 'brake_type', op: 'in', value: ['none', 'electronic_regen_only'] },
          { field: 'top_speed_kmh', op: 'gte', value: 15 },
        ],
      },
      penalty: 20,
      cap_tier: 'C',
      cap_tier_rule: [{ when: { field: 'top_speed_kmh', op: 'gte', value: 25 }, cap_tier: 'AVOID' }],
      reason_zh: '刹车',
    },
    {
      id: 'RF05_no_cert_at_all',
      name_zh: '完全没有认证表述',
      when: {
        all: [
          { field: 'cert_best_tier', op: 'eq', value: 'E' },
          { field: 'detail_text_available', op: 'eq', value: true },
        ],
      },
      penalty: 15,
      cap_tier: 'C',
      reason_zh: '认证',
    },
    {
      id: 'RF07_bait_price',
      name_zh: '低价高功率',
      when: {
        all: [
          { field: 'price_cny', op: 'lt', value: { ref: '0.5 * family_median_price_cny' } },
          { field: 'motor_w_total', op: 'gte', value: { ref: 'family_median_motor_w' } },
        ],
      },
      penalty: 18,
      cap_tier: 'C',
      reason_zh: 'bait',
    },
    {
      id: 'RF08_no_specs',
      name_zh: '零规格',
      when: { field: 'spec_field_count', op: 'eq', value: 0 },
      penalty: 10,
      cap_tier: 'C',
      reason_zh: '零规格',
    },
    {
      id: 'RF10_diy_kit',
      name_zh: 'DIY',
      when: { field: 'text_has_diy_kit', op: 'eq', value: true },
      penalty: 20,
      cap_tier: 'AVOID',
      reason_zh: 'diy',
    },
    {
      id: 'RF15_speed_inflation',
      name_zh: '速度虚标',
      when: {
        field: 'top_speed_kmh',
        op: 'gt',
        value: { ref: '1.5 * families.<confirmed_family>.plausible_max_speed_kmh' },
      },
      penalty: 10,
      cap_tier: 'C',
      reason_zh: '虚标',
    },
  ],
  verdict_tiers: {
    A: { rank: 1, label_zh: '推荐采购', label_en: 'proceed', condition: 'final_score >= 75 AND D_safety >= 60 AND confidence >= 0.60 AND no cap_tier applied' },
    B: { rank: 2, label_zh: '可考虑，先核验', label_en: 'shortlist', condition: '60 <= final_score < 75, OR ...' },
    C: { rank: 3, label_zh: '备选观望', label_en: 'fallback', condition: '45 <= final_score < 60, OR cap_tier == C' },
    AVOID: { rank: 4, label_zh: '回避', label_en: 'avoid', condition: 'final_score < 45, OR cap_tier == AVOID' },
    UNRANKABLE: { rank: 5, label_zh: '不参与排名', label_en: 'unrankable', condition: 'family mismatch or TOY_CLASS' },
    confidence_caps: [
      { below_confidence: 0.4, max_tier: 'B' },
      { below_confidence: 0.25, max_tier: 'C' },
    ],
    auto_avoid: {
      rules: [
        { any_flag_in: ['RF01_recalled_model', 'RF10_diy_kit'], verdict: 'AVOID' },
        { at_least: 2, flags: ['RF02_no_brake_fast', 'RF05_no_cert_at_all', 'RF08_no_specs'], verdict: 'AVOID' },
      ],
    },
  },
  recall_seed: [{ brand: 'Jetson', model: 'Rogue 42V', match_keys: ['Jetson', 'Rogue'] }],
  score_assembly: { penalty_cap: 45 },
  validation: {},
};

const FIXTURE_CLASSIFIED = {
  offers: [
    {
      offer_id: '111111111111',
      title: '电动滑板四轮遥控成人 30km/h 续航 25km 载重 120kg',
      price: 800,
      shop: '东莞市甲运动器材厂',
      province: '广东',
      sales: 1200,
      rr: 30,
      keyword: '电动滑板',
      family: 'e_skate',
      rideable: true,
      url: 'https://detail.1688.com/offer/111111111111.html',
      pic: 'https://cbu01.alicdn.com/a.jpg',
    },
    {
      offer_id: '222222222222',
      title: '儿童三轮漂移车 玩具 广场车',
      price: 300,
      shop: '永康市乙玩具厂',
      province: '浙江',
      sales: 5000,
      rr: 20,
      keyword: '电动漂移板',
      family: 'drift_trike',
      rideable: true,
      url: 'https://detail.1688.com/offer/222222222222.html',
    },
    {
      offer_id: '333333333333',
      title: '电动滑板车电机轮毂配件',
      price: 50,
      shop: '永康市丙配件厂',
      province: '浙江',
      sales: 100,
      rr: 10,
      keyword: '电动漂移板',
      family: 'part',
      rideable: false,
      url: 'https://detail.1688.com/offer/333333333333.html',
    },
    {
      offer_id: '444444444444',
      title: '电动滑板车 M365 折叠代步 25km/h 成人',
      price: 600,
      shop: '永康市丁车业有限公司',
      province: '浙江',
      sales: 800,
      rr: 25,
      keyword: '电动滑板',
      family: 'e_scooter',
      rideable: true,
      url: 'https://detail.1688.com/offer/444444444444.html',
    },
  ],
};

const FIXTURE_MARKET_ITEMS = [
  {
    offer_id: '111111111111',
    category: 'electric_skateboard',
    biz_type: '生产加工',
    factory_inspection: true,
    super_factory: false,
    tp_year: 5,
    is_p4p: false,
    quantity_prices: [{ quantity: '≥1个', value: '800.00' }],
  },
  {
    offer_id: '444444444444',
    category: 'electric_scooter',
    biz_type: '工贸一体',
    factory_inspection: false,
    super_factory: false,
    tp_year: 3,
    is_p4p: true,
  },
];

const FIXTURE_PROVIDER_DETAILS = [
  {
    offer_id: '111111111111',
    title: '电动滑板四轮遥控成人 30km/h',
    price: '750.00',
    saled_count: 1300,
    company: '东莞市甲运动器材厂',
    attributes: {
      最高时速: '30km/h',
      续航里程: '20-25km',
      最大载重量: '120kg',
      制动系统: '碟刹',
      外贸出口认证: '无',
      电池类型: '锂电池',
      适用人群: '通用',
      颜色: '单电机15km,双电机25km',
    },
    detail_url: 'https://detail.1688.com/offer/111111111111.html',
  },
];

const FIXTURE_PORTAL = {
  captured_at: '2026-11-13T22:10+08:00',
  endpoint_base: 'https://trend.onebound.cn',
  contract: { 'GET /portal/image-compare': 'inertia json' },
  quota_after: { searchesRemaining: 0, monitorsRemaining: 1, isPro: false },
  membership: { plan: 'basic', label: '免费版' },
  free_quota_note: 'free tier trial only',
  search_receipts: [
    {
      request_id: 213,
      seed: 'https://detail.1688.com/offer/111111111111.html',
      http: 200,
      request: { id: 213, query_mode: 'item_id', platform_scope: 'all', status: 'completed' },
      results_total: 1,
      rows: [
        {
          id: 3556,
          platform: '1688',
          product_id: '111111111111',
          product_title: '电动滑板四轮遥控成人 30km/h',
          price: 800,
          shop_name: '_sopid@BBBmasked',
          seller_nick: '_sopid@BBBmasked',
          image_url: 'https://cbu01.alicdn.com/a.jpg',
          product_url: 'https://detail.1688.com/offer/111111111111.html',
          is_proxy_image: true,
        },
      ],
    },
  ],
};

function candidateFrom(overrides = {}, options = {}) {
  const offer = { ...FIXTURE_CLASSIFIED.offers[0], ...overrides };
  return buildOfferCandidate(offer, {
    spec: loadScoringSpec(FIXTURE_SPEC),
    marketItem: options.marketItem || null,
    providerDetail: options.providerDetail || null,
  });
}

function scoreInput(overrides = {}) {
  const spec = loadScoringSpec(FIXTURE_SPEC);
  const candidate = candidateFrom(overrides.offer || {}, overrides.options || {});
  candidate.fields = { ...candidate.fields, ...(overrides.fields || {}) };
  candidate.family = overrides.family || candidate.family;
  candidate.rankability = { rankable: overrides.rankable !== false };
  return { spec, candidate };
}

// ---------------------------------------------------------------------------

describe('Provider Radar — scoring.json executor', () => {
  it('loadScoringSpec validates weights and rejects broken specs', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const validation = validateScoringSpec(spec);
    assert.equal(validation.ok, true);
    assert.equal(validation.criterion_weights_sum, 1);
    assert.equal(spec.criteria.length, 5);
    assert.throws(() => loadScoringSpec({ criteria: [] }), /criteria/);
    assert.throws(() => loadScoringSpec(null), /scoring\.json/);
  });

  it('interpolateAnchors interpolates and clamps outside the anchor range', () => {
    const anchors = [[0, 0], [10, 50], [20, 100]];
    assert.equal(interpolateAnchors(anchors, -5), 0);
    assert.equal(interpolateAnchors(anchors, 0), 0);
    assert.equal(interpolateAnchors(anchors, 5), 25);
    assert.equal(interpolateAnchors(anchors, 15), 75);
    assert.equal(interpolateAnchors(anchors, 99), 100);
  });

  it('executes piecewise_linear_log10 with log10 x-axis', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const metric = spec.criteria.find((c) => c.id === 'E_reliability').metrics[0];
    const context = { fields: { orders_count: 1000 }, family: 'electric_skateboard', spec, confirmedFamily: 'electric_skateboard' };
    const result = evaluateFormula(metric.formula, metric, context);
    assert.equal(result.known, true);
    // log10(1000) = 3 → anchor score 70
    assert.equal(result.score, 70);
  });

  it('applies family_override anchors instead of the base anchors', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const metric = spec.criteria.find((c) => c.id === 'A_performance').metrics[0];
    const eSkate = evaluateFormula(metric.formula, metric, {
      fields: { top_speed_kmh: 20 },
      family: 'electric_skateboard',
      spec,
      confirmedFamily: 'electric_skateboard',
    });
    const scooter = evaluateFormula(metric.formula, metric, {
      fields: { top_speed_kmh: 20 },
      family: 'electric_scooter',
      spec,
      confirmedFamily: 'electric_skateboard',
    });
    // e-skate override yields 60 at 20 km/h; scooter override is only 50
    assert.equal(eSkate.score, 60);
    assert.equal(scooter.score, 50);
  });

  it('distinguishes unavailable (unknown, neutral) from absent (detail read, penalty anchor)', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const metric = spec.criteria.find((c) => c.id === 'A_performance').metrics[0];
    const unavailable = evaluateFormula(metric.formula, metric, {
      fields: { top_speed_kmh: null, detail_text_available: false },
      family: 'electric_skateboard',
      spec,
      confirmedFamily: 'electric_skateboard',
    });
    const absent = evaluateFormula(metric.formula, metric, {
      fields: { top_speed_kmh: null, detail_text_available: true },
      family: 'electric_skateboard',
      spec,
      confirmedFamily: 'electric_skateboard',
    });
    assert.equal(unavailable.score, 50);
    assert.equal(unavailable.known, false);
    assert.equal(unavailable.missing, 'unavailable');
    assert.equal(absent.score, 35);
    assert.equal(absent.known, true);
    assert.equal(absent.missing, 'absent');
  });

  it('ratio_piecewise falls back to a neutral value when the denominator is unknown', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const metric = spec.criteria.find((c) => c.id === 'C_affordability').metrics[0];
    const result = evaluateFormula(metric.formula, metric, {
      fields: { price_cny: 800, family_median_price_cny: null },
      family: 'electric_skateboard',
      spec,
      confirmedFamily: 'electric_skateboard',
    });
    assert.equal(result.score, 50);
    assert.equal(result.known, false);
  });

  it('scores a metric with the cert evidence tier map', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const metric = spec.criteria.find((c) => c.id === 'D_safety').metrics[0];
    const result = evaluateFormula(metric.formula, metric, {
      fields: { cert_best_tier: 'E' },
      family: 'electric_skateboard',
      spec,
      confirmedFamily: 'electric_skateboard',
    });
    assert.equal(result.score, 10);
    assert.equal(result.known, true);
  });
});

describe('Provider Radar — classification & signal extraction', () => {
  it('resolves family from the market-scan class map before title regex', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    assert.equal(
      resolveScoringFamily('电动滑板四轮遥控', { scanCategory: 'electric_skateboard' }, spec).family,
      'electric_skateboard'
    );
    // parts class maps to null → excluded
    assert.equal(resolveScoringFamily('电机配件', { scanCategory: 'parts_accessories' }, spec).family, null);
  });

  it('filters human-powered freeline boards and parts via title regex', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    assert.equal(resolveScoringFamily('幽威六代漂移板 分体成人滑板', {}, spec).family, null);
    assert.equal(resolveScoringFamily('电动滑板车电机 轮毂配件', {}, spec).family, null);
  });

  it('classifies audience from title, and detail attributes override the title', () => {
    assert.equal(classifyAgeTarget('儿童电动平衡车').age_target, 'child');
    assert.equal(classifyAgeTarget('儿童成人通用电动平衡车').age_target, 'family');
    assert.equal(classifyAgeTarget('儿童电动平衡车', { 适用人群: '通用' }).age_target, 'unisex');
    assert.equal(classifyAgeTarget('智能平衡车', { 儿童专用: '是' }).age_target, 'child');
  });

  it('derives cert tier only on positive/affirmative evidence', () => {
    assert.equal(deriveCertTier({ cert_noise: [] }, 'electric_skateboard', false), null);
    assert.equal(deriveCertTier({ cert_noise: ['CE'] }, 'electric_skateboard', false), 'D');
    assert.equal(deriveCertTier({ cert_noise: [], cert_system: [] }, 'electric_skateboard', true), 'E');
    assert.equal(
      deriveCertTier({ cert_noise: [], cert_system: [{ id: 'UL2272' }] }, 'electric_skateboard', true),
      'C'
    );
  });

  it('extracts speed/range/load/battery/brake signals from title and detail attributes', () => {
    const signals = extractSignals('电动滑板 30km/h 续航 25km 载重 120kg 36V 10Ah 碟刹', {});
    assert.equal(signals.top_speed_kmh, 30);
    assert.equal(signals.claimed_range_km, 25);
    assert.equal(signals.max_load_kg, 120);
    assert.equal(signals.battery_v, 36);
    assert.equal(signals.battery_ah, 10);
    assert.equal(signals.battery_wh, 360);
    assert.equal(signals.brake_type, 'single_mechanical_disc');
    const detail = extractSignals('电动滑板', {
      最高时速: '24km/h',
      续航里程: '25km(含)-35km(不含)',
      最大载重量: '150kg',
      制动系统: '碟刹',
      外贸出口认证: '无',
    });
    assert.equal(detail.top_speed_kmh, 24);
    assert.equal(detail.claimed_range_km, 25);
    assert.equal(detail.max_load_kg, 150);
    assert.equal(detail.explicit_no_cert, true);
  });
});

describe('Provider Radar — red flags & verdict tiers', () => {
  function fired(overrides) {
    const { spec, candidate } = scoreInput(overrides);
    return evaluateRedFlags(candidate, spec);
  }

  it('fires RF05 only when the detail text was actually read', () => {
    const searchOnly = fired({ fields: { cert_best_tier: 'E', detail_text_available: false } });
    assert.equal(searchOnly.fired.some((flag) => flag.id === 'RF05_no_cert_at_all'), false);
    const detailRead = fired({ fields: { cert_best_tier: 'E', detail_text_available: true } });
    assert.equal(detailRead.fired.some((flag) => flag.id === 'RF05_no_cert_at_all'), true);
  });

  it('escalates RF02 cap to AVOID above 25 km/h', () => {
    const slow = fired({ fields: { brake_type: 'electronic_regen_only', top_speed_kmh: 20 } });
    const fast = fired({ fields: { brake_type: 'electronic_regen_only', top_speed_kmh: 30 } });
    assert.equal(slow.fired.find((flag) => flag.id === 'RF02_no_brake_fast')?.cap_tier, 'C');
    assert.equal(fast.fired.find((flag) => flag.id === 'RF02_no_brake_fast')?.cap_tier, 'AVOID');
  });

  it('evaluates {ref} expressions against spec paths and fields', () => {
    const inflated = fired({ fields: { top_speed_kmh: 80 } });
    assert.equal(inflated.fired.some((flag) => flag.id === 'RF15_speed_inflation'), true);
    const normal = fired({ fields: { top_speed_kmh: 30 } });
    assert.equal(normal.fired.some((flag) => flag.id === 'RF15_speed_inflation'), false);
  });

  it('caps penalty total at 45 and auto-AVOIDs on two avoid-class flags', () => {
    const result = fired({
      offer: { title: 'Jetson Rogue 电动滑板 DIY 散件 二手翻新 80km/h' },
      fields: { top_speed_kmh: 80, brake_type: 'none', detail_text_available: true, cert_best_tier: 'E' },
    });
    assert.ok(result.total_penalty <= 45);
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const verdict = assignVerdictTier({
      finalScore: 72,
      safetyScore: 75,
      confidence: 0.8,
      redFlags: result.fired,
      spec,
      rankability: { rankable: true },
    });
    assert.equal(verdict.tier, 'AVOID');
    assert.equal(verdict.auto_avoid, true);
  });

  it('applies confidence caps: <0.25 cannot exceed C', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const verdict = assignVerdictTier({
      finalScore: 80,
      safetyScore: 85,
      confidence: 0.2,
      redFlags: [],
      spec,
      rankability: { rankable: true },
    });
    assert.equal(verdict.tier, 'C');
  });

  it('returns UNRANKABLE when the rankability gate rejects the candidate', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const verdict = assignVerdictTier({
      finalScore: 90,
      safetyScore: 90,
      confidence: 0.9,
      redFlags: [],
      spec,
      rankability: { rankable: false, reason: 'TOY_CLASS' },
    });
    assert.equal(verdict.tier, 'UNRANKABLE');
  });
});

describe('Provider Radar — provider pipeline', () => {
  it('maps a portal result row to a candidate and marks the masked shop', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const row = FIXTURE_PORTAL.search_receipts[0].rows[0];
    const candidate = candidateFromPortalRow(row, { spec, requestId: 213 });
    assert.equal(candidate.platform, '1688');
    assert.equal(candidate.offer_id, '111111111111');
    assert.equal(candidate.price_cny, 800);
    assert.equal(candidate.shop_masked, true);
    assert.equal(candidate.request_id, 213);
    assert.equal(candidate.evidence[0].kind, 'portal-result-row');
  });

  it('runs the full radar on fixtures: ranks adult e-skate, excludes toy & parts', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const result = runProviderRadar({
      seed: { input: '111111111111' },
      portal: FIXTURE_PORTAL,
      classified: FIXTURE_CLASSIFIED,
      marketItems: FIXTURE_MARKET_ITEMS,
      providerDetails: FIXTURE_PROVIDER_DETAILS,
      spec,
      provenance: { files: [], notes: [] },
    });

    assert.equal(result.schema_version.startsWith('2.'), true);
    assert.equal(result.product.confirmed_family, 'electric_skateboard');
    assert.equal(result.stats.portal_rows, 1);
    assert.equal(result.stats.portal_rows_joined, 1);

    const primary = result.family_groups.find((group) => group.role === 'primary');
    assert.equal(primary.family, 'electric_skateboard');
    assert.equal(primary.providers.length, 1);
    const top = primary.providers[0];
    assert.equal(top.shop, '东莞市甲运动器材厂');
    assert.equal(top.detail_enriched, true);
    assert.equal(top.offer_id, '111111111111');
    assert.equal(top.criteria.length, 5);
    assert.ok(top.final_score >= 0 && top.final_score <= 100);
    assert.equal(top.fields.top_speed_kmh, 30);
    assert.equal(top.fields.max_load_kg, 120);
    assert.equal(top.fields.cert_best_tier, 'E');
    assert.equal(top.fields.brake_type, 'single_mechanical_disc');
    assert.equal(top.red_flags.some((flag) => flag.id === 'RF05_no_cert_at_all'), true);
    // price_cny is the canonical search price; detail price kept separately
    assert.equal(top.price_cny, 800);
    assert.equal(top.price_detail_cny, 750);

    const unrankableCodes = result.unrankable.summary.map((entry) => entry.code);
    assert.ok(unrankableCodes.includes('FAMILY_MISMATCH'));
    assert.ok(unrankableCodes.includes('TOY_CLASS'));
    assert.equal(result.quota_ledger.searches_remaining, 0);
    assert.equal(result.quota_ledger.exhausted, true);
    assert.equal(result.scoring.validation.ok, true);
  });

  it('aggregates providers per family so the same shop can rank in two families', () => {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const sameShop = { ...FIXTURE_CLASSIFIED.offers[0], offer_id: '999999999999', shop: '东莞市甲运动器材厂' };
    const scooter = { ...FIXTURE_CLASSIFIED.offers[3], shop: '东莞市甲运动器材厂' };
    const candidates = [sameShop, scooter].map((offer) =>
      buildOfferCandidate(offer, { spec, marketItem: null, providerDetail: null })
    );
    for (const candidate of candidates) {
      candidate.rankability = { rankable: true };
      candidate.score = { final_score: 50, tier: 'C' };
    }
    const providers = aggregateProviders(candidates, spec);
    assert.equal(providers.length, 2);
    assert.deepEqual(providers.map((provider) => provider.family).sort(), ['electric_scooter', 'electric_skateboard']);
    assert.equal(new Set(providers.map((provider) => provider.provider_key)).size, 2);
  });
});

describe('Provider Radar — dashboard renderer', () => {
  function renderFixture() {
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const result = runProviderRadar({
      seed: { input: '111111111111' },
      portal: FIXTURE_PORTAL,
      classified: FIXTURE_CLASSIFIED,
      marketItems: FIXTURE_MARKET_ITEMS,
      providerDetails: FIXTURE_PROVIDER_DETAILS,
      spec,
      provenance: {
        files: [{ role: 'scoring-rubric', path: '/tmp/scoring.json', bytes: 1234, sha256_12: 'abcdef123456' }],
        notes: [],
      },
    });
    return renderRadarDashboard(result);
  }

  it('renders a self-contained dashboard with no CDN/external resources', () => {
    const html = renderFixture();
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('<link rel="stylesheet"'), false);
    for (const cdn of ['cdn.jsdelivr', 'unpkg.com', 'cdnjs.cloudflare.com', 'googleapis.com']) {
      assert.equal(html.includes(cdn), false);
    }
    assert.ok(html.includes('viewport'));
  });

  it('renders ranked cards, provenance, quota ledger and the unknown state', () => {
    const html = renderFixture();
    assert.ok(html.includes('东莞市甲运动器材厂'));
    assert.ok(html.includes('溯源面板'));
    assert.ok(html.includes('quota ledger'));
    assert.ok(html.includes('免费额度已用尽'));
    assert.ok(html.includes('评分明细'));
    assert.ok(html.includes('data-tier='));
    assert.ok(html.includes('chip-unknown'));
    assert.ok(html.includes('未参与排名的条目'));
    assert.ok(html.includes('1688 详情属性'));
  });

  it('escapes HTML and only renders http(s) evidence URLs as anchors', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('https://detail.1688.com/offer/1.html'), 'https://detail.1688.com/offer/1.html');
    const spec = loadScoringSpec(FIXTURE_SPEC);
    const evil = {
      ...FIXTURE_CLASSIFIED.offers[0],
      offer_id: '888888888888',
      title: '<img src=x onerror=alert(1)>电动滑板 30km/h',
      shop: '<b>evil shop</b>',
      url: 'javascript:alert(2)',
    };
    const result = runProviderRadar({
      seed: { input: '888888888888' },
      portal: null,
      classified: { offers: [evil] },
      marketItems: [],
      providerDetails: [],
      spec,
      provenance: { files: [], notes: [] },
    });
    const html = renderRadarDashboard(result);
    assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
    assert.equal(html.includes('<b>evil shop</b>'), false);
    assert.equal(html.includes('href="javascript:'), false);
  });
});

describe('Provider Radar — portal session client (fixture fetch, no live call)', () => {
  it('builds cookie header and decodes the XSRF token', () => {
    const cookies = [
      { name: 'XSRF-TOKEN', value: encodeURIComponent('abc+/=') },
      { name: 'onebound-session', value: 'xyz' },
    ];
    assert.equal(buildCookieHeader(cookies), `XSRF-TOKEN=${encodeURIComponent('abc+/=')}; onebound-session=xyz`);
    assert.equal(extractXsrfToken(cookies), 'abc+/=');
  });

  it('parses Inertia pages and detects quota exhaustion from props or flash', () => {
    const page = parseInertiaPage({
      props: {
        quota: { searchesRemaining: 0, monitorsRemaining: 1, isPro: false },
        flash: { quota_exhausted: true, status: 'ok' },
        results: { data: [] },
      },
    });
    assert.equal(page.quota.searchesRemaining, 0);
    assert.equal(detectQuotaExhausted(page).remaining, 0);
    assert.equal(
      detectQuotaExhausted(parseInertiaPage({ props: { quota: { searchesRemaining: 1 }, flash: {} } })),
      null
    );
  });

  it('extracts request_id from a redirect Location', () => {
    assert.equal(extractRequestId('/portal/image-compare?request_id=213'), 213);
    assert.equal(extractRequestId('/portal/image-compare'), null);
  });

  it('throws actionable QUOTA_EXHAUSTED before spending a POST when quota is 0', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ component: 'x', props: { quota: { searchesRemaining: 0, monitorsRemaining: 1, isPro: false } } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const client = new PortalSessionClient({
      session: {
        origin: 'https://trend.onebound.cn',
        user_agent: 'test-agent',
        inertia_version: 'v1',
        cookies: [{ name: 'XSRF-TOKEN', value: encodeURIComponent('tok') }],
      },
      fetchImpl,
    });
    await assert.rejects(
      () => client.search({ mode: 'item_id', item_url: 'https://detail.1688.com/offer/1.html' }),
      (err) => err instanceof PortalError && err.code === 'PORTAL_QUOTA_EXHAUSTED' && /1688-ops image-search/.test(err.actionable)
    );
    assert.equal(calls, 1); // only the free quota GET, never the paid POST
  });

  it('dispatches a POST and returns the request_id from the 302 redirect', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, method: init.method });
      if (init.method === 'GET') {
        return new Response(
          JSON.stringify({ props: { quota: { searchesRemaining: 1, monitorsRemaining: 1 }, flash: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(null, { status: 302, headers: { location: '/portal/image-compare?request_id=321' } });
    };
    const client = new PortalSessionClient({
      session: {
        origin: 'https://trend.onebound.cn',
        user_agent: 'test-agent',
        inertia_version: 'v1',
        cookies: [{ name: 'XSRF-TOKEN', value: encodeURIComponent('tok') }],
      },
      fetchImpl,
    });
    const dispatch = await client.search({ mode: 'item_id', item_url: 'https://detail.1688.com/offer/1.html' });
    assert.equal(dispatch.request_id, 321);
    assert.equal(dispatch.state, 'dispatched');
    const post = requests.find((request) => request.method === 'POST');
    assert.ok(post.url.includes('/portal/image-compare'));
  });

  it('maps HTTP 422 validation errors to an actionable PortalError', async () => {
    const fetchImpl = async () => {
      return new Response(JSON.stringify({ errors: { image_url: ['image url 必须是有效的网址'] } }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new PortalSessionClient({
      session: { origin: 'https://trend.onebound.cn', user_agent: 't', inertia_version: 'v1', cookies: [{ name: 'a', value: 'b' }] },
      fetchImpl,
    });
    await assert.rejects(
      () => client.request('POST', '/portal/image-compare', { form: { query_mode: 'image', image_url: 'x' } }),
      (err) => err instanceof PortalError && err.code === 'PORTAL_VALIDATION' && /image_url/.test(err.actionable)
    );
  });

  it('rejects insecure (world-readable) session files and never prints cookie values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-session-'));
    const file = path.join(dir, 'session.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        captured_at: '2026-11-13T00:00:00Z',
        origin: 'https://trend.onebound.cn',
        user_agent: 'ua',
        inertia_version: 'v1',
        cookies: [{ name: 'session-secret', value: 'super-secret-value' }],
      })
    );
    fs.chmodSync(file, 0o644);
    assert.throws(() => loadSession(file), (err) => err instanceof PortalError && err.code === 'PORTAL_SESSION_INSECURE');
    fs.chmodSync(file, 0o600);
    const session = loadSession(file);
    const description = describeSession(session, file);
    assert.equal(JSON.stringify(description).includes('super-secret-value'), false);
    assert.deepEqual(description.cookie_names, ['session-secret']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Provider Radar — OneBound credential field mapping (regression)', () => {
  it('requests apiKey (never username/login) for the OneBound API key and credential for the secret', () => {
    const calls = [];
    const lookup = (itemTitle, fieldName) => {
      calls.push({ itemTitle, fieldName });
      if (itemTitle !== ONEBOUND_ITEM_TITLE) return null;
      if (fieldName === 'apiKey') return 'key-from-apiKey';
      if (fieldName === 'credential') return 'secret-from-credential';
      if (fieldName === 'username') return 'hxsmyxxx-login-name';
      return null;
    };
    const creds = resolveCredentials('onebound', { lookup });
    assert.equal(creds.key, 'key-from-apiKey');
    assert.equal(creds.secret, 'secret-from-credential');
    assert.equal(creds.key.includes('hxsmyxxx'), false);
    const fieldsRequested = calls.map((call) => call.fieldName);
    assert.ok(fieldsRequested.includes('apiKey'));
    assert.ok(fieldsRequested.includes('credential'));
    assert.equal(ONEBOUND_FORBIDDEN_KEY_FIELDS.includes('username'), true);
    assert.deepEqual(ONEBOUND_KEY_FIELDS, ['apiKey', 'API Key']);
    assert.deepEqual(ONEBOUND_SECRET_FIELDS, ['credential']);
  });
});

describe('Provider Radar — real scoring.json contract (skipped when file absent)', () => {
  const radarDir =
    process.env.PROVIDER_RADAR_DIR ||
    path.resolve(process.env.HOME || '.', 'Documents/Cowork/Antigravity Cowork/26.11.13 OneBound Provider Radar');
  const scoringPath = path.join(radarDir, 'data/scoring.json');

  it('the canonical scoring.json is executable and internally consistent', { skip: !fs.existsSync(scoringPath) }, () => {
    const spec = loadScoringSpec(JSON.parse(fs.readFileSync(scoringPath, 'utf8')));
    const validation = validateScoringSpec(spec);
    assert.equal(validation.ok, true);
    assert.equal(spec.product.confirmed_family, 'electric_skateboard');
    assert.equal(spec.criteria.length, 5);
    assert.ok(spec.red_flags.length >= 16);
    assert.equal(Object.keys(spec.families).length, 5);
  });
});
