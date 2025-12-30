const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');

// 👇 新增：专门用来强行读取 XML 原始数据的函数
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    // 1. 如果 Vercel 已经解析了（比如是 Buffer），直接转字符串
    if (req.body) {
      if (typeof req.body === 'string') return resolve(req.body);
      if (Buffer.isBuffer(req.body)) return resolve(req.body.toString());
      // 奇怪的情况，可能是 JSON 对象，转回字符串
      return resolve(JSON.stringify(req.body));
    }

    // 2. 如果 body 是空的，说明需要手动读取流
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

module.exports = async (req, res) => {
  try {
    // 1. 微信验证 (GET)
    if (req.method === 'GET') {
      return res.status(200).send(req.query.echostr);
    }

    // 2. 👇 关键修改：手动读取 XML 内容
    const rawContent = await getRawBody(req);
    
    // 🔍 打印日志：让我看看这次能不能拿到数据
    console.log(`[Request] Raw Body Length: ${rawContent ? rawContent.length : 0}`);
    
    if (!rawContent) {
      console.warn('[Warning] 确实读不到数据，跳过。');
      return res.status(200).send('success');
    }

    // 3. 解析 XML
    const result = await parseStringPromise(rawContent);
    const xml = result.xml;

    const toUser = xml.ToUserName[0];
    const fromUser = xml.FromUserName[0]; // 用户 OpenID
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Message] User: ${fromUser}, Content: ${content}`);

    // 4. 定义回复
    const reply = (text) => {
      const now = Math.floor(Date.now() / 1000);
      const xmlResponse = `
        <xml>
          <ToUserName><![CDATA[${fromUser}]]></ToUserName>
          <FromUserName><![CDATA[${toUser}]]></FromUserName>
          <CreateTime>${now}</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[${text}]]></Content>
        </xml>
      `;
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(xmlResponse);
    };

    // 5. 业务逻辑 (把 fromUser 传下去!)
    if (content === '更新' || content.toLowerCase() === 'update') {
      const result = await handlers.handleSimpleAllOsUpdates();
      return reply(result);
    } 
    else if (content.startsWith('价格')) {
      const key = content.replace('价格', '').trim();
      const result = await handlers.handlePriceQuery(key, '中国', true);
      return reply(result);
    } 
    else if (content.startsWith('图标')) {
      const appName = content.replace('图标', '').trim();
      // 👇 带着 ID 去查
      const result = await handlers.lookupAppIcon(appName, fromUser);
      return reply(result);
    }
    else {
      return reply('收到！试试发送“图标 微信”？');
    }

  } catch (error) {
    console.error('[Error] 处理失败:', error);
    res.status(200).send('success');
  }
};
