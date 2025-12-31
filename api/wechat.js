// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { isSupportedRegion } = require('./utils');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;

const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

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

    // 修改点：关注回复内容更新
    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      replyContent =
        `恭喜！你发现了果粉秘密基地\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=应用查询&msgmenuid=1">应用查询</a>\n热门应用详情查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
    } else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      
      const chartMatch = content.match(/^(.*?)(免费榜|付费榜)$/); 
      const chartV2Match = content.match(/^榜单\s*(.+)$/i); 
      
      const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const priceMatchSimple = content.match(/^价格\s*(.+)$/i); 
      
      const switchRegionMatch = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      
      const osAllMatch = /^系统更新$/i.test(content);
      const osUpdateMatch = content.match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)$/i); 
      
      const iconMatch = content.match(/^图标\s*(.+)$/i); 
      
      const detailMatch = content.match(/^((查询|详情)\s*)?(.+)$/i); 

      // 1. 榜单
      if (chartV2Match && isSupportedRegion(chartV2Match[1])) {
        replyContent = await Handlers.handleChartQuery(chartV2Match[1].trim(), '免费榜');
      } else if (chartMatch && isSupportedRegion(chartMatch[1])) {
        replyContent = await Handlers.handleChartQuery(chartMatch[1].trim(), chartMatch[2]);
      
      // 2. 价格
      } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
        replyContent = await Handlers.handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false);
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
        replyContent = await Handlers.handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);

      // 3. 系统更新
      } else if (osAllMatch) {
        replyContent = await Handlers.handleSimpleAllOsUpdates();
      } else if (osUpdateMatch) {
        replyContent = await Handlers.handleDetailedOsUpdate(osUpdateMatch[1].trim());

      // 4. 切换
      } else if (switchRegionMatch && isSupportedRegion(switchRegionMatch[2])) {
        replyContent = Handlers.handleRegionSwitch(switchRegionMatch[2].trim());

      // 5. 图标
      } else if (iconMatch) {
        replyContent = await Handlers.lookupAppIcon(iconMatch[1].trim());

      // 6. 详情 (兜底)
      } else if (detailMatch) {
        let keyword = content;
        if (content.startsWith('查询') || content.startsWith('详情')) {
             keyword = content.replace(/^(查询|详情)\s*/, '');
        }
        // 如果用户点击了“应用查询”菜单，这里会搜索“应用查询”这个词，
        // 为了体验更好，如果关键词是“应用查询”，提示用户输入名称
        if (keyword.trim() === '应用查询') {
            replyContent = '请直接回复你想查询的应用名称，例如：\n\n微信\nTikTok\n小红书';
        } else {
            replyContent = await Handlers.handleAppDetails(keyword.trim());
        }
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
    ToUserName: toUser,
    FromUserName: fromUser,
    CreateTime: Math.floor(Date.now() / 1000),
    MsgType: 'text',
    Content: content
  };
  return builder.buildObject(payload);
}
