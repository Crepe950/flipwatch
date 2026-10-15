@AGENTS.md

# FlipWatch — project notes

- Stack: Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4 (design tokens in `src/app/globals.css`), Drizzle ORM on Postgres (embedded PGlite when `DATABASE_URL` is unset), vitest.
- Money is integer cents + currency code everywhere; distances are km.
- Library code (`src/lib`, `src/worker`) must not import `next/*` or `server-only` — it also runs in the standalone worker via `tsx`.
- Library functions take `db: Db` as the first argument; only pages, route handlers, server actions and the worker call `getDb()`. Tests use `createTestDb()` (in-memory PGlite; set `FW_TEST_PG=postgres://user@host:port` to run them on real Postgres).
- Embedded PGlite is single-process: a lock file in `PGLITE_DIR` makes a second process (seed, migrate) fail fast, and the standalone worker requires `DATABASE_URL`. Standalone entry points (`src/worker`, `src/scripts`) load `.env*` files with `loadEnvConfig` from `@next/env`.
- Marketplace adapters live in `src/lib/marketplaces/<id>/` with pure parsers tested against fixtures in `test/fixtures/<id>/`. Tests never hit the network.
- Schema changes: edit `src/lib/db/schema.ts`, then `npm run db:generate` to add a migration under `drizzle/`.
- Before committing: `npm run typecheck && npm run lint && npm test`.
