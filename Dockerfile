# FeedNest —— 自托管 RSS 订阅服务器
FROM node:22-alpine

ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app

ENV NODE_ENV=production \
    PORT=13786 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=${NPM_REGISTRY} && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 13786

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:13786/api/health > /dev/null || exit 1

CMD ["node", "--experimental-sqlite", "server/index.js"]
