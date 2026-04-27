# Grok Video Batch Generator

Chrome extension tự động tạo video Grok hàng loạt từ một folder ảnh. Lần lượt đẩy từng ảnh lên grok.com (chế độ tạo video), điền prompt, chờ render xong, rồi tải video về **đúng folder ảnh** với cùng tên (ví dụ `1.png` → `1.mp4`).

## Cài đặt (Load unpacked)

1. Mở Chrome → `chrome://extensions`
2. Bật **Developer mode** (góc phải trên)
3. Click **Load unpacked** → chọn folder chứa repo này
4. Extension sẽ xuất hiện. Pin nó để dễ dùng.

> Extension không có icon riêng (Chrome dùng icon mặc định). Nếu cần icon, thêm folder `icons/` và khai báo trong `manifest.json`.

## Cách dùng

1. Mở `https://grok.com/...` ở **chế độ tạo video** (trang có ô prompt + nút "Upload or drop images") trong tab active
2. Click icon extension trên thanh công cụ → side panel mở ra
3. Bấm **Chọn folder ảnh** → chọn folder có các ảnh (`.png .jpg .jpeg .webp .bmp`). Trình duyệt sẽ xin quyền đọc/ghi.
4. Nhập **Prompt** chung. Có thể dùng biến:
   - `{filename}` → tên file ảnh (không đuôi)
   - `{index}` → thứ tự (1, 2, 3...)
5. (Tùy chọn) Mở **Cài đặt nâng cao** chỉnh:
   - **Bỏ qua ảnh đã có video**: nếu folder đã có `1.mp4` thì không xử lý lại `1.png`
   - **Timeout** mỗi video (mặc định 300s)
   - **Số lần retry** khi lỗi (mặc định 2)
   - **Delay** giữa các ảnh (chống rate limit)
   - **URL trang tạo video**: để trống = dùng URL hiện tại của tab. Sau mỗi ảnh extension sẽ navigate về URL này để reset state.
6. Bấm **Start**

## Flow xử lý mỗi ảnh

```
1. Tìm <input type="file"> trên grok → set file → trigger change
   (fallback: simulate drop event)
2. Chờ ảnh attach xong (xuất hiện chip @Image hoặc thumbnail)
3. Focus ô prompt (ProseMirror), đặt caret ở đầu, insert prompt
4. Click nút Generate (icon mũi tên lên)
5. Poll <video src="*.mp4"> xuất hiện
6. Fetch URL video → ghi vào folder ảnh dưới tên <baseName>.mp4
7. Navigate tab về URL reset → tiếp ảnh sau
```

## Giới hạn / lưu ý

- Selector của grok.com có thể thay đổi. Nếu extension không bắt được nút/ô input nào, mở `content.js` để chỉnh selector. Các điểm cần để ý:
  - `findFileInput()` — input file của grok
  - `findPromptEditor()` — ô ProseMirror
  - `findGenerateButton()` — nhận diện qua `svg path[d^="M6 11L12 5"]`
  - `findReadyVideo()` — lấy `<video>` có `src="*.mp4"`
- Quyền folder là **per-session**. Mỗi lần mở lại side panel phải chọn lại folder.
- Nếu grok hiện popup "rate limit" hoặc lỗi quota, extension sẽ retry rồi log lỗi. Tăng **delay** + giảm batch size nếu hay bị.
- Stop chỉ có hiệu lực **giữa các ảnh**, không giết được generation đang chạy.

## Cấu trúc

```
manifest.json     — MV3, sidePanel + content_script grok.com
background.js     — service worker, mở side panel
sidepanel.html    — UI chính
sidepanel.css     — style
sidepanel.js      — điều phối: chọn folder, queue, fetch video, ghi file
content.js        — chạy trên grok.com: upload, fill prompt, click generate, đọc URL video
```
