import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Mã dòng hạch toán không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: deletedRows, error: deleteError } = await supabase
    .from("purchase_invoices")
    .delete()
    .eq("id", id)
    .select("id");

  if (deleteError) {
    console.error("purchase invoice delete failed", deleteError);
    return NextResponse.json({ error: "Không thể xóa dòng hạch toán mua vào." }, { status: 500 });
  }
  if (!deletedRows?.length) {
    return NextResponse.json({ error: "Không tìm thấy dòng hạch toán mua vào." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id });
}
