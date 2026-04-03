# Cloudflare AI App Builder

A Lovable-style AI app generator running entirely on Cloudflare. Describe an app in chat and the platform generates and deploys a full-stack app — frontend, Worker backend, D1 database, and auth — in minutes.

## How it works

1. Describe your app in the chat prompt
2. The AI agent (Claude Sonnet) generates three files: `worker.js`, `index.html`, and `migration.sql`
3. Files are stored in R2 and deployed as a live Cloudflare Worker via Workers for Platforms
4. Iterate by chatting — the agent reads the existing files, patches what changed, and redeploys
5. Deploy when ready using the Deploy button in the preview header

## What the agent can build

- CRUD apps with user auth (register, login, JWT sessions)
- Multi-table relational data models (D1/SQLite)
- Dashboards, trackers, admin panels, booking systems
- Apps with multiple views and client-side routing
- External API integrations (proxied through the Worker)
- File storage via R2

Generated apps use: Preact + htm + Tailwind CSS (CDN) on the frontend, Cloudflare Workers + D1 + R2 on the backend. No npm dependencies — everything runs natively on the edge.

## Platform architecture

- **Builder UI** — served at `/`, single-page app with sidebar chat and preview iframe
- **Platform Worker (Hono)** — API routes for auth, chat, projects, and build pipeline
- **Claude Agent loop** — `claude-sonnet-4-6` with tool use: reads/writes files to R2, triggers deploy
- **Cloudflare Workflows** — durable build pipeline with retries; survives timeouts
- **Workers for Platforms** — each generated app is its own Worker in a dispatch namespace
- **Per-app resources** — each project gets a dedicated D1 database and a shared R2 bucket for code storage
- **SSE build events** — real-time progress stream from agent to UI during builds

## API routes

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/change-password`

### Projects
- `GET /api/projects` — list user's projects
- `POST /api/projects` — create project (AI-generates name from description)
- `GET /api/projects/:id` — get project
- `POST /api/projects/:id/build` — trigger build workflow
- `GET /api/projects/:id/stream` — SSE stream of build events
- `GET /api/projects/:id/events` — poll build events
- `GET /api/projects/:id/files` — list R2 files for project
- `DELETE /api/projects/:id` — delete project and all resources

### Chat
- `POST /api/chat` — send message, triggers agent workflow
- `GET /api/chat/:projectId/history` — fetch message history

### Generated apps
- `GET /apps/:projectId/*` — dispatches to the project's deployed Worker

## Prerequisites

- Node 18+
- Cloudflare account (paid plan required for Workers for Platforms)
- Wrangler CLI (`npm install -g wrangler`)
- Anthropic API key

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create Cloudflare resources**

   - **D1 (platform DB)**
     ```bash
     npx wrangler d1 create platform-db
     ```
     Copy the `database_id` into `wrangler.toml` under `[[d1_databases]]`.

   - **R2 bucket**
     ```bash
     npx wrangler r2 bucket create user-code
     ```

   - **KV namespace**
     ```bash
     npx wrangler kv namespace create SESSIONS
     ```
     Copy the `id` into `wrangler.toml` under `[[kv_namespaces]]`.

   - **Dispatch namespace**
     In the Cloudflare dashboard: Workers for Platforms → Create dispatch namespace → name it `user-apps`.

3. **Run platform migrations**

   ```bash
   npm run db:migrate:local   # local dev
   npm run db:migrate         # remote
   ```

4. **Set secrets**

   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   npx wrangler secret put PLATFORM_JWT_SECRET
   ```

   The `CLOUDFLARE_API_TOKEN` needs: Workers Scripts Write, D1 Edit, R2 Object Read/Write, Account Settings Read.
   The `PLATFORM_JWT_SECRET` can be any long random string (`openssl rand -hex 32`).

5. **Set account ID**

   In `wrangler.toml` under `[vars]`, set `CLOUDFLARE_ACCOUNT_ID` to your Cloudflare account ID.

6. **Local dev**

   ```bash
   npm run dev
   ```

   Open `http://localhost:8787`, register, describe your app, and hit Build.

7. **Deploy**

   ```bash
   npm run deploy
   ```

## Project layout

```
src/
  index.ts          # Hono app entrypoint: routing, /apps/:id/* dispatch
  agent.ts          # Claude tool-use agent loop (generate → write → deploy)
  build.ts          # Build pipeline: reads conversation, calls agent
  workflow.ts       # Cloudflare Workflow: durable agent execution with retries
  builderScript.ts  # Browser JS for the builder UI (served at /builder-app.js)
  ui.ts             # Builder UI HTML shell
  auth.ts           # Password hashing (SHA-256 + salt) and JWT (HMAC-SHA256)
  middleware.ts     # JWT auth middleware
  cf-api.ts         # Cloudflare REST API: D1, Worker deploy/delete, R2
  teardown.ts       # Delete project Worker, D1 database, and R2 files
  types.ts          # Shared TypeScript types and Env interface
  ai.ts             # (legacy) Workers AI helpers
  routes/
    auth.ts         # Register, login, change-password
    chat.ts         # Send message, chat history
    projects.ts     # Projects CRUD, build trigger, SSE stream, file list
schema/
  platform.sql      # Platform D1 schema (users, projects, chat_messages, build_events, build_logs)
```

## Cost notes

- Each agent build run makes several Anthropic API calls (Claude Sonnet 4.6)
- Each deployed app is a Worker in the dispatch namespace with its own D1 database
- Workers, D1, R2, KV, and Workers for Platforms are billed per Cloudflare pricing
- Project names are AI-generated using Claude Haiku (lightweight, fast)
