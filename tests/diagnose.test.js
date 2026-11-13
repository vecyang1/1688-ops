import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initDatabase } from '../src/db.js';
import {
  EXPECTED_ADAPTERS,
  getAdapterDirs,
  readSystemStatus,
  testLiveParser,
  reconcileAdapters,
} from '../src/diagnose.js';

describe('1688 Diagnostics & Observability Test Suite', () => {
  let tempRoot = null;
  let prevSrc;
  let prevDest;

  before(() => {
    const { sourceAdaptersDir } = getAdapterDirs();
    if (!fs.existsSync(sourceAdaptersDir)) {
      prevSrc = process.env.HUB_1688_ADAPTER_SRC;
      prevDest = process.env.HUB_1688_ADAPTER_DEST;
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1688-diag-test-'));
      const srcDir = path.join(tempRoot, 'src');
      const destDir = path.join(tempRoot, 'dest');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of EXPECTED_ADAPTERS) {
        const stub =
          file === 'auth.js'
            ? "registerSiteAuthCommands({ site: '1688' });\n"
            : file === 'shared.js'
              ? "export const SITE = '1688';\n"
              : `export const command = cli({ site: '1688', name: '${file}' });\n`;
        fs.writeFileSync(path.join(srcDir, file), stub, 'utf-8');
        fs.writeFileSync(path.join(destDir, file), stub, 'utf-8');
      }
      process.env.HUB_1688_ADAPTER_SRC = srcDir;
      process.env.HUB_1688_ADAPTER_DEST = destDir;
    }
  });

  after(() => {
    if (tempRoot) {
      if (prevSrc === undefined) delete process.env.HUB_1688_ADAPTER_SRC;
      else process.env.HUB_1688_ADAPTER_SRC = prevSrc;
      if (prevDest === undefined) delete process.env.HUB_1688_ADAPTER_DEST;
      else process.env.HUB_1688_ADAPTER_DEST = prevDest;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('readSystemStatus reports environment, database stats, and adapter parity', () => {
    const db = initDatabase(':memory:');
    const status = readSystemStatus(db);

    assert.ok(status.timestamp);
    assert.ok(status.environment.nodeVersion);
    assert.equal(status.adapters.total, EXPECTED_ADAPTERS.length);
    assert.equal(status.adapters.synced, EXPECTED_ADAPTERS.length);
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
