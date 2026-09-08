import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function fixture(pi: ExtensionAPI) {
  const directory = process.env.TAB_STATUS_E2E_DIR!;
  const mark = (name: string) => writeFileSync(join(directory, name), "ready");
  const has = (name: string) => existsSync(join(directory, name));
  async function gate(name: string, signal?: AbortSignal) {
    const deadline = Date.now() + 20_000;
    while (!has(name)) {
      if (Date.now() > deadline) throw new Error(`Fixture gate timed out: ${name}`);
      await delay(25, undefined, { signal });
    }
  }

  // Return model responses locally; PI emits the lifecycle and tool events.
  pi.registerProvider("tab-status-fixture", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fixture-not-a-credential",
    api: "tab-status-fixture",
    models: [{
      id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 1024,
    }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "pending", timestamp: Date.now(),
        usage: {
          input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      void (async () => {
        try {
          stream.push({ type: "start", partial: output });
          const last = context.messages.at(-1);
          const text = last?.role === "user"
            ? typeof last.content === "string" ? last.content
              : last.content.filter((item) => item.type === "text").map((item) => item.text).join("")
            : "";
          if (text === "hold") await gate("release-parent", options?.signal);
          if (text === "spawn") {
            const toolCall = { type: "toolCall" as const, id: "call-child", name: "subagent_spawn", arguments: {} };
            output.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
            output.stopReason = "toolUse";
          } else {
            output.content.push({ type: "text", text: "Fixture response." });
            stream.push({ type: "text_start", contentIndex: 0, partial: output });
            stream.push({ type: "text_end", contentIndex: 0, content: "Fixture response.", partial: output });
            output.stopReason = "stop";
          }
          stream.push({ type: "done", reason: output.stopReason, message: output });
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
  });

  pi.registerTool({
    name: "subagent_spawn", label: "Fixture child", description: "Return a queued child fixture.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "Child queued." }], details: { jobId: "modern-child", state: "queued" } };
    },
  });
  pi.registerCommand("fixture", {
    description: "Drive the isolated tab-status test.",
    async handler(args, ctx) {
      if (args === "legacy-start") pi.events.emit("subagents:started", { id: "legacy-child" });
      else if (args === "modern-complete") pi.sendMessage({
        customType: "pi-subagents-completion", content: "Child completed.", display: false,
        details: { jobId: "modern-child", state: "completed" },
      }, { triggerTurn: false });
      else if (args === "shutdown") ctx.shutdown();
      else throw new Error(`Unknown fixture command: ${args}`);
    },
  });
  pi.on("session_start", () => mark("session-started"));
  pi.on("agent_settled", () => mark("parent-settled"));
  pi.on("session_before_compact", async (event) => {
    await gate("release-compaction", event.signal);
    if (has("complete-legacy")) pi.events.emit("subagents:completed", { id: "legacy-child" });
    if (has("cancel-compaction")) return { cancel: true };
    return { compaction: {
      summary: "Fixture summary.", firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } };
  });
  pi.on("session_compact", () => mark("compacted"));
  pi.on("session_compact_failed", () => mark("compaction-failed"));
  pi.on("session_shutdown", () => mark("shutdown"));
}
