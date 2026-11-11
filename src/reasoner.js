/**
 * 1688 货源审计与智能决策推理引擎 (Sourcing Reasoner & Risk Engine)
 * 纯函数与白盒可解释设计，零外部副作用，支持端到端自动化验算
 */

import { cleanText } from './extractor.js';

/**
 * 供应商可信度评分 (0 - 100)
 * 维度权重：
 * 1. 复购率 / 回头率 (30%)
 * 2. 商家履历与工厂资质 (25%)
 * 3. 市场销量与动销表现 (20%)
 * 4. 履约发货与服务保障 (15%)
 * 5. 价格与起批量稳定性 (10%)
 *
 * @param {object} offer
 * @returns {{ score: number, breakdown: object }}
 */
export function evaluateSupplierScore(offer = {}) {
  const breakdown = {
    return_rate_score: 0, // max 30
    factory_badge_score: 0, // max 25
    sales_score: 0, // max 20
    fulfillment_score: 0, // max 15
    price_moq_stability: 0, // max 10
  };

  // 1. 复购率 / 回头率 (30分)
  const returnRate = typeof offer.return_rate_percent === 'number'
    ? offer.return_rate_percent
    : null;

  if (returnRate !== null) {
    if (returnRate >= 40) breakdown.return_rate_score = 30;
    else if (returnRate >= 30) breakdown.return_rate_score = 25;
    else if (returnRate >= 20) breakdown.return_rate_score = 18;
    else if (returnRate >= 10) breakdown.return_rate_score = 10;
    else breakdown.return_rate_score = 4;
  } else {
    // 缺失回头率指标，给默认兜底分
    breakdown.return_rate_score = 8;
  }

  // 2. 商家履历与工厂资质 (25分)
  let badges = [];
  if (Array.isArray(offer.badges)) {
    badges = offer.badges;
  } else if (typeof offer.badges_json === 'string') {
    try {
      badges = JSON.parse(offer.badges_json);
    } catch {
      badges = [];
    }
  }

  const badgeStr = badges.join(' ');
  const sellerName = offer.seller_name || '';

  if (badgeStr.includes('超级工厂') || badgeStr.includes('严选工厂')) {
    breakdown.factory_badge_score += 18;
  } else if (badgeStr.includes('实力商家') || badgeStr.includes('深度验厂')) {
    breakdown.factory_badge_score += 12;
  } else if (sellerName.includes('厂') || sellerName.includes('实业') || sellerName.includes('制造')) {
    breakdown.factory_badge_score += 6;
  } else {
    breakdown.factory_badge_score += 3;
  }

  if (badgeStr.includes('金牌制造') || badgeStr.includes('诚信通') || badgeStr.includes('年')) {
    breakdown.factory_badge_score += 7;
  }
  breakdown.factory_badge_score = Math.min(25, breakdown.factory_badge_score);

  // 3. 市场销量与动销表现 (20分)
  const salesVal = typeof offer.sales_value === 'number' ? offer.sales_value : 0;
  if (salesVal >= 20000) breakdown.sales_score = 20;
  else if (salesVal >= 5000) breakdown.sales_score = 16;
  else if (salesVal >= 1000) breakdown.sales_score = 12;
  else if (salesVal >= 100) breakdown.sales_score = 8;
  else if (salesVal > 0) breakdown.sales_score = 4;
  else breakdown.sales_score = 0;

  // 4. 履约发货与服务保障 (15分)
  const deliveryDays = (offer.delivery_days_text || '').toLowerCase();
  if (deliveryDays.includes('24小时') || deliveryDays.includes('当日')) {
    breakdown.fulfillment_score += 8;
  } else if (deliveryDays.includes('48小时') || deliveryDays.includes('2天')) {
    breakdown.fulfillment_score += 6;
  } else if (deliveryDays.includes('72小时') || deliveryDays.includes('3天')) {
    breakdown.fulfillment_score += 4;
  } else {
    breakdown.fulfillment_score += 3;
  }

  if (badgeStr.includes('无忧退') || badgeStr.includes('破损包赔') || badgeStr.includes('材质保真') || badgeStr.includes('假一赔四')) {
    breakdown.fulfillment_score += 7;
  } else if (badgeStr.includes('7天无理由') || badgeStr.includes('买家保障')) {
    breakdown.fulfillment_score += 4;
  }
  breakdown.fulfillment_score = Math.min(15, breakdown.fulfillment_score);

  // 5. 价格与起批量稳定性 (10分)
  const minPrice = typeof offer.price_min === 'number' ? offer.price_min : 0;
  const maxPrice = typeof offer.price_max === 'number' ? offer.price_max : minPrice;
  const moqVal = typeof offer.moq_value === 'number' ? offer.moq_value : 1;

  if (minPrice > 0 && maxPrice > 0) {
    const ratio = maxPrice / minPrice;
    if (ratio <= 1.5) breakdown.price_moq_stability += 5;
    else if (ratio <= 2.5) breakdown.price_moq_stability += 3;
    else breakdown.price_moq_stability += 1;
  }

  if (moqVal <= 2) breakdown.price_moq_stability += 5;
  else if (moqVal <= 10) breakdown.price_moq_stability += 3;
  else if (moqVal <= 50) breakdown.price_moq_stability += 1;

  breakdown.price_moq_stability = Math.min(10, breakdown.price_moq_stability);

  const totalScore = Math.round(
    breakdown.return_rate_score +
    breakdown.factory_badge_score +
    breakdown.sales_score +
    breakdown.fulfillment_score +
    breakdown.price_moq_stability
  );

  return {
    score: totalScore,
    breakdown,
  };
}

/**
 * 解析并分析阶梯批发价与批量折扣结构
 * @param {object} offer
 * @returns {object}
 */
export function analyzePriceTiers(offer = {}) {
  let tiers = [];
  if (Array.isArray(offer.price_tiers)) {
    tiers = offer.price_tiers;
  } else if (typeof offer.price_tiers_json === 'string') {
    try {
      tiers = JSON.parse(offer.price_tiers_json);
    } catch {
      tiers = [];
    }
  }

  // 构造标准阶梯结构
  if (!Array.isArray(tiers) || tiers.length === 0) {
    const minP = typeof offer.price_min === 'number' ? offer.price_min : null;
    const maxP = typeof offer.price_max === 'number' ? offer.price_max : minP;
    if (minP !== null && maxP !== null && minP < maxP) {
      tiers = [
        { min_qty: offer.moq_value || 1, unit_price: maxP },
        { min_qty: 50, unit_price: minP },
      ];
    } else if (minP !== null) {
      tiers = [{ min_qty: offer.moq_value || 1, unit_price: minP }];
    }
  }

  // 计算阶梯折扣率
  const sortedTiers = [...tiers].sort((a, b) => (a.min_qty || 0) - (b.min_qty || 0));
  const basePrice = sortedTiers[0]?.unit_price || offer.price_max || offer.price_min || 0;

  const analyzedTiers = sortedTiers.map((t, idx) => {
    const price = typeof t.unit_price === 'number' ? t.unit_price : parseFloat(t.unit_price) || basePrice;
    const discount = basePrice > 0 ? Math.round((1 - price / basePrice) * 100) : 0;
    return {
      tier_index: idx + 1,
      min_quantity: t.min_qty || 1,
      unit_price: price,
      discount_percent: Math.max(0, discount),
    };
  });

  const maxDiscount = analyzedTiers.length > 1
    ? analyzedTiers[analyzedTiers.length - 1].discount_percent
    : 0;

  return {
    has_tiered_pricing: analyzedTiers.length > 1,
    tier_count: analyzedTiers.length,
    base_unit_price: basePrice,
    lowest_unit_price: analyzedTiers[analyzedTiers.length - 1]?.unit_price || basePrice,
    max_discount_percent: maxDiscount,
    tiers: analyzedTiers,
  };
}

/**
 * 测算独立站/跨境出海毛利空间与损益平衡点 (Margin & Unit Economics)
 * 默认汇率与履约参数可配
 *
 * @param {object} offer
 * @param {object} [options]
 * @param {number} [options.target_retail_price] 目标零售价 (默认按 3.5 倍加价率自动推导)
 * @param {string} [options.target_currency='USD'] 目标销售货币 (USD / CNY)
 * @param {number} [options.exchange_rate=7.2] 汇率 (CNY / USD)
 * @param {number} [options.domestic_shipping_cny=3.0] 国内揽收与入仓头程估算 (元)
 * @param {number} [options.intl_shipping_cny=30.0] 跨境专线 / 小包尾程物流估算 (元)
 * @param {number} [options.platform_fee_percent=3.5] 独立站支付通道费 (Shopify/Stripe ~3.5%)
 * @returns {object}
 */
export function estimateMarginAndProfit(offer = {}, options = {}) {
  const currency = options.target_currency || 'USD';
  const exchangeRate = options.exchange_rate || 7.2;
  const domesticShipping = options.domestic_shipping_cny !== undefined ? options.domestic_shipping_cny : 3.0;
  const intlShipping = options.intl_shipping_cny !== undefined ? options.intl_shipping_cny : 30.0;
  const gatewayFeeRate = (options.platform_fee_percent !== undefined ? options.platform_fee_percent : 3.5) / 100;

  const baseCostCny = typeof offer.price_min === 'number'
    ? offer.price_min
    : (typeof offer.price_max === 'number' ? offer.price_max : 10.0);

  // 到仓采购落地总成本 (含国内运费与专线小包运费)
  const landedCostCny = baseCostCny + domesticShipping + intlShipping;
  const landedCostUsd = parseFloat((landedCostCny / exchangeRate).toFixed(2));

  // 目标零售价推导：若未显式指定，按默认 3.5x - 4x 加价定价测算
  let retailPrice = options.target_retail_price;
  if (typeof retailPrice !== 'number' || retailPrice <= 0) {
    retailPrice = currency === 'USD'
      ? parseFloat((landedCostUsd * 3.5).toFixed(2))
      : parseFloat((landedCostCny * 3.5).toFixed(2));
  }

  // 统一换算为 USD 和 CNY 进行双币种对账
  const retailUsd = currency === 'USD' ? retailPrice : parseFloat((retailPrice / exchangeRate).toFixed(2));
  const retailCny = currency === 'USD' ? parseFloat((retailPrice * exchangeRate).toFixed(2)) : retailPrice;

  // 扣减支付通道费
  const paymentFeeUsd = parseFloat((retailUsd * gatewayFeeRate).toFixed(2));
  const netRevenueUsd = parseFloat((retailUsd - paymentFeeUsd).toFixed(2));

  // 单件毛利与毛利率
  const grossProfitUsd = parseFloat((netRevenueUsd - landedCostUsd).toFixed(2));
  const grossMarginPercent = retailUsd > 0
    ? parseFloat(((grossProfitUsd / retailUsd) * 100).toFixed(1))
    : 0;

  // 保本广告投产比 (Break-Even ROAS = 零售额 / 毛利)
  const breakEvenRoas = grossProfitUsd > 0
    ? parseFloat((retailUsd / grossProfitUsd).toFixed(2))
    : null;

  return {
    target_currency: currency,
    exchange_rate: exchangeRate,
    base_sourcing_cost_cny: baseCostCny,
    landed_cost_cny: landedCostCny,
    landed_cost_usd: landedCostUsd,
    target_retail_price: retailPrice,
    retail_price_usd: retailUsd,
    retail_price_cny: retailCny,
    payment_fee_usd: paymentFeeUsd,
    gross_profit_usd: grossProfitUsd,
    gross_margin_percent: grossMarginPercent,
    break_even_roas: breakEvenRoas,
    cost_structure: {
      sourcing_ratio: parseFloat(((baseCostCny / retailCny) * 100).toFixed(1)),
      shipping_ratio: parseFloat((((domesticShipping + intlShipping) / retailCny) * 100).toFixed(1)),
      profit_ratio: grossMarginPercent,
    },
  };
}

/**
 * 7 项核心风险触发器排查 (7 Risk Triggers)
 * 1. LOW_RETURN_RATE: 回头率偏低或严重低于行业基准 (< 15%)
 * 2. NO_RETURN_INSURANCE: 无买家保障/无退换货承诺
 * 3. HIGH_MOQ: 起订量过高 (> 50 件，不利于初期测款)
 * 4. ZERO_SALES: 30天无动销 (月销为 0 或空)
 * 5. NO_FACTORY_VERIFICATION: 缺乏超级工厂/深度验厂/实体制造背书
 * 6. PRICE_TIER_MISSING: 无梯度批发定价 (仅一口价或无量产折让)
 * 7. WIDE_PRICE_SPAN: 最高价与最低价跨度异常 (> 3.0x，防范低价引流陷阱)
 *
 * @param {object} offer
 * @returns {Array<{ code: string, severity: 'CRITICAL'|'WARNING', message: string, mitigation: string }>}
 */
export function evaluateRiskTriggers(offer = {}) {
  const risks = [];

  // 1. LOW_RETURN_RATE
  if (typeof offer.return_rate_percent === 'number' && offer.return_rate_percent < 15) {
    risks.push({
      code: 'LOW_RETURN_RATE',
      severity: 'WARNING',
      message: `回头率仅 ${offer.return_rate_percent}%，低于 15% 行业健康基准`,
      mitigation: '首批严控采购量，下单前索要大货产前样，仔细核对客诉原因',
    });
  }

  // 2. NO_RETURN_INSURANCE
  let badges = [];
  if (Array.isArray(offer.badges)) badges = offer.badges;
  else if (typeof offer.badges_json === 'string') {
    try { badges = JSON.parse(offer.badges_json); } catch { badges = []; }
  }
  const badgeStr = badges.join(' ');
  const hasInsurance = badgeStr.includes('退') || badgeStr.includes('保') || badgeStr.includes('赔');
  if (!hasInsurance) {
    risks.push({
      code: 'NO_RETURN_INSURANCE',
      severity: 'WARNING',
      message: '未发现退换货保障、破损包赔或买家履约保险标签',
      mitigation: '走 1688 担保交易，合同条款中明确约定次品包退换及运费归属',
    });
  }

  // 3. HIGH_MOQ
  const moq = typeof offer.moq_value === 'number' ? offer.moq_value : 1;
  if (moq > 50) {
    risks.push({
      code: 'HIGH_MOQ',
      severity: 'WARNING',
      message: `起批量为 ${moq} 件，不利于独立站轻量化低成本测款`,
      mitigation: '联系旺旺客服申请样品质检或商谈首批混批测款优惠',
    });
  }

  // 4. ZERO_SALES
  const sales = typeof offer.sales_value === 'number' ? offer.sales_value : 0;
  if (sales <= 0) {
    risks.push({
      code: 'ZERO_SALES',
      severity: 'WARNING',
      message: '近 30 天无有效动销或销量记录为 0',
      mitigation: '核实是否为刚上架新品或非主推老链接，确认库存现货情况',
    });
  }

  // 5. NO_FACTORY_VERIFICATION
  const isFactory = badgeStr.includes('超级工厂') ||
    badgeStr.includes('深度验厂') ||
    badgeStr.includes('实力商家') ||
    (offer.seller_name || '').includes('制造') ||
    (offer.seller_name || '').includes('厂');
  if (!isFactory) {
    risks.push({
      code: 'NO_FACTORY_VERIFICATION',
      severity: 'CRITICAL',
      message: '非源头超级工厂或实力商家，可能为多层二道分销商',
      mitigation: '要求提供工厂实景营业执照，或以图搜款溯源源头代工厂',
    });
  }

  // 6. PRICE_TIER_MISSING
  let tiers = [];
  if (Array.isArray(offer.price_tiers)) tiers = offer.price_tiers;
  else if (typeof offer.price_tiers_json === 'string') {
    try { tiers = JSON.parse(offer.price_tiers_json); } catch { tiers = []; }
  }
  if (!tiers || tiers.length <= 1) {
    risks.push({
      code: 'PRICE_TIER_MISSING',
      severity: 'WARNING',
      message: '商品未配置阶梯批发价格，批量采买缺乏自动折让机制',
      mitigation: '在大促或批量出单前通过线下或旺旺敲定大货梯度出厂底价',
    });
  }

  // 7. WIDE_PRICE_SPAN
  const pMin = typeof offer.price_min === 'number' ? offer.price_min : 0;
  const pMax = typeof offer.price_max === 'number' ? offer.price_max : pMin;
  if (pMin > 0 && pMax / pMin >= 3.0) {
    risks.push({
      code: 'WIDE_PRICE_SPAN',
      severity: 'CRITICAL',
      message: `区间价跨度高达 ${(pMax / pMin).toFixed(1)} 倍 (${pMin} ~ ${pMax})，疑似配件规格低价引流`,
      mitigation: '抓取具体 SKU 规格清单，确保主推规格的真实采买价而非引流配件价',
    });
  }

  return risks;
}

/**
 * 综合货源推理主函数 (End-to-End Reasoner)
 * 输出可行动决议与操作员决策建议
 *
 * @param {object} offer
 * @param {object} [options]
 * @returns {object}
 */
export function reasonOffer(offer = {}, options = {}) {
  const supplierEvaluation = evaluateSupplierScore(offer);
  const tierAnalysis = analyzePriceTiers(offer);
  const marginEconomics = estimateMarginAndProfit(offer, options);
  const risks = evaluateRiskTriggers(offer);

  const criticalCount = risks.filter((r) => r.severity === 'CRITICAL').length;
  const warningCount = risks.filter((r) => r.severity === 'WARNING').length;

  let verdict = 'RECOMMENDED';
  if (supplierEvaluation.score < 50 || criticalCount >= 2 || (criticalCount >= 1 && warningCount >= 3)) {
    verdict = 'HIGH_RISK';
  } else if (supplierEvaluation.score < 75 || criticalCount >= 1 || warningCount >= 2) {
    verdict = 'CONDITIONAL';
  }

  // 生成操作员中文行动建议 (无敬语，纯事实)
  const recommendations = [];

  if (verdict === 'HIGH_RISK') {
    recommendations.push('综合风险过高，暂不建议直接列入主力采购清单。');
  } else if (verdict === 'CONDITIONAL') {
    recommendations.push('资质处于合格区间，但存在特定风险点，建议小批量验证后再放量。');
  } else {
    recommendations.push('供应商资质与履约表现良好，毛利模型健康，可列为主选货源。');
  }

  if (tierAnalysis.has_tiered_pricing) {
    recommendations.push(`存在 ${tierAnalysis.tier_count} 级阶梯价，量大最高可享 ${tierAnalysis.max_discount_percent}% 折扣空间。`);
  }

  if (marginEconomics.gross_margin_percent < 50) {
    recommendations.push(`测算毛利率仅 ${marginEconomics.gross_margin_percent}%，广告投放容错率低，需评估提升零售端定价。`);
  } else {
    recommendations.push(`毛利率达 ${marginEconomics.gross_margin_percent}% (保本 ROAS: ${marginEconomics.break_even_roas})，出海投放空间充足。`);
  }

  for (const r of risks) {
    recommendations.push(`[${r.severity}] ${r.message} -> ${r.mitigation}`);
  }

  return {
    offer_id: offer.offer_id,
    title: offer.title,
    seller_name: offer.seller_name,
    supplier_score: supplierEvaluation.score,
    supplier_breakdown: supplierEvaluation.breakdown,
    verdict,
    risk_summary: {
      critical_count: criticalCount,
      warning_count: warningCount,
      triggers: risks,
    },
    tier_analysis: tierAnalysis,
    margin_economics: marginEconomics,
    recommendations,
    evaluated_at: new Date().toISOString(),
  };
}
