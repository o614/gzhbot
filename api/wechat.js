// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
// 确保 consts.js 里有 '日本':'jp'
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const { isSupportedRegion, checkAbuseGate, checkSubscribeFirstTime } = require('./utils');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;

// Admin OpenIDs
const ADMIN_OPENIDS = String(process.env.ADMIN_OPENIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAdmin(openId) {
  return !!openId && ADMIN_OPENIDS.includes(String(openId));
}

async function gateOrBypass(openId) {
  if (isAdmin(openId)) return { allowed: true };
  return await checkAbuseGate(openId);
}

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

function buildWelcomeText(prefixLine = '') {
  const base =
    `恭喜！你发现了果粉秘密基地\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=查询TikTok&msgmenuid=1">查询TikTok</a>\n热门地区上架查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;

  return prefixLine ? `${prefixLine}\n\n${base}` : base;
}

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};

    const openId = message.FromUserName;

    // --- 事件消息 ---
    if (message.MsgType === 'event') {
      if (message.Event === 'subscribe') {
        const { isFirst } = await checkSubscribeFirstTime(openId);
        replyContent = isFirst ? buildWelcomeText('') : buildWelcomeText('欢迎回来！');
      }
    } 
    
    // --- 文本消息 ---
    else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      console.log(`[Msg] User: ${openId} | Content: "${content}"`); // 打印收到的原始内容

      if (/^myid$/i.test(content)) {
        replyContent = `你的 OpenID：${openId}`;
      } else {
        // --- 1. 正则匹配 ---
        // 榜单查询：匹配 "榜单美国"
        const chartV2Match = content.match(/^榜单\s*(.+)$/i);
        
        // 榜单详情：匹配 "美国付费榜" (改为更宽松的匹配，允许两端有空格)
        const chartMatch = content.match(/^\s*(.+?)\s*(免费榜|付费榜)\s*$/i);
        
        // 价格查询
        const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i);
        const priceMatchSimple = content.match(/^价格\s*(.+)$/i);
        
        // 其他
        const switchRegionMatch = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i);
        const availabilityMatch = content.match(/^查询\s*(.+)$/i);
        const osAllMatch = /^系统更新$/i.test(content);
        const osUpdateMatch = content.match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)$/i);
        const iconMatch = content.match(/^图标\s*(.+)$/i);

        // --- 2. 逻辑分发 ---
        
        if (chartV2Match && isSupportedRegion(chartV2Match[1].trim())) {
          console.log(`[Log] Matched ChartV2: ${chartV2Match[1]}`);
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed
            ? await Handlers.handleChartQuery(chartV2Match[1].trim(), '免费榜')
            : gate.message;

        } else if (chartMatch) {
          // 调试：打印提取到的地区和类型
          const region = chartMatch[1].trim();
          const type = chartMatch[2].trim();
          const isSupported = isSupportedRegion(region);
          console.log(`[Log] Matched ChartDetail: Region="${region}" Supported=${isSupported}, Type="${type}"`);

          if (isSupported) {
            const gate = await gateOrBypass(openId);
            replyContent = gate.allowed
              ? await Handlers.handleChartQuery(region, type)
              : gate.message;
          } else {
            console.log(`[Log] Region "${region}" not supported.`);
            // 如果正则匹配了但地区不支持，也可以考虑提示，或者静默
          }

        } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed
            ? await Handlers.handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false)
            : gate.message;

        } else if (priceMatchSimple) {
          const gate = await gateOrBypass(openId);
          if (!gate.allowed) {
            replyContent = gate.message;
          } else {
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
          }

        } else if (osAllMatch) {
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed ? await Handlers.handleSimpleAllOsUpdates() : gate.message;

        } else if (osUpdateMatch) {
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed ? await Handlers.handleDetailedOsUpdate(osUpdateMatch[1].trim()) : gate.message;

        } else if (switchRegionMatch && isSupportedRegion(switchRegionMatch[2])) {
          replyContent = Handlers.handleRegionSwitch(switchRegionMatch[2].trim());

        } else if (availabilityMatch) {
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed ? await Handlers.handleAvailabilityQuery(availabilityMatch[1].trim()) : gate.message;

        } else if (iconMatch) {
          const appName = iconMatch[1].trim();
          if (appName) {
            const gate = await gateOrBypass(openId);
            replyContent = gate.allowed ? await Handlers.lookupAppIcon(appName) : gate.message;
          }
        } 
        
        // --- 3. 兜底调试 (如果上面都没进，回复这句) ---
        if (!replyContent) {
           console.log('[Log] No match found for:', content);
           // 如果你想让用户知道指令不对，可以取消下面这行的注释
           // replyContent = `未识别指令：${content}\n请检查格式或地区是否支持。`;
        }
      }
    }
  } catch (error) {
    console.error('Error processing POST:', error.message || error);
    // 出错时也回复，方便知道崩了
    replyContent = '系统内部错误，请稍后再试。';
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
