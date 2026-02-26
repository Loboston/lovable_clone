import { Hono } from "hono";
import { authMiddleware } from "../middleware";
import type { Env } from "../types";
import { randomId } from "../auth";
import { buildProject } from "../build";
import { deleteProject as teardownProject } from "../teardown";

const app = new Hono<{ Bindings: Env; Variables: { user: { sub: string; email: string } } }>();

app.use("/*", authMiddleware());

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = typeof body.name === "string" ? body.name.trim() : "Untitled Project";
  const user = c.get("user");
  const id = randomId();

  await c.env.DB.prepare(
    "INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)"
  )
    .bind(id, user.sub, name)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT id, user_id, name, status, deployed_url, created_at FROM projects WHERE id = ?"
  )
    .bind(id)
    .first();

  return c.json({ project: row });
});

app.get("/", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT id, user_id, name, status, deployed_url, created_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC"
  )
    .bind(user.sub)
    .all();

  return c.json({ projects: results });
});

app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const row = await c.env.DB.prepare(
    "SELECT id, user_id, name, status, deployed_url, d1_database_id, worker_name, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.sub)
    .first();

  if (!row) return c.json({ error: "Project not found" }, 404);
  return c.json({ project: row });
});

app.post("/:id/build", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const project = await c.env.DB.prepare(
    "SELECT id, user_id, name, status FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.sub)
    .first<{ id: string; user_id: string; name: string; status: string }>();

  if (!project) return c.json({ error: "Project not found" }, 404);

  await c.env.DB.prepare("UPDATE projects SET status = ? WHERE id = ?")
    .bind("building", id)
    .run();

  try {
    const baseUrl = new URL(c.req.url).origin;
    const result = await buildProject(c.env, id, project.name, baseUrl);
    await c.env.DB.prepare(
      "UPDATE projects SET status = ?, deployed_url = ?, d1_database_id = ?, worker_name = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind("deployed", result.deployedUrl, result.d1DatabaseId, result.workerName, id)
      .run();
    return c.json({ success: true, deployed_url: result.deployedUrl });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Build failed";
    await c.env.DB.prepare("UPDATE projects SET status = ? WHERE id = ?")
      .bind("error", id)
      .run();
    return c.json({ error: message }, 500);
  }
});

app.get("/:id/files", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.sub)
    .first();

  if (!project) return c.json({ error: "Project not found" }, 404);

  const prefix = `projects/${id}/`;
  const list = await c.env.CODE_BUCKET.list({ prefix });
  const files = (list.objects || []).map((o) => o.key.slice(prefix.length));

  return c.json({ files });
});

app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const project = await c.env.DB.prepare(
    "SELECT id, worker_name, d1_database_id FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.sub)
    .first<{ id: string; worker_name: string | null; d1_database_id: string | null }>();

  if (!project) return c.json({ error: "Project not found" }, 404);

  try {
    await teardownProject(c.env, id, project.worker_name, project.d1_database_id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Teardown failed";
    return c.json({ error: message }, 500);
  }

  await c.env.DB.prepare("DELETE FROM chat_messages WHERE project_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();

  return c.json({ success: true });
});

export default app;
