import path from "node:path";
import { openDatabase } from "./db.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH =
  process.env.DB_PATH ?? path.join(process.cwd(), "data", "openstocks.sqlite");

const db = openDatabase(DB_PATH);
const app = createApp(db);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`OpenStocks API listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`SQLite database: ${DB_PATH}`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
