import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "./types";
import { buildProject } from "./build";

interface BuildWorkflowParams {
  projectId: string;
  projectName: string;
  baseUrl: string;
  previousStatus: string;
}

export class BuildWorkflow extends WorkflowEntrypoint<Env, BuildWorkflowParams> {
  async run(event: WorkflowEvent<BuildWorkflowParams>, step: WorkflowStep) {
    const { projectId, projectName, baseUrl, previousStatus } = event.payload;

    try {
      const result = await step.do(
        "run-agent",
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

      // Save the agent's text responses as assistant chat messages
      await step.do("save-chat-messages", async () => {
        for (const msg of result.assistantMessages) {
          if (msg.trim()) {
            await this.env.DB.prepare(
              "INSERT INTO chat_messages (project_id, role, content) VALUES (?, ?, ?)"
            )
              .bind(projectId, "assistant", msg)
              .run();
          }
        }
      });

      // Update project status based on whether a deploy happened
      await step.do("update-project-status", async () => {
        // Guard: if user cancelled, don't overwrite
        const current = await this.env.DB.prepare(
          "SELECT status FROM projects WHERE id = ?"
        ).bind(projectId).first<{ status: string }>();
        if (!current || current.status === "idle") return;

        if (result.deployed) {
          await this.env.DB.prepare(
            "UPDATE projects SET status = ?, deployed_url = ?, d1_database_id = ?, worker_name = ?, updated_at = datetime('now') WHERE id = ?"
          )
            .bind("deployed", result.deployedUrl, result.d1DatabaseId, result.workerName, projectId)
            .run();
          await this.env.DB.prepare(
            "INSERT INTO build_events (project_id, message) VALUES (?, ?)"
          )
            .bind(projectId, "Deployment complete")
            .run();
        } else {
          // Agent just chatted — restore the previous status
          await this.env.DB.prepare("UPDATE projects SET status = ? WHERE id = ?")
            .bind(previousStatus, projectId)
            .run();
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Build failed";
      // Guard: don't overwrite a cancelled build
      const current = await this.env.DB.prepare(
        "SELECT status FROM projects WHERE id = ?"
      ).bind(projectId).first<{ status: string }>();
      if (current && current.status !== "idle") {
        await this.env.DB.prepare("UPDATE projects SET status = ? WHERE id = ?")
          .bind("error", projectId)
          .run();
      }
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
