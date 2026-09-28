import { afterAll, expect, test } from "bun:test";
import { route } from "../src/api/server.ts";

afterAll(() => {
  delete process.env.HM_HOST;
});

test("on a public host, /healthz answers without a token and exposes no data; the app API stays closed", async () => {
  process.env.HM_HOST = "0.0.0.0";
  const h = await route(new Request("http://hm.example.com/healthz"));
  expect(h.status).toBe(200);
  expect(await h.json()).toEqual({ ok: true });
  const s = await route(new Request("http://hm.example.com/api/status"));
  expect(s.status).toBe(401);
});
