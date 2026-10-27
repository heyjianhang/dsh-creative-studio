import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CreativeAssets } from "../src/host/creative-assets.ts";
import { LibrarySearch } from "../src/host/library-search.ts";
import type {
  CreativeAsset,
  FolderCatalog,
  CreativeAssetDraft,
} from "../src/shared/contracts.ts";

function setup() {
  const assets = new Map<string, CreativeAsset>();
  const folders = new Map<string, FolderCatalog>();
  let fail = false;
  const service = new CreativeAssets(
    {
      get: (id) => assets.get(id),
      entries: () => assets.entries(),
      put: async (id, item) => {
        if (fail) throw new Error("disk full");
        assets.set(id, structuredClone(item));
      },
      delete: async (id) => {
        assets.delete(id);
      },
    },
    new LibrarySearch(() => undefined),
    (r) => structuredClone(r),
    {
      get: (id) => folders.get(id),
      entries: () => folders.entries(),
      put: async (id, item) => {
        folders.set(id, structuredClone(item));
      },
    },
  );
  const draft: CreativeAssetDraft = {
    name: "Original",
    category: "character",
    description: "Reference",
    references: [
      {
        kind: "image",
        media: {
          id: randomUUID(),
          name: "test.png",
          size: 123,
          mime: "image/png",
        },
      },
    ],
    folderId: null,
  };
  return {
    service,
    draft,
    fail: () => {
      fail = true;
    },
  };
}

test("creative assets move across project and personal folders without retaining the old owner", async () => {
  const { service, draft } = setup();
  const projectId = randomUUID();
  const personal = (await service.folders())[0]!;
  const project = (await service.folders(projectId))[0]!;
  const original = await service.create({
    ...draft,
    ownerProjectId: projectId,
    folderId: project.id,
  });
  // Mirrors RPC JSON serialization: undefined ownership is omitted for personal scope.
  const moved = await service.update({
    ...draft,
    id: original.id,
    revision: original.revision,
    folderId: personal.id,
  });
  assert.equal(moved.ownerProjectId, undefined);
  assert.equal(moved.folderId, personal.id);
  assert.equal(moved.createdAt, original.createdAt);
  assert.deepEqual(moved.references, original.references);
  const back = await service.update({
    ...draft,
    id: moved.id,
    revision: moved.revision,
    ownerProjectId: projectId,
    folderId: project.id,
  });
  assert.equal(back.ownerProjectId, projectId);
  assert.equal(back.folderId, project.id);
  const root = await service.update({
    ...draft,
    id: back.id,
    revision: back.revision,
    folderId: null,
  });
  assert.equal(root.ownerProjectId, undefined);
  assert.equal(root.folderId, null);
});

test("creative asset copies share files but rename and removal affect only the copy", async () => {
  const { service, draft } = setup();
  const original = await service.create(draft);
  const copy = await service.create({ ...draft, name: "Copy" });
  assert.notEqual(copy.id, original.id);
  assert.deepEqual(copy.references, original.references);
  const renamed = await service.update({
    ...draft,
    id: copy.id,
    revision: copy.revision,
    name: "Renamed",
  });
  assert.equal(service.get(original.id).name, "Original");
  await assert.rejects(
    service.remove({ id: copy.id, revision: copy.revision }),
    /修改/,
  );
  await service.remove({ id: copy.id, revision: renamed.revision });
  assert.throws(() => service.get(copy.id), /不存在/);
  assert.equal(service.get(original.id).name, "Original");
  assert.equal(service.usesMedia(draft.references[0]!.media!.id), true);
});

test("failed creative asset saves preserve the previous record and its revision", async () => {
  const { service, draft, fail } = setup();
  const original = await service.create(draft);
  fail();
  await assert.rejects(
    service.update({
      ...draft,
      id: original.id,
      revision: original.revision,
      name: "Failed",
    }),
    /disk full/,
  );
  assert.deepEqual(service.get(original.id), original);
});
