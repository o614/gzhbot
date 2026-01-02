// api/replies.js

/**
 * 1. 欢迎语配置
 * isFirst: 是否首次关注 (true/false)
 */
function getWelcomeText(isFirst) {
  const prefix = isFirst ? '' : '欢迎回来！';
  
  return `${prefix}恭喜！你发现了果粉秘密基地\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=应用查询&msgmenuid=1">应用查询</a>\n热门应用详情查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单查询&msgmenuid=3">榜单查询</a>\n全球免费付费榜单\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=价格查询&msgmenuid=2">价格查询</a>\n应用价格优惠查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=图标查询&msgmenuid=5">图标查询</a>\n获取官方高清图标\n\n` +
    `更多服务请戳底部菜单栏了解`;
}

/**
 * 2. 关键词自动回复配置
 * 这里的 Key 必须和上面欢迎语里的 msgmenucontent 对应
 */
const KEYWORD_REPLIES = {
  // === 核心引导功能 ===
  '应用查询': '请回复“查询+应用名称”，例如：\n\n查询微信\n查询TikTok\n查询小红书',
  
  '榜单查询': '请回复“榜单+地区”，例如：\n\n榜单美国\n榜单日本\n榜单香港',
  
  '价格查询': '请回复“价格+应用名称”，例如：\n\n价格 YouTube\n价格 Minecraft\n价格 小红书',
  
  '图标查询': '请回复“图标+应用名称”，例如：\n\n图标 QQ\n图标 微信\n图标 TikTok',

  '付款方式': '目前支持支付宝和微信支付，请直接发送“购买”获取链接。',

  // === 扩展自动回复 (你可以在这里随意加) ===
  '客服': '人工客服在线时间：9:00 - 18:00\n有事请直接留言，看到必回。',
  '加群': '请添加小助手微信：ehpass，备注“入群”。'
};

module.exports = {
  getWelcomeText,
  KEYWORD_REPLIES
};
