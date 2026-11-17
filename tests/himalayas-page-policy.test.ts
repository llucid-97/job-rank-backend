import assert from "node:assert/strict";
import test from "node:test";
import { allowedFeed } from "../src/modules/provider-proxy/provider.routes.ts";

const search = (page: string, suffix = "") =>
  `https://himalayas.app/jobs/api/search?worldwide=true&sort=recent&page=${page}${suffix}`;

test("Himalayas permits later safe positive pages", () => {
  assert.equal(allowedFeed(search("11")), true);
  assert.equal(allowedFeed(search("9007199254740991")), true);
});

test("Himalayas rejects malformed and unsafe page numbers", () => {
  for (const page of ["0", "-1", "1.5", "9007199254740992", "1e2"]) {
    assert.equal(allowedFeed(search(page)), false, page);
  }
});

test("Himalayas keeps fixed host, path, scheme and query boundaries", () => {
  assert.equal(
    allowedFeed(
      "https://himalayas.app.evil.test/jobs/api/search?worldwide=true&sort=recent&page=11",
    ),
    false,
  );
  assert.equal(allowedFeed(search("11", "&page=12")), false);
  assert.equal(allowedFeed(search("11", "&redirect=https://localhost")), false);
  assert.equal(
    allowedFeed(
      "http://himalayas.app/jobs/api/search?worldwide=true&sort=recent&page=11",
    ),
    false,
  );
});
