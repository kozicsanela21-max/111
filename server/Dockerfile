FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node
ENV NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -qO- --header="X-Qianchuan-Client-Key: $QIANCHUAN_CLIENT_API_KEY" http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "server/index.mjs"]
