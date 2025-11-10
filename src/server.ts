import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { apiKeyAuthMiddleware } from "./lib/api-key-auth"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes, modelInfoRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(logger())
server.use(cors())

server.use("/chat/completions", apiKeyAuthMiddleware)
server.use("/models", apiKeyAuthMiddleware)
server.use("/embeddings", apiKeyAuthMiddleware)
server.use("/usage", apiKeyAuthMiddleware)
server.use("/token", apiKeyAuthMiddleware)
server.use("/v1/chat/completions", apiKeyAuthMiddleware)
server.use("/v1/models", apiKeyAuthMiddleware)
server.use("/v1/embeddings", apiKeyAuthMiddleware)
server.use("/v1/messages", apiKeyAuthMiddleware)

server.get("/", (c) => c.text("Server running"))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Additional model info routes
server.route("/", modelInfoRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// Compatibility routes for v1 model info
server.route("/v1", modelInfoRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
