// api/handlers.js
// 【新增】引入 https 模块
const https = require('https'); 

const { 
  getCountryCode, getCountryName, getJSON, getFormattedTime, SOURCE_NOTE, 
  pickBestMatch, formatPrice, fetchExchangeRate, 
  fetchGdmf, collectReleases, normalizePlatform, toBeijingYMD,
  checkUrlAccessibility, toBeijingShortDate, formatBytes, withCache,
  sendBark 
} = require('./utils');

const { DSF_MAP, BLOCKED_APP_IDS, ADMIN_OPENID, DAILY_REQUEST_LIMIT } = require('./consts');

let kv = null;
try { ({ kv } = require('@vercel/kv')); } catch (e) { kv = null; }

const CACHE_TTL_SHORT = 600; 
const CACHE_TTL_LONG = 1800; 

// 1. 榜单查询 (保持不变)
async function handleChartQuery(regionInput, chartType) {
  const regionCode = getCountryCode(regionInput);
  if (!regionCode) return '不支持的地区或格式错误。';

  const displayName = getCountryName(regionCode);
  const interactiveName = displayName || regionInput;
  const cacheKey = `v13:chart:${regionCode}:${chartType === '免费榜' ? 'free' : 'paid'}`;

  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    let apps = []; 
    try {
      const typeNew = chartType === '免费榜' ? 'top-free' : 'top-paid';
      const urlNew = `https://rss.applemarketingtools.com/api/v2/${regionCode}/apps/${typeNew}/10/apps.json`;
      const dataNew = await getJSON(urlNew, { timeout: 5000 });
      const results = (dataNew && dataNew.feed && dataNew.feed.results) || [];
      if (results.length) apps = results.map(r => ({ id: r.id, name: r.name, url: r.url }));
    } catch (e) { console.warn(`Plan A failed:`, e.message); }

    if (apps.length === 0) {
      try {
        const typeC = chartType === '免费榜' ? 'topfreeapplications' : 'toppaidapplications';
        const urlC = `https://itunes.apple.com/${regionCode}/rss/${typeC}/limit=10/json`;
        const dataC = await getJSON(urlC, { timeout: 5000 });
        const entriesC = (dataC && dataC.feed && dataC.feed.entry) || [];
        if (entriesC.length) apps = entriesC.map(e => ({ id: e.id && e.id.attributes ? e.id.attributes['im:id'] : '', name: e['im:name'] ? e['im:name'].label : '未知应用', url: (e.link && Array.isArray(e.link) && e.link[0].attributes) ? e.link[0].attributes.href : '' }));
      } catch (e3) { console.error('Plan B failed:', e3.message); }
    }

    if (!apps.length) return '获取榜单失败，Apple 接口暂不可用，请稍后再试。';

    let resultText = `${interactiveName}${chartType}\n${getFormattedTime()}\n\n`;
    resultText += apps.map((app, idx) => {
      const appId = String(app.id || '');
      const appName = app.name || '未知应用';
      if (BLOCKED_APP_IDS.has(appId)) return `${idx + 1}、${appName}`;
      return app.url ? `${idx + 1}、<a href="${app.url}">${appName}</a>` : `${idx + 1}、${appName}`;
    }).join('\n');

    const toggleCmd = chartType === '免费榜' ? `${interactiveName}付费榜` : `${interactiveName}免费榜`;
    resultText += `\n› <a href="weixin://bizmsgmenu?msgmenucontent=${encodeURIComponent(toggleCmd)}&msgmenuid=chart_toggle">查看${chartType === '免费榜' ? '付费' : '免费'}榜单</a>`;
    resultText += `\n\n${SOURCE_NOTE}`;
    return resultText;
  });
}

// 2. 价格查询 (保持不变)
async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const code = getCountryCode(regionName);
  if (!code) return `不支持的地区或格式错误：${regionName}`;
  const cacheKey = `v11:price:${code}:${appName.toLowerCase().replace(/\s/g, '')}`;
  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=1`;
    try {
      const data = await getJSON(url);
      const results = data.results || [];
      if (!results.length) return `在${regionName}未找到“${appName}”。`;
      const best = results[0];
      const link = `<a href="${best.trackViewUrl}">${best.trackName}</a>`;
      const priceText = formatPrice(best);
      let replyText = `您查询的“${appName}”最匹配的结果是：\n\n${link}\n\n地区：${regionName}\n价格：${priceText}`;
      if (typeof best.price === 'number' && best.price > 0 && best.currency) {
        const rate = await fetchExchangeRate(best.currency);
        if (rate) { const cnyPrice = (best.price * rate).toFixed(2); replyText += ` (≈ ¥${cnyPrice})`; }
      }
      replyText += `\n时间：${getFormattedTime()}`;
      if (isDefaultSearch) replyText += `\n\n想查其他地区？试试发送：\n价格 ${appName} 日本`;
      return replyText + `\n\n${SOURCE_NOTE}`;
    } catch (e) { return '查询价格失败，请稍后再试。'; }
  });
}

// 3. 商店切换 (【已修改】统一为复制链接模式)
function handleRegionSwitch(regionName) {
  const regionCode = getCountryCode(regionName);
  const dsf = DSF_MAP[regionCode];
  if (!regionCode || !dsf) return '不支持的地区或格式错误。';
  
  // 构造 itms-apps 协议链接 (最稳妥的跳转协议)
  const rawUrl = `itms-apps://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${dsf}&cc=${regionCode}`;

  const cnCode = 'cn';
  const cnDsf = DSF_MAP[cnCode];
  const cnRawUrl = `itms-apps://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${cnDsf}&cc=${cnCode}`;

  // 文案说明：移除点击跳转，只保留长按复制
  return `由于微信限制，请长按复制下方链接去 Safari 浏览器地址栏粘贴打开。\n\n` +
         `【切换至 ${regionName}】链接：\n` +
         `<a href="weixin://">${rawUrl}</a>\n\n` +
         `【切换回 中国】链接：\n` +
         `<a href="weixin://">${cnRawUrl}</a>\n\n` +
         `点击弹窗右侧选项自动跳转切换`
}

// 4. 应用详情 (保持不变)
async function handleAppDetails(appName) {
  const code = 'us';
  const cacheKey = `v11:detail:us:${appName.toLowerCase().replace(/\s/g, '')}`;
  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=1`;
    try {
      const data = await getJSON(url);
      if (!data || !data.results || data.results.length === 0) return `未找到应用“${appName}”，请检查名称或稍后再试。`;
      const app = data.results[0];
      const rating = app.averageUserRating ? app.averageUserRating.toFixed(1) : '暂无';
      const size = formatBytes(app.fileSizeBytes || 0);
      const updateDate = toBeijingShortDate(app.currentVersionReleaseDate); 
      const minOS = app.minimumOsVersion ? `${app.minimumOsVersion}+` : '未知';
      let reply = `您查询的“${appName}”最匹配的结果是：\n\n`;
      reply += `<a href="${app.trackViewUrl}">${app.trackName}</a>\n\n`; 
      reply += `评分：${rating}\n大小：${size}\n更新：${updateDate}\n版本：${app.version}\n兼容：iOS ${minOS}\n\n${SOURCE_NOTE}`;
      return reply;
    } catch (e) { return '获取应用详情失败，请稍后再试。'; }
  });
}

// 5. 图标查询 (保持不变)
async function lookupAppIcon(appName) {
  const cacheKey = `v11:icon:us:${appName.toLowerCase().replace(/\s/g, '')}`;
  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=us&entity=software&limit=1`;
      const data = await getJSON(url);
      if (data.resultCount === 0) return '未找到相关应用，请检查名称。';
      const app = data.results[0];
      const highRes = String(app.artworkUrl100 || '').replace('100x100bb.jpg', '1024x1024bb.jpg');
      let finalIcon = app.artworkUrl512 || app.artworkUrl100;
      let desc = '图标链接';
      if (highRes && highRes !== app.artworkUrl100) {
          if (await checkUrlAccessibility(highRes)) { finalIcon = highRes; desc = '高清图标链接'; }
      }
      const appLink = `<a href="${app.trackViewUrl}">${app.trackName}</a>`;
      return `您查询的“${appName}”最匹配的结果是：\n\n${appLink}\n\n这是它的${desc}：\n${finalIcon}\n\n${SOURCE_NOTE}`;
    } catch (e) { return '查询应用图标失败，请稍后再试。'; }
  });
}

// 6. 系统更新 (保持不变)
async function handleSimpleAllOsUpdates() {
  const cacheKey = `v11:os:simple_all`;
  return await withCache(cacheKey, CACHE_TTL_LONG, async () => {
    try {
      const data = await fetchGdmf();
      const platforms = ['iOS','iPadOS','macOS','watchOS','tvOS','visionOS'];
      const results = [];
      for (const p of platforms) {
        const list = collectReleases(data, p);
        if (list.length) {
          const latest = list.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}))[0];
          results.push(`• ${p} ${latest.version}`);
        }
      }
      if (!results.length) return '暂未获取到系统版本信息，请稍后再试。';
      let replyText = `最新系统版本：\n\n${results.join('\n')}\n\n查看详情：\n`;
      replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=更新iOS&msgmenuid=iOS">iOS</a>      › <a href="weixin://bizmsgmenu?msgmenucontent=更新iPadOS&msgmenuid=iPadOS">iPadOS</a>\n`;
      replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=更新macOS&msgmenuid=macOS">macOS</a>     › <a href="weixin://bizmsgmenu?msgmenucontent=更新watchOS&msgmenuid=watchOS">watchOS</a>\n`;
      replyText += `\n查询时间：${getFormattedTime()}\n\n${SOURCE_NOTE}`;
      return replyText;
    } catch (e) { return '查询系统版本失败，请稍后再试。'; }
  });
}

// 7. 详细系统更新 (保持不变)
async function handleDetailedOsUpdate(inputPlatform = 'iOS') {
  const platform = normalizePlatform(inputPlatform) || 'iOS';
  const cacheKey = `v11:os:detail:${platform}`;
  return await withCache(cacheKey, CACHE_TTL_LONG, async () => {
    try {
      const data = await fetchGdmf();
      const list = collectReleases(data, platform);
      if (!list.length) return `${platform} 暂无版本信息。`;
      list.sort((a,b)=>{
        const da = new Date(a.date||0), db = new Date(b.date||0);
        if (db - da !== 0) return db - da;
        return b.version.localeCompare(a.version,undefined,{numeric:true});
      });
      const latest = list[0];
      const stableTag = /beta|rc|seed/i.test(JSON.stringify(latest.raw)) ? '' : ' — 正式版';
      const latestDateStr = toBeijingShortDate(latest.date) || '未知';
      const lines = list.slice(0,5).map(r=>{
        const t = toBeijingShortDate(r.date);
        const releaseTag = /beta/i.test(JSON.stringify(r.raw)) ? ' (Beta)' : '';
        return `• ${r.version} (${r.build})${releaseTag}${t?` ${t}`:''}`;
      });
      return `${platform} 最新版本：\n版本：${latest.version}（${latest.build}）${stableTag}\n时间：${latestDateStr}\n\n近期历史：\n${lines.join('\n')}\n\n${SOURCE_NOTE}`;
    } catch (e) { return '查询系统版本失败，请稍后再试。'; }
  });
}

// 8. 管理后台 (保持不变)
async function handleAdminStatus(fromUser) {
  if (fromUser !== ADMIN_OPENID) return ''; 
  try {
    const dbSize = kv ? await kv.dbsize() : '未连接KV'; 
    return `【管理看板】\n\n状态：运行中\n缓存Key数：${dbSize}\n每日限额：${DAILY_REQUEST_LIMIT}次/人\n\n系统时间：${getFormattedTime()}`;
  } catch (e) { return `后台查询出错：${e.message}`; }
}

module.exports = {
  handleChartQuery, handlePriceQuery, handleRegionSwitch, handleAppDetails,
  lookupAppIcon, handleSimpleAllOsUpdates, handleDetailedOsUpdate, handleAdminStatus
};
