import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { URL as NodeURL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("outbound request options work in Workers and reject redirects", async (t) => {
  const source = await readFile(new NodeURL("../src/http.ts", import.meta.url), "utf8");
  const script = stripTypeScriptTypes(source);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: "2026-07-30",
    script: script + `
      export default { async fetch() {
        const statuses = [];
        for (const status of [200, 302]) {
          try {
            const response = await request(async (url, init) => {
              new Request(url, init);
              return new Response(null, { status });
            }, "https://example.com", {}, "upstream");
            statuses.push(response.status);
          } catch (error) { statuses.push(errorCode(error)); }
        }
        return Response.json(statuses);
      } }`,
  }));
  t.after(() => mf.dispose());
  assert.deepEqual(await (await mf.dispatchFetch("http://localhost")).json(), [200, "upstream_http_302"]);
});
