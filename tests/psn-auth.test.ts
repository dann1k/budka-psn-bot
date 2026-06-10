import assert from "node:assert/strict";
import { PsnInvalidGrantError, PsnService } from "../supabase/functions/telegram-webhook/psn.ts";
import { PsnAuthStore, type PersistedPsnAuthState } from "../supabase/functions/telegram-webhook/psn-auth-store.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

class FakeStore {
  state: PersistedPsnAuthState | null;
  saved: PersistedPsnAuthState[] = [];
  loadValues: (PersistedPsnAuthState | null)[] | null = null;
  private loadIndex = 0;

  constructor(initial: PersistedPsnAuthState | null) {
    this.state = initial;
  }

  load(): Promise<PersistedPsnAuthState | null> {
    if (this.loadValues) {
      const value = this.loadValues[Math.min(this.loadIndex, this.loadValues.length - 1)];
      this.loadIndex += 1;
      return Promise.resolve(value);
    }
    return Promise.resolve(this.state);
  }

  save(state: PersistedPsnAuthState): Promise<void> {
    this.saved.push(state);
    this.state = state;
    return Promise.resolve();
  }
}

function asStore(store: FakeStore): PsnAuthStore {
  return store as unknown as PsnAuthStore;
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function stubFetch(handler: () => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(handler())) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("keep-alive rotates the refresh token on a valid PSN response", async () => {
  const now = Date.now();
  const store = new FakeStore({
    accessToken: "old-access",
    refreshToken: "RT1",
    expiresAt: now + HOUR,
    refreshTokenExpiresAt: now + 5 * DAY
  });
  const restore = stubFetch(() =>
    tokenResponse({
      access_token: "new-access",
      refresh_token: "RT2",
      expires_in: 3600,
      refresh_token_expires_in: 5_184_000
    })
  );

  try {
    const service = new PsnService("npsso", asStore(store));
    const result = await service.ensureFreshAuthorization();

    assert.equal(result.status, "rotated");
    assert.equal(store.saved.length, 1);
    assert.equal(store.saved[0].accessToken, "new-access");
    assert.equal(store.saved[0].refreshToken, "RT2");
    assert.ok(store.saved[0].refreshTokenExpiresAt > Date.now() + 50 * DAY);
  } finally {
    restore();
  }
});

Deno.test("transient PSN failure retries and never overwrites the good token", async () => {
  const now = Date.now();
  const store = new FakeStore({
    accessToken: "access",
    refreshToken: "RT1",
    expiresAt: now + HOUR,
    refreshTokenExpiresAt: now + 5 * DAY
  });
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    return tokenResponse({ error: "server_error" }, 500);
  });

  try {
    const service = new PsnService("npsso", asStore(store));
    const result = await service.ensureFreshAuthorization();

    assert.equal(result.status, "transient-skip");
    assert.equal(store.saved.length, 0, "must not persist anything on transient failure");
    assert.equal(calls, 3, "should retry up to the max attempts");
  } finally {
    restore();
  }
});

Deno.test("invalid_grant adopts a token another instance just rotated (no NPSSO)", async () => {
  const now = Date.now();
  const store = new FakeStore(null);
  // First load -> the about-to-die token; reload after invalid_grant -> a fresher one
  // that another isolate rotated in.
  store.loadValues = [
    { accessToken: "a1", refreshToken: "RT1", expiresAt: now + HOUR, refreshTokenExpiresAt: now + 5 * DAY },
    { accessToken: "a2", refreshToken: "RT2", expiresAt: now + HOUR, refreshTokenExpiresAt: now + 60 * DAY }
  ];
  const restore = stubFetch(() => tokenResponse({ error: "invalid_grant" }, 400));

  try {
    const service = new PsnService("npsso", asStore(store));
    const result = await service.ensureFreshAuthorization();

    assert.equal(result.status, "already-fresh");
    assert.equal(store.saved.length, 0, "must not bootstrap from NPSSO when a fresh token already exists");
  } finally {
    restore();
  }
});

Deno.test("a 2xx response missing token fields is treated as transient, not success", async () => {
  const now = Date.now();
  const store = new FakeStore({
    accessToken: "access",
    refreshToken: "RT1",
    expiresAt: now + HOUR,
    refreshTokenExpiresAt: now + 5 * DAY
  });
  const restore = stubFetch(() => tokenResponse({ token_type: "bearer" }, 200));

  try {
    const service = new PsnService("npsso", asStore(store));
    const result = await service.ensureFreshAuthorization();

    assert.equal(result.status, "transient-skip");
    assert.equal(store.saved.length, 0);
  } finally {
    restore();
  }
});

Deno.test("the store refuses to persist corrupted auth state", async () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32))); // valid 32-byte base64 key
  const store = new PsnAuthStore("http://localhost:54321", "service-key", key);
  const now = Date.now();

  await assert.rejects(
    () =>
      store.save({ accessToken: "", refreshToken: "RT", expiresAt: now + HOUR, refreshTokenExpiresAt: now + DAY }),
    /accessToken is empty/
  );

  await assert.rejects(
    () =>
      store.save({ accessToken: "a", refreshToken: "RT", expiresAt: Number.NaN, refreshTokenExpiresAt: now + DAY }),
    /expiry is invalid/
  );
});
