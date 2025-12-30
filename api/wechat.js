const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');
const utils = require('./utils');

// ==========================================
// 🎛️ 配置表
// ==========================================
const LIMIT_CONFIG = {
  // 👑 你的 OpenID (超级管理员)
  ADMIN_OPENID: 'o4UNGw6r9OL9q_4jRAfed_jnvXh8', 

  // 全局限制
  GLOBAL_DAILY_LIMIT: 30, 

  // 功能限制
  FEATURES: {
    'icon': 3,     // 图标
    'search': 10,  // 查询/价格
    'rank': 10,    // 榜单
    'update': 15,  // 更新
    'switch': -1,  // 豁免
    'static': -1,  // 豁免
    'myid': -1     // 豁免
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

    // 🚦 拦截检查器
    const checkLimits = async (actionType) => {
      // 👇👇👇【核心修改】超级管理员直接无敌，跳过所有检查 👇👇👇
      if (fromUser === LIMIT_CONFIG.ADMIN_OPENID) {
        console.log(`[Admin] 管理员 ${fromUser} 驾到，统统闪开！`);
        return true; 
      }

      const featureLimit = LIMIT_CONFIG.FEATURES[actionType];
      if (featureLimit === -1) return true; // 豁免功能

      // 查大闸
      const globalAllowed = await utils.checkUsageLimit(fromUser, 'global_limit', LIMIT_CONFIG.GLOBAL_DAILY_LIMIT);
      if (!globalAllowed) {
        reply(`🚫 今日总互动已达上限 (${LIMIT_CONFIG.GLOBAL_DAILY_LIMIT}次)。\n成为VIP会员可解除限制。`);
        return false;
      }

      // 查小闸
      if (featureLimit > 0) {
        const featureAllowed = await utils.checkUsageLimit(fromUser, `feat_${actionType}`, featureLimit);
        if (!featureAllowed) {
          reply(`🚫 该功能今日额度已用完 (${featureLimit}次)。`);
          return false;
        }
      }
      return true;
    };

    // ==========================================
    // 🎮 路由逻辑
    // ==========================================

    // 👮‍♂️ 管理员指令 (VIP 管理)
    if (fromUser === LIMIT_CONFIG.ADMIN_OPENID && content.toLowerCase().startsWith('vip')) {
      const parts = content.split(' ');
      if (parts.length === 3) { 
        const cmd = parts[1];
        const targetId = parts[2];
        const result = await utils.manageVip(cmd, targetId);
        return reply(result);
      }
    }

    // 1. 关注事件
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

    // 2. MyID
    if (content.toLowerCase() === 'myid') {
      // 这里的 checkLimits('myid') 现在对你会直接返回 true
      if (await checkLimits('myid')) return reply(`你的 OpenID 是：\n${fromUser}`);
    }

    // 3. 查价格 / 查询
    else if (content.startsWith('价格') || content.startsWith('查询')) {
      if (await checkLimits('search')) {
        const key = content.replace(/^(价格|查询)/, '').trim();
        const result = await handlers.handlePriceQuery(key, '中国', true);
        return reply(result);
      }
    }

    // 4. 查图标
    else if (content.startsWith('图标')) {
      if (await checkLimits('icon')) {
        const appName = content.replace('图标', '').trim();
        const result = await handlers.lookupAppIcon(appName, fromUser);
        return reply(result);
      }
    }

    // 5. 查更新
    else if (content === '更新' || content.toLowerCase() === 'update') {
      if (await checkLimits('update')) {
        const result = await handlers.handleSimpleAllOsUpdates();
        return reply(result);
      }
    }
    
    // 6. 切换 (豁免)
    else if (content.startsWith('切换')) {
      if (await checkLimits('switch')) {
        return reply('🇺🇸 切换教程链接：\n(这里填链接)');
      }
    }

    // 7. 付款方式 (豁免)
    else if (content === '付款方式') {
      if (await checkLimits('static')) {
        return reply('💳 支持微信/支付宝付款...');
      }
    }

    // 8. 榜单
    else if (content.startsWith('榜单')) {
      if (await checkLimits('rank')) {
         return reply('🏆 榜单功能 (请对接handlers)...');
      }
    }

    // 9. 兜底
    else {
      return res.status(200).send('success');
    }

  } catch (error) {
    console.error('[Error]', error);
    res.status(200).send('success');
  }
};
