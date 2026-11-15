import {
  buyerGoogleConfigured,
  buyerGoogleRedirectUri,
  issueSessionToken,
  readCookie,
  sessionCookieHeader,
  upsertGoogleUser,
  type UserRole,
} from "@/lib/auth";
import { hmacVerify } from "@/lib/crypto";

export const dynamic = "force-dynamic";

interface ParsedState {
  role: UserRole;
  next: string;
}

function parseState(token: string): ParsedState | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  let payload: string;
  try {
    payload = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!hmacVerify(payload, sig)) return null;
  try {
    const parsed = JSON.parse(payload) as { exp?: number; role?: string; next?: string };
    if (!Number.isFinite(parsed.exp) || Date.now() > Number(parsed.exp)) return null;
    const role: UserRole = parsed.role === "supplier" ? "supplier" : "buyer";
    const next =
      typeof parsed.next === "string" && parsed.next.startsWith("/") && !parsed.next.startsWith("//")
        ? parsed.next
        : "/";
    return { role, next };
  } catch {
    const exp = Number(payload.split(".")[1]);
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    return { role: "buyer", next: "/" };
  }
}

export async function GET(req: Request) {
  if (!buyerGoogleConfigured()) {
    return Response.redirect(new URL("/?auth_error=google_disabled", req.url));
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readCookie(req, "aup_oauth_state");
  const parsedState = state ? parseState(state) : null;

  if (!code || !state || !cookieState || state !== cookieState || !parsedState) {
    return Response.redirect(new URL("/?auth_error=invalid_state", req.url));
  }

  const redirectUri = buyerGoogleRedirectUri(req);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.BUYER_GOOGLE_CLIENT_ID!,
      client_secret: process.env.BUYER_GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return Response.redirect(new URL("/?auth_error=token_exchange", req.url));
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) {
    return Response.redirect(new URL("/?auth_error=no_access_token", req.url));
  }

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    return Response.redirect(new URL("/?auth_error=profile", req.url));
  }
  const profile = (await profileRes.json()) as {
    email?: string;
    name?: string;
    given_name?: string;
    family_name?: string;
  };
  if (!profile.email) {
    return Response.redirect(new URL("/?auth_error=no_email", req.url));
  }

  const googleName =
    profile.name?.trim() ||
    [profile.given_name, profile.family_name].filter(Boolean).join(" ").trim() ||
    undefined;
  const user = await upsertGoogleUser({
    email: profile.email,
    name: googleName,
    role: parsedState.role,
  });
  const session = issueSessionToken(user.id);

  const headers = new Headers();
  headers.set("Location", parsedState.next || (parsedState.role === "supplier" ? "/sources" : "/"));
  headers.append("Set-Cookie", sessionCookieHeader(session));
  headers.append("Set-Cookie", "aup_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
