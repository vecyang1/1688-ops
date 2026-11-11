/**
 * 1688 对账与可观测性诊断器 (Diagnostic & Observability Engine)
 * 遵循“能读、能试、能调”三大铁律，严禁模拟假算法，直连真实解析器与数据库
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getStats, DEFAULT_DB_PATH } from './db.js';
import {
  parsePriceText,
  parseSales,
  parseReturnRate,
  parseMoq,
  cleanText,
  extractOfferId,
} from './extractor.js';

export function getAdapterDirs() {
  const homeDir = process.env.HOME || os.homedir();
  return {
    sourceAdaptersDir:
      process.env.HUB_1688_ADAPTER_SRC ||
      path.resolve(homeDir, 'Documents/A-coding/opencli-fork/clis/1688'),
    installedAdaptersDir:
      process.env.HUB_1688_ADAPTER_DEST ||
      path.resolve(homeDir, '.opencli/clis/1688'),
  };
}

function computeFileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * 1. 能读：读取当前运行态环境、认证、数据真理与适配器版本
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object}
 */
export function readSystemStatus(db) {
  const {
    sourceAdaptersDir: SOURCE_ADAPTERS_DIR,
    installedAdaptersDir: INSTALLED_ADAPTERS_DIR,
  } = getAdapterDirs();
  const dbPath = db ? DEFAULT_DB_PATH : null;
  const dbExists = dbPath ? fs.existsSync(dbPath) : false;
  const dbStats = db ? getStats(db) : null;
  const dbSizeBytes = dbExists ? fs.statSync(dbPath).size : 0;

  // 检查适配器同步状态
  const adapters = [
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

  const adapterCheck = adapters.map((name) => {
    const srcPath = path.join(SOURCE_ADAPTERS_DIR, name);
    const destPath = path.join(INSTALLED_ADAPTERS_DIR, name);
    const srcHash = computeFileHash(srcPath);
    const destHash = computeFileHash(destPath);
    const inSync = Boolean(srcHash && destHash && srcHash === destHash);
    return {
      adapter: name,
      inSync,
      srcHash,
      destHash,
    };
  });

  const outOfSyncCount = adapterCheck.filter((a) => !a.inSync).length;

  // 尝试检查 opencli 状态
  let cliVersion = 'unknown';
  try {
    cliVersion = execFileSync('opencli', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {}

  return {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      opencliVersion: cliVersion,
      sourceAdaptersDir: SOURCE_ADAPTERS_DIR,
      installedAdaptersDir: INSTALLED_ADAPTERS_DIR,
    },
    database: {
      path: dbPath,
      exists: dbExists,
      sizeBytes: dbSizeBytes,
      stats: dbStats,
    },
    adapters: {
      total: adapters.length,
      synced: adapters.length - outOfSyncCount,
      outOfSyncCount,
      details: adapterCheck,
    },
  };
}

/**
 * 2. 能试：使用真实生产解析函数现场测试样本，给出白盒推导对账证据
 * @param {object} samples
 * @returns {object}
 */
export function testLiveParser(samples = {}) {
  const defaultSamples = {
    priceCases: [
      '¥16.00-183.00',
      '¥ 27.50',
      '12.5~35.0',
      '38% 回头率 90天最低价 2026新款 ￥45.00',
      '折叠椅月亮椅 2026 便携款',
    ],
    salesCases: [
      '全网1.4万+件',
      '月销500+件',
      '已售3800',
      '销量 9999+',
    ],
    returnRateCases: [
      '回头率 38%',
      '复购率42.5%',
      '暂无复购',
    ],
    moqCases: [
      '1件起批',
      '100套起订',
      '拿样价格',
    ],
  };

  const activeSamples = { ...defaultSamples, ...samples };

  const priceResults = activeSamples.priceCases.map((input) => ({
    input,
    output: parsePriceText(input),
  }));

  const salesResults = activeSamples.salesCases.map((input) => ({
    input,
    output: parseSales(input),
  }));

  const returnRateResults = activeSamples.returnRateCases.map((input) => ({
    input,
    output: parseReturnRate(input),
  }));

  const moqResults = activeSamples.moqCases.map((input) => ({
    input,
    output: parseMoq(input),
  }));

  return {
    testedAt: new Date().toISOString(),
    priceParserVerification: priceResults,
    salesParserVerification: salesResults,
    returnRateParserVerification: returnRateResults,
    moqParserVerification: moqResults,
  };
}

/**
 * 3. 能调：调校与对齐适配器，从真实源头覆盖到 OpenCLI 运行区
 * @returns {object}
 */
export function reconcileAdapters() {
  const {
    sourceAdaptersDir: SOURCE_ADAPTERS_DIR,
    installedAdaptersDir: INSTALLED_ADAPTERS_DIR,
  } = getAdapterDirs();
  if (!fs.existsSync(SOURCE_ADAPTERS_DIR)) {
    throw new Error(`Source adapters dir not found: ${SOURCE_ADAPTERS_DIR}`);
  }

  if (!fs.existsSync(INSTALLED_ADAPTERS_DIR)) {
    fs.mkdirSync(INSTALLED_ADAPTERS_DIR, { recursive: true });
  }

  const files = fs.readdirSync(SOURCE_ADAPTERS_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  let copiedCount = 0;

  for (const f of files) {
    const src = path.join(SOURCE_ADAPTERS_DIR, f);
    const dest = path.join(INSTALLED_ADAPTERS_DIR, f);
    fs.copyFileSync(src, dest);
    copiedCount++;
  }

  // 重新检查 OpenCLI daemon
  let daemonReceipt = null;
  try {
    execFileSync('opencli', ['daemon', 'restart'], { encoding: 'utf-8' });
    daemonReceipt = 'Daemon restarted successfully';
  } catch (err) {
    daemonReceipt = `Daemon restart skipped: ${err.message}`;
  }

  return {
    action: 'reconcile',
    copiedCount,
    source: SOURCE_ADAPTERS_DIR,
    destination: INSTALLED_ADAPTERS_DIR,
    daemonReceipt,
  };
}
