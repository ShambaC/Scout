import type { LlmProvider, ProviderConfig, Settings } from "../types";
import { anthropicProvider } from "./anthropic";
import { cliProvider } from "./cli";
import { openaiProvider } from "./openai";
import { oauthProvider } from "./oauth";

export function getProvider(cfg: ProviderConfig, settings: Settings): LlmProvider {
  switch (cfg.kind) {
    case "anthropic": return anthropicProvider(cfg);
    case "oauth": return oauthProvider(cfg);
    case "cli_bridge": return cliProvider(cfg, settings.experimental.cli_bridges);
    default: return openaiProvider(cfg); // openai_compat, llama_local
  }
}
