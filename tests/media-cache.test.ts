import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaCache, MediaReadQueue } from "../src/client/media-cache.ts";
import { readMediaBlob, mediaKey } from "../src/client/media-source.ts";
import type { Request } from "../src/shared/contracts.ts";
import type { CreativeNode } from "../src/shared/contracts.ts";

const data: CreativeNode["data"] = {
  kind: "video",
  label: "test",
  text: "",
  media: { id: "video", name: "v.mp4", mime: "video/mp4", size: 15 },
};
function cache(budget = 100, ttl = 60_000) {
  const revoked: string[] = [];
  let created = 0;
  const value = new MediaCache(budget, ttl, {
    create: () => `blob:${++created}`,
    revoke: (url) => revoked.push(url),
  });
  return { value, revoked, created: () => created };
}

test("canvas, preview and thumbnails share a load and retain the URL across remounts", async (t) => {
  const { value, revoked, created } = cache();
  t.after(() => value.dispose());
  let calls = 0,
    finish!: (blob: Blob) => void;
  const read = async () => {
    calls++;
    return new Promise<Blob>((resolve) => {
      finish = resolve;
    });
  };
  const key = mediaKey("project", data, false);
  assert.equal(mediaKey("project", data, true), key);
  const canvas = value.acquire(key, read);
  const preview = value.acquire(key, read);
  await Promise.resolve();
  canvas.release();
  finish(new Blob(["video"]));
  assert.equal((await preview.promise).src, (await canvas.promise).src);
  preview.release();
  const remounted = value.acquire(key, read);
  assert.equal((await remounted.promise).src, "blob:1");
  assert.equal(calls, 1);
  assert.equal(created(), 1);
  assert.deepEqual(revoked, []);
  remounted.release();
});

test("LRU only evicts idle media; active consumers and seeded uploads keep valid URLs", async (t) => {
  const { value, revoked } = cache(8);
  t.after(() => value.dispose());
  const a = value.acquire("a", async () => new Blob(["123456"]));
  await a.promise;
  value.seed("upload", new Blob(["abcdef"]));
  const upload = value.acquire("upload", async () => {
    throw new Error("must not reread upload");
  });
  await upload.promise;
  a.release();
  assert.deepEqual(revoked, []);
  upload.release();
  assert.equal(revoked.length, 1);
  assert.ok(value.peek("upload"));
});

test("failed loads retry, disposed in-flight reads cannot leak object URLs", async (t) => {
  const { value, created, revoked } = cache();
  t.after(() => value.dispose());
  const failed = value.acquire("bad", async () => {
    throw new Error("offline");
  });
  await assert.rejects(failed.promise, /offline/);
  failed.release();
  const retry = value.acquire("bad", async () => new Blob(["ok"]));
  await retry.promise;
  let finish!: (blob: Blob) => void;
  const late = value.acquire(
    "late",
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  value.dispose();
  finish(new Blob(["late"]));
  await assert.rejects(late.promise, { name: "AbortError" });
  assert.equal(created(), 1);
  assert.deepEqual(revoked, ["blob:1"]);
});

test("idle expiry revokes only unused URLs, never a currently displayed medium", async (t) => {
  const { value, revoked } = cache(100, 10);
  t.after(() => value.dispose());
  const live = value.acquire("live", async () => new Blob(["live"]));
  await live.promise;
  value.seed("idle", new Blob(["idle"]));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(value.peek("live"));
  assert.equal(value.peek("idle"), undefined);
  assert.equal(revoked.length, 1);
  live.release();
});

test("parallel chunks remain in byte order and malformed partial responses are rejected", async () => {
  let active = 0,
    peak = 0;
  const bytes = Buffer.from("abcdefghijklmno");
  const request = (async (_method: string, input: { offset: number }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) =>
      setTimeout(resolve, input.offset === 3 ? 12 : 1),
    );
    active--;
    const part = bytes.subarray(input.offset, input.offset + 3);
    return {
      data: part.toString("base64"),
      size: bytes.length,
      mime: "video/mp4",
      nextOffset: input.offset + part.length,
    };
  }) as Request;
  const blob = await readMediaBlob(
    request,
    "project",
    data,
    false,
    new AbortController().signal,
  );
  assert.equal(await blob.text(), bytes.toString());
  assert.equal(blob.type, "video/mp4");
  assert.equal(peak, 4);
  await assert.rejects(
    readMediaBlob(
      (async () => ({
        data: "YQ==",
        size: 10,
        mime: "video/mp4",
        nextOffset: 3,
      })) as Request,
      "project",
      data,
      false,
      new AbortController().signal,
    ),
    /读取不完整/,
  );
});

test("session read queue bounds concurrency and removes cancelled waiting readers", async () => {
  const queue = new MediaReadQueue(1);
  let release!: () => void;
  const first = queue.run(
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const abort = new AbortController();
  let cancelledRan = false;
  const cancelled = queue.run(abort.signal, async () => {
    cancelledRan = true;
  });
  abort.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const next = queue.run(new AbortController().signal, async () => "next");
  release();
  await first;
  assert.equal(await next, "next");
  assert.equal(cancelledRan, false);
});
