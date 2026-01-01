// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { isSupportedRegion, checkUserRateLimit } = require('./utils');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleVerification(req, res);
  
  if (req.method === 'POST') {
    // 【核心保护】4.5秒超时熔断，防止微信发起重试轰炸
    const task = handlePostRequest(req, res);
    const timeout = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 4500));

    try {
      const result = await Promise.race([task, timeout]);
      if (result === 'TIMEOUT') {
        // 超时了，直接返回空，结束战斗
        return res.status(200).send(''); 
      }
      return result; 
    } catch (e) {
      console.error('Main Handler Error:', e);
      return res.status(200).send('');
    }
  }
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
    const fromUser = message.FromUserName;

    // 关注事件
    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      replyContent =
        `恭喜！你发现了果粉秘密基地\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=应用查询&msgmenuid=1">应用查询</a>\n热门应用详情查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
    
    // 文本消息
    } else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();

      // 【核心保护】用户限流检查
      const isAllowed = await checkUserRateLimit(fromUser);
      if (!isAllowed) {
        const xml = buildTextReply(message.FromUserName, message.ToUserName, '您今天的查询次数已达上限，请明天再来吧！');
        return res.setHeader('Content-Type', 'application/xml').status(200).send(xml);
      }

      // 宽容正则，允许前后空格
      const chartMatch = content.match(/^\s*(.*?)\s*(免费榜|付费榜)\s*$/); 
      const chartV2Match = content.match(/^榜单\s*(.+)$/i); 
      const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const priceMatchSimple = content.match(/^价格\s*(.+)$/i); 
      const switchRegionMatch = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const osAllMatch = /^系统更新$/i.test(content);
      const osUpdateMatch = content.match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)$/i); 
      const iconMatch = content.match(/^图标\s*(.+)$/i); 
      const detailMatch = content.match(/^查询\s*(.+)$/i); 
      const isAppQueryMenu = content === '应用查询';
      const adminMatch = content === '管理后台' || content === '后台数据';

      // 路由分发
      if (chartV2Match && isSupportedRegion(chartV2Match[1])) {
        replyContent = await Handlers.handleChartQuery(chartV2Match[1].trim(), '免费榜');
      } else if (chartMatch && isSupportedRegion(chartMatch[1])) {
        // 由于有双向字典，chartMatch[1] 即使是 'jp' 也能直接查到
        replyContent = await Handlers.handleChartQuery(chartMatch[1].trim(), chartMatch[2]);
      } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
        replyContent = await Handlers.handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false);
      } else if (priceMatchSimple) {
        let queryAppName = priceMatchSimple[1].trim();
        let targetRegion = '美国';
        let isDefaultSearch = true;
        for (const countryName in ALL_SUPPORTED_REGIONS) {
          // 处理类似 "价格Instagram土耳其" 这种连在一起的输入
          if (queryAppName.endsWith(countryName) && queryAppName.length > countryName.length) {
            targetRegion = countryName;
            queryAppName = queryAppName.slice(0, -countryName.length).trim();
            isDefaultSearch = false; 
            break; 
          }
        }
        replyContent = await Handlers.handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);
      } else if (osAllMatch) {
        replyContent = await Handlers.handleSimpleAllOsUpdates();
      } else if (osUpdateMatch) {
        replyContent = await Handlers.handleDetailedOsUpdate(osUpdateMatch[1].trim());
      } else if (switchRegionMatch && isSupportedRegion(switchRegionMatch[2])) {
        replyContent = Handlers.handleRegionSwitch(switchRegionMatch[2].trim());
      } else if (iconMatch) {
        replyContent = await Handlers.lookupAppIcon(iconMatch[1].trim());
      } else if (isAppQueryMenu) {
        replyContent = '请回复“查询+应用名称”，例如：\n\n查询微信\n查询TikTok\n查询小红书';
      } else if (detailMatch) {
        replyContent = await Handlers.handleAppDetails(detailMatch[1].trim());
      } else if (adminMatch) {
        replyContent = await Handlers.handleAdminStatus(fromUser);
      }
    }
  } catch (error) { console.error('Error processing POST:', error.message || error); }

  if (replyContent) {
    const xml = buildTextReply(message.FromUserName, message.ToUserName, replyContent);
    return res.setHeader('Content-Type', 'application/xml').status(200).send(xml);
  }
  return res.status(200).send('');
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString('utf-8')));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function buildTextReply(toUser, fromUser, content) {
  const payload = {
    ToUserName: toUser, FromUserName: fromUser, CreateTime: Math.floor(Date.now() / 1000), MsgType: 'text', Content: content
  };
  return builder.buildObject(payload);
}
