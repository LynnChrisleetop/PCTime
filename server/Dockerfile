FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PCTIME_HOST=0.0.0.0 PCTIME_PORT=4318 PCTIME_DB_PATH=/data/pctime.sqlite
USER node
EXPOSE 4318
VOLUME ["/data"]
CMD ["node", "index.mjs"]
