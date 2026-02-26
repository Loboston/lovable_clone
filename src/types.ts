export type ProjectStatus = "draft" | "building" | "deployed" | "error";

export interface Env {
  DB: D1Database;
  CODE_BUCKET: R2Bucket;
  SESSIONS: KVNamespace;
  AI: Ai;
  /** Workers for Platforms dispatch namespace: DISPATCHER.get(scriptName) returns a Fetcher */
  DISPATCHER: { get: (scriptName: string) => Fetcher };
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  PLATFORM_JWT_SECRET: string;
}

export interface PlanPage {
  name: string;
  route: string;
}

export interface PlanColumn {
  name: string;
  type: string;
}

export interface PlanTable {
  name: string;
  columns: PlanColumn[];
}

export interface PlanDataModel {
  tables: PlanTable[];
}

export interface AppPlan {
  appName: string;
  pages: PlanPage[];
  dataModel: PlanDataModel;
  features: string[];
  needsAuth: boolean;
  needsFileStorage: boolean;
}

export interface JWTPayload {
  sub: string;
  email: string;
  iat?: number;
  exp?: number;
}
