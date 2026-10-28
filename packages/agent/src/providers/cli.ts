import { runCli } from "../rust";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderConfig } from "../types";
import { approxTokens } from "./openai";

// Headless invocations, verified against claude 2.1.312 and codex-cli 0.162.1. The user prompt goes on stdin.
// No --bare for claude: it forces API-key auth, and the point of the bridge is the user's own signed-in CLI.
const CLAUDE_ARGS = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""];
const CODEX_ARGS = ["exec", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never"];

const system = (req: ChatRequest) => req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
const convo = (req: ChatRequest) =>
  req.messages.filter((m) => m.role !== "system").map((m) => (req.messages.length > 2 ? `${m.role.toUpperCase()}:\n${m.content}` : m.content)).join("\n\n");

/** Experimental (PLAN 3.3): spawns the user's own signed-in CLI; we never read, copy or proxy its auth. */
export function cliProvider(cfg: ProviderConfig, enabled: boolean): LlmProvider {
  const cli = cfg.cli ?? "claude";
  return {
    id: cfg.id,
    kind: "cli_bridge",
    capabilities: { streaming: false, tools: false, json_mode: true, max_context: 200_000, embeddings: false },
    estimateCost: () => 0, // billed to the user's subscription, not per token
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (!enabled) throw new Error("CLI bridges are disabled (Settings > Experimental)");
      const model = req.model && req.model !== "default" ? req.model : "";
      if (cli === "claude") {
        const args = [...CLAUDE_ARGS, "--system-prompt", system(req) || "You are a helpful research assistant."];
        if (model) args.push("--model", model);
        if (req.json_schema) args.push("--json-schema", JSON.stringify(req.json_schema));
        const r = await runCli("claude", args, convo(req));
        let j: any;
        try { j = JSON.parse(r.stdout); } catch { throw new Error(`claude exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 500)}`); }
        if (j.is_error) throw new Error(`claude: ${String(j.result ?? j.subtype).slice(0, 500)}`);
        const text = j.structured_output != null ? JSON.stringify(j.structured_output) : String(j.result ?? "");
        const u = j.usage ?? {};
        return {
          text,
          tokens_in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) || approxTokens(system(req) + convo(req)),
          tokens_out: u.output_tokens ?? approxTokens(text),
        };
      }
      // codex has no system-prompt flag; schema stays in the prompt (router validates) since --output-schema needs a strict schema file
      let prompt = `${system(req)}\n\n${convo(req)}`;
      if (req.json_schema) prompt += `\n\nRespond with only JSON matching this schema:\n${JSON.stringify(req.json_schema)}`;
      const r = await runCli("codex", model ? [...CODEX_ARGS, "-m", model, "-"] : [...CODEX_ARGS, "-"], prompt);
      if (r.code !== 0) throw new Error(`codex exited ${r.code}: ${r.stderr.slice(-500)}`);
      const text = r.stdout.trim();
      const total = Number(/tokens used\s+([\d,]+)/i.exec(r.stderr)?.[1]?.replace(/,/g, "") ?? NaN);
      const out = approxTokens(text);
      return { text, tokens_in: Number.isFinite(total) ? Math.max(total - out, 0) : approxTokens(prompt), tokens_out: out };
    },
  };
}
