/**
 * Deep-clones plain JSON-like sync metadata (objects, arrays, dates, primitives).
 * Undefined object values are kept, and nested objects and arrays are new values.
 * (obsi-mcp original code; replaces lodash cloneDeep in the sync engine.)
 */
export function cloneDeep<T>(value: T): T {
  return cloneValue(value) as T;
}

function cloneValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = cloneValue(Reflect.get(value, key));
  }
  return copy;
}
