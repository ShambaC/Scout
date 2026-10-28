const files = import.meta.glob<string>("../prompts/*.md", { query: "?raw", import: "default", eager: true });

export function loadPrompt(name: string): string {
  const text = files[`../prompts/${name}`];
  if (text === undefined) throw new Error(`Unknown prompt: ${name}`);
  return text;
}
