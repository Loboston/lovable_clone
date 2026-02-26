const CF_API = "https://api.cloudflare.com/client/v4";

async function cfFetch(
  accountId: string,
  apiToken: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const pathNorm = path.startsWith("/") ? path : `/${path}`;
  const url = `${CF_API}${pathNorm}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res;
}

export interface CreateD1Result {
  uuid: string;
  name: string;
}

export async function createD1Database(
  accountId: string,
  apiToken: string,
  name: string
): Promise<CreateD1Result> {
  const res = await cfFetch(accountId, apiToken, `/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const data = (await res.json()) as {
    success?: boolean;
    result?: { uuid?: string; database_id?: string; name?: string };
    errors?: unknown[];
  };
  if (!data.success || !data.result) {
    throw new Error("Failed to create D1 database: " + JSON.stringify(data.errors ?? data));
  }
  const r = data.result as { uuid?: string; database_id?: string; name?: string };
  const uuid = r?.uuid ?? r?.database_id ?? "";
  if (!uuid) throw new Error("D1 create did not return uuid: " + JSON.stringify(data.result));
  return { uuid, name: r?.name ?? name };
}

export async function runD1Query(
  accountId: string,
  apiToken: string,
  databaseId: string,
  sql: string
): Promise<unknown> {
  const res = await cfFetch(
    accountId,
    apiToken,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({ sql }),
    }
  );
  const data = (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown[] };
  if (!data.success) {
    throw new Error("D1 query failed: " + JSON.stringify(data.errors ?? data));
  }
  return data.result;
}

export async function deleteD1Database(
  accountId: string,
  apiToken: string,
  databaseId: string
): Promise<void> {
  const res = await cfFetch(
    accountId,
    apiToken,
    `/accounts/${accountId}/d1/database/${databaseId}`,
    { method: "DELETE" }
  );
  const data = (await res.json()) as { success?: boolean; errors?: unknown[] };
  if (!data.success) {
    throw new Error("Failed to delete D1 database: " + JSON.stringify(data.errors ?? data));
  }
}

async function hashContentBase64(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer)).slice(0, 16);
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DeployUserWorkerParams {
  accountId: string;
  apiToken: string;
  namespace: string;
  scriptName: string;
  scriptContent: string;
  indexHtml: string;
  d1DatabaseId: string;
  r2BucketName: string;
  jwtSecret: string;
}

export async function deployUserWorker(params: DeployUserWorkerParams): Promise<void> {
  const {
    accountId,
    apiToken,
    namespace,
    scriptName,
    scriptContent,
    indexHtml,
    d1DatabaseId,
    r2BucketName,
    jwtSecret,
  } = params;

  const baseUrl = `${CF_API}/accounts/${accountId}/workers`;
  const indexB64 = btoa(unescape(encodeURIComponent(indexHtml)));
  const indexSize = new TextEncoder().encode(indexHtml).length;
  const indexHash = await hashContentBase64(indexB64);

  const manifest: Record<string, { hash: string; size: number }> = {
    "/index.html": { hash: indexHash, size: indexSize },
  };

  const sessionRes = await fetch(
    `${baseUrl}/dispatch/namespaces/${namespace}/scripts/${scriptName}/assets-upload-session`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ manifest }),
    }
  );
  const sessionData = (await sessionRes.json()) as {
    success?: boolean;
    result?: { jwt?: string; buckets?: string[][] };
  };
  if (!sessionData.success || !sessionData.result?.jwt) {
    throw new Error("Failed to create assets upload session: " + JSON.stringify(sessionData));
  }

  let completionToken = sessionData.result.jwt;
  const buckets = sessionData.result.buckets ?? [];

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      if (hash === indexHash) form.append(hash, indexB64);
    }
    const uploadRes = await fetch(`${baseUrl}/assets/upload?base64=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${completionToken}` },
      body: form,
    });
    const uploadData = (await uploadRes.json()) as { success?: boolean; result?: { jwt?: string } };
    if (uploadData.result?.jwt) completionToken = uploadData.result.jwt;
  }

  const metadata = {
    main_module: `${scriptName}.mjs`,
    compatibility_date: "2024-01-01",
    assets: { jwt: completionToken },
    bindings: [
      { type: "d1_database", name: "DB", database_id: d1DatabaseId },
      { type: "r2_bucket", name: "STORAGE", bucket_name: r2BucketName },
      { type: "secret_text", name: "JWT_SECRET", text: jwtSecret },
      { type: "assets", name: "ASSETS" },
    ],
  };

  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  formData.append(
    `${scriptName}.mjs`,
    new Blob([scriptContent], { type: "application/javascript+module" })
  );

  const deployRes = await fetch(
    `${baseUrl}/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    }
  );

  if (!deployRes.ok) {
    const errText = await deployRes.text();
    throw new Error("Failed to deploy Worker: " + deployRes.status + " " + errText);
  }
}

export async function deleteUserWorker(
  accountId: string,
  apiToken: string,
  namespace: string,
  scriptName: string
): Promise<void> {
  const res = await cfFetch(
    accountId,
    apiToken,
    `/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error("Failed to delete Worker: " + res.status + " " + errText);
  }
}
