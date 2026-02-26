import type { Env } from "./types";
import { generatePlan, generateCode } from "./ai";
import {
  createD1Database,
  runD1Query,
  deployUserWorker,
} from "./cf-api";
import { randomId } from "./auth";

const NAMESPACE = "user-apps";
const R2_BUCKET_NAME = "user-code";

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
  const { workerJs, indexHtml, migrationSql } = await generateCode(env, plan, conversation);

  const prefix = `projects/${projectId}/`;
  await env.CODE_BUCKET.put(`${prefix}worker.js`, workerJs);
  await env.CODE_BUCKET.put(`${prefix}index.html`, indexHtml);
  await env.CODE_BUCKET.put(`${prefix}migration.sql`, migrationSql);

  const dbName = `app-${projectId}`;
  const { uuid: d1DatabaseId } = await createD1Database(accountId, apiToken, dbName);

  const statements = migrationSql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await runD1Query(accountId, apiToken, d1DatabaseId, sql + ";");
  }
  if (statements.length === 0 && migrationSql.trim()) {
    const sql = migrationSql.trim();
    await runD1Query(accountId, apiToken, d1DatabaseId, sql.endsWith(";") ? sql : sql + ";");
  }

  const workerName = `app-${projectId}`;
  const jwtSecret = randomId() + randomId();

  await deployUserWorker({
    accountId,
    apiToken,
    namespace: NAMESPACE,
    scriptName: workerName,
    scriptContent: workerJs,
    indexHtml,
    d1DatabaseId,
    r2BucketName: R2_BUCKET_NAME,
    jwtSecret,
  });

  const deployedUrl = `${baseUrl}/apps/${projectId}/`;
  return { deployedUrl, d1DatabaseId, workerName };
}
