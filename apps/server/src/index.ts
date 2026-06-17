import { getConfig } from "./config.js";
import { buildServer } from "./app.js";

const config = getConfig();
const app = buildServer(config);

try {
  await app.listen({ port: config.port, host: config.bindHost });
  app.log.info(`SecOps Agent API listening on ${config.bindHost}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
