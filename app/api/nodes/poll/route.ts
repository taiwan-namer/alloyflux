import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 舊 OAuth-relay poll 已退役；請改用 /api/agent/poll */
export async function POST() {
  return NextResponse.json(
    {
      error: "已改為 Node Agent 架構。請使用 npm run node-agent 與 /api/agent/*",
    },
    { status: 410 },
  );
}
