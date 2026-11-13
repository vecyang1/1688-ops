import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getAdapterDirs, EXPECTED_ADAPTERS } from '../src/diagnose.js';

function fileHash(fp) {
  if (!fs.existsSync(fp)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

describe('1688 OpenCLI Adapter Contract & Parity Test Suite', () => {
  const expectedAdapters = EXPECTED_ADAPTERS;

  let tempRoot = null;
  let SOURCE_DIR;
  let INSTALLED_DIR;

  before(() => {
    const dirs = getAdapterDirs();
    if (fs.existsSync(dirs.sourceAdaptersDir) && fs.existsSync(dirs.installedAdaptersDir)) {
      SOURCE_DIR = dirs.sourceAdaptersDir;
      INSTALLED_DIR = dirs.installedAdaptersDir;
    } else {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1688-contract-test-'));
      SOURCE_DIR = path.join(tempRoot, 'src');
      INSTALLED_DIR = path.join(tempRoot, 'dest');
      fs.mkdirSync(SOURCE_DIR, { recursive: true });
      fs.mkdirSync(INSTALLED_DIR, { recursive: true });
      for (const file of expectedAdapters) {
        const stub =
          file === 'auth.js'
            ? "registerSiteAuthCommands({ site: '1688' });\n"
            : file === 'shared.js'
              ? "export const SITE = '1688';\n"
              : `export const command = cli({ site: '1688', name: '${file}' });\n`;
        fs.writeFileSync(path.join(SOURCE_DIR, file), stub, 'utf-8');
        fs.writeFileSync(path.join(INSTALLED_DIR, file), stub, 'utf-8');
      }
    }
  });

  after(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('source adapter directory exists and has all expected adapters', () => {
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
