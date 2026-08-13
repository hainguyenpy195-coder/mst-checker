# MST Checker

Ứng dụng tra cứu mã số thuế nội bộ, xây dựng với Next.js và Supabase.

## Cảnh báo dữ liệu

Repository GitHub hiện là **public**. Workbook nguồn có tên, địa chỉ và mã số thuế nên đã được đưa vào `.gitignore`. Không commit workbook thật, `supabase/seed.sql`, API key hoặc service-role key vào repository này.

Dữ liệu thật được nạp trực tiếp vào project Supabase riêng bằng seed SQL sinh cục bộ.

## Chạy local

```powershell
Copy-Item .env.example .env.local
# Điền NEXT_PUBLIC_SUPABASE_URL và NEXT_PUBLIC_SUPABASE_ANON_KEY
npm install
npm run dev
```

Mở `http://localhost:3000`.

## Supabase

1. Tạo project Supabase.
2. Chạy migration `supabase/migrations/202608130001_initial_schema.sql` trong SQL Editor.
3. Cấu hình Google OAuth trong Supabase Auth và callback URL:
   `https://<domain>/auth/callback`
4. Tạo seed cục bộ từ workbook:

   ```powershell
   npm run generate:seed -- --input ".\2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx"
   ```

5. Mở file `supabase/seed.sql` cục bộ, kiểm tra số liệu rồi chạy trong SQL Editor. File này bị `.gitignore` để tránh đưa dữ liệu thật lên GitHub public.
6. Thiết lập secrets cho Edge Function bằng Supabase CLI hoặc Dashboard:
   `XINVOICE_CLIENT_ID`, `XINVOICE_API_KEY`, `REFRESH_WORKER_SECRET`.
7. Triển khai Edge Function `supabase/functions/xinvoice-refresh` và cấu hình cron theo `supabase/cron.sql`.

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
