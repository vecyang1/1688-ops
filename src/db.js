import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanText,
  parsePriceText,
  parseMoq,
  parseSales,
  parseReturnRate,
  extractOfferId,
} from './extractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/1688_ops.db');
const SCHEMA_PATH = path.resolve(__dirname, 'schema.sql');

/**
 * 初始化并连接 SQLite 数据库
 * @param {string} [customPath]
 * @returns {DatabaseSync}
 */
export function initDatabase(customPath) {
  const dbPath = customPath || process.env.HUB_1688_DB_PATH || DEFAULT_DB_PATH;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schemaSql);
  return db;
}

/**
 * 插入或更新单条商品 Offer
 * @param {DatabaseSync} db
 * @param {object} item
 * @returns {object}
 */
export function upsertOffer(db, item) {
  const offerId = item.offer_id || extractOfferId(item.item_url);
  if (!offerId) {
    throw new Error('Offer ID is required for upserting offer record');
  }

  const title = cleanText(item.title || '');
  const itemUrl = item.item_url || `https://detail.1688.com/offer/${offerId}.html`;
  const sellerUrl = item.seller_url || null;
  const sellerName = cleanText(item.seller_name || item.shop_name || '');
  const memberId = item.member_id || null;
  const shopId = item.shop_id || null;

  // 价格解析
  const priceParsed = parsePriceText(item.price_text || (item.price_min ? `¥${item.price_min}` : ''));
  const priceMin = item.price_min !== undefined ? item.price_min : priceParsed.price_min;
  const priceMax = item.price_max !== undefined ? item.price_max : priceParsed.price_max;
  const priceText = item.price_text || priceParsed.price_text;
  const currency = item.currency || priceParsed.currency;

  // 起订量
  const moqParsed = parseMoq(item.moq_text || (item.moq_value ? `${item.moq_value}件` : ''));
  const moqValue = item.moq_value !== undefined ? item.moq_value : moqParsed.moq_value;

  // 销量与派生整数
  const salesParsed = parseSales(item.sales_text || '');
  const salesValue = salesParsed.sales_value;

  // 回头率与派生百分比
  const returnParsed = parseReturnRate(item.return_rate_text || '');
  const returnRatePercent = returnParsed.return_rate_percent;

  const stmt = db.prepare(`
    INSERT INTO offers (
      offer_id, title, member_id, shop_id, seller_name, seller_url,
      item_url, image_url, main_images_json, price_text, price_min, price_max,
      currency, moq_text, moq_value, sales_text, sales_value,
      return_rate_text, return_rate_percent, location, delivery_days_text,
      customization_text, stock_quantity, badges_json, price_tiers_json,
      visible_attributes_json, source_strategy, raw_payload_json, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, datetime('now')
    )
    ON CONFLICT(offer_id) DO UPDATE SET
      title = excluded.title,
      member_id = coalesce(excluded.member_id, offers.member_id),
      shop_id = coalesce(excluded.shop_id, offers.shop_id),
      seller_name = coalesce(excluded.seller_name, offers.seller_name),
      seller_url = coalesce(excluded.seller_url, offers.seller_url),
      item_url = excluded.item_url,
      image_url = coalesce(excluded.image_url, offers.image_url),
      main_images_json = coalesce(excluded.main_images_json, offers.main_images_json),
      price_text = coalesce(excluded.price_text, offers.price_text),
      price_min = coalesce(excluded.price_min, offers.price_min),
      price_max = coalesce(excluded.price_max, offers.price_max),
      currency = coalesce(excluded.currency, offers.currency),
      moq_text = coalesce(excluded.moq_text, offers.moq_text),
      moq_value = coalesce(excluded.moq_value, offers.moq_value),
      sales_text = coalesce(excluded.sales_text, offers.sales_text),
      sales_value = coalesce(excluded.sales_value, offers.sales_value),
      return_rate_text = coalesce(excluded.return_rate_text, offers.return_rate_text),
      return_rate_percent = coalesce(excluded.return_rate_percent, offers.return_rate_percent),
      location = coalesce(excluded.location, offers.location),
      delivery_days_text = coalesce(excluded.delivery_days_text, offers.delivery_days_text),
      customization_text = coalesce(excluded.customization_text, offers.customization_text),
      stock_quantity = coalesce(excluded.stock_quantity, offers.stock_quantity),
      badges_json = coalesce(excluded.badges_json, offers.badges_json),
      price_tiers_json = coalesce(excluded.price_tiers_json, offers.price_tiers_json),
      visible_attributes_json = coalesce(excluded.visible_attributes_json, offers.visible_attributes_json),
      source_strategy = excluded.source_strategy,
      raw_payload_json = coalesce(excluded.raw_payload_json, offers.raw_payload_json),
      updated_at = datetime('now');
  `);

  stmt.run(
    offerId,
    title,
    memberId,
    shopId,
    sellerName,
    sellerUrl,
    itemUrl,
    item.image_url || (Array.isArray(item.main_images) ? item.main_images[0] : null),
    item.main_images ? JSON.stringify(item.main_images) : null,
    priceText,
    priceMin,
    priceMax,
    currency,
    item.moq_text || moqParsed.moq_text,
    moqValue,
    item.sales_text || salesParsed.sales_text,
    salesValue,
    item.return_rate_text || returnParsed.return_rate_text,
    returnRatePercent,
    item.location || item.origin_place || null,
    item.delivery_days_text || null,
    item.customization_text || null,
    item.stock_quantity !== undefined ? item.stock_quantity : null,
    item.badges || item.service_badges ? JSON.stringify(item.badges || item.service_badges) : null,
    item.price_tiers ? JSON.stringify(item.price_tiers) : null,
    item.visible_attributes ? JSON.stringify(item.visible_attributes) : null,
    item.strategy || 'cookie',
    JSON.stringify(item)
  );

  return { offer_id: offerId, title, price_min: priceMin, price_max: priceMax };
}

/**
 * 批量插入或更新 Offers
 * @param {DatabaseSync} db
 * @param {Array<object>} items
 * @returns {number}
 */
export function upsertOffers(db, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let count = 0;
  db.exec('BEGIN TRANSACTION;');
  try {
    for (const it of items) {
      if (it.offer_id || it.item_url) {
        upsertOffer(db, it);
        count++;
      }
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return count;
}

/**
 * 获取单条 Offer 详情
 * @param {DatabaseSync} db
 * @param {string} offerId
 * @returns {object|null}
 */
export function getOffer(db, offerId) {
  const stmt = db.prepare('SELECT * FROM offers WHERE offer_id = ?;');
  return stmt.get(offerId) || null;
}

/**
 * 查询离线 Offer 列表
 * @param {DatabaseSync} db
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function listOffers(db, options = {}) {
  const limit = Math.min(Math.max(options.limit || 20, 1), 100);
  const keyword = options.keyword ? `%${cleanText(options.keyword)}%` : null;

  let sql = 'SELECT * FROM offers';
  const params = [];

  if (keyword) {
    sql += ' WHERE (title LIKE ? OR seller_name LIKE ?)';
    params.push(keyword, keyword);
  }

  if (options.sortBy === 'sales') {
    sql += ' ORDER BY sales_value DESC NULLS LAST';
  } else if (options.sortBy === 'return_rate') {
    sql += ' ORDER BY return_rate_percent DESC NULLS LAST';
  } else if (options.sortBy === 'price_asc') {
    sql += ' ORDER BY price_min ASC NULLS LAST';
  } else {
    sql += ' ORDER BY updated_at DESC';
  }

  sql += ` LIMIT ${limit};`;
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * 插入或更新采购车条目
 * @param {DatabaseSync} db
 * @param {Array<object>} items
 * @returns {number}
 */
export function upsertCartItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let count = 0;
  db.exec('BEGIN TRANSACTION;');
  try {
    const stmt = db.prepare(`
      INSERT INTO cart_items (
        cart_item_id, offer_id, seller_name, seller_url, title,
        item_url, image_url, spec_name, price, quantity,
        subtotal, status, raw_payload_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, datetime('now')
      )
      ON CONFLICT(cart_item_id) DO UPDATE SET
        price = excluded.price,
        quantity = excluded.quantity,
        subtotal = excluded.subtotal,
        status = excluded.status,
        raw_payload_json = excluded.raw_payload_json,
        updated_at = datetime('now');
    `);

    const stubStmt = db.prepare(`
      INSERT INTO offers (offer_id, title, item_url, seller_name, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(offer_id) DO UPDATE SET
        title = CASE WHEN offers.title IS NULL OR offers.title = '' THEN excluded.title ELSE offers.title END,
        seller_name = coalesce(offers.seller_name, excluded.seller_name);
    `);

    for (const it of items) {
      const offerId = it.offer_id || extractOfferId(it.item_url || '') || null;
      if (offerId) {
        stubStmt.run(
          offerId,
          cleanText(it.title || ''),
          it.item_url || `https://detail.1688.com/offer/${offerId}.html`,
          cleanText(it.shop_name || '')
        );
      }

      const cartItemId = `${offerId || 'item'}_${cleanText(it.spec || 'default')}`;
      const price = Number(it.price) || 0;
      const quantity = Number(it.quantity) || 1;
      const subtotal = Math.round(price * quantity * 100) / 100;
      const status = it.is_invalid ? '失效' : 'normal';

      stmt.run(
        cartItemId,
        offerId,
        cleanText(it.shop_name || ''),
        null,
        cleanText(it.title || ''),
        it.item_url || null,
        null,
        cleanText(it.spec || ''),
        price,
        quantity,
        subtotal,
        status,
        JSON.stringify(it)
      );
      count++;
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return count;
}

/**
 * 插入或更新采购订单
 * @param {DatabaseSync} db
 * @param {Array<object>} orders
 * @returns {number}
 */
export function upsertOrders(db, orders) {
  if (!Array.isArray(orders) || orders.length === 0) return 0;
  let count = 0;
  db.exec('BEGIN TRANSACTION;');
  try {
    const stmt = db.prepare(`
      INSERT INTO orders (
        order_id, seller_name, seller_url, status_text,
        total_amount, currency, order_time, items_json,
        raw_payload_json, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, datetime('now')
      )
      ON CONFLICT(order_id) DO UPDATE SET
        status_text = excluded.status_text,
        total_amount = excluded.total_amount,
        raw_payload_json = excluded.raw_payload_json,
        updated_at = datetime('now');
    `);

    for (const o of orders) {
      if (!o.order_id) continue;
      stmt.run(
        String(o.order_id),
        cleanText(o.shop_name || ''),
        null,
        cleanText(o.status || 'unknown'),
        Number(o.total_amount) || null,
        o.currency || 'CNY',
        o.order_date || null,
        o.title ? JSON.stringify([{ title: o.title, url: o.item_url }]) : null,
        JSON.stringify(o)
      );
      count++;
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return count;
}

/**
 * 查询离线购物车条目
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
export function listCartItems(db) {
  const stmt = db.prepare('SELECT * FROM cart_items ORDER BY updated_at DESC;');
  return stmt.all();
}

/**
 * 查询离线订单列表
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
export function listOrders(db) {
  const stmt = db.prepare('SELECT * FROM orders ORDER BY order_time DESC NULLS LAST, updated_at DESC;');
  return stmt.all();
}

/**
 * 记录检索历史
 * @param {DatabaseSync} db
 * @param {string} queryType
 * @param {string} queryContent
 * @param {Array<string>} resultOfferIds
 */
export function recordSearch(db, queryType, queryContent, resultOfferIds) {
  const stmt = db.prepare(`
    INSERT INTO search_history (query_type, query_content, result_count, result_offer_ids_json)
    VALUES (?, ?, ?, ?);
  `);
  stmt.run(
    queryType,
    queryContent,
    resultOfferIds ? resultOfferIds.length : 0,
    resultOfferIds ? JSON.stringify(resultOfferIds) : '[]'
  );
}

/**
 * 记录操作与审计痕迹
 * @param {DatabaseSync} db
 * @param {string} action
 * @param {string} targetId
 * @param {string} summary
 * @param {object} [metadata]
 */
export function logAudit(db, action, targetId, summary, metadata) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (action, target_id, summary, metadata_json)
    VALUES (?, ?, ?, ?);
  `);
  stmt.run(
    action,
    targetId || null,
    summary,
    metadata ? JSON.stringify(metadata) : null
  );
}

/**
 * 获取数据库统计指标
 * @param {DatabaseSync} db
 * @returns {object}
 */
export function getStats(db) {
  const offerCount = db.prepare('SELECT COUNT(*) as count FROM offers;').get().count;
  const cartCount = db.prepare('SELECT COUNT(*) as count FROM cart_items;').get().count;
  const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders;').get().count;
  const searchCount = db.prepare('SELECT COUNT(*) as count FROM search_history;').get().count;
  return {
    offers: Number(offerCount),
    cart_items: Number(cartCount),
    orders: Number(orderCount),
    searches: Number(searchCount),
  };
}
