// ============================================================
//  Album-Pixel-Proxy  (Node 18+)
//  Aufgabe: 1) Alben suchen   2) Cover -> Farbraster mit Nummern
//
//  Warum nötig? Roblox kann keine Internet-Bilder in Pixel zerlegen.
//  Dieser Server macht das und liefert reines JSON zurueck.
//
//  Endpunkte:
//    GET /search?q=abba
//        -> [ {id, name, artist, artwork}, ... ]
//    GET /pixels?id=<deezerAlbumId>&size=50&colors=20
//        -> { size, palette:[{n,r,g,b}], grid:[[n,...],...] }
//
//  Deployen: Render.com / Railway / Replit / eigener VPS.
//  Lokal testen:  npm install  &&  npm start
// ============================================================

import express from "express";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Suche ueber die kostenlose Deezer-API (kein Login noetig) ----
async function deezerSearch(q) {
  const url = "https://api.deezer.com/search/album?q=" + encodeURIComponent(q) + "&limit=25";
  const r = await fetch(url);
  const j = await r.json();
  return (j.data || []).map(a => ({
    id: a.id,
    name: a.title,
    artist: (a.artist && a.artist.name) || "",
    artwork: a.cover_medium || a.cover_big
  }));
}

async function deezerCover(id) {
  const r = await fetch("https://api.deezer.com/album/" + encodeURIComponent(id));
  const j = await r.json();
  return j.cover_xl || j.cover_big || j.cover_medium;
}

// ---- Einfaches k-means fuer die Farb-/Nummern-Palette ----
function quantize(pixels, k, iters = 10) {
  const n = pixels.length;
  const centers = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(i * (n - 1) / Math.max(1, k - 1));
    centers.push(pixels[idx].slice());
  }
  const assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      const p = pixels[i];
      for (let c = 0; c < k; c++) {
        const dr = p[0] - centers[c][0], dg = p[1] - centers[c][1], db = p[2] - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const c = assign[i], p = pixels[i];
      sum[c][0] += p[0]; sum[c][1] += p[1]; sum[c][2] += p[2]; sum[c][3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sum[c][3] > 0) {
        centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
      }
    }
  }
  return { centers: centers.map(c => c.map(v => Math.round(v))), assign };
}

app.get("/", (_req, res) => res.send("Album-Pixel-Proxy laeuft. /search?q=  und  /pixels?id="));

app.get("/search", async (req, res) => {
  try {
    res.json(await deezerSearch(req.query.q || ""));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/pixels", async (req, res) => {
  try {
    const size = Math.min(64, Math.max(8, parseInt(req.query.size) || 50));
    const colors = Math.min(40, Math.max(2, parseInt(req.query.colors) || 20));

    let url = req.query.cover;
    if (!url && req.query.id) url = await deezerCover(req.query.id);
    if (!url) return res.status(400).json({ error: "kein Cover gefunden" });

    const imgResp = await fetch(url);
    const buf = Buffer.from(await imgResp.arrayBuffer());

    // Auf size x size verkleinern, Alpha weg, rohe RGB-Werte lesen
    const { data } = await sharp(buf)
      .resize(size, size, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const px = [];
    for (let i = 0; i < data.length; i += 3) px.push([data[i], data[i + 1], data[i + 2]]);

    const { centers, assign } = quantize(px, colors);

    const grid = [];
    for (let y = 0; y < size; y++) {
      const row = [];
      for (let x = 0; x < size; x++) row.push(assign[y * size + x] + 1); // 1-basiert = Nummer
      grid.push(row);
    }
    const palette = centers.map((c, i) => ({ n: i + 1, r: c[0], g: c[1], b: c[2] }));

    res.json({ size, palette, grid });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log("Album-Pixel-Proxy laeuft auf Port " + PORT));
