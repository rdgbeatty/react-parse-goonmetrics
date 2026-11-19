import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { GitHubApi } from "../lib/github-client.mjs";
import { nodeSealer, secretWriter } from "../lib/github-node.mjs";
import { adoptGrant, durableSso } from "../lib/hosted-auth.mjs";
import { encodeState, restoreState, downloadAsset, restoreLatest, saveStateRelease } from "../lib/release-state.mjs";
import { runHosted, checkHostedContext } from "../hosted.mjs";
import { writeJson, readJson } from "../lib/storage.mjs";
import { createFixture } from "../lib/fixture.mjs";
import { validateReleaseConfig } from "../lib/release-config.mjs";
const sodium = createRequire(import.meta.url)("libsodium-wrappers");
const config = { schemaVersion: 1, repository: "owner/repo", branch: "main", environment: "market-collector", clientId: "test-client", collectorCharacterId: "1234", cjId: "1049588174021", additionalHubs: [], contact: "https://example.com", typeLimit: 0, historyBatchSeconds: 300, legacyApi: "https://legacy.example.com" };
const grant = { authentication: "pkce", refreshToken: "fake-refresh-original", character: { id: "1234", name: "Test" } };
const replacement = { ...grant, refreshToken: "fake-refresh-replacement" };
const nonce = "a".repeat(64);
const pending = (overrides = {}) => JSON.stringify({ schemaVersion: 1, nonce, repository: config.repository, clientId: config.clientId, createdAt: new Date().toISOString(), grant, ...overrides });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function temporary(t) { const p = await mkdtemp(join(tmpdir(), "market-release-test-")); t.after(() => rm(p, { recursive: true, force: true })); return p; }
const live = () => ({ ...createFixture(2, new Date("2026-11-18T12:00:00Z")), mode: "live" });
const manualEnv = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: config.repository,
  GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "owner", GITHUB_TOKEN: "fake" };

test("Secret writer uses GitHub sealed boxes, and workflow inputs contain only operation/ref/nonce", async () => {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair(), calls = [];
  const api = new GitHubApi({ repository: config.repository, token: "fake-owner-token", seal: nodeSealer, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("public-key") ? json({ key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL), key_id: "key-id" }) : new Response(null, { status: 204 });
  } });
  await api.setSecret("EVE_PENDING_GRANT", pending());
  const sent = JSON.parse(calls[1].init.body);
  assert.equal(sent.key_id, "key-id"); assert.equal(calls[1].init.method, "PUT");
  const decrypted = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(sent.encrypted_value, sodium.base64_variants.ORIGINAL), pair.publicKey, pair.privateKey));
  assert.equal(decrypted, pending(JSON.parse(decrypted)));
  assert.doesNotMatch(calls[1].init.body, /fake-refresh|fake-owner/);
  await api.dispatch("adopt", "main", nonce);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { ref: "main", inputs: { operation: "adopt", nonce } });
  assert.equal(calls[1].init.credentials, "omit"); assert.equal(calls[1].init.redirect, "error");
});

test("GitHub errors never echo credential-bearing response bodies", async () => {
  const api = new GitHubApi({ repository: config.repository, token: "fake-owner-token", fetchImpl: async () => json({ message: "fake-owner-token fake-refresh" }, 403) });
  await assert.rejects(api.request(api.base), (e) => /403/.test(e.message) && !/fake-owner|fake-refresh/.test(e.message));
});

test("owner setup rejects another GitHub user or a non-default branch", async () => {
  for (const [login, branch] of [["visitor", "main"], ["owner", "other"]]) {
    const api = new GitHubApi({ repository: config.repository, token: "fake", fetchImpl: async (url) => url.endsWith("/user") ? json({ login }) : json({ default_branch: "main", permissions: { push: true } }) });
    await assert.rejects(api.verifyOwner(branch), /repository owner/);
  }
});

test("initial adoption validates before canonical write and never deletes a newer pending setup", async () => {
  const events = [];
  const writer = { setSecret: async (name, text) => { events.push(name); assert.equal(JSON.parse(text).refreshToken, replacement.refreshToken); }, deleteSecret: async (name) => events.push(`delete:${name}`) };
  const sso = { refresh: async (_c, _g, persist) => { events.push("exchange"); await persist(replacement); events.push("verified"); return { character: grant.character }; } };
  await adoptGrant({ config, pendingText: pending(), nonce, writer, sso });
  assert.deepEqual(events, ["exchange", "verified", "EVE_GRANT"]);
  events.length = 0;
  await assert.rejects(adoptGrant({ config, pendingText: pending(), nonce, writer, sso: { refresh: async (_c, _g, persist) => { await persist(replacement); throw new Error("signed identity invalid"); } } }), /identity invalid/);
  assert.deepEqual(events, []);
});

test("adoption rejects expired/superseded/wrong-repository/application/character grants before SSO", async () => {
  for (const changes of [{ nonce: "b".repeat(64) }, { repository: "other/repo" }, { clientId: "other" }, { schemaVersion: 99 },
    { createdAt: "2020-01-01T00:00:00Z" }, { grant: { ...grant, character: { id: "999" } } }]) {
    await assert.rejects(adoptGrant({ config, pendingText: pending(changes), nonce, writer: {}, sso: { refresh: async () => assert.fail("must not exchange") } }));
  }
});

test("refresh replacement is remotely durable before local persistence or later validation failure", async () => {
  const events = [];
  const sso = { refresh: async (_c, _g, persist) => { await persist(replacement); events.push("validate"); throw new Error("later failure"); } };
  const writer = { setSecret: async (name, text) => { events.push(name); assert.equal(JSON.parse(text).refreshToken, replacement.refreshToken); } };
  await assert.rejects(durableSso(sso, writer, "1234").refresh(config, grant, async () => events.push("local")), /later failure/);
  assert.deepEqual(events, ["EVE_GRANT", "local", "validate"]);
  events.length = 0;
  await assert.rejects(durableSso(sso, { setSecret: async () => { throw new Error("write failed"); } }, "1234").refresh(config, grant, async () => events.push("local")), /write failed/);
  assert.deepEqual(events, []);
});

test("App writer signs a valid JWT and requests only one repository/environment permission", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); let called = false;
  await secretWriter(config, { MARKET_APP_ID: "123", MARKET_APP_INSTALLATION_ID: "456", MARKET_APP_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }) }, async (_url, options) => {
    const token = options.headers.Authorization.slice(7), parts = token.split(".");
    assert.equal(verify("RSA-SHA256", Buffer.from(parts.slice(0,2).join(".")), publicKey, Buffer.from(parts[2], "base64url")), true);
    assert.deepEqual(JSON.parse(options.body), { repositories: ["repo"], permissions: { environments: "write" } });
    assert.equal(JSON.parse(Buffer.from(parts[1], "base64url")).iss, "123"); called = true;
    return json({ token: "fake-installation-token" });
  });
  assert.equal(called, true);
});

test("state round-trip preserves live data and checkpoints while excluding credentials, raw caches and metrics", async (t) => {
  const from = await temporary(t), to = await temporary(t);
  await writeJson(join(from,"public/data/market.json"), live());
  await writeJson(join(from,"history/checkpoints/000000000001.json"), { schemaVersion: 1, rows: [] });
  await writeJson(join(from,"private/grant.json"), { refreshToken: "must-never-publish" });
  await writeJson(join(from,"cache/raw.json"), { body: "must-never-publish" });
  const encoded = await encodeState(from, config.repository);
  assert.doesNotMatch(gunzipSync(encoded).toString(), /must-never-publish|private\/|cache\//);
  const result = await restoreState(encoded, to, config.repository);
  assert.equal(result.files, 2); assert.deepEqual(await readJson(join(to,"public/data/market.json")), live());
  assert.equal(await readJson(join(to,"private/grant.json")), null);
});

test("state restore validates every entry before writing and rejects tampering, paths, duplicate files and symlinks", async (t) => {
  const from = await temporary(t); await writeJson(join(from,"public/data/market.json"), live());
  const original = JSON.parse(gunzipSync(await encodeState(from, config.repository)));
  for (const mutate of [
    (a) => { a.files[0].sha256 = "bad"; }, (a) => { a.files.push({ ...a.files[0], path: "../private/grant.json" }); },
    (a) => { a.files.push(a.files[0]); }, (a) => { a.repository = "other/repo"; },
    (a) => { const text = JSON.stringify({ refreshToken: "must-not-restore" }); a.files.push({ path: "catalog/current.json", text, sha256: createHash("sha256").update(text).digest("hex") }); },
  ]) {
    const to = await temporary(t), archive = structuredClone(original); mutate(archive);
    await assert.rejects(restoreState(gzipSync(JSON.stringify(archive)), to, config.repository));
    assert.deepEqual(await readdir(to), []);
  }
  const to = await temporary(t), outside = await temporary(t); await symlink(outside, join(to,"public"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(restoreState(gzipSync(JSON.stringify(original)), to, config.repository), /symlink/);
});

test("state publication rejects fixture data", async (t) => {
  const path = await temporary(t); await writeJson(join(path,"public/data/market.json"), createFixture(1));
  await assert.rejects(encodeState(path, config.repository), /Simulated/);
});

test("release downloads never forward bearer credentials to signed CDN URLs", async () => {
  const calls = [];
  const api = new GitHubApi({ repository: config.repository, token: "fake-token", fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/example?signature=fake" } }) : new Response("content");
  } });
  assert.equal((await downloadAsset(api, { id: 1, size: 7 })).toString(), "content");
  assert.match(calls[0].options.headers.Authorization, /fake-token/); assert.equal(calls[1].options.headers, undefined);
});

test("hosted guard allows owner dispatches and approved schedules only on the configured branch", () => {
  checkHostedContext(config, manualEnv, "adopt");
  for (const changes of [{ GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "fork/repo" }, { GITHUB_REF: "refs/heads/untrusted" },
    { GITHUB_ACTOR: "visitor" }, { GITHUB_EVENT_NAME: "push" }]) {
    assert.throws(() => checkHostedContext(config, { ...manualEnv, ...changes }, "quotes"));
  }
  const scheduled = { ...manualEnv, GITHUB_EVENT_NAME: "schedule", GITHUB_ACTOR: "scheduled-actor" };
  for (const operation of ["quotes", "weekly-history", "prune"]) checkHostedContext(config, scheduled, operation);
  assert.throws(() => checkHostedContext(config, scheduled, "adopt"));
  assert.throws(() => checkHostedContext(config, { ...scheduled, GITHUB_REF: "refs/heads/untrusted" }, "weekly-history"));
  validateReleaseConfig(config); assert.throws(() => validateReleaseConfig({ ...config, clientSecret: "private" }));
});

test("hosted failed batch still checkpoints progress but does not report success", async (t) => {
  const directory = await temporary(t), calls = [];
  await assert.rejects(runHosted({ operation: "history", directory, config, env: manualEnv, dependencies: {
    restore: async () => { await writeJson(join(directory,"public/data/market.json"), live()); return {}; },
    run: async () => { calls.push("batch"); throw new Error("source failure"); },
    save: async () => { calls.push("checkpoint"); return { releaseId: 1, bytes: 10 }; },
  } }), /source failure/);
  assert.deepEqual(calls, ["batch", "checkpoint"]);
});

test("scheduled weekly history crosses batch boundaries and checkpoints the snapshot with 21-day summaries", async (t) => {
  const directory = await temporary(t);
  const snapshotPath = join(directory, "public/data/market.json");
  const snapshot = live();
  snapshot.hubs = snapshot.hubs.slice(0, 2);
  snapshot.hubs.forEach((hub, index) => { hub.regionId = String(10000002 + index); });
  const now = Date.parse("2026-11-18T12:00:00Z"), dayMs = 86_400_000;
  const days = Array.from({ length: 22 }, (_, index) => ({
    date: new Date(now - dayMs * (index + 1)).toISOString().slice(0, 10),
    volume: 10, order_count: 1, average: 10, highest: 10, lowest: 10,
  }));
  const result = await runHosted({ operation: "weekly-history", directory, config,
    env: { ...manualEnv, GITHUB_EVENT_NAME: "schedule", GITHUB_ACTOR: "scheduled-actor" }, dependencies: {
      restore: async () => { await writeJson(snapshotPath, snapshot); return {}; },
      historyOptions: { maxPairs: 2, now: () => now, request: async () => ({
        body: days, expiresAt: now + dayMs, sourceUpdatedAt: new Date(now).toISOString(),
      }) },
      save: async () => {
        const saved = await readJson(snapshotPath);
        assert.equal(saved.generatedAt, snapshot.generatedAt);
        for (const row of saved.hubs.flatMap((hub) => hub.rows)) {
          assert.equal(row.history.retainedDays, 21);
          assert.equal(row.regionalWeekVolume, 70);
        }
        return { releaseId: 1, bytes: 10 };
      },
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.historySession.batchesCompleted, 2);
  assert.equal(result.historySession.refreshedPairs, 4);
});

test("Secret creation accepts GitHub's successful empty 201 response", async () => {
  const api = new GitHubApi({ repository: config.repository, token: "fake", seal: async () => "encrypted", fetchImpl: async (url) => url.endsWith("public-key") ? json({ key: "public", key_id: "id" }) : new Response(null, { status: 201 }) });
  await api.setSecret("EVE_GRANT", "test-only");
});

test("release asset upload verifies bytes, restores newest generation and rejects a corrupted newest asset", async (t) => {
  const from = await temporary(t), to = await temporary(t); await writeJson(join(from,"public/data/market.json"), live());
  let bytes, asset;
  const release = { id: 42, upload_url: "https://uploads.github.com/repos/owner/repo/releases/42/assets{?name,label}" };
  const api = new GitHubApi({ repository: config.repository, token: "fake", fetchImpl: async (url, options) => {
    url = String(url);
    if (url.startsWith("https://uploads.github.com")) {
      bytes = Buffer.from(options.body); asset = { id: 99, name: new URL(url).searchParams.get("name"), state: "uploaded", size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }; return json(asset,201);
    }
    if (url.includes("/releases/assets/99")) return new Response(bytes);
    if (url.includes("/releases/42/assets?")) return json([asset]);
    if (url.endsWith("/releases/tags/market-state")) return json(release);
    throw new Error("unexpected fake API request");
  } });
  await saveStateRelease(api,from,{branch:"main",generation:"1234567890123-aaaaaaaa"});
  await restoreLatest(api,to); assert.deepEqual(await readJson(join(to,"public/data/market.json")),live());
  bytes = Buffer.from("corrupt");
  await assert.rejects(restoreLatest(api,await temporary(t)),/digest mismatch/);
});

test("combined build excludes private state, handles a cold start, and preserves last build when rejecting a fixture", async (t) => {
  const { buildSite } = await import("../../../scripts/build-site.mjs");
  const state = await temporary(t), destination = join(await temporary(t),"site");
  await writeJson(join(state,"private/grant.json"),{refreshToken:"must-never-publish"});
  await buildSite({ base:"/qa-project/",directory:state,destination,config });
  const previous = await readFile(join(destination,"index.html"),"utf8");
  assert.match(previous,/\/qa-project\/assets\//);
  assert.match(await readFile(join(destination,"market/index.html"),"utf8"),/market-mode/);
  assert.match(await readFile(join(destination,"market/connect.html"),"utf8"),/\/qa-project\/market\/assets\//);
  assert.equal(await readJson(join(destination,"market/data/market.json")),null);
  assert.equal(await readJson(join(destination,"private/grant.json")),null);
  assert.deepEqual(JSON.parse(await readFile(join(destination,"market/hosted-config.json"),"utf8")),config);
  await writeJson(join(state,"public/data/market.json"),createFixture(1));
  await assert.rejects(buildSite({ base:"/qa-project/",directory:state,destination,config }),/simulated/);
  assert.equal(await readFile(join(destination,"index.html"),"utf8"),previous);
});

test("adoption retries are idempotent and refreshes retain the adopted setup identity", async () => {
  const current = { ...grant, setupNonce: nonce };
  const writer = { setSecret: async (_n, text) => assert.equal(JSON.parse(text).setupNonce, nonce) };
  const result = await adoptGrant({ config, pendingText: pending(), currentText: JSON.stringify(current), nonce, writer: {}, sso: { refresh: async () => assert.fail("retry must not consume old pending token") } });
  assert.equal(result.setupNonce, nonce);
  const sso = { refresh: async (_c, _g, persist) => { await persist(replacement); return { character: grant.character }; } };
  await durableSso(sso,writer,"1234").refresh(config,current,async (saved) => assert.equal(saved.setupNonce,nonce));
});

test("first-release seed dry-run never contacts GitHub and upload refuses existing hosted state", async (t) => {
  const { seedFirstState } = await import("../../../scripts/seed-state.mjs");
  const directory = await temporary(t); await writeJson(join(directory,"public/data/market.json"),live());
  const dry = await seedFirstState({ directory,config,dryRun:true,api:{request:async()=>assert.fail("dry run must not contact GitHub")} });
  assert.equal(dry.uploaded,false); assert.ok(dry.archiveBytes>0);
  await assert.rejects(seedFirstState({directory,config,api:{verifyOwner:async()=>{},base:"/repos/owner/repo",request:async()=>({id:1})},save:async()=>assert.fail("must not overwrite hosted state")}),/already exists/);
});

test("hosted catalog uses the real updater without reacquiring the job's operation lock", async (t) => {
  const directory = await temporary(t), events = [];
  const catalog = { schemaVersion: 1, types: { 34: { name:"Tritanium",groupId:18,marketGroupId:1857,published:true,volumeM3:0.01,packagedVolumeM3:0.01 } } };
  const digest = createHash("sha256").update(JSON.stringify(catalog)).digest("hex"), file = `types-${digest}.json`;
  const result = await runHosted({ operation:"catalog",directory,config,env:manualEnv,dependencies:{
    restore:async()=>{ await writeJson(join(directory,"catalog",file),catalog); await writeJson(join(directory,"catalog/current.json"),{schemaVersion:1,buildNumber:12345,sourceReleasedAt:"2026-11-17T00:00:00Z",importedAt:"2026-11-17T01:00:00Z",contentSha256:digest,dataFile:file,typeCount:1}); return {}; },
    catalogOptions:{fetchImpl:async()=>{events.push("version-check");return json({_key:"sde",buildNumber:12345,releaseDate:"2026-11-17T00:00:00Z"});}},
    save:async()=>{events.push("checkpoint");return {releaseId:1,bytes:100};},
  }});
  assert.equal(result.status,"complete");assert.deepEqual(events,["version-check","checkpoint"]);
});
