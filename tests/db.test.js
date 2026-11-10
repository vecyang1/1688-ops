import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDatabase,
  upsertOffer,
  upsertOffers,
  getOffer,
  listOffers,
  recordSearch,
  logAudit,
  getStats,
} from '../src/db.js';

describe('1688 SQLite Single Source of Truth Test Suite', () => {
  let db;

  beforeEach(() => {
    // 使用内存数据库隔离每个测试用例
    db = initDatabase(':memory:');
  });

  test('initializes schema with empty tables', () => {
    const stats = getStats(db);
    assert.deepEqual(stats, {
      offers: 0,
      cart_items: 0,
      orders: 0,
      searches: 0,
    });
  });

  test('upserts single offer and derives sales/return rate numbers', () => {
    const sample = {
      offer_id: '1024786474053',
      title: '户外折叠椅月亮椅',
      item_url: 'https://detail.1688.com/offer/1024786474053.html',
      seller_name: '江西以其户外用品有限公司',
      seller_url: 'https://shop751a009v46r94.1688.com',
      price_text: '¥27.00',
      price_min: 27,
      price_max: 27,
      sales_text: '全网1.4万+件',
      return_rate_text: '回头率 38%',
      moq_text: '1件起批',
      badges: ['退货包运费'],
    };

    upsertOffer(db, sample);

    const saved = getOffer(db, '1024786474053');
    assert.ok(saved);
    assert.equal(saved.offer_id, '1024786474053');
    assert.equal(saved.title, '户外折叠椅月亮椅');
    assert.equal(saved.price_min, 27);
    assert.equal(saved.sales_value, 14000); // 派生整数
    assert.equal(saved.return_rate_percent, 38.0); // 派生浮点百分比
    assert.equal(saved.moq_value, 1);
  });

  test('handles conflict update cleanly without duplicates', () => {
    const itemV1 = {
      offer_id: '888888',
      title: '初始标题',
      item_url: 'https://detail.1688.com/offer/888888.html',
      price_text: '¥10.0',
    };
    upsertOffer(db, itemV1);

    const itemV2 = {
      offer_id: '888888',
      title: '更新后标题',
      item_url: 'https://detail.1688.com/offer/888888.html',
      price_text: '¥9.5',
      sales_text: '全网2万+件',
    };
    upsertOffer(db, itemV2);

    const offers = listOffers(db);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].title, '更新后标题');
    assert.equal(offers[0].sales_value, 20000);
  });

  test('batch upsert offers and lists with sorting', () => {
    const batch = [
      {
        offer_id: '1',
        title: '低销量高价椅子',
        item_url: 'https://detail.1688.com/offer/1.html',
        price_text: '¥100',
        sales_text: '月销10件',
        return_rate_text: '回头率 10%',
      },
      {
        offer_id: '2',
        title: '高销量中价椅子',
        item_url: 'https://detail.1688.com/offer/2.html',
        price_text: '¥50',
        sales_text: '全网5万+件',
        return_rate_text: '回头率 45%',
      },
    ];

    upsertOffers(db, batch);

    const sortedBySales = listOffers(db, { sortBy: 'sales' });
    assert.equal(sortedBySales[0].offer_id, '2');

    const sortedByReturn = listOffers(db, { sortBy: 'return_rate' });
    assert.equal(sortedByReturn[0].offer_id, '2');

    const filtered = listOffers(db, { keyword: '低销量' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].offer_id, '1');
  });

  test('records search history and audit logs', () => {
    recordSearch(db, 'text', '折叠桌', ['1001', '1002']);
    logAudit(db, 'search', '折叠桌', '检索完成', { total: 2 });

    const stats = getStats(db);
    assert.equal(stats.searches, 1);
  });
});
