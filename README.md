# MST Checker

Ứng dụng tra cứu mã số thuế nội bộ, xây dựng với Next.js và Supabase.

## Cảnh báo dữ liệu

Repository GitHub hiện là **public**. Workbook nguồn có tên, địa chỉ và mã số thuế nên đã được đưa vào `.gitignore`. Không commit workbook thật, `supabase/seed.sql`, API key hoặc service-role key vào repository này.

Dữ liệu thật được nạp trực tiếp vào project Supabase riêng bằng seed SQL sinh cục bộ.

## Chạy local

```powershell
Copy-Item .env.example .env.local
# Điền SUPABASE_URL, SUPABASE_SECRET_KEY,
# APP_LOGIN_USERNAME, APP_LOGIN_PASSWORD và APP_SESSION_SECRET
npm install
npm run dev
```

Mở `http://localhost:3000`.

## Supabase

1. Tạo project Supabase.
2. Chạy lần lượt các migration trong SQL Editor:
  - `supabase/migrations/202608130001_initial_schema.sql`
  - `supabase/migrations/202608130002_app_login_and_yearly_sources.sql`
  - `supabase/migrations/202608130003_recurring_refresh_schedule.sql`
  - `supabase/migrations/202608130004_targeted_and_monthly_refresh.sql`
  - `supabase/migrations/202608130005_prioritize_refresh_retries.sql`
  - `supabase/migrations/202608130006_endpoint_settings.sql`
  - `supabase/migrations/202608130007_taxpayer_activity_logs.sql`
  - `supabase/migrations/202608130008_manual_refresh_only.sql`
3. Tạo seed cục bộ từ workbook:

   ```powershell
   npm run generate:seed -- --input ".\2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx"
   ```

4. Mở file `supabase/seed.sql` cục bộ, kiểm tra số liệu rồi chạy trong SQL Editor. Script lưu sheet `T2-26` thành năm `2026` và đưa các MST hợp lệ vào `refresh_queue`. File này bị `.gitignore` để tránh đưa dữ liệu thật lên GitHub public.
5. Thiết lập secret nội bộ cho Edge Function bằng Supabase CLI hoặc Dashboard:
   `REFRESH_WORKER_SECRET`. Endpoint tra cứu MST công khai của XInvoice không
   yêu cầu `client-id` hoặc `api-key`.
6. Triển khai Edge Function `supabase/functions/xinvoice-refresh`. Migration `202608130008_manual_refresh_only.sql` và `supabase/cron.sql` tắt các cron tự động; người dùng bắt đầu cập nhật bằng nút `Cập nhật toàn bộ` ở tab Tổng hợp hoặc nút cập nhật từng MST. Worker vẫn xử lý theo lô tối đa 10 MST/lượt và retry/backoff để tôn trọng giới hạn endpoint.

Supabase Auth không được sử dụng trong phiên bản nội bộ này. Vercel kiểm tra
tài khoản ứng dụng trong các biến `APP_LOGIN_*` rồi cấp cookie phiên httpOnly.
Trình duyệt chỉ gọi API route của Next.js; secret key Supabase chỉ tồn tại ở
server.

Các chức năng chính gồm bảng tổng hợp theo một MST duy nhất, tìm nhanh theo MST
hoặc tên, tab năm động, thêm MST theo năm với cảnh báo trùng, cập nhật thủ công
từng MST và xuất workbook Excel nhiều sheet với các cột A–H tương thích mẫu.
Cột D `Mặt hàng` được giữ là cột vật lý trống và ẩn; dữ liệu ứng dụng tập trung
vào STT, tên, MST, tình trạng, hai thời điểm tra cứu và ghi chú. XInvoice là
nguồn chính; VietQR được dùng làm nguồn phụ khi XInvoice tạm lỗi hoặc bị giới
hạn, đồng thời không xoá các trường mà VietQR không cung cấp.

## Kiểm tra

```powershell
npm run typecheck
npm run build
```

## SSH remote

Remote dùng alias SSH đã cấu hình cho tài khoản `hainguyenpy195-coder`:

```text
git@github-hainguyenpy195-mst-checker:hainguyenpy195-coder/mst-checker.git
```

Chi tiết kiến trúc nằm trong [KE_HOACH_VERCEL_SUPABASE.md](./KE_HOACH_VERCEL_SUPABASE.md).
