import type { OutcomeMetaResponse } from "./types.js";

/** Public /info outcomeTemplates registry. Text is data, never markup. */
export interface OutcomeTemplate {
  id: string;
  name: string;
  description: string;
  role: "question" | { standaloneOutcome: { sideNames: string[] } } | { questionOutcome: { parent: string } };
  keywords: [string, string][];
}

/** Values may contain colons (HIP-3 symbols, URLs and times). */
export function parseOutcomeFields(description: string): Record<string, string> {
  return Object.fromEntries(description.split("|").flatMap((part) => {
    const colon = part.indexOf(":");
    return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]];
  }));
}

export function resolveOutcomeTemplates(meta: OutcomeMetaResponse, templates: OutcomeTemplate[]): OutcomeMetaResponse {
  const registry = new Map(templates.map((template) => [template.id, template]));
  function resolve<T extends { name: string; description: string; sideSpecs?: { name: string }[] }>(entry: T): T {
    if (!entry.name.startsWith("template:")) return entry;
    const id = entry.name.slice("template:".length);
    const template = registry.get(id);
    // Do not present an undecoded market as a tradeable, understood question.
    if (!template) throw new Error(`Market template unavailable: ${id}. Please retry.`);
    const values = parseOutcomeFields(entry.description);
    const interpolate = (text: string) => text.replace(/\{([^{}]+)\}/g, (_, key: string) => {
      if (!Object.hasOwn(values, key)) throw new Error(`Missing ${key} in market template ${id}`);
      return values[key];
    });
    return {
      ...entry,
      name: interpolate(template.name),
      description: interpolate(template.description),
      ...(entry.sideSpecs ? { sideSpecs: entry.sideSpecs.map((side) => ({
        ...side,
        name: side.name.startsWith("template:") ? interpolate(side.name.slice(9)) : side.name,
      })) } : {}),
    };
  }
  return { ...meta, outcomes: meta.outcomes.map(resolve), questions: meta.questions?.map(resolve) };
}
