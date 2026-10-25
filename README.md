# opencode-go-pool

Plugin Paseo: **pool key OpenCode Go/Zen cấp provider** — mọi agent chạy trên provider được phủ
đều dùng key từ pool dùng chung, hết quota/bị từ chối thì tự xoay sang key còn khỏe. Không cần
gán account cho từng agent như ZeroSub.

## Kiến trúc

```
Agent (session_open / agent.create)
   │  before-hook
   ▼
opencode-go-pool ── chọn key (LRU, bỏ key đang cooldown, tôn trọng pin)
   │
   ├─ OpenCode family → inject OPENCODE_AUTH_CONTENT (merge auth.json gốc)
   └─ Pi family       → inject PI_CODING_AGENT_DIR → per-key home (symlink + merged auth.json)
```

## Tương thích Pi Agent

Pi không có env kiểu auth-content — nó đọc key từ `<agent-dir>/auth.json` và tôn trọng env
`PI_CODING_AGENT_DIR` (chuyển toàn bộ agent dir). Pool xử lý bằng **per-key home**:

- Mỗi key một home tại `~/.paseo/opencode-go-pool/pi-homes/<hash-key>/`: mọi entry của
  `~/.pi/agent` (models.json, extensions, sessions, settings…) được **symlink** về bản thật —
  cấu hình, lịch sử dùng chung — riêng `auth.json` là file merge (key pool thắng cho
  `opencode-go`, các provider khác của bạn giữ nguyên).
- Race-free: mỗi agent chạy trên home riêng của key nó đang dùng.

Nhận diện family theo token provider id: token `pi` → pi, token `opencode` → opencode (không
match substring để tránh dính "copilot"). List `providers` trong config thắng khi không rỗng.

## Cài đặt

```bash
git clone https://github.com/luongndcoder/opencode-go-pool.git
cd opencode-go-pool && npm install && npm run typecheck && npm test
paseo plugin install "$(pwd)"        # hoặc thêm entry directory-source vào config.json
```

Cấu hình `~/.paseo/opencode-go-pool/config.json` (đọc lại mỗi hook, không cần restart):

```json
{
  "keys": ["oc_sk_...", "oc_sk_..."],
  "providers": ["pi", "slp-pi-builder", "slp-opencode-builder", "be-opencode-worker"],
  "autoRetry": true,
  "strict": false
}
```

- `providers` rỗng = phủ mọi provider id có token `opencode` hoặc `pi`.
- `strict: true` chỉ inject duy nhất pool key (không merge auth gốc) — dùng để test.

## Auto-switch

Turn fail với lỗi `429/rate limit/quota` → key cooldown **1 giờ**; `401/403/invalid key/
entitlement/subscription` → cooldown **24 giờ**. Sau đó plugin reload agent (`paseo agent
reload`) → session mới tự nhận key kế tiếp. State nằm ở
`~/.paseo/opencode-go-pool/state.json` (chmod 600).

## Điều khiển bằng RPC

| Method | Input | Chức năng |
| --- | --- | --- |
| `opencode-go-pool.status` | `{}` | Trạng thái keys (mask), cooldown, pins, config |
| `opencode-go-pool.pin` | `{ agentId, key }` | **Switch thủ công**: gán agent vào 1 key (full key hoặc mask `oc_s…1TCD`); session_open tôn trọng pin, log có cờ `[pinned]` |
| `opencode-go-pool.unpin` | `{ agentId }` | Bỏ pin, trả agent về LRU |
| `opencode-go-pool.simulate-failure` | `{ agentId, kind: "window"\|"auth" }` | Chạy đúng đường auto-switch (cool → reload) để test không cần chờ gateway từ chối |

`agentId` là **id đầy đủ** (từ `paseo agent ls --json`).

## Kiểm chứng đã chạy (2026-10-25/26)

- 15 unit test: LRU, cooldown window/auth, pin override, persistence, pi-home symlink + merge.
- E2E auto-switch: `simulate-failure` → key 1TCD cooling → agent reload → nhảy sang key Z6J6.
- E2E manual switch: pin → session_open log `[pinned]` → unpin → về LRU.
- E2E Pi: agent `pi` (model `opencode-go/kimi-k3`) nhận `PI_CODING_AGENT_DIR` per-key home,
  turn thành công qua pool.
