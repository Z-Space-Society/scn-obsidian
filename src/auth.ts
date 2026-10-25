// Sign-in through Corliss: spec sections S1 to S6. Nothing here imports
// obsidian, so it runs under `node --test`. The plugin hands in `requestUrl`,
// SecretStorage and the clock.

export const PROTOCOL_ACTION = "scn-obsidian";
export const REDIRECT_URI = `obsidian://${PROTOCOL_ACTION}`;
export const PENDING_TTL_MS = 10 * 60 * 1000;
// Refresh when a token has less than this left.
export const REFRESH_MARGIN_MS = 60 * 1000;
// A lost refresh response is retried with the same token: Corliss accepts a
// repeat within 60 seconds of first use, and these add up to 15.
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

export interface HttpRequest {
	url: string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	// Null when the body is not JSON.
	json: unknown;
}

// Throws only when no response arrived at all.
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

// Shown to the member as it stands.
export class SignInError extends Error {}
// The refresh token is gone or Corliss refused it. Sign in again.
export class SignedOut extends Error {}
// Corliss could not be asked. Try again later.
export class Offline extends Error {}

export interface Endpoints {
	issuer: string;
	// The sync audience: what the plugin asks Corliss for and the relay expects.
	resource: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

// Saved before the browser opens, because iOS may end Obsidian while the
// browser is in front and the callback then reaches a fresh plugin instance.
export interface PendingSignIn {
	state: string;
	verifier: string;
	syncUrl: string;
	issuer: string;
	tokenEndpoint: string;
	startedAt: number;
}

export type Callback =
	| { kind: "exchange"; code: string; pending: PendingSignIn }
	| { kind: "refused"; message: string }
	// Not a sign-in this vault started, or one that has expired.
	| { kind: "foreign" };

export function clientIdFor(issuer: string): string {
	return `${issuer}/clients/scn-obsidian.json`;
}

// The sync URL in the one form it is stored in, `https://<sync host>`. A
// pasted `wss://` address is the same host.
export function normaliseSyncUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new SignInError("That is not a web address. Copy the sync URL from the Notes page.");
	}
	if (url.protocol !== "https:" && url.protocol !== "wss:") {
		throw new SignInError("The sync URL starts with https://. Copy it from the Notes page.");
	}
	return `https://${url.host}`;
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown, key: string): string | null {
	const found = field(value, key);
	return typeof found === "string" && found !== "" ? found : null;
}

function withoutTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

async function getJson(http: Http, url: string): Promise<unknown> {
	let response: HttpResponse;
	try {
		response = await http({ url });
	} catch {
		throw new SignInError(`Could not reach ${new URL(url).host}. Check the connection and the address.`);
	}
	if (response.status !== 200) {
		throw new SignInError(`${url} answered ${response.status}.`);
	}
	return response.json;
}

// S1. From the sync URL alone: the relay names its issuer and audience, and
// the issuer names its endpoints. An issuer set by hand skips the first step.
export async function discover(http: Http, syncUrl: string, issuerOverride?: string): Promise<Endpoints> {
	let issuer = issuerOverride ? withoutTrailingSlash(issuerOverride) : null;
	let resource = syncUrl;
	if (!issuer) {
		const metadata = await getJson(http, `${syncUrl}/.well-known/oauth-protected-resource`);
		const servers = field(metadata, "authorization_servers");
		issuer = Array.isArray(servers) && typeof servers[0] === "string" ? withoutTrailingSlash(servers[0]) : null;
		resource = text(metadata, "resource") ?? syncUrl;
		if (!issuer) {
			throw new SignInError("The relay did not say where to sign in. Set the issuer under Advanced.");
		}
	}
	const server = await getJson(http, `${issuer}/.well-known/oauth-authorization-server`);
	const authorizationEndpoint = text(server, "authorization_endpoint");
	const tokenEndpoint = text(server, "token_endpoint");
	if (!authorizationEndpoint || !tokenEndpoint) {
		throw new SignInError(`${issuer} does not look like Corliss: its discovery document has no endpoints.`);
	}
	return { issuer, resource, authorizationEndpoint, tokenEndpoint };
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64url(bytes);
}

export async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

// S2. The address to open in the browser, and what to save before opening it.
export async function beginSignIn(
	endpoints: Endpoints,
	syncUrl: string,
	now: number,
): Promise<{ pending: PendingSignIn; url: string }> {
	const pending: PendingSignIn = {
		state: randomString(),
		verifier: randomString(),
		syncUrl,
		issuer: endpoints.issuer,
		tokenEndpoint: endpoints.tokenEndpoint,
		startedAt: now,
	};
	const url = new URL(endpoints.authorizationEndpoint);
	const params = {
		response_type: "code",
		client_id: clientIdFor(endpoints.issuer),
		redirect_uri: REDIRECT_URI,
		scope: "offline_access",
		resource: endpoints.resource,
		code_challenge: await challengeFor(pending.verifier),
		code_challenge_method: "S256",
		state: pending.state,
	};
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return { pending, url: url.toString() };
}

// S3. With two vaults open on the desktop the callback can reach the wrong
// one, and the state check is what catches that.
export function matchCallback(
	pending: PendingSignIn | null,
	params: Record<string, string | undefined>,
	now: number,
): Callback {
	if (!pending || now - pending.startedAt > PENDING_TTL_MS || params.state !== pending.state) {
		return { kind: "foreign" };
	}
	if (params.error) {
		return { kind: "refused", message: `Corliss refused the sign-in: ${params.error_description || params.error}` };
	}
	if (!params.code) {
		return { kind: "refused", message: "Corliss sent no code back. Sign in again." };
	}
	return { kind: "exchange", code: params.code, pending };
}

function post(url: string, fields: Record<string, string>): HttpRequest {
	return {
		url,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	};
}

function tokensFrom(json: unknown, now: number): TokenSet | null {
	const accessToken = text(json, "access_token");
	const refreshToken = text(json, "refresh_token");
	const expiresIn = field(json, "expires_in");
	if (!accessToken || !refreshToken || typeof expiresIn !== "number") return null;
	return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000 };
}

// S4. Redeem the code. The refresh token is the caller's to store.
export async function exchangeCode(http: Http, pending: PendingSignIn, code: string, now: number): Promise<TokenSet> {
	let response: HttpResponse;
	try {
		response = await http(
			post(pending.tokenEndpoint, {
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				client_id: clientIdFor(pending.issuer),
				code_verifier: pending.verifier,
			}),
		);
	} catch {
		throw new SignInError("Could not reach Corliss to finish signing in. Sign in again.");
	}
	if (response.status !== 200) {
		const reason = text(response.json, "error_description") ?? text(response.json, "error") ?? `status ${response.status}`;
		throw new SignInError(`Corliss refused the sign-in: ${reason}`);
	}
	const tokens = tokensFrom(response.json, now);
	if (!tokens) throw new SignInError("Corliss answered without a refresh token. Sign in again.");
	return tokens;
}

// The member's DID, from the access token's `sub`. Read, not verified: the
// relay verifies the token, and this only labels the account.
export function subjectOf(accessToken: string): string {
	try {
		const payload = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
		const sub = field(JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))), "sub");
		if (typeof sub === "string" && sub.startsWith("did:")) return sub;
	} catch {
		// Falls through to the refusal below.
	}
	throw new SignInError("Corliss answered with a token that names no member.");
}

// Where the refresh token is kept. An empty string means none: SecretStorage
// has no delete.
export interface SecretStore {
	get(): string | null;
	set(value: string): void;
}

export interface TokenKeeperOptions {
	http: Http;
	secrets: SecretStore;
	// Null until a sign-in has said which Corliss to ask.
	client: () => { tokenEndpoint: string; issuer: string } | null;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

// S5 and S6. Holds the access token in memory and the refresh token in the
// secret store, and never runs two refreshes at once.
export class TokenKeeper {
	private access: { token: string; expiresAt: number } | null = null;
	private inflight: Promise<string> | null = null;
	// Bumped by every sign-in and sign-out, so a refresh that finishes after
	// one of them does not write back a token that belongs to the past.
	private generation = 0;
	private options: TokenKeeperOptions;

	constructor(options: TokenKeeperOptions) {
		this.options = options;
	}

	hasRefreshToken(): boolean {
		return !!this.options.secrets.get();
	}

	adopt(tokens: TokenSet) {
		this.generation++;
		this.inflight = null;
		this.options.secrets.set(tokens.refreshToken);
		this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
	}

	signOut() {
		this.generation++;
		this.inflight = null;
		this.access = null;
		this.options.secrets.set("");
	}

	// A token with at least a minute left, refreshing first if need be.
	async accessToken(): Promise<string> {
		if (this.access && this.access.expiresAt - this.options.now() > REFRESH_MARGIN_MS) {
			return this.access.token;
		}
		if (!this.inflight) {
			const run = this.refresh(this.generation);
			this.inflight = run;
			run.finally(() => {
				if (this.inflight === run) this.inflight = null;
			}).catch(() => {});
		}
		return this.inflight;
	}

	private async refresh(generation: number): Promise<string> {
		const { http, secrets, client, now, sleep } = this.options;
		const refreshToken = secrets.get();
		const corliss = client();
		if (!refreshToken || !corliss) throw new SignedOut("Not signed in.");
		const request = post(corliss.tokenEndpoint, {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientIdFor(corliss.issuer),
		});
		for (let attempt = 0; ; attempt++) {
			let response: HttpResponse | null = null;
			try {
				response = await http(request);
			} catch {
				// No answer arrived, so the grant may have been spent. The same
				// token is sent again, inside Corliss's 60-second grace.
			}
			if (generation !== this.generation) throw new SignedOut("Signed out while refreshing.");
			const tokens = response?.status === 200 ? tokensFrom(response.json, now()) : null;
			if (tokens) {
				// Stored before the access token is used: if the plugin stops
				// here, the next start still holds a token that works.
				secrets.set(tokens.refreshToken);
				this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
				return tokens.accessToken;
			}
			const error = text(response?.json, "error");
			if (error === "invalid_grant" || error === "invalid_target") {
				this.signOut();
				throw new SignedOut("Corliss ended the sign-in. Sign in again.");
			}
			if (attempt >= RETRY_DELAYS_MS.length) throw new Offline("Could not reach Corliss.");
			await sleep(RETRY_DELAYS_MS[attempt]);
		}
	}
}
