// Browser-only feasibility client. No Node imports or application secret.
export const SCOPES = ["esi-markets.structure_markets.v1", "esi-universe.read_structures.v1"];
const ORIGIN = "https://login.eveonline.com";
const DISCOVERY = `${ORIGIN}/.well-known/oauth-authorization-server`;
const SESSION_KEY = "market-github-only-pkce-v1";
const MAX_AGE = 10 * 60_000;
const OAUTH_ERRORS = new Set(["invalid_request", "invalid_grant", "invalid_client", "access_denied", "invalid_scope", "server_error", "temporarily_unavailable"]);
const encoder = new TextEncoder();
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid EVE token encoding.");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
function clientId(value) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Enter the public EVE application client ID.");
  return value;
}
function safeError(error) { return OAUTH_ERRORS.has(error) ? error : "unavailable"; }

export class BrowserEveSso {
  constructor({ fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto,
    storage = globalThis.sessionStorage, now = () => Date.now() } = {}) {
    this.fetch = fetchImpl; this.crypto = cryptoImpl; this.storage = storage; this.now = now;
  }
  async request(url, options = {}) {
    let response;
    try {
      response = await this.fetch(url, { ...options, credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", signal: AbortSignal.timeout(25_000) });
    } catch { throw new Error("Browser could not read the EVE response. Check connectivity and browser CORS errors."); }
    let body;
    try { body = await response.json(); } catch { throw new Error("EVE returned an unreadable response."); }
    if (!response.ok) throw new Error(`EVE browser request failed (${response.status}, ${safeError(body?.error)}). Start Connect EVE again if needed.`);
    return body;
  }
  async metadata() {
    const metadata = await this.request(DISCOVERY);
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      if (new URL(metadata[key]).origin !== ORIGIN) throw new Error("Unexpected EVE SSO endpoint.");
    }
    if (!metadata.code_challenge_methods_supported?.includes("S256")) throw new Error("EVE did not advertise PKCE/S256.");
    return metadata;
  }
  async begin(id, redirectUri) {
    clientId(id);
    const callback = new URL(redirectUri);
    if (callback.username || callback.password || callback.search || callback.hash ||
      !(callback.protocol === "https:" || (callback.protocol === "http:" && ["localhost", "127.0.0.1"].includes(callback.hostname)))) {
      throw new Error("Use an HTTPS callback, or a loopback HTTP callback for local testing.");
    }
    const metadata = await this.metadata();
    const verifier = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    const state = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(await this.crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
    this.storage.setItem(SESSION_KEY, JSON.stringify({ clientId: id, redirectUri, verifier, state, createdAt: this.now() }));
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: redirectUri,
      scope: SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return url.href;
  }
  async complete(callbackUrl) {
    let saved;
    try { saved = JSON.parse(this.storage.getItem(SESSION_KEY)); }
    catch { /* Unusable/absent transaction is rejected below. */ }
    // Consume before exchanging: reloading the callback cannot reuse its code.
    this.storage.removeItem(SESSION_KEY);
    const url = new URL(callbackUrl);
    if (!saved || typeof saved.state !== "string" || typeof saved.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier) || !Number.isFinite(saved.createdAt) ||
      this.now() - saved.createdAt < 0 || this.now() - saved.createdAt > MAX_AGE ||
      url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== saved.state ||
      `${url.origin}${url.pathname}` !== saved.redirectUri || url.hash) {
      throw new Error("Missing, expired or mismatched EVE sign-in state. Start Connect EVE again in this tab.");
    }
    clientId(saved.clientId);
    if (url.searchParams.has("error")) throw new Error(`EVE authorization failed (${safeError(url.searchParams.get("error"))}).`);
    const code = url.searchParams.get("code");
    if (url.searchParams.getAll("code").length !== 1 || !code || code.length > 2048) throw new Error("EVE callback did not contain one authorization code.");
    const metadata = await this.metadata();
    const result = await this.request(metadata.token_endpoint, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: saved.clientId,
        code, redirect_uri: saved.redirectUri, code_verifier: saved.verifier }).toString() });
    if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string" || !result.refresh_token) {
      throw new Error("EVE did not return the required tokens.");
    }
    const character = await this.validate(result.access_token, saved.clientId, metadata);
    return { authentication: "pkce", refreshToken: result.refresh_token, character };
  }
  async validate(token, id, metadata) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error();
      const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
      const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
      if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error();
      const jwks = await this.request(metadata.jwks_uri);
      const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256"));
      if (!jwk) throw new Error();
      const key = await this.crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      if (!await this.crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))) throw new Error();
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const scopes = Array.isArray(claims.scp) ? claims.scp : String(claims.scp ?? "").split(" ");
      if (![metadata.issuer, ORIGIN, `${ORIGIN}/`, "login.eveonline.com"].filter(Boolean).includes(claims.iss) ||
        !audience.includes(id) || !audience.includes("EVE Online") ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= this.now() ||
        (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > this.now() + 30_000)) ||
        !/^CHARACTER:EVE:\d+$/.test(claims.sub ?? "") || !SCOPES.every((s) => scopes.includes(s))) throw new Error();
      return { id: claims.sub.split(":")[2], name: String(claims.name ?? claims.sub), scopes };
    } catch { throw new Error("EVE token signature, character, expiry, audience or scopes could not be verified."); }
  }
}

// Deliberately invalid code: this checks browser access, not a successful login.
// A browser-readable 400/401 proves the response was not blocked by CORS.
export async function probeBrowserAccess({ fetchImpl = globalThis.fetch, id = "github-only-cors-probe" } = {}) {
  clientId(id);
  const probes = [
    ["EVE discovery", DISCOVERY, {}],
    ["EVE signing keys", `${ORIGIN}/oauth/jwks`, {}],
    ["EVE token exchange (invalid-code probe)", `${ORIGIN}/v2/oauth/token`, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: id,
        code: "deliberately-invalid-github-only-cors-probe", code_verifier: "a".repeat(43),
        redirect_uri: "http://localhost:4173/auth/eve/callback" }).toString() }],
    ["GitHub REST + authorization-header preflight", "https://api.github.com/rate_limit", {
      headers: { Authorization: "Bearer deliberately-invalid-cors-probe", Accept: "application/vnd.github+json" } }],
  ];
  return Promise.all(probes.map(async ([name, url, options]) => {
    const started = performance.now();
    try {
      const response = await fetchImpl(url, { ...options, credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", signal: AbortSignal.timeout(25_000) });
      // SSO can return HTML on an error. Readability, rather than JSON shape,
      // is the CORS question; never display or log the response body.
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { /* A readable HTML error still proves CORS. */ }
      return { name, readable: true, status: response.status, oauthError: OAUTH_ERRORS.has(body?.error) ? body.error : null,
        elapsedMs: Math.round(performance.now() - started) };
    } catch { return { name, readable: false, status: null, oauthError: null, elapsedMs: Math.round(performance.now() - started) }; }
  }));
}
