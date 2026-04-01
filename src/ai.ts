import type { Env, AppPlan } from "./types";
export type { AgentResult, DeployFn, StorageAdapter } from "./agent";
export { runBuildAgent } from "./agent";

const PLAN_SYSTEM = `You are an app architect. Given a user's app description and conversation, output ONLY a single JSON object (no markdown, no code fence) with this exact shape:
{
  "appName": "kebab-case-name",
  "pages": [{"name": "PageName", "route": "/path"}],
  "dataModel": {
    "tables": [
      {"name": "table_name", "columns": [{"name": "id", "type": "TEXT PRIMARY KEY"}, ...]}
    ]
  },
  "features": ["auth", "crud", ...],
  "needsAuth": true,
  "needsFileStorage": false
}
Use SQLite/D1 types (TEXT, INTEGER, etc.). Always include an app_users (or similar) table if needsAuth is true.`;

/** Normalize AI binding response to a string; supports OpenAI-style and simple shapes. */
function getTextFromAiResponse(out: unknown): string {
  if (typeof out === "string") return out;
  const o = out as Record<string, unknown>;
  const content = (o?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (typeof o?.response === "string") return o.response;
  const result = o?.result as Record<string, unknown> | undefined;
  if (result && typeof result.response === "string") return result.response;
  return "";
}

export async function generatePlan(
  env: Env,
  conversation: { role: string; content: string }[]
): Promise<AppPlan> {
  const messages = [
    { role: "system" as const, content: PLAN_SYSTEM },
    ...conversation.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    {
      role: "user" as const,
      content: "Output the JSON plan only, no other text.",
    },
  ];

  const out = await env.AI.run(MODEL as never, {
    messages,
    stream: false,
  } as never);

  const text = getTextFromAiResponse(out);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : text;

  let plan: AppPlan;
  try {
    plan = JSON.parse(jsonStr) as AppPlan;
  } catch {
    const rawStr = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    const rawPreview = rawStr.slice(0, 800);
    throw new Error(
      "AI did not return valid plan JSON. Extracted text: " +
        text.slice(0, 500) +
        " | Raw AI response: " +
        rawPreview
    );
  }

  if (!plan.appName || !plan.pages || !plan.dataModel?.tables) {
    throw new Error("Plan missing required fields: " + JSON.stringify(plan));
  }

  return plan;
}

/**
 * Light validation for full generated index.html.
 * Ensures it has the expected structure and the API_BASE placeholder for the platform.
 */
function validateIndexHtml(html: string): string[] {
  const errors: string[] = [];

  if (!/<script/i.test(html)) {
    errors.push("index.html: must contain a <script> tag");
  }
  if (!/render\s*\(/.test(html)) {
    errors.push("index.html: must contain render(...) to mount the app");
  }
  if (!/\{\{API_BASE\}\}/.test(html)) {
    errors.push("index.html: must contain {{API_BASE}} so the platform can set the API URL (e.g. const API_URL = \"{{API_BASE}}\";)");
  }
  if (/```/.test(html)) {
    errors.push("index.html: must not contain markdown code fences; output raw HTML only");
  }

  return errors;
}

/** Catch common worker.js mistakes: plain-text API errors and missing body parse handling. */
function validateWorkerJs(code: string): string[] {
  const errors: string[] = [];

  // Plain-text "Not Found" (or similar) causes frontend res.json() to throw; API must return JSON.
  if (/new\s+Response\s*\(\s*["'][^"']+["']\s*,\s*\{\s*status\s*:\s*(400|401|403|404|500)/i.test(code)) {
    errors.push("worker.js: API error responses should use Response.json(...), not plain-text new Response(...)");
  }

  // request.json() without try/catch can throw on invalid JSON and surface as non-JSON response.
  if (/await\s+request\.json\s*\(\s*\)/.test(code) && (!/\btry\s*\{/.test(code) || !/\bcatch\s*\(/.test(code))) {
    errors.push(
      "worker.js: Wrap request.json() in try/catch and return Response.json({ error: 'Invalid JSON' }, { status: 400 }) on failure"
    );
  }

  return errors;
}

/** Canonical index.html scaffold (reference only — shown in prompt so the AI outputs a full file in this shape). */
const INDEX_HTML_SCAFFOLD = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-gray-100 min-h-screen">
    <div id="root"></div>
    <script type="module">
  import { h, render } from 'https://esm.sh/preact@10';
  import { useState, useEffect } from 'https://esm.sh/preact@10/hooks';
  import htm from 'https://esm.sh/htm@3';
  const html = htm.bind(h);
  const API_URL = "{{API_BASE}}";

  const App = () => html\`<div>Your app here</div>\`;
  const root = document.getElementById('root');
  render(html\`<\${App} />\`, root);
    </script>
  </body>
</html>`;

const CODE_SYSTEM = `You generate exactly three artifacts for a Cloudflare app. Output full files; the platform will replace {{API_BASE}} in index.html before deploy.

1. worker.js
- Full ES module Worker file.
- Must export default { async fetch(request, env) { ... } }.
- Route /api/* to API logic, otherwise return env.ASSETS.fetch(request).
- Use env.DB (D1), env.JWT_SECRET, env.STORAGE (R2) if needed.
- Implement auth and CRUD from the plan.
- API responses: For every /api/* response (including 404 and 500), return JSON only. Use Response.json({ error: '...' }, { status: 404 }) or 400/500 for errors. Never return plain text (e.g. new Response('Not Found')) for API routes.
- Body parsing: When reading the request body with request.json(), use try/catch; on failure return Response.json({ error: 'Invalid JSON' }, { status: 400 }).
- No npm imports; use inline password hash (crypto.subtle.digest SHA-256 with salt) and JWT (HMAC-SHA256).

2. index.html
- A complete, standalone HTML file. Use this structure as your scaffold (rewrite the whole file with your app logic):
${INDEX_HTML_SCAFFOLD}
- You MUST keep exactly: const API_URL = "{{API_BASE}}"; so the platform can inject the path prefix for preview/deploy. Do not replace {{API_BASE}} yourself.
- API_URL is ONLY /apps/<projectId> (no /api). The worker.js API lives under /api/*. Every fetch to the backend MUST include /api in the path: fetch(API_URL + '/api/notes'), fetch(API_URL + '/api/todos'), fetch(API_URL + '/api/auth/login'), etc. NEVER fetch(API_URL + '/notes') or API_URL + '/todos' without /api/ — that hits the wrong route and returns 404.
- Use htm + Preact (import from esm.sh as in scaffold). Use html\`...\` tagged templates, not JSX.
- Define your root component (e.g. const App = () => ...) and mount with render(html\`<\${App} />\`, root).
- Use camelCase event handlers: onClick, onInput, onChange, onSubmit, onKeyDown.
- If you split UI into child components (e.g. a row component for each list item), pass parent callbacks as props (onDelete, onEdit). The child must only call props.onDelete(id) or similar — never reference handleDelete directly inside the child if handleDelete is defined in the parent (ReferenceError at runtime).
- For fetch calls, check res.ok and handle non-2xx by reading JSON error body; show a user-friendly message.
- Do not include markdown code fences in the output; output raw HTML only.

3. migration.sql
- Full SQLite/D1 migration. CREATE TABLE IF NOT EXISTS for each table; add indexes where useful.

Output exactly three blocks:
---FILE:worker.js---
...
---FILE:index.html---
...
---FILE:migration.sql---
...
No other text.`;

