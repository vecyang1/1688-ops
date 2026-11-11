import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSupplierScore,
  analyzePriceTiers,
  estimateMarginAndProfit,
  evaluateRiskTriggers,
  reasonOffer,
} from '../src/reasoner.js';

describe('1688 Sourcing Reasoner & Risk Engine Test Suite', () => {
  describe('evaluateSupplierScore', () => {
    it('scores high for verified super factory with high return rate and sales', () => {
      const offer = {
        offer_id: '1001',
        title: '高档铝合金折叠椅户外露营',
        seller_name: '永康市实业制造有限公司',
        return_rate_percent: 42.5,
        sales_value: 25000,
        badges_json: JSON.stringify(['超级工厂', '深度验厂', '破损包赔', '48小时发货']),
        delivery_days_text: '48小时发货',
        price_min: 35.0,
        price_max: 38.0,
        moq_value: 2,
      };

      const result = evaluateSupplierScore(offer);
      assert.ok(result.score >= 80, `Expected score >= 80, got ${result.score}`);
      assert.equal(result.breakdown.return_rate_score, 30);
      assert.equal(result.breakdown.sales_score, 20);
      assert.ok(result.breakdown.factory_badge_score >= 18);
    });

    it('scores low for unverified seller with zero sales and no return rate', () => {
      const offer = {
        offer_id: '1002',
        title: '某贸易商普通塑料椅',
        seller_name: '义乌市某某商贸部',
        return_rate_percent: null,
        sales_value: 0,
        badges_json: JSON.stringify([]),
        price_min: 10.0,
        price_max: 40.0,
        moq_value: 100,
      };

      const result = evaluateSupplierScore(offer);
      assert.ok(result.score < 50, `Expected score < 50, got ${result.score}`);
      assert.equal(result.breakdown.sales_score, 0);
    });
  });

  describe('analyzePriceTiers', () => {
    it('correctly calculates tiers and discount percentages', () => {
      const offer = {
        price_tiers: [
          { min_qty: 2, unit_price: 35.0 },
          { min_qty: 50, unit_price: 31.5 },
          { min_qty: 500, unit_price: 28.0 },
        ],
      };

      const res = analyzePriceTiers(offer);
      assert.equal(res.has_tiered_pricing, true);
      assert.equal(res.tier_count, 3);
      assert.equal(res.base_unit_price, 35.0);
      assert.equal(res.lowest_unit_price, 28.0);
      assert.equal(res.max_discount_percent, 20);
    });

    it('handles single flat price without crash', () => {
      const offer = {
        price_min: 25.0,
        price_max: 25.0,
        moq_value: 1,
      };

      const res = analyzePriceTiers(offer);
      assert.equal(res.has_tiered_pricing, false);
      assert.equal(res.base_unit_price, 25.0);
      assert.equal(res.max_discount_percent, 0);
    });
  });

  describe('estimateMarginAndProfit', () => {
    it('calculates landed cost, USD conversion, and break-even ROAS', () => {
      const offer = {
        price_min: 25.0,
      };

      const res = estimateMarginAndProfit(offer, {
        target_retail_price: 29.99,
        target_currency: 'USD',
        exchange_rate: 7.2,
        domestic_shipping_cny: 3.0,
        intl_shipping_cny: 26.0,
        platform_fee_percent: 3.5,
      });

      // 采购 25 + 国内 3 + 跨境 26 = 54 CNY -> 54 / 7.2 = 7.5 USD
      assert.equal(res.landed_cost_cny, 54.0);
      assert.equal(res.landed_cost_usd, 7.5);
      assert.equal(res.retail_price_usd, 29.99);
      assert.ok(res.gross_profit_usd > 20.0);
      assert.ok(res.gross_margin_percent > 65.0);
      assert.ok(res.break_even_roas < 1.5);
    });
  });

  describe('evaluateRiskTriggers', () => {
    it('flags CRITICAL on price bait (wide price span > 3x)', () => {
      const offer = {
        price_min: 5.0,
        price_max: 55.0, // 11x price difference
        badges: ['超级工厂'],
        return_rate_percent: 25,
        sales_value: 1000,
      };

      const risks = evaluateRiskTriggers(offer);
      const wideSpan = risks.find((r) => r.code === 'WIDE_PRICE_SPAN');
      assert.ok(wideSpan, 'Should trigger WIDE_PRICE_SPAN');
      assert.equal(wideSpan.severity, 'CRITICAL');
    });

    it('flags WARNING on low return rate and high MOQ', () => {
      const offer = {
        price_min: 20.0,
        price_max: 20.0,
        badges: ['超级工厂', '破损包赔'],
        return_rate_percent: 8.5, // < 15%
        moq_value: 200, // > 50
        sales_value: 500,
      };

      const risks = evaluateRiskTriggers(offer);
      const lowReturn = risks.find((r) => r.code === 'LOW_RETURN_RATE');
      const highMoq = risks.find((r) => r.code === 'HIGH_MOQ');
      assert.ok(lowReturn, 'Should trigger LOW_RETURN_RATE');
      assert.ok(highMoq, 'Should trigger HIGH_MOQ');
    });
  });

  describe('reasonOffer (End-to-End)', () => {
    it('returns RECOMMENDED for high quality offer', () => {
      const offer = {
        offer_id: '9901',
        title: '跨境热销露营折叠桌蛋卷桌',
        seller_name: '永康市优品户外用品制造厂',
        return_rate_percent: 36.5,
        sales_value: 8000,
        badges_json: JSON.stringify(['超级工厂', '破损包赔', '48小时发货']),
        delivery_days_text: '48小时发货',
        price_min: 40.0,
        price_max: 45.0,
        moq_value: 2,
        price_tiers: [
          { min_qty: 2, unit_price: 45.0 },
          { min_qty: 20, unit_price: 42.0 },
          { min_qty: 100, unit_price: 39.0 },
        ],
      };

      const result = reasonOffer(offer, { target_retail_price: 49.99 });
      assert.equal(result.verdict, 'RECOMMENDED');
      assert.ok(result.supplier_score >= 75);
      assert.equal(result.risk_summary.critical_count, 0);
      assert.ok(result.recommendations.length > 0);
    });

    it('returns HIGH_RISK when price bait and unverified seller coincide', () => {
      const offer = {
        offer_id: '9902',
        title: '超低价便携水壶',
        seller_name: '某个人贸易',
        return_rate_percent: 5.0,
        sales_value: 0,
        badges_json: JSON.stringify([]),
        price_min: 2.0,
        price_max: 28.0, // 14x
        moq_value: 100,
      };

      const result = reasonOffer(offer);
      assert.equal(result.verdict, 'HIGH_RISK');
      assert.ok(result.risk_summary.critical_count >= 1);
    });
  });
});
