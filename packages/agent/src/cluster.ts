const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const unit = (v: number[]) => { const n = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / n); };

export const cosine = (a: number[], b: number[]) => dot(a, b) / (Math.sqrt(dot(a, a) * dot(b, b)) || 1);

export const chooseK = (n: number) => Math.min(30, Math.max(2, Math.round(Math.sqrt(n / 2))));

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic spherical k-means (k-means++ init, fixed seed). Centroids are unit vectors. */
export function kmeans(vectors: number[][], k: number, iters = 50): { assign: number[]; centroids: number[][] } {
  const xs = vectors.map(unit);
  k = Math.min(k, xs.length);
  const rnd = mulberry32(42);
  const centroids = k > 0 ? [xs[Math.floor(rnd() * xs.length)]] : [];
  while (centroids.length < k) {
    const d2 = xs.map((x) => Math.max(0, 1 - Math.max(...centroids.map((c) => dot(x, c)))) ** 2);
    let r = rnd() * d2.reduce((a, b) => a + b, 0);
    let pick = d2.findIndex((w) => (r -= w) <= 0);
    if (pick < 0) pick = Math.floor(rnd() * xs.length); // all points identical
    centroids.push(xs[pick]);
  }
  let assign: number[] = [];
  for (let it = 0; it < iters; it++) {
    const next = xs.map((x) => centroids.reduce((best, c, i) => (dot(x, c) > dot(x, centroids[best]) ? i : best), 0));
    const changed = next.some((a, i) => a !== assign[i]);
    assign = next;
    if (!changed) break;
    centroids.forEach((_, j) => {
      const members = xs.filter((_, i) => assign[i] === j);
      if (members.length) centroids[j] = unit(members[0].map((_, d) => members.reduce((s, m) => s + m[d], 0)));
    });
  }
  return { assign, centroids };
}
