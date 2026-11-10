/**
 * 1688 数据提取与纯函数解析器 (Pure Parsers)
 * 遵循单一职责与纯函数原则，零外部依赖，支持全分支确定性测试
 */

/**
 * 清理文本空白字符
 * @param {string} text
 * @returns {string}
 */
export function cleanText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 解析价格文本为数值范围与货币符号
 * 严格匹配带货币符号或有效数字的片段，防止年份(如 2026)、促销天数(如 90天)或百分比串入
 * @param {string} text
 * @returns {{ price_text: string, price_min: number|null, price_max: number|null, currency: string }}
 */
export function parsePriceText(text) {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return { price_text: '', price_min: null, price_max: null, currency: 'CNY' };
  }

  // 检测货币符号
  let currency = 'CNY';
  if (cleaned.includes('$')) currency = 'USD';
  else if (cleaned.includes('€')) currency = 'EUR';

  // 1. 尝试匹配区间格式: "¥16.00-183.00" 或 "16.00~183.00"
  const rangeMatch = cleaned.match(/(?:[¥￥$€]\s*)?(\d+(?:\.\d+)?)\s*(?:-|~|至)\s*(?:[¥￥$€]\s*)?(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    const normalizedText = (currency === 'CNY' ? '¥' : currency + ' ') + `${min}-${max}`;
    return {
      price_text: normalizedText,
      price_min: isNaN(min) ? null : min,
      price_max: isNaN(max) ? null : max,
      currency,
    };
  }

  // 2. 尝试匹配带货币符号的单值: "¥ 27.5" 或 "￥12"
  const symbolMatch = cleaned.match(/[¥￥$€]\s*(\d+(?:\.\d+)?)/);
  if (symbolMatch) {
    const val = parseFloat(symbolMatch[1]);
    const normalizedText = (currency === 'CNY' ? '¥' : currency + ' ') + val;
    return {
      price_text: normalizedText,
      price_min: isNaN(val) ? null : val,
      price_max: isNaN(val) ? null : val,
      currency,
    };
  }

  // 3. 兜底纯数字匹配（必须排除纯年份或无意义片段）
  const numMatch = cleaned.match(/\b(\d+(?:\.\d+)?)\b/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    // 过滤常见非价格数字（如 2026 年）
    if (val >= 2020 && val <= 2030 && !cleaned.includes('.')) {
      return { price_text: '', price_min: null, price_max: null, currency };
    }
    return {
      price_text: `¥${val}`,
      price_min: isNaN(val) ? null : val,
      price_max: isNaN(val) ? null : val,
      currency,
    };
  }

  return { price_text: '', price_min: null, price_max: null, currency };
}

/**
 * 解析起订量文本 (MOQ)
 * @param {string} text
 * @returns {{ moq_text: string|null, moq_value: number|null }}
 */
export function parseMoq(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return { moq_text: null, moq_value: null };

  const match = cleaned.match(/(\d+)\s*(?:件|套|个|批|起批|起订)/);
  if (match) {
    const val = parseInt(match[1], 10);
    return { moq_text: cleaned, moq_value: isNaN(val) ? null : val };
  }

  return { moq_text: cleaned, moq_value: null };
}

/**
 * 解析销量文本并转换为派生整数
 * 例: "全网1.4万+件" -> 14000, "已售500件" -> 500
 * @param {string} text
 * @returns {{ sales_text: string|null, sales_value: number|null }}
 */
export function parseSales(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return { sales_text: null, sales_value: null };

  const match = cleaned.match(/(?:全网|已售|月销|销量)?\s*(\d+(?:\.\d+)?)\s*(万|\+)?\+?\s*(?:件|套|个|单|笔)?/);
  if (match) {
    let num = parseFloat(match[1]);
    if (isNaN(num)) return { sales_text: cleaned, sales_value: null };
    if (match[2] === '万') {
      num = Math.round(num * 10000);
    }
    return { sales_text: cleaned, sales_value: num };
  }

  return { sales_text: cleaned, sales_value: null };
}

/**
 * 解析回头率文本并转换为派生浮点百分比
 * 例: "回头率 38%" -> 38.0
 * @param {string} text
 * @returns {{ return_rate_text: string|null, return_rate_percent: number|null }}
 */
export function parseReturnRate(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return { return_rate_text: null, return_rate_percent: null };

  const match = cleaned.match(/(?:回头率|复购率)\s*(\d+(?:\.\d+)?)\s*%/);
  if (match) {
    const rate = parseFloat(match[1]);
    return {
      return_rate_text: `回头率 ${rate}%`,
      return_rate_percent: isNaN(rate) ? null : rate,
    };
  }

  return { return_rate_text: null, return_rate_percent: null };
}

/**
 * 从 URL 中提取 Offer ID (1688 商品唯一不可变 ID)
 * @param {string} url
 * @returns {string|null}
 */
export function extractOfferId(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/offer\/(\d+)\.html/) || url.match(/[?&]offerId=(\d+)/);
  return match ? match[1] : null;
}

/**
 * 从店铺 URL 中提取 Shop ID / Member ID
 * @param {string} url
 * @returns {{ member_id: string|null, shop_id: string|null }}
 */
export function extractShopIdentifiers(url) {
  if (!url || typeof url !== 'string') return { member_id: null, shop_id: null };

  const shopMatch = url.match(/([a-zA-Z0-9_\-]+)\.1688\.com/);
  const shopId = shopMatch ? shopMatch[1] : null;

  const memberMatch = url.match(/memberId=([a-zA-Z0-9_\-]+)/);
  const memberId = memberMatch ? memberMatch[1] : null;

  return { member_id: memberId, shop_id: shopId };
}
