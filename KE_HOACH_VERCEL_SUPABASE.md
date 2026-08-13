# Kế hoạch xây dựng hệ thống tra cứu mã số thuế

> Trạng thái: Bản kế hoạch đề xuất, chờ phê duyệt trước khi triển khai  
> Ngày lập: 13/08/2026  
> Nền tảng dự kiến: Next.js trên Vercel + PostgreSQL/Auth/Edge Functions trên Supabase

## 1. Mục tiêu

Xây dựng một ứng dụng web nội bộ cho phép người dùng đã được cấp quyền:

- Đăng nhập bằng tài khoản do Supabase Auth quản lý.
- Nhập mã số thuế (MST) và nhận kết quả gần như tức thời từ Supabase PostgreSQL.
- Xem tình trạng hoạt động, tên người nộp thuế, địa chỉ, cơ quan thuế và thời điểm tra cứu gần nhất.
- Được thông báo rõ khi dữ liệu đang cũ, đang cập nhật hoặc gặp lỗi từ XInvoice.
- Tự động cập nhật dữ liệu nền từ API XInvoice mà không yêu cầu người dùng tải Excel lên.
- Lưu lịch sử khi tình trạng hoạt động của MST thực sự thay đổi.

Hệ thống mới chuyển quy trình từ xử lý từng file Excel sang một cơ sở dữ liệu tập trung. Chức năng xuất Excel cập nhật lại từ database sẽ được xem là hạng mục mở rộng nếu vẫn cần dùng cho nghiệp vụ.

## 2. Phạm vi MVP đề xuất

### Bao gồm

- Next.js App Router và TypeScript.
- Giao diện tra cứu chuyên nghiệp, ưu tiên phong cách Windows 11 và hiển thị tốt trên máy tính.
- Supabase Auth với Google là nhà cung cấp đăng nhập đầu tiên.
- Cơ chế phê duyệt tài khoản hoặc giới hạn tên miền email.
- Nạp dữ liệu Excel ban đầu bằng SQL chạy một lần.
- Tra cứu chính xác theo MST đã có trong database.
- Hàng đợi cập nhật XInvoice theo lô và giới hạn tốc độ.
- Lưu trạng thái hiện tại, thời điểm tra cứu, lỗi gần nhất và lịch sử thay đổi.
- Trang quản trị tối thiểu để xem tài khoản, tiến độ cập nhật và lỗi.
- Nhật ký tra cứu phục vụ kiểm tra vận hành.

### Chưa bao gồm trong MVP

- Cho người dùng tự tải Excel lên.
- Cho phép đăng ký xong là sử dụng ngay mà không cần phê duyệt.
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
    ├── Giao diện đăng nhập và tra cứu
    ├── Xác minh Supabase Auth session
    ├── Kiểm tra quyền người dùng
    └── API tra cứu chính xác theo MST
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
| Vercel | Phục vụ Next.js, giao diện, callback đăng nhập và API tra cứu cho người dùng |
| Supabase Auth | Xác thực Google/Microsoft/Facebook hoặc provider khác |
| Supabase PostgreSQL | Nguồn dữ liệu trung tâm và phân quyền dữ liệu |
| Supabase Cron | Lập lịch xử lý hàng đợi |
| Supabase Edge Function | Gọi XInvoice và cập nhật database |
| XInvoice | Nguồn dữ liệu tình trạng người nộp thuế |

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

1. Người dùng đăng nhập bằng Google hoặc provider đã được cấu hình.
2. Backend xác minh session và kiểm tra `profiles.approval_status = 'approved'`.
3. Người dùng nhập MST.
4. Hệ thống chuẩn hóa khoảng trắng và dấu phân cách, sau đó kiểm tra định dạng.
5. Next.js API Route truy vấn chính xác một MST trong Supabase.
6. Giao diện trả ngay dữ liệu hiện có cùng `last_checked_at`.
7. Nếu dữ liệu đã quá thời hạn, hệ thống đưa MST vào `refresh_queue` với độ ưu tiên cao.
8. Giao diện hiển thị “Đang cập nhật” nhưng vẫn giữ kết quả gần nhất.
9. Khi có dữ liệu mới, giao diện tải lại hoặc nhận thông báo cập nhật.

Mặc định đề xuất cho MVP: dữ liệu được xem là cũ sau 24 giờ.

## 8. Cập nhật XInvoice tự động

### Chiến lược xử lý

- Supabase Cron gọi Edge Function mỗi 30 hoặc 60 giây.
- Mỗi lần chạy chỉ nhận một lô nhỏ, ban đầu tối đa 10 MST.
- Chỉ một worker được quyền nhận cùng một MST tại một thời điểm.
- Dùng khóa database hoặc cơ chế claim nguyên tử để tránh hai worker xử lý trùng.
- Đọc `RateLimit` và `Retry-After` từ XInvoice thay vì chỉ dựa vào giá trị hard-code.
- Dùng exponential backoff cho lỗi tạm thời.
- Sau số lần thất bại quy định, chuyển bản ghi sang trạng thái cần kiểm tra thủ công.

### Ước lượng hiện tại

- Giới hạn quan sát được: khoảng 10 request/30 giây.
- Số MST duy nhất: 1.658.
- Thời gian tối thiểu cho một vòng cập nhật toàn bộ: khoảng 83 phút.
- Số request nếu cập nhật toàn bộ mỗi ngày: khoảng 49.740 request/tháng.

Cần xác nhận quota và điều khoản chính thức của tài khoản XInvoice trước khi bật cập nhật hàng ngày.

### Hành vi khi có lỗi

| Trường hợp | Xử lý |
|---|---|
| HTTP 429 | Đọc `Retry-After`, hoãn hàng đợi và giảm tốc độ |
| HTTP 401/403 | Dừng job, phát cảnh báo cấu hình credentials |
| HTTP 404 | Giữ dữ liệu cũ, ghi chú không tìm thấy và chuyển kiểm tra thủ công nếu lặp lại |
| HTTP 5xx/timeout | Retry có backoff, không ghi đè dữ liệu hợp lệ |
| Payload không đúng cấu trúc | Lưu lỗi rút gọn, không cập nhật trạng thái |
| MST bất thường | Chuyển vào `import_issues`, không tự sửa nếu không chắc chắn |

## 9. Xác thực và phân quyền

### Provider đăng nhập

- Giai đoạn đầu: Google.
- Nếu tổ chức dùng Microsoft 365: cân nhắc Azure/Microsoft thay cho Facebook.
- Facebook và các provider khác chỉ thêm khi có yêu cầu thực tế.

Mỗi provider cần OAuth App, client ID, client secret và redirect URL riêng. Việc bật provider trong Supabase không tự tạo các thông tin này.

### Phân biệt xác thực và cấp quyền

- Supabase Auth xác nhận người dùng là ai.
- Bảng `profiles` quyết định người dùng có được sử dụng ứng dụng hay không.
- Mặc định tài khoản mới ở trạng thái `pending`.
- Quản trị viên phê duyệt hoặc hệ thống chỉ cho phép tên miền email nội bộ.

### RLS và bảo vệ dữ liệu

- Bật Row Level Security cho toàn bộ bảng nghiệp vụ.
- Client không được quyền trực tiếp thêm, sửa hoặc xóa `taxpayers`.
- Không cấp quyền đọc toàn bộ bảng chỉ vì người dùng đã đăng nhập.
- Mọi tra cứu đi qua API Route/RPC giới hạn theo đúng một MST.
- Cập nhật XInvoice chỉ được thực hiện bởi Edge Function dùng service role.
- Ghi nhật ký các lượt tra cứu và thao tác quản trị.
- Thêm giới hạn tần suất theo người dùng để tránh quét toàn bộ database.

## 10. Quản lý secrets

Không đưa các giá trị sau xuống trình duyệt:

- `SUPABASE_SERVICE_ROLE_KEY`
- `XINVOICE_CLIENT_ID`
- `XINVOICE_API_KEY`
- OAuth provider client secrets

Phân bổ đề xuất:

| Biến | Nơi lưu |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel Environment Variables, được phép công khai |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel Environment Variables, được phép công khai khi RLS đúng |
| `SUPABASE_SERVICE_ROLE_KEY` | Chỉ Vercel server nếu API Route thật sự cần |
| `XINVOICE_CLIENT_ID` | Supabase Edge Function Secrets |
| `XINVOICE_API_KEY` | Supabase Edge Function Secrets |

## 11. Đánh giá giới hạn gói miễn phí

### Vercel Hobby

- 1.000.000 Function invocations/tháng.
- Tối đa 300 giây cho một Vercel Function.
- Cron chỉ chạy một lần/ngày và có thể lệch tới 59 phút.
- Chỉ dành cho mục đích cá nhân, phi thương mại theo chính sách hiện tại.

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
- [ ] Chốt provider đăng nhập đầu tiên.
- [ ] Chốt việc có giữ chức năng xuất Excel hay không.
- [ ] Phê duyệt kiến trúc trước khi viết code.

Kết quả: tài liệu thiết kế được duyệt và không còn quyết định ảnh hưởng lớn đến schema.

### Giai đoạn 1: Chuẩn hóa dữ liệu và database

- [ ] Xác nhận 17 MST bất thường.
- [ ] Thiết kế migration SQL tạo bảng, index và constraint.
- [ ] Tạo script đọc workbook offline và sinh SQL UTF-8.
- [ ] Tạo seed SQL có thể chạy lại an toàn.
- [ ] Nạp `taxpayers`, `taxpayer_sources` và `import_issues`.
- [ ] Kiểm tra tổng số bản ghi và các MST có số `0` đầu tiên.
- [ ] Thiết lập RLS cơ bản.

Kết quả: Supabase chứa dữ liệu đã chuẩn hóa, có thể đối chiếu lại với workbook.

Ước lượng: 0,5–1 ngày.

### Giai đoạn 2: Next.js, Auth và phân quyền

- [ ] Khởi tạo Next.js App Router với TypeScript.
- [ ] Thiết lập Supabase SSR/Auth.
- [ ] Cấu hình Google OAuth.
- [ ] Tạo callback và xử lý session.
- [ ] Tạo `profiles` và quy trình phê duyệt.
- [ ] Bảo vệ route tra cứu và route quản trị.
- [ ] Hoàn thiện RLS và kiểm thử truy cập trái phép.

Kết quả: chỉ người dùng được phê duyệt mới truy cập được ứng dụng.

Ước lượng: khoảng 1 ngày.

### Giai đoạn 3: Trang tra cứu

- [ ] Thiết kế giao diện tra cứu MST.
- [ ] Kiểm tra và chuẩn hóa dữ liệu nhập.
- [ ] Tạo API Route/RPC tra cứu chính xác một MST.
- [ ] Hiển thị trạng thái, thông tin doanh nghiệp và thời điểm tra cứu.
- [ ] Hiển thị dữ liệu cũ/đang cập nhật/lỗi.
- [ ] Ghi `lookup_audit_logs`.
- [ ] Thêm rate limit theo tài khoản.

Kết quả: người dùng tra cứu dữ liệu đã nạp gần như tức thời.

Ước lượng: khoảng 1 ngày.

### Giai đoạn 4: Worker cập nhật XInvoice

- [ ] Tạo `refresh_queue` và hàm claim nguyên tử.
- [ ] Tạo Supabase Edge Function gọi XInvoice.
- [ ] Cấu hình secrets.
- [ ] Xử lý rate limit, timeout, retry và backoff.
- [ ] So sánh trạng thái chuẩn hóa.
- [ ] Ghi lịch sử khi trạng thái thay đổi.
- [ ] Tạo Supabase Cron.
- [ ] Thêm cơ chế ưu tiên MST vừa được người dùng tra cứu.
- [ ] Tạo dashboard theo dõi tiến độ và lỗi.

Kết quả: dữ liệu được làm mới nền mà không cần mở trình duyệt.

Ước lượng: 1–2 ngày.

### Giai đoạn 5: Kiểm thử và triển khai

- [ ] Unit test chuẩn hóa MST và trạng thái.
- [ ] Integration test Supabase và XInvoice mock.
- [ ] Kiểm tra RLS bằng tài khoản anon, pending, approved và admin.
- [ ] Kiểm tra job bị chạy trùng.
- [ ] Kiểm tra khôi phục sau 429, timeout và 5xx.
- [ ] Kiểm tra một vòng cập nhật có đầy đủ số lượng.
- [ ] Thiết lập Vercel production domain và OAuth redirect URL.
- [ ] Lập quy trình backup/restore.
- [ ] Viết hướng dẫn vận hành.

Kết quả: MVP có thể bàn giao cho nhóm người dùng thử nghiệm.

Ước lượng: 0,5–1 ngày.

### Tổng ước lượng

Khoảng 3–5 ngày phát triển tập trung, chưa tính thời gian chờ:

- Cấp `client-id` và `api-key` XInvoice.
- Tạo OAuth App với Google/Microsoft/Facebook.
- Xác minh 17 MST bất thường.
- Phản hồi và nghiệm thu giao diện.

## 13. Tiêu chí nghiệm thu MVP

- Đăng nhập Google thành công trên domain production.
- Tài khoản chưa phê duyệt không thể tra cứu.
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
| Người dùng đăng nhập nhưng không được phép | Cao | Approval workflow hoặc email domain allowlist |
| Người dùng quét hàng loạt dữ liệu | Trung bình | API server-side, rate limit theo tài khoản, audit log |
| Dữ liệu lịch sử tăng quá nhanh | Trung bình | Chỉ lưu khi trạng thái thay đổi, có retention cho log |
| MST nguồn bị sai/mất số 0 | Cao | Lưu dạng text, quarantine 17 dòng bất thường, đối chiếu trước seed |
| Hai job xử lý trùng | Trung bình | Claim nguyên tử, `locked_at`, timeout lock và idempotent upsert |

## 15. Các quyết định cần chốt trước khi triển khai

1. MVP chỉ tra cứu 1.658 MST đã nhập hay được phép thêm MST mới khi người dùng tìm kiếm?
2. Chu kỳ làm mới là 24 giờ, 7 ngày hay chỉ cập nhật khi có người tra cứu?
3. Provider đăng nhập đầu tiên là Google hay Microsoft/Azure?
4. Tài khoản mới cần quản trị viên phê duyệt hay chỉ cần đúng tên miền email?
5. Chức năng xuất Excel cập nhật có còn là yêu cầu bắt buộc không?
6. Đã có `client-id` và `api-key` XInvoice chính thức chưa?
7. Đây là môi trường demo cá nhân hay ứng dụng nội bộ doanh nghiệp dùng thật?

## 16. Khuyến nghị mặc định

Nếu chưa có yêu cầu khác, phương án mặc định được đề xuất là:

- Chỉ tra cứu danh sách đã nạp; quản trị viên mới được thêm MST.
- Google Auth với quy trình phê duyệt tài khoản.
- Làm mới dữ liệu trong vòng 24 giờ.
- Trả kết quả cache ngay và ưu tiên cập nhật MST vừa được tìm kiếm.
- Supabase Cron + Edge Function thực hiện cập nhật nền.
- Chỉ lưu lịch sử khi trạng thái thay đổi.
- Vercel Hobby + Supabase Free chỉ dùng cho MVP/pilot.
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

