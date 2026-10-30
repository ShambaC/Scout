import type { GpuInfo } from "../packages/agent/src/rust";

export type GgufFile = { path: string; size: number };
const GB = 1073741824;
export const mb = (n: number) => (n / 1048576).toFixed(0);
export const gb = (n: number) => (n / GB).toFixed(1);
export const sizeOf = (n: number) => (n >= GB ? `${gb(n)} GB` : `${mb(n)} MB`);
export const CHAT_REPOS = ["unsloth/Qwen3.5-4B-GGUF", "unsloth/gemma-4-E4B-it-GGUF", "unsloth/Qwen3.5-9B-GGUF", "unsloth/gemma-4-12b-it-GGUF", "unsloth/gemma-4-26B-A4B-it-GGUF", "unsloth/Qwen3.8-27B-GGUF", "unsloth/gemma-4-31B-it-GGUF"];
export const EMBED_REPOS = ["ggml-org/embeddinggemma-300M-GGUF", "Qwen/Qwen3-Embedding-0.6B-GGUF"];

/** VRAM minus ~1.5 GB for context/overhead; without a usable GPU (<3 GB) half of RAM, CPU only. */
export function budgetOf(hw: GpuInfo) {
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vram_bytes));
  return vram >= 3 * GB ? { bytes: vram - 1.5 * GB, gpu: true } : { bytes: hw.ram_bytes / 2, gpu: false };
}

// bits of the quant in a file name (Q4_K_M, UD-IQ3_XXS, BF16...); unknown names count as 4
const bitsOf = (name: string) => /(?:^|[^a-z0-9])(?:b?f(16|32))/i.test(name) ? 16 : Number(/(?:^|[^a-z0-9])i?q(\d)/i.exec(name)?.[1] ?? 4);

/** Largest single-file GGUF that fits: Q4+ first, then Q3, below Q3 only as a last resort. Skips mmproj and sharded files. */
export function pickQuant(files: GgufFile[], budget: number): GgufFile | null {
  const fit = files.filter((f) => {
    const n = f.path.split("/").pop()!;
    return f.path.endsWith(".gguf") && !/^mmproj/i.test(n) && !/-\d{5}-of-\d{5}/.test(n) && f.size <= budget;
  });
  for (const ok of [(b: number) => b >= 4, (b: number) => b === 3, () => true]) {
    const c = fit.filter((f) => ok(bitsOf(f.path.split("/").pop()!)));
    if (c.length) return c.reduce((a, b) => (b.size > a.size ? b : a));
  }
  return null;
}
