import { Hono } from "hono";
import { hashPassword, randomId, createJWT } from "../auth";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

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
  if (!secret) return c.json({ error: "Server misconfiguration" }, 500);
  const token = await createJWT({ sub: user.id, email: user.email }, secret);
  return c.json({ token, user: { id: user.id, email: user.email } });
});

export default app;
