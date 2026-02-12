const axios = require('axios');
const https = require('https');
const { ALL_SUPPORTED_REGIONS, ADMIN_OPENID, DAILY_REQUEST_LIMIT } = require('./consts');

// KV 连接错误时静默降级，避免崩溃
let kv = null;
try { ({ kv } = require('@vercel/kv')); } catch (e) { kv = null; }

const SOURCE_NOTE = '*数据来源 Apple 官方*';

const HTTP = axios.create({
  timeout: 8000, 
  headers: { 
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15' 
}
});

// ----------------------
// 缓存与限流
// ----------------------

async function withCache(key, ttl, fetcher) {
  // 降级：如果 KV 不可用，直接穿透查询，不报错
  if (!process.env.KV_REST_API_TOKEN || !kv) return await fetcher();
  try {
    const cached = await kv.get(key);
    if (cached) return cached;
  } catch (e) { console.warn('KV Get Error (Degraded):', e.message); }

  const data = await fetcher();
  if (data) {
    try { await kv.set(key, data, { ex: ttl }); } catch (e) {}
  }
  return data;
}

async function checkUrlAccessibility(url) {
  try {
    await HTTP.head(url, { timeout: 1500 });
    return true;
  } catch (e) { return false; }
}

async function checkUserRateLimit(openid) {
  // 降级：如果 KV 不可用，默认允许通过（无限流），保证可用性
  if (!process.env.KV_REST_API_TOKEN || !kv || openid === ADMIN_OPENID) return true;
  const key = `limit:req:${openid}`;
  try {
    const currentCount = await kv.incr(key);
    if (currentCount === 1) await kv.expire(key, 86400);
    return currentCount <= DAILY_REQUEST_LIMIT;
  } catch (e) { 
    console.warn('RateLimit Error (Allowing):', e.message);
    return true; 
  }
}

async function checkSubscribeFirstTime(openId) {
  // 降级：如果 KV 不可用，默认视为新用户（会有通知），但不阻断流程
  if (!process.env.KV_REST_API_TOKEN || !kv || !openId) return { isFirst: true };
  const key = `sub:seen:${openId}`;
  try {
    const seen = await kv.get(key);
    if (seen) return { isFirst: false };
    await kv.set(key, '1');
    return { isFirst: true };
  } catch (e) {
    return { isFirst: true };
  }
}

// ----------------------
// 业务工具
// ----------------------

// 【优化】Bark 降权：出错不抛出异常，只记录日志
async function sendBark(title, body) {
  if (!process.env.BARK_KEY) return;
  try {
    const url = `https://api.day.app/${process.env.BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=WeChatMonitor`;
    await axios.get(url, { timeout: 2000 });
  } catch (e) {
    // 默默失败，不要吵醒主程序
    console.warn('Bark push failed (Ignored):', e.message);
  }
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getCountryCode(identifier) {
  const trimmed = String(identifier || '').trim().toLowerCase();
  if (ALL_SUPPORTED_REGIONS[trimmed]) return ALL_SUPPORTED_REGIONS[trimmed];
  if (/^[a-z]{2}$/i.test(trimmed)) {
    for (const name in ALL_SUPPORTED_REGIONS) {
      if (ALL_SUPPORTED_REGIONS[name] === trimmed) return trimmed;
    }
  }
  return '';
}

function getCountryName(code) {
  for (const [name, c] of Object.entries(ALL_SUPPORTED_REGIONS)) {
    if (c === code) return name;
  }
  return code; 
}

function isSupportedRegion(identifier) { return !!getCountryCode(identifier); }

function toBeijingShortDate(s) {
  if (!s) return '未知';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '未知';
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = String(bj.getFullYear()).slice(-2);
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d2 = String(bj.getDate()).padStart(2, '0');
  return `${y}/${m}/${d2}`;
}

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

async function getJSON(url, { timeout = 8000, retries = 1 } = {}) {
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

function pickBestMatch(query, results) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return results[0];
  const exact = results.find(r => String(r.trackName || '').toLowerCase() === q);
  return exact || results.find(r => String(r.trackName || '').toLowerCase().includes(q)) || results[0];
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
    return data?.rates?.CNY || null;
  } catch (e) { return null; }
}

async function fetchGdmf() {
  const url = 'https://gdmf.apple.com/v2/pmv';
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  const agent = new https.Agent({ rejectUnauthorized: false });
  try {
    const response = await HTTP.get(url, { timeout: 15000, headers, httpsAgent: agent });
    if (!response.data || typeof response.data !== 'object') throw new Error('Invalid GDMF data');
    return response.data;
  } catch (error) { throw new Error('fetchGdmf Error'); }
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

function toBeijingYMD(s) { return toBeijingShortDate(s); }

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
              const version = node.ProductVersion || node.OSVersion || node.SystemVersion;
              const build = node.Build || node.BuildID || node.BuildVersion;
              const dateStr = node.PostingDate || node.ReleaseDate || node.Date;
              const devices = node.SupportedDevices;
              if (version && build && !foundBuilds.has(build)) {
                const actualPlatforms = determinePlatformsFromDevices(devices);
                if (actualPlatforms.has(targetOS)) {
                  releases.push({ os: targetOS, version, build, date: dateStr, raw: node });
                  foundBuilds.add(build);
                } else if (targetOS === 'iPadOS' && actualPlatforms.has('iOS')) {
                   if (parseFloat(version) >= 13.0) {
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

module.exports = {
  HTTP, SOURCE_NOTE, withCache, formatBytes, getCountryCode, getCountryName, isSupportedRegion,
  getFormattedTime, getJSON, pickBestMatch, formatPrice, fetchExchangeRate, fetchGdmf,
  normalizePlatform, toBeijingYMD, toBeijingShortDate, collectReleases, 
  checkUrlAccessibility, checkUserRateLimit, checkSubscribeFirstTime,
  sendBark
};
