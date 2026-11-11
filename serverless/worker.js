/**
 * Cloudflare Workers 入口。
 * - /api/* 走业务逻辑
 * - 其余请求交给静态资源（assets 绑定）
 * - 定时任务（Cron Trigger）按间隔刷新订阅
 */

import { handleApi, runScheduledRefresh } from './core.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledRefresh(env, ctx));
  },
};
