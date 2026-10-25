import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	Offline,
	PENDING_TTL_MS,
	REDIRECT_URI,
	SignInError,
	SignedOut,
	TokenKeeper,
	beginSignIn,
	challengeFor,
	discover,
	exchangeCode,
	matchCallback,
	normaliseSyncUrl,
	subjectOf,
	type Http,
	type HttpRequest,
	type HttpResponse,
	type PendingSignIn,
} from "../src/auth.ts";

const ISSUER = "https://scn.example";
const SYNC = "https://sync.scn.example";
const TOKEN_ENDPOINT = `${ISSUER}/oidc/token`;

function jwt(payload: object): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256", typ: "at+jwt" })}.${part(payload)}.signature`;
}

// An Http that answers from a script and records what it was asked.
function scripted(...answers: Array<HttpResponse | "drop">) {
	const asked: HttpRequest[] = [];
	const http: Http = async (request) => {
		asked.push(request);
		const answer = answers.shift();
		if (!answer) throw new Error(`unexpected request to ${request.url}`);
		if (answer === "drop") throw new Error("connection dropped");
		return answer;
	};
	return { http, asked };
}

function form(request: HttpRequest): URLSearchParams {
	return new URLSearchParams(request.body);
}

function tokens(refresh: string, access = "access-1") {
	return { status: 200, json: { access_token: access, refresh_token: refresh, expires_in: 900, token_type: "Bearer" } };
}

function pendingAt(startedAt: number): PendingSignIn {
	return { state: "s", verifier: "v", syncUrl: SYNC, issuer: ISSUER, tokenEndpoint: TOKEN_ENDPOINT, startedAt };
}

describe("the sync URL", () => {
	it("is stored as https with no path", () => {
		assert.equal(normaliseSyncUrl(" https://sync.scn.example/ "), SYNC);
		assert.equal(normaliseSyncUrl("wss://sync.scn.example/"), SYNC);
		assert.equal(normaliseSyncUrl("https://sync.scn.example:8443"), "https://sync.scn.example:8443");
	});

	it("refuses anything that is not https or wss", () => {
		assert.throws(() => normaliseSyncUrl("sync.scn.example"), SignInError);
		assert.throws(() => normaliseSyncUrl("http://sync.scn.example"), SignInError);
	});
});

describe("discovery", () => {
	it("finds the issuer from the relay and the endpoints from the issuer", async () => {
		const { http, asked } = scripted(
			{ status: 200, json: { resource: SYNC, authorization_servers: [ISSUER] } },
			{ status: 200, json: { authorization_endpoint: `${ISSUER}/oidc/authorize`, token_endpoint: TOKEN_ENDPOINT } },
		);
		const endpoints = await discover(http, SYNC);
		assert.deepEqual(endpoints, {
			issuer: ISSUER,
			resource: SYNC,
			authorizationEndpoint: `${ISSUER}/oidc/authorize`,
			tokenEndpoint: TOKEN_ENDPOINT,
		});
		assert.deepEqual(
			asked.map((r) => r.url),
			[`${SYNC}/.well-known/oauth-protected-resource`, `${ISSUER}/.well-known/oauth-authorization-server`],
		);
	});

	it("skips the relay when the issuer is set by hand", async () => {
		const { http, asked } = scripted({
			status: 200,
			json: { authorization_endpoint: `${ISSUER}/oidc/authorize`, token_endpoint: TOKEN_ENDPOINT },
		});
		const endpoints = await discover(http, SYNC, `${ISSUER}/`);
		assert.equal(endpoints.issuer, ISSUER);
		assert.equal(endpoints.resource, SYNC);
		assert.equal(asked.length, 1);
	});

	it("says so when the relay names no issuer", async () => {
		const { http } = scripted({ status: 404, json: null });
		await assert.rejects(discover(http, SYNC), SignInError);
	});
});

describe("PKCE", () => {
	it("matches RFC 7636 appendix B", async () => {
		assert.equal(
			await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});

	it("puts the challenge, never the verifier, in the address", async () => {
		const { pending, url } = await beginSignIn(
			{ issuer: ISSUER, resource: SYNC, authorizationEndpoint: `${ISSUER}/oidc/authorize`, tokenEndpoint: TOKEN_ENDPOINT },
			SYNC,
			1000,
		);
		const params = new URL(url).searchParams;
		assert.equal(params.get("client_id"), `${ISSUER}/clients/scn-obsidian.json`);
		assert.equal(params.get("redirect_uri"), REDIRECT_URI);
		assert.equal(params.get("resource"), SYNC);
		assert.equal(params.get("state"), pending.state);
		assert.equal(params.get("code_challenge"), await challengeFor(pending.verifier));
		assert.equal(params.get("code_challenge_method"), "S256");
		assert.ok(!url.includes(pending.verifier));
		assert.equal(pending.startedAt, 1000);
		assert.notEqual(pending.state, pending.verifier);
	});
});

describe("the callback", () => {
	it("exchanges a code whose state matches", () => {
		const result = matchCallback(pendingAt(0), { state: "s", code: "c" }, 1000);
		assert.equal(result.kind, "exchange");
	});

	it("ignores a sign-in this vault did not start", () => {
		assert.equal(matchCallback(null, { state: "s", code: "c" }, 0).kind, "foreign");
		assert.equal(matchCallback(pendingAt(0), { state: "other", code: "c" }, 0).kind, "foreign");
	});

	it("ignores a sign-in older than ten minutes", () => {
		assert.equal(matchCallback(pendingAt(0), { state: "s", code: "c" }, PENDING_TTL_MS + 1).kind, "foreign");
	});

	it("passes on Corliss's refusal", () => {
		const result = matchCallback(pendingAt(0), { state: "s", error: "access_denied" }, 0);
		assert.deepEqual(result, { kind: "refused", message: "Corliss refused the sign-in: access_denied" });
	});
});

describe("the code exchange", () => {
	it("sends the verifier and returns both tokens", async () => {
		const { http, asked } = scripted(tokens("refresh-1"));
		const result = await exchangeCode(http, pendingAt(0), "c", 5000);
		assert.deepEqual(result, { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 5000 + 900_000 });
		const sent = form(asked[0]);
		assert.equal(sent.get("grant_type"), "authorization_code");
		assert.equal(sent.get("code_verifier"), "v");
		assert.equal(sent.get("redirect_uri"), REDIRECT_URI);
	});

	it("shows Corliss's reason for a refusal", async () => {
		const { http } = scripted({ status: 400, json: { error: "invalid_grant", error_description: "code expired" } });
		await assert.rejects(exchangeCode(http, pendingAt(0), "c", 0), /code expired/);
	});
});

describe("the member", () => {
	it("is the access token's subject", () => {
		assert.equal(subjectOf(jwt({ sub: "did:plc:abc", aud: SYNC })), "did:plc:abc");
	});

	it("must be a DID", () => {
		assert.throws(() => subjectOf(jwt({ sub: "alice" })), SignInError);
		assert.throws(() => subjectOf("not a token"), SignInError);
	});
});

function keeperWith(http: Http, stored: string | null, clock = { now: 0 }) {
	const secrets = { value: stored as string | null, writes: [] as string[] };
	const slept: number[] = [];
	const keeper = new TokenKeeper({
		http,
		secrets: {
			get: () => secrets.value || null,
			set: (v) => {
				secrets.value = v;
				secrets.writes.push(v);
			},
		},
		client: () => ({ tokenEndpoint: TOKEN_ENDPOINT, issuer: ISSUER }),
		now: () => clock.now,
		sleep: async (ms) => {
			slept.push(ms);
		},
	});
	return { keeper, secrets, slept, clock };
}

describe("refresh", () => {
	it("uses a token with time left without asking", async () => {
		const { http, asked } = scripted();
		const { keeper } = keeperWith(http, null);
		keeper.adopt({ accessToken: "a", refreshToken: "r", expiresAt: 900_000 });
		assert.equal(await keeper.accessToken(), "a");
		assert.equal(asked.length, 0);
	});

	it("refreshes inside the last minute and stores the new refresh token", async () => {
		const { http, asked } = scripted(tokens("refresh-2", "access-2"));
		const { keeper, secrets, clock } = keeperWith(http, null);
		keeper.adopt({ accessToken: "a", refreshToken: "refresh-1", expiresAt: 900_000 });
		clock.now = 900_000 - 59_000;
		assert.equal(await keeper.accessToken(), "access-2");
		assert.equal(form(asked[0]).get("refresh_token"), "refresh-1");
		assert.equal(form(asked[0]).get("client_id"), `${ISSUER}/clients/scn-obsidian.json`);
		assert.equal(secrets.value, "refresh-2");
	});

	it("runs one refresh for callers that arrive together", async () => {
		const { http, asked } = scripted(tokens("refresh-2", "access-2"));
		const { keeper } = keeperWith(http, "refresh-1");
		const both = await Promise.all([keeper.accessToken(), keeper.accessToken()]);
		assert.deepEqual(both, ["access-2", "access-2"]);
		assert.equal(asked.length, 1);
	});

	it("retries a lost response with the same refresh token", async () => {
		const { http, asked } = scripted("drop", { status: 502, json: null }, tokens("refresh-2", "access-2"));
		const { keeper, slept } = keeperWith(http, "refresh-1");
		assert.equal(await keeper.accessToken(), "access-2");
		assert.deepEqual(
			asked.map((r) => form(r).get("refresh_token")),
			["refresh-1", "refresh-1", "refresh-1"],
		);
		assert.deepEqual(slept, [1000, 2000]);
	});

	it("gives up as offline after the last retry, keeping the token", async () => {
		const { http } = scripted("drop", "drop", "drop", "drop", "drop");
		const { keeper, secrets, slept } = keeperWith(http, "refresh-1");
		await assert.rejects(keeper.accessToken(), Offline);
		assert.deepEqual(slept, [1000, 2000, 4000, 8000]);
		assert.equal(secrets.value, "refresh-1");
	});

	it("signs out on invalid_grant, which is what a removed member sees", async () => {
		const { http } = scripted({ status: 400, json: { error: "invalid_grant", error_description: "no longer a member" } });
		const { keeper, secrets } = keeperWith(http, "refresh-1");
		await assert.rejects(keeper.accessToken(), SignedOut);
		assert.equal(secrets.value, "");
		assert.equal(keeper.hasRefreshToken(), false);
	});

	it("does not bring a token back after a sign-out mid-refresh", async () => {
		let answer!: (response: HttpResponse) => void;
		const http: Http = () => new Promise((resolve) => (answer = resolve));
		const { keeper, secrets } = keeperWith(http, "refresh-1");
		const waiting = keeper.accessToken();
		keeper.signOut();
		answer(tokens("refresh-2", "access-2"));
		await assert.rejects(waiting, SignedOut);
		assert.equal(secrets.value, "");
	});

	it("is signed out with no stored token", async () => {
		const { http } = scripted();
		const { keeper } = keeperWith(http, null);
		await assert.rejects(keeper.accessToken(), SignedOut);
	});
});
