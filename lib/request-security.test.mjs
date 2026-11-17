import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./request-security.ts");
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  })), true);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "localhost:30141" },
  })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("allows IPv6 and an explicitly configured hostname", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const ipv6 = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "[::1]:30141",
      origin: "http://[::1]:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  const configured = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi-web.internal:30141",
      origin: "http://pi-web.internal:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(ipv6), true);
  assert.equal(isApiRequestAllowed(configured, ["pi-web.internal"]), true);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { host: "localhost:30141", "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestAllowed(crossSiteGet), false);
});

test("does not globally trust opaque iframe or alternate loopback origins", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const previewUrl = "http://localhost:30141/api/files/tmp/test.docx?type=preview";
  const opaqueIframe = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    },
  });
  const alternateLoopback = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "cross-site",
    },
  });

  assert.equal(isApiRequestAllowed(opaqueIframe), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
});

test("allows only user-initiated session export document navigations from a PWA", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const navigationHeaders = {
    host: "127.0.0.1:30141",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };

  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: navigationHeaders },
  )), true);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions",
    { headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, "sec-fetch-dest": "empty" } },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    {
      headers: {
        ...navigationHeaders,
        "sec-fetch-user": "",
      },
    },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { method: "POST", headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, host: "attacker.example:30141" } },
  )), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects DNS rebinding even when browser headers say same-origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/skills/install", {
    method: "POST",
    headers: {
      host: "attacker.example:30141",
      origin: "http://attacker.example:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects missing, malformed, and unconfigured Host headers", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test")), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "localhost@attacker.example:30141" },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "pi-web.internal:30141" },
  })), false);
});

test("recognizes JSON request content types", async () => {
  const { hasJsonContentType } = await loadSubject();
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/problem+json" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "text/plain" },
  })), false);
});

// The engine's entry passes a policy: loopback and the configured tailnet only, plus the HTTPS origins
// `tailscale serve` terminated. A caller with no policy (the Next entry, the GUI's routes) keeps today's rule.
const TAILNET_POLICY = {
  restrictHosts: true,
  tailnetHosts: ["100.64.0.5", "fd7a:115c:a1e0::1", "pc.example.ts.net"],
  tailnetOrigins: ["https://pc.example.ts.net:8443"],
};

test("the engine's policy takes the configured tailnet Hosts and refuses the others", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const allowed = [
    "100.64.0.5:30144",
    "pc.example.ts.net:30144",
    "[fd7a:115c:a1e0::1]:30144",
    "127.0.0.1:30144",
    "localhost:30144",
    "[::1]:30144",
  ];
  for (const host of allowed) {
    assert.equal(isApiRequestAllowed(new Request("http://127.0.0.1:30144/api/test", { headers: { host } }), [], TAILNET_POLICY), true, host);
  }
  const refused = [
    "192.168.11.22:30144",
    "8.8.8.8:30144",
    "100.64.0.9:30144",
    "100.128.0.1:30144",
    "example.com",
    "other.ts.net:30144",
    "attacker.example:30144",
  ];
  for (const host of refused) {
    assert.equal(isApiRequestAllowed(new Request("http://127.0.0.1:30144/api/test", { headers: { host } }), [], TAILNET_POLICY), false, host);
  }
  // an engine with no tailnet setting still refuses a stray IP Host
  const empty = { restrictHosts: true, tailnetHosts: [], tailnetOrigins: [] };
  assert.equal(isApiRequestAllowed(new Request("http://127.0.0.1:30144/api/test", { headers: { host: "192.168.11.22:30144" } }), [], empty), false);
  assert.equal(isApiRequestAllowed(new Request("http://127.0.0.1:30144/api/test", { headers: { host: "127.0.0.1:30144" } }), [], empty), true);
});

test("the engine's policy takes a configured origin even when the request reached it over http", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const serveTerminated = new Request("http://127.0.0.1:30144/api/test", {
    method: "POST",
    headers: {
      host: "pc.example.ts.net:30144",
      origin: "https://pc.example.ts.net:8443",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(serveTerminated, [], TAILNET_POLICY), true);
  // the tailnet address's own http origin, with the Host matching it, is same-origin as before
  const addressOrigin = new Request("http://100.64.0.5:30144/api/test", {
    method: "POST",
    headers: {
      host: "100.64.0.5:30144",
      origin: "http://100.64.0.5:30144",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(addressOrigin, [], TAILNET_POLICY), true);
});

test("the engine's policy refuses an unconfigured origin and every cross-site request", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const cases = [
    "https://evil.example",
    "https://pc.example.ts.net:8443.evil.example",
    "https://pc.example.ts.net:9443",
    "http://pc.example.ts.net:8443",
    "https://pc.example.ts.net",
  ];
  for (const origin of cases) {
    assert.equal(isApiRequestAllowed(new Request("http://127.0.0.1:30144/api/test", {
      method: "POST",
      headers: { host: "pc.example.ts.net:30144", origin, "sec-fetch-site": "same-site" },
    }), [], TAILNET_POLICY), false, origin);
  }
  const crossSite = new Request("http://127.0.0.1:30144/api/test", {
    method: "POST",
    headers: { host: "pc.example.ts.net:30144", origin: "https://pc.example.ts.net:8443", "sec-fetch-site": "cross-site" },
  });
  assert.equal(isApiRequestAllowed(crossSite, [], TAILNET_POLICY), false);
  // a policy that names an http or IP origin does not make it acceptable
  const badPolicy = { restrictHosts: true, tailnetHosts: ["100.64.0.5"], tailnetOrigins: ["http://100.64.0.5:30144"] };
  const httpOrigin = new Request("http://127.0.0.1:30144/api/test", {
    headers: { host: "100.64.0.5:30144", origin: "http://100.64.0.5:30144", "sec-fetch-site": "same-origin" },
  });
  // the request's own Host rebuilds the same origin, so it is taken as same-origin; the configured http origin adds nothing
  assert.equal(isApiRequestAllowed(httpOrigin, [], badPolicy), true);
  const ipOriginFromElsewhere = new Request("http://127.0.0.1:30144/api/test", {
    headers: { host: "pc.example.ts.net:30144", origin: "http://100.64.0.5:30144", "sec-fetch-site": "same-site" },
  });
  assert.equal(isApiRequestAllowed(ipOriginFromElsewhere, [], badPolicy), false);
});

test("a policy leaves the Next entry's no-argument judgment unchanged", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  process.env.IDD_TAILNET_ORIGINS = "https://pc.example.ts.net:8443";
  process.env.IDD_TAILNET_ADDRESSES = "100.64.0.5";
  try {
    const lan = new Request("http://localhost:30141/api/test", {
      method: "POST",
      headers: { host: "192.168.32.7:30141", origin: "http://192.168.32.7:30141", "sec-fetch-site": "same-origin" },
    });
    assert.equal(isApiRequestAllowed(lan), true);
  } finally {
    delete process.env.IDD_TAILNET_ORIGINS;
    delete process.env.IDD_TAILNET_ADDRESSES;
  }
});
