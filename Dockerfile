FROM node:22-alpine

RUN apk add --no-cache su-exec tzdata wget \
  && mkdir -p /app/config /app/library /app/log

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY worker.mjs dashboard.html entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENV LIBRARY_PATH=/app/library/ \
    DOWNLOADME_FILEPATH=/app/config/downloadme.txt \
    DONTDOWNLOADME_FILEPATH=/app/config/dontdownloadme.txt \
    ENV_FILE=/app/config/.env \
    STATUS_PORT=8100 \
    NODE_ENV=production

EXPOSE 8100
VOLUME ["/app/config", "/app/library", "/app/log"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8100/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]