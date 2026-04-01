import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "./types";
import { buildProject } from "./build";

interface BuildWorkflowParams {
  projectId: string;
  projectName: string;
  baseUrl: string;
}

export class BuildWorkflow extends WorkflowEntrypoint<Env, BuildWorkflowParams> {
  async run(event: WorkflowEvent<BuildWorkflowParams>, step: WorkflowStep) {
    const { projectId, projectName, baseUrl } = event.payload;

    try {
      const result = await step.do(
        "build-and-deploy",
        {
          retries: {
            limit: 3,
            delay: "15 seconds",
            backoff: "exponential",
          },
        },
        async () => {
          return await buildProject(
            this.env,
            projectId,
            projectName,
            baseUrl,
            async (message: string) => {
              await this.env.DB.prepare(
                "INSERT INTO build_events (project_id, message) VALUES (?, ?)"
              )
                .bind(projectId, message)
                .run();
            }
          );
        }
      );

      await step.do("update-project-deployed", async () => {
        await this.env.DB.prepare(
          "UPDATE projects SET status = ?, deployed_url = ?, d1_database_id = ?, worker_name = ?, updated_at = datetime('now') WHERE id = ?"
        )
          .bind("deployed", result.deployedUrl, result.d1DatabaseId, result.workerName, projectId)
          .run();
        await this.env.DB.prepare(
          "INSERT INTO build_events (project_id, message) VALUES (?, ?)"
        )
          .bind(projectId, "Everything checks out — opening the doors!")
          .run();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Build failed";
      await this.env.DB.prepare("UPDATE projects SET status = ? WHERE id = ?")
        .bind("error", projectId)
        .run();
      await this.env.DB.prepare(
        "INSERT INTO build_logs (project_id, error) VALUES (?, ?)"
      )
        .bind(projectId, message)
        .run();
      await this.env.DB.prepare(
        "INSERT INTO build_events (project_id, message) VALUES (?, ?)"
      )
        .bind(projectId, "Build failed: " + message)
        .run();
    }
  }
}
