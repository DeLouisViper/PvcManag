# HAIC PVC Terminal - quản lý ống PVC & vật tư lắp đặt

Ứng dụng web tính vật tư và quản lý tồn kho cho **Piezometer, Standpipe, Permeability, Seismic**:
nhập độ sâu hố khoan -> tự tính ống PVC, ống lọc, nắp, **kế hoạch cắt ống**, tái sử dụng đoạn dư -> lưu và trừ kho nguyên tử (atomic) -> theo dõi tồn kho, lịch sử, sổ giao dịch.

*English summary: React + Vite + TypeScript + Tailwind frontend, Supabase (PostgreSQL + Auth + RLS) backend, 100% free tiers. All stock changes happen inside secure PostgreSQL functions; the browser can only read.*

## 1. Công nghệ

| Phần | Công nghệ |
|---|---|
| Giao diện | React 18, Vite, TypeScript, Tailwind CSS (giao diện TVA Loki, JetBrains Mono, CRT scanline) |
| Cơ sở dữ liệu / đăng nhập | Supabase Free: PostgreSQL, Supabase Auth, Row Level Security |
| Tạo tài khoản nhân viên | 1 Supabase Edge Function (`admin-users`), dùng service-role key **chỉ ở server** |
| Xuất báo cáo | CSV, PDF (jsPDF, chạy trên trình duyệt, có font hỗ trợ tiếng Việt) |
| Hosting | Cloudflare Pages hoặc GitHub Pages (miễn phí) |

Không dùng API trả phí, thư viện UI trả phí hay dịch vụ AI. Biểu đồ vẽ bằng SVG thuần (không thêm thư viện).

## 2. Cấu trúc thư mục

```
src/lib/engine/        Engine tính toán (thuần TypeScript, mọi chiều dài tính bằng mm nguyên) + test
src/lib/i18n/          Từ điển Việt / Anh tập trung
src/pages/             Dashboard, Calculator, Inventory, History, Transactions, Users, Settings
supabase/migrations/   0001 schema, 0002 hàm bảo mật, 0003 RLS
supabase/setup_all.sql Gộp 3 migration thành 1 file để dán vào SQL Editor
supabase/functions/admin-users/   Edge Function tạo user / đặt lại mật khẩu
tests/db/              Test tích hợp (PGlite + PostgreSQL thật)
```

## 3. Cài đặt để chạy thử trên máy

Cần Node.js 20 trở lên.

```bash
npm install
cp .env.example .env      # rồi điền 2 giá trị công khai của Supabase (mục 4.3)
npm run dev               # mở http://localhost:5173
```

## 4. Thiết lập Supabase (làm 1 lần, ~10 phút)

### 4.1 Tạo project
1. Vào https://supabase.com, đăng ký, **New project** (gói Free).
2. Chọn vùng gần Việt Nam (ví dụ Singapore). Ghi nhớ mật khẩu database.

### 4.2 Tạo database
1. Supabase -> **SQL Editor** -> **New query**.
2. Mở file `supabase/setup_all.sql`, dán toàn bộ nội dung, bấm **Run**. Chạy **một lần** trên project trống.
   (Dùng Supabase CLI thì chạy `supabase db push` với thư mục `supabase/migrations`.)

### 4.3 Lấy khóa công khai cho ứng dụng
**Project Settings -> API**: copy **Project URL** và **anon / publishable key** vào file `.env`:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

**TUYỆT ĐỐI không** đưa `service_role` / secret key vào `.env` hay mã nguồn giao diện.

### 4.4 Tắt đăng ký công khai (bắt buộc)
**Authentication -> Sign In / Providers** (hoặc *Settings*): tắt **Allow new users to sign up**.
Lớp bảo vệ thứ hai: tài khoản tự tạo luôn ở trạng thái *chưa kích hoạt* và không xem được gì cho đến khi admin kích hoạt.

### 4.5 Tạo tài khoản Admin đầu tiên (an toàn)
1. Supabase -> **Authentication -> Users -> Add user -> Create new user**: nhập email + mật khẩu mạnh, tick **Auto Confirm User**.
2. **SQL Editor**, chạy (thay email của anh):

```sql
update public.profiles
   set role = 'admin', active = true, full_name = 'Tên của anh'
 where email = 'admin@congty.com';
```

3. Đăng nhập vào ứng dụng bằng tài khoản đó. Đây là lần duy nhất phải dùng SQL để cấp quyền admin; sau này admin cấp quyền cho người khác ngay trong ứng dụng.

### 4.6 Triển khai Edge Function tạo nhân viên
Cần cho nút **Tạo người dùng** và **Đặt lại mật khẩu** (đổi vai trò / khóa tài khoản không cần).

```bash
npm i -g supabase            # hoặc dùng npx supabase
supabase login
supabase link --project-ref <PROJECT_REF>
supabase functions deploy admin-users
```

Function dùng service-role key do Supabase tự cấp cho Edge Function; khóa này không bao giờ tới trình duyệt. Function kiểm tra người gọi là **admin đang hoạt động** trước khi làm gì.
Không muốn dùng function: tạo user trong Supabase Dashboard, rồi vào **Quản lý người dùng** của ứng dụng để bật *Account active* và chọn vai trò.

## 5. Cấp tài khoản cho nhân viên

1. Đăng nhập Admin -> **Quản lý người dùng** -> **Tạo người dùng**.
2. Nhập họ tên, email, vai trò (Admin / Người dùng thường), bấm *Tạo ngẫu nhiên* mật khẩu tạm.
3. Gửi email + mật khẩu tạm cho nhân viên. Lần đăng nhập đầu họ **bắt buộc đổi mật khẩu**.
4. Đổi vai trò, khóa/mở tài khoản, đặt lại mật khẩu ngay trong trang này. Luôn còn ít nhất 1 admin hoạt động (hệ thống chặn nếu cố xóa quyền admin cuối cùng).

## 6. Quy trình sử dụng

1. **Admin nhập tồn kho ban đầu**: *Tồn kho vật tư -> Tồn kho ban đầu*: ống nguyên, **từng đoạn dư (theo chiều dài)**, ống lọc (số đoạn x chiều dài), nắp. Đây là giao dịch có kiểm soát, cộng vào sổ kho, không ghi đè.
2. **Admin ghi nhập mua** khi mua thêm hàng.
3. **Nhân viên** vào *Tính vật tư lắp đặt*: chọn loại, thêm vị trí (Add Location), nhập độ sâu -> **Tính vật tư** (chỉ xem trước, không trừ kho) -> **Lưu lắp đặt & xuất vật tư** (trừ kho nguyên tử).
4. Thiếu vật tư: hệ thống nêu chính xác từng loại thiếu bao nhiêu. Nhân viên không tự sửa tồn kho được; admin nhập mua hoặc điều chỉnh có lý do.
5. Sai sót: admin dùng **Điều chỉnh** (bắt buộc lý do) hoặc **Hủy lắp đặt** (tạo giao dịch hoàn trả, bản ghi cũ vẫn giữ nguyên để truy vết).

## 7. Quy tắc tính toán

```
Tổng chiều dài lắp đặt = độ sâu + phần nhô trên mặt đất        (Piezometer / Permeability / Standpipe: +1,0 m; Seismic: +0,5 m)
Chiều dài PVC          = tổng chiều dài - chiều dài ống lọc    (Seismic: ống lọc 0 m => PVC = tổng)
Nắp                    = 1 nắp trên + 1 nắp đáy mỗi vị trí
```

Mặc định ống lọc: Piezometer 1 m, Permeability 1 m, Standpipe 5 m, Seismic không có. Mọi giá trị chỉnh được ở **Cài đặt** (chỉ áp dụng cho các lần tính sau; mỗi bản ghi lắp đặt lưu lại bản chụp cài đặt đã dùng).

**Kế hoạch cắt ống** cho từng đường kính (D35 / D55 / D90 không bao giờ trộn lẫn):
- ống mới dài 4 m; dùng đoạn dư đúng đường kính trước (vừa khít, rồi đoạn nhỏ nhất đủ dài);
- phần dư của một lần cắt được dùng lại ngay cho vị trí kế tiếp trong cùng lần tính;
- thử nhiều thứ tự và chọn phương án dùng **ít ống mới nhất**, rồi ít mối nối nhất;
- mỗi mm đều được hạch toán: đoạn nguồn = đoạn cắt + phần dư + hao hụt + phế liệu; không đoạn nào dài hơn đoạn nguồn;
- đoạn dư lưu từng đoạn riêng (ví dụ 2,5 m x 1, 1,0 m x 1), không gộp thành tổng mét;
- cho phép nối nhiều đoạn (có thể tắt ở Cài đặt); hao hụt khi cắt mặc định 0 m, chỉ áp dụng nếu admin bật.

Kiểm tra bắt buộc đã chạy tự động: Piezometer 12,5 m -> 4 ống, PVC 12,5 m, ống lọc 1 m, 2 nắp, dư 3,5 m; Standpipe 18 m -> 4 ống, PVC 14 m, dư 2 m; Permeability 10 m -> 3 ống, dư 2 m; Seismic 20 m -> 6 ống D90, PVC 20,5 m, dư 3,5 m.
(Khi kho đã có đoạn dư, hệ thống dùng chúng trước nên số ống mới sẽ ít hơn, đúng yêu cầu.)

## 8. Bảo mật

- **Trình duyệt chỉ đọc được dữ liệu**: không có policy INSERT/UPDATE/DELETE nào. Mọi thay đổi kho đi qua hàm `SECURITY DEFINER` (`save_installation`, `admin_record_opening_stock`, `admin_record_purchase`, `admin_adjust_inventory`, `admin_reverse_installation`, ...).
- Hàm kiểm tra `auth.uid()`, quyền admin, **tính lại toàn bộ độ dài / ống lọc / nắp từ cài đặt trong database**, kiểm tra kế hoạch cắt khớp từng mm với đoạn nguồn thật, khóa dòng kho, rồi mới trừ. Số liệu từ giao diện không được tin.
- Tồn kho không thể âm (ràng buộc CHECK + kiểm tra trong hàm).
- Sổ giao dịch, nhật ký kiểm toán, chi tiết lắp đặt: trigger chặn sửa/xóa (kể cả superuser).
- Chống bấm đúp: mỗi lần tính có `client_request_id`; gửi lại cùng mã chỉ trả bản ghi cũ, không trừ kho lần hai.
- Nhiều người cùng lúc: khóa dòng theo thứ tự cố định; người đến sau nhận thông báo thiếu hàng hoặc "kế hoạch đã cũ" rồi được tính lại.
- Mọi lỗi giữa chừng rollback toàn bộ.
- Người dùng thường không đổi được vai trò của mình, không sửa tồn kho, không đọc mua hàng và nhật ký kiểm toán.

## 9. Kiểm thử

```bash
npm test                 # engine (29 test) + test database trên PGlite (không cần cài gì thêm)
npm run build            # kiểm tra kiểu TypeScript + build

# Chạy thêm bộ test trên PostgreSQL thật, gồm test nhiều kết nối đồng thời:
TEST_DATABASE_URL=postgres://postgres:matkhau@localhost:5432/postgres npm test
```
(Chuỗi kết nối là tài khoản superuser của một PostgreSQL cục bộ; test tự tạo và xóa database tạm.)

Bộ test bao phủ: 4 loại lắp đặt, mặc định/tùy chỉnh ống lọc, nhiều vị trí, tái sử dụng đoạn dư, cutting plan, nắp trên/dưới, thiếu vật tư, bấm đúp, tranh chấp đồng thời, quyền admin / user, rollback nguyên tử, tổng dashboard, lịch sử giao dịch, bản chụp cài đặt.

## 10. Triển khai miễn phí

### Cách A - Cloudflare Pages (khuyên dùng)
1. Đưa mã lên GitHub.
2. Cloudflare Dashboard -> **Workers & Pages -> Create -> Pages -> Connect to Git**, chọn repo.
3. Build command: `npm run build`, Output directory: `dist`.
4. **Environment variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (+ `NODE_VERSION=20`).
5. Deploy. Ứng dụng dùng hash-router (`#/`) nên không cần cấu hình rewrite.

### Cách B - GitHub Pages
1. Repo -> **Settings -> Pages -> Source: GitHub Actions**.
2. **Settings -> Secrets and variables -> Actions**: thêm `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
3. Push lên nhánh `main`: workflow `.github/workflows/deploy-pages.yml` chạy test, build và đăng.

Sau khi có địa chỉ web, vào Supabase -> **Authentication -> URL Configuration** điền địa chỉ đó vào *Site URL*.

## 11. Giới hạn của gói miễn phí và của hệ thống

- Supabase Free **tạm dừng project sau 7 ngày không có hoạt động**; vào dashboard bấm Restore là chạy lại. Dùng hằng ngày thì không bị. Nên bật sao lưu thủ công (xuất dữ liệu) định kỳ vì gói Free không có backup tự động dài hạn.
- Dung lượng Free (500 MB database) dư dùng rất nhiều cho loại dữ liệu này.
- Tạo/đặt lại tài khoản cần Edge Function (có trong gói Free). Không gửi email tự động: admin gửi mật khẩu tạm cho nhân viên.
- Không có tính năng "giữ chỗ" vật tư (cột *Reserved* luôn 0); không có module quản lý dự án, chỉ có trường tên/mã dự án tùy chọn.
- Danh sách lịch sử và sổ giao dịch hiển thị tối đa 500 dòng mới nhất mỗi lần (dùng bộ lọc để tìm cũ hơn).
- Đổi **chiều dài ống chuẩn** chỉ được khi không còn ống nguyên trong kho (tránh âm thầm đổi giá trị tồn kho). Hủy lắp đặt bị chặn nếu đoạn dư nó tạo ra đã được dùng cho công trình khác: hủy công trình sau trước.
- Chỉ lưu ngôn ngữ ưa thích của giao diện trong trình duyệt/hồ sơ; không có dữ liệu nghiệp vụ nào lưu ở localStorage.
