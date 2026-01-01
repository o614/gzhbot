// api/utils.js
const axios = require('axios');
const https = require('https');
const { ALL_SUPPORTED_REGIONS, ADMIN_OPENID, DAILY_REQUEST_LIMIT } = require('./consts');

// 数据库连接 (Fail-open)
let kv = null;
try {
  ({ kv } = require('@vercel/kv'));
} catch (e) {
  kv = null;
}

const SOURCE_NOTE = '*数据来源 Apple 官方*';

const HTTP = axios.create({
  timeout: 6000,
  headers: { 'user-agent': 'Mozilla/5.0 (Serverless-WeChatBot)' }
});

// 获取地区代码 (保留原逻辑，支持输入 jp 返回 jp)
function getCountryCode(identifier) {
  const trimmed = String(identifier || '').trim();
  const key = trimmed.toLowerCase();
  if (ALL_SUPPORTED_REGIONS[trimmed]) return ALL_SUPPORTED_REGIONS[trimmed];
  if (/^[a-z]{2}$/i.test(key)) {
    for (const name in ALL_SUPPORTED_REGIONS) {
      if (ALL_SUPPORTED_REGIONS[name] === key) return key;
    }
  }
  return '';
}

function isSupportedRegion(identifier) {
  return !!getCountryCode(identifier);
}

// 时间格式化 YY/MM/DD
function toBeijingShortDate(s) {
  const d = s ? new Date(s) : new Date();
  if (isNaN(d.getTime())) return '';
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = String(bj.getFullYear()).slice(-2);
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d2 = String(bj.getDate()).padStart(2, '0');
  return `${y}/${m}/${d2}`;
}

// 兼容旧的完整时间格式
function getFormattedTime() {
  const now = new Date();
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const yyyy = String(bj.getFullYear());
  const mm = String(bj.getMonth() + 1).padStart(2, '0');
  const dd = String(bj.getDate()).padStart(2, '0');
  const hh = String(bj.getHours()).padStart(2, '0');
  const mi = String(bj.getMinutes()).padStart(2, '0');
  return `${yyyy.slice(-2)}/${mm}/${dd} ${hh}:${mi}`;
}

// 通用 HTTP GET
async function getJSON(url, { timeout = 6000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await HTTP.get(url, { timeout });
      return data;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, 250 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// 【加回】检测链接有效性 (HEAD)
async function checkUrlAccessibility(url) {
  try {
    await HTTP.head(url, { timeout: 1500 });
    return true;
  } catch (e) {
    return false;
  }
}

// 价格处理
function pickBestMatch(query, results) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return results[0];
  const exact = results.find(r => String(r.trackName || '').toLowerCase() === q);
  if (exact) return exact;
  const contains = results.find(r => String(r.trackName || '').toLowerCase().includes(q));
  if (contains) return contains;
  return results[0];
}

function formatPrice(r) {
  if (r.formattedPrice) return r.formattedPrice.replace(/^Free$/i, '免费');
  if (typeof r.price === 'number') {
    return r.price === 0 ? '免费' : `${r.currency || ''} ${r.price.toFixed(2)}`.trim();
  }
  return '未知';
}

async function fetchExchangeRate(targetCurrencyCode) {
  if (!targetCurrencyCode || targetCurrencyCode.toUpperCase() === 'CNY') return null;
  try {
    const url = `https://api.frankfurter.app/latest?from=${targetCurrencyCode.toUpperCase()}&to=CNY`;
    const { data } = await axios.get(url, { timeout: 3000 });
    if (data && data.rates && data.rates.CNY) {
      return data.rates.CNY;
    }
  } catch (e) {
    console.error(`Exchange Rate Error (${targetCurrencyCode}):`, e.message);
  }
  return null;
}

// 系统更新相关
async function fetchGdmf() {
  const url = 'https://gdmf.apple.com/v2/pmv';
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  const agent = new https.Agent({ rejectUnauthorized: false });
  try {
    const response = await HTTP.get(url, { timeout: 15000, headers, httpsAgent: agent });
    if (!response.data || typeof response.data !== 'object') throw new Error('Invalid GDMF data');
    return response.data;
  } catch (error) {
    throw new Error('fetchGdmf Error');
  }
}

function normalizePlatform(p) {
  const k = String(p || '').toLowerCase();
  if (['ios', 'iphoneos', 'iphone'].includes(k)) return 'iOS';
  if (['ipados', 'ipad'].includes(k)) return 'iPadOS';
  if (['macos', 'mac', 'osx'].includes(k)) return 'macOS';
  if (['watchos', 'watch'].includes(k)) return 'watchOS';
  if (['tvos', 'apple tv', 'tv'].includes(k)) return 'tvOS';
  if (['visionos', 'vision'].includes(k)) return 'visionOS';
  return null;
}

function toBeijingYMD(s) {
  return toBeijingShortDate(s); // 复用短日期格式
}

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
              const version = node.ProductVersion || node.OSVersion || node.SystemVersion || null;
              const build = node.Build || node.BuildID || node.BuildVersion || null;
              const dateStr = node.PostingDate || node.ReleaseDate || node.Date || node.PublishedDate || node.PublicationDate || null;
              const devices = node.SupportedDevices;
              if (version && build && !foundBuilds.has(build)) {
                const actualPlatforms = determinePlatformsFromDevices(devices);
                if (actualPlatforms.has(targetOS)) {
                  releases.push({ os: targetOS, version, build, date: dateStr, raw: node });
                  foundBuilds.add(build);
                } else if (targetOS === 'iPadOS' && actualPlatforms.has('iOS')) {
                   const versionNum = parseFloat(version);
                   if (!isNaN(versionNum) && versionNum >= 13.0) {
                      releases.push({ os: targetOS, version, build, date: dateStr, raw: node });
                      foundBuilds.add(build);
                   }
                }
              }
            }
          });
        }
      }
    }
  }
  return releases;
}

function determinePlatformsFromDevices(devices) {
  const platforms = new Set();
  if (!Array.isArray(devices)) return platforms;
  for (const device of devices) {
    const d = String(device || '').toLowerCase();
    if (d.startsWith('iphone') || d.startsWith('ipod')) platforms.add('iOS');
    else if (d.startsWith('ipad')) platforms.add('iPadOS');
    else if (d.startsWith('watch')) platforms.add('watchOS');
    else if (d.startsWith('appletv')) platforms.add('tvOS');
    else if (d.includes('mac')) platforms.add('macOS');
    else if (d.startsWith('realitydevice')) platforms.add('visionOS');
  }
  return platforms;
}

// 🛡️ 限额与VIP检查
function getBuckets() {
  const now = new Date();
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = String(bj.getFullYear()), m = String(bj.getMonth() + 1).padStart(2, '0'), d = String(bj.getDate()).padStart(2, '0');
  const hh = String(bj.getHours()).padStart(2, '0'), mi = String(bj.getMinutes()).padStart(2, '0');
  return { day: `${y}${m}${d}`, minute: `${y}${m}${d}${hh}${mi}` };
}

async function checkAbuseGate(openId) {
  const perMinute = Number(process.env.RATE_LIMIT_PER_MINUTE || 10);
  const perDay = Number(DAILY_REQUEST_LIMIT || 30);
  if (!openId) return { allowed: true };
  if (!kv) return { allowed: true };

  // 管理员跳过
  if (openId === ADMIN_OPENID) return { allowed: true };

  try {
    const isVip = await kv.get(`vip:${openId}`);
    if (isVip) return { allowed: true };

    const { day, minute } = getBuckets();

    if (perMinute > 0) {
      const key = `gate:rl:${minute}:${openId}`;
      const used = await kv.incr(key);
      if (used === 1) await kv.expire(key, 80);
      if (used > perMinute) return { allowed: false, message: '操作太频繁，请稍后再试。' };
    }

    if (perDay > 0) {
      const key = `gate:daily:${day}:${openId}`;
      const used = await kv.incr(key);
      if (used === 1) await kv.expire(key, 60 * 60 * 26);
      if (used > perDay) return { allowed: false, message: '今日查询次数已达上限，请明天再试。' };
    }
    return { allowed: true };
  } catch (e) {
    return { allowed: true };
  }
}

async function checkSubscribeFirstTime(openId) {
  if (!openId) return { isFirst: true, supported: false };
  if (!kv) return { isFirst: true, supported: false };
  const key = `sub:seen:${openId}`;
  try {
    const seen = await kv.get(key);
    if (seen) return { isFirst: false, supported: true };
    await kv.set(key, '1');
    return { isFirst: true, supported: true };
  } catch (e) {
    return { isFirst: true, supported: false };
  }
}

module.exports = {
  HTTP, SOURCE_NOTE, getCountryCode, isSupportedRegion, getFormattedTime, getJSON,
  pickBestMatch, formatPrice, fetchExchangeRate, fetchGdmf, normalizePlatform, toBeijingYMD,
  collectReleases, determinePlatformsFromDevices, checkAbuseGate, checkSubscribeFirstTime,
  checkUrlAccessibility, toBeijingShortDate
};
