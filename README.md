
## Điều khiển bằng RPC

Plugin expose các RPC (gọi được từ app client hoặc script dùng `@getpaseo/client`):

| Method | Input | Chức năng |
| --- | --- | --- |
| `opencode-go-pool.status` | `{}` | Xem trạng thái keys (mask), cooldown, pins, config |
| `opencode-go-pool.pin` | `{ agentId, key }` | **Switch account thủ công**: gán agent vào 1 key (full key hoặc mask `oc_s…1TCD`). session_open sẽ tôn trọng pin thay vì LRU, log có cờ `[pinned]` |
| `opencode-go-pool.unpin` | `{ agentId }` | Bỏ pin, trả agent về LRU tự động |
| `opencode-go-pool.simulate-failure` | `{ agentId, kind: "window"\|"auth" }` | Chạy đúng đường auto-switch (cool key → reload agent) — dùng để test mà không cần chờ gateway từ chối |

Lưu ý: `agentId` là **id đầy đủ** (lấy từ `paseo agent ls --json`), không phải 8 ký tự đầu.
