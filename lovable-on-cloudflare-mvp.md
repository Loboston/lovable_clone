# Building a Lovable-Style AI App Builder on Cloudflare

## Executive Summary

This document maps every piece of Lovable's architecture to a Cloudflare-native equivalent, using **GLM-4.7-Flash** as the AI backbone. The goal: a user describes an app in chat, the system generates a plan, builds a full-stack app (frontend + backend + database), deploys it to a live URL, and stores all code per-user with auth — all on Cloudflare's stack. No external services.

---

## 1. How Lovable Actually Works (Under the Hood)

### Core Flow
1. **Chat interface** → user describes an app in natural language
2. **AI generates a plan** → summarizes what it will build (pages, features, data model)
3. **AI generates code** → full React + Vite + Tailwind CSS frontend, with Supabase for backend (auth, DB, storage)
4. **Live preview** → hot-reloaded in an iframe in the browser
5. **One-click deploy** → ships to a *.lovable.app subdomain
6. **GitHub sync** → code is pushed to a repo the user owns
7. **Iterative refinement** → user chats more, AI patches the codebase

### Tech Stack
| Layer | Lovable Uses |
|-------|-------------|
| Frontend framework | React + Vite + Tailwind CSS + shadcn/ui |
| Backend/DB/Auth | Supabase (Postgres, Auth, Edge Functions, Storage) |
| AI model | Proprietary (likely Claude or GPT-4 class) |
| Hosting | Custom infra + Netlify-style deploy |
| Version control | GitHub integration |
| Code execution | Server-side sandboxed build (Vite) |

### Key Insight
Lovable is essentially: **LLM + code sandbox + hosting platform + user DB + auto-provisioned backend**. The AI writes code, a build pipeline compiles it, the result is deployed to a CDN, and Supabase is auto-provisioned to give the generated app a real database, auth, and API.

---

## 2. Cloudflare Service Mapping

| Lovable Component | Cloudflare Equivalent | Service |
|---|---|---|
| AI (code generation) | **Workers AI** | @cf/zai-org/glm-4.7-flash (131K context) |
| Platform user database | **D1** (platform-level) | SQLite-based serverless SQL |
| Platform authentication | **D1 + Workers** | JWT via Web Crypto API |
| Code storage (per user) | **R2** | Object storage for project files |
| **Generated app's database** | **D1** (per-project) | Auto-provisioned via CF REST API |
| **Generated app's backend API** | **User Worker** | The Worker IS the backend — static assets + API routes |
| **Generated app's auth** | **D1 + User Worker** | Auth tables + JWT in per-project D1 |
| **Generated app's file storage** | **R2** (per-project prefix) | Bound to the User Worker |
| App hosting | **Workers for Platforms** | Each user app is a Worker w/ static assets + D1 + R2 |
| Platform API + chat | **Workers** | Hono-based API on the edge |
| Chat streaming | **Workers** | SSE from Workers AI |
| Custom domains | **Custom Hostnames** | Via Workers for Platforms |
| Caching / rate limiting | **AI Gateway** | In front of Workers AI calls |
| Session storage | **KV** | Session tokens + subdomain mapping |

---

## 3. MVP Architecture (Detailed)

### 3.1 — The Platform Worker (Main API)

A single Cloudflare Worker (Hono) serves as the brain:

```
POST /api/auth/register      → create platform user in D1
POST /api/auth/login          → issue JWT
POST /api/chat                → prompt GLM-4.7-Flash, stream response
POST /api/projects             → create new project
POST /api/projects/:id/build  → generate code + provision D1 + deploy
GET  /api/projects/:id/files  → list files from R2
DELETE /api/projects/:id      → tear down (delete D1, Worker, R2 files)
```

**Bindings:**
```toml
[[d1_databases]]
binding = "DB"                     # Platform database
database_name = "platform-db"

[[r2_buckets]]
binding = "CODE_BUCKET"             # All user code
bucket_name = "user-code"

[[kv_namespaces]]
binding = "SESSIONS"

[ai]
binding = "AI"

[[dispatch_namespaces]]
binding = "DISPATCHER"
namespace = "user-apps"
```

### 3.2 — Platform Auth (D1 + JWT)

**Platform D1 Schema:**
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'draft',   -- draft | building | deployed | error
  deployed_url TEXT,
  d1_database_id TEXT,            -- Provisioned D1 UUID
  worker_name TEXT,               -- Name in dispatch namespace
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

- Password hashing via `crypto.subtle.digest('SHA-256')` with salt
- JWT via `@tsndr/cloudflare-worker-jwt` (zero-dep, native to Workers)

### 3.3 — AI Code Generation (Three Phases)

**Model**: `@cf/zai-org/glm-4.7-flash` — 131K tokens, streaming, multi-turn tool calling.

#### Phase 1: Generate Plan
AI outputs a structured JSON plan including the **data model**:
```json
{
  "appName": "task-manager",
  "pages": [
    { "name": "Login", "route": "/login" },
    { "name": "Dashboard", "route": "/" }
  ],
  "dataModel": {
    "tables": [
      {
        "name": "app_users",
        "columns": [
          { "name": "id", "type": "TEXT PRIMARY KEY" },
          { "name": "email", "type": "TEXT UNIQUE NOT NULL" },
          { "name": "password_hash", "type": "TEXT NOT NULL" },
          { "name": "created_at", "type": "TEXT DEFAULT (datetime('now'))" }
        ]
      },
      {
        "name": "tasks",
        "columns": [
          { "name": "id", "type": "TEXT PRIMARY KEY" },
          { "name": "user_id", "type": "TEXT REFERENCES app_users(id)" },
          { "name": "title", "type": "TEXT NOT NULL" },
          { "name": "completed", "type": "INTEGER DEFAULT 0" }
        ]
      }
    ]
  },
  "features": ["auth", "crud", "dark-mode"],
  "needsAuth": true,
  "needsFileStorage": false
}
```

#### Phase 2: Generate Full-Stack Code
AI generates THREE artifacts:

1. **`worker.js`** — A Cloudflare Worker that serves as BOTH the API backend AND static asset server
2. **`index.html`** (+ component files) — Frontend SPA using htm + Preact + Tailwind CDN
3. **`migration.sql`** — D1 schema migration

**The generated Worker script:**
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // API routes → backend logic with D1
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }
    
    // Everything else → static assets (HTML, CSS, JS)
    return env.ASSETS.fetch(request);
  }
};

async function handleAPI(request, env, url) {
  // Auth endpoints
  if (url.pathname === '/api/auth/register' && request.method === 'POST') {
    const { email, password } = await request.json();
    const id = crypto.randomUUID();
    const hash = await hashPassword(password, env.JWT_SECRET);
    await env.DB.prepare('INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)')
      .bind(id, email, hash).run();
    const token = await createJWT({ sub: id, email }, env.JWT_SECRET);
    return Response.json({ token, user: { id, email } });
  }
  
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const { email, password } = await request.json();
    const user = await env.DB.prepare('SELECT * FROM app_users WHERE email = ?')
      .bind(email).first();
    if (!user || !(await verify(password, user.password_hash, env.JWT_SECRET)))
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    const token = await createJWT({ sub: user.id, email }, env.JWT_SECRET);
    return Response.json({ token });
  }
  
  // Protected CRUD routes
  const auth = await authenticateRequest(request, env.JWT_SECRET);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  
  if (url.pathname === '/api/tasks' && request.method === 'GET') {
    const r = await env.DB.prepare('SELECT * FROM tasks WHERE user_id = ?')
      .bind(auth.sub).all();
    return Response.json({ tasks: r.results });
  }
  // ... more CRUD
}
```

**The frontend** uses htm + Preact with Tailwind CDN (no build step needed):
```html
<script type="module">
  import { h, render } from 'https://esm.sh/preact@10';
  import { useState, useEffect } from 'https://esm.sh/preact@10/hooks';
  import htm from 'https://esm.sh/htm@3';
  const html = htm.bind(h);
  // ... calls /api/* routes on same origin — no CORS issues
</script>
```

#### Phase 3: SQL Migration
```sql
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (...);
CREATE INDEX idx_tasks_user_id ON tasks(user_id);
```

### 3.4 — Auto-Provisioning (The Core Pipeline)

When the user deploys, the platform orchestrates:

```
STEP 1: POST /d1/database
         → Create a NEW D1 database for this project
         → Returns: database UUID

STEP 2: POST /d1/database/{uuid}/query
         → Execute migration.sql
         → Creates tables: app_users, tasks, etc.

STEP 3: POST .../scripts/{name}/assets-upload-session
         → Upload static assets (HTML, CSS, JS)
         → Returns: completion JWT

STEP 4: PUT .../dispatch/namespaces/user-apps/scripts/{name}
         → Upload Worker script with BINDINGS:
           • D1 binding → the new project database
           • R2 binding → file storage bucket
           • Secret    → JWT signing key (unique per app)
           • Assets    → the uploaded static files

STEP 5: Store all code in R2 for versioning

STEP 6: Update platform D1 with deployed URL + DB UUID
```

The critical insight from the Cloudflare docs: **Workers for Platforms supports attaching per-User-Worker bindings** via the `Patch Script Settings` API or the multipart upload metadata. This means each generated app gets:
- Its own isolated D1 database
- Its own R2 storage prefix
- Its own JWT secret
- Its own static assets

### 3.5 — What Each Deployed App Looks Like

```
┌─────────────────────────────────────────────────────┐
│         User Worker (app-{projectId})                │
│                                                       │
│  Bindings:                                           │
│    env.DB        → D1 (project-specific database)    │
│    env.STORAGE   → R2 (file uploads)                 │
│    env.ASSETS    → Static assets (HTML/CSS/JS)       │
│    env.JWT_SECRET → Secret (unique signing key)      │
│                                                       │
│  Routes:                                              │
│    GET  /            → SPA HTML (via ASSETS)         │
│    POST /api/auth/*  → Auth (D1 backed)              │
│    GET  /api/tasks   → Query D1                      │
│    POST /api/tasks   → Insert into D1                │
│    POST /api/upload  → Store in R2                   │
│    *                 → SPA fallback (via ASSETS)     │
└─────────────────────────────────────────────────────┘
```

**Lovable ↔ Cloudflare mapping per generated app:**

| Lovable (Supabase) | This MVP (Cloudflare) |
|---|---|
| Supabase Postgres | D1 (per-project, auto-provisioned, $0 when idle) |
| Supabase Auth | JWT in the Worker script (D1-backed) |
| Supabase Edge Functions | The Worker script IS the edge function |
| Supabase Storage | R2 bucket (bound to Worker) |
| Supabase REST API | Worker routes at /api/* |
| Supabase Realtime | Not in MVP (add via Durable Objects later) |

### 3.6 — Hosting Architecture (Workers for Platforms)

```
    Request: my-todo.apps.your-platform.com
                    │
                    ▼
┌───────────────────────────────────────┐
│  Dynamic Dispatch Worker              │
│  *.apps.your-platform.com            │
│                                       │
│  1. Extract subdomain → "my-todo"    │
│  2. KV lookup → worker name          │
│  3. env.DISPATCHER.get(workerName)   │
│  4. Forward request                  │
└───────────────┬───────────────────────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│ Worker  │ │ Worker  │ │ Worker  │
│ + D1    │ │ + D1    │ │ + D1    │
│ + R2    │ │ + R2    │ │ + R2    │
│ + HTML  │ │ + HTML  │ │ + HTML  │
└─────────┘ └─────────┘ └─────────┘
  (isolated)  (isolated)  (isolated)
```

### 3.7 — Teardown (Project Deletion)

```
1. DELETE Worker from dispatch namespace
2. DELETE the project's D1 database (CF REST API)
3. DELETE all R2 objects under user/project prefix
4. DELETE from platform D1 (projects, chat_messages)
```

---

## 4. Development Effort

| Component | Effort | Notes |
|-----------|--------|-------|
| Platform auth | 2-3 days | Register, login, JWT middleware |
| Chat API + streaming | 2-3 days | SSE streaming, conversation mgmt |
| **Prompt engineering** | **5-7 days** | **Getting GLM-4.7-Flash to reliably generate Worker + frontend + SQL** |
| R2 file storage + parsing | 1-2 days | Parse AI output → files, store in R2 |
| **Auto-provisioning pipeline** | **3-5 days** | **D1 creation, migration, asset upload, Worker deploy w/ bindings** |
| Dispatch Worker + routing | 2-3 days | Subdomain routing, KV mapping |
| Frontend (builder UI) | 5-7 days | Chat, preview iframe, dashboard |
| Iterative editing | 3-5 days | Send code context → AI → patch → redeploy |
| Teardown | 1 day | Cleanup D1, Worker, R2 |
| **Total** | **~4-6 weeks** | One experienced developer |

---

## 5. Cost Estimate

| Service | Est. Cost (1K users, 500 projects, 50 deploys/day) |
|---------|------------------------------------------------------|
| Workers (platform) | $5/mo base + ~$1 requests |
| Workers AI (GLM-4.7-Flash) | ~$20-50/mo |
| D1 (platform) | ~$5/mo |
| **D1 (500 per-project DBs)** | **~$10-20/mo (most are idle = free)** |
| R2 (code + app storage) | ~$10/mo |
| KV | ~$5/mo |
| Workers for Platforms | Included in paid plan |
| **Total** | **~$55-100/mo** |

**D1's pricing is the unlock**: you pay zero for idle databases. A project with 10 hits/day costs essentially nothing. 10,000 databases with no per-DB fee — only query costs. This is fundamentally different from Supabase (which charges per-instance).

---

## 6. Post-MVP Roadmap

1. **Vite build step** via external service → enables real React/JSX
2. **OAuth** in generated apps (Google, GitHub login)
3. **Realtime** via Durable Objects WebSocket
4. **GitHub sync** — push code to user's repo
5. **Visual editor** — point-and-click UI editing
6. **Stronger AI model** — swap in better models as they hit Workers AI
7. **Durable Objects** for stateful/collaborative apps
8. **Custom domains** for user apps (CNAME setup)
