import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.PORT, env.HOST, () => {
  //   console.log(`Job Rank API is running at http://localhost:${env.PORT}`);
});

function shutDown(signal: string) {
  console.log(`${signal} received. Shutting down safely.`);

  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));
