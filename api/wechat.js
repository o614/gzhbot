const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');
const utils = require('./utils');

// ==========================================
// 🎛️ 配置表
// ==========================================
const LIMIT_CONFIG = {
  // 👑 【必须修改】你的 OpenID
  // 只有这个 ID 发送 "vip add xxx" 才有用
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

// 强行读取 Body
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
    // 1. 微信握手
    if (req.method === 'GET') return res.status(200).send(req.query.echostr);

    // 2. 读取数据
    const rawContent = await getRawBody(req);
    if (!rawContent) return res.status(200).send('success');

    // 3. 解析 XML
    const result = await parseStringPromise(rawContent);
    const xml = result.xml;
    const toUser = xml.ToUserName[0];
    const fromUser = xml.FromUserName[0];
    const msgType = xml.MsgType ? xml.MsgType[0] : '';
    const eventType = xml.Event ? xml.Event[0] : '';
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Msg] User: ${fromUser}, Content: ${content}`);

    // 回复工具
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
      const featureLimit = LIMIT_CONFIG.FEATURES[actionType];
      if (featureLimit === -1) return true; // 豁免

      // 先查大闸
      const globalAllowed = await utils.checkUsageLimit(fromUser, 'global_limit', LIMIT_CONFIG.GLOBAL_DAILY_LIMIT);
      if (!globalAllowed) {
        reply(`🚫 今日总互动已达上限 (${LIMIT_CONFIG.GLOBAL_DAILY_LIMIT}次)。\n成为VIP会员可解除限制。`);
        return false;
      }

      // 再查小闸
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
      if (parts.length === 3) { // vip add openid
        const cmd = parts[1];
        const targetId = parts[2];
        const result = await utils.manageVip(cmd, targetId);
        return reply(result);
      }
    }

    // 1. 关注事件
    if (msgType === 'event' && eventType === 'subscribe') {
      return reply('欢迎关注！\n请点击底部菜单体验功能。\n发送 myid 可查看你的用户ID。');
    }

    // 2. MyID
    if (content.toLowerCase() === 'myid') {
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
        return reply('🇺🇸 切换教程链接：\nhttps://itunes.apple.com/...');
      }
    }

    // 7. 付款方式 (豁免)
    else if (content === '付款方式') {
      if (await checkLimits('static')) {
        return reply('💳 支持微信/支付宝付款...');
      }
    }

    // 8. 兜底
    else {
      return res.status(200).send('success');
    }

  } catch (error) {
    console.error('[Error]', error);
    res.status(200).send('success');
  }
};
