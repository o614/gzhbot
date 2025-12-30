const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');

module.exports = async (req, res) => {
  try {
    const { body } = req;

    // 🔍 调试日志：看看请求到底是啥样
    console.log(`[Request] Method: ${req.method}, Body Type: ${typeof body}`);
    
    // 1. 如果是 GET 请求 (微信验证)，直接放行
    if (req.method === 'GET') {
      return res.status(200).send(req.query.echostr);
    }

    // 🛡️ 防弹逻辑：如果 Body 是空的，直接返回 success 闭嘴，防止报错崩溃
    if (!body) {
      console.warn('[Warning] 收到空 Body 的 POST 请求，已忽略。');
      return res.status(200).send('success');
    }

    // 2. 解析 XML (加了 try-catch 防止解析失败炸掉)
    let xml;
    try {
      const result = await parseStringPromise(body);
      xml = result.xml;
    } catch (parseError) {
      console.error('[Error] XML 解析失败:', parseError);
      return res.status(200).send('success'); // 解析不了也回 success，防止微信重试
    }

    // 3. 提取信息
    const toUser = xml.ToUserName ? xml.ToUserName[0] : '';
    const fromUser = xml.FromUserName ? xml.FromUserName[0] : '';
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Message] From: ${fromUser}, Content: "${content}"`);

    // 4. 定义回复函数
    const reply = (text) => {
      const now = Math.floor(Date.now() / 1000);
      // 这里的 fromUser 和 toUser 互换位置发送
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

    // 5. 业务逻辑 (记得把 ID 传下去！)
    if (!fromUser) {
      console.warn('[Warning] 居然没有 OpenID？');
      return reply('无法识别用户身份');
    }

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
      // 👇 关键：带着 ID 去查
      const result = await handlers.lookupAppIcon(appName, fromUser);
      return reply(result);
    }
    else {
      return reply('收到！试试发送“图标 微信”？');
    }

  } catch (error) {
    console.error('[Fatal Error] 主程序崩溃:', error);
    // 无论如何都要返回 200，否则微信会以为没发送成功一直重试
    res.status(200).send('success');
  }
};
