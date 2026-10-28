import { describe, expect, it } from "vitest";
import { budgetOf, pickQuant } from "./localModels";

const GB = 1073741824, f = (path: string, gb: number) => ({ path, size: gb * GB });

describe("pickQuant", () => {
  const files = [f("m-Q8_0.gguf", 8), f("m-Q4_K_M.gguf", 4.5), f("m-Q3_K_S.gguf", 3.5), f("m-IQ2_XS.gguf", 2.5), f("mmproj-F16.gguf", 0.9), f("m-Q4_K_M-00001-of-00002.gguf", 4.5), f("README.md", 0.1)];
  it("takes the largest fitting Q4+ file", () => {
    expect(pickQuant(files, 10 * GB)?.path).toBe("m-Q8_0.gguf");
    expect(pickQuant(files, 5 * GB)?.path).toBe("m-Q4_K_M.gguf");
  });
  it("falls back to Q3, then below Q3, then null", () => {
    expect(pickQuant(files, 4 * GB)?.path).toBe("m-Q3_K_S.gguf");
    expect(pickQuant(files, 3 * GB)?.path).toBe("m-IQ2_XS.gguf");
    expect(pickQuant(files, 1 * GB)).toBeNull();
  });
});

describe("budgetOf", () => {
  const gpu = (gb: number) => ({ name: "g", vendor: "nvidia" as const, vram_bytes: gb * GB });
  it("uses best GPU minus 1.5 GB, else half of RAM", () => {
    expect(budgetOf({ gpus: [gpu(8), gpu(12)], ram_bytes: 32 * GB })).toEqual({ bytes: 10.5 * GB, gpu: true });
    expect(budgetOf({ gpus: [gpu(0.5)], ram_bytes: 32 * GB })).toEqual({ bytes: 16 * GB, gpu: false });
    expect(budgetOf({ gpus: [], ram_bytes: 0 })).toEqual({ bytes: 0, gpu: false });
  });
});
