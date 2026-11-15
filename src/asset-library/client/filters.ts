import type { Input } from "../shared/contracts.ts";
export type Filters = {
  favorite: boolean;
  collectionIds: string[];
  tags: string[];
  withinDays: number;
  sort: "default" | "newest" | "oldest" | "name" | "size";
};
export const defaultFilters: Filters = {
  favorite: false,
  collectionIds: [],
  tags: [],
  withinDays: 0,
  sort: "default",
};
export function filterRequest(filters: Filters): Partial<Input<"search">> {
  return {
    ...filters,
    // Ignore the retired persisted index filter from older plugin versions.
    indexState: "all",
    tags: [...new Set(filters.tags)],
  };
}

export function filterCount(filters: Filters, kind: string) {
  return (
    Number(kind !== "all") +
    Number(filters.favorite) +
    Number(filters.collectionIds.length > 0) +
    Number(filters.tags.length > 0) +
    Number(filters.withinDays > 0)
  );
}
