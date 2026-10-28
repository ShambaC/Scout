// API-key / PAT / bearer providers only; OAuth logins, AWS SigV4 and Google ADC providers are out.
// Scout speaks Chat Completions (openai_compat) and Anthropic Messages (anthropic) only, so providers whose main API
// is another wire get their Chat Completions (or Anthropic) root instead, and `note` says when that is unverified.
import type { ProviderKind } from "../types";

export interface ProviderPreset {
  id: string;
  label: string;
  group: string;
  kind: Extract<ProviderKind, "openai_compat" | "anthropic" | "llama_local">;
  /** Chat Completions root (anthropic kind: host root, /v1/messages is appended). `{name}` segments must be filled in by the user. */
  base_url: string;
  key_url?: string;
  note?: string;
  /** See ProviderConfig.auth_header. */
  auth_header?: string;
  /** Local engine that normally runs without a key: no secret is attached until the user saves one. */
  keyless?: boolean;
}

const MAJOR = "Major APIs", GATEWAY = "Gateways and routers", HOST = "Inference hosts", REGION = "Regional and China", PLAN = "Coding plans", CLOUD = "Cloud platforms", LOCAL = "Local engines";
const RESP = "This host's main API is OpenAI Responses; Chat Completions support is unverified.";
const BEARER = "authorization"; // non-Anthropic Anthropic-compatible hosts take Authorization: Bearer, not x-api-key

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", group: MAJOR, kind: "openai_compat", base_url: "https://api.openai.com/v1", key_url: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", group: MAJOR, kind: "anthropic", base_url: "https://api.anthropic.com", key_url: "https://console.anthropic.com/settings/keys" },
  { id: "google", label: "Google Gemini", group: MAJOR, kind: "openai_compat", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", key_url: "https://aistudio.google.com/apikey", note: "Google's OpenAI-compatible endpoint for the Gemini API." },
  { id: "xai", label: "xAI", group: MAJOR, kind: "openai_compat", base_url: "https://api.x.ai/v1", key_url: "https://console.x.ai" },
  { id: "mistral", label: "Mistral", group: MAJOR, kind: "openai_compat", base_url: "https://api.mistral.ai/v1", key_url: "https://console.mistral.ai/api-keys" },
  { id: "deepseek", label: "DeepSeek", group: MAJOR, kind: "openai_compat", base_url: "https://api.deepseek.com", key_url: "https://platform.deepseek.com/api_keys" },
  { id: "moonshot", label: "Moonshot (Kimi)", group: MAJOR, kind: "openai_compat", base_url: "https://api.moonshot.ai/v1", key_url: "https://platform.moonshot.ai" },
  { id: "meta", label: "Meta (Llama API)", group: MAJOR, kind: "openai_compat", base_url: "https://api.meta.ai/v1", note: RESP },
  { id: "inception", label: "Inception (Mercury)", group: MAJOR, kind: "openai_compat", base_url: "https://api.inceptionlabs.ai/v1", key_url: "https://platform.inceptionlabs.ai/dashboard/api-keys" },
  { id: "sakana", label: "Sakana AI", group: MAJOR, kind: "openai_compat", base_url: "https://api.sakana.ai/v1", note: RESP },

  { id: "openrouter", label: "OpenRouter", group: GATEWAY, kind: "openai_compat", base_url: "https://openrouter.ai/api/v1", key_url: "https://openrouter.ai/keys" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", group: GATEWAY, kind: "openai_compat", base_url: "https://ai-gateway.vercel.sh/v1", key_url: "https://vercel.com/ai-gateway" },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway (OpenAI-compatible)", group: GATEWAY, kind: "openai_compat", base_url: "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat", auth_header: "cf-aig-authorization", key_url: "https://dash.cloudflare.com", note: "Replace {account} and {gateway} with your Cloudflare account ID and gateway ID. Model ids look like openai/gpt-5.5." },
  { id: "cloudflare-ai-gateway-anthropic", label: "Cloudflare AI Gateway (Anthropic)", group: GATEWAY, kind: "anthropic", base_url: "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic", auth_header: "cf-aig-authorization", key_url: "https://dash.cloudflare.com", note: "Replace {account} and {gateway} with your Cloudflare account ID and gateway ID." },
  { id: "litellm", label: "LiteLLM proxy", group: GATEWAY, kind: "openai_compat", base_url: "http://localhost:4000/v1", keyless: true, note: "Your own LiteLLM proxy; change the URL if it runs elsewhere. Save a key only if the proxy requires one." },
  { id: "kilo", label: "Kilo Gateway", group: GATEWAY, kind: "openai_compat", base_url: "https://api.kilo.ai/api/gateway", key_url: "https://kilo.ai" },
  { id: "zenmux", label: "ZenMux", group: GATEWAY, kind: "openai_compat", base_url: "https://zenmux.ai/api/v1" },
  { id: "aimlapi", label: "AI/ML API", group: GATEWAY, kind: "openai_compat", base_url: "https://api.aimlapi.com/v1", key_url: "https://aimlapi.com/app/keys" },
  { id: "nanogpt", label: "NanoGPT", group: GATEWAY, kind: "openai_compat", base_url: "https://nano-gpt.com/api/v1", key_url: "https://nano-gpt.com" },
  { id: "opencode-zen", label: "OpenCode Zen", group: GATEWAY, kind: "openai_compat", base_url: "https://opencode.ai/zen/v1", key_url: "https://opencode.ai/auth" },
  { id: "opencode-go", label: "OpenCode Go", group: GATEWAY, kind: "openai_compat", base_url: "https://opencode.ai/inference/go/v1", key_url: "https://opencode.ai/auth" },
  { id: "commandcode", label: "Command Code", group: GATEWAY, kind: "openai_compat", base_url: "https://api.commandcode.ai/provider/v1" },
  { id: "cline-pass", label: "ClinePass", group: GATEWAY, kind: "openai_compat", base_url: "https://api.cline.bot/api/v1", key_url: "https://app.cline.bot" },
  { id: "charm-hyper", label: "Charm Hyper", group: GATEWAY, kind: "openai_compat", base_url: "https://hyper.charm.land/v1", key_url: "https://hyper.charm.land/" },
  { id: "singularityapi-dev", label: "SingularityAPI (pay-as-you-go)", group: GATEWAY, kind: "openai_compat", base_url: "https://api.singularityapi.dev/v1", key_url: "https://app.singularityapi.dev" },
  { id: "singularityapi-tech", label: "SingularityAPI (reserved DeepSeek lanes)", group: GATEWAY, kind: "openai_compat", base_url: "https://api.singularityapi.tech/v1", key_url: "https://app.singularityapi.tech", note: "Billed against a booked reservation slot; a valid key with no active slot gets HTTP 403." },
  { id: "yolo-auto", label: "YOLO Auto", group: GATEWAY, kind: "openai_compat", base_url: "https://yolo-auto.com/v1" },
  { id: "helmcode", label: "HelmCode", group: GATEWAY, kind: "openai_compat", base_url: "https://api.helmcode.com/v1" },
  { id: "aiand", label: "AIAND", group: GATEWAY, kind: "openai_compat", base_url: "https://api.aiand.com/v1" },
  { id: "abliteration", label: "Abliteration", group: GATEWAY, kind: "openai_compat", base_url: "https://api.abliteration.ai/v1", note: RESP },

  { id: "groq", label: "Groq", group: HOST, kind: "openai_compat", base_url: "https://api.groq.com/openai/v1", key_url: "https://console.groq.com/keys" },
  { id: "cerebras", label: "Cerebras", group: HOST, kind: "openai_compat", base_url: "https://api.cerebras.ai/v1", key_url: "https://cloud.cerebras.ai" },
  { id: "together", label: "Together AI", group: HOST, kind: "openai_compat", base_url: "https://api.together.xyz/v1", key_url: "https://api.together.ai/settings/api-keys" },
  { id: "fireworks", label: "Fireworks AI", group: HOST, kind: "openai_compat", base_url: "https://api.fireworks.ai/inference/v1", key_url: "https://fireworks.ai/account/api-keys" },
  { id: "firepass", label: "Fireworks Fire Pass", group: HOST, kind: "openai_compat", base_url: "https://api.fireworks.ai/inference/v1", key_url: "https://fireworks.ai/account/api-keys" },
  { id: "deepinfra", label: "DeepInfra", group: HOST, kind: "openai_compat", base_url: "https://api.deepinfra.com/v1/openai", key_url: "https://deepinfra.com/dash/api_keys" },
  { id: "huggingface", label: "Hugging Face Inference Providers", group: HOST, kind: "openai_compat", base_url: "https://router.huggingface.co/v1", key_url: "https://huggingface.co/settings/tokens" },
  { id: "nvidia", label: "NVIDIA NIM", group: HOST, kind: "openai_compat", base_url: "https://integrate.api.nvidia.com/v1", key_url: "https://build.nvidia.com" },
  { id: "novita", label: "Novita AI", group: HOST, kind: "openai_compat", base_url: "https://api.novita.ai/openai/v1", key_url: "https://novita.ai/settings/key-management" },
  { id: "venice", label: "Venice AI", group: HOST, kind: "openai_compat", base_url: "https://api.venice.ai/api/v1", key_url: "https://venice.ai/settings/api" },
  { id: "sambanova", label: "SambaNova", group: HOST, kind: "openai_compat", base_url: "https://api.sambanova.ai/v1", key_url: "https://cloud.sambanova.ai/apis" },
  { id: "baseten", label: "Baseten", group: HOST, kind: "openai_compat", base_url: "https://inference.baseten.co/v1", key_url: "https://app.baseten.co/settings/api_keys" },
  { id: "coreweave", label: "CoreWeave (W&B Inference)", group: HOST, kind: "openai_compat", base_url: "https://api.inference.wandb.ai/v1" },
  { id: "gmi-cloud", label: "GMI Cloud", group: HOST, kind: "openai_compat", base_url: "https://api.gmi-serving.com/v1" },
  { id: "coralbricks", label: "Coral Bricks", group: HOST, kind: "openai_compat", base_url: "https://inference.coralbricks.ai/v1" },
  { id: "synthetic", label: "Synthetic", group: HOST, kind: "openai_compat", base_url: "https://api.synthetic.new/openai/v1" },
  { id: "wafer-serverless", label: "Wafer Serverless", group: HOST, kind: "openai_compat", base_url: "https://pass.wafer.ai/v1" },
  { id: "ollama-cloud", label: "Ollama Cloud", group: HOST, kind: "openai_compat", base_url: "https://ollama.com/v1", note: "Ollama's OpenAI-compatible route; unverified against Ollama Cloud." },

  { id: "siliconflow", label: "SiliconFlow (global)", group: REGION, kind: "openai_compat", base_url: "https://api.siliconflow.com/v1", key_url: "https://cloud.siliconflow.com/account/ak" },
  { id: "siliconflow-cn", label: "SiliconFlow (China)", group: REGION, kind: "openai_compat", base_url: "https://api.siliconflow.cn/v1", key_url: "https://cloud.siliconflow.cn/account/ak" },
  { id: "stepfun", label: "StepFun", group: REGION, kind: "openai_compat", base_url: "https://api.stepfun.ai/v1", key_url: "https://platform.stepfun.ai" },
  { id: "qianfan", label: "Baidu Qianfan", group: REGION, kind: "openai_compat", base_url: "https://qianfan.baidubce.com/v2", key_url: "https://console.bce.baidu.com/qianfan/ais/console/apiKey" },
  { id: "qwen-portal", label: "Qwen Portal", group: REGION, kind: "openai_compat", base_url: "https://portal.qwen.ai/v1", key_url: "https://chat.qwen.ai", note: "Paste a Qwen Portal API key." },
  { id: "xiaomi", label: "Xiaomi MiMo", group: REGION, kind: "openai_compat", base_url: "https://api.xiaomimimo.com/v1", key_url: "https://platform.xiaomimimo.com" },
  { id: "minimax", label: "MiniMax (global)", group: REGION, kind: "anthropic", base_url: "https://api.minimax.io/anthropic", auth_header: BEARER, key_url: "https://platform.minimax.io" },
  { id: "minimax-cn", label: "MiniMax (China)", group: REGION, kind: "anthropic", base_url: "https://api.minimaxi.com/anthropic", auth_header: BEARER, key_url: "https://platform.minimaxi.com" },

  { id: "zai", label: "Z.AI (GLM)", group: PLAN, kind: "anthropic", base_url: "https://api.z.ai/api/anthropic", auth_header: BEARER, key_url: "https://z.ai/manage-apikey/apikey-list" },
  { id: "zhipu-coding-plan", label: "Zhipu coding plan", group: PLAN, kind: "openai_compat", base_url: "https://open.bigmodel.cn/api/coding/paas/v4", key_url: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "minimax-code", label: "MiniMax coding plan (global)", group: PLAN, kind: "anthropic", base_url: "https://api.minimax.io/anthropic", auth_header: BEARER, key_url: "https://platform.minimax.io" },
  { id: "minimax-code-cn", label: "MiniMax coding plan (China)", group: PLAN, kind: "anthropic", base_url: "https://api.minimaxi.com/anthropic", auth_header: BEARER, key_url: "https://platform.minimaxi.com" },
  { id: "alibaba-coding-plan", label: "Alibaba coding plan", group: PLAN, kind: "openai_compat", base_url: "https://coding-intl.dashscope.aliyuncs.com/v1" },
  { id: "alibaba-token-plan", label: "Alibaba token plan", group: PLAN, kind: "openai_compat", base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  { id: "xiaomi-token-plan-ams", label: "Xiaomi token plan (Amsterdam)", group: PLAN, kind: "openai_compat", base_url: "https://token-plan-ams.xiaomimimo.com/v1", key_url: "https://platform.xiaomimimo.com" },
  { id: "xiaomi-token-plan-cn", label: "Xiaomi token plan (China)", group: PLAN, kind: "openai_compat", base_url: "https://token-plan-cn.xiaomimimo.com/v1", key_url: "https://platform.xiaomimimo.com" },
  { id: "xiaomi-token-plan-sgp", label: "Xiaomi token plan (Singapore)", group: PLAN, kind: "openai_compat", base_url: "https://token-plan-sgp.xiaomimimo.com/v1", key_url: "https://platform.xiaomimimo.com" },
  { id: "umans", label: "Umans coding plan", group: PLAN, kind: "anthropic", base_url: "https://api.code.umans.ai", auth_header: BEARER },

  { id: "azure", label: "Azure OpenAI", group: CLOUD, kind: "openai_compat", base_url: "https://{resource}.openai.azure.com/openai/v1", auth_header: "api-key", key_url: "https://portal.azure.com", note: "Replace {resource} with your Azure OpenAI resource name. The model field is your deployment name." },
  { id: "snowflake", label: "Snowflake Cortex", group: CLOUD, kind: "openai_compat", base_url: "https://{account}.snowflakecomputing.com/api/v2/cortex/v1", note: "Replace {account} with your Snowflake account identifier. The key is a programmatic access token (PAT)." },
  { id: "bedrock-mantle", label: "Amazon Bedrock (Mantle)", group: CLOUD, kind: "openai_compat", base_url: "https://bedrock-mantle.{region}.api.aws/openai/v1", note: `Replace {region} (e.g. us-east-1). The key is an Amazon Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). ${RESP}` },

  { id: "ollama", label: "Ollama", group: LOCAL, kind: "openai_compat", base_url: "http://127.0.0.1:11434/v1", keyless: true },
  { id: "lm-studio", label: "LM Studio", group: LOCAL, kind: "openai_compat", base_url: "http://127.0.0.1:1234/v1", keyless: true },
  { id: "llama-cpp", label: "llama.cpp server", group: LOCAL, kind: "llama_local", base_url: "http://127.0.0.1:8080/v1", keyless: true },
  { id: "vllm", label: "vLLM", group: LOCAL, kind: "openai_compat", base_url: "http://127.0.0.1:8000/v1", keyless: true },
];
