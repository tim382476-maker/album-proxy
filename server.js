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
    artwork: a.cover_big || a.cover_xl || a.cover_medium
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

// Fasst zu aehnliche Farben zusammen -> nur klar unterscheidbare Nummern bleiben.
// minDist: je groesser, desto weniger (deutlichere) Farben. ~42 ist ein guter Wert.
function mergePalette(centers, assign, minDist) {
  const k = centers.length;
  const map = new Array(k);
  const newCenters = [];
  for (let c = 0; c < k; c++) {
    let target = -1;
    for (let j = 0; j < newCenters.length; j++) {
      const dr = centers[c][0] - newCenters[j][0];
      const dg = centers[c][1] - newCenters[j][1];
      const db = centers[c][2] - newCenters[j][2];
      if (dr * dr + dg * dg + db * db < minDist * minDist) { target = j; break; }
    }
    if (target >= 0) {
      map[c] = target;
    } else {
      map[c] = newCenters.length;
      newCenters.push(centers[c].slice());
    }
  }
  const newAssign = new Array(assign.length);
  for (let i = 0; i < assign.length; i++) newAssign[i] = map[assign[i]];
  return { centers: newCenters, assign: newAssign };
}

// Baut ein kleines Farb-Vorschaubild (pw x pw) aus einer Cover-URL
async function coverPreview(url, pw) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  const { data } = await sharp(buf)
    .resize(pw, pw, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const cells = [];
  for (let i = 0; i < data.length; i += 3) cells.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  return { w: pw, h: pw, cells };
}

app.get("/", (_req, res) => res.send("Album-Pixel-Proxy laeuft. /search?q=  und  /pixels?id="));

app.get("/search", async (req, res) => {
  try {
    let list = await deezerSearch(req.query.q || "");

    // Optional: kleine Vorschaubilder mitliefern (?preview=1)
    if (req.query.preview) {
      const pw = Math.min(32, Math.max(6, parseInt(req.query.pw) || 24));
      list = list.slice(0, 18);
      await Promise.all(list.map(async (a) => {
        try {
          if (a.artwork) a.preview = await coverPreview(a.artwork, pw);
        } catch (_) { /* ohne Vorschau weiter */ }
      }));
    }

    res.json(list);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/pixels", async (req, res) => {
  try {
    const size = Math.min(128, Math.max(8, parseInt(req.query.size) || 50));
    const colors = Math.min(48, Math.max(2, parseInt(req.query.colors) || 20));

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

    const q = quantize(px, colors);
    const merged = mergePalette(q.centers, q.assign, 15);
    const centers = merged.centers;
    const assign = merged.assign;

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
