import { createHash, createPublicKey, verify } from "node:crypto";

export const EVE_SCOPES = ["esi-markets.structure_markets.v1", "esi-universe.read_structures.v1"];
const DISCOVERY = "https://login.eveonline.com/.well-known/oauth-authorization-server";
const OAUTH_ERRORS = new Set(["invalid_client", "invalid_grant", "invalid_request", "invalid_scope", "unauthorized_client", "unsupported_grant_type", "access_denied", "server_error", "temporarily_unavailable"]);

// OAuth client-password authentication encodes each component BEFORE Base64.
// Plain `${id}:${secret}` is incorrect for secrets containing reserved characters.
function encodeClientComponent(value) {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function ssoFailure(stage, status, oauthError, authentication = null) {
  const tokenRequest = stage === "authorization code exchange" || stage === "refresh token exchange";
  let detail = "Try again later; EVE's SSO service may be unavailable.";
  if (tokenRequest && oauthError === "invalid_grant") {
    detail = stage === "authorization code exchange"
      ? "The authorization code expired, was already used, or does not match this application/callback. Start Connect EVE again from the local page."
      : "The saved character grant is no longer usable. Connect EVE again from the local page.";
  } else if (tokenRequest && (status === 401 || oauthError === "invalid_client")) {
    detail = authentication === "pkce"
      ? "EVE rejected this application client ID or local PKCE flow. Check the application's registration and exact local callback, then start Connect EVE again."
      : "EVE rejected the application credentials. Re-copy the client ID and Secret Key from the same EVE developer application into Local setup, save, then start Connect EVE again.";
  } else if (tokenRequest && oauthError === "unauthorized_client") {
    detail = "This EVE application is not allowed to use the configured authorization flow. Check its application registration and API access settings.";
  } else if (tokenRequest && (oauthError === "invalid_request" || oauthError === "invalid_scope" || oauthError === "unsupported_grant_type")) {
    detail = "EVE rejected the token request parameters. Check the registered callback and required API scopes before starting Connect EVE again.";
  }
  // Never echo upstream descriptions/bodies: they can contain codes or credentials.
  const label = authentication === "pkce" ? `local PKCE ${stage}` : stage;
  const error = new Error(`EVE SSO ${label} failed (${status}${oauthError ? `, ${oauthError}` : ""}). ${detail}`);
  error.name = "EveSsoError";
  error.stage = stage;
  error.status = status;
  error.oauthError = oauthError;
  error.authentication = authentication;
  return error;
}

export class EveSso {
  constructor({ fetchImpl = fetch, discoveryUrl = DISCOVERY, now = () => Date.now() } = {}) {
    this.fetch = fetchImpl;
    this.discoveryUrl = discoveryUrl;
    this.now = now;
  }

  async json(url, options = {}, stage = "request", authentication = null) {
    let response;
    try { response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(25_000) }); }
    catch { throw new Error(`EVE SSO ${stage} could not reach the server or timed out. Check connectivity and retry.`); }
    if (!response.ok) {
      let body;
      try { body = await response.json(); } catch { /* Some authentication failures have an empty response. */ }
      const challenge = response.headers.get("WWW-Authenticate") ?? "";
      const candidate = typeof body?.error === "string" ? body.error : /\berror="([a-z_]+)"/i.exec(challenge)?.[1];
      throw ssoFailure(stage, response.status, OAUTH_ERRORS.has(candidate) ? candidate : null, authentication);
    }
    try { return await response.json(); }
    catch { throw new Error(`EVE SSO ${stage} returned an unreadable JSON response. Retry later.`); }
  }

  async metadata() {
    if (!this.discovery || this.discoveryAt + 300_000 < this.now()) {
      this.discovery = await this.json(this.discoveryUrl, {}, "discovery");
      this.discoveryAt = this.now();
    }
    // Never send an application secret to a URL supplied by user configuration.
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      const url = new URL(this.discovery[key]);
      if (url.origin !== "https://login.eveonline.com") throw new Error("Unexpected EVE SSO endpoint.");
    }
    return this.discovery;
  }

  async authorizationUrl(config, redirectUri, state, codeVerifier = null) {
    const metadata = await this.metadata();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId,
      redirect_uri: redirectUri, scope: EVE_SCOPES.join(" "), state }).toString();
    if (codeVerifier !== null) {
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new Error("Invalid local PKCE verifier.");
      url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.href;
  }

  async validateAccessToken(token, clientId) {
    const metadata = await this.metadata();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid EVE access token.");
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    } catch { throw new Error("Invalid EVE access token."); }
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported EVE token signature.");
    if (!this.jwks || this.keysAt + 300_000 < this.now() || !this.jwks.keys.some((key) => key.kid === header.kid)) {
      this.jwks = await this.json(metadata.jwks_uri, {}, "signing-key download");
      this.keysAt = this.now();
    }
    const jwk = this.jwks.keys.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256"));
    if (!jwk || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"))) {
      throw new Error("EVE token signature verification failed.");
    }
    const issuers = new Set([metadata.issuer, "https://login.eveonline.com", "https://login.eveonline.com/", "login.eveonline.com"]);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const scopes = Array.isArray(claims.scp) ? claims.scp : String(claims.scp ?? "").split(" ");
    if (typeof claims.iss !== "string" || !issuers.has(claims.iss) || !audience.includes(clientId) || !audience.includes("EVE Online") ||
      !Number.isFinite(claims.exp) || claims.exp * 1000 <= this.now() ||
      (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > this.now() + 30_000)) ||
      !/^CHARACTER:EVE:\d+$/.test(claims.sub ?? "") || !EVE_SCOPES.every((scope) => scopes.includes(scope))) {
      throw new Error("EVE token identity, expiry, audience or required scopes could not be verified.");
    }
    return { id: claims.sub.split(":")[2], name: String(claims.name ?? claims.sub), scopes };
  }

  async exchange(config, fields, current, persist, { codeVerifier = null, publicClient = false } = {}) {
    const metadata = await this.metadata();
    const stage = fields.grant_type === "authorization_code" ? "authorization code exchange" : "refresh token exchange";
    const methods = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    const payload = new URLSearchParams(fields);
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    let authentication;
    if (codeVerifier !== null || publicClient) {
      authentication = "pkce";
      payload.set("client_id", config.clientId);
      if (codeVerifier !== null) {
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new Error("Invalid local PKCE verifier.");
        payload.set("code_verifier", codeVerifier);
      }
    // Legacy confidential grants retain their existing refresh mechanism.
    } else if (methods.includes("client_secret_post")) {
      authentication = "client_secret_post";
      payload.set("client_id", config.clientId);
      payload.set("client_secret", config.clientSecret);
    } else if (methods.includes("client_secret_basic")) {
      authentication = "client_secret_basic";
      headers.Authorization = `Basic ${Buffer.from(`${encodeClientComponent(config.clientId)}:${encodeClientComponent(config.clientSecret)}`).toString("base64")}`;
    } else {
      throw new Error("EVE SSO does not advertise a supported client-password authentication method.");
    }
    const result = await this.json(metadata.token_endpoint, { method: "POST",
      headers, body: payload.toString() }, stage, authentication);
    if (typeof result.access_token !== "string" || typeof (result.refresh_token ?? current?.refreshToken) !== "string") {
      throw new Error("EVE SSO did not return the required tokens.");
    }
    // Save a rotated grant BEFORE further I/O/validation/collection can fail.
    const grant = { refreshToken: result.refresh_token ?? current.refreshToken, character: current?.character ?? null, authentication };
    await persist(grant);
    const character = await this.validateAccessToken(result.access_token, config.clientId);
    if (current?.character && current.character.id !== character.id) throw new Error("Refreshed character identity changed. Reconnect EVE.");
    await persist({ ...grant, character });
    return { accessToken: result.access_token, character };
  }

  authorize(config, code, redirectUri, persist, codeVerifier = null) {
    return this.exchange(config, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, null, persist, { codeVerifier });
  }

  refresh(config, grant, persist) {
    if (!grant?.refreshToken) throw new Error("Connect an EVE character before collecting live data.");
    return this.exchange(config, { grant_type: "refresh_token", refresh_token: grant.refreshToken }, grant, persist, { publicClient: grant.authentication === "pkce" });
  }
}
