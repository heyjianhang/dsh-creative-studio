import { defineStore } from "@deepseek-ai/dsh-client-store";
import { defaultFilters, type Filters } from "./filters.ts";
export type View = "all" | "favorites" | "recent" | "tasks" | "collection";
export function createViewStore() {
  try {
    const raw = localStorage.getItem("dsh.asset-library.view");
    if (raw) {
      const previous = JSON.parse(raw);
      if (previous.uiVersion !== 2) {
        localStorage.setItem(
          "dsh.asset-library.view",
          JSON.stringify({
            ...previous,
            ai: previous.aiDefaultVersion ? previous.ai : true,
            aiDefaultVersion: 1,
            uiVersion: 2,
            filters: {
              ...defaultFilters,
              ...previous.filters,
              tags:
                previous.filters?.tags ??
                String(previous.filters?.tagText ?? "")
                  .split(/[,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              tagText: undefined,
              indexState: undefined,
            },
          }),
        );
      }
    }
  } catch {
    /* Private mode must not prevent using the library. */
  }

  return defineStore({
    persist: "dsh.asset-library.view",
    init: () => ({
      libraryId: "",
      collectionId: "",
      view: "all" as View,
      searchOpen: false,
      filters: { ...defaultFilters },
      query: "",
      ai: true,
      aiDefaultVersion: 1,
      uiVersion: 2,
      scopeAll: false,
      kind: "all" as "all" | "image" | "video",
    }),
    actions: {
      selectLibrary: (d, id: string) => {
        d.libraryId = id;
        d.filters = { ...defaultFilters, ...d.filters, collectionIds: [] };
        d.view = "all";
        d.collectionId = "";
      },
      selectCollection: (d, id: string) => {
        d.collectionId = id;
        d.view = "collection";
      },
      collectionDeleted: (d, id: string) => {
        d.filters.collectionIds = d.filters.collectionIds.filter(
          (value) => value !== id,
        );
        if (d.collectionId === id) {
          d.collectionId = "";
          d.view = "all";
        }
      },
      selectView: (d, view: View) => {
        d.view = view;
      },
      openSearch: (d, open: boolean) => {
        if (!open || !d.searchOpen) d.query = "";
        d.searchOpen = open;
      },
      setQuery: (d, query: string) => {
        d.query = query;
      },
      setAI: (d, ai: boolean) => {
        d.ai = ai;
      },
      setScope: (d, all: boolean) => {
        d.scopeAll = all;
      },
      setFilters: (d, patch: Partial<Filters>) => {
        d.filters = { ...defaultFilters, ...d.filters, ...patch };
      },
      resetFilters: (d) => {
        d.filters = { ...defaultFilters, sort: d.filters.sort };
        d.kind = "all";
      },
      setKind: (d, kind: "all" | "image" | "video") => {
        d.kind = kind;
      },
    },
  });
}
