import { Hono } from "hono";
import { hashPassword, randomId, createJWT, verifyPassword } from "../auth";
import { authMiddleware } from "../middleware";
import type { Env, JWTPayload } from "../types";

const app = new Hono<{ Bindings: Env; Variables: { user: JWTPayload } }>();

app.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const salt = randomId();
  const password_hash = await hashPassword(password, salt);
  const id = randomId();

  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)"
    )
      .bind(id, email, password_hash, salt)
      .run();
  } catch (e: unknown) {
    const err = e as { message?: string };
    if (err?.message?.includes("UNIQUE")) {
      return c.json({ error: "Email already registered" }, 409);
    }
    throw e;
  }

  const secret = c.env.PLATFORM_JWT_SECRET;
  // Temporary: confirm JWT secret is available in dev
  console.log("[auth/register] PLATFORM_JWT_SECRET present:", !!secret, "type:", typeof secret);
  if (!secret) return c.json({ error: "Server misconfiguration" }, 500);
  const token = await createJWT({ sub: id, email }, secret);
  return c.json({ token, user: { id, email } });
});

app.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const user = await c.env.DB.prepare(
    "SELECT id, email, password_hash, salt FROM users WHERE email = ?"
  )
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; salt: string }>();

  if (!user) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const { verifyPassword } = await import("../auth");
  const ok = await verifyPassword(password, user.password_hash, user.salt);
  if (!ok) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const secret = c.env.PLATFORM_JWT_SECRET;
  // Temporary: confirm JWT secret is available in dev
  console.log("[auth/login] PLATFORM_JWT_SECRET present:", !!secret, "type:", typeof secret);
  if (!secret) return c.json({ error: "Server misconfiguration" }, 500);
  const token = await createJWT({ sub: user.id, email: user.email }, secret);
  return c.json({ token, user: { id: user.id, email: user.email } });
});

app.get("/me", authMiddleware(), async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    "SELECT id, email, created_at FROM users WHERE id = ?"
  )
    .bind(user.sub)
    .first<{ id: string; email: string; created_at: string }>();
  if (!row) return c.json({ error: "User not found" }, 404);
  return c.json({ user: row });
});

app.delete("/account", authMiddleware(), async (c) => {
  const user = c.get("user");

  // Get all projects to tear down CF resources
  const { results: userProjects } = await c.env.DB.prepare(
    "SELECT id, worker_name, d1_database_id FROM projects WHERE user_id = ?"
  )
    .bind(user.sub)
    .all<{ id: string; worker_name: string | null; d1_database_id: string | null }>();

  const { deleteProject } = await import("../teardown");
  for (const project of userProjects) {
    try {
      await deleteProject(c.env, project.id, project.worker_name, project.d1_database_id);
    } catch (err) {
      console.error("Teardown failed for project", project.id, err);
    }
    await c.env.DB.prepare("DELETE FROM build_events WHERE project_id = ?").bind(project.id).run();
    await c.env.DB.prepare("DELETE FROM build_logs WHERE project_id = ?").bind(project.id).run();
    await c.env.DB.prepare("DELETE FROM chat_messages WHERE project_id = ?").bind(project.id).run();
    await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id).run();
  }

  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.sub).run();
  return c.json({ success: true });
});

app.post("/change-password", authMiddleware(), async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return c.json({ error: "Current and new password required" }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: "New password must be at least 8 characters" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT password_hash, salt FROM users WHERE id = ?"
  )
    .bind(user.sub)
    .first<{ password_hash: string; salt: string }>();

  if (!row) return c.json({ error: "User not found" }, 404);

  const ok = await verifyPassword(currentPassword, row.password_hash, row.salt);
  if (!ok) return c.json({ error: "Current password is incorrect" }, 401);

  const newSalt = randomId();
  const newHash = await hashPassword(newPassword, newSalt);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
    .bind(newHash, newSalt, user.sub)
    .run();

  return c.json({ success: true });
});

export default app;
