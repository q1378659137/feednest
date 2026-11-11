'use strict';

const { postJson } = require('./net');

// 默认官方接口；可用 PUSHPLUS_URL 指向自建代理（也方便本地测试）
const PUSHPLUS_URL = process.env.PUSHPLUS_URL || 'https://www.pushplus.plus/send';
const MAX_ITEMS_IN_MESSAGE = 10;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 把新文章列表拼成 PushPlus 的 html 模板内容 */
function buildMessage(items) {
  const shown = items.slice(0, MAX_ITEMS_IN_MESSAGE);
  const list = shown
    .map((i) => {
      const link = i.link ? `<a href="${escapeHtml(i.link)}">${escapeHtml(i.title)}</a>` : escapeHtml(i.title);
      const feed = i.feedTitle ? ` <span style="color:#888;font-size:12px">· ${escapeHtml(i.feedTitle)}</span>` : '';
      return `<li style="margin:6px 0">${link}${feed}</li>`;
    })
    .join('');
  const more =
    items.length > shown.length
      ? `<p style="color:#888;font-size:12px">… 另有 ${items.length - shown.length} 篇，请打开 FeedNest 查看</p>`
      : '';
  return {
    title: `FeedNest：${items.length} 篇新文章`,
    content: `<p>发现 ${items.length} 篇新文章：</p><ul style="padding-left:18px">${list}</ul>${more}`,
  };
}

/** 直接调 PushPlus 接口，失败抛错 */
async function sendPushPlus(token, title, content) {
  const { status, data } = await postJson(PUSHPLUS_URL, {
    token,
    title,
    content,
    template: 'html',
  });
  if (!data || data.code !== 200) {
    throw new Error((data && data.msg) || `PushPlus 返回异常（HTTP ${status}）`);
  }
  return data;
}

/** 有更新时按用户设置推送；未启用或没填 token 时直接跳过 */
async function notifyNewItems(db, userId, items) {
  if (!items || !items.length) return null;
  const settings = db.getSettings(userId);
  if (!settings.pushEnabled || !settings.pushToken) return null;
  const { title, content } = buildMessage(items);
  return sendPushPlus(settings.pushToken, title, content);
}

module.exports = { sendPushPlus, notifyNewItems, buildMessage };
