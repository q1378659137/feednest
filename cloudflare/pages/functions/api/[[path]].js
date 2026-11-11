/**
 * Cloudflare Pages Functions 入口：/api/* 全部交给同一套业务逻辑。
 * 静态文件由 Pages 直接托管，同源部署，不需要 CORS。
 */

import { handleApi } from '../../../../serverless/core.js';

export const onRequest = (context) => handleApi(context.request, context.env, context);
