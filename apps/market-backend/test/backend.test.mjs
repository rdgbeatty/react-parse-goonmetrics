import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { createFixture } from "../lib/fixture.mjs";
import { validateSnapshot, compareHubs, sortOpportunities, describeDataAge } from "../../../packages/shared/src/marketSnapshot.mjs";
import { readJson, writeJson, publishSnapshot, withLock } from "../lib/storage.mjs";
import { EveSso, EVE_SCOPES } from "../lib/auth.mjs";
import { EsiClient } from "../lib/esi.mjs";
import { regionalWeekVolume, summarizeOrders, selectSampleTypes, collectLive } from "../lib/collector.mjs";
import { initialize, createPrototypeServer, exportSite } from "../lib/server.mjs";

const NOW = new Date("2026-11-06T15:00:00Z");
const jsonResponse = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
const order = (overrides = {}) => ({ order_id: 1, type_id: 34, location_id: 60003760, volume_remain: 100, is_buy_order: false, price: 100, ...overrides });
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "market-poc-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("60,000 fixture rows round-trip and compare every hub direction without a server", () => {
  const snapshot = validateSnapshot(JSON.parse(JSON.stringify(createFixture(20_000, NOW))));
  assert.equal(snapshot.hubs.reduce((sum, hub) => sum + hub.rows.length, 0), 60_000);
  for (const source of snapshot.hubs) for (const destination of snapshot.hubs) {
    assert.equal(compareHubs(snapshot, source.id, destination.id).length, source.id === destination.id ? 0 : 20_000);
  }
});

test("quote policy uses the chosen sale side and preserves unavailable hauling/profit", () => {
  const snapshot = createFixture(2, NOW);
  snapshot.hubs[0].rows[0] = { ...snapshot.hubs[0].rows[0], sell: 100, volumeM3: 2 };
  snapshot.hubs[1].rows[0] = { ...snapshot.hubs[1].rows[0], buy: 2500, sell: 3000, regionalWeekVolume: null };
  const listing = compareHubs(snapshot, "jita", "tortuga", { haul: 700, tax: 5.37 })[0];
  assert.equal(listing.transport, 1400);
  assert.equal(listing.profit, 3000 * 0.9463 - 1500);
  assert.equal(listing.regionalWeekVolume, null);
  assert.equal(compareHubs(snapshot, "jita", "tortuga", { sale: "instant" })[0].destinationPrice, 2500);
  snapshot.hubs[0].rows[0].volumeM3 = null;
  assert.equal(compareHubs(snapshot, "jita", "tortuga")[0].profit, null);
  snapshot.hubs[0].rows[0].volumeM3 = 0;
  assert.equal(compareHubs(snapshot, "jita", "tortuga")[0].transport, 0);
});

test("missing values sort last in either direction and do not mutate source rows", () => {
  const rows = [{ itemName: "missing", profit: null }, { itemName: "low", profit: -2 }, { itemName: "high", profit: 3 }];
  assert.deepEqual(sortOpportunities(rows).map((row) => row.itemName), ["high", "low", "missing"]);
  assert.deepEqual(sortOpportunities(rows, "profit", "asc").map((row) => row.itemName), ["low", "high", "missing"]);
  assert.equal(rows[0].itemName, "missing");
});

test("snapshot boundary rejects credentials, duplicates and invalid quotes", () => {
  const snapshot = createFixture(2, NOW);
  assert.throws(() => validateSnapshot({ ...snapshot, refreshToken: "never-public" }), /unexpected field/);
  snapshot.hubs[0].rows[1].typeId = snapshot.hubs[0].rows[0].typeId;
  assert.throws(() => validateSnapshot(snapshot), /duplicate/);
  const invalid = createFixture(1, NOW); invalid.hubs[0].rows[0].sell = NaN;
  assert.throws(() => validateSnapshot(invalid), /sell/);
});

test("failed publication retains the last good file and operations serialize", async (t) => {
  const directory = await temporary(t), path = join(directory, "market.json");
  await publishSnapshot(path, createFixture(1, NOW));
  const previous = await readFile(path, "utf8");
  await assert.rejects(publishSnapshot(path, { schemaVersion: 100 }), /unsupported schema/);
  assert.equal(await readFile(path, "utf8"), previous);
  await withLock(directory, () => assert.rejects(withLock(directory, async () => {}), /Another local operation/));
  await withLock(directory, async () => {});
});

test("regional volume uses seven completed UTC days and leaves missing days unknown", () => {
  const valid = Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.UTC(2026, 10, 5 - i)).toISOString().slice(0, 10), volume: 10 }));
  assert.equal(regionalWeekVolume([...valid, { date: "2026-11-06", volume: 999 }], NOW), 70);
  assert.equal(regionalWeekVolume(valid.slice(1), NOW), null);
  assert.equal(regionalWeekVolume([], NOW), null);
});

test("market data age distinguishes minutes, hours and stale days independently of file generation", () => {
  const age = (minutes) => describeDataAge(new Date(NOW.getTime() - minutes * 60_000).toISOString(), NOW.getTime());
  assert.deepEqual(age(30), { ageMs: 1_800_000, text: "30 minutes old", tone: "fresh" });
  assert.equal(age(61).text, "1 hour 1 minute old");
  assert.equal(age(61).tone, "aging");
  assert.equal(age(480).tone, "stale");
  assert.equal(age(1440).text, "1 day old");
  assert.equal(age(1500).text, "1 day 1 hour old");
  assert.equal(age(-5).text, "Less than a minute old");
});

test("aggregation chooses best prices, sums side units and preserves missing sides", () => {
  const metadata = new Map([[34, { name: "Tritanium", packaged_volume: 0.01 }], [35, { name: "Pyerite" }]]);
  const rows = summarizeOrders([order({ price: 110 }), order({ order_id: 2, price: 90 }), order({ order_id: 3, price: 85, is_buy_order: true })], [34, 35], metadata, new Map([[34, 70]]));
  assert.equal(rows[0].sell, 90); assert.equal(rows[0].buy, 85); assert.equal(rows[0].sellUnits, 200);
  assert.equal(rows[1].sell, null); assert.equal(rows[1].volumeM3, null); assert.equal(rows[1].regionalWeekVolume, null);
});

test("ESI pagination, duplicate IDs and fresh cache reuse are correct", async (t) => {
  const directory = await temporary(t); let calls = 0;
  const progress = [];
  const esi = new EsiClient({ cacheDirectory: directory, userAgent: "test", fetchImpl: async (url) => {
    calls++; return jsonResponse([order({ order_id: url.endsWith("page=1") ? 1 : 2 })], { "X-Pages": "2", "Cache-Control": "max-age=60" });
  } });
  assert.equal((await esi.orders("/markets/10000002/orders?order_type=all", false, (value) => progress.push(value))).orders.length, 2);
  assert.deepEqual(progress[0], { completed: 0, total: null, page: 1, ordersReceived: 0 });
  assert.deepEqual(progress.at(-1), { completed: 2, total: 2, page: 2, ordersReceived: 2 });
  const cachedProgress = [];
  await esi.orders("/markets/10000002/orders?order_type=all", false, (value) => cachedProgress.push(value));
  assert.deepEqual(cachedProgress, progress);
  assert.equal(calls, 2); assert.equal(esi.statistics.cacheHits, 2);
});

test("market timestamps use upstream modification time and preserve age through 304/cache reuse", async (t) => {
  const directory = await temporary(t);
  const modified = new Date(NOW.getTime() - 24 * 60 * 60_000);
  let calls = 0;
  const esi = new EsiClient({ cacheDirectory: directory, userAgent: "test", now: () => NOW.getTime(), fetchImpl: async () => {
    calls++;
    return calls === 1 ? jsonResponse([order()], { "Last-Modified": modified.toUTCString(), ETag: '"old-book"' }) :
      new Response(null, { status: 304, headers: { "Cache-Control": "max-age=60" } });
  } });
  assert.equal((await esi.get("/book")).observedAt, modified.toISOString());
  assert.equal((await esi.get("/book")).observedAt, modified.toISOString());
  assert.equal((await esi.get("/book")).observedAt, modified.toISOString());
  assert.equal(calls, 2);
  const dated = new EsiClient({ cacheDirectory: directory, userAgent: "test", now: () => NOW.getTime(), fetchImpl: async () =>
    jsonResponse([order()], { Date: NOW.toUTCString(), Age: "1800" }) });
  assert.equal((await dated.get("/dated-book")).observedAt, new Date(NOW.getTime() - 1_800_000).toISOString());
  const originDate = new Date(NOW.getTime() - 1_800_000);
  const aged = new EsiClient({ cacheDirectory: directory, userAgent: "test", now: () => NOW.getTime(), fetchImpl: async () =>
    jsonResponse([order()], { Date: originDate.toUTCString(), Age: "1800" }) });
  assert.equal((await aged.get("/aged-book")).observedAt, originDate.toISOString());
  const paged = new EsiClient({ cacheDirectory: directory, userAgent: "test", now: () => NOW.getTime(), fetchImpl: async (url) =>
    jsonResponse([order({ order_id: url.endsWith("page=1") ? 1 : 2 })], { "X-Pages": "2", "Last-Modified": url.endsWith("page=1") ? NOW.toUTCString() : modified.toUTCString() }) });
  assert.equal((await paged.orders("/paged-book")).observedAt, modified.toISOString());
});

test("ESI 304 retains its cached body, while rate/permission errors stop collection", async (t) => {
  const directory = await temporary(t); let calls = 0;
  const esi = new EsiClient({ cacheDirectory: directory, userAgent: "test", fetchImpl: async () => {
    calls++; return calls === 1 ? jsonResponse([order()], { ETag: '"one"', "Cache-Control": "max-age=0" }) : new Response(null, { status: 304 });
  } });
  await esi.get("/example"); assert.equal((await esi.get("/example")).body[0].price, 100);
  for (const status of [403, 420, 429]) {
    const failing = new EsiClient({ cacheDirectory: directory, userAgent: "test", fetchImpl: async () => new Response(null, { status, headers: { "Retry-After": "60" } }) });
    await assert.rejects(failing.get(`/failure-${status}`), new RegExp(String(status)));
  }
});

test("inconsistent page counts and unsafe int64 IDs cannot become a snapshot", async (t) => {
  const directory = await temporary(t);
  const esi = new EsiClient({ cacheDirectory: directory, userAgent: "test", fetchImpl: async (url) => jsonResponse([order()], { "X-Pages": url.endsWith("page=1") ? "2" : "3" }) });
  await assert.rejects(esi.orders("/changing"), /page count changed/);
  const unsafe = new EsiClient({ cacheDirectory: directory, userAgent: "test", fetchImpl: async () => jsonResponse([order({ order_id: Number.MAX_SAFE_INTEGER + 1 })]) });
  await assert.rejects(unsafe.orders("/unsafe"), /unsafe integer/);
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" };
function signedToken(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: "https://login.eveonline.com/", aud: ["test-client", "EVE Online"],
    exp: NOW.getTime() / 1000 + 1200, sub: "CHARACTER:EVE:123", name: "Test Pilot", scp: EVE_SCOPES, ...overrides })).toString("base64url");
  const payload = `${header}.${claims}`;
  return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
}
function mockSso(fetchExtra = () => {}) {
  return new EveSso({ now: () => NOW.getTime(), fetchImpl: async (url, options) => {
    const extra = fetchExtra(url, options); if (extra) return extra;
    if (url.includes(".well-known")) return jsonResponse({ issuer: "https://login.eveonline.com/", authorization_endpoint: "https://login.eveonline.com/v2/oauth/authorize", token_endpoint: "https://login.eveonline.com/v2/oauth/token", jwks_uri: "https://login.eveonline.com/oauth/jwks" });
    if (url.endsWith("jwks")) return jsonResponse({ keys: [jwk] });
    return jsonResponse({ access_token: signedToken(), refresh_token: "replacement-grant" });
  } });
}

test("SSO verifies signatures, issuer, expiry, client audience and required scopes", async () => {
  const sso = mockSso();
  assert.equal((await sso.validateAccessToken(signedToken(), "test-client")).id, "123");
  for (const overrides of [{ iss: null }, { iss: "https://attacker.test" }, { aud: ["other", "EVE Online"] }, { exp: 1 }, { scp: [] }]) {
    await assert.rejects(sso.validateAccessToken(signedToken(overrides), "test-client"), /could not be verified/);
  }
  const parts = signedToken().split("."); parts[1] = Buffer.from('{"name":"tampered"}').toString("base64url");
  await assert.rejects(sso.validateAccessToken(parts.join("."), "test-client"), /signature verification/);
});

test("rotated refresh grant is persisted before later validation can fail", async () => {
  const saved = [];
  const sso = mockSso((url) => url.endsWith("jwks") ? new Response(null, { status: 503 }) : null);
  await assert.rejects(sso.refresh({ clientId: "test-client", clientSecret: "private" }, { refreshToken: "old" }, async (value) => saved.push(value)), /503/);
  assert.equal(saved[0].refreshToken, "replacement-grant");
  assert.equal("accessToken" in saved[0], false);
});

test("SSO reports rejected application credentials separately from an expired character grant", async () => {
  for (const grantType of ["authorization_code", "refresh_token"]) {
    const saved = [];
    const sso = mockSso((url, options) => {
      if (!url.endsWith("/token")) return null;
      assert.equal(options.method, "POST");
      assert.equal(Buffer.from(options.headers.Authorization.slice(6), "base64").toString(), "test-client:private-secret");
      assert.equal(new URLSearchParams(options.body).get("grant_type"), grantType);
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="SSO"' } });
    });
    const operation = grantType === "authorization_code"
      ? sso.authorize({ clientId: "test-client", clientSecret: "private-secret" }, "private-code", "http://localhost:4173/auth/eve/callback", async (value) => saved.push(value))
      : sso.refresh({ clientId: "test-client", clientSecret: "private-secret" }, { refreshToken: "private-grant" }, async (value) => saved.push(value));
    await assert.rejects(operation, (error) => {
      assert.equal(error.stage, grantType === "authorization_code" ? "authorization code exchange" : "refresh token exchange");
      assert.match(error.message, /application credentials/);
      assert.doesNotMatch(error.message, /grant was revoked|private-secret|private-code|private-grant/);
      return true;
    });
    assert.equal(saved.length, 0);
  }
});

test("OAuth Basic authentication form-encodes reserved characters in both client components", async () => {
  let captured = false;
  const clientId = "client:id+id";
  const clientSecret = "secret:with+slash/percent%and&space here";
  const sso = mockSso((url, options) => {
    if (!url.endsWith("/token")) return null;
    const basic = Buffer.from(options.headers.Authorization.slice(6), "base64").toString();
    assert.equal(basic, "client%3Aid%2Bid:secret%3Awith%2Bslash%2Fpercent%25and%26space+here");
    const [id, secret] = basic.split(":");
    assert.equal(new URLSearchParams(`value=${id}`).get("value"), clientId);
    assert.equal(new URLSearchParams(`value=${secret}`).get("value"), clientSecret);
    assert.equal(new URLSearchParams(options.body).get("code"), "one-use-code");
    captured = true;
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  });
  await assert.rejects(sso.authorize({ clientId, clientSecret }, "one-use-code", "http://localhost:4173/auth/eve/callback", async () => {}), /authorization code expired/);
  assert.equal(captured, true);
});

test("SSO uses advertised form client authentication for both code and refresh requests", async () => {
  const requests = [];
  const config = { clientId: "test-client", clientSecret: "private:secret+with/&%punctuation" };
  const sso = mockSso((url, options) => {
    if (url.includes(".well-known")) return jsonResponse({ issuer: "https://login.eveonline.com/", authorization_endpoint: "https://login.eveonline.com/v2/oauth/authorize",
      token_endpoint: "https://login.eveonline.com/v2/oauth/token", jwks_uri: "https://login.eveonline.com/oauth/jwks", token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] });
    if (!url.endsWith("/token")) return null;
    assert.equal(options.headers.Authorization, undefined);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("client_id"), config.clientId);
    assert.equal(form.get("client_secret"), config.clientSecret);
    requests.push(form.get("grant_type"));
    return jsonResponse({ access_token: signedToken(), refresh_token: "replacement-grant" });
  });
  let grant;
  const persist = async (value) => { grant = value; };
  const result = await sso.authorize(config, "one-use-code", "http://localhost:4173/auth/eve/callback", persist);
  assert.equal(result.character.id, "123");
  await sso.refresh(config, grant, persist);
  assert.deepEqual(requests, ["authorization_code", "refresh_token"]);
});

const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

test("local PKCE authorization uses the RFC S256 challenge and never exposes its verifier", async () => {
  const url = new URL(await mockSso().authorizationUrl({ clientId: "test-client", clientSecret: "unused-secret" }, "http://localhost:4173/auth/eve/callback", "browser-state", PKCE_VERIFIER));
  assert.equal(url.searchParams.get("code_challenge"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:4173/auth/eve/callback");
  assert.equal(url.searchParams.get("state"), "browser-state");
  assert.equal(url.searchParams.has("code_verifier"), false);
  assert.equal(url.href.includes("unused-secret"), false);
});

test("PKCE token exchange binds the verifier and refreshes without any application secret", async () => {
  const forms = [];
  const sso = mockSso((url, options) => {
    if (!url.endsWith("/token")) return null;
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("client_id"), "test-client");
    assert.equal(form.has("client_secret"), false);
    assert.equal(options.headers.Authorization, undefined);
    forms.push(form);
    return jsonResponse({ access_token: signedToken(), refresh_token: forms.length === 1 ? "pkce-grant" : "rotated-pkce-grant" });
  });
  const config = { clientId: "test-client", clientSecret: "never-transmit-this" };
  let grant;
  const persist = async (value) => { grant = value; };
  await sso.authorize(config, "one-use-code", "http://localhost:4173/auth/eve/callback", persist, PKCE_VERIFIER);
  assert.equal(forms[0].get("code_verifier"), PKCE_VERIFIER);
  assert.equal(forms[0].get("code"), "one-use-code");
  assert.equal(forms[0].get("redirect_uri"), "http://localhost:4173/auth/eve/callback");
  assert.equal(grant.authentication, "pkce");
  await sso.refresh({ clientId: "test-client" }, grant, persist);
  assert.equal(forms[1].get("grant_type"), "refresh_token");
  assert.equal(forms[1].get("refresh_token"), "pkce-grant");
  assert.equal(forms[1].has("code_verifier"), false);
  assert.equal(grant.refreshToken, "rotated-pkce-grant");
  assert.equal(grant.authentication, "pkce");
  const rejected = mockSso((url) => url.endsWith("/token") ? new Response(null, { status: 401 }) : null);
  await assert.rejects(rejected.authorize(config, "fresh-code", "http://localhost:4173/auth/eve/callback", async () => {}, PKCE_VERIFIER), (error) => {
    assert.match(error.message, /local PKCE authorization code exchange failed/);
    assert.equal(error.authentication, "pkce");
    assert.doesNotMatch(error.message, /Secret Key|never-transmit-this|fresh-code/);
    return true;
  });
});

test("an invalid PKCE verifier is rejected before its code is sent", async () => {
  let tokenCalls = 0;
  const sso = mockSso((url) => { if (url.endsWith("/token")) tokenCalls++; });
  await assert.rejects(sso.authorize({ clientId: "test-client" }, "one-use-code", "http://localhost:4173/auth/eve/callback", async () => {}, "too-short"), /PKCE verifier/);
  await assert.rejects(sso.authorizationUrl({ clientId: "test-client" }, "http://localhost:4173/auth/eve/callback", "state", "too-short"), /PKCE verifier/);
  assert.equal(tokenCalls, 0);
});

test("unsupported advertised client authentication fails before sending the authorization code", async () => {
  let tokenCalls = 0;
  const sso = mockSso((url) => {
    if (url.includes(".well-known")) return jsonResponse({ issuer: "https://login.eveonline.com/", authorization_endpoint: "https://login.eveonline.com/v2/oauth/authorize",
      token_endpoint: "https://login.eveonline.com/v2/oauth/token", jwks_uri: "https://login.eveonline.com/oauth/jwks", token_endpoint_auth_methods_supported: ["client_secret_jwt"] });
    if (url.endsWith("/token")) tokenCalls++;
    return null;
  });
  await assert.rejects(sso.authorize({ clientId: "test-client", clientSecret: "private" }, "one-use-code", "http://localhost:4173/auth/eve/callback", async () => {}), /supported client-password authentication method/);
  assert.equal(tokenCalls, 0);
});

test("SSO recognizes safe OAuth error codes and never exposes response descriptions or unexpected errors", async () => {
  for (const [code, expected] of [["invalid_client", /application credentials/], ["invalid_grant", /authorization code expired/], ["invalid_request", /request parameters/], ["private-secret-leak", /Try again later/]]) {
    const sso = mockSso((url) => url.endsWith("/token") ? new Response(JSON.stringify({ error: code, error_description: "private-secret private-code private-grant" }), { status: 400 }) : null);
    await assert.rejects(sso.authorize({ clientId: "test-client", clientSecret: "private-secret" }, "private-code", "http://localhost:4173/auth/eve/callback", async () => {}), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-secret|private-code|private-grant/);
      return true;
    });
  }
  const sso = mockSso((url) => url.endsWith("/token") ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : null);
  await assert.rejects(sso.refresh({ clientId: "test-client", clientSecret: "private" }, { refreshToken: "old" }, async () => {}), /saved character grant is no longer usable/);
  const keys = mockSso((url) => url.endsWith("jwks") ? new Response(null, { status: 401 }) : null);
  await assert.rejects(keys.validateAccessToken(signedToken(), "test-client"), (error) => {
    assert.match(error.message, /signing-key download failed \(401/);
    assert.doesNotMatch(error.message, /application credentials/);
    return true;
  });
});

test("live sample represents both private hubs even when one book has all the lowest IDs", () => {
  const book = (ids) => ({ orders: ids.map((type_id) => order({ type_id })) });
  const cjTypes = Array.from({ length: 60 }, (_, index) => index + 1);
  const tortugaTypes = Array.from({ length: 60 }, (_, index) => index + 1000);
  const selected = selectSampleTypes([book([9999]), book(tortugaTypes), book(cjTypes)], 50);
  assert.equal(selected.length, 50);
  assert.equal(selected.filter((id) => id >= 1000).length, 25);
  assert.equal(selected.filter((id) => id < 1000).length, 25);
  assert.deepEqual(selectSampleTypes([book([99]), book([8, 8, 9]), book([8, 10, 11])], 4), [8, 9, 10, 11]);
  assert.deepEqual(selectSampleTypes([book([99]), book([]), book([8, 9])], 50), [8, 9]);
  assert.deepEqual(selectSampleTypes([book([9, 7, 7]), book([]), book([])], 50), [7, 9]);
  assert.deepEqual(selectSampleTypes([book([]), book([]), book([])], 50), []);
});

test("full coverage includes the union of all three books, including Jita-only types", () => {
  const book = (ids) => ({ orders: ids.map((type_id) => order({ type_id })) });
  assert.deepEqual(selectSampleTypes([book([1, 2, 2]), book([2, 3]), book([3, 4])], 0), [1, 2, 3, 4]);
  assert.deepEqual(selectSampleTypes([book([1, 2]), book([]), book([])], 0), [1, 2]);
  const full = createFixture(1, NOW); full.scope.typeLimit = 0;
  assert.equal(validateSnapshot(full).scope.typeLimit, 0);
});

test("live pipeline resolves both structure systems and produces a bounded three-hub snapshot", async (t) => {
  const directory = await temporary(t);
  await writeJson(join(directory, "private", "grant.json"), { refreshToken: "old-grant", authentication: "pkce" });
  const config = { clientId: "test-client", clientSecret: "secret-not-public", tortugaId: "1000000000001", tortugaEnabled: true, cjId: "1000000000002", contact: "test@example.com", typeLimit: 50, historyLimit: 1 };
  const history = Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.UTC(2026, 10, 5 - i)).toISOString().slice(0, 10), volume: 10 }));
  const catalog = { schemaVersion: 1, types: Object.fromEntries([34, 35].map((id) => [String(id),
    { name: id === 34 ? "Tritanium" : "Pyerite", groupId: 18, marketGroupId: 1857, published: true, volumeM3: 0.01, packagedVolumeM3: 0.01 }])) };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/universe/structures")) { assert.match(options.headers.Authorization, /^Bearer /); return jsonResponse({ solar_system_id: path.endsWith("1") ? 1 : 2 }); }
    if (path.startsWith("/universe/systems")) return jsonResponse({ name: path.endsWith("1") ? "Siseide" : "C-J6MT", constellation_id: path.endsWith("1") ? 10 : 20 });
    if (path.startsWith("/universe/constellations")) return jsonResponse({ region_id: path.endsWith("10") ? 10000030 : 10000003 });
    if (path.startsWith("/universe/types")) throw new Error("Collection must resolve item types from the local catalog.");
    if (path.endsWith("/history")) throw new Error("Quote collection must use retained summaries, not fetch history.");
    const location = path.includes("structures") ? Number(path.split("/").at(-1)) : 60003760;
    const orders = [order({ location_id: location, price: location === 60003760 ? 100 : 150 })];
    if (location === 60003760) orders.push(order({ order_id: 2, type_id: 35 }));
    return jsonResponse(orders);
  };
  const result = await collectLive(config, directory, mockSso(), { fetchImpl, now: () => NOW, catalog });
  assert.equal(result.mode, "live"); assert.equal(result.hubs.length, 3);
  assert.equal(result.hubs[1].rows[0].regionalWeekVolume, null); // No retained history yet; quote collection makes no history calls.
  assert.equal(result.hubs[0].rows[0].sell, 100);
  assert.equal(JSON.stringify(result).includes(config.clientSecret), false);
  assert.equal((await readJson(join(directory, "private", "grant.json"))).refreshToken, "replacement-grant");
  const withoutSecret = await collectLive({ ...config, clientSecret: "" }, directory, mockSso(), { fetchImpl, now: () => NOW, catalog });
  assert.equal(withoutSecret.hubs.length, 3);
  const progress = [];
  const full = await collectLive({ ...config, typeLimit: 0 }, directory, mockSso(), { fetchImpl, now: () => NOW, catalog, onProgress: (value) => progress.push(value) });
  assert.equal(full.hubs[0].rows.length, 2);
  assert.equal(full.hubs[0].rows[1].sell, 100);
  assert.equal(full.hubs[1].rows[1].sell, null);
  for (const id of ["jita", "tortuga", "cj6mt"]) assert.ok(progress.some((value) => value.phase === "orders" && value.hubs.some((hub) => hub.id === id && hub.completed === 1 && hub.total === 1)));
  assert.ok(progress.some((value) => value.phase === "metadata" && value.completed === 2 && value.total === 2 && value.hubsCompleted === 3));
  assert.equal(progress.some((value) => value.phase === "history"), false);
  assert.equal(progress.at(-1).phase, "publishing");
});

test("local login starts using only a client ID and a server-held PKCE verifier", async (t) => {
  const directory = await temporary(t); await initialize(directory);
  const server = createPrototypeServer({ directory, sso: mockSso() });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${origin}/local/status`)).json();
  const post = (path, body) => fetch(`${origin}/local/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Local-CSRF": status.csrf }, body: JSON.stringify(body) });
  assert.equal((await post("config", { clientId: "test-client", typeLimit: 0, historyLimit: 10 })).status, 200);
  assert.equal((await (await fetch(`${origin}/local/status`)).json()).config.typeLimit, 0);
  const response = await post("connect", {});
  assert.equal(response.status, 200);
  const authorization = new URL((await response.json()).url);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorization.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorization.searchParams.has("code_verifier"), false);
  const visibleStatus = await (await fetch(`${origin}/local/status`)).text();
  assert.equal(visibleStatus.includes("codeVerifier"), false);
});

test("local HTTP flow protects credentials, binds OAuth state, rejects replay and exports a static site", async (t) => {
  const directory = await temporary(t); await initialize(directory);
  let tokenCalls = 0, expectedRedirect;
  const sso = mockSso((url, options) => {
    if (!url.endsWith("/token")) return null;
    tokenCalls++;
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("redirect_uri"), expectedRedirect);
    assert.match(form.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(form.has("client_secret"), false);
    return null;
  });
  const server = createPrototypeServer({ directory, sso });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${origin}/local/status`)).json();
  const post = (path, body, extra = {}) => fetch(`${origin}/local/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Local-CSRF": status.csrf, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post("config", {}, { Origin: "https://attacker.test" })).status, 403);
  assert.equal((await post("config", {}, { "X-Local-CSRF": "incorrect" })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${origin}/local/status`, { headers: { Host: "attacker.test" } }, (response) => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  const config = { clientId: "test-client", clientSecret: "secret-not-public", tortugaId: "1000000000001", cjId: "1000000000002", contact: "test@example.com", typeLimit: 50, historyLimit: 10 };
  assert.equal((await post("config", config)).status, 200);
  assert.equal((await post("config", { ...config, clientSecret: "  secret-not-public  " })).status, 200);
  assert.equal((await readJson(join(directory, "private", "config.json"))).clientSecret, "secret-not-public");
  assert.equal((await post("config", { ...config, clientSecret: "  " })).status, 200);
  assert.equal((await readJson(join(directory, "private", "config.json"))).clientSecret, "secret-not-public");
  assert.equal((await (await fetch(`${origin}/local/status`)).text()).includes(config.clientSecret), false);
  for (const path of ["/private/config.json", "/.market-poc/private/grant.json", "/../../package.json"]) assert.equal((await fetch(`${origin}${path}`)).status, 404);
  const connect = await post("connect", {}), cookie = connect.headers.get("set-cookie").split(";")[0];
  const authorization = new URL((await connect.json()).url), state = authorization.searchParams.get("state");
  expectedRedirect = authorization.searchParams.get("redirect_uri");
  const callbackPath = `/auth/eve/callback?code=one-use&state=${state}`;
  const invalid = await fetch(`${origin}${callbackPath}`, { redirect: "manual" });
  assert.match(invalid.headers.get("location"), /auth=failed/);
  const valid = await fetch(`${origin}${callbackPath}`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(valid.headers.get("location"), "/?connected=1");
  const replay = await fetch(`${origin}${callbackPath}`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.match(replay.headers.get("location"), /auth=failed/);
  assert.equal(tokenCalls, 1);
  assert.ok((await (await fetch(`${origin}/local/status`)).json()).lastError);
  assert.equal((await post("config", { ...config, clientSecret: "" })).status, 200);
  assert.equal((await (await fetch(`${origin}/local/status`)).json()).lastError, null);
  assert.equal((await readJson(join(directory, "private", "grant.json"))).refreshToken, "replacement-grant");
  await exportSite(directory);
  assert.deepEqual((await readdir(join(directory, "site"))).sort(), ["app.mjs", "data", "index.html", "snapshot.mjs", "styles.css"]);
  for (const file of ["index.html", "app.mjs", "snapshot.mjs", "styles.css", "data/market.json"]) {
    const contents = await readFile(join(directory, "site", file), "utf8");
    assert.equal(contents.includes(config.clientSecret), false);
    assert.equal(contents.includes("replacement-grant"), false);
  }
  const staticServer = createPrototypeServer({ directory, local: false });
  staticServer.listen(0, "127.0.0.1"); await once(staticServer, "listening");
  t.after(() => { staticServer.closeAllConnections(); staticServer.close(); });
  const staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;
  assert.equal((await fetch(`${staticOrigin}/`)).status, 200);
  assert.equal((await fetch(`${staticOrigin}/local/status`)).status, 404);
  assert.equal(validateSnapshot(await (await fetch(`${staticOrigin}/data/market.json`)).json()).hubs[0].rows.length, 20_000);
});

test("local collection reports in-flight progress without publishing early or starting duplicate jobs", async (t) => {
  const directory = await temporary(t); await initialize(directory);
  const snapshotPath = join(directory, "public", "data", "market.json"), previous = await readFile(snapshotPath, "utf8");
  let release, update, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const server = createPrototypeServer({ directory, collector: async (_config, _directory, _sso, { onProgress }) => {
    calls++; update = onProgress;
    onProgress({ phase: "orders", message: "Reading Tortuga", hubIndex: 2, hubName: "Tortuga", hubsCompleted: 1, completed: 2, total: 8, unit: "pages" });
    await gate;
    return createFixture(2, NOW);
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const status = () => fetch(`${origin}/local/status`).then((response) => response.json());
  const { csrf } = await status();
  const collect = () => fetch(`${origin}/local/collect`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Local-CSRF": csrf }, body: "{}" });
  assert.equal((await collect()).status, 202);
  let current;
  for (let i = 0; i < 100; i++) {
    current = await status();
    if (current.progress.phase === "orders") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(current.busy, true);
  assert.equal(current.progress.hubIndex, 2);
  assert.equal(current.progress.completed, 2);
  assert.equal(current.progress.total, 8);
  assert.equal(await readFile(snapshotPath, "utf8"), previous);
  assert.equal((await collect()).status, 409);
  update({ phase: "metadata", message: "Item details", completed: 5, total: 50, hubsCompleted: 3 });
  assert.equal((await status()).progress.phase, "metadata");
  assert.equal(calls, 1);
  release();
  for (let i = 0; i < 100; i++) {
    current = await status(); if (!current.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(current.busy, false);
  assert.equal(current.progress.phase, "complete");
  assert.equal(current.lastError, null);
  assert.equal((await readJson(snapshotPath)).hubs[0].rows.length, 2);
});

test("failed live collection preserves the file and reports the failure to the local viewer", async (t) => {
  const directory = await temporary(t); await initialize(directory);
  const path = join(directory, "public", "data", "market.json"), previous = await readFile(path, "utf8");
  const server = createPrototypeServer({ directory, collector: async () => { throw new Error("incomplete market book"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${origin}/local/status`)).json();
  assert.equal((await fetch(`${origin}/local/collect`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Local-CSRF": status.csrf }, body: "{}" })).status, 202);
  let next;
  for (let i = 0; i < 100; i++) {
    next = await (await fetch(`${origin}/local/status`)).json();
    if (!next.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(next.lastError, "incomplete market book");
  assert.equal(next.progress.phase, "failed");
  assert.equal(await readFile(path, "utf8"), previous);
});
