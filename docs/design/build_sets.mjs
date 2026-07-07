import fs from 'fs';
const DIR = process.argv[2];
const r6 = n => Math.round(n * 1e6) / 1e6;
function roadClass(hw) {
  if (/^(motorway|trunk)(_link)?$/.test(hw)) return 4;
  if (/^(primary)(_link)?$/.test(hw)) return 3;
  if (/^(secondary|tertiary)(_link)?$/.test(hw)) return 2;
  if (/^(residential|living_street|unclassified|road)$/.test(hw)) return 1;
  return 0;
}

// stitch a multipolygon relation's outer member ways into closed rings
function stitchRings(members) {
  const outers = (members || []).filter(m => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === '' || m.role == null));
  const segs = outers.map(m => m.geometry.map(p => [p.lat, p.lon]));
  const used = new Array(segs.length).fill(false);
  const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  const rings = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let ring = segs[i].slice();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < segs.length + 2) {
      const tail = key(ring[ring.length - 1]);
      let found = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const s = segs[j];
        if (key(s[0]) === tail) { ring = ring.concat(s.slice(1)); used[j] = true; found = true; break; }
        if (key(s[s.length - 1]) === tail) { ring = ring.concat(s.slice().reverse().slice(1)); used[j] = true; found = true; break; }
      }
      if (!found) break;
    }
    if (ring.length >= 4) rings.push(ring.map(p => [r6(p[0]), r6(p[1])]));
  }
  return rings;
}

function transform(raw) {
  const ways = [];
  for (const el of raw.elements) {
    const t = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const g = el.geometry.map(p => [r6(p.lat), r6(p.lon)]);
      if (t.highway) ways.push({ k: 's', c: roadClass(t.highway), nm: t.name || '', g, n: el.nodes });
      else if (t.leisure === 'park') ways.push({ k: 'p', nm: t.name || '', g });
      else if (t.natural === 'water' || t.waterway === 'riverbank' || t.water) ways.push({ k: 'w', g });
      else if (t.natural === 'coastline') ways.push({ k: 'c', g });
      else if (t.waterway) ways.push({ k: 'r', g });
    } else if (el.type === 'relation' && t.natural === 'water') {
      for (const rg of stitchRings(el.members)) ways.push({ k: 'w', g: rg });
    }
  }
  return ways;
}

const AREAS = [
  { name: 'caphill', bbox: [47.6130, -122.3300, 47.6420, -122.3070], raw: 'osm_raw.json' },
  { name: 'union',   bbox: [47.6100, -122.3450, 47.6450, -122.3250] },
  { name: 'greenlk', bbox: [47.6720, -122.3430, 47.6890, -122.3230] },
  { name: 'core',    bbox: [47.6078, -122.3420, 47.6140, -122.3320] },
];

const UA = 'streetCryptid-mockup/1.0 (design mockup)';
const EP = 'https://overpass-api.de/api/interpreter';
function ql([S, W, N, E]) {
  const b = `${S},${W},${N},${E}`;
  return `[out:json][timeout:120];(` +
    `way["highway"](${b});` +
    `way["leisure"="park"](${b});` +
    `way["natural"="water"](${b});` +
    `rel["natural"="water"](${b});` +
    `way["natural"="coastline"](${b});` +
    `way["waterway"](${b});` +
    `);out body geom;`;
}

async function fetchArea(a) {
  if (a.raw && fs.existsSync(`${DIR}/${a.raw}`)) return JSON.parse(fs.readFileSync(`${DIR}/${a.raw}`, 'utf8'));
  const cache = `${DIR}/raw_${a.name}.json`;
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const body = 'data=' + encodeURIComponent(ql(a.bbox));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(EP, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (res.ok) { const j = await res.json(); fs.writeFileSync(cache, JSON.stringify(j)); return j; }
      console.log('  attempt', attempt, a.name, 'status', res.status);
    } catch (e) { console.log('  attempt', attempt, a.name, 'err', e.message); }
    await new Promise(r => setTimeout(r, 7000 * (attempt + 1)));
  }
  throw new Error('fetch failed ' + a.name);
}

const SETS = {};
for (const a of AREAS) {
  const raw = await fetchArea(a);
  const ways = transform(raw);
  SETS[a.name] = { bbox: a.bbox, ways };
  const counts = ways.reduce((o, w) => (o[w.k] = (o[w.k] || 0) + 1, o), {});
  console.log(a.name.padEnd(9), 'ways', String(ways.length).padEnd(6), JSON.stringify(counts));
  await new Promise(r => setTimeout(r, 4000));
}
fs.writeFileSync(`${DIR}/mapdata.js`, 'window.OSMSETS=' + JSON.stringify(SETS) + ';');
console.log('wrote mapdata.js', Math.round(fs.statSync(`${DIR}/mapdata.js`).size / 1024) + 'kb');
