import { NextResponse, type NextRequest } from "next/server";
import { APP_SESSION_COOKIE, verifySessionToken } from "@/lib/app-auth";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isPublicRoute = pathname.startsWith("/login") || pathname.startsWith("/api/auth/") || pathname.startsWith("/auth/callback") || pathname.startsWith("/api/health") || pathname.startsWith("/_next");
  if (isPublicRoute) return NextResponse.next({ request });

  const session = await verifySessionToken(request.cookies.get(APP_SESSION_COOKIE)?.value);
  if (!session && pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Bạn cần đăng nhập để sử dụng chức năng này." }, { status: 401 });
  }

  if (!session) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next({ request });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
