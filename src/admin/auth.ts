const encoder = new TextEncoder();

export type MiniAppIdentity = {
  id: number;
  username?: string;
  firstName?: string;
  rawUser: Record<string, unknown>;
  authDate: number;
};

export type AdminRole = "owner" | "admin" | "support";
export type AdminSession = { identity: MiniAppIdentity; role: AdminRole };

export async function validateMiniAppInitData(initData: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = 86_400): Promise<MiniAppIdentity> {
  if (!initData || !botToken) throw new Error("admin_init_data_missing");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("admin_init_data_invalid_hash");
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw new Error("admin_auth_date_invalid");
  if (Math.abs(nowSeconds - authDate) > maxAgeSeconds) throw new Error("admin_init_data_expired");

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== "hash" && key !== "signature") pairs.push(key + "=" + value);
  });
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const webAppKey = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secretKeyBytes = await crypto.subtle.sign("HMAC", webAppKey, encoder.encode(botToken));
  const secretKey = await crypto.subtle.importKey("raw", secretKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const expected = hexToBytes(hash);
  const valid = await crypto.subtle.verify("HMAC", secretKey, expected as unknown as BufferSource, encoder.encode(dataCheckString));
  if (!valid) throw new Error("admin_init_data_invalid");

  const userParam = params.get("user");
  if (!userParam) throw new Error("admin_user_missing");
  let rawUser: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(userParam);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid_user");
    rawUser = parsed as Record<string, unknown>;
  } catch {
    throw new Error("admin_user_invalid");
  }
  if (typeof rawUser.id !== "number" || !Number.isSafeInteger(rawUser.id)) throw new Error("admin_user_id_invalid");
  return {
    id: rawUser.id,
    ...(typeof rawUser.username === "string" ? { username: rawUser.username } : {}),
    ...(typeof rawUser.first_name === "string" ? { firstName: rawUser.first_name } : {}),
    rawUser,
    authDate,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
