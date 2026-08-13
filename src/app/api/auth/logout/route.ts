import { NextResponse } from "next/server";
import { APP_SESSION_COOKIE, sessionCookieOptions } from "@/lib/app-auth";

export function POST(request: Request) {
  const response = NextResponse.json({ ok: true });
  const requestProtocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  response.cookies.set({ name: APP_SESSION_COOKIE, value: "", ...sessionCookieOptions, maxAge: 0, secure: requestProtocol === "https" });
  return response;
}
