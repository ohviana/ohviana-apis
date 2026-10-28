#!/bin/sh
# Vercel build for the API service (see vercel.json). Production deploys migrate the database
# first, through the session pooler: the transaction pooler in DATABASE_URL can't run them.
# Migrations are additive, so the live version keeps working if this deploy fails later.
set -e
npm run build
if [ "$VERCEL_ENV" = production ]; then
  : "${MIGRATE_DATABASE_URL:?Set MIGRATE_DATABASE_URL (Supabase session pooler, port 5432)}"
  cd ../.. && DATABASE_URL="$MIGRATE_DATABASE_URL" npm run db:migrate
fi
