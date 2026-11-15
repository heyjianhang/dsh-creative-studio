import { projectSchema, type Project } from "./contracts.ts";
import { validateGraph } from "./project-graph.ts";

export const projectConflictCode = "creative-studio/project-conflict";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "creative-studio/project-conflict": Record<never, never>;
  }
}

export function isProjectConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === projectConflictCode;
}

const conflict = Symbol();

function same<T>(a: T, b: T): boolean {
  // Project values are normalized by the same JSON schema on both sides.
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function mergeValue<T>(base: T, draft: T, saved: T): T {
  if (same(base, draft) || same(draft, saved)) return saved;
  if (same(base, saved)) return draft;
  throw conflict;
}

function mergeFields<T extends object>(base: T, draft: T, saved: T): T {
  const result = { ...saved };
  for (const key of Object.keys({ ...base, ...draft, ...saved }) as (keyof T)[]) {
    const value = mergeValue(base[key], draft[key], saved[key]);
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

function mergeItems<T extends { id: string }>(
  base: T[],
  draft: T[],
  saved: T[],
  merge: (base: T, draft: T, saved: T) => T,
): T[] {
  const maps = [base, draft, saved].map((items) => new Map(items.map((item) => [item.id, item])));
  const result: T[] = [];
  for (const id of new Set([...saved, ...draft, ...base].map((item) => item.id))) {
    const [old, local, remote] = maps.map((map) => map.get(id));
    const item = old && local && remote ? merge(old, local, remote) : mergeValue(old, local, remote);
    if (item) result.push(item);
  }
  return result;
}

/** Merge independent edits while retaining the saved revision and rejecting conflicting fields or invalid graphs. */
export function mergeProject(base: Project, draft: Project, saved: Project): Project | undefined {
  if (base.id !== draft.id || draft.id !== saved.id) return;
  try {
    const merged = projectSchema.safeParse({
      ...saved,
      name: mergeValue(base.name, draft.name, saved.name),
      viewport: mergeValue(base.viewport, draft.viewport, saved.viewport),
      playbackPreferences: mergeValue(base.playbackPreferences, draft.playbackPreferences, saved.playbackPreferences),
      generationPreferences: mergeValue(base.generationPreferences, draft.generationPreferences, saved.generationPreferences),
      nodes: mergeItems(base.nodes, draft.nodes, saved.nodes, (old, local, remote) => ({
        ...mergeFields(
          { ...old, data: undefined },
          { ...local, data: undefined },
          { ...remote, data: undefined },
        ),
        data: mergeFields(old.data, local.data, remote.data),
      })),
      edges: mergeItems(base.edges, draft.edges, saved.edges, mergeValue),
    });
    if (!merged.success) return;
    try {
      validateGraph(merged.data);
    } catch (_error) {
      // Independent edits can still create a cycle or leave a dangling edge.
      return;
    }
    return merged.data;
  } catch (error) {
    if (error !== conflict) throw error;
    return;
  }
}
