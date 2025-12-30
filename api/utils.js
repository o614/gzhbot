const axios = require('axios');
const https = require('https');
const { kv } = require('@vercel/kv'); // 引入数据库
const { ALL_SUPPORTED_REGIONS } = require('./consts');

const HTTP = axios.create({ timeout: 4000 });

// 👇👇👇 核心检查逻辑 (升级版) 👇👇👇
async function checkUsageLimit(openId, action, maxLimit) {
  if (!openId) return true;

  // 1. ✨ 优先检查是否为 VIP
  // 我们约定 VIP 的 Key 格式为: "vip:用户OpenID"
  const isVip = await kv.get(`vip:${openId}`);
  if (isVip) {
    console.log(`[VIP] User ${openId} is VIP. Pass.`);
    return true; // 👑 VIP 直接放行，不扣次数
  }

  // 2. 普通用户检查逻辑 (保持不变)
  const today = new Date().toISOString().split('T')[0];
  const key = `limit:${action}:${today}:${openId}`;

  try {
    const current = await kv.get(key);
    const count = current ? parseInt(current) : 0;
    
    if (count >= maxLimit) return false; // 🚫 拦截

    await kv.incr(key); 
    await kv.expire(key, 86400); 
    return true; 
  } catch (e) {
    console.error('KV Error:', e.message);
    return true; 
  }
}

// 👇👇👇 新增：管理员管理 VIP 的函数 👇👇👇
async function manageVip(command, targetOpenId) {
  const vipKey = `vip:${targetOpenId}`;
  
  if (command === 'add') {
    // 设为 VIP (这里设为永久，也可以设置过期时间)
    await kv.set(vipKey, '1'); 
    return `✅ 成功！用户 \n${targetOpenId}\n 已升级为尊贵的 VIP，无限制使用！`;
  } 
  
  else if (command === 'del') {
    // 取消 VIP
    await kv.del(vipKey);
    return `👋 已取消 \n${targetOpenId}\n 的 VIP 资格。`;
  }
  
  return '指令错误';
}

// ... 下面的 helper 函数保持不变 ...
// (为了篇幅，我这里简写了，请务必保留你原来 utils.js 下面那些 fetchGdmf, getJSON 等所有函数)
// ⚠️ 记得把 manageVip 导出出去！

module.exports = {
  HTTP,
  checkUsageLimit,
  manageVip, // 👈 记得导出这个新函数
  // ... 保留原来的导出 ...
  getCountryCode: (id) => id, 
  getJSON: axios.get,
  isSupportedRegion: () => true,
  pickBestMatch: (q, r) => r[0],
  formatPrice: () => '免费',
  fetchExchangeRate: () => null,
  fetchGdmf: () => null,
  normalizePlatform: (p) => p,
  toBeijingYMD: (d) => d,
  collectReleases: () => [],
  determinePlatformsFromDevices: () => new Set()
};
