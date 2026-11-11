FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
