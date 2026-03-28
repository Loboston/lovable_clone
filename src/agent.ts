/**
 * Build agent — runs a Claude tool-use loop to generate and deploy a Cloudflare app.
 *
 * Pattern from: https://ampcode.com/notes/how-to-build-an-agent
 * Each iteration: call Claude → if tool_use, execute tools and feed results back → repeat until end_turn.
 */

import type { Env, AppPlan } from "./types";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const AGENT_MODEL = "claude-haiku-4-5-20251001";
const MAX_ITERATIONS = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, string> };
type AnthropicContentBlock = TextBlock | ToolUseBlock;

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

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const AGENT_TOOLS = [
  {
    name: "read_from_r2",
    description: `Read a previously generated file from R2 object storage for this project.

Use this on an update deploy to load the current state of a file before modifying it.
On a first deploy, the files won't exist yet — the tool will return a message saying so, and you should generate the file fresh.

Available files:
- worker.js  — the Cloudflare Worker that handles all /api/* routes (auth, CRUD, etc.)
- index.html — the full frontend UI (Preact + htm + Tailwind, standalone HTML file)
- migration.sql — the D1 (SQLite) schema migration that creates all tables

Returns the complete UTF-8 text of the file, or a message that the file does not exist yet.`,
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          enum: ["worker.js", "index.html", "migration.sql"],
          description:
            'The file to read. Must be one of: "worker.js", "index.html", or "migration.sql".',
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "write_to_r2",
    description: `Write a complete generated file to R2 object storage for this project.

You must call this for all three files — worker.js, index.html, and migration.sql — before calling deploy_from_r2.
Always pass the entire file contents; this overwrites any existing version. Partial updates are not supported.

After writing all three files, call deploy_from_r2 to publish the app.`,
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          enum: ["worker.js", "index.html", "migration.sql"],
          description:
            'The file to write. Must be one of: "worker.js", "index.html", or "migration.sql".',
        },
        content: {
          type: "string",
          description:
            "The complete text content of the file. Must be the full file, not a partial update or diff.",
        },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "deploy_from_r2",
    description: `Deploy the app to Cloudflare by publishing all three files stored in R2.

This tool:
1. Reads worker.js, index.html, and migration.sql from R2 for this project
2. Creates or reuses a D1 (SQLite) database for this project and runs the migration SQL
3. Deploys the Worker script and HTML frontend via Cloudflare Workers for Platforms
4. Returns the live public URL of the deployed app

Only call this after write_to_r2 has been called for all three files in the current session.
If any file is missing from R2, deploy will fail with an error listing the missing files.
If deploy fails (e.g. a syntax error in worker.js), fix the broken file and call deploy_from_r2 again.`,
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// ─── System Prompt ────────────────────────────────────────────────────────────

/** Canonical index.html scaffold shown as a reference in the system prompt. */
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

const AGENT_SYSTEM = `You are a code generation agent for a Cloudflare app builder platform.

Your job: use your tools to generate worker.js, index.html, and migration.sql for the user's app, then deploy them.

## Workflow

FIRST DEPLOY (a Plan is provided in the user message):
1. Generate all three files fresh from the plan. Do NOT call read_from_r2 — the files don't exist yet.
2. Call write_to_r2 for each file.
3. Call deploy_from_r2.

UPDATE DEPLOY (no Plan — "this is an update deploy"):
1. Call read_from_r2 for all three files to load the current state.
2. Determine the scope of changes from the user's last message:
   - PATCH (default): small changes — colors, wording, adding one field, fixing a bug. Only modify the specific parts that need to change. Keep all existing routes, DB schema, auth logic, components, and page structure.
   - REWRITE: only if the user explicitly says "start over", "rebuild from scratch", or requests a completely different app type.
3. Call write_to_r2 for each changed file (always write all three to keep R2 in sync).
4. Call deploy_from_r2.

In PATCH mode: do not add login screens, new pages, or new DB tables unless explicitly asked. Do not rename or remove existing DB tables or API routes.

## File Requirements

### worker.js
- Full ES module. Must export default { async fetch(request, env) { ... } }
- Route /api/* to API logic; all other routes → env.ASSETS.fetch(request)
- Use env.DB (D1), env.JWT_SECRET, env.STORAGE (R2) as needed
- Every /api/* response must use Response.json() — never plain text
- Wrap request.json() in try/catch; return Response.json({ error: 'Invalid JSON' }, { status: 400 }) on failure
- No npm imports — use crypto.subtle inline for password hashing (SHA-256 with salt) and JWT (HMAC-SHA256)

### index.html
- Complete standalone HTML file. Use this scaffold (rewrite the whole file):
${INDEX_HTML_SCAFFOLD}
- Keep exactly: const API_URL = "{{API_BASE}}"; — do NOT replace {{API_BASE}} yourself
- Use exactly these imports (do not change them):
    import { h, render } from 'https://esm.sh/preact@10';
    import { useState, useEffect } from 'https://esm.sh/preact@10/hooks';
    import htm from 'https://esm.sh/htm@3';
    const html = htm.bind(h);
- Do NOT import { html } from preact — preact does not export html. Only h and render.
- Every fetch to the backend must include /api/: fetch(API_URL + '/api/todos'), NOT fetch(API_URL + '/todos')
- Use html\`...\` tagged templates (htm syntax), not JSX
- Mount with:
    const root = document.getElementById('root');
    render(html\`<\${App} />\`, root);
- Use camelCase event handlers: onClick, onInput, onChange, onSubmit
- Child components must receive callbacks as props (e.g. onDelete) — never reference parent-scoped functions directly

### migration.sql
- CREATE TABLE IF NOT EXISTS for each table
- SQLite types only: TEXT, INTEGER, REAL, BLOB — no SERIAL, no AUTO_INCREMENT
- Add indexes where useful

## Self-check before calling deploy_from_r2
- Every fetch() in index.html uses API_URL + '/api/...'
- worker.js returns Response.json() for every /api/* route including errors
- worker.js has env.ASSETS.fetch(request) as the final non-API fallback
- index.html contains exactly: const API_URL = "{{API_BASE}}";
- migration.sql uses SQLite syntax only`;

// ─── Agent ────────────────────────────────────────────────────────────────────

async function callAnthropic(
  apiKey: string,
  messages: AgentMessage[]
): Promise<AnthropicResponse> {
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

  return res.json() as Promise<AnthropicResponse>;
}

function buildInitialMessage(
  projectId: string,
  plan: AppPlan | null,
  conversation: { role: string; content: string }[],
  isFirstDeploy: boolean
): string {
  const convStr = conversation
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const planSection = plan
    ? `Plan:\n${JSON.stringify(plan, null, 2)}`
    : `No plan — this is an update deploy. Read the existing files from R2 first, then apply only the changes the user requested.`;

  const instruction = isFirstDeploy
    ? "Generate all three files fresh from the plan above and deploy."
    : "Read the existing files from R2, patch only what the user asked for, then deploy.";

  return `${planSection}\n\nRecent conversation:\n${convStr}\n\nProject ID: ${projectId}\n\n${instruction}`;
}

export async function runBuildAgent(
  env: Env,
  projectId: string,
  plan: AppPlan | null,
  conversation: { role: string; content: string }[],
  isFirstDeploy: boolean,
  deployFn: DeployFn
): Promise<{ deployedUrl: string; d1DatabaseId: string; workerName: string }> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your-anthropic-api-key-here") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — add it to wrangler.toml or run: wrangler secret put ANTHROPIC_API_KEY"
    );
  }

  const prefix = `projects/${projectId}/`;
  let deployResult: { deployedUrl: string; d1DatabaseId: string; workerName: string } | null =
    null;

  // ── Tool execution ──────────────────────────────────────────────────────────

  async function executeTool(name: string, input: Record<string, string>): Promise<string> {
    if (name === "read_from_r2") {
      const obj = await env.CODE_BUCKET.get(`${prefix}${input.filename}`);
      if (!obj) {
        return `${input.filename} does not exist yet — generate it fresh.`;
      }
      return obj.text();
    }

    if (name === "write_to_r2") {
      if (!input.filename || !input.content) {
        return "Error: filename and content are required";
      }
      await env.CODE_BUCKET.put(`${prefix}${input.filename}`, input.content);
      return `${input.filename} written successfully.`;
    }

    if (name === "deploy_from_r2") {
      const [workerObj, htmlObj, sqlObj] = await Promise.all([
        env.CODE_BUCKET.get(`${prefix}worker.js`),
        env.CODE_BUCKET.get(`${prefix}index.html`),
        env.CODE_BUCKET.get(`${prefix}migration.sql`),
      ]);

      const missing = (
        [
          !workerObj && "worker.js",
          !htmlObj && "index.html",
          !sqlObj && "migration.sql",
        ] as (string | false)[]
      ).filter(Boolean) as string[];

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
        return `Deploy failed: ${msg}. Fix the relevant file and call deploy_from_r2 again.`;
      }
    }

    return `Unknown tool: ${name}`;
  }

  // ── Agent loop ──────────────────────────────────────────────────────────────

  const messages: AgentMessage[] = [
    {
      role: "user",
      content: buildInitialMessage(projectId, plan, conversation, isFirstDeploy),
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callAnthropic(apiKey, messages);

    // Append the assistant's full response (may include text + tool_use blocks)
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      if (!deployResult) {
        throw new Error(
          "Agent finished without deploying. The deploy_from_r2 tool was not called."
        );
      }
      return deployResult;
    }

    if (response.stop_reason === "tool_use") {
      // Execute all tool calls in this turn, then feed all results back in one user message
      const toolResults: ToolResultBlock[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    if (response.stop_reason === "max_tokens") {
      throw new Error("Agent exceeded token limit. Try a simpler app description.");
    }
  }

  throw new Error("Agent exceeded maximum iterations without completing the build.");
}
