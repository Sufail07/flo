export type RunContext = {
  run: { id: string; input: unknown };
  // keyed by step name, then by 'output' / 'input'
  steps: Record<string, { output: unknown; input: unknown }>;
  previous: { output: unknown; input: unknown } | null;
};

/**
 * Resolves a dotted path such as "steps.classify.output.text" or
 * "previous.output.choices.0.message" against the run context.
 */
export function resolvePath(ctx: RunContext, path: string): unknown {
  const parts = path
    .replace(/^\$\./, '')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);

  let cursor: unknown = ctx;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Replaces every {{ path }} occurrence in a string. */
export function renderString(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) =>
    stringify(resolvePath(ctx, path)),
  );
}

/** Recursively renders every string inside a config value. */
export function renderValue<T>(value: T, ctx: RunContext): T {
  if (typeof value === 'string') {
    return renderString(value, ctx) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderValue(v, ctx)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderValue(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}
