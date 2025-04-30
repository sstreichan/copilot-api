FROM oven/bun:alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 bunjs && \
    adduser -S -u 1001 -h /app -G bunjs bunjs

USER bunjs

COPY --chown=bunjs:bunjs package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --chown=bunjs:bunjs --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 4141

CMD ["bun", "dist/main.js", "start"]
