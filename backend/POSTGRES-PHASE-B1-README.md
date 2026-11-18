# OTW Logistics – PostgreSQL Phase B1

## Important status
This ZIP is a staged preparation of the PostgreSQL database layer. The existing
application server and `auth.js` still use SQLite. Do NOT assume that the live
application has switched to PostgreSQL after installing this package.

## Install
From this backend directory:
```cmd
npm install
```

Keep your private existing `.env` file. Add:
```env
DATABASE_URL=your_supabase_postgresql_connection_string
PG_POOL_MAX=10
```

Do not commit or share `.env`.

## Test connection
```cmd
npm run test:postgres
```

## Prepare the authentication schema
Run `postgres-auth-schema.sql` in the Supabase SQL Editor only after confirming
whether the earlier SQLite-to-Supabase migration already created these tables.
The script uses CREATE TABLE IF NOT EXISTS and does not delete rows. If tables
already exist, compare their columns and constraints before running it.

## Not yet converted
- `auth.js` remains SQLite-backed.
- `server.js` still opens `payments.sqlite`.
- Authentication and portal routes are not yet switched to PostgreSQL.
- Other backend modules still use SQLite.

The next integration stage must port auth.js to asynchronous PostgreSQL calls,
then update every server.js caller (`getSession`, `findCandidates`, session
creation/deletion, password reset, admin management, and partner account
operations). It must also migrate portal_data reads/writes and ensure all
authentication routes await database operations. Keep SQLite as the rollback
source until full end-to-end tests pass.
