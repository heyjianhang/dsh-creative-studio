import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MediaDownloads,
  savePickedFile,
  safeDownloadName,
} from "../src/client/media-download.ts";
const file = { src: "blob:prepared", blob: new Blob(["original"]) };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("duplicate gestures share a download; preparing alone never saves or releases it", async () => {
  const controller = new MediaDownloads();
  let loads = 0,
    released = 0;
  const load = () => {
    loads++;
    return {
      promise: Promise.resolve(file),
      release() {
        released++;
      },
    };
  };
  const done = controller.prepare("a", "image.png", load);
  assert.equal(controller.prepare("a", "image.png", load), done);
  assert.equal(controller.getSnapshot()?.status, "preparing");
  await tick();
  assert.equal(loads, 1);
  assert.equal(released, 0);
  assert.equal(controller.getSnapshot()?.status, "ready");
  let writes = 0;
  const id = controller.getSnapshot()!.id;
  assert.equal(
    await controller.save(id, "renamed.png", async (actual, name) => {
      writes++;
      assert.equal(actual.blob, file.blob);
      assert.equal(name, "renamed.png");
      return "saved";
    }),
    "saved",
  );
  assert.equal(await done, true);
  assert.equal(writes, 1);
  assert.equal(released, 1);
  assert.equal(controller.getSnapshot(), undefined);
  controller.dispose();
});

test("cancel before file readiness ignores late completion and leaves the next download intact", async () => {
  const controller = new MediaDownloads();
  let resolve!: (value: typeof file) => void;
  let released = 0;
  const first = controller.prepare("a", "first", () => ({
    promise: new Promise((r) => {
      resolve = r;
    }),
    release() {
      released++;
    },
  }));
  const second = controller.prepare("b", "second", () => ({
    promise: Promise.resolve(file),
    release() {
      released++;
    },
  }));
  controller.cancel(controller.getSnapshot()!.id);
  assert.equal(await first, false);
  resolve(file);
  await tick();
  assert.equal(controller.getSnapshot()?.name, "second");
  assert.equal(controller.getSnapshot()?.status, "ready");
  controller.dispose();
  assert.equal(await second, false);
  assert.equal(released, 2);
});

test("save-dialog cancellation and disk failure retain the file for retry without success", async () => {
  const controller = new MediaDownloads();
  const done = controller.prepare("a", "name.png", () => ({
    promise: Promise.resolve(file),
    release() {},
  }));
  await tick();
  const id = controller.getSnapshot()!.id;
  assert.equal(
    await controller.save(id, "name.png", async () => {
      throw new DOMException("Cancelled", "AbortError");
    }),
    undefined,
  );
  assert.equal(controller.getSnapshot()?.status, "ready");
  assert.equal(controller.getSnapshot()?.error, undefined);
  assert.equal(
    await controller.save(id, "name.png", async () => {
      throw new Error("Disk full");
    }),
    undefined,
  );
  assert.equal(controller.getSnapshot()?.error, "Disk full");
  assert.equal(
    await controller.save(id, "name.png", async () => "browser"),
    "browser",
  );
  assert.equal(await done, true);
  controller.dispose();
});

test("native saving waits for close and aborts a failed write", async () => {
  const calls: string[] = [];
  const picker = async ({ suggestedName }: { suggestedName: string }) => {
    calls.push(suggestedName);
    return {
      createWritable: async () => ({
        write: async (blob: Blob) => {
          calls.push(await blob.text());
        },
        close: async () => {
          calls.push("close");
        },
        abort: async () => {
          calls.push("abort");
        },
      }),
    };
  };
  assert.equal(await savePickedFile(picker, file, "name.png"), "saved");
  assert.deepEqual(calls, ["name.png", "original", "close"]);
  await assert.rejects(
    savePickedFile(
      async () => ({
        createWritable: async () => ({
          write: async () => {
            throw new Error("Disk full");
          },
          close: async () => {},
          abort: async () => {
            calls.push("abort");
          },
        }),
      }),
      file,
      "name.png",
    ),
    /Disk full/,
  );
  assert.equal(calls.at(-1), "abort");
  assert.equal(safeDownloadName("../bad/name.png"), ".._bad_name.png");
});
