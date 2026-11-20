import { Hono } from "hono";
import { cors } from "hono/cors";
import crypto from "node:crypto";

const app = new Hono();
app.use("*", cors());

// ============================================================
// 1. ZING MP3 ENGINE (v1.22.4)
// ============================================================
const Z_API_KEY = "X5BM3w8N7MKozC0B85o4KMlzLZKhV00y";
const Z_SECRET_KEY = "acOrvUS15XRW2o9JksiK1KgQ6Vbds8ZW";
const Z_VERSION = "1.22.4";
const Z_BASE = "https://zingmp3.vn";
const SIGNED_KEYS = ["ctime", "id", "type", "page", "count", "version"];

let cachedZingCookie = "";
let zingCookieTimestamp = 0;

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function hmac512(str, key) {
  return crypto.createHmac("sha512", key).update(Buffer.from(str, "utf8")).digest("hex");
}

function createZingSig(path, params) {
  const sorted = {};
  Object.keys(params).sort().forEach(k => { sorted[k] = params[k]; });

  const filtered = [];
  for (const k in sorted) {
    if (SIGNED_KEYS.includes(k) && sorted[k] !== null && sorted[k] !== undefined && sorted[k] !== "") {
      filtered[k] = sorted[k];
    }
  }

  const hashParam = Object.keys(filtered)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(filtered[k])}`)
    .join("");

  return hmac512(path + sha256("" + hashParam), Z_SECRET_KEY);
}

async function getZingCookie() {
  const now = Date.now();
  if (cachedZingCookie && now - zingCookieTimestamp < 10 * 60 * 1000) {
    return cachedZingCookie;
  }
  try {
    const res = await fetch(Z_BASE, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const setCookie = res.headers.get("set-cookie") || "";
    if (setCookie) {
      cachedZingCookie = setCookie.split(";")[0];
      zingCookieTimestamp = now;
    }
    return cachedZingCookie;
  } catch {
    return cachedZingCookie || "";
  }
}

async function requestZing(apiPath, queryParams = {}) {
  const cookie = await getZingCookie();
  const ctime = Math.floor(Date.now() / 1000);
  const signedParams = { ...queryParams, ctime, version: Z_VERSION };
  const sig = createZingSig(apiPath, signedParams);

  const urlParams = new URLSearchParams({
    ...queryParams,
    ctime: ctime.toString(),
    version: Z_VERSION,
    apiKey: Z_API_KEY,
    sig,
  });

  const res = await fetch(`${Z_BASE}${apiPath}?${urlParams.toString()}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Cookie: cookie,
      Referer: "https://zingmp3.vn/",
    },
  });

  return await res.json();
}

async function searchZingSong(query) {
  try {
    const data = await requestZing("/api/v2/search/multi", { q: query });
    if (data.err === 0 && data.data?.songs?.length > 0) {
      const s = data.data.songs[0];
      return {
        id: s.encodeId,
        title: s.title || query,
        artist: s.artistsNames || (s.artists && s.artists[0]?.name) || "Nhiều ca sĩ",
        thumbnail: s.thumbnailM || s.thumbnail || "",
        duration: s.duration || 0,
        source: "zing",
      };
    }
  } catch (err) {
    console.error("Zing search error:", err);
  }
  return null;
}

async function getZingAudioUrl(songId) {
  try {
    const data = await requestZing("/api/v2/song/get/streaming", { id: songId });
    if (data.err === 0 && data.data) {
      return (
        data.data["128"] ||
        (data.data.streaming && data.data.streaming["128"]) ||
        `https://api.mp3.zing.vn/api/streaming/audio/${songId}/128`
      );
    }
  } catch (err) {
    console.error("Zing audio error:", err);
  }
  return `https://api.mp3.zing.vn/api/streaming/audio/${songId}/128`;
}

// ============================================================
// 2. SOUNDCLOUD ENGINE (Kho nhạc Remix, Cover, Nonstop, Quốc tế)
// ============================================================
let cachedSCClientId = "Me902VCqB1VmYOCc7W9v0XM17WgIHGSL";
let scClientTimestamp = 0;

async function getSoundCloudClientId() {
  const now = Date.now();
  if (cachedSCClientId && now - scClientTimestamp < 24 * 60 * 60 * 1000) {
    return cachedSCClientId;
  }
  try {
    const html = await fetch("https://soundcloud.com").then(r => r.text());
    const urls = html.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\"]+\.js/g) || [];
    for (const u of urls.slice(-4)) {
      const code = await fetch(u).then(r => r.text());
      const m = code.match(/client_id[:=]"([a-zA-Z0-9]{32})"/);
      if (m) {
        cachedSCClientId = m[1];
        scClientTimestamp = now;
        return cachedSCClientId;
      }
    }
  } catch {}
  return cachedSCClientId || "Me902VCqB1VmYOCc7W9v0XM17WgIHGSL";
}

async function searchSoundCloud(query) {
  try {
    const clientId = await getSoundCloudClientId();
    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=3`;
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const track = data.collection?.[0];
    if (track) {
      // Ưu tiên progressive (MP3) trước, nếu không có thì lấy HLS (AAC)
      const trans =
        track.media?.transcodings?.find(t => t.format?.protocol === "progressive") ||
        track.media?.transcodings?.[0];

      if (trans) {
        return {
          id: encodeURIComponent(trans.url),
          title: track.title,
          artist: track.user?.username || "SoundCloud Artist",
          thumbnail: track.artwork_url || track.user?.avatar_url || "",
          duration: Math.floor((track.duration || 0) / 1000),
          source: "soundcloud",
        };
      }
    }
  } catch (err) {
    console.error("SoundCloud search error:", err);
  }
  return null;
}

async function getSoundCloudAudioUrl(transcodingUrl) {
  try {
    const clientId = await getSoundCloudClientId();
    const targetUrl = `${decodeURIComponent(transcodingUrl)}?client_id=${clientId}`;
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (res.ok) {
      const data = await res.json();
      return data.url;
    }
  } catch (err) {
    console.error("SoundCloud audio error:", err);
  }
  return null;
}

// ============================================================
// 3. RADIO VOV
// ============================================================
const RADIOS = {
  vov1: {
    key: "vov1",
    name: "VOV1 - Thời sự",
    aliases: ["vov1", "vov 1", "vov-1", "thoi su", "tin tuc"],
    streamUrl: "http://media.kythuatvov.vn:7001/;stream/",
    thumb: "https://vov.vn/themes/custom/vov/logo.svg",
  },
  vov2: {
    key: "vov2",
    name: "VOV2 - Văn hóa Xã hội",
    aliases: ["vov2", "vov 2", "vov-2", "van hoa"],
    streamUrl: "http://media.kythuatvov.vn:7003/;stream/",
    thumb: "https://vov.vn/themes/custom/vov/logo.svg",
  },
  vov3: {
    key: "vov3",
    name: "VOV3 - Âm nhạc Giải trí",
    aliases: ["vov3", "vov 3", "vov-3", "am nhac"],
    streamUrl: "http://media.kythuatvov.vn:7005/;stream/",
    thumb: "https://vov.vn/themes/custom/vov/logo.svg",
  },
  vov5: {
    key: "vov5",
    name: "VOV5 - Phát thanh Đối ngoại",
    aliases: ["vov5", "vov 5", "vov-5", "doi ngoai"],
    streamUrl: "https://str.vov.gov.vn/vovlive/vov5.sdp_aac/playlist.m3u8",
    thumb: "https://vov.vn/themes/custom/vov/logo.svg",
  },
  "vov-gt": {
    key: "vov-gt",
    name: "VOV Giao Thông Hà Nội",
    aliases: ["vov giao thong", "vovgt", "giao thong ha noi", "giao thong hn", "vov-gt"],
    streamUrl: "https://str.vov.gov.vn/vovlive/vovgt-hn.sdp_aac/playlist.m3u8",
    thumb: "https://vov.vn/themes/custom/vov/logo.svg",
  },
  "vov-gt-hcm": {
    key: "vov-gt-hcm",
    name: "VOV Giao Thông TP.HCM",
    aliases: ["vov giao thong hcm", "vovgt hcm", "giao thong sai gon", "giao thong hcm", "vov-gt-hcm"],
    streamUrl: "https://str.vov.gov.vn/vovlive/vovgt-hcm.sdp_aac/playlist.m3u8",
    thumb: "https://vov.vn/themes/custom/vov/logo.svg",
  },
};

function normalizeText(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchRadio(query) {
  const norm = normalizeText(query);
  if (!norm) return null;
  for (const radio of Object.values(RADIOS)) {
    if (radio.aliases.some(alias => norm.includes(normalizeText(alias)))) {
      return radio;
    }
  }
  if (norm.includes("radio") || norm.includes("dai tieng noi") || norm.includes("phat thanh")) {
    return RADIOS.vov1;
  }
  return null;
}

// ============================================================
// 4. API CHO ESP32 (TẬP TRUNG ÂM THANH - KHÔNG CẦN LYRIC)
// ============================================================

// 4.1) /stream_pcm?song=... (Tìm kiếm đa nguồn thông minh)
app.get("/stream_pcm", async (c) => {
  let q = (c.req.query("song") || "").trim();
  if (!q) {
    return c.json({ error: "Missing song query" }, 400);
  }

  // 1. Kiểm tra Radio VOV
  const radio = matchRadio(q);
  if (radio) {
    return c.json({
      title: radio.name,
      artist: "VOV Radio Quốc Gia",
      audio_url: `/proxy_audio?id=${radio.key}&source=radio`,
      thumbnail: radio.thumb,
      duration: 0,
      source: "radio",
    });
  }

  // 2. Kiểm tra chỉ định tiền tố nguồn:
  // "sc:tên_bài" -> ép SoundCloud
  // "zing:tên_bài" -> ép Zing
  let forcedSource = "";
  if (q.toLowerCase().startsWith("sc:") || q.toLowerCase().startsWith("soundcloud:")) {
    forcedSource = "soundcloud";
    q = q.replace(/^soundcloud:|^sc:/i, "").trim();
  } else if (q.toLowerCase().startsWith("zing:")) {
    forcedSource = "zing";
    q = q.replace(/^zing:/i, "").trim();
  }

  // 3. Nhận diện từ khóa remix, cover, dj, lofi -> Ưu tiên SoundCloud
  const isRemixOrCover = /remix|cover|lofi|nonstop|dj|mashup|slowed|bassboost|vinahouse/i.test(q);

  let songResult = null;

  if (forcedSource === "soundcloud" || (isRemixOrCover && forcedSource !== "zing")) {
    // Thử SoundCloud trước cho nhạc remix/cover
    songResult = await searchSoundCloud(q);
    if (!songResult && forcedSource !== "soundcloud") {
      songResult = await searchZingSong(q);
    }
  } else if (forcedSource === "zing") {
    songResult = await searchZingSong(q);
  } else {
    // Mặc định: Zing MP3 trước -> nếu không thấy thì tự động sang SoundCloud
    songResult = await searchZingSong(q);
    if (!songResult) {
      songResult = await searchSoundCloud(q);
    }
  }

  if (songResult) {
    return c.json({
      title: songResult.title,
      artist: songResult.artist,
      audio_url: `/proxy_audio?id=${songResult.id}&source=${songResult.source}`,
      thumbnail: songResult.thumbnail,
      duration: songResult.duration,
      source: songResult.source,
    });
  }

  return c.json({ error: "Not found", message: `Không tìm thấy bài hát: ${q}` }, 404);
});

// 4.2) /proxy_audio?id=...&source=...
// Trả về HTTP 302 chuyển hướng trực tiếp đến CDN máy chủ nhanh nhất
app.get("/proxy_audio", async (c) => {
  const id = c.req.query("id");
  const source = c.req.query("source") || "zing";
  const mode = c.req.query("mode");

  if (!id) return c.text("Missing id", 400);

  let directUrl = "";

  if (source === "radio" || RADIOS[id]) {
    const radio = RADIOS[id] || RADIOS.vov1;
    directUrl = radio.streamUrl;
  } else if (source === "soundcloud") {
    directUrl = await getSoundCloudAudioUrl(id);
  } else {
    directUrl = await getZingAudioUrl(id);
  }

  if (!directUrl) return c.text("Audio stream not found", 404);

  // Mặc định 302 Redirect (0s delay, không tốn ram/cpu của worker)
  if (mode !== "stream") {
    return c.redirect(directUrl, 302);
  }

  // Stream proxy nếu cần
  const streamRes = await fetch(directUrl);
  return new Response(streamRes.body, {
    headers: {
      "Content-Type": streamRes.headers.get("content-type") || "audio/mpeg",
      "Cache-Control": "no-cache",
    },
  });
});

// Aliases cho firmware ESP32 cũ
app.get("/audio/:id", (c) => {
  const id = c.req.param("id");
  const source = c.req.query("source") || "zing";
  return c.redirect(`/proxy_audio?id=${encodeURIComponent(id)}&source=${source}`, 302);
});

app.get("/radio/play", (c) => {
  const id = c.req.query("id") || "vov1";
  return c.redirect(`/proxy_audio?id=${encodeURIComponent(id)}&source=radio`, 302);
});

// Endpoint lyric giữ lại trả rỗng để firmware cũ không bị crash nếu có gọi
app.get(["/proxy_lyric", "/dynamic_lyric"], (c) => c.text(""));

// Healthcheck
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    platform: "Cloudflare Workers (Edge)",
    engine: "Multi-Source Audio Engine (Zing + SoundCloud + Radio)",
    sources: ["zing", "soundcloud", "radio"],
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// 5. GIAO DIỆN WEB PLAYGROUND TRỰC QUAN (KHÔNG CẦN LYRIC)
// ============================================================
app.get("/", (c) => {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Multi-Source Music API - Cloudflare Edge</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #090d16; --card: rgba(22, 30, 49, 0.85); --primary: #38bdf8; --zing: #8b5cf6; --sc: #f97316; --radio: #10b981; --text: #f8fafc; --muted: #94a3b8; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: radial-gradient(circle at 50% 0%, #1e1b4b 0%, var(--bg) 75%); color: var(--text); min-height: 100vh; padding: 30px 20px; display: flex; flex-direction: column; align-items: center; }
    .container { max-width: 800px; width: 100%; }
    header { text-align: center; margin-bottom: 28px; }
    .badge-bar { display: flex; justify-content: center; gap: 8px; margin-bottom: 12px; }
    .badge { padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .badge-zing { background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid rgba(139, 92, 246, 0.4); }
    .badge-sc { background: rgba(249, 115, 22, 0.2); color: #fb923c; border: 1px solid rgba(249, 115, 22, 0.4); }
    .badge-radio { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    h1 { font-size: 30px; font-weight: 800; margin-bottom: 6px; }
    p.sub { color: var(--muted); font-size: 14px; }
    .card { background: var(--card); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 18px; padding: 22px; margin-bottom: 20px; box-shadow: 0 15px 35px rgba(0,0,0,0.4); }
    .search-row { display: flex; gap: 10px; margin-bottom: 14px; }
    input { flex: 1; padding: 13px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); background: #0f172a; color: #fff; font-size: 15px; outline: none; }
    input:focus { border-color: var(--primary); }
    button.btn-search { padding: 13px 22px; background: var(--primary); color: #041324; border: none; border-radius: 10px; font-weight: 700; cursor: pointer; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .chip { padding: 5px 11px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; font-size: 12px; cursor: pointer; }
    .chip:hover { border-color: var(--primary); color: var(--primary); }
    .result { display: none; }
    .song-hdr { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
    .song-thumb { width: 70px; height: 70px; border-radius: 10px; object-fit: cover; background: #1e293b; }
    audio { width: 100%; margin-bottom: 16px; }
    pre { background: #020617; padding: 14px; border-radius: 10px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #38bdf8; max-height: 200px; overflow: auto; white-space: pre-wrap; }
    .loader { display: none; text-align: center; padding: 15px; color: var(--primary); font-weight: 600; }
  </style>
</head>
<body>
<div class="container">
  <header>
    <div class="badge-bar">
      <span class="badge badge-zing">Zing MP3</span>
      <span class="badge badge-sc">SoundCloud Remix</span>
      <span class="badge badge-radio">Radio VOV</span>
    </div>
    <h1>Multi-Source Music Engine</h1>
    <p class="sub">Kho nhạc khổng lồ đa nguồn - Tối ưu siêu tốc cho ESP32</p>
  </header>

  <div class="card">
    <div class="search-row">
      <input type="text" id="songInput" placeholder="Nhập tên bài hát (VD: Cắt đôi nỗi sầu remix, See tình, Lofi...)">
      <button class="btn-search" onclick="search()">Tìm & Phát</button>
    </div>
    <div class="chips">
      <span style="font-size: 13px; color: var(--muted);">Thử nhanh:</span>
      <span class="chip" onclick="quick('Cắt đôi nỗi sầu')">Cắt đôi nỗi sầu (Zing)</span>
      <span class="chip" onclick="quick('Cắt đôi nỗi sầu remix')">Cắt đôi nỗi sầu (Remix SC)</span>
      <span class="chip" onclick="quick('sc:Sơn Tùng MTP')">Sơn Tùng (SoundCloud)</span>
      <span class="chip" onclick="quick('vov1')">VOV1 Thời sự</span>
      <span class="chip" onclick="quick('vov-gt')">VOV Giao thông</span>
    </div>
  </div>

  <div id="loader" class="loader">⏳ Đang tìm kiếm bài hát trên Edge Server...</div>

  <div id="resView" class="card result">
    <div class="song-hdr">
      <img id="thumb" class="song-thumb" src="" alt="Thumbnail">
      <div>
        <h3 id="title">Tên bài hát</h3>
        <p id="artist" style="color: var(--muted); font-size: 14px; margin-top: 3px;">Nghệ sĩ</p>
        <span id="sourceBadge" class="badge" style="margin-top: 6px; display: inline-block;">Nguồn</span>
      </div>
    </div>
    <audio id="player" controls autoplay></audio>
    <p style="font-size: 13px; font-weight: 700; margin-bottom: 6px;">JSON trả về cho ESP32 (Không cần lyric):</p>
    <pre id="json"></pre>
  </div>
</div>

<script>
  async function search() {
    const q = document.getElementById('songInput').value.trim();
    if (!q) return;
    const l = document.getElementById('loader'), r = document.getElementById('resView');
    l.style.display = 'block'; r.style.display = 'none';

    try {
      const res = await fetch('/stream_pcm?song=' + encodeURIComponent(q));
      const data = await res.json();
      if (data.error) { alert(data.message || data.error); l.style.display = 'none'; return; }
      document.getElementById('title').innerText = data.title;
      document.getElementById('artist').innerText = data.artist;
      document.getElementById('thumb').src = data.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150';
      document.getElementById('player').src = data.audio_url;
      document.getElementById('json').innerText = JSON.stringify(data, null, 2);

      const b = document.getElementById('sourceBadge');
      b.className = 'badge ' + (data.source === 'zing' ? 'badge-zing' : (data.source === 'soundcloud' ? 'badge-sc' : 'badge-radio'));
      b.innerText = 'Nguồn: ' + data.source.toUpperCase();

      l.style.display = 'none'; r.style.display = 'block';
    } catch (e) {
      alert('Lỗi: ' + e.message); l.style.display = 'none';
    }
  }
  function quick(k) { document.getElementById('songInput').value = k; search(); }
  document.getElementById('songInput').addEventListener('keypress', e => { if (e.key === 'Enter') search(); });
</script>
</body>
</html>`;
  return c.html(html);
});

export default app;
