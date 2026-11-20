# ⚡ Multi-Source Music Engine (Cloudflare Workers Edition)

Hệ thống API tìm kiếm và phát nhạc **Đa Nguồn Thông Minh** (Zing MP3 + SoundCloud + Radio VOV) được tối ưu hóa đặc biệt cho thiết bị phần cứng thông minh (**ESP32**, Loa AI XiaoZhi, Robot nhận diện giọng nói).

Phiên bản này tập trung hoàn toàn vào **chất lượng và tốc độ luồng âm thanh**, loại bỏ xử lý lời bài hát (Lyric) dư thừa, giúp thời gian phản hồi đạt mức kỷ lục **dưới 50 mili-giây**!

---

## 🌟 Vì sao chọn giải pháp Đa nguồn (Zing + SoundCloud)?

1. **Kho nhạc khổng lồ không giới hạn**: 
   - Bài hát chính thống, nhạc Việt chất lượng cao ➔ Lấy từ **Zing MP3** (MP3 128kbps CDN trong nước).
   - Nhạc Remix, Cover, Nonstop, Lofi, EDM, Vinahouse, Nhạc ngoại quốc tế US-UK/K-Pop ➔ Lấy từ **SoundCloud** (kho nhạc mở lớn nhất thế giới, không bị Google bot chặn).
   - Tin tức thời sự, giao thông ➔ Lấy trực tiếp từ đài **Radio VOV** quốc gia.
2. **Không lo bị Google chặn bot**: SoundCloud và Zing MP3 hoàn toàn mở API, không bị lỗi `Sign in to confirm you're not a bot` như YouTube.
3. **Phản hồi siêu tốc (Zero Cold Start)**: Cloudflare Workers chạy trên Data Center Viettel/VNPT ngay tại Hà Nội & TP.HCM, phát nhạc tức thì khi ESP32 gọi.
4. **Tập trung âm thanh (Không cần Lyric)**: Tối ưu payload JSON gọn gàng, ESP32 chỉ cần parse link `audio_url` là phát loa ngay.

---

## 📁 Cấu trúc thư mục

```
globy-music-cloudflare/
├── src/
│   └── index.js             # Engine đa nguồn Zing MP3 + SoundCloud + Radio VOV
├── wrangler.toml            # Cấu hình Worker
├── package.json             # Khai báo gói (Hono, Wrangler)
└── README.md                # Tài liệu hướng dẫn
```

---

## 🚀 Triển khai trong 1 phút (Wrangler CLI)

1. Mở Terminal và vào thư mục:
   ```bash
   cd globy-music-cloudflare
   ```
2. Đăng nhập Cloudflare (nếu chưa):
   ```bash
   npx wrangler login
   ```
3. Triển khai:
   ```bash
   npx wrangler deploy
   ```
Sau khi hoàn tất, bạn nhận được link công khai dạng:
`https://globy-music-api.<tên-tài-khoản>.workers.dev`

---

## 📡 API Endpoints cho ESP32

### 1. Endpoint tìm kiếm & phát nhạc
* **URL:** `GET /stream_pcm?song={tên_bài_hát}`
* **Cơ chế tìm kiếm tự động thông minh:**
  - Nếu query có các từ khóa: `remix`, `cover`, `lofi`, `dj`, `vinahouse`, `nonstop` ➔ Tự động ưu tiên tìm trên **SoundCloud**.
  - Các bài hát khác ➔ Tìm trên **Zing MP3** trước, nếu không có sẽ tự động nhảy sang **SoundCloud**.
  - Bạn cũng có thể ép nguồn bằng tiền tố:
    - `sc:tên_bài`: Ép tìm trên SoundCloud (VD: `/stream_pcm?song=sc:cat+doi+noi+sau+remix`).
    - `zing:tên_bài`: Ép tìm trên Zing MP3.
    - `vov1`, `vov-gt`: Phát đài VOV tương ứng.

* **Payload JSON trả về cho ESP32 (Rất gọn, không lyric):**
  ```json
  {
    "title": "Cắt Đôi Nỗi Sầu Remix",
    "artist": "T&C",
    "audio_url": "/proxy_audio?id=...&source=soundcloud",
    "thumbnail": "https://i1.sndcdn.com/...",
    "duration": 287,
    "source": "soundcloud"
  }
  ```

### 2. Endpoint luồng âm thanh
* **URL:** `GET /proxy_audio?id={id}&source={zing|soundcloud|radio}`
* **Cơ chế:** Worker trả về **HTTP 302 Found** chuyển hướng trực tiếp tới CDN của Zing MP3, SoundCloud hoặc Icecast VOV. ESP32 kết nối thẳng đến CDN để phát âm thanh mà không tốn tài nguyên server.

---

## 🤖 Code C++ nạp ESP32 (Arduino IDE)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "Audio.h" // Thư viện ESP32-audioI2S

const char* WORKER_BASE = "https://your-worker.workers.dev";
Audio audio;

void playMusic(String songQuery) {
  HTTPClient http;
  String url = String(WORKER_BASE) + "/stream_pcm?song=" + urlEncode(songQuery);
  
  http.begin(url);
  int httpCode = http.GET();
  
  if (httpCode == 200) {
    String payload = http.getString();
    DynamicJsonDocument doc(1024);
    deserializeJson(doc, payload);
    
    String audioUrl = String(WORKER_BASE) + doc["audio_url"].as<String>();
    Serial.println("Đang phát: " + doc["title"].as<String>() + " (" + doc["source"].as<String>() + ")");
    
    // Thư viện ESP32-audioI2S hỗ trợ cả MP3 và HLS m3u8 (SoundCloud/Radio)
    audio.connecttohost(audioUrl.c_str());
  } else {
    Serial.println("Không tìm thấy bài hát!");
  }
  http.end();
}
```
