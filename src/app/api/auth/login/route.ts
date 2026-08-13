import { NextResponse } from "next/server";
import { APP_SESSION_COOKIE, createSessionToken, isValidLogin, sessionCookieOptions } from "@/lib/app-auth";

export async function POST(request: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await request.json() as { username?: string; password?: string };
  } catch {
    return NextResponse.json({ error: "Dữ liệu đăng nhập không hợp lệ." }, { status: 400 });
  }

  const username = body.username?.trim() ?? "";
  const password = body.password ?? "";
  if (!isValidLogin(username, password)) {
    return NextResponse.json({ error: "Tên đăng nhập hoặc mật khẩu không đúng." }, { status: 401 });
  }

  try {
    const token = await createSessionToken(username);
    const response = NextResponse.json({ ok: true });
    const requestProtocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
    response.cookies.set({ name: APP_SESSION_COOKIE, value: token, ...sessionCookieOptions, secure: requestProtocol === "https" });
    return response;
  } catch (error) {
    console.error("app login configuration error", error);
    return NextResponse.json({ error: "Hệ thống chưa cấu hình khóa phiên đăng nhập." }, { status: 500 });
  }
}
