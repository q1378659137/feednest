/**
 * PushPlus（推送加）推送 —— Workers 版，用全局 fetch。
 */

const DEFAULT_URL = 'https://www.pushplus.plus/send';
const MAX_ITEMS_IN_MESSAGE = 10;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function buildMessage(items) {
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

export async function sendPushPlus(token, title, content, url) {
  const res = await fetch(url || DEFAULT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, */*;q=0.5' },
    body: JSON.stringify({ token, title, content, template: 'html' }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!data || data.code !== 200) {
    throw new Error((data && data.msg) || `PushPlus 返回异常（HTTP ${res.status}）`);
  }
  return data;
}

export async function notifyNewItems(db, userId, items, url) {
  if (!items || !items.length) return null;
  const settings = await db.getSettings(userId);
  if (!settings.pushEnabled || !settings.pushToken) return null;
  const { title, content } = buildMessage(items);
  return sendPushPlus(settings.pushToken, title, content, url);
}
