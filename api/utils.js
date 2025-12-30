// api/utils.js
const axios = require('axios');
const https = require('https');
const { kv } = require('@vercel/kv'); // 引入数据库
const { ALL_SUPPORTED_REGIONS } = require('./consts');

const SOURCE_NOTE = '*数据来源 Apple 官方*';
const SEPARATOR = '------------------------------';
const TRUNCATE_LIMIT = 24;

const HTTP = axios.create({
  timeout: 4000, 
  headers: { 'user-agent': 'Mozilla/5.0 (Serverless-WeChatBot)' }
});

// 👇👇👇 核心：带调试日志的检查函数 👇👇👇
async function checkUsageLimit(openId, action, maxLimit) {
  // 1. 检查 OpenID 是否传入
  console.log(`[Debug] 正在检查限额...`);
  console.log(`[Debug] OpenID: ${openId}`);
  
  if (!openId) {
    console.warn('[Debug] ⚠️ OpenID 居然是空的！直接放行。');
    return true; 
  }

  // 2. 检查环境变量是否读取成功 (只打印长度，不打印密码，安全第一)
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  console.log(`[Debug] Env check -> URL存在: ${!!kvUrl}, Token长度: ${kvToken ? kvToken.length : 0}`);

  // 生成 Key
  const today = new Date().toISOString().split('T')[0];
  const key = `limit:${action}:${today}:${openId}`;

  try {
    // 3. 尝试连接数据库
    const current = await kv.get(key);
    const count = current ? parseInt(current) : 0;
    console.log(`[Debug] 数据库读取成功！当前次数: ${count}`);

    if (count >= maxLimit) {
      console.log(`[Debug] 🚫 拦截！已达上限 ${maxLimit}`);
      return false; // 🚫 次数超限
    }

    await kv.incr(key); 
    await kv.expire(key, 86400); 
    console.log(`[Debug] ✅ 放行！次数 +1`);
    
    return true; // ✅ 放行
  } catch (e) {
    // 4. 如果连接失败，打印具体报错
    console.error('[Debug] ❌ 数据库连接炸了:', e.message);
    // console.error(e); // 如果需要更详细的报错可以解开这行
    return true; // 报错时默认放行
  }
}

// ... 下面是原来的代码，保持不变 ...

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
  } catch (e) { }
  return null;
}

async function fetchGdmf() {
  const url = 'https://gdmf.apple.com/v2/pmv';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };
  const agent = new https.Agent({ rejectUnauthorized: false });
  try {
    const response = await HTTP.get(url, { timeout: 4000, headers: headers, httpsAgent: agent });
    return response.data;
  } catch (error) { throw new Error('fetchGdmf Error'); }
}

function normalizePlatform(p) {
  const k = String(p || '').toLowerCase();
  if (['ios','iphoneos','iphone'].includes(k)) return 'iOS';
  if (['ipados','ipad'].includes(k)) return 'iPadOS';
  if (['macos','mac','osx'].includes(k)) return 'macOS';
  if (['watchos','watch'].includes(k)) return 'watchOS';
  if (['tvos','apple tv','tv'].includes(k)) return 'tvOS';
  if (['visionos','vision'].includes(k)) return 'visionOS';
  return null;
}

function toBeijingYMD(s) {
  if (!s) return '';
  const d = new Date(s); if (isNaN(d)) return '';
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = bj.getFullYear(), m = String(bj.getMonth()+1).padStart(2,'0'), d2 = String(bj.getDate()).padStart(2,'0');
  return `${y}-${m}-${d2}`;
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
    let hasIOS = false; let hasIPadOS = false; let hasWatchOS = false;
    let hasTVOS = false; let hasMacOS = false; let hasVisionOS = false;
    for (const device of devices) {
        const d = String(device || '').toLowerCase();
        if (d.startsWith('iphone') || d.startsWith('ipod')) hasIOS = true;
        else if (d.startsWith('ipad')) hasIPadOS = true;
        else if (d.startsWith('watch')) hasWatchOS = true;
        else if (d.startsWith('appletv') || d.startsWith('audioaccessory')) hasTVOS = true;
        else if (d.startsWith('j') || d.startsWith('mac-') || d.includes('macos') || d.startsWith('vmm') || d.startsWith('x86') || /^[A-Z]\d{3}[A-Z]{2}AP$/i.test(device)) hasMacOS = true;
        else if (d.startsWith('realitydevice')) hasVisionOS = true;
    }
    if (hasIOS) platforms.add('iOS');
    if (hasIPadOS) platforms.add('iPadOS');
    if (hasWatchOS) platforms.add('watchOS');
    if (hasTVOS) platforms.add('tvOS');
    if (hasMacOS) platforms.add('macOS');
    if (hasVisionOS) platforms.add('visionOS');
    return platforms;
}

module.exports = {
  HTTP,
  SOURCE_NOTE,
  SEPARATOR,
  TRUNCATE_LIMIT,
  checkUsageLimit,
  getCountryCode,
  isSupportedRegion: (id) => !!getCountryCode(id),
  getFormattedTime,
  getJSON,
  pickBestMatch,
  formatPrice,
  fetchExchangeRate,
  fetchGdmf,
  normalizePlatform,
  toBeijingYMD,
  collectReleases,
  determinePlatformsFromDevices
};
