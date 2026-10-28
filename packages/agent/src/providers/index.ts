import type { LlmProvider, ProviderConfig, Settings } from "../types";
import { anthropicProvider } from "./anthropic";
import { cliProvider } from "./cli";
import { openaiProvider } from "./openai";

export function getProvider(cfg: ProviderConfig, settings: Settings): LlmProvider {
  switch (cfg.kind) {
    case "anthropic": return anthropicProvider(cfg);
    case "cli_bridge": return cliProvider(cfg, settings.experimental.cli_bridges);
    default: return openaiProvider(cfg); // openai_compat, llama_local
  }
}
