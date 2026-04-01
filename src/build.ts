import type { Env } from "./types";
import { runBuildAgent } from "./ai";
import type { AgentResult, DeployFn, StorageAdapter } from "./ai";
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
export function wrapGeneratedWorkerForErrors(workerJs: string): string {
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

/**
 * Processes raw agent-generated files and deploys them to Cloudflare.
 * Called by the agent's deploy_from_r2 tool via the deployFn callback.
 */
async function deployFiles(
  env: Env,
  projectId: string,
  workerJs: string,
  indexHtml: string,
  migrationSql: string,
  baseUrl: string
): Promise<{ deployedUrl: string; d1DatabaseId: string; workerName: string }> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  // Wrap worker with error handler and inject API base path
  const workerJsWrapped = wrapGeneratedWorkerForErrors(workerJs);
  const apiBase = `/apps/${projectId}`;
  const indexHtmlProcessed = indexHtml.replace(/\{\{API_BASE\}\}/g, apiBase);

  // Reuse existing D1 database if already provisioned for this project
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
    indexHtml: indexHtmlProcessed,
    d1DatabaseId,
    r2BucketName: R2_BUCKET_NAME,
    jwtSecret,
  });

  const deployedUrl = `${baseUrl}/apps/${projectId}/`;
  return { deployedUrl, d1DatabaseId, workerName };
}

export async function buildProject(
  env: Env,
  projectId: string,
  projectName: string,
  baseUrl: string,
  onProgress?: (message: string) => Promise<void>
): Promise<AgentResult> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set");
  }

  // Fetch full chat history to give the agent context
  const history = await env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE project_id = ? ORDER BY created_at ASC"
  )
    .bind(projectId)
    .all();

  const conversation = (history.results ?? []) as { role: string; content: string }[];

  // Check if files exist in R2 to determine first vs update deploy
  const existingWorker = await env.CODE_BUCKET.get(`projects/${projectId}/worker.js`);
  const isFirstDeploy = existingWorker === null;

  const prefix = `projects/${projectId}/`;
  const storage: StorageAdapter = {
    async readFile(filename) {
      const obj = await env.CODE_BUCKET.get(`${prefix}${filename}`);
      return obj ? obj.text() : null;
    },
    async writeFile(filename, content) {
      await env.CODE_BUCKET.put(`${prefix}${filename}`, content);
    },
  };

  const deployFn: DeployFn = (workerJs, indexHtml, migrationSql) =>
    deployFiles(env, projectId, workerJs, indexHtml, migrationSql, baseUrl);

  return await runBuildAgent(env.ANTHROPIC_API_KEY, storage, deployFn, projectId, conversation, isFirstDeploy, onProgress);
}
