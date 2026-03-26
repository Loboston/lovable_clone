import type { Env } from "./types";
import { generatePlan, generateCode } from "./ai";
import {
  getOrCreateD1Database,
  runD1Query,
  deployUserWorker,
  isEmptyOrNoQuery,
} from "./cf-api";
import { randomId } from "./auth";

const NAMESPACE = "user-apps";
const R2_BUCKET_NAME = "user-code";

/**
 * Generated app workers are produced by an LLM; runtime failures can surface to the user
 * as a generic 500. Wrap the worker's exported `fetch()` so we return JSON with the
 * actual error message. This helps us debug (and helps the frontend show a useful error).
 *
 * Note: this only affects newly built/redeployed apps.
 */
function wrapGeneratedWorkerForErrors(workerJs: string): string {
  const startMarker = "// --- platform error wrapper start ---";
  if (workerJs.includes(startMarker)) return workerJs;

  const exportDefaultObj = "export default {";
  if (!workerJs.includes(exportDefaultObj)) return workerJs;

  // Replace the default export object with a local const so we can wrap it.
  const replaced = workerJs.replace(exportDefaultObj, "const generatedWorker = {");

  // Append wrapper export. Keep it plain JS (generatedWorker is runtime data).
  return (
    replaced +
    `\n\n${startMarker}\n` +
    `export default {\n` +
    `  async fetch(request, env, ctx) {\n` +
    `    try {\n` +
    `      const w = generatedWorker;\n` +
    `      if (!w || typeof w.fetch !== "function") {\n` +
    `        throw new Error("Generated worker missing fetch()");\n` +
    `      }\n` +
    `      return await w.fetch(request, env, ctx);\n` +
    `    } catch (err) {\n` +
    `      const msg = err instanceof Error ? err.message : String(err);\n` +
    `      const stack = err instanceof Error ? err.stack : undefined;\n` +
    `      return Response.json({ error: msg, stack }, { status: 500 });\n` +
    `    }\n` +
    `  },\n` +
    `};\n` +
    `// --- platform error wrapper end ---\n`
  );
}

export async function buildProject(
  env: Env,
  projectId: string,
  projectName: string,
  baseUrl: string
): Promise<{ deployedUrl: string; d1DatabaseId: string; workerName: string }> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set");
  }

  const history = await env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE project_id = ? ORDER BY created_at ASC"
  )
    .bind(projectId)
    .all();

  const conversation = (history.results ?? []) as { role: string; content: string }[];
  const plan = await generatePlan(env, conversation);
  const { workerJs, indexHtml: rawIndexHtml, migrationSql } = await generateCode(env, plan, conversation);
  const workerJsWrapped = wrapGeneratedWorkerForErrors(workerJs);

  // Replace {{API_BASE}} so the app's fetch() calls hit the same-origin API under /apps/:projectId/
  // We intentionally do NOT include '/api' here, because generated code commonly uses `${API_URL}/api/...`.
  // This keeps the final path as /apps/:projectId/api/... instead of /apps/:projectId/api//api/...
  const apiBase = `/apps/${projectId}`;
  const indexHtml = rawIndexHtml.replace(/\{\{API_BASE\}\}/g, apiBase);

  const prefix = `projects/${projectId}/`;
  await env.CODE_BUCKET.put(`${prefix}worker.js`, workerJsWrapped);
  await env.CODE_BUCKET.put(`${prefix}index.html`, indexHtml);
  await env.CODE_BUCKET.put(`${prefix}migration.sql`, migrationSql);

  const dbName = `app-${projectId}`;
  const existingRow = await env.DB.prepare(
    "SELECT d1_database_id FROM projects WHERE id = ?"
  )
    .bind(projectId)
    .first<{ d1_database_id: string | null }>();

  const existingId = existingRow?.d1_database_id?.trim() ?? "";
  const d1DatabaseId =
    existingId.length > 0
      ? existingId
      : (await getOrCreateD1Database(accountId, apiToken, dbName)).uuid;

  const statements = migrationSql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !isEmptyOrNoQuery(s));
  for (const sql of statements) {
    await runD1Query(accountId, apiToken, d1DatabaseId, sql + ";");
  }
  const migrationTrimmed = migrationSql.trim();
  if (statements.length === 0 && migrationTrimmed && !isEmptyOrNoQuery(migrationTrimmed)) {
    const sql = migrationTrimmed.endsWith(";") ? migrationTrimmed : migrationTrimmed + ";";
    await runD1Query(accountId, apiToken, d1DatabaseId, sql);
  }

  const workerName = `app-${projectId}`;
  const jwtSecret = randomId() + randomId();

  await deployUserWorker({
    accountId,
    apiToken,
    namespace: NAMESPACE,
    scriptName: workerName,
    scriptContent: workerJsWrapped,
    indexHtml,
    d1DatabaseId,
    r2BucketName: R2_BUCKET_NAME,
    jwtSecret,
  });

  const deployedUrl = `${baseUrl}/apps/${projectId}/`;
  return { deployedUrl, d1DatabaseId, workerName };
}
