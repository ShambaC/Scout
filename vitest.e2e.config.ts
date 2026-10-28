import { defineConfig } from "vitest/config";

// Live end-to-end harness (network + local CLIs); not part of `npm test`.
export default defineConfig({
  test: { include: ["packages/eval/e2e/*.e2e.ts"], testTimeout: 3_600_000, hookTimeout: 120_000 },
});
