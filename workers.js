/**
 * PM Bot Platform - Isolated Verification Fix
 * * 修复说明：
 * 之前的验证 Key 是 `verified-{uid}` (全局共享)。
 * 现在改为 `verified-{routeId}-{uid}` (每个机器人独立)。
 * 这样新创建的机器人不会继承用户在旧机器人上的验证状态。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. 主机器人 Webhook (平台入口)
    if (url.pathname === '/endpoint') {
      return handleMainBotWebhook(request, env, ctx);
    } 
    // 2. 托管机器人入口 (子机器人)
    else if (url.pathname.startsWith('/entry/')) {
      const routeId = url.pathname.split('/')[2];
      return handleManagedBotWebhook(request, env, ctx, routeId);
    }
    // 3. 注册主机器人 Webhook
    else if (url.pathname === '/registerWebhook') {
      return registerMainWebhook(request, url, env);
    } 
    // 4. 人机验证页面
    else if (url.pathname === '/verify') {
      return handleVerifyPage(url, env);
    } 
    // 5. 人机验证提交接口
    else if (url.pathname === '/verify_submit') {
      return handleVerifySubmit(request, env);
    } 
    else {
      return new Response('PM Bot Platform Running (v3.9 - Isolated Verify)...');
    }
  }
};

// --- 配置区域 ---
const NOTIFY_INTERVAL = 3600 * 1000; 
const fraudDbUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
const DEFAULT_TTL = 30 * 24 * 60 * 60; 

// --- [文案配置] 子机器人管理员使用教程 ---
const OWNER_HELP_TEXT = `
👋 **管理员您好！**

您的私聊机器人正在运行中。

📝 **如何使用？**

1. **接收消息**
   当有人给此机器人发消息时，您会立刻收到转发。

2. **回复用户**
   直接**回复 (左滑消息)** 转发过来的消息，即可发送文字给对方。

3. **管理用户**
   • **屏蔽/解封**：点击消息下方的按钮，或回复 \`/block\` / \`/unblock\`。
   • **查看资料**：点击消息下方的用户昵称。

💡 *提示：所有新用户在第一次联系您时，都需要通过人机验证，有效拦截广告。*
`;

// --- 辅助函数 ---
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function apiUrl(method, token, params = null) {
  let query = params ? '?' + new URLSearchParams(params).toString() : '';
  return `https://api.telegram.org/bot${token}/${method}${query}`;
}

async function requestTelegram(method, token, body) {
  const resp = await fetch(apiUrl(method, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function sendMessage(token, chatId, text, options = {}) {
  return requestTelegram('sendMessage', token, {
    chat_id: chatId,
    text: text,
    ...options
  });
}

// [核心] 自动设置机器人菜单命令
async function setBotCommands(token) {
  return requestTelegram('setMyCommands', token, {
    commands: [
      { command: 'start', description: '开始使用 / 查看教程' }
    ]
  });
}

async function copyMessage(token, toChatId, fromChatId, messageId, options = {}) {
  return requestTelegram('copyMessage', token, {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...options
  });
}

async function forwardMessage(token, toChatId, fromChatId, messageId) {
  return requestTelegram('forwardMessage', token, {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId
  });
}

async function answerCallbackQuery(token, callbackQueryId, text = null, showAlert = false) {
  return requestTelegram('answerCallbackQuery', token, {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  });
}

async function editMessageText(token, chatId, messageId, text, options = {}) {
  return requestTelegram('editMessageText', token, {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    ...options
  });
}

// ==================================================
// 1. 主机器人逻辑 (平台入口)
// ==================================================

async function handleMainBotWebhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.ENV_BOT_SECRET) {
    return new Response('Unauthorized', { status: 403 });
  }
  
  const update = await request.json();
  const MAIN_TOKEN = env.ENV_BOT_TOKEN;
  const ADMIN_ID = env.ENV_ADMIN_UID; 

  // --- 处理回调查询 ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data;
    const chatId = cq.message.chat.id;

    if (chatId.toString() !== ADMIN_ID) {
        await answerCallbackQuery(MAIN_TOKEN, cq.id, "无权操作", true);
        return new Response('Ok');
    }

    let platformConfig = await env.PMBOT.get('platform:settings', { type: 'json' }) || {
        enable_new_users: true,
        verify_ttl: DEFAULT_TTL
    };

    if (data === 'admin_toggle_access') {
        platformConfig.enable_new_users = !platformConfig.enable_new_users;
        await env.PMBOT.put('platform:settings', JSON.stringify(platformConfig));
        const dashboard = await getAdminDashboardUI(platformConfig, env);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, dashboard.text, { parse_mode: 'Markdown', reply_markup: dashboard.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id, `新接入已${platformConfig.enable_new_users ? '开启' : '关闭'}`);
    }
    else if (data === 'admin_ttl_menu') {
        const ttlMenu = getTTLMenuUI(platformConfig.verify_ttl); 
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, ttlMenu.text, { parse_mode: 'Markdown', reply_markup: ttlMenu.markup });
    }
    else if (data.startsWith('admin_set_ttl_')) {
        const days = parseInt(data.split('_')[3]);
        platformConfig.verify_ttl = days * 24 * 60 * 60;
        await env.PMBOT.put('platform:settings', JSON.stringify(platformConfig));
        await answerCallbackQuery(MAIN_TOKEN, cq.id, "设置已更新");
        const dashboard = await getAdminDashboardUI(platformConfig, env);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, dashboard.text, { parse_mode: 'Markdown', reply_markup: dashboard.markup });
    }
    else if (data === 'admin_refresh') {
        const dashboard = await getAdminDashboardUI(platformConfig, env);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, dashboard.text, { parse_mode: 'Markdown', reply_markup: dashboard.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id, "已刷新");
    }

    return new Response('Ok');
  }

  // --- 处理消息 ---
  if (!update.message) return new Response('Ok');
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text === '/start') {
      if (chatId.toString() === ADMIN_ID) {
          let platformConfig = await env.PMBOT.get('platform:settings', { type: 'json' }) || {
            enable_new_users: true,
            verify_ttl: DEFAULT_TTL
          };
          const dashboard = await getAdminDashboardUI(platformConfig, env);
          await sendMessage(MAIN_TOKEN, chatId, dashboard.text, { 
              parse_mode: 'Markdown',
              reply_markup: dashboard.markup
          });
      } else {
          const welcomeMsg = `
🤖 **欢迎使用 PM 机器人托管平台**

在这里，您可以免费创建一个功能强大的**私聊转发机器人**。
它能帮您接收陌生人的消息，隐藏您的真实身份，并自动拦截垃圾广告。

🌟 **核心功能：**
• **智能验证**：自动拦截机器人和广告骚扰。
• **隐私回复**：直接回复消息，对方看不到您的账号。
• **一键管理**：消息下方自带屏蔽/解封按钮。
• **数据统计**：查看有多少人联系过您。

🚀 **如何开始？**
只需将您的 **Bot Token** 发送给我即可。
*(如果您还没有 Token，请先找 @BotFather 申请一个)*
          `;
          await sendMessage(MAIN_TOKEN, chatId, welcomeMsg, { parse_mode: 'Markdown' });
      }
      return new Response('Ok');
  }

  if (/^\d+:[A-Za-z0-9_-]{35,}$/.test(text.trim())) {
    const platformConfig = await env.PMBOT.get('platform:settings', { type: 'json' }) || { enable_new_users: true };
    
    if (!platformConfig.enable_new_users && chatId.toString() !== ADMIN_ID) {
        await sendMessage(MAIN_TOKEN, chatId, '⛔️ **平台维护中**\n\n管理员已暂时关闭新机器人接入，请稍后再试。', { parse_mode: 'Markdown' });
        return new Response('Ok');
    }

    const userToken = text.trim();
    await sendMessage(MAIN_TOKEN, chatId, '⏳ 正在验证 Token 并部署环境，请稍候...');

    const verifyResp = await fetch(apiUrl('getMe', userToken)).then(r => r.json());
    if (!verifyResp.ok) {
      await sendMessage(MAIN_TOKEN, chatId, '❌ **Token 无效**\n请检查是否复制完整。', { parse_mode: 'Markdown' });
      return new Response('Ok');
    }
    
    const botUsername = verifyResp.result.username;
    let routeId = uuidv4();
    const workerOrigin = new URL(request.url).origin;
    const webhookUrl = `${workerOrigin}/entry/${routeId}`;
    const secret = uuidv4();

    const setHookResp = await fetch(apiUrl('setWebhook', userToken, { 
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: JSON.stringify(["message", "callback_query"]) 
    })).then(r => r.json());

    if (!setHookResp.ok) {
      await sendMessage(MAIN_TOKEN, chatId, `❌ **部署失败**: ${setHookResp.description}`);
      return new Response('Ok');
    }
    
    // [自动设置菜单]
    await setBotCommands(userToken);

    const botConfig = {
      token: userToken,
      owner_id: chatId,
      secret: secret,
      bot_username: botUsername,
      created_at: Date.now(),
      enable_verify: true 
    };

    await env.PMBOT.put(`platform:route:${routeId}`, JSON.stringify(botConfig));
    await env.PMBOT.put(`platform:user:${chatId}`, JSON.stringify({ ...botConfig, routeId }));
    
    const totalBotsKey = 'stats:platform:total_bots';
    ctx.waitUntil((async () => {
        let currentTotal = await env.PMBOT.get(totalBotsKey) || 0;
        await env.PMBOT.put(totalBotsKey, parseInt(currentTotal) + 1);
    })());

    const safeBotUsername = botUsername.replace(/_/g, '\\_');

    const successMsg = `
✅ **部署成功！**

您的私聊机器人已就绪：@${safeBotUsername}

👉 **下一步**：
请直接前往您的机器人，点击左下角 **菜单** 或发送 **/start** 开始使用。
    `;
    await sendMessage(MAIN_TOKEN, chatId, successMsg, { parse_mode: 'Markdown' });

    // [自动发送欢迎语]
    try {
        await sendMessage(userToken, chatId, OWNER_HELP_TEXT, { parse_mode: 'Markdown' });
    } catch (e) {
        // 忽略首次发送可能失败的情况
    }

    return new Response('Ok');
  }

  return new Response('Ok');
}

// ==================================================
// 2. 托管机器人逻辑 (Bot Owner & Guest)
// ==================================================

async function handleManagedBotWebhook(request, env, ctx, routeId) {
  const configStr = await env.PMBOT.get(`platform:route:${routeId}`);
  if (!configStr) return new Response('Bot not found', { status: 404 });
  
  let config = JSON.parse(configStr);
  if (typeof config.enable_verify === 'undefined') config.enable_verify = true;

  const update = await request.json();
  const TOKEN = config.token;
  const OWNER_ID = config.owner_id.toString();

  // --- 处理回调查询 ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data;
    const chatId = cq.message.chat.id;

    if (chatId.toString() !== OWNER_ID) {
        await answerCallbackQuery(TOKEN, cq.id, "无权操作", true);
        return new Response('Ok');
    }

    if (data.startsWith('block_')) {
        const targetId = data.split('_')[1];
        await env.PMBOT.put(`isblocked-${targetId}`, true);
        await answerCallbackQuery(TOKEN, cq.id, `🚫 用户 ${targetId} 已屏蔽`, true);
    }
    else if (data.startsWith('unblock_')) {
        const targetId = data.split('_')[1];
        await env.PMBOT.put(`isblocked-${targetId}`, false);
        await answerCallbackQuery(TOKEN, cq.id, `✅ 用户 ${targetId} 已解封`, true);
    }
    else if (data === 'reply_placeholder') {
        await answerCallbackQuery(TOKEN, cq.id);
    }
    
    return new Response('Ok');
  }

  // --- 处理普通消息 ---
  if (!update.message) return new Response('Ok');
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // === A. 机器人管理员 (Bot Owner) ===
  if (chatId.toString() === OWNER_ID) {
    // 回复消息逻辑
    if (msg.reply_to_message) {
      const mappingKey = `msg-map-${msg.reply_to_message.message_id}`;
      const guestChatId = await env.PMBOT.get(mappingKey, { type: "json" });

      if (guestChatId) {
        if (text.startsWith('/block')) {
           await env.PMBOT.put(`isblocked-${guestChatId}`, true);
           await sendMessage(TOKEN, OWNER_ID, `🚫 已屏蔽用户 ${guestChatId}`);
           return new Response('Ok');
        }
        if (text.startsWith('/unblock')) {
           await env.PMBOT.put(`isblocked-${guestChatId}`, false);
           await sendMessage(TOKEN, OWNER_ID, `✅ 已解除屏蔽 ${guestChatId}`);
           return new Response('Ok');
        }

        await copyMessage(TOKEN, guestChatId, chatId, msg.message_id);
        return new Response('Ok');
      }
    }
    
    // 使用教程
    if (text === '/start') {
        await sendMessage(TOKEN, chatId, OWNER_HELP_TEXT, { parse_mode: 'Markdown' });
        // [静默修复] 每次管理员 /start 时，尝试设置一次菜单，确保旧机器人也有菜单
        ctx.waitUntil(setBotCommands(TOKEN));
    }
    return new Response('Ok');
  }

  // === B. 普通访客 (Guest) ===
  const isBlocked = await env.PMBOT.get(`isblocked-${chatId}`, { type: "json" });
  if (isBlocked) {
    await sendMessage(TOKEN, chatId, '🚫 **您已被管理员屏蔽**', { parse_mode: 'Markdown' });
    return new Response('Ok');
  }

  if (text === '/start') {
    const statsKey = `stats:${routeId}:users`;
    ctx.waitUntil((async () => {
        let count = await env.PMBOT.get(statsKey) || 0;
        await env.PMBOT.put(statsKey, parseInt(count) + 1);
    })());

    const welcome = config.welcome_msg || `
👋 **您好！这里是私聊机器人**

如果您有任何事，请直接发送消息。
我会收到并尽快回复。

⚠️ *请注意：所有消息均会被记录，请勿发送垃圾广告。*
    `;
    await sendMessage(TOKEN, chatId, welcome, { parse_mode: 'Markdown' });
    return new Response('Ok');
  }

  if (config.enable_verify) {
      // [Fix] 验证状态 Key 增加 routeId 前缀，实现多机器人隔离
      const isVerified = await env.PMBOT.get(`verified-${routeId}-${chatId}`, { type: "json" });
      
      if (!isVerified) {
        const workerOrigin = new URL(request.url).origin;
        const firstName = msg.from.first_name || 'User';
        const username = msg.from.username ? `(@${msg.from.username})` : '';
        const verifyLink = `${workerOrigin}/verify?uid=${chatId}&routeId=${routeId}&name=${encodeURIComponent(firstName)}&user=${encodeURIComponent(username)}`;

        await sendMessage(TOKEN, chatId, '🛡 <b>安全验证 (Security Check)</b>\n\n为了防止垃圾信息，请点击下方按钮进行验证。\nPlease verify you are human to continue.', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[ { text: "🤖 点击验证 (Verify)", web_app: { url: verifyLink } } ]]
            }
        });
        return new Response('Ok');
      }
  }

  const userDisplayName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'User';
  const profileLink = `tg://user?id=${chatId}`;
  
  const copyResp = await copyMessage(TOKEN, OWNER_ID, chatId, msg.message_id, {
      reply_markup: {
          inline_keyboard: [
              [
                  { text: `👤 ${userDisplayName}`, url: profileLink },
                  { text: `🆔 ${chatId}`, callback_data: 'reply_placeholder' }
              ],
              [
                  { text: "🚫 屏蔽", callback_data: `block_${chatId}` },
                  { text: "✅ 解封", callback_data: `unblock_${chatId}` }
              ]
          ]
      }
  });
  
  if (copyResp.ok) {
    const statsKey = `stats:${routeId}:msgs`;
    ctx.waitUntil((async () => {
        let count = await env.PMBOT.get(statsKey) || 0;
        await env.PMBOT.put(statsKey, parseInt(count) + 1);
    })());

    const mappingKey = `msg-map-${copyResp.result.message_id}`;
    await env.PMBOT.put(mappingKey, chatId, { expirationTtl: 60 * 60 * 48 });
    
    if (await isFraud(chatId)) {
        await sendMessage(TOKEN, OWNER_ID, `⚠️ **警报**：检测到发送者 UID ${chatId} 在诈骗黑名单中！`, { parse_mode: 'Markdown' });
    }
  }

  return new Response('Ok');
}

// --- 辅助：平台管理员面板 ---
async function getAdminDashboardUI(platformConfig, env) {
    const totalBots = await env.PMBOT.get('stats:platform:total_bots') || '0';
    const ttlDays = Math.round(platformConfig.verify_ttl / (24 * 3600));
    const ttlText = ttlDays > 365 ? '永久' : `${ttlDays}天`;

    const text = `
🎛 **平台管理后台 (超级管理员)**

📊 **平台数据**:
• 累计托管机器人: ${totalBots}

🔧 **全局设置**:
• 新用户接入: ${platformConfig.enable_new_users ? '✅ 允许' : '⛔️ 禁止'}
• 验证有效期: ${ttlText} (全局默认)

请选择操作：
    `;
    const markup = {
        inline_keyboard: [
            [
                { text: `${platformConfig.enable_new_users ? '⛔️ 停止接入' : '🟢 开放接入'}`, callback_data: 'admin_toggle_access' }
            ],
            [
                { text: `⏳ 设置有效期 (${ttlText})`, callback_data: 'admin_ttl_menu' }
            ],
            [
                { text: "🔄 刷新面板", callback_data: 'admin_refresh' }
            ]
        ]
    };
    return { text, markup };
}

// --- 辅助：TTL 菜单 ---
function getTTLMenuUI(currentSeconds) {
    const currentDays = Math.round(currentSeconds / 86400);
    const prefix = 'admin'; 
    const text = `
⏳ **设置默认验证有效期**

用户通过验证后，多久需要重新验证？
当前：**${currentDays > 365 ? '永久' : currentDays + ' 天'}**
    `;
    const markup = {
        inline_keyboard: [
            [{ text: "1 天", callback_data: `${prefix}_set_ttl_1` }, { text: "7 天", callback_data: `${prefix}_set_ttl_7` }],
            [{ text: "30 天", callback_data: `${prefix}_set_ttl_30` }, { text: "永久", callback_data: `${prefix}_set_ttl_365` }],
            [{ text: "🔙 返回", callback_data: 'admin_refresh' }]
        ]
    };
    return { text, markup };
}

// ==========================================
// 3. 人机验证页面
// ==========================================

function handleVerifyPage(url, env) {
  const uid = url.searchParams.get('uid');
  const name = url.searchParams.get('name') || 'User';
  const user = url.searchParams.get('user') || '';
  const SITE_KEY = env.ENV_TURNSTILE_SITE_KEY;

  if (!uid) return new Response('Missing UID', { status: 400 });

  const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Human Verification</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
        <style>
            :root { --bg-color: #f0f2f5; --text-color: #333; --primary: #3b82f6; }
            body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: var(--bg-color); color: var(--text-color); }
            .container { width: 100%; max-width: 400px; padding: 20px; text-align: center; }
            .icon-wrapper { background: var(--primary); width: 64px; height: 64px; border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3); }
            .icon-wrapper svg { width: 32px; height: 32px; color: white; }
            h1 { font-size: 22px; margin-bottom: 8px; }
            .user-info { font-size: 14px; color: #666; margin-bottom: 24px; }
            .turnstile-wrapper { background: white; padding: 4px; border-radius: 8px; display: inline-block; margin-bottom: 20px; }
            .footer { margin-top: 40px; font-size: 12px; color: #999; display: flex; align-items: center; justify-content: center; gap: 5px; }
            .footer svg { width: 12px; height: 12px; fill: currentColor; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="icon-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.516 2.17a.75.75 0 00-1.032 0 11.209 11.209 0 01-7.877 3.08.75.75 0 00-.722.515A12.74 12.74 0 002.25 9.75c0 5.942 4.064 10.933 9.563 12.348a.749.749 0 00.374 0c5.499-1.415 9.563-6.406 9.563-12.348 0-1.39-.223-2.73-.635-3.985a.75.75 0 00-.722-.516l-.143.001c-2.996 0-5.717-1.17-7.734-3.08zm3.094 8.016a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z" clip-rule="evenodd" /></svg>
            </div>
            <h1>人机验证</h1>
            <div class="user-info">当前 Telegram 用户：<b>${name} ${user}</b></div>
            <form id="verifyForm">
                <div class="turnstile-wrapper">
                    <div class="cf-turnstile" data-sitekey="${SITE_KEY}" data-callback="onSuccess" data-language="zh-CN"></div>
                </div>
            </form>
            <div id="msg" style="color: #666; font-size: 14px;">请点击上方框体验证...</div>
            <div class="footer">
                <svg viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2zm0 3.45l8.27 14.3H3.73L12 5.45z"/></svg> 
                Secured by Cloudflare
            </div>
        </div>
        <script>
            window.Telegram.WebApp.ready();
            window.Telegram.WebApp.expand();
            function onSuccess(token) {
                const msg = document.getElementById('msg');
                msg.textContent = '正在提交验证...';
                
                const formData = new FormData();
                formData.append('cf-turnstile-response', token);
                const urlParams = new URLSearchParams(window.location.search);
                formData.append('uid', urlParams.get('uid'));
                formData.append('routeId', urlParams.get('routeId') || '');

                fetch('/verify_submit', { method: 'POST', body: formData })
                .then(r => r.json())
                .then(data => {
                    if(data.success) {
                        msg.textContent = '✅ 验证成功！';
                        msg.style.color = 'green';
                        window.Telegram.WebApp.close();
                    } else {
                        msg.textContent = '❌ 验证失败，请重试';
                        msg.style.color = 'red';
                        setTimeout(() => location.reload(), 1500);
                    }
                });
            }
        </script>
    </body>
    </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

async function handleVerifySubmit(request, env) {
  const formData = await request.formData();
  const token = formData.get('cf-turnstile-response');
  const uid = formData.get('uid');
  const routeId = formData.get('routeId'); // [Fix] 获取 routeId
  const ip = request.headers.get('CF-Connecting-IP');
  const SECRET_KEY = env.ENV_TURNSTILE_SECRET_KEY;

  if (!token || !uid) return new Response(JSON.stringify({ success: false }), { headers: { 'Content-Type': 'application/json' } });

  const tr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET_KEY, response: token, remoteip: ip })
  }).then(r => r.json());

  if (tr.success) {
    let ttl = DEFAULT_TTL;
    let tokenToSend = null;

    if (routeId) {
        const platformSettings = await env.PMBOT.get('platform:settings', { type: 'json' });
        if (platformSettings && platformSettings.verify_ttl) {
            ttl = platformSettings.verify_ttl;
        }

        const configStr = await env.PMBOT.get(`platform:route:${routeId}`);
        if (configStr) {
            const config = JSON.parse(configStr);
            tokenToSend = config.token;
        }
        
        // [Fix] 使用带 routeId 的 Key，实现隔离验证
        await env.PMBOT.put(`verified-${routeId}-${uid}`, "true", { expirationTtl: ttl });
    } else {
        // [Fallback] 如果没有 routeId (理论上不应发生)，使用旧 Key 格式
        await env.PMBOT.put(`verified-${uid}`, "true", { expirationTtl: ttl });
    }
    
    if (tokenToSend) {
        // [保持优化] 提示用户稍等
        await sendMessage(tokenToSend, uid, '✅ **验证成功！**\n\n系统正在同步数据，请稍等 **5秒** 后再发送消息。\n_(若消息发送失败，请等待几秒后重试)_', { parse_mode: 'Markdown' });
    }

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } else {
    return new Response(JSON.stringify({ success: false }), { headers: { 'Content-Type': 'application/json' } });
  }
}

// 5. 注册主 Webhook
async function registerMainWebhook(request, url, env) {
  const webhookUrl = `${url.origin}/endpoint`;
  const r = await requestTelegram('setWebhook', env.ENV_BOT_TOKEN, { url: webhookUrl, secret_token: env.ENV_BOT_SECRET });
  return new Response(JSON.stringify(r, null, 2));
}

async function isFraud(id) {
  try {
    const db = await fetch(fraudDbUrl).then(r => r.text());
    return db.includes(id.toString());
  } catch { return false; }
}
