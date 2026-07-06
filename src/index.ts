import { startApp } from "./app.js";
import { createLogger } from "./utils/index.js";

const logger = createLogger("startup");

startApp().catch((error: unknown) => {
  logger.error("Failed to start DingTalk Agent gateway.", { error });
  process.exitCode = 1;
});
