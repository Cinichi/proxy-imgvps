// 🚀 Bandwidth Hero VPS Server v4.2
// ✅ Mangabuddy full referer fix
// ✅ Auto referer discovery + retry
// ✅ Compression + in-memory cache + stats
// ✅ Works with Tachiyomi & Bandwidth Hero
// 🐳 Docker ready

const express = require('express');
const fetch = require('node-fetch');
const sharp = require('sharp');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// In-memory cache (stdTTL: 7 days, checkperiod: 1 hour)
const imageCache = new NodeCache({ stdTTL: 604800, checkperiod: 3600 });

let stats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
  startTime: new Date().toISOString()
};

// ========================
// 🔧 Smart Referer Mapping
// ========================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // 🔹 Mangabuddy numbered CDNs (auto-detect chapter)
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    return match
      ? `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`
      : "https://mangabuddy.com/";
  }

  // 🔹 Likemanga + all mirror CDNs
  if (
    host.includes("likemanga.ink") ||
    host.includes("1stkmgv1.com") ||
    host.includes("1kmgv") ||
    host.includes("like1.")
  ) {
    return "https://likemanga.ink/";
  }

  // 🔹 Backup & other manga mirrors
  const map = {
    mgcdn: "https://res.mgcdn.xyz/",
    mbbcdn: "https://res.mgcdn.xyz/",
    mangapill: "https://mangapill.com/",
    readdetectiveconan: "https://mangapill.com/",
    hentaifox: "https://hentaifox.com/",
    nhentai: "https://nhentai.net/",
  };

  for (const [key, ref] of Object.entries(map)) {
    if (host.includes(key)) return ref;
  }

  // Default fallback — use same host as referer
  return `https://${hostname}/`;
}

// ========================
// 🖼️ Image Handling
// ========================
async function handleImageRequest(req, res) {
  const startTime = Date.now();
  const targetUrl = req.query.url;
  const bw = req.query.bw === "1";
  const jpeg = req.query.jpg === "1" || req.query.jpeg === "1";
  const quality = Math.min(100, Math.max(1, parseInt(req.query.l) || 75));

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing 'url' parameter" });
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const referer = getRefererForHost(parsedTarget.hostname, targetUrl);
    
    const cacheKey = `${targetUrl}-q${quality}-${jpeg ? "jpg" : "webp"}-${bw ? "bw" : "color"}`;
    
    // Check cache
    const cached = imageCache.get(cacheKey);
    if (cached) {
      stats.requests++;
      stats.cacheHits++;
      
      res.set({
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=604800',
        'X-Cache-Status': 'HIT',
        'X-Quality': quality.toString(),
        'X-Response-Time': `${Date.now() - startTime}ms`,
        'Access-Control-Allow-Origin': '*'
      });
      return res.send(cached.buffer);
    }

    console.log(`📥 Fetching ${parsedTarget.hostname} | q=${quality}`);

    // Attempt 1: Fetch with referer
    let response = await fetch(targetUrl, {
      headers: {
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      }
    });

    // Attempt 2: Retry with fallback referer
    if (response.status === 403) {
      console.warn("🔁 Retrying with fallback referer: https://mangabuddy.com/");
      response = await fetch(targetUrl, {
        headers: {
          "Referer": "https://mangabuddy.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134 Safari/537.36",
          "Accept": "image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        }
      });
    }

    if (!response.ok) {
      console.error(`❌ Failed (${response.status}) ${targetUrl}`);
      return res.status(response.status).json({ 
        error: `Failed to fetch image (${response.status})` 
      });
    }

    const imageBuffer = await response.buffer();
    const originalSize = imageBuffer.length;

    // Process image with Sharp
    let processedImage = sharp(imageBuffer);

    if (bw) {
      processedImage = processedImage.grayscale();
    }

    const outputFormat = jpeg ? 'jpeg' : 'webp';
    processedImage = processedImage[outputFormat]({ quality });

    const outputBuffer = await processedImage.toBuffer();
    const compressedSize = outputBuffer.length;
    const bytesSaved = originalSize - compressedSize;
    
    if (bytesSaved > 0) stats.bytesSaved += bytesSaved;

    // Cache the result
    const contentType = jpeg ? 'image/jpeg' : 'image/webp';
    imageCache.set(cacheKey, { buffer: outputBuffer, contentType });

    stats.requests++;
    stats.cacheMisses++;

    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800',
      'X-Cache-Status': 'MISS',
      'X-Quality': quality.toString(),
      'X-Response-Time': `${Date.now() - startTime}ms`,
      'X-Original-Size': originalSize.toString(),
      'X-Compressed-Size': compressedSize.toString(),
      'X-Bytes-Saved': bytesSaved.toString(),
      'Access-Control-Allow-Origin': '*'
    });

    return res.send(outputBuffer);

  } catch (err) {
    console.error("❌ Error processing image:", err);
    return res.status(500).json({ 
      error: `Internal error: ${err.message}` 
    });
  }
}

// ========================
// 📍 Routes
// ========================

// CORS preflight
app.options('*', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
  });
  res.status(204).send();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Stats page
app.get('/stats', (req, res) => {
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate = stats.requests > 0 
    ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) 
    : 0;
  
  const cacheStats = imageCache.getStats();
  
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bandwidth Hero Stats</title>
  <style>
    body { font-family: sans-serif; padding: 40px; background: #f5f5f5; }
    .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; }
    .stat { display: flex; justify-content: space-between; padding: 15px 0; border-bottom: 1px solid #eee; }
    .stat:last-child { border-bottom: none; }
    .label { font-weight: 600; color: #666; }
    .value { color: #2196F3; font-weight: 700; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Bandwidth Hero v4.2 Stats</h1>
    <div class="stat"><span class="label">Total Requests:</span><span class="value">${stats.requests}</span></div>
    <div class="stat"><span class="label">Cache Hits:</span><span class="value">${stats.cacheHits} (${hitRate}%)</span></div>
    <div class="stat"><span class="label">Cache Misses:</span><span class="value">${stats.cacheMisses}</span></div>
    <div class="stat"><span class="label">Data Saved:</span><span class="value">${savedMB} MB</span></div>
    <div class="stat"><span class="label">Cached Images:</span><span class="value">${cacheStats.keys}</span></div>
    <div class="stat"><span class="label">Server Started:</span><span class="value">${stats.startTime}</span></div>
  </div>
</body>
</html>`);
});

// Reset stats
app.get('/reset', (req, res) => {
  stats = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesSaved: 0,
    startTime: new Date().toISOString()
  };
  imageCache.flushAll();
  res.send('✅ Stats and cache reset.');
});

// Web interface
app.get('/', (req, res) => {
  if (req.query.url) {
    return handleImageRequest(req, res);
  }
  
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bandwidth Hero Proxy</title>
  <style>
    body { font-family: sans-serif; padding: 40px; background: #f5f5f5; }
    .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h2 { color: #333; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
    ul { line-height: 1.8; }
    a { color: #2196F3; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h2>⚡ Bandwidth Hero Proxy v4.2</h2>
    <p><strong>Usage:</strong> <code>?url=&lt;IMAGE_URL&gt;&amp;l=75&amp;jpg=0&amp;bw=0</code></p>
    <ul>
      <li><code>url</code> - Image URL to compress (required)</li>
      <li><code>l</code> - Quality 1-100 (default: 75)</li>
      <li><code>jpg</code> or <code>jpeg</code> - Output as JPEG (default: WebP)</li>
      <li><code>bw</code> - Convert to grayscale</li>
    </ul>
    <h3>Features</h3>
    <ul>
      <li>✅ Auto referer for Mangabuddy, Mangapill, Hentaifox, NHentai</li>
      <li>✅ In-memory cache with 7-day TTL</li>
      <li>✅ Sharp image processing (WebP/JPEG)</li>
      <li>✅ CORS enabled</li>
    </ul>
    <h3>Links</h3>
    <ul>
      <li><a href="/stats">📊 View Stats</a></li>
      <li><a href="/health">❤️ Health Check</a></li>
      <li><a href="/reset">🔄 Reset Stats</a></li>
    </ul>
  </div>
</body>
</html>`);
});

// ========================
// 🚀 Start Server
// ========================
app.listen(PORT, HOST, () => {
  console.log(`🚀 Bandwidth Hero VPS Server v4.2`);
  console.log(`📡 Server running on ${HOST}:${PORT}`);
  console.log(`🌐 Visit http://localhost:${PORT} for web interface`);
  console.log(`📊 Stats available at http://localhost:${PORT}/stats`);
});
