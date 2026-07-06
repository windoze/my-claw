import { loadConfig } from "./config/index.js";
import { StateStore } from "./state/index.js";
import { createLogger } from "./utils/index.js";

const logger = createLogger("app");

/** Starts the gateway after loading and validating runtime configuration. */
export async function startApp(): Promise<void> {
  const config = await loadConfig();
  const stateStore = new StateStore({ logger: createLogger("state") });
  await stateStore.load();

  logger.info(
    `DingTalk Agent gateway starting with ${config.defaultEnvironment.backend} backend.`,
  );
}
