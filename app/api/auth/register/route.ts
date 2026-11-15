import {
  createUser,
  homePathFor,
  issueSessionToken,
  jsonError,
  publicUser,
  sessionCookieHeader,
  type UserRole,
} from "@/lib/auth";
import { balance } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      password?: string;
      name?: string;
      role?: UserRole;
    };
    if (!body.email?.trim() || !body.password) {
      return Response.json({ error: "請填 Email 與密碼" }, { status: 400 });
    }
    const role: UserRole = body.role === "supplier" ? "supplier" : "buyer";
    const user = await createUser({
      email: body.email,
      password: body.password,
      name: body.name,
      role,
    });
    const token = issueSessionToken(user.id);
    return new Response(
      JSON.stringify({
        ok: true,
        user: publicUser(user),
        balance: await balance(user.id),
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
