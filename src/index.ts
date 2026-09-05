import { env } from "./env.js";
import { openDatabase } from "./db.js";
import { createApp } from "./app.js";

const db = openDatabase(env.DB_PATH);
const app = createApp(db);

const server = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`OpenStocks API listening on http://localhost:${env.PORT}`);
  // eslint-disable-next-line no-console
  console.log(`SQLite database: ${env.DB_PATH}`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
