import { Hono } from "hono";
import { authMiddleware } from "../middleware";
import type { Env } from "../types";
import { streamChat } from "../ai";

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
    "SELECT id FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(projectId, user.sub)
    .first();

  if (!project) return c.json({ error: "Project not found" }, 404);

  await c.env.DB.prepare(
    "INSERT INTO chat_messages (project_id, role, content) VALUES (?, ?, ?)"
  )
    .bind(projectId, "user", message)
    .run();

  const history = await c.env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE project_id = ? ORDER BY created_at ASC LIMIT 50"
  )
    .bind(projectId)
    .all();

  const stream = await streamChat(c.env, message, history.results as { role: string; content: string }[]);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.body(stream);
});

app.get("/:projectId/history", async (c) => {
  const projectId = c.req.param("projectId");
  const user = c.get("user");

  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(projectId, user.sub)
    .first();

  if (!project) return c.json({ error: "Project not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, created_at FROM chat_messages WHERE project_id = ? ORDER BY created_at ASC"
  )
    .bind(projectId)
    .all();

  return c.json({ messages: results });
});

app.post("/save-assistant", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { project_id?: string; content?: string };
  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";

  if (!projectId || !content) {
    return c.json({ error: "project_id and content required" }, 400);
  }

  const user = c.get("user");
  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(projectId, user.sub)
    .first();

  if (!project) return c.json({ error: "Project not found" }, 404);

  const { saveAssistantMessage } = await import("../ai");
  await saveAssistantMessage(c.env, projectId, content);
  return c.json({ success: true });
});

export default app;
