import type { Env, AppPlan } from "./types";

const MODEL = "@cf/zai-org/glm-4.7-flash";

const CHAT_SYSTEM =
  "You are a friendly assistant for an app builder. The user describes the app they want. " +
  "You must ONLY give a short acknowledgment (1–2 sentences). Examples: 'Got it, I've noted you want a todo app. Click Deploy when you're ready to build it.' or 'Noted! Add more details if you like, or click Deploy to generate your app.' " +
  "Do NOT output any code, file contents, HTML, markdown code blocks, or images. Do NOT start with 'Sure!' or 'Here is...' and then paste code. Just acknowledge briefly.";

function historyToPrompt(
  history: { role: string; content: string }[],
  userMessage: string
): string {
  let prompt = CHAT_SYSTEM + "\n\n";
  for (const m of history) {
    prompt += (m.role === "user" ? "User: " : "Assistant: ") + m.content + "\n\n";
  }
  prompt += "User: " + userMessage + "\n\nAssistant: ";
  return prompt;
}

export async function streamChat(
  env: Env,
  userMessage: string,
  history: { role: string; content: string }[]
): Promise<ReadableStream<Uint8Array>> {
  const prompt = historyToPrompt(history, userMessage);

  const response = await env.AI.run(MODEL as never, {
    prompt,
    stream: true,
  } as never);

  if (!response || typeof (response as { getReader?: unknown })?.getReader !== "function") {
    throw new Error("AI did not return a stream");
  }

  return response as ReadableStream<Uint8Array>;
}

export async function saveAssistantMessage(
  env: Env,
  projectId: string,
  content: string
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO chat_messages (project_id, role, content) VALUES (?, ?, ?)"
  )
    .bind(projectId, "assistant", content)
    .run();
}

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

// ─── Claude Agent ────────────────────────────────────────────────────────────

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const AGENT_MODEL = "claude-haiku-4-5-20251001";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, string> };

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type AgentMessage =
  | { role: "user"; content: string | ToolResultBlock[] }
  | { role: "assistant"; content: AnthropicContentBlock[] };

export type DeployFn = (
  workerJs: string,
  indexHtml: string,
  migrationSql: string
) => Promise<{ deployedUrl: string; d1DatabaseId: string; workerName: string }>;

const AGENT_TOOLS = [
  {
    name: "read_from_r2",
    description:
      "Read an existing generated file from R2 storage. Call this for all three files first to check what was previously generated before making changes.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          enum: ["worker.js", "index.html", "migration.sql"],
          description: "The filename to read",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "write_to_r2",
    description:
      "Write a generated file to R2 storage. Call this for each of the three files after generating them.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          enum: ["worker.js", "index.html", "migration.sql"],
          description: "The filename to write",
        },
        content: {
          type: "string",
          description: "The complete file content",
        },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "deploy_from_r2",
    description:
      "Deploy the app using the three files stored in R2. Only call this after writing all three files to R2.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

const AGENT_SYSTEM = `You are a code generation agent for a Cloudflare app builder platform.

Your job: Generate or update worker.js, index.html, and migration.sql for a user's app, then deploy them.

PROCESS (follow in order):
1. Call read_from_r2 for each of the three files to check what was previously generated
2. Generate new or patched versions based on the plan, conversation, and any existing files
3. Call write_to_r2 for each file
4. Verify your files meet all requirements below
5. Call deploy_from_r2

FILE REQUIREMENTS:

worker.js:
- Full ES module. Must export default { async fetch(request, env) { ... } }
- Route /api/* to API logic, otherwise return env.ASSETS.fetch(request) as the final fallback
- Use env.DB (D1), env.JWT_SECRET, env.STORAGE (R2) as needed
- Every /api/* response must use Response.json() — never plain text responses
- Wrap request.json() in try/catch, return Response.json({ error: 'Invalid JSON' }, { status: 400 }) on failure
- No npm imports — use crypto.subtle inline for password hashing and JWT (HMAC-SHA256)

index.html:
- Complete standalone HTML file using Preact + htm from esm.sh + Tailwind CDN
- Must use EXACTLY these imports — do not change them:
    import { h, render } from 'https://esm.sh/preact@10';
    import { useState, useEffect } from 'https://esm.sh/preact@10/hooks';
    import htm from 'https://esm.sh/htm@3';
    const html = htm.bind(h);
- Do NOT import { html } from preact — preact does not export html. Only h and render.
- Do NOT use window.preact.useState — always use the imported useState directly.
- Must contain exactly: const API_URL = "{{API_BASE}}"; — do NOT replace {{API_BASE}} yourself
- Every fetch to the backend must include /api/ in the path: fetch(API_URL + '/api/todos') not fetch(API_URL + '/todos')
- Use html\`...\` tagged templates (htm syntax), not JSX
- Mount with exactly these two lines, no backslashes:
    const root = document.getElementById('root');
    render(html\`<\${App} />\`, root);
  Do NOT add escape slashes before backticks or \${...} placeholders in the final output.
- Use camelCase event handlers: onClick, onInput, onChange, onSubmit
- Match response shapes: if worker.js returns { todos: results }, use data.todos in the frontend — never call .map() directly on a wrapped response object
- Child components must receive callbacks as props (e.g. onDelete) — never reference parent-scoped functions directly

migration.sql:
- CREATE TABLE IF NOT EXISTS for each table
- SQLite types only: TEXT, INTEGER, REAL, BLOB — no SERIAL, no AUTO_INCREMENT
- Add indexes where useful

SELF-CHECK before calling deploy_from_r2:
- Every fetch() in index.html uses API_URL + '/api/...' (not API_URL + '/todos' etc.)
- worker.js returns Response.json() for every /api/* route including error cases
- worker.js has env.ASSETS.fetch(request) as the final fallback for non-API routes
- index.html contains the exact string: const API_URL = "{{API_BASE}}";
- migration.sql has no Postgres-only syntax
- Response shapes match between worker.js and index.html`;

export async function runBuildAgent(
  env: Env,
  projectId: string,
  plan: AppPlan,
  conversation: { role: string; content: string }[],
  deployFn: DeployFn
): Promise<{ deployedUrl: string; d1DatabaseId: string; workerName: string }> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your-anthropic-api-key-here") {
    throw new Error("ANTHROPIC_API_KEY is not set — add it to wrangler.toml or run: wrangler secret put ANTHROPIC_API_KEY");
  }

  const prefix = `projects/${projectId}/`;
  let deployResult: { deployedUrl: string; d1DatabaseId: string; workerName: string } | null = null;

  async function executeTool(name: string, input: Record<string, string>): Promise<string> {
    if (name === "read_from_r2") {
      const obj = await env.CODE_BUCKET.get(`${prefix}${input.filename}`);
      if (!obj) {
        return `${input.filename} does not exist yet — this is a first deploy. Generate it fresh.`;
      }
      return await obj.text();
    }

    if (name === "write_to_r2") {
      if (!input.filename || !input.content) {
        return "Error: filename and content are required";
      }
      await env.CODE_BUCKET.put(`${prefix}${input.filename}`, input.content);
      return `${input.filename} written to R2 successfully`;
    }

    if (name === "deploy_from_r2") {
      const [workerObj, htmlObj, sqlObj] = await Promise.all([
        env.CODE_BUCKET.get(`${prefix}worker.js`),
        env.CODE_BUCKET.get(`${prefix}index.html`),
        env.CODE_BUCKET.get(`${prefix}migration.sql`),
      ]);

      const missing = [
        !workerObj && "worker.js",
        !htmlObj && "index.html",
        !sqlObj && "migration.sql",
      ].filter(Boolean);

      if (missing.length > 0) {
        return `Error: missing files in R2: ${missing.join(", ")}. Write all three files before deploying.`;
      }

      const [workerJs, indexHtml, migrationSql] = await Promise.all([
        workerObj!.text(),
        htmlObj!.text(),
        sqlObj!.text(),
      ]);

      try {
        deployResult = await deployFn(workerJs, indexHtml, migrationSql);
        return `Deployed successfully. URL: ${deployResult.deployedUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Deploy failed: ${msg}. Fix the issue in the relevant file and try again.`;
      }
    }

    return `Unknown tool: ${name}`;
  }

  const planStr = JSON.stringify(plan, null, 2);
  const convStr = conversation
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const messages: AgentMessage[] = [
    {
      role: "user",
      content: `Plan:\n${planStr}\n\nRecent conversation:\n${convStr}\n\nProject ID: ${projectId}\n\nStart by reading the existing files from R2, then generate or update all three files and deploy.`,
    },
  ];

  const MAX_ITERATIONS = 20;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: 8192,
        system: AGENT_SYSTEM,
        tools: AGENT_TOOLS,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    messages.push({ role: "assistant", content: data.content });

    if (data.stop_reason === "end_turn") {
      if (!deployResult) {
        throw new Error("Agent finished without deploying. Check that deploy_from_r2 was called.");
      }
      return deployResult;
    }

    if (data.stop_reason === "tool_use") {
      const toolResults: ToolResultBlock[] = [];

      for (const block of data.content) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    if (data.stop_reason === "max_tokens") {
      throw new Error("Agent exceeded token limit. Try a simpler app description.");
    }
  }

  throw new Error("Agent exceeded maximum iterations without completing the build.");
}