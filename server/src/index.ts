import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { registerRoutes } from "./routes/api.js";
import { startWorker } from "./enrichment/worker.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(registerRoutes);

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) {
      return reply.code(404).send({ error: { category: "not_found", message: "Unknown API route" } });
    }
    return reply.sendFile("index.html");
  });
}

const stopWorker = startWorker();
process.on("SIGTERM", () => { stopWorker(); void app.close(); });

await app.listen({ port: config.PORT, host: "0.0.0.0" });
console.log(`GTM workspace listening on :${config.PORT} — model: ${config.MODEL_API_KEY ? config.MODEL_NAME : "demo (rules-based)"}`);
