import { startApp } from "./app.js";
import type { AppRuntime } from "./app.js";
import { createLogger } from "./utils/index.js";

const logger = createLogger("startup");
const shutdownLogger = createLogger("shutdown");

startApp()
  .then((runtime) => {
    installShutdownHandlers(runtime);
  })
  .catch((error: unknown) => {
    logger.error("Failed to start DingTalk Agent gateway.", { error });
    process.exitCode = 1;
  });

/** Installs process-level shutdown handlers after runtime startup succeeds. */
function installShutdownHandlers(runtime: AppRuntime): void {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode?: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    shutdownLogger.info("Stopping DingTalk Agent gateway.", { reason });
    await runtime.close();
    shutdownLogger.info("DingTalk Agent gateway stopped.", { reason });

    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 143);
  });
  process.once("beforeExit", () => {
    void shutdown("beforeExit");
  });
}
