FROM oven/bun:alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:linux

FROM alpine:latest AS runner
WORKDIR /app

RUN apk add --no-cache libstdc++ libgcc wget && \
    addgroup -g 1001 bunjs && \
    adduser -S -u 1001 -h /app -G bunjs bunjs && \
    mkdir -p /app/.local/share/copilot-api && \
    chown -R bunjs:bunjs /app/.local

USER bunjs

VOLUME /app/.local/share/copilot-api

COPY --chown=bunjs:bunjs --from=builder /app/copilot-api /app/copilot-api

ENV NODE_ENV=production

EXPOSE 4141
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD wget --quiet --spider http://localhost:4141/health || exit 1

CMD ["/app/copilot-api", "start"]
