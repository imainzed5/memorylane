import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Use the project's TypeScript compiler; no additional test runtime or browser is required.
const source = await readFile(new URL("../src/utils/contentRevision.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { ContentRevision } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("a restore reusing an ID rejects old pixels while accepting new pixels", async () => {
  const revision = new ContentRevision();
  const oldImage = deferred();
  const cache = new Map();
  const pending = revision.read(() => oldImage.promise).then((image) => cache.set(image.id, image.pixels));
  const rejected = assert.rejects(pending, /content changed/);
  revision.invalidate();
  cache.clear();
  const newImage = await revision.read(async () => ({ id: 7, pixels: "restored library" }));
  cache.set(newImage.id, newImage.pixels);
  oldImage.resolve({ id: 7, pixels: "prior library" });
  await rejected;
  assert.equal(cache.get(7), "restored library");
});

test("redaction fences snippets synchronously before effect cleanup", async () => {
  const revision = new ContentRevision();
  const response = deferred();
  const requestRevision = revision.current();
  let snippets = ["sensitive snippet"];
  const pending = response.promise.then((results) => {
    if (revision.isCurrent(requestRevision)) snippets = results;
  });
  revision.invalidate();
  snippets = [];
  response.resolve(["late sensitive snippet"]);
  await pending;
  assert.deepEqual(snippets, []);
  const fresh = revision.current();
  assert.equal(revision.isCurrent(fresh), true);
  revision.invalidate();
  assert.equal(revision.isCurrent(fresh), false);
});

test("a read from before multiple deletions cannot repopulate thumbnails", async () => {
  const revision = new ContentRevision();
  const response = deferred();
  const pending = revision.read(() => response.promise);
  const rejected = assert.rejects(pending, /content changed/);
  revision.invalidate();
  revision.invalidate();
  response.resolve([{ id: 1, thumbnail: "deleted" }]);
  await rejected;
  assert.deepEqual(await revision.read(async () => []), []);
});

test("consumers reject invalidation between read resolution and state commit", async () => {
  const revision = new ContentRevision();
  const requestRevision = revision.current();
  const value = await revision.read(async () => "old thumbnail");
  revision.invalidate();
  let displayed = null;
  // This is why the App's page/context consumers also check at their state commit boundary.
  if (revision.isCurrent(requestRevision)) displayed = value;
  assert.equal(displayed, null);
});
