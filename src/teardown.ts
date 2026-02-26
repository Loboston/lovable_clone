import type { Env } from "./types";
import { deleteD1Database, deleteUserWorker } from "./cf-api";

const NAMESPACE = "user-apps";

export async function deleteProject(
  env: Env,
  projectId: string,
  workerName: string | null,
  d1DatabaseId: string | null
): Promise<void> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set");
  }

  if (workerName) {
    try {
      await deleteUserWorker(accountId, apiToken, NAMESPACE, workerName);
    } catch (e) {
      console.warn("Delete Worker failed (may not exist):", e);
    }
  }

  if (d1DatabaseId) {
    try {
      await deleteD1Database(accountId, apiToken, d1DatabaseId);
    } catch (e) {
      console.warn("Delete D1 failed (may not exist):", e);
    }
  }

  const prefix = `projects/${projectId}/`;
  const list = await env.CODE_BUCKET.list({ prefix });
  const objects = list.objects ?? [];
  for (const obj of objects) {
    await env.CODE_BUCKET.delete(obj.key);
  }
}
