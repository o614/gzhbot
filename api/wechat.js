// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
// 【修正】确保这里引入了 ALL_SUPPORTED_REGIONS
const { ALL_SUPPORTED_REGIONS } = require('./consts'); 
const { isSupportedRegion, checkUserRateLimit, checkSubscribeFirstTime } = require('./utils');
const Handlers = require('./handlers');
const { getWelcomeText, KEYWORD_REPLIES } = require('./replies');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

const FEATURES = [
  // 1. 管理功能
  {
    name: 'Admin',
    match: (c) => /^管理后台|后台数据$/i.test(c),
    needAuth: false,
    handler: async (match, openId) => Handlers.handleAdminStatus(openId)
  },
  {
    name: 'MyID', 
    match: (c) => /^myid$/i.test(c),
    needAuth: false,
    handler: async (match, openId) => `你的 OpenID：${openId}`
  },

  // 2. 静态关键词 (读取 replies.js)
  {
    name: 'StaticKeyword',
    // 只要 content 存在于 KEYWORD_REPLIES 的键中，就匹配成功
    match: (c) => !!KEYWORD_REPLIES[c], 
    needAuth: false,
    // 【关键】这里需要第3个参数 content
    handler: async (match, openId, content) => KEYWORD_REPLIES[content] 
  },

  // 3. 动态业务功能
  {
    name: 'ChartSimple',
    match: (c) => c.match(/^榜单\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[1])) return null;
      return Handlers.handleChartQuery(match[1].trim(), '免费榜');
    }
  },
  {
    name: 'ChartDetail',
    match: (c) => c.match(/^(.*?)(免费榜|付费榜)$/),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[1])) return null;
      return Handlers.handleChartQuery(match[1].trim(), match[2]);
    }
  },
  {
    name: 'PriceAdvanced',
    match: (c) => c.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[2])) return null;
      return Handlers.handlePriceQuery(match[1].trim(), match[2].trim(), false);
    }
  },
  {
    name: 'PriceSimple',
    match: (c) => c.match(/^价格\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => {
      let queryAppName = match[1].trim();
      let targetRegion = '美国';
      let isDefaultSearch = true;
      
      // 倒序遍历地区名，解决 "价格 Minecraft 日本" 这种没有空格的情况
      for (const countryName in ALL_SUPPORTED_REGIONS) {
        if (queryAppName.endsWith(countryName) && queryAppName.length > countryName.length) {
          targetRegion = countryName;
          queryAppName = queryAppName.slice(0, -countryName.length).trim();
          isDefaultSearch = false;
          break;
        }
      }
      return Handlers.handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);
    }
  },
  {
    name: 'SwitchRegion',
    match: (c) => c.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i),
    needAuth: false,
    handler: async (match) => {
      if (!isSupportedRegion(match[2])) return null;
      return Handlers.handleRegionSwitch(match[2].trim());
    }
  },
  {
    name: 'AppDetails',
    match: (c) => c.match(/^查询\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => Handlers.handleAppDetails(match[1].trim())
  },
  {
    name: 'SystemUpdateAll',
    match: (c) => /^系统更新$/i.test(c),
    needAuth: true,
    handler: async () => Handlers.handleSimpleAllOsUpdates()
  },
  {
    name: 'SystemUpdateDetail',
    match: (c) => c.match(/^更新\s*(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)?$/i),
    needAuth: true,
    handler: async (match) => Handlers.handleDetailedOsUpdate((match[1] || 'iOS').trim())
  },
  {
    name: 'AppIcon',
    match: (c) => c.match(/^图标\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => Handlers.lookupAppIcon(match[1].trim())
  }
];

// 主入口
module.exports = async (req, res) => {
  if (req.method === 'GET') return handleVerification(req, res);
  
  if (req.method === 'POST') {
    const task = handlePostRequest(req, res);
    // 4.5秒 超时熔断
    const timeout = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 4500));

    try {
      const result = await Promise.race([task, timeout]);
      if (result === 'TIMEOUT') return res.status(200).send(''); 
      return result; 
    } catch (e) {
      console.error('Main Handler Error:', e);
      return res.status(200).send('');
    }
  }
  res.status(200).send('');
};

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};
    const openId = message.FromUserName;

    // 1. 关注事件
    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      const { isFirst } = await checkSubscribeFirstTime(openId);
      // 使用 replies.js 的配置
      replyContent = getWelcomeText(isFirst);
    }
    // 2. 文本消息
    else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      
      for (const feature of FEATURES) {
        const match = feature.match(content);
        if (match) {
          if (feature.needAuth) {
            const gate = await checkUserRateLimit(openId);
            if (!gate) {
              replyContent = '您今天的查询次数已达上限，请明天再来吧！';
              break;
            }
          }
          try {
            // 【关键】传入 content 参数，供 StaticKeyword 使用
            const result = await feature.handler(match, openId, content);
            if (result) { 
               replyContent = result;
               break; 
            }
          } catch (e) { console.error(`Error in feature ${feature.name}:`, e); }
        }
      }
    }
  } catch (error) { console.error('Error processing POST:', error); }

  if (replyContent) {
    const xml = buildTextReply(message.FromUserName, message.ToUserName, replyContent);
    return res.setHeader('Content-Type', 'application/xml').status(200).send(xml);
  }
  return res.status(200).send('');
}

function handleVerification(req, res) {
  try {
    const { signature, timestamp, nonce, echostr } = req.query;
    const params = [WECHAT_TOKEN || '', timestamp, nonce].sort();
    const hash = crypto.createHash('sha1').update(params.join('')).digest('hex');
    if (hash === signature) return res.status(200).send(echostr);
  } catch {}
  res.status(200).send('');
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
