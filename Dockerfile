FROM oven/bun:alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 bunjs && \
    adduser -S -u 1001 -h /app -G bunjs bunjs && \
    mkdir -p /app/.local/share/copilot-api && \
    chown -R bunjs:bunjs /app/.local

USER bunjs

VOLUME /app/.local/share/copilot-api

COPY --chown=bunjs:bunjs package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --chown=bunjs:bunjs --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 4141
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD [ "bun", "-e", "fetch('http://localhost:4141/health').then(r => process.exit(r.ok ? 0 : 1))" ]

CMD ["bun", "dist/main.js", "start"]
