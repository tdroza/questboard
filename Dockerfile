FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json server.mjs index.html reset-countdown.js progress-features.js app.js styles.css favicon.svg ./
COPY --chown=node:node test ./test

RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATA_DIR=/data

USER node

EXPOSE 4173
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
