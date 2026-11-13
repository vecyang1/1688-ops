import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateParity,
  parseJustOneApiLinks,
  renderParityMatrixMarkdown,
  scaffoldMissingAdapters,
  loadParityRegistry,
  DEFAULT_REGISTRY_PATH,
} from '../src/parity.js';
import { buildProviderRequest } from '../src/api_fallback.js';

describe('Upstream Parity & Gap Detection Engine', () => {
  test('loadParityRegistry loads valid 1688 and taobao mappings', () => {
    const reg = loadParityRegistry(DEFAULT_REGISTRY_PATH);
    assert.ok(reg['1688'].onebound.item_get);
    assert.ok(reg['1688'].justoneapi['/en/api/1688/product-details-v1']);
    assert.ok(reg.taobao.onebound.item_question_answer);
    assert.ok(reg.taobao.justoneapi['/en/api/taobao-and-tmall/product-questions-v1']);
  });

  test('parseJustOneApiLinks deduplicates and extracts endpoint slugs', () => {
    const html = `
      <a href="/en/api/1688/product-details-v1">V1</a>
      <a href="/en/api/1688/product-details-v1">V1 dup</a>
      <a href="/en/api/1688/factory-search-v1">Factory</a>
    `;
    const list = parseJustOneApiLinks(html, '1688');
    assert.equal(list.length, 2);
    assert.equal(list[1].id, '/en/api/1688/factory-search-v1');
  });

  test('evaluateParity flags unmapped upstream gaps and missing local adapters', () => {
    const registry = {
      '1688': {
        onebound: { item_get: { local: '1688 item' }, buyer_cart_order: { excluded: true, reason: 'write' } },
        justoneapi: {},
      },
      taobao: {
        onebound: { item_get: { local: 'taobao detail' } },
        justoneapi: {},
      },
    };
    const catalogs = {
      '1688': {
        onebound: [
          { id: 'item_get', name: '详情' },
          { id: 'buyer_cart_order', name: '下单' },
          { id: 'new_magic_api', name: '新接口' },
        ],
        justoneapi: [],
      },
      taobao: {
        onebound: [{ id: 'item_get', name: '详情' }],
        justoneapi: [],
      },
    };
    const installedCommands = new Set(['1688 item']);
    const report = evaluateParity({ registry, catalogs, installedCommands });

    assert.equal(report.status, 'GAP_DETECTED');
    assert.equal(report.unmapped_gaps.length, 1);
    assert.equal(report.unmapped_gaps[0].endpoint, 'new_magic_api');
    assert.equal(report.broken_mappings.length, 1);
    assert.equal(report.broken_mappings[0].expectedLocal, 'taobao detail');

    const md = renderParityMatrixMarkdown(report);
    assert.match(md, /new_magic_api/);
    assert.match(md, /taobao detail/);
  });

  test('scaffoldMissingAdapters creates deterministic todo scaffolds in temp dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-scaffold-'));
    try {
      const created = scaffoldMissingAdapters(
        {
          unmapped_gaps: [
            { platform: '1688', provider: 'onebound', endpoint: 'item_new_feat', name: '新能力' },
          ],
        },
        { scaffoldDir1688: tmp, scaffoldDirTaobao: tmp }
      );
      assert.equal(created.length, 1);
      assert.ok(fs.existsSync(created[0]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('buildProviderRequest constructs clean URLs for JustOneAPI and OneBound', () => {
    const joUrl = buildProviderRequest('justoneapi', '1688', 'get-item-detail/v1', { itemId: '123' }, { token: 't1' });
    assert.equal(joUrl, 'https://api.justoneapi.com/api/1688/get-item-detail/v1?token=t1&itemId=123');
    const obUrl = buildProviderRequest('onebound', 'taobao', 'item_get', { num_iid: '456' }, { key: 'k1', secret: 's1' });
    assert.equal(obUrl, 'https://api-gw.onebound.cn/taobao/item_get/?key=k1&secret=s1&result_type=json&num_iid=456');
  });
});
