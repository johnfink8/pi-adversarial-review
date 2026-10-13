import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/**
 * Loads `prompts/<name>.md` once and returns a filler for its `{{key}}` slots.
 * Read at load time so a missing file fails when the extension loads, not on
 * the first re-review; a slot nothing fills, or a value no slot uses, throws.
 */
export function loadPrompt(name: string): (values: Record<string, string>) => string {
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  const template = fs.readFileSync(file, "utf-8");
  return (values) => {
    const used = new Set<string>();
    const text = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`review: ${file} uses {{${key}}}, which nothing supplies`);
      used.add(key);
      return value;
    });
    const unused = Object.keys(values).filter((key) => !used.has(key));
    if (unused.length > 0) throw new Error(`review: ${file} never uses ${unused.map((k) => `{{${k}}}`).join(", ")}`);
    return text.trim();
  };
}
