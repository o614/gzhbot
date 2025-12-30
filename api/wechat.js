const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');
const utils = require('./utils');

// ==========================================
// 🎛️ 中央控制室：精准限额配置表
// ==========================================
const LIMIT_CONFIG = {
  // 1. 🌏 全局大闸：每天总共能互动 30 次 (底线防御)
  GLOBAL_DAILY_LIMIT: 30, 

  // 2. 🚦 功能小闸：
  // 数字 = 每日次数 | 0 = 只受大闸限制 | -1 = 豁免(不扣次数)
  FEATURES: {
    'icon': 3,     // 🟥 图标：高消耗，严防 (每日3次)
    'search': 10,  // 🟨 查询/价格：API调用 (每日10次)
    'rank': 10,    // 🟨 榜单：API调用 (每日10次)
    'update': 15,  // 🟦 系统更新：外部请求 (每日15次，给宽裕点)
    
    'switch': -1,  // 🟩 切换地区：静态链接，不消耗资源 -> 豁免
    'static': -1,  // 🟩 静态回复(如付款方式)：豁免
    'myid': -1     // 🟩 查ID：豁免
  }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) {
      if (typeof req.body === 'string') return resolve(req.body);
      if (Buffer.isBuffer(req.body)) return resolve(req.body.toString());
      return resolve(JSON.stringify(req.body));
    }
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { resolve(data); });
    req.on('error', err => { reject(err); });
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') return res.status(200).send(req.query.echostr);

    const rawContent = await getRawBody(req);
    if (!rawContent) return res.status(200).send('success');

    const result = await parseStringPromise(rawContent);
    const xml = result.xml;

    const toUser = xml.ToUserName[0];
    const fromUser = xml.FromUserName[0];
    const msgType = xml.MsgType ? xml.MsgType[0] : '';
    const eventType = xml.Event ? xml.Event[0] : '';
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Msg] User: ${fromUser}, Content: ${content}`);

    const reply = (text) => {
      const now = Math.floor(Date.now() / 1000);
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(`
        <xml>
          <ToUserName><![CDATA[${fromUser}]]></ToUserName>
          <FromUserName><![CDATA[${toUser}]]></FromUserName>
          <CreateTime>${now}</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[${text}]]></Content>
        </xml>
      `);
    };

    // 🚦 拦截核心逻辑
    const checkLimits = async (actionType) => {
      const featureLimit = LIMIT_CONFIG.FEATURES[actionType];
      
      // 1. 豁免功能直接放行
      if (featureLimit === -1) return true;

      // 2. 查大闸 (30次)
      const globalAllowed = await utils.checkUsageLimit(fromUser, 'global_limit', LIMIT_CONFIG.GLOBAL_DAILY_LIMIT);
      if (!globalAllowed) {
        reply(`🚫 今日总互动次数已达上限 (${LIMIT_CONFIG.GLOBAL_DAILY_LIMIT}次)\n休息一下，明天再来体验吧！`);
        return false;
      }

      // 3. 查小闸 (如果有具体限制)
      if (featureLimit > 0) {
        const featureAllowed = await utils.checkUsageLimit(fromUser, `feat_${actionType}`, featureLimit);
        if (!featureAllowed) {
          reply(`🚫 该功能今日额度已用完 (${featureLimit}次)\n但你还可以使用其他功能哦！`);
          return false;
        }
      }
      return true;
    };

    // ==========================================
    // 🕹️ 业务指令路由
    // ==========================================

    // 1. 关注欢迎语 (豁免)
    if (msgType === 'event' && eventType === 'subscribe') {
      const welcomeText = 
        `恭喜！你发现了果粉秘密基地\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=查询TikTok&msgmenuid=1">查询TikTok</a>\n热门地区上架查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
      return reply(welcomeText);
    }

    // 2. MyID (豁免)
    if (content.toLowerCase() === 'myid') {
      if (await checkLimits('myid')) return reply(`你的 OpenID 是：\n${fromUser}`);
    }

    // 3. 付款方式 (豁免 - 静态文本)
    else if (content === '付款方式') {
      if (await checkLimits('static')) {
        // 👇 你可以在这里修改你的付款方式回复
        return reply('💳 付款方式：\n\n我们支持微信支付和支付宝...\n(这里填入你的具体内容)');
      }
    }

    // 4. 切换美国 (豁免 - 静态链接)
    // ⚠️ 如果你的切换功能是给一个链接，那就是静态的，不限制。
    else if (content.startsWith('切换')) {
      if (await checkLimits('switch')) {
        // 👇 假设这是静态回复。如果是动态函数，就把 checkLimits 参数改为 'search' 或其他
        return reply('🇺🇸 切换美区教程：\n\n点击链接自动跳转：\nhttps://itunes.apple.com/us/app/id123456789');
      }
    }

    // 5. 查图标 (限制 3 次)
    else if (content.startsWith('图标')) {
      if (await checkLimits('icon')) {
        const appName = content.replace('图标', '').trim();
        const result = await handlers.lookupAppIcon(appName, fromUser);
        return reply(result);
      }
    }

    // 6. 查价格 / 查询 (限制 10 次)
    // 涵盖了 "查询TikTok" 和 "价格YouTube"
    else if (content.startsWith('价格') || content.startsWith('查询')) {
      if (await checkLimits('search')) { 
        const key = content.replace(/^(价格|查询)/, '').trim();
        const result = await handlers.handlePriceQuery(key, '中国', true);
        return reply(result);
      }
    } 

    // 7. 查榜单 (限制 10 次)
    else if (content.startsWith('榜单')) {
      if (await checkLimits('rank')) {
        // 👇 这里调用你 handlers 里的榜单函数，我先写个占位
        // const result = await handlers.handleCharts(content); 
        return reply('🏆 榜单数据获取中...(请确保handlers里有榜单函数)');
      }
    }

    // 8. 查更新 (限制 15 次)
    else if (content === '更新' || content.toLowerCase() === 'update') {
      if (await checkLimits('update')) {
        const result = await handlers.handleSimpleAllOsUpdates();
        return reply(result);
      }
    } 

    // 9. 兜底 (静默)
    else {
      return res.status(200).send('success');
    }

  } catch (error) {
    console.error('[Error]', error);
    res.status(200).send('success');
  }
};
