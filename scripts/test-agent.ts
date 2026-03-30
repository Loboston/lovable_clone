/**
 * CLI wrapper for testing the build agent locally against real Cloudflare.
 *
 * Usage:
 *   npm run test-agent -- "Build a todo app with user auth"
 *
 * Required env vars (set in shell or .env):
 *   ANTHROPIC_API_KEY     — your Anthropic key
 *   CF_ACCOUNT_ID         — Cloudflare account ID
 *   CF_API_TOKEN          — Cloudflare API token (needs R2, D1, Workers for Platforms permissions)
 *   CF_BUCKET_NAME        — R2 bucket name (default: user-code)
 *   PLATFORM_BASE_URL     — public URL of the deployed platform Worker (default: https://lovable-platform.loboar.workers.dev)
 *
 * This script imports runBuildAgent directly from src/agent.ts — the exact same code
 * the web app uses — and wires it up with REST API implementations of StorageAdapter
 * and DeployFn instead of Worker bindings.
 */

import { runBuildAgent } from "../src/agent";
import type { StorageAdapter, DeployFn } from "../src/agent";
import {
  r2GetObject,
  r2PutObject,
  getOrCreateD1Database,
  runD1Query,
  deployUserWorker,
  isEmptyOrNoQuery,
} from "../src/cf-api";
import { wrapGeneratedWorkerForErrors } from "../src/build";
import type { AppPlan } from "../src/types";

// ─── Config ───────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? "3cd12c15afa8ca3571132632118ffc15";
const CF_API_TOKEN = process.env.CF_API_TOKEN ?? "QK14FjHd3DbzFu7heSBwMXCxT8uQR8V_ujDQjLGU";
const CF_BUCKET_NAME = process.env.CF_BUCKET_NAME ?? "user-code";
const PLATFORM_BASE_URL =
  process.env.PLATFORM_BASE_URL ?? "https://lovable-platform.loboar.workers.dev";
const NAMESPACE = "user-apps";

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// ─── Storage adapter (Cloudflare R2 REST API) ─────────────────────────────────

function makeRestStorage(projectId: string): StorageAdapter {
  const prefix = `projects/${projectId}/`;
  return {
    async readFile(filename) {
      console.log(`  [R2] GET ${prefix}${filename}`);
      return r2GetObject(CF_ACCOUNT_ID, CF_API_TOKEN, CF_BUCKET_NAME, `${prefix}${filename}`);
    },
    async writeFile(filename, content) {
      console.log(`  [R2] PUT ${prefix}${filename} (${content.length} chars)`);
      await r2PutObject(CF_ACCOUNT_ID, CF_API_TOKEN, CF_BUCKET_NAME, `${prefix}${filename}`, content);
    },
  };
}

// ─── Deploy function (same logic as build.ts, without platform DB lookup) ────

function makeDeployFn(projectId: string): DeployFn {
  return async (workerJs, indexHtml, migrationSql) => {
    console.log("\n[deploy] Wrapping worker and processing index.html...");
    const workerJsWrapped = wrapGeneratedWorkerForErrors(workerJs);
    const apiBase = `/apps/${projectId}`;
    const indexHtmlProcessed = indexHtml.replace(/\{\{API_BASE\}\}/g, apiBase);

    console.log("[deploy] Creating / reusing D1 database...");
    const dbName = `app-${projectId}`;
    const { uuid: d1DatabaseId } = await getOrCreateD1Database(CF_ACCOUNT_ID, CF_API_TOKEN, dbName);
    console.log(`[deploy] D1 database: ${d1DatabaseId}`);

    console.log("[deploy] Running migration SQL...");
    const statements = migrationSql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !isEmptyOrNoQuery(s));

    for (const sql of statements) {
      await runD1Query(CF_ACCOUNT_ID, CF_API_TOKEN, d1DatabaseId, sql + ";");
    }

    const workerName = `app-${projectId}`;
    const jwtSecret = randomId() + randomId();
    console.log(`[deploy] Deploying Worker: ${workerName}`);
    console.log(`[deploy] worker.js size: ${workerJs.length} chars`);

    try {
    await deployUserWorker({
      accountId: CF_ACCOUNT_ID,
      apiToken: CF_API_TOKEN,
      namespace: NAMESPACE,
      scriptName: workerName,
      scriptContent: workerJsWrapped,
      indexHtml: indexHtmlProcessed,
      d1DatabaseId,
      r2BucketName: CF_BUCKET_NAME,
      jwtSecret,
    });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[deploy] ERROR: ${msg}`);
      throw err;
    }

    const deployedUrl = `${PLATFORM_BASE_URL}/apps/${projectId}/`;
    return { deployedUrl, d1DatabaseId, workerName };
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const description = process.argv[2];
  if (!description) {
    console.error('Usage: npm run test-agent -- "Build a todo app with user auth"');
    process.exit(1);
  }

  if (!ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY env var is required");
    process.exit(1);
  }

  const projectId = randomId();
  console.log(`\nProject ID: ${projectId}`);
  console.log(`Description: ${description}\n`);

  // Build a minimal plan from the description — enough for the agent to work with
  const plan: AppPlan = {
    appName: description.slice(0, 50),
    pages: [{ name: "Home", route: "/" }],
    dataModel: { tables: [] },
    features: [description],
    needsAuth: description.toLowerCase().includes("auth"),
    needsFileStorage: false,
  };

  const storage = makeRestStorage(projectId);
  const deployFn = makeDeployFn(projectId);
  const conversation = [{ role: "user", content: description }];

  console.log("Starting agent...\n");

  try {
    const result = await runBuildAgent(
      ANTHROPIC_API_KEY,
      storage,
      deployFn,
      projectId,
      plan,
      conversation,
      true // first deploy
    );

    console.log("\n✓ Build complete!");
    console.log(`  URL:        ${result.deployedUrl}`);
    console.log(`  Worker:     ${result.workerName}`);
    console.log(`  D1 DB ID:   ${result.d1DatabaseId}`);
  } catch (err) {
    console.error("\n✗ Build failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
