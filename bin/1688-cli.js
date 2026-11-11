#!/usr/bin/env node

/**
 * 1688 Agentic Operations CLI (1688-ops / 1688-cli)
 * 批发采购、以图搜款、详情对账与离线真理库管理工具
 */

import { parseArgs } from 'node:util';
import {
  initDatabase,
  listOffers,
  getOffer,
  getStats,
  listCartItems,
  listOrders,
} from '../src/db.js';
import { HubClient1688 } from '../src/client.js';
import {
  readSystemStatus,
  testLiveParser,
  reconcileAdapters,
} from '../src/diagnose.js';
import { reasonOffer } from '../src/reasoner.js';

function printHelp() {
  console.log(`
1688 批发采购与货源对账控制台 (1688-ops / 1688-cli)

基础诊断与认证:
  1688-ops doctor                   检查 1688 登录态、操作者身份与浏览器桥接
  1688-ops whoami                   输出当前登录用户信息 (JSON)

在线货源检索与抓取:
  1688-ops search <关键词> [--limit 20] [--pages 1] [--sort sales|price|return_rate] [--no-sync]
  1688-ops image-search <图片路径/URL> [--limit 20]
  1688-ops item <offer_id> [--no-sync]
  1688-ops store <member_id或店铺URL>
  1688-ops cart                     抓取当前采购车条目
  1688-ops orders [--pages 1]       抓取买家采购订单列表

智能推理与毛利风险对账:
  1688-ops reason <offer_id> [--target-price P] [--currency USD] [--live] [--json]
                                    执行供应商评分、阶梯价、毛利模型与 7 项风险排查

离线数据真理库 (SQLite):
  1688-ops db list [--limit 20] [--keyword 词] [--sort sales|return_rate|price_asc]
  1688-ops db stats                 查看本地离线库统计数据
  1688-ops inspect <offer_id>       查看指定商品的深度审计指标与派生字段

可观测性与对账器 (能读、能试、能调):
  1688-ops diagnose                 全面检查环境、数据统计与适配器同步状态 (能读)
  1688-ops diagnose --test-parser   使用现场样本执行纯函数白盒推导对账 (能试)
  1688-ops diagnose --reconcile     将适配器源码热同步至 OpenCLI 运行区 (能调)
  1688-ops install-adapters         同步并校验 OpenCLI 适配器
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(0);
  }

  const db = initDatabase();
  const client = new HubClient1688({ db });

  try {
    switch (command) {
      case 'doctor':
      case 'whoami': {
        const info = await client.whoami();
        if (command === 'whoami') {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log('\n--- 1688 运行环境与身份诊断 ---');
          console.log(`登录状态: ${info.logged_in ? '已登录' : '未登录'}`);
          console.log(`用户账号: ${info.name || '未知'}`);
          console.log(`用户编号: ${info.user_id || '未知'}`);
          console.log(`站点域名: ${info.site || '1688.com'}`);
          console.log('--------------------------------\n');
        }
        break;
      }

      case 'search': {
        const keyword = argv[1];
        if (!keyword || keyword.startsWith('-')) {
          console.error('错误: 请提供搜索关键词。例: 1688-ops search "折叠椅"');
          process.exit(1);
        }

        const limitArgIdx = argv.indexOf('--limit');
        const limit = limitArgIdx !== -1 && argv[limitArgIdx + 1] ? parseInt(argv[limitArgIdx + 1], 10) : 10;
        const pagesArgIdx = argv.indexOf('--pages');
        const pages = pagesArgIdx !== -1 && argv[pagesArgIdx + 1] ? parseInt(argv[pagesArgIdx + 1], 10) : (limit > 20 ? Math.ceil(limit / 20) : 1);
        const noSync = argv.includes('--no-sync');

        const activeClient = noSync ? new HubClient1688() : client;
        console.log(`正在检索 1688 货源: "${keyword}" (上限: ${limit}, 页数: ${pages})...`);

        const items = await activeClient.search(keyword, { limit, pages });
        console.log(`检索完成，获取 ${items.length} 条记录:\n`);

        const tableRows = items.map((it, idx) => ({
          序号: idx + 1,
          商品编号: it.offer_id,
          标题: (it.title || '').slice(0, 28),
          单价: it.price_text || '待询',
          销量: it.sales_text || '-',
          回头率: it.return_rate_text || '-',
          供应商: (it.seller_name || '').slice(0, 16),
        }));

        console.table(tableRows);
        break;
      }

      case 'image-search': {
        const imgTarget = argv[1];
        if (!imgTarget) {
          console.error('错误: 请提供本地图片路径或网络图片 URL。例: 1688-ops image-search /path/to/img.jpg');
          process.exit(1);
        }

        const limitArgIdx = argv.indexOf('--limit');
        const limit = limitArgIdx !== -1 && argv[limitArgIdx + 1] ? parseInt(argv[limitArgIdx + 1], 10) : 10;

        console.log(`正在以图搜款: ${imgTarget} (数量上限: ${limit})...`);
        const items = await client.imageSearch(imgTarget, { limit });
        console.log(`搜图完成，匹配到 ${items.length} 个候选商品:\n`);

        if (items.length > 0) {
          const tableRows = items.map((it, idx) => ({
            匹配度: idx + 1,
            商品编号: it.offer_id,
            标题: (it.title || '').slice(0, 28),
            价格: it.price_text || '待询',
            销量: it.sales_text || '-',
            供应商: (it.seller_name || '').slice(0, 16),
          }));
          console.table(tableRows);
        }
        break;
      }

      case 'item': {
        const offerId = argv[1];
        if (!offerId) {
          console.error('错误: 请提供 1688 商品 ID。例: 1688-ops item 1024786474053');
          process.exit(1);
        }

        console.log(`正在抓取商品详情: ${offerId}...`);
        const item = await client.getItem(offerId);

        console.log('\n--- 1688 商品详情 ---');
        console.log(`商品编号: ${item.offer_id}`);
        console.log(`商品标题: ${item.title}`);
        console.log(`价格区间: ${item.price_text}`);
        console.log(`起订数量: ${item.moq_text || '1件起批'}`);
        console.log(`供应商名: ${item.seller_name}`);
        console.log(`发货时效: ${item.delivery_days_text || '-'}`);
        console.log(`服务承诺: ${(item.service_badges || item.badges || []).join(' | ')}`);
        console.log(`商品链接: ${item.item_url}`);
        if (item.main_images && item.main_images.length > 0) {
          console.log(`主图数量: ${item.main_images.length} 张`);
          console.log(`首图预览: ${item.main_images[0]}`);
        }
        console.log('----------------------\n');
        break;
      }

      case 'store': {
        const target = argv[1];
        if (!target) {
          console.error('错误: 请提供店铺 URL 或 memberId。例: 1688-ops store shop751a009v46r94');
          process.exit(1);
        }
        console.log(`正在抓取店铺信息: ${target}...`);
        const store = await client.getStore(target);
        console.log('\n--- 1688 店铺档案 ---');
        console.log(`店铺名称: ${store.store_name || store.company_name}`);
        console.log(`经营模式: ${store.business_model_text || '-'}`);
        console.log(`入驻年限: ${store.years_on_platform_text || '-'}`);
        console.log(`物理地址: ${store.location || '-'}`);
        console.log(`员工规模: ${store.staff_size_text || '-'}`);
        console.log(`回复速度: ${store.response_rate_text || '-'}`);
        console.log(`店铺链接: ${store.store_url || store.company_url}`);
        console.log(`工厂认证: ${(store.factory_badges || []).join(' | ') || '-'}`);
        console.log(`服务保障: ${(store.service_badges || []).join(' | ') || '-'}`);
        console.log('----------------------\n');
        break;
      }

      case 'cart': {
        const noSync = argv.includes('--no-sync');
        console.log('正在拉取买家采购车...');
        const cart = await client.getCart({ sync: !noSync });
        console.log(`采购车拉取完成，共 ${cart.length} 个条目:\n`);

        if (cart.length > 0) {
          const rows = cart.map((it, idx) => ({
            序号: idx + 1,
            店铺: (it.shop_name || '').slice(0, 16),
            商品: (it.title || '').slice(0, 24),
            规格: (it.spec || '').slice(0, 16),
            单价: it.price_text || it.price,
            数量: it.quantity,
            状态: it.is_invalid ? '失效' : '正常',
          }));
          console.table(rows);
        } else {
          console.log('采购车当前为空。');
        }
        break;
      }

      case 'orders': {
        const noSync = argv.includes('--no-sync');
        console.log('正在拉取采购订单流水...');
        const orders = await client.getOrders({ sync: !noSync });
        console.log(`订单拉取完成，共 ${orders.length} 条记录:\n`);

        if (orders.length > 0) {
          const rows = orders.map((o, idx) => ({
            序号: idx + 1,
            订单号: o.order_id,
            下单日期: o.order_date || '-',
            供应商: (o.shop_name || '').slice(0, 16),
            商品: (o.title || '').slice(0, 24),
            金额: o.total_amount ? `¥${o.total_amount}` : '-',
            状态: o.status || '正常',
          }));
          console.table(rows);
        } else {
          console.log('暂无采购订单记录。');
        }
        break;
      }

      case 'db': {
        const sub = argv[1];
        if (sub === 'stats') {
          const stats = getStats(db);
          console.log('\n--- 离线数据真理库统计 ---');
          console.log(`商品记录数 (Offers): ${stats.offers}`);
          console.log(`购物车条目 (Cart): ${stats.cart_items}`);
          console.log(`采购订单数 (Orders): ${stats.orders}`);
          console.log(`检索历史数 (Searches): ${stats.searches}`);
          console.log('---------------------------\n');
        } else if (sub === 'cart') {
          const items = listCartItems(db);
          console.log(`\n离线购物车条目 (共 ${items.length} 条):`);
          if (items.length > 0) {
            const rows = items.map((it, idx) => ({
              序号: idx + 1,
              商品: (it.title || '').slice(0, 24),
              规格: it.spec_name || '-',
              单价: it.price,
              数量: it.quantity,
              小计: it.subtotal,
              状态: it.status,
              供应商: (it.seller_name || '').slice(0, 16),
            }));
            console.table(rows);
          }
        } else if (sub === 'orders') {
          const orders = listOrders(db);
          console.log(`\n离线采购订单 (共 ${orders.length} 条):`);
          if (orders.length > 0) {
            const rows = orders.map((o, idx) => ({
              序号: idx + 1,
              订单号: o.order_id,
              供应商: (o.seller_name || '').slice(0, 16),
              金额: o.total_amount ? `¥${o.total_amount}` : '-',
              状态: o.status_text,
              下单时间: o.order_time || '-',
            }));
            console.table(rows);
          }
        } else {
          // list
          const limitIdx = argv.indexOf('--limit');
          const limit = limitIdx !== -1 && argv[limitIdx + 1] ? parseInt(argv[limitIdx + 1], 10) : 20;

          const kwIdx = argv.indexOf('--keyword');
          const keyword = kwIdx !== -1 ? argv[kwIdx + 1] : null;

          const sortIdx = argv.indexOf('--sort');
          const sortBy = sortIdx !== -1 ? argv[sortIdx + 1] : null;

          const offers = listOffers(db, { limit, keyword, sortBy });
          console.log(`\n离线库记录 (当前展示: ${offers.length} 条):`);

          const tableRows = offers.map((o, idx) => ({
            序号: idx + 1,
            编号: o.offer_id,
            标题: (o.title || '').slice(0, 26),
            价格: o.price_text,
            销量整数: o.sales_value ?? '-',
            回头率: o.return_rate_percent ? `${o.return_rate_percent}%` : '-',
            供应商: (o.seller_name || '').slice(0, 14),
            更新时间: o.updated_at,
          }));
          console.table(tableRows);
        }
        break;
      }

      case 'inspect': {
        const offerId = argv[1];
        if (!offerId) {
          console.error('错误: 请提供要审计的商品 ID。例: 1688-ops inspect 1024786474053');
          process.exit(1);
        }

        const offer = getOffer(db, offerId);
        if (!offer) {
          console.error(`离线真理库中未找到商品: ${offerId}`);
          process.exit(1);
        }

        console.log('\n=== 商品真理与审计对账报告 ===');
        console.log(`商品 ID: ${offer.offer_id}`);
        console.log(`标题: ${offer.title}`);
        console.log(`价格范围: ${offer.price_text} (最小: ${offer.price_min}, 最大: ${offer.price_max})`);
        console.log(`销量派生: 原始="${offer.sales_text}" -> 派生数值=${offer.sales_value}`);
        console.log(`回头率派生: 原始="${offer.return_rate_text}" -> 派生百分比=${offer.return_rate_percent}%`);
        console.log(`起订数量: ${offer.moq_value ?? '1'} 件`);
        console.log(`店铺与供应商: ${offer.seller_name} (${offer.seller_url})`);
        console.log(`物理所在地: ${offer.location || '未标注'}`);
        console.log(`发货时效: ${offer.delivery_days_text || '常规'}`);
        console.log(`服务标签: ${offer.badges_json || '[]'}`);
        console.log(`最后同步时间: ${offer.updated_at}`);
        console.log(`商品直达地址: ${offer.item_url}`);
        console.log('==============================\n');
        break;
      }

      case 'reason': {
        const offerId = argv[1];
        if (!offerId || offerId.startsWith('-')) {
          console.error('错误: 请提供要推理评估的商品 ID。例: 1688-ops reason 1024786474053 --target-price 39.99');
          process.exit(1);
        }

        const targetPriceIdx = argv.indexOf('--target-price');
        const targetPrice = targetPriceIdx !== -1 && argv[targetPriceIdx + 1] ? parseFloat(argv[targetPriceIdx + 1]) : undefined;

        const currencyIdx = argv.indexOf('--currency');
        const currency = currencyIdx !== -1 && argv[currencyIdx + 1] ? argv[currencyIdx + 1].toUpperCase() : 'USD';

        const isLive = argv.includes('--live');
        const isJson = argv.includes('--json');

        let offer = !isLive ? getOffer(db, offerId) : null;
        if (!offer) {
          if (!isJson) console.log(`离线库未命中或指定在线抓取，正在在线获取商品详情: ${offerId}...`);
          try {
            offer = await client.getItem(offerId);
          } catch (fetchErr) {
            console.error(`无法获取商品信息: ${fetchErr.message}`);
            process.exit(1);
          }
        }

        if (!offer) {
          console.error(`未能定位商品: ${offerId}`);
          process.exit(1);
        }

        const reasoning = reasonOffer(offer, {
          target_retail_price: targetPrice,
          target_currency: currency,
        });

        if (isJson) {
          console.log(JSON.stringify(reasoning, null, 2));
          return;
        }

        console.log('\n================ 1688 货源智能推理与决策报告 ================');
        console.log(`商品标识: ${reasoning.offer_id} | ${reasoning.title}`);
        console.log(`供应商: ${reasoning.seller_name || '未注明'}`);
        console.log(`综合评分: ${reasoning.supplier_score} / 100 分 (决议: ${reasoning.verdict})`);
        console.log('评分明细:');
        console.log(`  - 复购/回头率得分: ${reasoning.supplier_breakdown.return_rate_score}/30`);
        console.log(`  - 资质/验厂得分:   ${reasoning.supplier_breakdown.factory_badge_score}/25`);
        console.log(`  - 动销/销量得分:   ${reasoning.supplier_breakdown.sales_score}/20`);
        console.log(`  - 发货/履约得分:   ${reasoning.supplier_breakdown.fulfillment_score}/15`);
        console.log(`  - 价格/起批稳定性: ${reasoning.supplier_breakdown.price_moq_stability}/10`);

        console.log('\n阶梯价格结构:');
        if (reasoning.tier_analysis.has_tiered_pricing) {
          console.log(`  基准单价: ¥${reasoning.tier_analysis.base_unit_price} | 最低阶梯价: ¥${reasoning.tier_analysis.lowest_unit_price} (最高折让: ${reasoning.tier_analysis.max_discount_percent}%)`);
          for (const t of reasoning.tier_analysis.tiers) {
            console.log(`  - 起订量 >= ${t.min_quantity} 件: ¥${t.unit_price} (折让: ${t.discount_percent}%)`);
          }
        } else {
          console.log(`  单一定价: ¥${reasoning.tier_analysis.base_unit_price} (无量产阶梯批发折扣)`);
        }

        console.log('\n跨境毛利与测算模型:');
        const m = reasoning.margin_economics;
        console.log(`  - 采购出厂价:   ¥${m.base_sourcing_cost_cny}`);
        console.log(`  - 到仓落地成本: ¥${m.landed_cost_cny} (~$${m.landed_cost_usd} @ 汇率 ${m.exchange_rate})`);
        console.log(`  - 目标零售定价: $${m.retail_price_usd} (约 ¥${m.retail_price_cny})`);
        console.log(`  - 预估单件毛利: $${m.gross_profit_usd} (毛利率: ${m.gross_margin_percent}%)`);
        console.log(`  - 保本广告ROAS: ${m.break_even_roas ?? 'N/A'}`);

        console.log('\n风险排查与预警:');
        if (reasoning.risk_summary.triggers.length === 0) {
          console.log('  未触发已知严重风险项。');
        } else {
          for (const r of reasoning.risk_summary.triggers) {
            console.log(`  [${r.severity}] ${r.message}`);
            console.log(`    应对建议: ${r.mitigation}`);
          }
        }

        console.log('\n操作员行动决策建议:');
        for (const rec of reasoning.recommendations) {
          console.log(`  * ${rec}`);
        }
        console.log('=============================================================\n');
        break;
      }

      case 'diagnose': {
        const testParser = argv.includes('--test-parser');
        const reconcile = argv.includes('--reconcile');

        if (reconcile) {
          console.log('正在执行适配器对调与同步 (能调)...');
          const recRes = reconcileAdapters();
          console.log(`已成功同步 ${recRes.copiedCount} 个适配器文件到 OpenCLI 运行区。`);
          console.log(`回执: ${recRes.daemonReceipt}`);
          return;
        }

        if (testParser) {
          console.log('正在执行生产纯函数对账验算 (能试)...');
          const parseReport = testLiveParser();
          console.log(JSON.stringify(parseReport, null, 2));
          return;
        }

        // 默认: 能读
        console.log('正在读取当前系统环境与对账状态 (能读)...');
        const status = readSystemStatus(db);
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      case 'install-adapters': {
        console.log('正在同步 1688 适配器到 ~/.opencli/clis/1688...');
        const res = reconcileAdapters();
        console.log(`已同步 ${res.copiedCount} 个适配器至: ${res.destination}`);
        console.log(`状态: ${res.daemonReceipt}`);
        break;
      }

      default: {
        console.error(`未知命令: ${command}`);
        printHelp();
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`\n执行失败: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
