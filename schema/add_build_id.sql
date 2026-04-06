-- Migration: add build_id to projects and build_events
-- Run once on existing databases:
--   Local:  npm run db:migrate:local -- --file=./schema/add_build_id.sql
--   Remote: npx wrangler d1 execute platform-db --remote --file=./schema/add_build_id.sql

ALTER TABLE projects ADD COLUMN build_id TEXT;
ALTER TABLE build_events ADD COLUMN build_id TEXT;
