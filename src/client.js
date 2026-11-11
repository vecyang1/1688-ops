/**
 * 1688 客户端包装层 (Programmatic Client)
 * 编排 OpenCLI 底层 Chrome Bridge 调用，并自动执行单向数据流与 SQLite 落地
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  upsertOffers,
  upsertOffer,
  upsertCartItems,
  upsertOrders,
  recordSearch,
  logAudit,
} from './db.js';

const execFileAsync = promisify(execFile);

export class HubClient1688 {
  /**
   * @param {object} options
   * @param {object} [options.db]
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    this.db = options.db || null;
    this.timeoutMs = options.timeoutMs || 75000;
  }

  /**
   * 调用底层的 opencli 1688 子命令
   * @param {string} subcommand
   * @param {Array<string>} args
   * @returns {Promise<any>}
   */
  async runRaw(subcommand, args = []) {
    const fullArgs = ['1688', subcommand, ...args, '-f', 'json'];
    try {
      const { stdout, stderr } = await execFileAsync('opencli', fullArgs, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });

      const raw = (stdout || '').trim();
      if (!raw) {
        throw new Error(`OpenCLI returned empty response for 1688 ${subcommand}`);
      }

      // 提取 JSON 部分（过滤可能的警告行）
      const jsonStart = raw.indexOf('{');
      if (jsonStart === -1) {
        throw new Error(`Invalid non-JSON output from opencli: ${raw.slice(0, 200)}`);
      }

      const jsonStr = raw.slice(jsonStart);
      const parsed = JSON.parse(jsonStr);

      if (!parsed.ok) {
        const errMsg = parsed.error?.message || 'OpenCLI command failed';
        const errCode = parsed.error?.code || 'UNKNOWN';
        const err = new Error(`[${errCode}] ${errMsg}`);
        err.code = errCode;
        err.data = parsed;
        throw err;
      }

      return parsed.data;
    } catch (err) {
      if (err.killed && err.signal === 'SIGTERM') {
        const timeoutErr = new Error(`1688 ${subcommand} timed out after ${this.timeoutMs}ms`);
        timeoutErr.code = 'TIMEOUT';
        throw timeoutErr;
      }
      if (err.stdout) {
        const raw = err.stdout.trim();
        const jsonStart = raw.indexOf('{');
        if (jsonStart !== -1) {
          try {
            const parsed = JSON.parse(raw.slice(jsonStart));
            if (!parsed.ok) {
              const errMsg = parsed.error?.message || err.message;
              const errCode = parsed.error?.code || 'EXEC_FAIL';
              const structuredErr = new Error(`[${errCode}] ${errMsg}`);
              structuredErr.code = errCode;
              structuredErr.data = parsed;
              throw structuredErr;
            }
          } catch (pe) {
            if (pe.code) throw pe;
          }
        }
      }
      throw err;
    }
  }

  /**
   * 诊断当前 1688 登录态与操作者身份
   */
  async whoami() {
    return this.runRaw('whoami');
  }

  /**
   * 关键字搜索货源
   * @param {string} keyword
   * @param {object} [options]
   */
  async search(keyword, options = {}) {
    const limit = options.limit || 20;
    const pages = options.pages || (limit > 20 ? Math.ceil(limit / 20) : 1);
    const args = [keyword, '--limit', String(limit), '--pages', String(pages)];
    const items = await this.runRaw('search', args);

    if (this.db && Array.isArray(items)) {
      upsertOffers(this.db, items);
      const ids = items.map((it) => it.offer_id).filter(Boolean);
      recordSearch(this.db, 'text', keyword, ids);
      logAudit(this.db, 'search', keyword, `关键词检索成功，获取 ${items.length} 个条目 (页数: ${pages})`, { count: items.length, pages });
    }

    return items;
  }

  /**
   * 抓取单个商品 Offer 详情
   * @param {string} offerId
   */
  async getItem(offerId) {
    const data = await this.runRaw('item', [String(offerId)]);
    const item = Array.isArray(data) ? data[0] : data;

    if (this.db && item) {
      upsertOffer(this.db, item);
      logAudit(this.db, 'item_fetch', String(offerId), `商品详情抓取成功: ${item.title || offerId}`);
    }

    return item;
  }

  /**
   * 以图搜款 (Visual Search)
   * @param {string} imagePathOrUrl
   * @param {object} [options]
   */
  async imageSearch(imagePathOrUrl, options = {}) {
    const limit = options.limit || 20;
    const args = [imagePathOrUrl, '--limit', String(limit)];
    const items = await this.runRaw('image-search', args);

    if (this.db && Array.isArray(items)) {
      upsertOffers(this.db, items);
      const ids = items.map((it) => it.offer_id).filter(Boolean);
      recordSearch(this.db, 'image', imagePathOrUrl, ids);
      logAudit(this.db, 'image_search', imagePathOrUrl, `以图搜款成功，获取 ${items.length} 个条目`, { count: items.length });
    }

    return items;
  }

  /**
   * 抓取店铺详情
   * @param {string} storeTarget
   */
  async getStore(storeTarget) {
    const data = await this.runRaw('store', [storeTarget]);
    const store = Array.isArray(data) ? data[0] : data;
    if (this.db && store) {
      logAudit(this.db, 'store_fetch', storeTarget, `店铺档案抓取成功: ${store.store_name || storeTarget}`);
    }
    return store;
  }

  /**
   * 抓取采购车并同步到离线数据库
   * @param {object} [options]
   */
  async getCart(options = {}) {
    const items = await this.runRaw('cart');
    if (this.db && options.sync !== false && Array.isArray(items)) {
      upsertCartItems(this.db, items);
      logAudit(this.db, 'cart_sync', 'buyer_cart', `采购车同步成功，共 ${items.length} 个条目`, { count: items.length });
    }
    return items;
  }

  /**
   * 抓取采购订单并同步到离线数据库
   * @param {object} [options]
   */
  async getOrders(options = {}) {
    const status = options.status || 'all';
    const pages = options.pages || 1;
    const args = ['--status', status, '--pages', String(pages)];
    const orders = await this.runRaw('orders', args);
    if (this.db && options.sync !== false && Array.isArray(orders)) {
      upsertOrders(this.db, orders);
      logAudit(this.db, 'order_sync', 'buyer_orders', `采购订单同步成功，共 ${orders.length} 条记录`, { count: orders.length });
    }
    return orders;
  }
}
