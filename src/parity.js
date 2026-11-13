/**
 * 1688 & Taobao Upstream Parity Auditor & Auto-Absorption Engine
 * Compares live OneBound + JustOneAPI endpoint catalogs against local OpenCLI / 1688-ops wheels.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_REGISTRY_PATH = path.join(REPO_ROOT, 'docs', 'parity_registry.json');
export const DEFAULT_MATRIX_DOC_PATH = path.join(REPO_ROOT, 'docs', 'api_parity_matrix.md');

export function loadParityRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
}

export async function fetchOneBoundCatalog(platform) {
  const url = `https://api.onebound.cn/${platform}/?test`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`OneBound ${platform} catalog HTTP ${res.status}`);
  }
  const data = await res.json();
  const apis = data?.APIS || {};
  return Object.entries(apis).map(([id, meta]) => ({
    id,
    name: String(meta?.name || ''),
  }));
}

export function parseJustOneApiLinks(html, platformPrefix) {
  const regex = new RegExp(`href="(/en/api/${platformPrefix}/[a-z0-9-]+)"`, 'gi');
  const seen = new Set();
  const results = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ id: href, name: href.split('/').pop() || href });
  }
  return results;
}

export async function fetchJustOneApiCatalog(platform) {
  const slug = platform === 'taobao' ? 'taobao-and-tmall' : '1688';
  const url = `https://docs.justoneapi.com/en/api/${slug}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`JustOneAPI ${platform} catalog HTTP ${res.status}`);
  }
  const html = await res.text();
  return parseJustOneApiLinks(html, slug);
}

export function discoverInstalledCommands(options = {}) {
  const home = process.env.HOME || os.homedir();
  const dir1688 = options.dir1688 || path.join(home, '.opencli/clis/1688');
  const dirTaobao = options.dirTaobao || path.join(home, '.opencli/clis/taobao');
  const forkTaobao = options.forkTaobao || path.join(home, 'Documents/A-coding/opencli-fork/clis/taobao');

  const commands = new Set(['1688 login', '1688 whoami', 'taobao login', 'taobao whoami']);

  const scanDir = (dir, site) => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js') || file.endsWith('.test.js') || file === 'shared.js' || file === 'auth.js') {
        continue;
      }
      const name = file.replace(/\.js$/, '');
      commands.add(`${site} ${name}`);
    }
  };

  scanDir(dir1688, '1688');
  scanDir(dirTaobao, 'taobao');
  scanDir(forkTaobao, 'taobao');

  return commands;
}

export function evaluateParity({ registry, catalogs, installedCommands }) {
  const gaps = [];
  const brokenMappings = [];
  const summary = {};

  for (const platform of ['1688', 'taobao']) {
    summary[platform] = {};
    for (const provider of ['onebound', 'justoneapi']) {
      const mapping = registry?.[platform]?.[provider] || {};
      const liveList = catalogs?.[platform]?.[provider] || [];
      let covered = 0;
      let excluded = 0;
      let missing = 0;

      for (const ep of liveList) {
        const entry = mapping[ep.id];
        if (!entry) {
          missing += 1;
          gaps.push({
            platform,
            provider,
            endpoint: ep.id,
            name: ep.name,
            reason: 'UNMAPPED_UPSTREAM_ENDPOINT',
          });
          continue;
        }
        if (entry.excluded) {
          excluded += 1;
          continue;
        }
        if (entry.local && !installedCommands.has(entry.local)) {
          missing += 1;
          brokenMappings.push({
            platform,
            provider,
            endpoint: ep.id,
            expectedLocal: entry.local,
            reason: 'LOCAL_ADAPTER_NOT_INSTALLED',
          });
          continue;
        }
        covered += 1;
      }

      const activeTotal = covered + missing;
      summary[platform][provider] = {
        live_total: liveList.length,
        covered,
        excluded,
        missing,
        active_coverage_percent: activeTotal > 0 ? Math.round((covered / activeTotal) * 1000) / 10 : 100,
      };
    }
  }

  return {
    checked_at: new Date().toISOString(),
    status: gaps.length === 0 && brokenMappings.length === 0 ? 'PARITY_OK' : 'GAP_DETECTED',
    summary,
    unmapped_gaps: gaps,
    broken_mappings: brokenMappings,
  };
}

export function renderParityMatrixMarkdown(report) {
  const lines = [
    '# 1688 & Taobao 本地轮子与 OneBound / JustOneAPI 对标矩阵',
    '',
    `- 最近巡检时间: \`${report.checked_at}\``,
    `- 总体状态: \`${report.status}\``,
    '',
    '## 覆盖率汇总',
    '',
    '| 平台 | 上游数据源 | 在线端点总数 | 本地已覆盖 | 明确排除(安全/后台写操作) | 缺失缺口 | 有效覆盖率 |',
    '|---|---|---|---|---|---|---|',
  ];

  for (const platform of ['1688', 'taobao']) {
    for (const provider of ['onebound', 'justoneapi']) {
      const s = report.summary[platform][provider];
      lines.push(
        `| ${platform} | ${provider} | ${s.live_total} | ${s.covered} | ${s.excluded} | ${s.missing} | ${s.active_coverage_percent}% |`
      );
    }
  }

  if (report.unmapped_gaps.length > 0 || report.broken_mappings.length > 0) {
    lines.push('', '## 待吸收缺口清单', '');
    for (const g of report.unmapped_gaps) {
      lines.push(`- [UNMAPPED] \`${g.platform}/${g.provider}\` \`${g.endpoint}\` (${g.name})`);
    }
    for (const b of report.broken_mappings) {
      lines.push(`- [MISSING_LOCAL] \`${b.platform}/${b.provider}\` \`${b.endpoint}\` -> expected \`${b.expectedLocal}\``);
    }
  } else {
    lines.push('', '## 缺口状态', '', '当前所有高价值只读/选品/对账端点均已 100% 覆盖且本地适配器同步完好。');
  }

  lines.push('');
  return lines.join('\n');
}

export function scaffoldMissingAdapters(report, options = {}) {
  const home = process.env.HOME || os.homedir();
  const scaffoldDir1688 = options.scaffoldDir1688 || path.join(home, 'Documents/A-coding/opencli-fork/clis/1688');
  const scaffoldDirTaobao = options.scaffoldDirTaobao || path.join(home, 'Documents/A-coding/opencli-plugin-taobao/clis/taobao');
  const created = [];

  for (const gap of report.unmapped_gaps || []) {
    const slug = gap.endpoint.split('/').pop().replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    const targetDir = gap.platform === 'taobao' ? scaffoldDirTaobao : scaffoldDir1688;
    const targetFile = path.join(targetDir, `${slug}.todo.js`);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    if (!fs.existsSync(targetFile)) {
      fs.writeFileSync(
        targetFile,
        `// Auto-scaffolded candidate for ${gap.platform}/${gap.provider}: ${gap.endpoint} (${gap.name})\n// Review and implement with cli({ site: '${gap.platform}', name: '${slug}', ... }) or mark excluded in docs/parity_registry.json\n`,
        'utf-8'
      );
      created.push(targetFile);
    }
  }
  return created;
}

export async function runParityAudit(options = {}) {
  const registry = loadParityRegistry(options.registryPath || DEFAULT_REGISTRY_PATH);
  const catalogs = options.catalogs || {
    1688: {
      onebound: await fetchOneBoundCatalog('1688'),
      justoneapi: await fetchJustOneApiCatalog('1688'),
    },
    taobao: {
      onebound: await fetchOneBoundCatalog('taobao'),
      justoneapi: await fetchJustOneApiCatalog('taobao'),
    },
  };
  const installedCommands = options.installedCommands || discoverInstalledCommands(options);
  const report = evaluateParity({ registry, catalogs, installedCommands });

  if (options.writeMatrix !== false) {
    const matrixPath = options.matrixPath || DEFAULT_MATRIX_DOC_PATH;
    fs.writeFileSync(matrixPath, renderParityMatrixMarkdown(report), 'utf-8');
  }

  let scaffolded = [];
  if (options.scaffold && report.unmapped_gaps.length > 0) {
    scaffolded = scaffoldMissingAdapters(report, options);
  }

  return {
    ...report,
    scaffolded,
  };
}
