import { buyerGoogleConfigured, buyerGoogleRedirectUri } from "@/lib/auth";
import { hmacSign, randomToken } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!buyerGoogleConfigured()) {
    return Response.json({ error: "未設定 BUYER_GOOGLE_CLIENT_ID" }, { status: 503 });
  }

  const statePayload = `${randomToken(16)}.${Date.now() + 600_000}`;
  const stateToken = `${Buffer.from(statePayload).toString("base64url")}.${hmacSign(statePayload)}`;

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
