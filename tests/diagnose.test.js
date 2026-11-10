import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase } from '../src/db.js';
import {
  readSystemStatus,
  testLiveParser,
  reconcileAdapters,
} from '../src/diagnose.js';

describe('1688 Diagnostics & Observability Test Suite', () => {
  test('readSystemStatus reports environment, database stats, and adapter parity', () => {
    const db = initDatabase(':memory:');
    const status = readSystemStatus(db);

    assert.ok(status.timestamp);
    assert.ok(status.environment.nodeVersion);
    assert.equal(status.adapters.total, 10);
    assert.equal(status.adapters.synced, 10);
    assert.equal(status.adapters.outOfSyncCount, 0);
  });

  test('testLiveParser produces comprehensive verification evidence', () => {
    const report = testLiveParser();

    assert.ok(report.testedAt);
    assert.ok(report.priceParserVerification.length >= 4);
    assert.ok(report.salesParserVerification.length >= 3);
    assert.ok(report.returnRateParserVerification.length >= 2);
    assert.ok(report.moqParserVerification.length >= 2);

    const chairPrice = report.priceParserVerification.find((p) => p.input.includes('27.50'));
    assert.equal(chairPrice.output.price_min, 27.5);

    const chairSales = report.salesParserVerification.find((s) => s.input.includes('1.4万'));
    assert.equal(chairSales.output.sales_value, 14000);
  });

  test('reconcileAdapters synchronizes without error', () => {
    const res = reconcileAdapters();
    assert.equal(res.action, 'reconcile');
    assert.ok(res.copiedCount >= 10);
  });
});
