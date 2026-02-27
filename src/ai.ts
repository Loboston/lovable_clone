import type { Env, AppPlan } from "./types";

const MODEL = "@cf/zai-org/glm-4.7-flash";


const CHAT_SYSTEM =
  "You are a friendly assistant for an app builder. The user describes the app they want. " +
  "You must ONLY give a short acknowledgment (1–2 sentences). Examples: 'Got it, I've noted you want a todo app. Click Deploy when you're ready to build it.' or 'Noted! Add more details if you like, or click Deploy to generate your app.' " +
  "Do NOT output any code, file contents, HTML, markdown code blocks, or images. Do NOT start with 'Sure!' or 'Here is...' and then paste code. Just acknowledge briefly.";

function historyToPrompt(history: { role: string; content: string }[], userMessage: string): string {
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
      content:
        "Output the JSON plan only, no other text.",
    },
  ];

  const out = await env.AI.run(MODEL as never, {
    messages,
    stream: false,
  } as never);

  const text = typeof out === "string" ? out : (out as { response?: string })?.response ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : text;
  let plan: AppPlan;
  try {
    plan = JSON.parse(jsonStr) as AppPlan;
  } catch {
    throw new Error("AI did not return valid plan JSON: " + text.slice(0, 500));
  }
  if (!plan.appName || !plan.pages || !plan.dataModel?.tables) {
    throw new Error("Plan missing required fields: " + JSON.stringify(plan));
  }
  return plan;
}

const CODE_SYSTEM = `You generate a full-stack app for Cloudflare:
1. worker.js - ES module. export default { async fetch(request, env) { ... } }. Route /api/* to API logic, else return env.ASSETS.fetch(request). Use env.DB (D1), env.JWT_SECRET, env.STORAGE (R2) if needed. Implement auth (register/login) and CRUD from the plan. No imports from npm; use inline password hash (crypto.subtle.digest SHA-256 with salt) and JWT (HMAC-SHA256).
2. index.html - Single file. Use Preact via ESM: import { h, render } from 'https://esm.sh/preact@10'; import htm from 'https://esm.sh/htm@3'; const html = htm.bind(h); Tailwind via CDN. Call /api/* on same origin.
3. migration.sql - SQLite/D1: CREATE TABLE IF NOT EXISTS for each table; add indexes.

Output exactly three blocks, each starting with a line ---FILE:filename--- and ending before the next ---FILE:--- or end of message. No other text.`;

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
    { role: "user" as const, content: `Plan:\n${planStr}\n\nRecent conversation:\n${convStr}\n\nGenerate the three files now.` },
  ];

  const out = await env.AI.run(MODEL as never, {
    messages,
    stream: false,
  } as never);

  const text = typeof out === "string" ? out : (out as { response?: string })?.response ?? "";
  const fileRegex = /---FILE:(\S+)---\s*([\s\S]*?)(?=---FILE:\S+---|$)/g;
  const files: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = fileRegex.exec(text)) !== null) {
    const name = m[1].trim();
    const content = m[2].trim();
    if (name === "worker.js") files.workerJs = content;
    else if (name === "index.html") files.indexHtml = content;
    else if (name === "migration.sql") files.migrationSql = content;
  }

  if (!files.workerJs || !files.indexHtml || !files.migrationSql) {
    throw new Error("AI did not return all three files. Got: " + Object.keys(files).join(", "));
  }
  return {
    workerJs: files.workerJs,
    indexHtml: files.indexHtml,
    migrationSql: files.migrationSql,
  };
}
