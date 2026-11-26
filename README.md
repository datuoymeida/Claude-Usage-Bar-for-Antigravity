# Claude Usage Bar

Thanh trạng thái (góc phải dưới) của Antigravity / VS Code hiện % hạn mức Claude Code của tài khoản đang
dùng — cùng số với bảng **Account & Usage** — và cho chuyển giữa nhiều tài khoản Claude Code.

## Dùng
- **Bấm ô trạng thái**: danh sách tài khoản kèm hạn mức từng cái (tuần, theo model, giờ reset). Chọn một
  tài khoản để chuyển sang; tài khoản chưa đăng nhập thì chọn để đăng nhập.
- **Thêm tài khoản…**: đặt tên gợi nhớ → terminal chạy `claude auth login` mở trình duyệt. Trình duyệt đang
  đăng nhập claude.ai bằng tài khoản khác thì đổi tài khoản trên claude.ai trước (hoặc cửa sổ ẩn danh:
  bấm `c` trong terminal để chép link).
- **Rê chuột**: hạn mức của mọi tài khoản. Từ 80% ô vàng, từ 95% ô đỏ. Tự làm mới mỗi 5 phút.
- Sau khi chuyển: phiên chat đang mở vẫn dùng tài khoản cũ → bấm **Tải lại cửa sổ** khi được hỏi.

## Cách hoạt động
- Mỗi tài khoản một thư mục cấu hình (`CLAUDE_CONFIG_DIR`) — cách Claude Code hướng dẫn cho nhiều tài
  khoản (https://code.claude.com/docs/en/authentication): đăng nhập và mục Keychain riêng. Mặc định là
  `~/.claude`; tài khoản thêm vào ở `~/.claude-accounts/<tên>` (sổ tài khoản: `~/.claude-accounts/accounts.json`).
- Lịch sử chat, memory, `CLAUDE.md`, `settings.json`, skills, plugins… **dùng chung** qua symlink tới
  `~/.claude`; MCP và thiết lập theo dự án chép từ `~/.claude.json` lúc tạo.
- Chuyển tài khoản = đặt `CLAUDE_CONFIG_DIR` trong cài đặt `claudeCode.environmentVariables` của extension
  Claude Code, và trong `terminal.integrated.env` (tắt bằng `claudeUsage.switchTerminal`).
- Hạn mức: chạy `claude -p` (stream-json) gửi yêu cầu điều khiển `get_usage` — không gửi prompt nên không
  tốn hạn mức; tắt hook và MCP cho lần chạy này; không đọc token. `get_usage` là API thử nghiệm của Claude
  Code: bản sau có thể đổi, khi đó ô hiện `?` kèm lỗi trong tooltip.
- Gỡ tài khoản: đăng xuất đúng thư mục đó (kiểm tra `configDirectory` trước khi `claude auth logout`),
  bỏ khỏi sổ; thư mục giữ lại để xoá tay.

Chỉ dùng cho các tài khoản của chính mình — Claude Code dành cho người mua gói, dùng cá nhân.

## Cài đặt
Chọn một trong hai cách để có file `.vsix`:

1. **Tải bản dựng sẵn**: [dist/claude-usage-bar-0.2.1.vsix](dist/claude-usage-bar-0.2.1.vsix)
   (mở link → nút **Download raw file**).
2. **Tự build từ mã nguồn** (chỉ cần Python 3, không cần Node/npm):
   ```bash
   git clone https://github.com/datuoymeida/Claude-Usage-Bar-for-Antigravity.git
   cd Claude-Usage-Bar-for-Antigravity
   python3 build.py        # → dist/claude-usage-bar-<version>.vsix
   ```

Rồi cài file đó:
- Trong Antigravity / VS Code / Cursor: tab Extensions → `···` → **Install from VSIX…** → chọn file.
- Hoặc dòng lệnh: `antigravity-ide --install-extension dist/claude-usage-bar-<version>.vsix`
  (VS Code: `code --install-extension …`, Cursor: `cursor --install-extension …`; trên macOS lệnh
  `antigravity-ide` nằm ở `/Applications/Antigravity IDE.app/Contents/Resources/app/bin/`).

Sau đó **Developer: Reload Window**. Máy đó cần có Claude Code (CLI hoặc extension Claude Code). Tài khoản
**không** đi theo file — mỗi máy đăng nhập lại bằng "Thêm tài khoản…". Windows: thư mục dùng chung bằng
junction; `CLAUDE.md` / `settings.json` chỉ dùng chung khi bật Developer Mode.

## Phát hành bản mới
Sửa mã → tăng `version` trong `package.json` → `python3 build.py` → xoá bản `.vsix` cũ trong `dist/`, sửa
link ở mục Cài đặt → commit cả mã lẫn file `.vsix` mới.
