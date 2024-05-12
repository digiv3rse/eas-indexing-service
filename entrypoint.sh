#!/bin/sh
set -e

DB_HOST=$(echo $DATABASE_HOST)
DB_USER=$(echo $DATABASE_USER)
DB_PASSWORD=$(echo $DATABASE_PASSWORD)
DB_NAME=$(echo $DATABASE_NAME)


# Wait for PostgreSQL to be available
until PGPASSWORD=$DB_PASSWORD psql -p 5432 -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c '\q'; do
  echo "PostgreSQL not ready, waiting..."
  sleep 2
done

# Run Prisma db push
npx prisma db push

# Run Prisma generate
SKIP_PRISMA_VERSION_CHECK=true npx prisma generate

# Start the application
yarn start
