import { Hono } from "hono";
import type { Env } from "./types";
import { builderScript } from "./builderScript";

/** Builder UI HTML – shell only; the app logic is loaded from /builder-app.js */
export const builderHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lovable-style App Builder</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">
  <div id="root"></div>
  <script type="module" src="/builder-app.js"></script>
</body>
</html>`;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.html(builderHtml);
});

app.get("/builder-app.js", (c) => {
  return c.body(builderScript, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
  });
});

export default app;
