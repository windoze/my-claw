import { loadConfig } from "./config/index.js";

/** Starts the gateway after loading and validating runtime configuration. */
export async function startApp(): Promise<void> {
  const config = await loadConfig();

  console.log(
    `DingTalk Agent gateway starting with ${config.defaultEnvironment.backend} backend.`,
  );
}
