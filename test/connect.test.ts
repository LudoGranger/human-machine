import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { qmReachableUrl, qmSetupInstructions, verifyGbrainWorkspace } from "../src/connect.ts";
import { qmProviderConfig } from "../src/qm.ts";

// A minimal hosted-GBrain stand-in speaking MCP over HTTP with a bearer token.
const pages = new Map<string, string>();
let server: ReturnType<typeof Bun.serve>;
let tools = ["put_page", "get_page", "search"];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer gb_test_token_1234567890") return new Response("unauthorized", { status: 401 });
      const m = await req.json();
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers: { "mcp-session-id": "s1" } });
      if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: {} });
      if (m.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (m.method === "tools/list") return reply({ tools: tools.map((name) => ({ name })) });
      if (m.method === "tools/call") {
        const { name, arguments: a } = m.params;
        if (name === "put_page") pages.set(a.slug, a.content);
        if (name === "get_page") return reply({ content: [{ type: "text", text: JSON.stringify({ content: pages.get(a.slug) ?? "" }) }] });
        return reply({ content: [{ type: "text", text: "{}" }] });
      }
      return reply({});
    },
  });
});
afterAll(() => server.stop(true));

describe("hm connect gbrain: the user's own workspace", () => {
  test("a working workspace is checked by writing a page and reading it back", async () => {
    const r = await verifyGbrainWorkspace(`http://127.0.0.1:${server.port}/mcp`, "gb_test_token_1234567890");
    expect(r.slug).toBe("hm/connection-check");
    expect(pages.get("hm/connection-check")).toContain("Human Machine connection check");
    // The check does not leave the workspace configured in this process.
    expect(process.env.GBRAIN_REMOTE_URL).toBeFalsy();
  });

  test("a wrong token fails before anything is saved", async () => {
    await expect(verifyGbrainWorkspace(`http://127.0.0.1:${server.port}/mcp`, "gb_wrong_token_1234567890")).rejects.toThrow("401");
  });

  test("a workspace missing required tools is refused", async () => {
    tools = ["search"];
    await expect(verifyGbrainWorkspace(`http://127.0.0.1:${server.port}/mcp`, "gb_test_token_1234567890")).rejects.toThrow("put_page");
    tools = ["put_page", "get_page", "search"];
  });
});

describe("hm connect qm: the user's own QM deployment", () => {
  test("a laptop address is refused because QM calls from its servers", () => {
    expect(() => qmReachableUrl("http://127.0.0.1:4747")).toThrow("only reachable from this computer");
    expect(() => qmReachableUrl("http://hm.example.com")).toThrow("https");
    expect(qmReachableUrl("https://hm.example.com/some/path")).toBe("https://hm.example.com");
  });

  test("instructions carry the exact provider config and secret names, never the secret values", () => {
    const text = qmSetupInstructions("https://hm.example.com", "/data/qm-client.env", qmProviderConfig("https://hm.example.com"));
    expect(text).toContain("https://hm.example.com/mcp");
    expect(text).toContain('"HM_QM_RW_CLIENT_SECRET": "HM_QM_RW_CLIENT_SECRET"');
    expect(text).toContain("cat /data/qm-client.env >> .env");
    const cfgLine = text.split("\n").find((l) => l.includes("MEMORY_PROVIDER_CONFIG"))!;
    const cfg = JSON.parse(JSON.parse(cfgLine.slice(cfgLine.indexOf(":") + 1).trim()));
    expect(cfg.routes.find((r: any) => r.provider === "human-machine").capture).toBe("explicit");
  });
});
