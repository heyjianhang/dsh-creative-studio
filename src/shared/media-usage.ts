/** Keep provider-reported numeric counters, including nested tool usage. */
export function normalizeMediaUsage(
  value: unknown,
): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const entries: [string, number][] = [];
  const visit = (record: object, prefix = "", depth = 0) => {
    for (const [key, counter] of Object.entries(record)) {
      if (entries.length >= 32) break;
      if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) continue;
      const path = prefix + key;
      if (
        typeof counter === "number" &&
        Number.isFinite(counter) &&
        counter >= 0
      )
        entries.push([path, counter]);
      else if (
        depth < 2 &&
        counter &&
        typeof counter === "object" &&
        !Array.isArray(counter)
      )
        visit(counter, path + ".", depth + 1);
    }
  };
  visit(value);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
