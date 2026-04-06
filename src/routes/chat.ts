import { Hono } from "hono";
import { authMiddleware } from "../middleware";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env; Variables: { user: { sub: string; email: string } } }>();

app.use("/*", authMiddleware());

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { project_id?: string; message?: string };
  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!projectId || !message) {
    return c.json({ error: "project_id and message required" }, 400);
  }

  const user = c.get("user");

  const project = await c.env.DB.prepare(
    "SELECT id, name, status, updated_at FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(projectId, user.sub)
    .first<{ id: string; name: string; status: string; updated_at: string }>();

  if (!project) return c.json({ error: "Project not found" }, 404);

  if (project.status === "building" || project.status === "thinking") {
    // Auto-expire builds stuck for more than 10 minutes
    const updatedAt = new Date(project.updated_at + "Z").getTime();
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    if (updatedAt > tenMinutesAgo) {
      return c.json({ error: "A build is already in progress for this project" }, 409);
    }
    await c.env.DB.prepare(
      "UPDATE projects SET status = 'idle', updated_at = datetime('now') WHERE id = ?"
    )
      .bind(projectId)
      .run();
    project.status = "idle";
  }

  // Save the user message
  await c.env.DB.prepare(
    "INSERT INTO chat_messages (project_id, role, content) VALUES (?, ?, ?)"
  )
    .bind(projectId, "user", message)
    .run();

  // Set project to "thinking" so the UI knows the agent is running
  const previousStatus = project.status;
  await c.env.DB.prepare(
    "UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind("thinking", projectId)
    .run();

  // Trigger the workflow — it runs the agent, saves its response, and updates status
  const baseUrl = new URL(c.req.url).origin;
  await c.env.BUILD_WORKFLOW.create({
    params: { projectId, projectName: project.name, baseUrl, previousStatus },
  });

  return c.json({ success: true });
});

app.get("/:projectId/history", async (c) => {
  const projectId = c.req.param("projectId");
  const user = c.get("user");
  const since = c.req.query("since");

  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(projectId, user.sub)
    .first();

  if (!project) return c.json({ error: "Project not found" }, 404);

  const { results } = since
    ? await c.env.DB.prepare(
        "SELECT id, role, content, created_at FROM chat_messages WHERE project_id = ? AND created_at > ? ORDER BY created_at ASC"
      )
        .bind(projectId, since)
        .all()
    : await c.env.DB.prepare(
        "SELECT id, role, content, created_at FROM chat_messages WHERE project_id = ? ORDER BY created_at ASC"
      )
        .bind(projectId)
        .all();

  return c.json({ messages: results });
});

export default app;
