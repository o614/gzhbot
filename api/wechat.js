const crypto = require('crypto');
const axios = require('axios');
const { Parser, Builder } = require('xml2js');
const cheerio = require('cheerio'); // 引入 HTML 解析库

// 引入外部数据
const { ALL_SUPPORTED_REGIONS, DSF_MAP, BLOCKED_APP_IDS, TARGET_COUNTRIES_FOR_AVAILABILITY } = require('./consts');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

const HTTP = axios.create({
  timeout: 8000, // 爬虫稍微给多点时间
  headers: { 'user-agent': 'Mozilla/5.0 (Serverless-WeChatBot)' }
});

const SOURCE_NOTE = '*数据来源 Apple 官方*';

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleVerification(req, res);
  if (req.method === 'POST') return handlePostRequest(req, res);
  res.status(200).send('');
};

function handleVerification(req, res) {
  try {
    const { signature, timestamp, nonce, echostr } = req.query;
    const params = [WECHAT_TOKEN || '', timestamp, nonce].sort();
    const hash = crypto.createHash('sha1').update(params.join('')).digest('hex');
    if (hash === signature) return res.status(200).send(echostr);
  } catch {}
  res.status(200).send('');
}

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};

    if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      
      const chartV2Match = content.match(/^榜单\s*(.+)$/i); 
      const chartMatch = content.match(/^(.*?)(免费榜|付费榜)$/); 
      const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const priceMatchSimple = content.match(/^价格\s*(.+)$/i); 
      const osAllMatch = /^系统更新$/i.test(content);
      const osUpdateMatch = content.match(/^更新\s*(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)?$/i);
      const iconMatch = content.match(/^图标\s*(.+)$/i);

      if (chartV2Match && isSupportedRegion(chartV2Match[1])) {
        replyContent = await handleChartQuery(chartV2Match[1].trim(), '免费榜');
      } else if (chartMatch && isSupportedRegion(chartMatch[1])) {
        replyContent = await handleChartQuery(chartMatch[1].trim(), chartMatch[2]);
      } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
        replyContent = await handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false);
      } else if (priceMatchSimple) {
        let queryAppName = priceMatchSimple[1].trim();
        let targetRegion = '美国';
        let isDefaultSearch = true;
        for (const countryName in ALL_SUPPORTED_REGIONS) {
          if (queryAppName.endsWith(countryName) && queryAppName.length > countryName.length) {
            targetRegion = countryName;
            queryAppName = queryAppName.slice(0, -countryName.length).trim();
            isDefaultSearch = false; 
            break; 
          }
        }
        replyContent = await handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);
      } else if (osAllMatch) {
        replyContent = await handleSimpleAllOsUpdates();
      } else if (osUpdateMatch) {
        const platform = (osUpdateMatch[1] || 'iOS').trim();
        replyContent = await handleDetailedOsUpdate(platform);
      } else if (iconMatch) { 
        const appName = iconMatch[1].trim();
        if (appName) replyContent = await lookupAppIcon(appName);
      }
    }
  } catch (error) {
    console.error('Error processing POST:', error.message || error);
  }

  if (replyContent) {
    const xml = buildTextReply(message.FromUserName, message.ToUserName, replyContent);
    return res.setHeader('Content-Type', 'application/xml').status(200).send(xml);
  }
  return res.status(200).send('');
}

// 🕷️ 核心爬虫：去网页里抠内购信息
async function scrapeIAP(appUrl) {
  try {
    // 伪装成 Mac Safari 浏览器，防止被 Apple 拦截
    const { data: html } = await axios.get(appUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });

    const $ = cheerio.load(html);
    let iapList = [];

    // 针对 Apple 网页结构的特定选择器
    // 策略 A：查找 class 为 list-with-numbers__item 的列表
    $('.list-with-numbers__item').each((i, el) => {
      if (i >= 5) return; // 只取前 5 个
      const title = $(el).find('.list-with-numbers__item__title span').text().trim();
      const price = $(el).find('.list-with-numbers__item__price').text().trim();
      if (title && price) {
        iapList.push(`${title}: ${price}`);
      }
    });

    // 策略 B：如果策略 A 没找到，尝试找 "inline-list__item" (某些旧版页面)
    if (iapList.length === 0) {
       $('.inline-list__item').each((i, el) => {
          if (i >= 5) return;
          const title = $(el).find('.inline-list__item__title').text().trim();
          const price = $(el).find('.inline-list__item__price').text().trim();
          if (title && price) iapList.push(`${title}: ${price}`);
       });
    }

    if (iapList.length > 0) {
      return '🛒 内购参考：\n' + iapList.join('\n');
    }
    
    return '未检测到内购项目';

  } catch (e) {
    console.error('Scrape Error:', e.message);
    if (e.response && e.response.status === 403) {
        return '内购数据获取受限 (服务器 IP 被 Apple 拦截)';
    }
    return '内购数据获取失败';
  }
}

// 价格查询 (升级版：集成内购抓取)
async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const code = getCountryCode(regionName);
  if (!code) return `不支持的地区或格式错误：${regionName}`;

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=5`;
  try {
    const data = await getJSON(url);
    const results = data.results || [];
    if (!results.length) return `在${regionName}未找到“${appName}”。`;

    const best = pickBestMatch(appName, results);
    const link = `<a href="${best.trackViewUrl}">${best.trackName}</a>`;
    const priceText = formatPrice(best);

    let replyText = `您搜索的“${appName}”最匹配的结果是：\n\n${link}\n\n地区：${regionName}\n价格：${priceText}`;
    
    // 【插入】调用爬虫获取内购！
    // 只有当有网页链接时才去爬
    if (best.trackViewUrl) {
        const iapInfo = await scrapeIAP(best.trackViewUrl);
        replyText += `\n\n${iapInfo}`;
    }

    replyText += `\n\n时间：${getFormattedTime()}`;
    if (isDefaultSearch) replyText += `\n\n想查其他地区？试试发送：\n价格 ${appName} 日本`;
    
    return replyText + `\n\n${SOURCE_NOTE}`;
  } catch {
    return '查询价格失败，请稍后再试。';
  }
}

// ... (以下辅助函数保持不变：getRawBody, getCountryCode, isSupportedRegion, getFormattedTime, buildTextReply, getJSON, handleChartQuery, pickBestMatch, formatPrice, handleSimpleAllOsUpdates, handleDetailedOsUpdate, fetchGdmf 等) ...
// 请保留你原文件中其余的辅助函数代码，这里省略以节省篇幅，只要替换上面的 handlePriceQuery 和新增 scrapeIAP 即可。
// 务必确保末尾的 normalizePlatform, toBeijingYMD 等函数都在。

// --- 补全缺失的辅助函数 (防止你复制漏了) ---
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString('utf-8')));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
// ... (请确保所有辅助函数完整) ...
