import {
  authenticateEmailPassword,
  homePathFor,
  issueSessionToken,
  jsonError,
  publicUser,
  sessionCookieHeader,
} from "@/lib/auth";
import { balance } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { email?: string; password?: string };
    if (!body.email?.trim() || !body.password) {
      return Response.json({ error: "請填 Email 與密碼" }, { status: 400 });
    }
    const user = authenticateEmailPassword(body.email, body.password);
    const token = issueSessionToken(user.id);
    return new Response(
      JSON.stringify({
        ok: true,
        user: publicUser(user),
        balance: balance(user.id),
        redirect: homePathFor(user),
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": sessionCookieHeader(token),
        },
      },
    );
  } catch (e) {
    return jsonError(e);
  }
}
