import { startApp } from "./app.js";

function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

startApp().catch((error: unknown) => {
  console.error("Failed to start DingTalk Agent gateway.");
  console.error(formatStartupError(error));
  process.exitCode = 1;
});
