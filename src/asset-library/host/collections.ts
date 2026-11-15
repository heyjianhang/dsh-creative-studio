/** Retain distinct collections when old folder branches used the same name. */
export function flattenCollectionNames<T extends { name: string }>(
  collections: T[],
): T[] {
  const occupied = new Set(collections.map((collection) => collection.name));
  const used = new Set<string>();
  return collections.map((collection) => {
    let name = collection.name,
      suffix = 2;
    if (used.has(name)) {
      do {
        name = collection.name.slice(0, 68) + ` (${suffix++})`;
      } while (occupied.has(name));
    }
    used.add(name);
    occupied.add(name);
    return { ...collection, name };
  });
}
