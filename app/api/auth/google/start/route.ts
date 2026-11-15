import { buyerGoogleConfigured, buyerGoogleRedirectUri } from "@/lib/auth";
import { hmacSign, randomToken } from "@/lib/crypto";

export const dynamic = "force-dynamic";

function sanitizeNextPath(raw: string | null, role: "buyer" | "supplier"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return role === "supplier" ? "/sources" : "/";
  }
  return raw;
}

export async function GET(req: Request) {
  if (!buyerGoogleConfigured()) {
    return Response.json({ error: "未設定 BUYER_GOOGLE_CLIENT_ID" }, { status: 503 });
  }

  const url = new URL(req.url);
  const role = url.searchParams.get("role") === "supplier" ? "supplier" : "buyer";
  const nextPath = sanitizeNextPath(url.searchParams.get("next"), role);

  const stateObj = JSON.stringify({
    n: randomToken(16),
    exp: Date.now() + 600_000,
    role,
    next: nextPath,
  });
  const stateToken = `${Buffer.from(stateObj).toString("base64url")}.${hmacSign(stateObj)}`;

  const params = new URLSearchParams({
    client_id: process.env.BUYER_GOOGLE_CLIENT_ID!,
    redirect_uri: buyerGoogleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state: stateToken,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "set-cookie": `aup_oauth_state=${stateToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}
