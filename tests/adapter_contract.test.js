import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const SOURCE_DIR = path.resolve(
  process.env.HOME,
  'Documents/A-coding/opencli-fork/clis/1688'
);
const INSTALLED_DIR = path.resolve(
  process.env.HOME,
  '.opencli/clis/1688'
);

function fileHash(fp) {
  if (!fs.existsSync(fp)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

describe('1688 OpenCLI Adapter Contract & Parity Test Suite', () => {
  const expectedAdapters = [
    'search.js',
    'item.js',
    'store.js',
    'assets.js',
    'download.js',
    'auth.js',
    'cart.js',
    'orders.js',
    'image-search.js',
    'shared.js',
  ];

  test('source adapter directory exists and has all 10 adapters', () => {
    assert.ok(fs.existsSync(SOURCE_DIR), `Source directory does not exist: ${SOURCE_DIR}`);
    for (const file of expectedAdapters) {
      const p = path.join(SOURCE_DIR, file);
      assert.ok(fs.existsSync(p), `Missing source adapter: ${file}`);
    }
  });

  test('installed adapter directory is byte-for-byte in sync with source', () => {
    assert.ok(fs.existsSync(INSTALLED_DIR), `Installed directory does not exist: ${INSTALLED_DIR}`);
    for (const file of expectedAdapters) {
      const srcPath = path.join(SOURCE_DIR, file);
      const destPath = path.join(INSTALLED_DIR, file);
      const srcH = fileHash(srcPath);
      const destH = fileHash(destPath);
      assert.equal(
        destH,
        srcH,
        `Adapter drift detected in ${file}! Run '1688-ops install-adapters' to reconcile.`
      );
    }
  });

  test('all command adapters declare declarative cli contract', () => {
    for (const file of expectedAdapters) {
      if (file === 'shared.js') continue;
      const srcPath = path.join(SOURCE_DIR, file);
      const code = fs.readFileSync(srcPath, 'utf-8');
      if (file === 'auth.js') {
        assert.match(code, /registerSiteAuthCommands\(\s*\{\s*site:\s*['"]1688['"]/, `${file} must register site auth for 1688`);
      } else {
        assert.match(code, /(?:export\s+const\s+command\s*=\s*)?cli\(\s*\{/, `${file} must call cli({...})`);
        assert.match(code, /site:\s*['"]1688['"]/, `${file} must declare site: '1688'`);
      }
    }
  });
});
