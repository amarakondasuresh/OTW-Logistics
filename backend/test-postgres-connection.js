import "dotenv/config";
import { checkPostgresConnection, closePostgres } from "./postgres-db.js";

try {
  const info = await checkPostgresConnection();
  console.log("PostgreSQL connection successful.");
  console.log({
    database: info.database,
    connected_user: info.connected_user,
    server_time: info.server_time,
  });
} catch (error) {
  console.error("PostgreSQL connection failed:", error.message);
  process.exitCode = 1;
} finally {
  await closePostgres();
}
