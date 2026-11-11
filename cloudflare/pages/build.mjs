/**
 * Pages 构建脚本：把仓库根目录的 public/ 复制到本项目下的 dist/。
 *
 * 为什么需要它：Cloudflare Pages 的 Git 构建要求「构建输出目录」位于项目根目录内，
 * 而前端静态文件放在仓库根目录（Docker 版和 Workers 版共用），所以这里复制一份。
 *
 * 用法：
 *   node build.mjs         # 生成 dist/
 *   npx wrangler pages deploy   # 命令行部署（读取 wrangler.jsonc 里的 pages_build_output_dir）
 */

import { cp, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'public');
const out = join(here, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(src, out, { recursive: true });

console.log(`[build] ${src} -> ${out}`);
