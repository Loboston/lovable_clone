# Lovable-style App Builder on Cloudflare

An AI-native app generator that runs on Cloudflare: describe an app in chat, then deploy a full-stack app (frontend + D1 + Worker backend + auth) with path-based routing.

## What’s included (MVP)

- **Platform Worker (Hono)**  
  - Auth: `POST /api/auth/register`, `POST /api/auth/login`  
  - Chat: `POST /api/chat` (streaming), `GET /api/chat/:projectId/history`, `POST /api/chat/save-assistant`  
  - Projects: `POST/GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects/:id/build`, `GET /api/projects/:id/files`, `DELETE /api/projects/:id`  
  - Builder UI at `/` (same Worker)  
  - Path-based app URLs: `/apps/:projectId/` and `/apps/:projectId/*` → dispatched to the generated app Worker  

- **Platform auth**  
  - D1: `users`, `projects`, `chat_messages`  
  - Passwords hashed with SHA-256 + salt; JWTs for sessions  

- **AI (Workers AI)**  
  - Model: `@cf/zai-org/glm-4.7-flash`  
  - Chat streaming; plan (JSON) + full-stack code (worker.js, index.html, migration.sql) for build  

- **Build pipeline**  
  - Create D1 DB → run migration → upload static assets → deploy Worker to dispatch namespace with D1, R2, secret, and assets bindings  

- **Teardown**  
  - Delete Worker, D1 database, and R2 objects for the project  

See [lovable-on-cloudflare-mvp.md](./lovable-on-cloudflare-mvp.md) for the full design.  
Subdomain routing is planned later; see [docs/subdomain-routing-todo.md](./docs/subdomain-routing-todo.md).

## Prerequisites

- Node 18+
- Cloudflare account (paid plan for Workers for Platforms)
- Wrangler CLI: `npm install -g wrangler` (or use `npx wrangler`)

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
     Put the returned `database_id` into `wrangler.toml` under `[[d1_databases]]` → `database_id`.

   - **R2 bucket**  
     In Dashboard: R2 → Create bucket → name it `user-code` (or set `bucket_name` in `wrangler.toml` to your name).

   - **KV namespace**  
     ```bash
     npx wrangler kv namespace create SESSIONS
     ```  
     Put the returned `id` into `wrangler.toml` under `[[kv_namespaces]]` → `id`.

   - **Dispatch namespace**  
     In Dashboard: Workers for Platforms → Create dispatch namespace → name it `user-apps`.  
     In `wrangler.toml`, the `[[dispatch_namespaces]]` binding should use that namespace name.

3. **Run platform migrations**

   ```bash
   npm run db:migrate:local   # local dev
   npm run db:migrate        # remote
   ```

4. **Secrets and vars**

   - **API token** (for D1/Worker provisioning from inside the Worker):  
     ```bash
     npx wrangler secret put CLOUDFLARE_API_TOKEN
     ```  
     Use a token with: D1 Edit, Workers Scripts Write, Account Settings Read, R2 Object Read/Write (if you use R2 from API).

   - **Platform JWT secret**:  
     ```bash
     npx wrangler secret put PLATFORM_JWT_SECRET
     ```  
     Use a long random string (e.g. `openssl rand -hex 32`).

   - In `wrangler.toml`, set `CLOUDFLARE_ACCOUNT_ID` under `[vars]` to your account ID.

5. **Local dev**

   ```bash
   npm run dev
   ```

   Open the builder UI, register, create a project, chat to describe the app, then click **Deploy**. The app will be at `http://localhost:8787/apps/<projectId>/`.

6. **Deploy platform**

   ```bash
   npm run deploy
   ```

   Then set secrets (and vars) for the deployed Worker as above if you didn’t already.

## Project layout

- `src/index.ts` – Hono app: API routes, `/apps/:id/*` dispatch, serve builder UI at `/`
- `src/auth.ts` – Password hashing and JWT
- `src/middleware.ts` – JWT auth middleware
- `src/routes/auth.ts` – Register / login
- `src/routes/chat.ts` – Chat and history
- `src/routes/projects.ts` – Projects CRUD, build, files, delete
- `src/ai.ts` – Plan + code generation and chat streaming (Workers AI)
- `src/build.ts` – Build pipeline (plan → code → D1 → assets → deploy Worker)
- `src/teardown.ts` – Delete project Worker, D1, R2
- `src/cf-api.ts` – Cloudflare REST: D1 create/query/delete, Worker deploy/delete
- `src/ui.ts` – Builder UI HTML (single page)
- `schema/platform.sql` – Platform D1 schema

## Cost notes

- Workers, D1, R2, KV, and Workers AI are billed per use; see Cloudflare pricing.
- Workers for Platforms is included on the paid Workers plan.
- Each generated app is a Worker in the dispatch namespace with its own D1 and shared R2 bucket.
