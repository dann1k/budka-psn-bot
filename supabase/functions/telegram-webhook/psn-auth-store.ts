import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export type PersistedPsnAuthState = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  // Epoch ms of the refresh token's own expiry. NaN means "unknown" (legacy rows or
  // PSN omitted refresh_token_expires_in) and is treated as due for rotation.
  refreshTokenExpiresAt: number;
};

type PsnAuthStateRow = {
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string | null;
};

const AUTH_STATE_ID = "default";
const ENCRYPTED_VALUE_VERSION = "v1";

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);

  if (keyBytes.length !== 32) {
    throw new Error("BUDKA_PSN_AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  return await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function assertNoError(error: { message: string } | null, action: string): void {
  if (error) {
    throw new Error(`${action}: ${error.message}`);
  }
}

function assertPersistableState(state: PersistedPsnAuthState): void {
  const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

  if (!isNonEmptyString(state.accessToken)) {
    throw new Error("Refusing to persist PSN auth state: accessToken is empty");
  }

  if (!isNonEmptyString(state.refreshToken)) {
    throw new Error("Refusing to persist PSN auth state: refreshToken is empty");
  }

  if (!Number.isFinite(state.expiresAt) || state.expiresAt <= 0) {
    throw new Error("Refusing to persist PSN auth state: access token expiry is invalid");
  }
}

export class PsnAuthStore {
  private readonly supabase: SupabaseClient;
  private readonly encryptionKeyPromise: Promise<CryptoKey>;

  constructor(supabaseUrl: string, supabaseSecretKey: string, authEncryptionKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseSecretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    this.encryptionKeyPromise = importEncryptionKey(authEncryptionKey);
  }

  async load(): Promise<PersistedPsnAuthState | null> {
    // Select "*" so a deploy that lands before the refresh_token_expires_at migration
    // still reads cleanly (the column is simply absent -> treated as unknown expiry).
    const { data, error } = await this.supabase
      .from("psn_auth_state")
      .select("*")
      .eq("id", AUTH_STATE_ID)
      .maybeSingle();

    assertNoError(error, "Не получилось получить PSN auth state");

    if (!data) {
      return null;
    }

    const row = data as PsnAuthStateRow;
    const refreshTokenExpiresAt = row.refresh_token_expires_at
      ? new Date(row.refresh_token_expires_at).getTime()
      : Number.NaN;

    return {
      accessToken: await this.decrypt(row.encrypted_access_token),
      refreshToken: await this.decrypt(row.encrypted_refresh_token),
      expiresAt: new Date(row.access_token_expires_at).getTime(),
      refreshTokenExpiresAt
    };
  }

  async save(state: PersistedPsnAuthState): Promise<void> {
    assertPersistableState(state);

    const refreshTokenExpiresAtIso =
      Number.isFinite(state.refreshTokenExpiresAt) && state.refreshTokenExpiresAt > 0
        ? new Date(state.refreshTokenExpiresAt).toISOString()
        : null;

    const { error } = await this.supabase
      .from("psn_auth_state")
      .upsert(
        {
          id: AUTH_STATE_ID,
          encrypted_access_token: await this.encrypt(state.accessToken),
          encrypted_refresh_token: await this.encrypt(state.refreshToken),
          access_token_expires_at: new Date(state.expiresAt).toISOString(),
          refresh_token_expires_at: refreshTokenExpiresAtIso,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "id"
        }
      );

    assertNoError(error, "Не получилось сохранить PSN auth state");
  }

  private async encrypt(value: string): Promise<string> {
    const key = await this.encryptionKeyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedValue = new TextEncoder().encode(value);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(encodedValue))
    );

    return `${ENCRYPTED_VALUE_VERSION}:${bytesToBase64(iv)}:${bytesToBase64(encrypted)}`;
  }

  private async decrypt(value: string): Promise<string> {
    const [version, encodedIv, encodedEncryptedValue] = value.split(":");

    if (version !== ENCRYPTED_VALUE_VERSION || !encodedIv || !encodedEncryptedValue) {
      throw new Error("Unsupported encrypted PSN auth state format");
    }

    const key = await this.encryptionKeyPromise;
    const iv = base64ToBytes(encodedIv);
    const encryptedValue = base64ToBytes(encodedEncryptedValue);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(encryptedValue)
    );

    return new TextDecoder().decode(decrypted);
  }
}
