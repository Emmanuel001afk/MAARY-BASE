FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY assets ./assets
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4100
WORKDIR /app
COPY --from=build /app/package.json ./
RUN npm install --omit=dev
COPY --from=build /app/assets ./assets
COPY --from=build /app/public ./public
COPY --from=build /app/releases ./releases
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./dist/db/migrations
COPY --from=build /app/src/db/migrations ./src/db/migrations
RUN mkdir -p /app/data /app/storage /app/data/backups /app/releases && chown -R node:node /app
USER node
VOLUME ["/app/data", "/app/storage"]
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4100/health || exit 1
CMD ["node", "dist/server.js"]
