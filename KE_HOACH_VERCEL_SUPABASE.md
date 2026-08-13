# Kế hoạch xây dựng hệ thống tra cứu mã số thuế

> Trạng thái: Đã được phê duyệt, đang triển khai theo mô hình đăng nhập nội bộ
> Ngày lập: 13/08/2026
> Nền tảng: Next.js trên Vercel + PostgreSQL/Cron/Edge Functions trên Supabase

## 1. Mục tiêu

Xây dựng một ứng dụng web nội bộ cho phép người dùng đã được cấp quyền:

- Đăng nhập nội bộ bằng một tài khoản ứng dụng do Vercel Environment Variables quản lý.
- Nhập mã số thuế (MST) và nhận kết quả gần như tức thời từ Supabase PostgreSQL.
- Xem tình trạng hoạt động, tên người nộp thuế, địa chỉ, cơ quan thuế và thời điểm tra cứu gần nhất.
- Được thông báo rõ khi dữ liệu đang cũ, đang cập nhật hoặc gặp lỗi từ XInvoice.
- Tự động cập nhật dữ liệu nền từ API XInvoice mà không yêu cầu người dùng tải Excel lên.
- Xem dữ liệu tổng hợp, lọc nhanh, xem theo năm và thêm MST vào năm theo dõi.
- Xuất workbook Excel nhiều sheet với các cột cập nhật giống file nghiệp vụ.
- Lưu lịch sử khi tình trạng hoạt động của MST thực sự thay đổi.

Hệ thống mới chuyển quy trình từ xử lý từng file Excel sang một cơ sở dữ liệu tập trung. Chức năng xuất Excel cập nhật lại từ database sẽ được xem là hạng mục mở rộng nếu vẫn cần dùng cho nghiệp vụ.

## 2. Phạm vi MVP đề xuất

### Bao gồm

- Next.js App Router và TypeScript.
- Giao diện tra cứu chuyên nghiệp, ưu tiên phong cách Windows 11 và hiển thị tốt trên máy tính.
- Đăng nhập nội bộ qua cookie phiên httpOnly được ký ở Vercel.
- Nạp dữ liệu Excel ban đầu bằng SQL chạy một lần.
- Tra cứu chính xác theo MST đã có trong database.
- Hàng đợi cập nhật XInvoice theo lô và giới hạn tốc độ.
- Lưu trạng thái hiện tại, thời điểm tra cứu, lỗi gần nhất và lịch sử thay đổi.
- API server-side bảo vệ secret key Supabase khỏi trình duyệt.

### Chưa bao gồm trong MVP

- Supabase Auth/OAuth và quy trình phê duyệt nhiều tài khoản.
- Cho người dùng tự tải Excel lên qua trình duyệt.
- Tự động thêm mọi MST chưa có trong danh sách.
- Xoay proxy hoặc né giới hạn tốc độ của XInvoice.
- Báo cáo thống kê nâng cao.
- Xuất lại workbook giữ nguyên toàn bộ hình ảnh, comment và định dạng gốc.

## 3. Hiện trạng dữ liệu đầu vào

File nguồn trong repo:

`2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx`

Các sheet nghiệp vụ cần nạp:

- `2023`
- `2024`
- `2025`
- `T2-26`

Trong database, `T2-26` (hoặc `T2-2026`) được chuẩn hóa thành năm `2026`.

Kết quả kiểm tra sơ bộ:

| Chỉ tiêu | Số lượng |
|---|---:|
| Dòng có MST | 2.152 |
| MST hợp lệ theo định dạng hiện tại | 2.135 |
| MST duy nhất hợp lệ | 1.658 |
| Lần xuất hiện trùng | 477 |
| MST cần kiểm tra/chuẩn hóa | 17 |

Nguyên tắc nhập dữ liệu:

- MST phải được lưu dưới dạng `text`, không dùng kiểu số để tránh mất số `0` đầu tiên.
- Một MST chỉ có một bản ghi hiện tại trong bảng `taxpayers`.
- Mọi lần MST xuất hiện trong các sheet/năm vẫn được giữ ở bảng `taxpayer_sources`.
- Không tự sửa các MST không chắc chắn. Chúng được đưa vào `import_issues` để xử lý thủ công.
- Script tạo dữ liệu SQL phải có tính lặp lại an toàn bằng `INSERT ... ON CONFLICT DO UPDATE`.

## 4. Kiến trúc đề xuất

```text
Người dùng
    │
    ▼
Vercel / Next.js
    ├── Giao diện đăng nhập nội bộ và dashboard
    ├── Xác minh cookie phiên httpOnly
    ├── API server-side đọc/ghi Supabase
    └── Xuất Excel theo năm
              │
              ▼
       Supabase PostgreSQL
       ├── Dữ liệu MST hiện tại
       ├── Nguồn dữ liệu theo sheet/năm
       ├── Lịch sử thay đổi trạng thái
       ├── Hàng đợi cập nhật
       ├── Lỗi cập nhật
       └── Nhật ký người dùng

Supabase Cron
    │
    ▼
Supabase Edge Function
    ├── Nhận một lô MST đến hạn
    ├── Gọi XInvoice bằng thông tin xác thực chính thức
    ├── Tôn trọng RateLimit và Retry-After
    └── Cập nhật PostgreSQL
```

### Phân chia trách nhiệm

| Thành phần | Trách nhiệm |
|---|---|
| Vercel | Phục vụ Next.js, đăng nhập nội bộ, giao diện, API tra cứu/thêm MST/xuất Excel |
| Supabase PostgreSQL | Nguồn dữ liệu trung tâm; Vercel server dùng secret key |
| Supabase Cron | Lập lịch xử lý hàng đợi |
| Supabase Edge Function | Gọi XInvoice và cập nhật database |
| XInvoice | Nguồn dữ liệu tình trạng người nộp thuế qua endpoint công khai |

## 5. Mô hình dữ liệu dự kiến

### `taxpayers`

Giữ dữ liệu mới nhất của mỗi MST.

Các trường chính:

- `tax_code text primary key`
- `name text`
- `org_type text`
- `address text`
- `tax_department text`
- `status text`
- `status_group text`
- `source_updated_at timestamptz`
- `previous_checked_at timestamptz`
- `last_checked_at timestamptz`
- `status_changed_at timestamptz`
- `last_error text`
- `consecutive_failures integer`
- `next_check_at timestamptz`
- `raw_current_response jsonb` nếu thực sự cần phục vụ chẩn đoán
- `created_at timestamptz`
- `updated_at timestamptz`

### `taxpayer_sources`

Giữ quan hệ giữa MST và dữ liệu Excel nguồn.

- `id bigint`
- `tax_code text`
- `source_sheet text`
- `source_year text`
- `source_row integer`
- `source_vendor_name text`
- `source_note text`
- Ràng buộc duy nhất để tránh nhập trùng khi chạy lại seed.

### `taxpayer_status_history`

Chỉ thêm bản ghi khi trạng thái thay đổi đáng kể.

- `id bigint`
- `tax_code text`
- `old_status text`
- `new_status text`
- `detected_at timestamptz`
- `source_updated_at timestamptz`
- `note text`

Không lưu một dòng lịch sử cho mỗi lần kiểm tra thành công nếu trạng thái không thay đổi. Cách này giúp tránh tạo hơn 605.000 dòng/năm khi cập nhật 1.658 MST mỗi ngày.

### `refresh_queue`

- `tax_code text primary key`
- `priority smallint`
- `state text`
- `attempts integer`
- `run_after timestamptz`
- `locked_at timestamptz`
- `last_error text`
- `created_at timestamptz`
- `updated_at timestamptz`

### `profiles`

Bảng cũ được giữ lại để không phá migration hiện hữu nhưng không được sử dụng
trong luồng đăng nhập nội bộ hiện tại.

- `id uuid`, liên kết `auth.users.id`
- `email text`
- `display_name text`
- `role text`: `admin` hoặc `user`
- `approval_status text`: `pending`, `approved`, `blocked`
- `created_at timestamptz`
- `approved_at timestamptz`
- `approved_by uuid`

### `lookup_audit_logs`

- `id bigint`
- `user_id uuid`
- `tax_code text`
- `result text`
- `created_at timestamptz`

### `import_issues`

- `id bigint`
- `source_sheet text`
- `source_row integer`
- `raw_tax_code text`
- `suggested_tax_code text`
- `issue_type text`
- `resolution_status text`
- `note text`

## 6. Quy tắc trạng thái và thời gian

Ba loại thời gian phải được tách riêng:

| Trường | Ý nghĩa |
|---|---|
| `source_updated_at` | Thời điểm dữ liệu nguồn do XInvoice trả về được cập nhật |
| `last_checked_at` | Thời điểm backend của hệ thống gọi XInvoice thành công gần nhất |
| `status_changed_at` | Thời điểm hệ thống lần đầu phát hiện trạng thái thay đổi |

Quy tắc cập nhật:

- Không ghi đè trạng thái hợp lệ cũ bằng `null` khi API lỗi.
- API lỗi chỉ cập nhật `last_error`, số lần lỗi và thời điểm thử lại.
- Chỉ thêm lịch sử khi trạng thái đã chuẩn hóa thực sự thay đổi.
- Các cách diễn đạt cùng nghĩa như “NNT đang hoạt động” và “NNT đang hoạt động (đã được cấp GCN ĐKT)” có thể được gom vào cùng nhóm `active`.
- Phải giữ nguyên chuỗi trạng thái gốc để người dùng kiểm tra khi cần.

## 7. Luồng tra cứu của người dùng

1. Người dùng đăng nhập bằng tài khoản nội bộ đã cấu hình trong Vercel.
2. Next.js xác minh cookie phiên httpOnly đã ký.
3. Người dùng nhập MST.
4. Hệ thống chuẩn hóa khoảng trắng và dấu phân cách, sau đó kiểm tra định dạng.
5. Next.js API Route truy vấn chính xác một MST trong Supabase.
6. Giao diện trả ngay dữ liệu hiện có cùng `last_checked_at`.
7. Nếu dữ liệu đã quá thời hạn, hệ thống đưa MST vào `refresh_queue` với độ ưu tiên cao.
8. Giao diện hiển thị “Đang cập nhật” nhưng vẫn giữ kết quả gần nhất.
9. Khi có dữ liệu mới, giao diện tải lại hoặc người dùng bấm làm mới.

Theo yêu cầu vận hành, dữ liệu chỉ được enqueue toàn bộ vào 12:00 ngày 1
hàng tháng theo giờ Việt Nam. `next_check_at` vẫn được lưu để tham khảo, nhưng
không còn là cơ chế tự refresh hàng ngày.

## 8. Cập nhật XInvoice tự động

### Chiến lược xử lý

- Một cron dispatcher enqueue toàn bộ MST lúc 05:00 UTC ngày 1 hàng tháng
  (12:00 UTC+7).
- Một cron drain gọi worker mỗi phút; khi hàng đợi rỗng worker không gọi XInvoice.
- Mỗi lần chạy chỉ nhận một lô nhỏ, ban đầu tối đa 10 MST.
- Lần đầu seed đã đưa toàn bộ MST vào hàng đợi để chạy backfill.
- Khi thêm hoặc bấm cập nhật một MST, API gửi `taxCode` để worker claim đúng mã đó.
- Chỉ một worker được quyền nhận cùng một MST tại một thời điểm.
- Dùng khóa database hoặc cơ chế claim nguyên tử để tránh hai worker xử lý trùng.
- Đọc `RateLimit` và `Retry-After` từ XInvoice thay vì chỉ dựa vào giá trị hard-code.
- Dùng exponential backoff cho lỗi tạm thời.
- Sau số lần thất bại quy định, chuyển bản ghi sang trạng thái cần kiểm tra thủ công.

### Ước lượng hiện tại

- Giới hạn quan sát được: khoảng 10 request/30 giây.
- Số MST duy nhất: 1.658.
- Với tối đa 10 MST mỗi phút, backfill lần đầu dự kiến khoảng 166 phút.
- Sau đó chỉ có một vòng toàn bộ mỗi tháng, ngoài các targeted refresh do người dùng yêu cầu.

### Hành vi khi có lỗi

| Trường hợp | Xử lý |
|---|---|
| HTTP 429 | Đọc `Retry-After`, hoãn hàng đợi và giảm tốc độ |
| HTTP 401/403 | Dừng job, phát cảnh báo cấu hình credentials |
| HTTP 404 | Giữ dữ liệu cũ, ghi chú không tìm thấy và chuyển kiểm tra thủ công nếu lặp lại |
| HTTP 5xx/timeout | Retry có backoff, không ghi đè dữ liệu hợp lệ |
| Payload không đúng cấu trúc | Lưu lỗi rút gọn, không cập nhật trạng thái |
| MST bất thường | Chuyển vào `import_issues`, không tự sửa nếu không chắc chắn |

## 9. Xác thực nội bộ và bảo vệ dữ liệu

- Vercel kiểm tra `APP_LOGIN_USERNAME` và `APP_LOGIN_PASSWORD` ở server.
- Sau khi đăng nhập, ứng dụng cấp cookie `mst_checker_session` có chữ ký HMAC,
  `httpOnly`, `sameSite=lax` và thời hạn giới hạn.
- `APP_SESSION_SECRET` không được commit.
- Supabase Auth/OAuth không tham gia vào luồng hiện tại; bảng `profiles` cũ
  được giữ lại để không phá dữ liệu/migration nhưng không được đọc bởi UI.

### RLS và bảo vệ dữ liệu

- Bật Row Level Security cho toàn bộ bảng nghiệp vụ.
- Client không được quyền trực tiếp kết nối Supabase; mọi thao tác đi qua API
  Route của Next.js.
- `SUPABASE_SECRET_KEY` chỉ tồn tại trên Vercel server và bypass RLS có chủ đích.
- Mọi tra cứu, thêm MST và xuất Excel đều kiểm tra cookie phiên trước khi đọc DB.
- Cập nhật XInvoice chỉ được thực hiện bởi Edge Function dùng service role.
- Ghi nhật ký các lượt tra cứu và thao tác quản trị.
- Thêm giới hạn tần suất theo người dùng để tránh quét toàn bộ database.

## 10. Quản lý secrets

Không đưa các giá trị sau xuống trình duyệt:

- `SUPABASE_SECRET_KEY`
- `APP_LOGIN_PASSWORD`
- `APP_SESSION_SECRET`
- Vercel Environment Variables containing application or Supabase secrets

Phân bổ đề xuất:

| Biến | Nơi lưu |
|---|---|
| `SUPABASE_URL` | Vercel Environment Variables, server-only |
| `SUPABASE_SECRET_KEY` | Vercel Environment Variables, server-only |
| `APP_LOGIN_USERNAME` | Vercel Environment Variables |
| `APP_LOGIN_PASSWORD` | Vercel Environment Variables, sensitive |
| `APP_SESSION_SECRET` | Vercel Environment Variables, sensitive |
## 11. Đánh giá giới hạn gói miễn phí

### Vercel Hobby

- Chỉ dùng cho giao diện Next.js và API server-side nhẹ.
- Không dùng Vercel Cron để chạy vòng cập nhật XInvoice.
- Vercel API không được giữ secret XInvoice hoặc chạy worker dài.

Hệ quả:

- Đủ tài nguyên cho demo/MVP cá nhân.
- Không dùng Vercel Function để chạy vòng cập nhật kéo dài 83 phút.
- Ứng dụng nội bộ doanh nghiệp nên chuyển sang Vercel Pro hoặc xác nhận lại phương án hosting trước production.

### Supabase Free

- 500 MB database cho mỗi project.
- 50.000 MAU.
- 500.000 Edge Function invocations/tháng.
- 5 GB egress/tháng.
- Có thể tạm dừng project ít hoạt động trong vòng 7 ngày.
- Không có daily backup tải xuống như gói trả phí.

Hệ quả:

- Dung lượng dư sức cho dữ liệu hiện tại nếu chỉ lưu trạng thái hiện tại và lịch sử thay đổi.
- Một Cron chạy mỗi 30 giây tạo khoảng 86.400 Edge Function invocations/tháng, vẫn nằm trong quota hiện tại.
- Cần tự động hoặc thủ công chạy `supabase db dump` và lưu backup ngoài Supabase.
- Gói Free phù hợp pilot; production cần đánh giá yêu cầu sẵn sàng và backup.

## 12. Các giai đoạn triển khai

### Giai đoạn 0: Phê duyệt thiết kế

- [x] Kiểm tra sơ bộ workbook.
- [x] Phân tích API XInvoice và giới hạn tốc độ quan sát được.
- [x] Phân tích Vercel Hobby và Supabase Free.
- [ ] Chốt phạm vi MST được phép tra cứu.
- [ ] Chốt chu kỳ làm mới dữ liệu.
- [x] Chốt đăng nhập nội bộ bằng tài khoản ứng dụng.
- [x] Giữ chức năng xuất Excel theo năm.
- [x] Phê duyệt kiến trúc trước khi viết code.

Kết quả: tài liệu thiết kế được duyệt và không còn quyết định ảnh hưởng lớn đến schema.

### Giai đoạn 1: Chuẩn hóa dữ liệu và database

- [ ] Xác nhận 17 MST bất thường.
- [x] Thiết kế migration SQL tạo bảng, index và constraint.
- [x] Tạo script đọc workbook offline và sinh SQL UTF-8.
- [x] Tạo seed SQL có thể chạy lại an toàn.
- [x] Nạp logic cho `taxpayers`, `taxpayer_sources` và `import_issues`.
- [x] Kiểm tra tổng số bản ghi và các MST có số `0` đầu tiên.
- [x] Thiết lập RLS cơ bản.

Kết quả: Supabase chứa dữ liệu đã chuẩn hóa, có thể đối chiếu lại với workbook.

Ước lượng: 0,5–1 ngày.

### Giai đoạn 2: Next.js, đăng nhập nội bộ và API

- [x] Khởi tạo Next.js App Router với TypeScript.
- [x] Tạo đăng nhập username/password nội bộ.
- [x] Tạo cookie phiên httpOnly có chữ ký.
- [x] Chuyển API sang Supabase server-only secret key.
- [x] Bảo vệ route tra cứu, thêm MST và xuất Excel.

Kết quả: chỉ người dùng được phê duyệt mới truy cập được ứng dụng.

Ước lượng: khoảng 1 ngày.

### Giai đoạn 3: Trang tra cứu và workbook

- [x] Thiết kế giao diện tra cứu MST.
- [x] Kiểm tra và chuẩn hóa dữ liệu nhập.
- [x] Tạo API Route/RPC tra cứu chính xác một MST.
- [x] Hiển thị trạng thái, thông tin doanh nghiệp và thời điểm tra cứu.
- [x] Hiển thị dữ liệu cũ/đang cập nhật/lỗi.
- [x] Hiển thị tổng hợp và lọc nhanh.
- [x] Hiển thị tab năm động từ database.
- [x] Thêm MST theo năm.
- [x] Xuất workbook nhiều sheet với cột cập nhật.

Kết quả: người dùng tra cứu dữ liệu đã nạp gần như tức thời.

Ước lượng: khoảng 1 ngày.

### Giai đoạn 4: Worker cập nhật XInvoice

- [x] Tạo `refresh_queue` và hàm claim nguyên tử.
- [x] Tạo Supabase Edge Function gọi XInvoice.
- [x] Cấu hình secrets trên project Supabase thực tế.
- [x] Xử lý rate limit, timeout, retry và backoff.
- [x] So sánh trạng thái chuẩn hóa.
- [x] Ghi lịch sử khi trạng thái thay đổi.
- [x] Kích hoạt Supabase Cron trên project thực tế.
- [x] Thêm cơ chế ưu tiên MST vừa được người dùng tra cứu.
- [x] Thêm nút cập nhật targeted sau từng MST.
- [x] Hiển thị summary pending/error trên dashboard.

Kết quả: dữ liệu được làm mới nền mà không cần mở trình duyệt.

Ước lượng: 1–2 ngày.

### Giai đoạn 5: Kiểm thử và triển khai

- [ ] Unit test chuẩn hóa MST và trạng thái.
- [ ] Integration test Supabase và XInvoice mock.
- [x] Kiểm tra cookie login và API không có session.
- [ ] Kiểm tra job bị chạy trùng.
- [ ] Kiểm tra khôi phục sau 429, timeout và 5xx.
- [ ] Kiểm tra một vòng cập nhật có đầy đủ số lượng.
- [ ] Thiết lập Vercel production domain và Environment Variables.
- [ ] Lập quy trình backup/restore.
- [ ] Viết hướng dẫn vận hành.

Kết quả: MVP có thể bàn giao cho nhóm người dùng thử nghiệm.

Ước lượng: 0,5–1 ngày.

### Tổng ước lượng

Khoảng 3–5 ngày phát triển tập trung, chưa tính thời gian chờ:

- Xác nhận quota và khả năng truy cập ổn định tới endpoint XInvoice công khai.
- Xác minh 17 MST bất thường.
- Phản hồi và nghiệm thu giao diện.

## 13. Tiêu chí nghiệm thu MVP

- Đăng nhập nội bộ thành công trên domain production sau khi cấu hình Vercel Environment Variables.
- Sheet T2-26 được lưu trong database dưới năm 2026 và có thể xuất lại thành sheet 2026.
- Cron ngày 1 hàng tháng enqueue toàn bộ MST; cron drain xử lý hàng đợi theo lô.
- Nút cập nhật từng MST chỉ claim và cập nhật đúng mã được chọn.
- MST đã tồn tại khi thêm mới bị từ chối và trả cảnh báo trùng.
- API không có cookie phiên trả về 401.
- Tra cứu đúng MST có trong database và không lộ danh sách toàn bộ MST.
- MST giữ được số `0` đầu tiên.
- Kết quả hiển thị `last_checked_at` rõ ràng.
- Dữ liệu cũ được đưa vào hàng đợi nhưng kết quả cũ vẫn hiển thị.
- API lỗi không làm mất trạng thái hợp lệ trước đó.
- Trạng thái thay đổi tạo đúng một bản ghi lịch sử.
- Hai worker không cập nhật trùng cùng một MST.
- Hệ thống tự giảm tốc độ khi nhận HTTP 429.
- Có thể theo dõi số lượng pending/running/success/error.
- Có bản backup database thử nghiệm và quy trình restore đã được kiểm tra.

## 14. Rủi ro và biện pháp giảm thiểu

| Rủi ro | Mức độ | Biện pháp |
|---|---|---|
| XInvoice thay đổi quota hoặc yêu cầu credentials | Cao | Dùng tài khoản chính thức, đọc header động, xác nhận hợp đồng API |
| XInvoice chặn do vượt giới hạn | Cao | Queue toàn cục, batch nhỏ, backoff, không xoay proxy |
| Vercel Hobby không phù hợp ứng dụng doanh nghiệp | Cao | Chỉ dùng cho demo hoặc chuyển Vercel Pro trước production |
| Supabase Free bị pause | Trung bình | Theo dõi hoạt động, quy trình restore, cân nhắc Pro |
| Không có backup tải xuống trên Free | Cao | Chạy `supabase db dump` định kỳ và lưu ngoài nền tảng |
| Mật khẩu nội bộ bị lộ | Cao | Không commit, thay mật khẩu trước production, dùng cookie ký và HTTPS |
| Người dùng quét hàng loạt dữ liệu | Trung bình | API server-side, giới hạn truy vấn và theo dõi log |
| Dữ liệu lịch sử tăng quá nhanh | Trung bình | Chỉ lưu khi trạng thái thay đổi, có retention cho log |
| MST nguồn bị sai/mất số 0 | Cao | Lưu dạng text, quarantine 17 dòng bất thường, đối chiếu trước seed |
| Hai job xử lý trùng | Trung bình | Claim nguyên tử, `locked_at`, timeout lock và idempotent upsert |

## 15. Các quyết định cần chốt trước khi triển khai

1. Chu kỳ làm mới nền mặc định 24 giờ, có thể điều chỉnh bằng queue.
2. Tài khoản nội bộ ban đầu là `hainh`; mật khẩu lưu trong Vercel, không commit.
3. Đã xác nhận bắt buộc xuất Excel theo các năm trong database.
4. Endpoint XInvoice hiện không yêu cầu `client-id` hoặc `api-key`; chỉ cần cấu hình secret nội bộ cho worker.
5. Cần thay mật khẩu mẫu trước khi mở domain cho nhiều người dùng.

## 16. Khuyến nghị mặc định

Nếu chưa có yêu cầu khác, phương án mặc định được đề xuất là:

- Cho phép tài khoản nội bộ thêm MST theo năm.
- Vercel login cookie thay cho Supabase Auth trong giai đoạn beta.
- Làm mới dữ liệu trong vòng 24 giờ.
- Trả kết quả cache ngay và ưu tiên cập nhật MST vừa được tìm kiếm.
- Supabase Cron + Edge Function thực hiện cập nhật nền.
- Chỉ lưu lịch sử khi trạng thái thay đổi.
- Vercel chỉ phục vụ UI/API; Supabase Cron + Edge Function chạy cập nhật nền.
- Trước khi đưa vào sử dụng nội bộ chính thức, đánh giá Vercel Pro, Supabase Pro và kế hoạch backup.

## 17. Tài liệu tham khảo chính thức

- [Vercel Hobby Plan](https://vercel.com/docs/plans/hobby)
- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations)
- [Vercel Cron Jobs Usage and Pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Supabase Billing and Free Quotas](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase Production Checklist](https://supabase.com/docs/guides/deployment/going-into-prod)
- [Supabase Social Login](https://supabase.com/docs/guides/auth/social-login)
- [Supabase Edge Function Limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [XInvoice API tra cứu mã số thuế](https://xinvoice.vn/apis/tra-cuu-ma-so-thue)
