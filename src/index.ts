import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import authRoutes from "./routes/auth";
import chatRoutes from "./routes/chat";
import projectRoutes from "./routes/projects";
import uiApp from "./ui";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", credentials: true }));

// Mount UI app at root: serves GET / (HTML) and GET /builder-app.js (script)
app.route("/", uiApp);

app.route("/api/auth", authRoutes);
app.route("/api/chat", chatRoutes);
app.route("/api/projects", projectRoutes);

app.get("/apps/:projectId/*", async (c) => {
  const projectId = c.req.param("projectId");
  const rest = c.req.param("*") ?? "";
  const workerName = `app-${projectId}`;

  const worker = c.env.DISPATCHER;
  if (!worker?.get) {
    return c.json({ error: "Dispatcher not configured" }, 500);
  }
  const target = worker.get(workerName);
  if (!target) {
    return c.json({ error: "App not found or not deployed" }, 404);
  }

  const url = new URL(c.req.url);
  const pathPrefix = `/apps/${projectId}`;
  const newPath = url.pathname.startsWith(pathPrefix)
    ? url.pathname.slice(pathPrefix.length) || "/"
    : "/";
  const newUrl = new URL(newPath, url.origin);
  newUrl.search = url.search;

  const req = new Request(newUrl.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  });

  const res = await target.fetch(req);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
});

app.get("/apps/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const workerName = `app-${projectId}`;
  const worker = c.env.DISPATCHER;
  if (!worker?.get) return c.json({ error: "Dispatcher not configured" }, 500);
  const target = worker.get(workerName);
  if (!target) return c.json({ error: "App not found or not deployed" }, 404);
  const url = new URL(c.req.url);
  const newUrl = new URL("/", url.origin);
  newUrl.search = url.search;
  const req = new Request(newUrl.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  });
  const res = await target.fetch(req);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
});

export default app;
