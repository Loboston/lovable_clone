import { Hono } from "hono";
import { authMiddleware } from "../middleware";
import type { Env } from "../types";
import { randomId } from "../auth";
import { deleteProject as teardownProject } from "../teardown";

const app = new Hono<{ Bindings: Env; Variables: { user: { sub: string; email: string } } }>();

app.use("/*", authMiddleware());

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
  const user = c.get("user");
  const id = randomId();

  let name = "Untitled Project";
  if (typeof body.description === "string" && body.description.trim()) {
    const desc = body.description.trim();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": c.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 30,
          messages: [
            {
              role: "user",
              content: `Generate a short 3-6 word project name for this app. Output ONLY the name, nothing else:\n"${desc.slice(0, 300)}"`,
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}`);
      const data = await res.json() as { content?: Array<{ text?: string }> };
      const generated = (data.content?.[0]?.text?.trim() ?? "").replace(/^["']+|["']+$/g, "");
      if (!generated) throw new Error("empty response");
      name = generated.slice(0, 60);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Project name generation failed:", errMsg);
      name = desc.slice(0, 40);
    }
  } else if (typeof body.name === "string" && body.name.trim()) {
    name = body.name.trim();
  }

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
  if (project.status === "building") return c.json({ error: "Build already in progress" }, 409);

  await c.env.DB.prepare("UPDATE projects SET status = ? WHERE id = ?")
    .bind("building", id)
    .run();

  const baseUrl = new URL(c.req.url).origin;
  await c.env.BUILD_WORKFLOW.create({ params: { projectId: id, projectName: project.name, baseUrl } });

  return c.json({ success: true, status: "building" });
});

app.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const since = c.req.query("since");

  const project = await c.env.DB.prepare(
    "SELECT id, status FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.sub)
    .first<{ id: string; status: string }>();

  if (!project) return c.json({ error: "Project not found" }, 404);

  const { results } = since
    ? await c.env.DB.prepare(
        "SELECT id, message, created_at FROM build_events WHERE project_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 50"
      )
        .bind(id, since)
        .all()
    : await c.env.DB.prepare(
        "SELECT id, message, created_at FROM build_events WHERE project_id = ? ORDER BY created_at ASC LIMIT 50"
      )
        .bind(id)
        .all();

  return c.json({ events: results, status: project.status });
});

app.get("/:id/stream", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const since = c.req.query("since") ?? "";

  const project = await c.env.DB.prepare(
    "SELECT id, status FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.sub)
    .first<{ id: string; status: string }>();

  if (!project) return c.json({ error: "Project not found" }, 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (data: unknown) =>
    writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

  (async () => {
    let lastAt = since;
    const deadline = Date.now() + 25_000;
    try {
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 1000));

        const { results } = lastAt
          ? await c.env.DB.prepare(
              "SELECT message, created_at FROM build_events WHERE project_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 50"
            )
              .bind(id, lastAt)
              .all()
          : await c.env.DB.prepare(
              "SELECT message, created_at FROM build_events WHERE project_id = ? ORDER BY created_at ASC LIMIT 50"
            )
              .bind(id)
              .all();

        for (const ev of results as { message: string; created_at: string }[]) {
          await send({ type: "event", message: ev.message, created_at: ev.created_at });
          lastAt = ev.created_at;
        }

        const proj = await c.env.DB.prepare(
          "SELECT status, deployed_url FROM projects WHERE id = ?"
        )
          .bind(id)
          .first<{ status: string; deployed_url: string | null }>();

        if (proj?.status === "deployed" || proj?.status === "error") {
          await send({ type: "status", status: proj.status, deployed_url: proj.deployed_url ?? null });
          break;
        }

        await send({ type: "heartbeat", lastAt });
      }
    } catch (_) {
      // client disconnected
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
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

app.get("/:id/file/:filename", async (c) => {
  const id = c.req.param("id");
  const filename = c.req.param("filename");
  const user = c.get("user");

  if (!["worker.js", "index.html", "migration.sql"].includes(filename)) {
    return c.json({ error: "Invalid filename" }, 400);
  }

  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.sub)
    .first();

  if (!project) return c.json({ error: "Project not found" }, 404);

  const obj = await c.env.CODE_BUCKET.get(`projects/${id}/${filename}`);
  if (!obj) return c.json({ error: "File not found" }, 404);

  const text = await obj.text();
  return new Response(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
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

  // Best-effort CF resource cleanup — don't block DB delete if it fails
  try {
    await teardownProject(c.env, id, project.worker_name, project.d1_database_id);
  } catch (err: unknown) {
    console.error("Teardown failed (continuing with DB delete):", err);
  }

  await c.env.DB.prepare("DELETE FROM build_events WHERE project_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM build_logs WHERE project_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM chat_messages WHERE project_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();

  return c.json({ success: true });
});

export default app;
