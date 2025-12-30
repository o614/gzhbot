// api/handlers.js
const { 
  getCountryCode, getJSON, getFormattedTime, SOURCE_NOTE, 
  pickBestMatch, formatPrice, fetchExchangeRate, 
  fetchGdmf, collectReleases, normalizePlatform, toBeijingYMD 
} = require('./utils');

const { DSF_MAP, BLOCKED_APP_IDS, TARGET_COUNTRIES_FOR_AVAILABILITY } = require('./consts');

// 1. 榜单查询
async function handleChartQuery(regionName, chartType) {
  const regionCode = getCountryCode(regionName);
  if (!regionCode) return '不支持的地区或格式错误。';

  const typePath = chartType === '免费榜' ? 'topfreeapplications' : 'toppaidapplications';
  const url = `https://itunes.apple.com/${regionCode}/rss/${typePath}/limit=10/json`;

  try {
    const data = await getJSON(url);
    const entries = data?.feed?.entry || [];
    if (!entries.length) return '暂无数据或未获取到榜单信息。';

    let replyText = `🏆 ${regionName}${chartType} Top 10\n\n`;
    entries.forEach((app, i) => {
      const name = app['im:name']?.label || '未知App';
      const appId = parseInt(app.id?.attributes?.['im:id'], 10);
      const link = app.link?.attributes?.href;

      // 屏蔽部分 appId 的链接
      if (appId && BLOCKED_APP_IDS.has(appId)) {
        replyText += `${i + 1}. ${name}\n`;
      } else if (link) {
        replyText += `${i + 1}. <a href="${link}">${name}</a>\n`;
      } else {
        replyText += `${i + 1}. ${name}\n`;
      }
    });

    replyText += `\n查询时间：${getFormattedTime()}\n\n${SOURCE_NOTE}`;

    // 追加切换另一个榜单的便捷入口
    const switchTo = chartType === '免费榜' ? '付费榜' : '免费榜';
    replyText += `\n\n<a href="weixin://bizmsgmenu?msgmenucontent=${regionName}${switchTo}&msgmenuid=3">查看${switchTo}</a>`;
    return replyText;
  } catch (e) {
    console.error('Error in handleChartQuery:', e.message || e);
    return '查询榜单失败，请稍后再试。';
  }
}

// 2. 价格查询
async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const regionCode = getCountryCode(regionName);
  if (!regionCode) return '不支持的地区或格式错误。';

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=${regionCode}&entity=software&limit=5`;

  try {
    const data = await getJSON(url);
    const results = data?.results || [];
    if (!results.length) return `未在 ${regionName} 找到 “${appName}” 的应用。`;

    const best = pickBestMatch(appName, results);
    const trackName = best.trackName || appName;
    const price = best.price;
    const currency = best.currency;
    const trackViewUrl = best.trackViewUrl;

    let replyText = `💰 ${regionName} 价格查询\n\n`;
    replyText += `应用：${trackViewUrl ? `<a href="${trackViewUrl}">${trackName}</a>` : trackName}\n`;
    replyText += `价格：${formatPrice(price, currency)}\n`;

    // 付费应用则尝试换算人民币
    if (price && currency && currency.toUpperCase() !== 'CNY') {
      const rate = await fetchExchangeRate(currency.toUpperCase());
      if (rate) {
        const cnyPrice = (price * rate);
        replyText += `约合：¥${cnyPrice.toFixed(2)}\n`;
      }
    }

    if (isDefaultSearch) {
      replyText += `\n提示：可用 “价格 应用名 国家/地区” 查询其他区，例如：价格 YouTube 日本`;
    }

    replyText += `\n\n查询时间：${getFormattedTime()}\n\n${SOURCE_NOTE}`;
    return replyText;
  } catch (e) {
    console.error('Error in handlePriceQuery:', e.message || e);
    return '查询价格失败，请稍后再试。';
  }
}

// 3. 地区切换链接
function handleRegionSwitch(regionName) {
  const regionCode = getCountryCode(regionName);
  if (!regionCode) return '不支持的地区或格式错误。';

  const dsf = DSF_MAP[regionCode];
  if (!dsf) return '该地区暂不支持切换链接。';

  const url = `https://apps.apple.com/us/app/apple-store/id375380948?l=zh&cc=${regionCode}&mt=8&app=itunes&dsf=${dsf}`;
  const switchUrl = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${dsf}&cc=${regionCode}`;

  return `🔁 切换 App Store 地区：${regionName}\n\n` +
         `点击切换：<a href="${switchUrl}">${switchUrl}</a>\n` +
         `浏览入口：<a href="${url}">${url}</a>\n\n` +
         `说明：切换后仅用于浏览，下载仍需对应地区账号。\n` +
         `*目前不支持 iOS 26 及以上系统*\n\n${SOURCE_NOTE}`;
}

// 4. 上架地区查询
async function handleAvailabilityQuery(appName) {
  try {
    const universalId = await findAppUniversalId(appName);
    if (!universalId) return `未找到 “${appName}” 的应用（美区/国区均未命中）。`;

    const availableCountries = [];
    for (const country of TARGET_COUNTRIES_FOR_AVAILABILITY) {
      const ok = await checkAvailability(universalId, country);
      if (ok) availableCountries.push(country.toUpperCase());
    }

    let replyText = `🔎 上架地区查询\n\n应用：${appName}\n\n`;
    replyText += availableCountries.length
      ? `可下载地区：\n${availableCountries.join(', ')}`
      : `在我们查询的热门地区中，均未发现此应用上架。`;
    return replyText + `\n\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Error in handleAvailabilityQuery:', e.message || e);
    return '查询上架地区失败，请稍后再试。';
  }
}

async function findAppUniversalId(appName) {
  const endpoints = [
    `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=us&entity=software&limit=1`,
    `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=cn&entity=software&limit=1`
  ];
  for (const url of endpoints) {
    try {
      const data = await getJSON(url, { timeout: 4000 });
      if (data?.results?.length) {
        return data.results[0].trackId;
      }
    } catch (e) {}
  }
  return null;
}

async function checkAvailability(trackId, country) {
  try {
    const url = `https://itunes.apple.com/lookup?id=${trackId}&country=${country}&entity=software`;
    const data = await getJSON(url);
    return (data?.resultCount || 0) > 0;
  } catch (e) {
    return false;
  }
}

// 5. 获取应用图标
async function lookupAppIcon(appName) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=us&entity=software&limit=1`;
  try {
    const data = await getJSON(url);
    const result = data?.results?.[0];
    if (!result) return '未找到该应用。';

    const name = result.trackName || appName;
    const artwork100 = result.artworkUrl100;
    const artwork512 = result.artworkUrl512;

    // 尽量给 1024
    let iconUrl = artwork100 ? artwork100.replace('100x100bb.jpg', '1024x1024bb.jpg') : '';
    if (!iconUrl || iconUrl === artwork100) iconUrl = artwork512 || artwork100 || '';

    if (!iconUrl) return '未获取到图标链接。';
    return `🖼️ ${name} 官方图标：\n<a href="${iconUrl}">${iconUrl}</a>\n\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Error in lookupAppIcon:', e.message || e);
    return '获取图标失败，请稍后再试。';
  }
}

// 6. 系统更新（总览）
async function handleSimpleAllOsUpdates() {
  try {
    const data = await fetchGdmf();
    if (!data) return '暂无系统更新数据。';

    const platforms = ['iOS', 'iPadOS', 'macOS', 'watchOS', 'tvOS', 'visionOS'];

    let replyText = `🆕 Apple 系统更新\n\n`;
    for (const p of platforms) {
      const rel = collectReleases(data, p);
      const latest = rel[0];
      if (latest?.version) {
        replyText += `${p}：${latest.version}（${latest.build || ''}）\n`;
      } else {
        replyText += `${p}：暂无\n`;
      }
    }
    replyText += `\n查询时间：${getFormattedTime()}\n\n${SOURCE_NOTE}`;
    return replyText;
  } catch (e) {
    console.error('Error in handleSimpleAllOsUpdates:', e.message || e);
    return '查询系统版本失败，请稍后再试。';
  }
}

// 7. 系统更新（单个平台详细）
async function handleDetailedOsUpdate(platform) {
  try {
    const p = normalizePlatform(platform);
    if (!p) return '不支持的系统平台。';

    const data = await fetchGdmf();
    const rel = collectReleases(data, p);
    if (!rel.length) return `未找到 ${p} 的更新信息。`;

    const latest = rel[0];
    const latestDateStr = latest.date ? toBeijingYMD(latest.date) : '';

    const recent = rel.slice(0, 5);
    const lines = recent.map((r, i) => {
      const d = r.date ? toBeijingYMD(r.date) : '';
      return `${i + 1}. ${r.version || ''}（${r.build || ''}） ${d ? `- ${d}` : ''}`.trim();
    });

    return `🆕 ${p} 最新版本\n\n` +
      `最新：${latest.version || ''}（${latest.build || ''}）\n` +
      `发布时间：${latestDateStr}\n\n` +
      `近期版本：\n${lines.join('\n')}\n\n` +
      `查询时间：${getFormattedTime()}\n\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Error in handleDetailedOsUpdate:', e.message || e);
    return '查询系统版本失败，请稍后再试。';
  }
}

module.exports = {
  handleChartQuery,
  handlePriceQuery,
  handleRegionSwitch,
  handleAvailabilityQuery,
  lookupAppIcon,
  handleSimpleAllOsUpdates,
  handleDetailedOsUpdate
};
