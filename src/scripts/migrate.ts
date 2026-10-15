import { loadEnvConfig } from "@next/env";
import { closeDb, getDb, PgliteLockedError } from "../lib/db";

// Same .env files as `next dev` / `next start` (.env.local, .env, …); real environment variables win.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main() {
  await getDb();
  console.log("Migrations applied.");
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof PgliteLockedError ? err.message : err);
  process.exit(1);
});
