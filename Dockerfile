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
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/assets ./assets
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
COPY src/db/migrations ./src/db/migrations
# The Android artifact directory is a volume/bind mount (see docker-compose.yml).
# The API reports "not_built" when no Gradle-built APK is present and never
# fabricates one.
RUN mkdir -p /app/data /app/storage /app/data/backups /app/releases && chown -R node:node /app
USER node
VOLUME ["/app/data", "/app/storage", "/app/releases"]
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4100/health || exit 1
CMD ["node", "dist/server.js"]
