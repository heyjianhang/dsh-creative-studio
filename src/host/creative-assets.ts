import { randomUUID } from "node:crypto";
import {
  creativeAssetDraftSchema,
  creativeAssetSchema,
  endpoints,
  type CreativeAsset,
  type Resource,
  type Input,
  type Project,
  type CreativeFolder,
  type FolderCatalog,
} from "../shared/contracts.ts";
import type { LibrarySearch } from "./library-search.ts";

export const resourceKey = (r: Resource) =>
  r.media
    ? `media:${r.media.id}`
    : JSON.stringify([r.asset!.libraryId, r.asset!.id]);
interface Table {
  get(id: string): CreativeAsset | undefined;
  entries(): Iterable<readonly [string, CreativeAsset]>;
  put(id: string, value: CreativeAsset): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}
interface FolderTable {
  get(id: string): FolderCatalog | undefined;
  entries(): Iterable<readonly [string, FolderCatalog]>;
  put(id: string, value: FolderCatalog): Promise<unknown>;
}
const categoryWords = {
  character: "角色 人物 character",
  scene: "场景 scene",
  prop: "道具 prop",
  style: "风格 style",
  other: "其他 other",
};
export class CreativeAssets {
  private tail = Promise.resolve();
  constructor(
    private table: Table,
    private library: LibrarySearch,
    private resolve: (r: Resource) => Resource,
    private foldersTable: FolderTable,
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.tail.then(fn);
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  private catalog(projectId?: string) {
    return this.foldersTable.get(projectId ?? "personal");
  }
  private async ensureFolders(projectId?: string) {
    const current = this.catalog(projectId);
    if (current) return current.folders;
    const folders: CreativeFolder[] = [
      ["角色", "character"],
      ["场景", "scene"],
      ["道具", "prop"],
      ["风格", "style"],
      ["音效", "other"],
      ["其他", "other"],
    ].map(([name, category]) => ({
      id: randomUUID(),
      name: name!,
      category: category as CreativeFolder["category"],
      legacyCategory:
        name === "音效" ? undefined : (category as CreativeFolder["category"]),
      parentId: null,
      projectId,
      revision: 0,
    }));
    await this.foldersTable.put(projectId ?? "personal", { folders });
    return folders;
  }
  folders(projectId?: string) {
    return this.serial(async () =>
      structuredClone(await this.ensureFolders(projectId)),
    );
  }
  private locateFolder(id: string) {
    for (const [key, catalog] of this.foldersTable.entries()) {
      const folder = catalog.folders.find((f) => f.id === id);
      if (folder) return { key, catalog: structuredClone(catalog), folder };
    }
    throw new Error("文件夹不存在，请刷新后重试");
  }
  private normalized(item: CreativeAsset): CreativeAsset {
    if (item.folderId !== undefined) return item;
    const folders = this.catalog(item.ownerProjectId)?.folders ?? [];
    const folder = folders.find((f) => f.legacyCategory === item.category);
    return { ...item, folderId: folder?.id ?? null };
  }
  private placement(
    folderId: string | null | undefined,
    ownerProjectId?: string,
  ) {
    if (!folderId) return { folderId: folderId ?? null, ownerProjectId };
    const { folder } = this.locateFolder(folderId);
    if (folder.projectId !== ownerProjectId)
      throw new Error("文件夹与素材范围不一致");
    return { folderId, ownerProjectId, category: folder.category };
  }
  createFolder(raw: Input<"createCreativeFolder">) {
    return this.serial(async () => {
      const input = endpoints.createCreativeFolder.input.parse(raw);
      const folders = [...(await this.ensureFolders(input.projectId))];
      if (input.parentId && !folders.some((f) => f.id === input.parentId))
        throw new Error("上级文件夹不存在");
      let parent = input.parentId,
        depth = 0;
      while (parent) {
        depth++;
        parent = folders.find((f) => f.id === parent)?.parentId ?? null;
      }
      if (depth >= 6) throw new Error("文件夹最多支持 6 层");
      if (folders.length >= 1000) throw new Error("文件夹数量已达上限");
      if (
        folders.some(
          (f) =>
            f.parentId === input.parentId &&
            f.name.toLocaleLowerCase() === input.name.toLocaleLowerCase(),
        )
      )
        throw new Error("同一位置已有这个名称的文件夹");
      const folder: CreativeFolder = {
        ...input,
        id: randomUUID(),
        revision: 0,
        category:
          folders.find((f) => f.id === input.parentId)?.category ?? "other",
      };
      await this.foldersTable.put(input.projectId ?? "personal", {
        folders: [...folders, folder],
      });
      return folder;
    });
  }
  renameFolder(raw: Input<"renameCreativeFolder">) {
    return this.serial(async () => {
      const input = endpoints.renameCreativeFolder.input.parse(raw);
      const { key, catalog, folder } = this.locateFolder(input.id);
      if (folder.revision !== input.revision)
        throw new Error("文件夹已修改，请刷新后重试");
      if (
        catalog.folders.some(
          (f) =>
            f.id !== folder.id &&
            f.parentId === folder.parentId &&
            f.name.toLocaleLowerCase() === input.name.toLocaleLowerCase(),
        )
      )
        throw new Error("同一位置已有这个名称的文件夹");
      const next = {
        ...folder,
        name: input.name,
        revision: folder.revision + 1,
      };
      await this.foldersTable.put(key, {
        folders: catalog.folders.map((f) => (f.id === next.id ? next : f)),
      });
      return next;
    });
  }
  removeFolder(raw: Input<"removeCreativeFolder">) {
    return this.serial(async () => {
      const input = endpoints.removeCreativeFolder.input.parse(raw);
      const { key, catalog, folder } = this.locateFolder(input.id);
      if (folder.revision !== input.revision)
        throw new Error("文件夹已修改，请刷新后重试");
      // Keep every asset; detach contents before removing the directory entry.
      for (const [, rawAsset] of this.table.entries()) {
        const asset = this.normalized(rawAsset);
        if (asset.folderId === folder.id)
          await this.table.put(asset.id, {
            ...asset,
            folderId: folder.parentId,
            revision: asset.revision + 1,
            updatedAt: new Date().toISOString(),
          });
      }
      const siblings = new Set(
        catalog.folders
          .filter((f) => f.parentId === folder.parentId && f.id !== folder.id)
          .map((f) => f.name.toLocaleLowerCase()),
      );
      const folders = catalog.folders
        .filter((f) => f.id !== folder.id)
        .map((f) => {
          if (f.parentId !== folder.id) return f;
          let name = f.name,
            suffix = 2;
          while (siblings.has(name.toLocaleLowerCase()))
            name = `${f.name.slice(0, 70)} (${suffix++})`;
          siblings.add(name.toLocaleLowerCase());
          return {
            ...f,
            name,
            parentId: folder.parentId,
            revision: f.revision + 1,
          };
        });
      await this.foldersTable.put(key, { folders });
      return { ok: true as const };
    });
  }
  addResources(raw: Input<"addCreativeResources">) {
    return this.serial(async () => {
      const input = endpoints.addCreativeResources.input.parse(raw);
      await this.ensureFolders(input.ownerProjectId);
      const placement = this.placement(input.folderId, input.ownerProjectId);
      const added: CreativeAsset[] = [];
      for (const resource of new Map(
        input.resources.map((r) => [resourceKey(r), r]),
      ).values()) {
        const ref = this.resolve(resource);
        const existing = [...this.table.entries()]
          .map(([, a]) => this.normalized(a))
          .find(
            (a) =>
              a.ownerProjectId === input.ownerProjectId &&
              a.folderId === input.folderId &&
              a.references.length === 1 &&
              resourceKey(a.references[0]!) === resourceKey(ref),
          );
        if (existing) {
          added.push(existing);
          continue;
        }
        const now = new Date().toISOString();
        const asset = creativeAssetSchema.parse({
          name: (ref.media ?? ref.asset)!.name.slice(0, 120),
          category: "other",
          description: "",
          ...placement,
          references: [ref],
          id: randomUUID(),
          revision: 0,
          createdAt: now,
          updatedAt: now,
        });
        await this.table.put(asset.id, asset);
        added.push(asset);
      }
      return added;
    });
  }
  get(id: string) {
    const item = this.table.get(id);
    if (!item) throw new Error("创作素材不存在或已移除");
    return structuredClone(this.normalized(item));
  }
  private draft(input: Input<"createCreativeAsset">) {
    const value = creativeAssetDraftSchema.parse(input);
    const references = value.references.map(this.resolve);
    return {
      ...value,
      ...(value.folderId !== undefined
        ? this.placement(value.folderId, value.ownerProjectId)
        : {}),
      references: [
        ...new Map(references.map((r) => [resourceKey(r), r])).values(),
      ],
    };
  }
  create(input: Input<"createCreativeAsset">) {
    return this.serial(async () => {
      const now = new Date().toISOString();
      const value = creativeAssetSchema.parse({
        ...this.draft(input),
        id: randomUUID(),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });
      await this.table.put(value.id, value);
      return value;
    });
  }
  update(input: Input<"updateCreativeAsset">) {
    return this.serial(async () => {
      const old = this.get(input.id);
      if (old.revision !== input.revision)
        throw new Error("素材已在其他位置修改，请重新打开后编辑");
      const value = creativeAssetSchema.parse({
        ...old,
        ...this.draft(input),
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await this.table.put(value.id, value);
      return value;
    });
  }
  remove(input: Input<"removeCreativeAsset">) {
    return this.serial(async () => {
      const old = this.get(input.id);
      if (old.revision !== input.revision)
        throw new Error("素材已在其他位置修改，请刷新后再移除");
      await this.table.delete(input.id);
      return { ok: true as const };
    });
  }
  usesMedia(id: string) {
    return [...this.table.entries()].some(([, a]) =>
      a.references.some((r) => r.media?.id === id),
    );
  }
  async search(
    raw: Input<"creativeAssets">,
    signal: AbortSignal,
    project?: Project,
  ) {
    const input = endpoints.creativeAssets.input.parse(raw);
    if (input.collection === "project" && !input.ownerProjectId)
      throw new Error("请选择项目");
    if (input.collection)
      await this.folders(
        input.collection === "project" ? input.ownerProjectId : undefined,
      );
    const terms = (input.query ?? "")
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const inProject = new Set(
      project?.nodes.map((n) => n.data.creativeAssetId).filter(Boolean),
    );
    const resources = new Set(
      project?.nodes
        .filter((n) => n.data.media || n.data.asset)
        .map((n) => resourceKey(n.data as Resource)),
    );
    const candidates = [...this.table.entries()]
      .map(([, a]) => this.normalized(a))
      .filter(
        (a) =>
          (!input.collection ||
            a.ownerProjectId ===
              (input.collection === "project"
                ? input.ownerProjectId
                : undefined)) &&
          (input.folderId === undefined || a.folderId === input.folderId) &&
          (!input.category ||
            input.category === "all" ||
            a.category === input.category) &&
          (!input.kind ||
            input.kind === "all" ||
            a.references.some((r) => r.kind === input.kind)) &&
          (!project ||
            inProject.has(a.id) ||
            a.references.some((r) => resources.has(resourceKey(r)))),
      );
    const libraryRefs = new Set(
      candidates.flatMap((a) =>
        a.references.filter((r) => r.asset).map(resourceKey),
      ),
    );
    const scores = new Map<string, number>();
    let mode: "ai" | "keyword" = "keyword",
      fallback = false;
    let partial = candidates.some((a) => a.references.some((r) => r.media));
    if (input.ai && terms.length && libraryRefs.size) {
      try {
        let offset = 0,
          total = 1;
        while (offset < total) {
          const result = await this.library.search(
            { query: input.query, ai: true, limit: 100, offset },
            signal,
          );
          if (result.fallback) {
            fallback = true;
            scores.clear();
            mode = "keyword";
            break;
          }
          mode = result.mode;
          // Upstream does not expose per-reference indexing state in search results.
          // Retain a partial-coverage notice when any library media are unindexed.
          if (result.unindexed) partial = true;
          for (const hit of result.hits) {
            const key = resourceKey({ kind: hit.kind, asset: hit });
            if (libraryRefs.has(key)) scores.set(key, hit.score);
          }
          total = result.total;
          offset += result.hits.length;
          if (!result.hits.length || scores.size === libraryRefs.size) break;
        }
      } catch {
        signal.throwIfAborted();
        fallback = true;
        scores.clear();
        mode = "keyword";
      }
    }
    signal.throwIfAborted();
    const ranked = candidates
      .flatMap((item) => {
        const name = item.name.toLocaleLowerCase();
        const text = [
          name,
          item.description,
          categoryWords[item.category],
          ...item.references.map((r) => (r.media ?? r.asset)!.name),
        ]
          .join(" ")
          .toLocaleLowerCase();
        const match = terms.every((t) => text.includes(t));
        const semantic = Math.max(
          -1,
          ...item.references.map((r) => scores.get(resourceKey(r)) ?? -1),
        );
        if (!match && semantic < 0) return [];
        return [
          {
            item,
            score:
              (match && terms.length
                ? name.includes(terms.join(" "))
                  ? 2
                  : 1
                : 0) + Math.max(0, semantic),
          },
        ];
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.item.updatedAt.localeCompare(a.item.updatedAt) ||
          a.item.id.localeCompare(b.item.id),
      );
    const offset = input.offset ?? 0,
      limit = input.limit ?? 40;
    return {
      items: ranked.slice(offset, offset + limit).map((r) => r.item),
      total: ranked.length,
      mode,
      fallback,
      partial,
    };
  }
  async close() {
    await this.tail;
  }
}
