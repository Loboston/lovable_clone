# Subdomain routing (post-MVP)

Right now the platform uses **path-based routing**: deployed apps are at `https://your-platform.com/apps/{projectId}/`.

When you want to move to **subdomain routing** (e.g. `https://my-todo.apps.your-platform.com`), do the following.

## 1. Custom hostnames (Cloudflare)

- In the Cloudflare dashboard, add a **Custom Hostname** (or wildcard) for `*.apps.your-platform.com` (or your chosen subdomain pattern).
- Point it to the Worker that will do **dynamic dispatch** (see below).

## 2. Dynamic Dispatch Worker

- Create a **separate** Worker that:
  - Receives requests for `*.apps.your-platform.com`.
  - Reads the hostname and extracts the subdomain (e.g. `my-todo` from `my-todo.apps.your-platform.com`).
  - Looks up the **worker name** for that subdomain (e.g. in **KV**: key = subdomain, value = `app-{projectId}`).
  - Uses the **dispatch namespace** binding: `env.DISPATCHER.get(workerName).fetch(request)`.
  - Forwards the request to that Worker (optionally rewriting the path to `/` for the root).

## 3. KV mapping

- When a project is **deployed**, store in KV:  
  `subdomain` → `app-{projectId}`  
  (or let the user choose a subdomain and store that mapping).
- When a project is **deleted**, remove the KV entry.

## 4. Platform Worker

- Keep the current Platform Worker for:
  - Builder UI and API (`/`, `/api/*`).
  - Path-based app URLs (`/apps/:projectId/*`) can stay as a fallback or be removed once subdomain routing is live.

## 5. Docs to check

- [Workers for Platforms – Get started](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/)
- [Custom Hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/custom-domains/)
- [Dynamic Dispatch](https://developers.cloudflare.com/workers/configuration/bindings/dispatcher/) (runtime API)

## Summary

| Current (path-based)        | Future (subdomain)                    |
|----------------------------|----------------------------------------|
| `.../apps/{id}/`           | `{subdomain}.apps.your-platform.com/`  |
| Platform Worker does dispatch | Dedicated Dynamic Dispatch Worker   |
| No KV for routing         | KV: subdomain → script name            |
