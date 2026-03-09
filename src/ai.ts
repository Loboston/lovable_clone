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
 * Returns validation errors for the generated app.js fragment.
 * Empty array = valid enough to inject into the platform template.
 */
function validateAppBody(code: string): string[] {
  const errors: string[] = [];

  const bannedPatterns: [RegExp, string][] = [
    [/<!DOCTYPE/i, "DOCTYPE"],
    [/<html[\s>]/i, "<html>"],
    [/<head[\s>]/i, "<head>"],
    [/<body[\s>]/i, "<body>"],
    [/<script[\s>]/i, "<script>"],
    [/^\s*import\s+/m, "import statement"],
    [/^\s*import\s+.*from\s+['"]preact(?:\/hooks)?['"]\s*;?\s*$/m, "preact import"],
    [/^\s*import\s+.*from\s+['"]https:\/\/esm\.sh\/preact@10(?:\/hooks)?['"]\s*;?\s*$/m, "preact esm import"],
    [/^\s*import\s+.*from\s+['"]https:\/\/esm\.sh\/htm@3['"]\s*;?\s*$/m, "htm import"],
    [/document\.getElementById\s*\(/, "document.getElementById(...)"],
    [/\bconst\s+html\s*=/, "const html = ..."],
    [/\bconst\s+API_URL\s*=/, "const API_URL = ..."],
    [/```/, "markdown code fence"],
    [/\bApp\.toString\s*=/, "App.toString override"],
    [/\bexport\s+default\b/, "export default"],
    [/\bReact\./, "React.* API"],
    [/<[A-Za-z][^>]*>/, "raw JSX/HTML tag"],
    [/^\s*const\s*\{[^}]*\buseState\b[^}]*\}\s*=\s*preact\s*;?\s*$/m, "preact global destructuring"],
    [/^\s*const\s*\{[^}]*\brender\b[^}]*\}\s*=\s*preact\s*;?\s*$/m, "preact render destructuring"],
  ];

  for (const [pattern, label] of bannedPatterns) {
    if (pattern.test(code)) {
      errors.push(`Banned in app.js: ${label}`);
    }
  }

  const appMatch = code.match(/\bconst\s+App\s*=|\bfunction\s+App\s*\(/);
  if (!appMatch || appMatch.index === undefined) {
    errors.push("Missing App component (const App = ... or function App(...))");
  } else {
    const beforeApp = code.slice(0, appMatch.index);

    if (/\buseState\s*\(/.test(beforeApp) || /\buseEffect\s*\(/.test(beforeApp)) {
      errors.push("Hooks appear before App definition; possible top-level hook usage");
    }
  }

  const lowercaseHandlers = [
    "onclick",
    "onchange",
    "oninput",
    "onkeypress",
    "onkeydown",
    "onsubmit",
  ];

  for (const handler of lowercaseHandlers) {
    const re = new RegExp(`\\b${handler}\\s*=`);
    if (re.test(code)) {
      errors.push(`Use camelCase event handlers instead of ${handler}`);
    }
  }

  if (!/html\s*`/.test(code)) {
    errors.push("Expected htm template usage: html`...`");
  }

  if (/\.map\s*\([^)]*\)\s*\.join\s*\(\s*['"]\s*['"]\s*\)/.test(code)) {
    errors.push("Suspicious .join('') after .map(...) in app.js");
  }

  return errors;
}

/** Catch common worker.js mistakes: plain-text API errors and missing body parse handling. */
function validateWorkerJs(code: string): string[] {
  const errors: string[] = [];

  if (/new\s+Response\s*\(\s*["'][^"']+["']\s*,\s*\{\s*status\s*:\s*(400|401|403|404|500)/i.test(code)) {
    errors.push("worker.js: API error responses should use Response.json(...), not plain-text new Response(...)");
  }

  if (/await\s+request\.json\s*\(\s*\)/.test(code) && (!/\btry\s*\{/.test(code) || !/\bcatch\s*\(/.test(code))) {
    errors.push(
      "worker.js: Wrap request.json() in try/catch and return Response.json({ error: 'Invalid JSON' }, { status: 400 }) on failure"
    );
  }

  if (!/\bResponse\.json\s*\(/.test(code)) {
    errors.push("worker.js: Expected Response.json(...) for API responses");
  }

  return errors;
}

/**
 * Remove common AI-generated redeclarations/imports that conflict with the template.
 * This is broader than STRIP_LINES and handles variants.
 */
function normalizeAppBody(code: string): string {
  let out = code
    .replace(/\r\n/g, "\n")
    .replace(/\bh\.preact\.useState\b/g, "useState")
    .replace(/\bh\.preact\.useEffect\b/g, "useEffect");

  // Remove common import variants.
  out = out
    .replace(/^\s*import\s+.*from\s+['"]preact(?:\/hooks)?['"]\s*;?\s*$/gm, "")
    .replace(/^\s*import\s+.*from\s+['"]https:\/\/esm\.sh\/preact@10(?:\/hooks)?['"]\s*;?\s*$/gm, "")
    .replace(/^\s*import\s+.*from\s+['"]https:\/\/esm\.sh\/htm@3['"]\s*;?\s*$/gm, "");

  // Remove common redeclarations of template-provided globals (flexible whitespace/semicolon).
  out = out
    .replace(/^\s*const\s+html\s*=\s*htm\.bind\s*\(\s*h\s*\)\s*;?\s*$/gm, "")
    .replace(/^\s*const\s+API_URL\s*=\s*['"][^'"]*['"]\s*;?\s*$/gm, "")
    .replace(/^\s*const\s+root\s*=\s*document\.getElementById\s*\(\s*['"]root['"]\s*\)\s*;?\s*$/gm, "")
    .replace(/^\s*const\s*\{\s*useState\s*,\s*useEffect\s*\}\s*=\s*globalThis\s*;?\s*$/gm, "")
    .replace(/^\s*const\s*\{[^}]*\bh\b[^}]*\brender\b[^}]*\bhtml\b[^}]*\buseState\b[^}]*\buseEffect\b[^}]*\}\s*=\s*preact\s*;?\s*$/gm, "")
    .replace(/^\s*const\s*\{[^}]*\buseState\b[^}]*\buseEffect\b[^}]*\}\s*=\s*preact\s*;?\s*$/gm, "");

  // Remove duplicate mount calls (any render(html`<${App} />`, root) style).
  out = out
    .replace(/^\s*render\s*\(\s*App\s*\)\s*;?\s*$/gm, "")
    .replace(/^\s*render\s*\(\s*html\s*`\s*<\s*\$\{\s*App\s*\}\s*\/?\s*>\s*`\s*,\s*root\s*\)\s*;?\s*$/gm, "")
    .replace(/^\s*render\s*\(\s*html\s*`\s*<\s*\$\{\s*App\s*\}\s*\/?\s*>\s*`\s*,\s*document\.getElementById\s*\(\s*['"]root['"]\s*\)\s*\)\s*;?\s*$/gm, "");

  // Patterns for lines that must never appear (template already provides these).
  const STRIP_PATTERNS = [
    /^\s*const\s+html\s*=\s*htm\.bind\s*\(\s*h\s*\)\s*;?\s*$/,
    /^\s*const\s+root\s*=\s*document\.getElementById\s*\(\s*['"]root['"]\s*\)\s*;?\s*$/,
    /^\s*render\s*\(\s*html\s*`\s*<\s*\$\{\s*App\s*\}\s*\/?\s*>\s*`\s*,\s*(?:root|document\.getElementById\s*\(\s*['"]root['"]\s*\))\s*\)\s*;?\s*$/,
  ];
  const STRIP_LINES = new Set([
    "const html = htm.bind(h);",
    "const html = htm.bind(h)",
    "const API_URL = '/api/';",
    "const API_URL = \"/api/\";",
    "const API_URL = '/api/'",
    "const API_URL = \"/api/\"",
    "const root = document.getElementById('root');",
    "const root = document.getElementById(\"root\");",
    "const root = document.getElementById('root')",
    "const root = document.getElementById(\"root\")",
    "const { useState, useEffect } = globalThis;",
    "const { useState, useEffect } = globalThis",
    "const {useState, useEffect} = globalThis;",
    "const {useState, useEffect} = globalThis",
    "import { h, render } from 'https://esm.sh/preact@10';",
    "import { useState, useEffect } from 'https://esm.sh/preact@10/hooks';",
    "import htm from 'https://esm.sh/htm@3';",
    "render(App);",
    "render(App)",
    "render(html`<${App} />`, root);",
    "render(html`<${App} />`, root)",
    "render(html`<${App} />`, document.getElementById('root'));",
    "render(html`<${App} />`, document.getElementById('root'))",
  ]);

  out = out
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (STRIP_LINES.has(t)) return false;
      if (STRIP_PATTERNS.some((p) => p.test(t))) return false;
      return true;
    })
    .join("\n");

  // Collapse repeated blank lines.
  out = out.replace(/\n{3,}/g, "\n\n").trim();

  return out;
}

/** Platform-controlled frontend shell. AI generates app.js, which is injected into {{APP_BODY}}. */
const INDEX_HTML_TEMPLATE = `<!DOCTYPE html>
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
  const API_URL = (() => {
    const m = document.location.pathname.match(/^\\/apps\\/([^/]+)/);
    return m ? \`/apps/\${m[1]}/api/\` : '/api/';
  })();

  {{APP_BODY}}

  const root = document.getElementById('root');
  render(html\`<\${App} />\`, root);
    </script>
  </body>
</html>`;

const CODE_SYSTEM = `You generate exactly three artifacts for a Cloudflare app:

1. worker.js
- Full ES module Worker file.
- Must export default { async fetch(request, env) { ... } }.
- Route /api/* to API logic, otherwise return env.ASSETS.fetch(request).
- Use env.DB (D1), env.JWT_SECRET, env.STORAGE (R2) if needed.
- Implement auth and CRUD from the plan.
- API responses: For every /api/* response (including 404 and 500), return JSON only. Use Response.json({ error: '...' }, { status: 404 }) or 400/500 for errors. Never return plain text (e.g. new Response('Not Found')) for API routes.
- Body parsing: When reading the request body with request.json(), use try/catch; on failure return Response.json({ error: 'Invalid JSON' }, { status: 400 }).
- No npm imports; use inline password hash (crypto.subtle.digest SHA-256 with salt) and JWT (HMAC-SHA256).

2. app.js
- This is NOT a full HTML file. Output only JavaScript for insertion into an existing platform-owned HTML template.
- The template ALREADY provides (do not repeat): (1) imports for h, render, useState, useEffect, htm, (2) const html = htm.bind(h), (3) const API_URL, (4) const root = document.getElementById('root'), (5) the single call render(html\`<\${App} />\`, root). You must NEVER output any of these: no const html, no const API_URL, no const root, no render(...), no document.getElementById('root').
- Do NOT output: <!DOCTYPE html>, <html>, <head>, <body>, <script>, import statements, const html = ..., const API_URL = ..., const root = ..., render(...), document.getElementById(...), export default, App.toString = ..., or JSX.
- Do NOT import from 'preact', 'preact/hooks', or 'htm'.
- Do NOT destructure h, render, html, useState, or useEffect from preact, globalThis, or any other global.
- You MUST define const App = () => { ... } as the root component. Child components may be defined before App.
- Hooks (useState, useEffect) may ONLY be called inside component functions, never at the top level of app.js.
- Never place useState(...) or useEffect(...) above the App component definition.
- Use htm tagged template syntax (html\`...\`), not JSX.
- Use camelCase handlers only: onClick, onInput, onChange, onSubmit, onKeyDown.
- Do not include comments explaining the code.
- For fetch calls, always check res.ok before using response data.
- For non-2xx responses, read the JSON error body and surface a user-friendly error message.
- Do not assume every response is a successful payload.
- Use the provided API_URL for every backend request. Never hardcode '/api/' or '/api/...'.

3. migration.sql
- Full SQLite/D1 migration. CREATE TABLE IF NOT EXISTS for each table; add indexes where useful.

Output exactly three blocks:
---FILE:worker.js---
...
---FILE:app.js---
...
---FILE:migration.sql---
...
No other text.`;

export async function generateCode(
  env: Env,
  plan: AppPlan,
  conversation: { role: string; content: string }[]
): Promise<{ workerJs: string; indexHtml: string; migrationSql: string }> {
  const planStr = JSON.stringify(plan, null, 2);
  const convStr = conversation
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const messages = [
    { role: "system" as const, content: CODE_SYSTEM },
    {
      role: "user" as const,
      content: `Plan:\n${planStr}\n\nRecent conversation:\n${convStr}\n\nGenerate the three files now.`,
    },
  ];

  const out = await env.AI.run(MODEL as never, {
    messages,
    stream: false,
  } as never);

  const text = getTextFromAiResponse(out);
  const fileRegex = /---FILE:(\S+)---\s*([\s\S]*?)(?=---FILE:\S+---|$)/g;
  const files: Record<string, string> = {};

  let m: RegExpExecArray | null;
  while ((m = fileRegex.exec(text)) !== null) {
    const name = m[1].trim();
    const content = m[2].trim();

    if (name === "worker.js") files.workerJs = content;
    else if (name === "app.js") files.appJs = content;
    else if (name === "migration.sql") files.migrationSql = content;
  }

  if (!files.workerJs || !files.appJs || !files.migrationSql) {
    throw new Error("AI did not return all three files. Got: " + Object.keys(files).join(", "));
  }

  const workerValidationErrors = validateWorkerJs(files.workerJs);
  if (workerValidationErrors.length > 0) {
    throw new Error("worker.js validation failed: " + workerValidationErrors.join("; "));
  }

  const appBody = normalizeAppBody(files.appJs);

  const validationErrors = validateAppBody(appBody);
  if (validationErrors.length > 0) {
    throw new Error("app.js validation failed: " + validationErrors.join("; "));
  }

  const indexHtml = INDEX_HTML_TEMPLATE.replace("{{APP_BODY}}", appBody);

  return {
    workerJs: files.workerJs,
    indexHtml,
    migrationSql: files.migrationSql,
  };
}