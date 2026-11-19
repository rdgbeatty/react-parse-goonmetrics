import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { BrowserEveSso, SCOPES, probeBrowserAccess } from "../spikes/github-only/eve-browser.mjs";
import { GitHubApi } from "../lib/github-client.mjs";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const REDIRECT = "http://localhost:4173/auth/eve/callback";
const ID = "test-public-client";
const metadata = { issuer: "https://login.eveonline.com", authorization_endpoint: "https://login.eveonline.com/v2/oauth/authorize",
  token_endpoint: "https://login.eveonline.com/v2/oauth/token", jwks_uri: "https://login.eveonline.com/oauth/jwks", code_challenge_methods_supported: ["S256"] };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" };
const claims = { iss: metadata.issuer, aud: [ID, "EVE Online"], sub: "CHARACTER:EVE:1234", name: "Collector",
  exp: NOW / 1000 + 1200, scp: SCOPES };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function jwt(overrides = {}, headerOverrides = {}) {
  const parts = [{ alg: "RS256", kid: "test", ...headerOverrides }, { ...claims, ...overrides }].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"));
  return [...parts, sign("RSA-SHA256", Buffer.from(parts.join(".")), privateKey).toString("base64url")].join(".");
}
function harness(options = {}) {
  const map = new Map(), calls = [];
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  let now = NOW;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("oauth-authorization-server")) return json(options.metadata ?? metadata);
    if (url.endsWith("/jwks")) return json({ keys: [jwk] });
    if (url.endsWith("/token")) return options.tokenResponse?.() ?? json({ access_token: options.token ?? jwt(), refresh_token: "fake-refresh-for-test-only" });
    throw new Error("Unexpected request");
  };
  return { sso: new BrowserEveSso({ cryptoImpl: webcrypto, storage, fetchImpl, now: () => now }), calls, map, setNow: (value) => { now = value; } };
}
async function callback(h) {
  const url = new URL(await h.sso.begin(ID, REDIRECT));
  return `${REDIRECT}?code=fake-code-for-test-only&state=${url.searchParams.get("state")}`;
}

test("owner setup clients call native browser fetch with the global receiver", async (t) => {
  t.mock.method(globalThis, "fetch", async function (url) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    if (url === "https://login.eveonline.com/.well-known/oauth-authorization-server") return json(metadata);
    if (url === "https://api.github.com/user") return json({ login: "test-owner" });
    throw new Error("Unexpected request");
  });
  const sso = new BrowserEveSso({ cryptoImpl: webcrypto, storage: new Map() });
  const api = new GitHubApi({ repository: "test-owner/test-repo", token: "fake-owner-token" });
  assert.deepEqual(await sso.metadata(), metadata);
  assert.deepEqual(await api.request("/user"), { login: "test-owner" });
});

test("browser PKCE exchanges with no secret/cookies, validates signed token, and never persists a grant", async () => {
  const h = harness();
  const authorization = new URL(await h.sso.begin(ID, REDIRECT));
  const pending = JSON.parse([...h.map.values()][0]);
  assert.equal(authorization.searchParams.get("code_challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("scope"), SCOPES.join(" "));
  const grant = await h.sso.complete(`${REDIRECT}?code=fake-code-for-test-only&state=${pending.state}`);
  assert.equal(grant.refreshToken, "fake-refresh-for-test-only");
  assert.deepEqual(grant.character, { id: "1234", name: "Collector", scopes: SCOPES });
  assert.equal(h.map.size, 0);
  const exchange = h.calls.find((c) => c.url.endsWith("/token"));
  const body = new URLSearchParams(exchange.init.body);
  assert.equal(body.get("code_verifier"), pending.verifier);
  assert.equal(body.get("client_id"), ID);
  assert.equal(body.has("client_secret"), false);
  assert.equal(exchange.init.headers.Authorization, undefined);
  assert.equal(exchange.init.credentials, "omit");
  assert.equal(exchange.init.redirect, "error");
  await assert.rejects(h.sso.complete(`${REDIRECT}?code=used&state=${pending.state}`), /state/);
});

test("browser callback rejects wrong state, callback path, duplicate code and expired transaction before token exchange", async () => {
  for (const change of [
    (url) => url.replace(/state=.*/, "state=wrong"),
    (url) => url.replace("/auth/eve/callback", "/wrong"),
    (url) => `${url}&code=second`,
    (url, h) => { h.setNow(NOW + 600_001); return url; },
  ]) {
    const h = harness(); const url = await callback(h);
    await assert.rejects(h.sso.complete(change(url, h)), /state|authorization code/);
    assert.equal(h.calls.some((c) => c.url.endsWith("/token")), false);
    assert.equal(h.map.size, 0);
  }
});

test("browser token validation rejects missing scope, wrong character/audience, expiry, future nbf, and tampering", async () => {
  for (const token of [jwt({ scp: [SCOPES[0]] }), jwt({ sub: "USER:EVE:1234" }), jwt({ aud: ["other", "EVE Online"] }),
    jwt({ exp: NOW / 1000 }), jwt({ nbf: NOW / 1000 + 60 }), jwt({}, { alg: "HS256" }),
    jwt().replace(/.$/, "!"),
    (() => { const parts = jwt().split("."); parts[1] = Buffer.from(JSON.stringify({ ...claims, name: "Impostor" })).toString("base64url"); return parts.join("."); })()]) {
    const h = harness({ token });
    await assert.rejects(h.sso.complete(await callback(h)), /could not be verified/);
    assert.equal(h.map.size, 0);
  }
});

test("browser metadata cannot redirect an exchange to an arbitrary token endpoint", async () => {
  const h = harness({ metadata: { ...metadata, token_endpoint: "https://attacker.invalid/token" } });
  await assert.rejects(h.sso.begin(ID, REDIRECT), /Unexpected EVE/);
  assert.equal(h.calls.length, 1);
});

test("browser failures never echo upstream descriptions, authorization codes, or token strings", async () => {
  const h = harness({ tokenResponse: () => json({ error: "invalid_grant", error_description: "fake-secret-that-must-not-appear" }, 400) });
  const url = await callback(h);
  await assert.rejects(h.sso.complete(url), (error) => {
    assert.match(error.message, /400, invalid_grant/);
    assert.doesNotMatch(error.message, /fake-secret|fake-code/);
    return true;
  });
  assert.equal(h.map.size, 0);
});

test("browser access probes distinguish a readable HTML rejection from a network/CORS failure", async () => {
  const results = await probeBrowserAccess({ fetchImpl: async (url) => {
    if (url.endsWith("/token")) return new Response("<html>upstream error body</html>", { status: 401 });
    if (url.includes("api.github.com")) throw new TypeError("CORS failure");
    return json({});
  } });
  const token = results.find((r) => r.name.startsWith("EVE token"));
  assert.equal(token.readable, true); assert.equal(token.status, 401);
  assert.equal(results.at(-1).readable, false);
  assert.doesNotMatch(JSON.stringify(results), /upstream error body|deliberately-invalid/);
});
