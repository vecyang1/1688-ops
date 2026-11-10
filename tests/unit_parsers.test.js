import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  parsePriceText,
  parseMoq,
  parseSales,
  parseReturnRate,
  extractOfferId,
  extractShopIdentifiers,
} from '../src/extractor.js';

describe('1688 Extractor & Pure Parsers Test Suite', () => {
  describe('cleanText', () => {
    test('cleans tabs, newlines, and multi-spaces', () => {
      assert.equal(cleanText('  hello \n\t  world  '), 'hello world');
      assert.equal(cleanText(''), '');
      assert.equal(cleanText(null), '');
      assert.equal(cleanText(undefined), '');
    });
  });

  describe('parsePriceText', () => {
    test('parses single price with currency symbol', () => {
      const res = parsePriceText('¥ 27.50');
      assert.equal(res.price_min, 27.5);
      assert.equal(res.price_max, 27.5);
      assert.equal(res.currency, 'CNY');
      assert.equal(res.price_text, '¥27.5');
    });

    test('parses price range correctly', () => {
      const res = parsePriceText('¥16.00-183.00');
      assert.equal(res.price_min, 16);
      assert.equal(res.price_max, 183);
      assert.equal(res.currency, 'CNY');
      assert.equal(res.price_text, '¥16-183');
    });

    test('parses price range with tilde', () => {
      const res = parsePriceText('12.5~35.0');
      assert.equal(res.price_min, 12.5);
      assert.equal(res.price_max, 35);
      assert.equal(res.currency, 'CNY');
    });

    test('filters out year numbers like 2026', () => {
      const res = parsePriceText('户外折叠椅 2026 便携露营款');
      assert.equal(res.price_min, null);
      assert.equal(res.price_text, '');
    });

    test('prioritizes real price in dirty promo text', () => {
      const res = parsePriceText('回头率38% 90天最低价 2026新品 ￥45.00');
      assert.equal(res.price_min, 45);
      assert.equal(res.currency, 'CNY');
    });
  });

  describe('parseSales', () => {
    test('parses 1.4万+件 to 14000', () => {
      const res = parseSales('全网1.4万+件');
      assert.equal(res.sales_value, 14000);
      assert.equal(res.sales_text, '全网1.4万+件');
    });

    test('parses 500+件 to 500', () => {
      const res = parseSales('月销500+件');
      assert.equal(res.sales_value, 500);
    });

    test('handles empty or non-numeric sales string', () => {
      assert.equal(parseSales('').sales_value, null);
      assert.equal(parseSales('热销爆款').sales_value, null);
    });
  });

  describe('parseReturnRate', () => {
    test('parses 回头率 38%', () => {
      const res = parseReturnRate('回头率 38%');
      assert.equal(res.return_rate_percent, 38.0);
      assert.equal(res.return_rate_text, '回头率 38%');
    });

    test('parses 复购率42.5%', () => {
      const res = parseReturnRate('复购率42.5%');
      assert.equal(res.return_rate_percent, 42.5);
    });

    test('returns null for absent rate', () => {
      const res = parseReturnRate('暂无数据');
      assert.equal(res.return_rate_percent, null);
    });
  });

  describe('parseMoq', () => {
    test('parses 1件起批', () => {
      const res = parseMoq('1件起批');
      assert.equal(res.moq_value, 1);
    });

    test('parses 100套起订', () => {
      const res = parseMoq('100套起订');
      assert.equal(res.moq_value, 100);
    });
  });

  describe('extractOfferId & Shop identifiers', () => {
    test('extracts offerId from 1688 detail URL', () => {
      assert.equal(extractOfferId('https://detail.1688.com/offer/1024786474053.html'), '1024786474053');
      assert.equal(extractOfferId('https://detail.1688.com/offer/1024786474053.html?spm=a26352'), '1024786474053');
    });

    test('extracts shop id from shop subdomain', () => {
      const res = extractShopIdentifiers('https://shop751a009v46r94.1688.com');
      assert.equal(res.shop_id, 'shop751a009v46r94');
    });
  });
});
