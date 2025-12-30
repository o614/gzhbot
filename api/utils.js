// api/utils.js
const axios = require('axios');
const https = require('https');

// Optional: Vercel KV for VIP & rate limiting (safe to run without KV in dev)
let kv = null;
try {
  ({ kv } = require('@vercel/kv'));
} catch (e) {
  kv = null;
}

const { ALL_SUPPORTED_REGIONS } = require('./consts');

const SOURCE_NOTE = '*数据来源 Apple 官方*';

const HTTP = axios.create({
  timeout: 4000,
  headers: { 'user-agent': 'Mozilla/5.0 (Serverless-WeChatBot)' }
});

// 获取地区代码
function getCountryCode(identifier) {
  const trimmed = String(identifier || '').trim();
  const key = trimmed.toLowerCase();
  if (!trimmed) return null;

  // 1) 直接 country code
  if (/^[a-z]{2}$/.test(key)) return key;

  // 2) 中文地区名称
  const code = ALL_SUPPORTED_REGIONS[trimmed];
  return code || null;
}

function isSupportedRegion(identifier) {
  return !!getCountryCode(identifier);
}

function getFormattedTime() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function getJSON(url, options = {}) {
  const { timeout } = options;
  const res = await HTTP.get(url, { timeout: timeout || 4000 });
  return res.data;
}

function pickBestMatch(query, results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return results[0];

  // 完全匹配 trackName
  const exact = results.find(r => (r.trackName || '').toLowerCase() === q);
  if (exact) return exact;

  // 包含匹配
  const includes = results.find(r => (r.trackName || '').toLowerCase().includes(q));
  if (includes) return includes;

  // fallback
  return results[0];
}

function formatPrice(price, currency) {
  if (price === 0) return `免费`;
  if (price == null) return `未知`;
  return `${price} ${currency || ''}`.trim();
}

async function fetchExchangeRate(currency) {
  try {
    const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`;
    const data = await getJSON(url, { timeout: 4000 });
    const cny = data?.rates?.CNY;
    if (!cny) return null;
    return cny;
  } catch (e) {
    return null;
  }
}

async function fetchGdmf() {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const url = `https://gdmf.apple.com/v2/pmv`;
  const res = await HTTP.get(url, { httpsAgent: agent, timeout: 6000 });
  return res.data;
}

function normalizePlatform(p) {
  const s = String(p || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'ios') return 'iOS';
  if (s === 'ipados') return 'iPadOS';
  if (s === 'macos') return 'macOS';
  if (s === 'watchos') return 'watchOS';
  if (s === 'tvos') return 'tvOS';
  if (s === 'visionos') return 'visionOS';
  return null;
}

function toBeijingYMD(isoStr) {
  try {
    const date = new Date(isoStr);
    const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`;
  } catch (e) {
    return '';
  }
}

// 从 SupportedDevices 推断平台
function determinePlatformsFromDevices(supportedDevices) {
  const platforms = new Set();
  if (!Array.isArray(supportedDevices)) return platforms;

  let hasIOS = false;
  let hasIPadOS = false;
  let hasWatchOS = false;
  let hasTVOS = false;
  let hasMacOS = false;
  let hasVisionOS = false;

  for (const d of supportedDevices) {
    const s = String(d || '').toLowerCase();
    if (s.includes('iphone')) hasIOS = true;
    if (s.includes('ipad')) hasIPadOS = true;
    if (s.includes('watch')) hasWatchOS = true;
    if (s.includes('appletv')) hasTVOS = true;
    if (s.includes('mac')) hasMacOS = true;
    if (s.includes('realitydevice')) hasVisionOS = true;
  }

  if (hasIOS) platforms.add('iOS');
  if (hasIPadOS) platforms.add('iPadOS');
  if (hasWatchOS) platforms.add('watchOS');
  if (hasTVOS) platforms.add('tvOS');
  if (hasMacOS) platforms.add('macOS');
  if (hasVisionOS) platforms.add('visionOS');

  return platforms;
}

// 收集版本发布信息（支持总览和单个平台）
function collectReleases(data, platform) {
  const releases = [];
  const targetOS = normalizePlatform(platform);
  if (!targetOS || !data) return releases;

  const assetSetNames = ['PublicAssetSets', 'AssetSets'];
  const foundBuilds = new Set();

  for (const setName of assetSetNames) {
    const assetSet = data[setName];
    if (assetSet && typeof assetSet === 'object') {
      for (const sourceKey in assetSet) {
        const platformArray = assetSet[sourceKey];
        if (platformArray && Array.isArray(platformArray)) {
          platformArray.forEach(node => {
            if (node && typeof node === 'object') {
              const version = node.ProductVersion || node.OS;
              const build = node.Build;
              const date = node.PostingDate || node.PublicReleaseDate || node.ReleaseDate;
              const supportedDevices = node.SupportedDevices;

              const platforms = determinePlatformsFromDevices(supportedDevices);
              if (!platforms.has(targetOS)) return;
              if (!build || foundBuilds.has(build)) return;
              foundBuilds.add(build);

              releases.push({
                os: targetOS,
                version,
                build,
                date
              });
            }
          });
        }
      }
    }
  }

  // 新->旧
  releases.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return releases;
}

// ------------------------------
// VIP & Usage limit (per day)
// ------------------------------

// Format date in user's timezone (Asia/Singapore, same as UTC+8)
function getLocalDateStr() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Singapore',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year')?.value;
    const m = parts.find(p => p.type === 'month')?.value;
    const d = parts.find(p => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch (_) {}
  // Fallback (UTC)
  return new Date().toISOString().slice(0, 10);
}

async function isVip(openId) {
  if (!kv || !openId) return false;
  try {
    const v = await kv.get(`vip:${openId}`);
    return v === true || v === '1' || v === 1 || v === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * Check & consume usage for a given action.
 * - VIP: always allowed (no counting)
 * - Non-VIP: count per day in KV
 * If KV is unavailable, default to allow (to avoid blocking users).
 */
async function checkUsageLimit(openId, action, maxLimit) {
  if (!openId || !action || !maxLimit) return { allowed: true };

  // If no KV, don't block
  if (!kv) return { allowed: true };

  const vip = await isVip(openId);
  if (vip) return { allowed: true, isVip: true };

  const day = getLocalDateStr();
  const key = `usage:${action}:${day}:${openId}`;

  try {
    const used = await kv.incr(key);

    // Set expiry if this is the first time today
    if (used === 1) {
      // 24h expiry is simple & robust
      await kv.expire(key, 60 * 60 * 24);
    }

    if (used > maxLimit) return { allowed: false, used, limit: maxLimit, isVip: false };
    return { allowed: true, used, limit: maxLimit, isVip: false };
  } catch (e) {
    // KV error -> allow (best-effort)
    return { allowed: true };
  }
}

/**
 * Manage VIP status in KV.
 * @param {'add'|'del'} op
 * @param {string} openId
 */
async function manageVip(op, openId) {
  if (!kv) throw new Error('KV 未配置或不可用');
  if (!openId) throw new Error('缺少 openId');
  if (op === 'add') {
    await kv.set(`vip:${openId}`, '1');
    return true;
  }
  if (op === 'del') {
    await kv.del(`vip:${openId}`);
    return true;
  }
  throw new Error('未知操作');
}

module.exports = {
  HTTP,
  SOURCE_NOTE,
  getCountryCode,
  isSupportedRegion,
  getFormattedTime,
  getJSON,
  pickBestMatch,
  formatPrice,
  fetchExchangeRate,
  fetchGdmf,
  normalizePlatform,
  toBeijingYMD,
  collectReleases,
  determinePlatformsFromDevices,

  // VIP & limits
  checkUsageLimit,
  manageVip,
  isVip,
  getLocalDateStr
};
