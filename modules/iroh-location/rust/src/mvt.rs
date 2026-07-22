//! Native Mapbox Vector Tile decoder for the map's tile pipeline.
//!
//! A faithful Rust port of `src/features/map/tiles/mvt-mapping.ts` (+ the SCB1
//! bundle unpack in `tile-bundle.ts`): raw MVT protobuf in, one flat little-endian
//! buffer of world-space geometry out. It exists to move the per-tile protobuf
//! parse, UTF-8 decode, coordinate transform, AND the object materialization off
//! the JS/Hermes thread — the JS decoder allocated ~4.6M coordinate tuples per
//! z13 bundle on the UI thread.
//!
//! Pure and dependency-free (no iroh/BLE), so `cargo test` exercises it on any host.
//!
//! ## Coordinate precision
//! World space is normalized Web Mercator ([0,1]² at z0). Storing absolute world
//! coords as f32 loses ~0.1px at z14 and worsens under overzoom, so every
//! coordinate is emitted as an **f32 delta from a per-decode f64 origin** (the
//! bundle anchor tile's min corner, or a lone tile's min corner). Deltas stay
//! < ~1e-3, where f32 has ~6e-11 resolution — sub-pixel at any zoom. JS adds the
//! f64 origin back when projecting.
//!
//! ## Output buffer layout (SCG1, little-endian — consumed by PackedGeometry in JS)
//! All multi-byte scalars little-endian (native on ARM/x86 → JS wraps coord pools
//! as Float32Array zero-copy). Every section is padded to a 4-byte boundary so the
//! f32 coordinate pools are aligned. Header stores the f64 origin (read via
//! DataView, so 8-byte alignment is not required).
//!
//! ```text
//! magic       u32   "SCG1" = 0x31474353
//! originX     f64
//! originY     f64
//! -- streets (stroked polylines) --
//!   count u32, totalPoints u32
//!   roadClass[count]  u8   (0..4)          (pad→4)
//!   nameRef[count]    i32  (-1 = none)
//!   pointOff[count+1] u32  (prefix sums into coords)
//!   coords[2*totalPoints] f32  (dx,dy)
//! -- rivers (stroked polylines) --  count u32, totalPoints u32, pointOff[count+1] u32, coords f32
//! -- water (even-odd fills) --  areas section (see below)
//! -- parks (even-odd fills) --  areas section
//! -- places --  count u32, nameRef[count] i32, kindRef[count] i32, rank[count] i32 (-1 absent),
//!               x[count] f32, y[count] f32
//! -- string table --  count u32, then per string: len u32 + utf8 bytes (pad→4 after each)
//! ```
//! An "areas section" (rings grouped per feature): count u32, totalRings u32,
//! totalPoints u32, nameRef[count] i32, ringOff[count+1] u32, pointOff[totalRings+1]
//! u32, coords[2*totalPoints] f32.

// ---------------------------------------------------------------------------
// Minimal protobuf wire reader (no external deps).
// ---------------------------------------------------------------------------

struct PbReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> PbReader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn eof(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn read_varint(&mut self) -> u64 {
        let mut result: u64 = 0;
        let mut shift = 0;
        while self.pos < self.buf.len() && shift < 64 {
            let b = self.buf[self.pos];
            self.pos += 1;
            result |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        result
    }

    /// zigzag-decoded signed varint (used by MVT geometry parameters).
    fn read_svarint(&mut self) -> i64 {
        let v = self.read_varint();
        ((v >> 1) as i64) ^ -((v & 1) as i64)
    }

    fn read_bytes(&mut self) -> &'a [u8] {
        let len = self.read_varint() as usize;
        let end = (self.pos + len).min(self.buf.len());
        let out = &self.buf[self.pos..end];
        self.pos = end;
        out
    }

    fn read_string(&mut self) -> String {
        String::from_utf8_lossy(self.read_bytes()).into_owned()
    }

    /// Skip one field's payload given its wire type. Returns false on malformed input.
    fn skip(&mut self, wire: u64) -> bool {
        match wire {
            0 => {
                self.read_varint();
                true
            }
            1 => {
                self.pos = (self.pos + 8).min(self.buf.len());
                true
            }
            2 => {
                let len = self.read_varint() as usize;
                self.pos = (self.pos + len).min(self.buf.len());
                true
            }
            5 => {
                self.pos = (self.pos + 4).min(self.buf.len());
                true
            }
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// MVT value + geometry model
// ---------------------------------------------------------------------------

const GEOM_LINE: u64 = 2;
const GEOM_POLYGON: u64 = 3;
const DEFAULT_EXTENT: u32 = 4096;

enum Value {
    Str(String),
    Num(f64),
    Bool(bool),
    None,
}

impl Value {
    fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    fn as_num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }
}

/// OMT `transportation.class` → the mock's 0–4 road class; non-ground classes → None.
/// Mirrors `roadClassOf` in mvt-mapping.ts exactly.
fn road_class_of(class: &str) -> Option<u8> {
    match class {
        "motorway" | "trunk" => Some(4),
        "primary" => Some(3),
        "secondary" | "tertiary" => Some(2),
        "minor" | "busway" => Some(1),
        "service" | "track" | "path" | "raceway" => Some(0),
        _ => None,
    }
}

fn is_park_landcover(class: &str) -> bool {
    matches!(class, "grass" | "wood")
}
fn is_park_landuse(class: &str) -> bool {
    matches!(
        class,
        "cemetery" | "grass" | "recreation_ground" | "stadium" | "pitch"
    )
}

// ---------------------------------------------------------------------------
// Decoded domain geometry (world-space f32 deltas from `origin`)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Geometry {
    streets: Vec<Street>,
    rivers: Vec<Line>,
    water: Vec<Area>,
    parks: Vec<Area>,
    places: Vec<Place>,
    strings: Interner,
}

struct Street {
    road_class: u8,
    name: i32,
    points: Vec<[f32; 2]>,
}
struct Line {
    points: Vec<[f32; 2]>,
}
struct Area {
    name: i32,
    rings: Vec<Vec<[f32; 2]>>,
}
struct Place {
    name: i32,
    kind: i32,
    rank: i32,
    pos: [f32; 2],
}

/// De-duplicating UTF-8 string table; feature name/kind fields store an index (-1 = none).
#[derive(Default)]
struct Interner {
    list: Vec<String>,
    index: std::collections::HashMap<String, u32>,
}
impl Interner {
    fn intern(&mut self, s: &str) -> i32 {
        if let Some(&i) = self.index.get(s) {
            return i as i32;
        }
        let i = self.list.len() as u32;
        self.list.push(s.to_string());
        self.index.insert(s.to_string(), i);
        i as i32
    }
}

/// Projection from tile-extent coordinates into world-space f32 deltas from `origin`.
#[derive(Clone, Copy)]
struct Proj {
    min_x: f64,
    min_y: f64,
    span: f64,
    extent: f64,
    origin_x: f64,
    origin_y: f64,
}
impl Proj {
    fn point(&self, px: i32, py: i32) -> [f32; 2] {
        let wx = self.min_x + (px as f64 / self.extent) * self.span;
        let wy = self.min_y + (py as f64 / self.extent) * self.span;
        [(wx - self.origin_x) as f32, (wy - self.origin_y) as f32]
    }
}

/// World rect min corner + span for a tile (mirrors tileWorldRect).
fn tile_min(z: u32, x: u32, y: u32) -> (f64, f64, f64) {
    let span = 1.0 / (1u64 << z) as f64;
    (x as f64 * span, y as f64 * span, span)
}

// ---------------------------------------------------------------------------
// Geometry command decode (MoveTo=1, LineTo=2, ClosePath=7)
// ---------------------------------------------------------------------------

/// Decode a feature's packed geometry into rings/lines of absolute tile coords,
/// projected to world deltas. Each MoveTo starts a new ring/line (mirrors
/// `loadGeometry()` returning an array of rings).
fn decode_geometry(cmds: &[u32], proj: &Proj) -> Vec<Vec<[f32; 2]>> {
    let mut rings: Vec<Vec<[f32; 2]>> = Vec::new();
    let mut cur: Vec<[f32; 2]> = Vec::new();
    let (mut x, mut y) = (0i32, 0i32);
    let mut i = 0usize;
    while i < cmds.len() {
        let cmd = cmds[i];
        i += 1;
        let id = cmd & 0x7;
        let count = (cmd >> 3) as usize;
        match id {
            1 => {
                // MoveTo: each starts a new ring/line
                for _ in 0..count {
                    if i + 1 >= cmds.len() {
                        break;
                    }
                    x += zigzag(cmds[i]);
                    y += zigzag(cmds[i + 1]);
                    i += 2;
                    if !cur.is_empty() {
                        rings.push(std::mem::take(&mut cur));
                    }
                    cur.push(proj.point(x, y));
                }
            }
            2 => {
                // LineTo
                for _ in 0..count {
                    if i + 1 >= cmds.len() {
                        break;
                    }
                    x += zigzag(cmds[i]);
                    y += zigzag(cmds[i + 1]);
                    i += 2;
                    cur.push(proj.point(x, y));
                }
            }
            7 => {
                // ClosePath: @mapbox/vector-tile appends a copy of the ring's first
                // point (mapnik-vector-tile #90 workaround). Mirror it so polygon
                // point counts match the JS decoder exactly.
                for _ in 0..count {
                    if let Some(&first) = cur.first() {
                        cur.push(first);
                    }
                }
            }
            _ => break,
        }
    }
    if !cur.is_empty() {
        rings.push(cur);
    }
    rings
}

fn zigzag(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

// ---------------------------------------------------------------------------
// Layer / feature decode
// ---------------------------------------------------------------------------

struct RawFeature {
    geom_type: u64,
    tags: Vec<u32>,
    geometry: Vec<u32>,
}

/// One decoded layer: name plus its keys/values tables and features (still in
/// tile-extent geometry). Only layers the map cares about are fully retained.
struct Layer {
    name: String,
    extent: u32,
    keys: Vec<String>,
    values: Vec<Value>,
    features: Vec<RawFeature>,
}

fn read_value(pb: &mut PbReader) -> Value {
    let mut v = Value::None;
    let bytes = pb.read_bytes();
    let mut r = PbReader::new(bytes);
    while !r.eof() {
        let tag = r.read_varint();
        let field = tag >> 3;
        let wire = tag & 0x7;
        match field {
            1 => v = Value::Str(r.read_string()),
            2 => {
                // float (fixed32)
                let b = read_fixed32(&mut r);
                v = Value::Num(f32::from_bits(b) as f64);
            }
            3 => {
                let b = read_fixed64(&mut r);
                v = Value::Num(f64::from_bits(b));
            }
            4 => v = Value::Num(r.read_varint() as i64 as f64), // int64
            5 => v = Value::Num(r.read_varint() as f64),        // uint64
            6 => v = Value::Num(r.read_svarint() as f64),       // sint64
            7 => v = Value::Bool(r.read_varint() != 0),
            _ => {
                if !r.skip(wire) {
                    break;
                }
            }
        }
    }
    let _ = &v; // bool handled below via as_* (only str/num used downstream)
    match v {
        Value::Bool(b) => Value::Num(if b { 1.0 } else { 0.0 }),
        other => other,
    }
}

fn read_fixed32(r: &mut PbReader) -> u32 {
    let mut out = 0u32;
    for k in 0..4 {
        let b = if r.pos < r.buf.len() { r.buf[r.pos] } else { 0 };
        r.pos += 1;
        out |= (b as u32) << (8 * k);
    }
    out
}
fn read_fixed64(r: &mut PbReader) -> u64 {
    let mut out = 0u64;
    for k in 0..8 {
        let b = if r.pos < r.buf.len() { r.buf[r.pos] } else { 0 };
        r.pos += 1;
        out |= (b as u64) << (8 * k);
    }
    out
}

fn read_packed_u32(pb: &mut PbReader) -> Vec<u32> {
    let bytes = pb.read_bytes();
    let mut r = PbReader::new(bytes);
    let mut out = Vec::new();
    while !r.eof() {
        out.push(r.read_varint() as u32);
    }
    out
}

fn decode_layer(bytes: &[u8]) -> Layer {
    let mut pb = PbReader::new(bytes);
    let mut layer = Layer {
        name: String::new(),
        extent: DEFAULT_EXTENT,
        keys: Vec::new(),
        values: Vec::new(),
        features: Vec::new(),
    };
    while !pb.eof() {
        let tag = pb.read_varint();
        let field = tag >> 3;
        let wire = tag & 0x7;
        match field {
            15 => {
                pb.read_varint();
            } // version
            1 => layer.name = pb.read_string(),
            5 => layer.extent = pb.read_varint() as u32,
            3 => layer.keys.push(pb.read_string()),
            4 => layer.values.push(read_value(&mut pb)),
            2 => {
                let fbytes = pb.read_bytes();
                layer.features.push(decode_feature(fbytes));
            }
            _ => {
                if !pb.skip(wire) {
                    break;
                }
            }
        }
    }
    layer
}

fn decode_feature(bytes: &[u8]) -> RawFeature {
    let mut pb = PbReader::new(bytes);
    let mut f = RawFeature {
        geom_type: 0,
        tags: Vec::new(),
        geometry: Vec::new(),
    };
    while !pb.eof() {
        let tag = pb.read_varint();
        let field = tag >> 3;
        let wire = tag & 0x7;
        match field {
            1 => {
                pb.read_varint();
            } // id
            2 => f.tags = read_packed_u32(&mut pb),
            3 => f.geom_type = pb.read_varint(),
            4 => f.geometry = read_packed_u32(&mut pb),
            _ => {
                if !pb.skip(wire) {
                    break;
                }
            }
        }
    }
    f
}

impl Layer {
    /// Look up a feature property value by key name via its tag pairs.
    fn prop<'b>(&'b self, f: &RawFeature, key: &str) -> Option<&'b Value> {
        let mut i = 0;
        while i + 1 < f.tags.len() {
            let k = f.tags[i] as usize;
            let v = f.tags[i + 1] as usize;
            i += 2;
            if self.keys.get(k).map(|s| s.as_str()) == Some(key) {
                return self.values.get(v);
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Tile decode: extract the map's layers into world-space Geometry
// ---------------------------------------------------------------------------

/// Decode one MVT tile into `geo`, projecting to world deltas from `origin`.
/// Mirrors `decodeMvtTile` layer/feature selection exactly.
fn decode_tile_into(bytes: &[u8], z: u32, x: u32, y: u32, origin: (f64, f64), geo: &mut Geometry) {
    let (min_x, min_y, span) = tile_min(z, x, y);
    // Two passes are avoided: decode layers we care about as we meet them.
    let mut pb = PbReader::new(bytes);
    while !pb.eof() {
        let tag = pb.read_varint();
        let field = tag >> 3;
        let wire = tag & 0x7;
        if field == 3 && wire == 2 {
            let lbytes = pb.read_bytes();
            let layer = decode_layer(lbytes);
            let proj = Proj {
                min_x,
                min_y,
                span,
                extent: layer.extent as f64,
                origin_x: origin.0,
                origin_y: origin.1,
            };
            ingest_layer(&layer, &proj, geo);
        } else if !pb.skip(wire) {
            break;
        }
    }
}

fn ingest_layer(layer: &Layer, proj: &Proj, geo: &mut Geometry) {
    match layer.name.as_str() {
        "transportation" => {
            for f in &layer.features {
                if f.geom_type != GEOM_LINE {
                    continue;
                }
                let class = layer.prop(f, "class").and_then(|v| v.as_str()).unwrap_or("");
                let Some(rc) = road_class_of(class) else {
                    continue;
                };
                let name = layer
                    .prop(f, "name")
                    .and_then(|v| v.as_str())
                    .map(|s| geo.strings.intern(s))
                    .unwrap_or(-1);
                for line in decode_geometry(&f.geometry, proj) {
                    if line.len() >= 2 {
                        geo.streets.push(Street {
                            road_class: rc,
                            name,
                            points: line,
                        });
                    }
                }
            }
        }
        "waterway" => {
            for f in &layer.features {
                if f.geom_type != GEOM_LINE {
                    continue;
                }
                for line in decode_geometry(&f.geometry, proj) {
                    if line.len() >= 2 {
                        geo.rivers.push(Line { points: line });
                    }
                }
            }
        }
        "water" => {
            for f in &layer.features {
                if f.geom_type != GEOM_POLYGON {
                    continue;
                }
                let rings = decode_geometry(&f.geometry, proj);
                if !rings.is_empty() {
                    geo.water.push(Area { name: -1, rings });
                }
            }
        }
        "park" => {
            for f in &layer.features {
                if f.geom_type == GEOM_POLYGON {
                    push_park(layer, f, proj, geo);
                }
            }
        }
        "landcover" => {
            for f in &layer.features {
                if f.geom_type == GEOM_POLYGON {
                    let class = layer.prop(f, "class").and_then(|v| v.as_str()).unwrap_or("");
                    if is_park_landcover(class) {
                        push_park(layer, f, proj, geo);
                    }
                }
            }
        }
        "landuse" => {
            for f in &layer.features {
                if f.geom_type == GEOM_POLYGON {
                    let class = layer.prop(f, "class").and_then(|v| v.as_str()).unwrap_or("");
                    if is_park_landuse(class) {
                        push_park(layer, f, proj, geo);
                    }
                }
            }
        }
        "place" => {
            for f in &layer.features {
                let Some(name) = layer.prop(f, "name").and_then(|v| v.as_str()) else {
                    continue;
                };
                if name.is_empty() {
                    continue;
                }
                let rings = decode_geometry(&f.geometry, proj);
                let Some(first) = rings.first().and_then(|r| r.first()) else {
                    continue;
                };
                let name_ref = geo.strings.intern(name);
                let kind = layer.prop(f, "class").and_then(|v| v.as_str()).unwrap_or("");
                let kind_ref = geo.strings.intern(kind);
                let rank = layer
                    .prop(f, "rank")
                    .and_then(|v| v.as_num())
                    .map(|n| n as i32)
                    .unwrap_or(-1);
                geo.places.push(Place {
                    name: name_ref,
                    kind: kind_ref,
                    rank,
                    pos: *first,
                });
            }
        }
        _ => {}
    }
}

fn push_park(layer: &Layer, f: &RawFeature, proj: &Proj, geo: &mut Geometry) {
    let rings = decode_geometry(&f.geometry, proj);
    if rings.is_empty() {
        return;
    }
    let name = layer
        .prop(f, "name")
        .and_then(|v| v.as_str())
        .map(|s| geo.strings.intern(s))
        .unwrap_or(-1);
    geo.parks.push(Area { name, rings });
}

// ---------------------------------------------------------------------------
// SCB1 bundle unpack (mirrors decodeTileBundle; big-endian header per tile-bundle.ts)
// ---------------------------------------------------------------------------

const SCB1_MAGIC: [u8; 4] = [0x53, 0x43, 0x42, 0x31]; // "SCB1"
const SCB1_HEADER: usize = 20;
const EMPTY_TILE: u32 = 0xffff_ffff;

fn be_u32(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// (z, x, y) of each bundle member, row-major (y outer, x inner) — mirrors bundleTiles().
fn bundle_tiles(anchor_z: u32, anchor_x: u32, anchor_y: u32, tile_z: u32) -> Vec<(u32, u32, u32)> {
    let d = tile_z - anchor_z;
    let side = 1u32 << d;
    let x0 = anchor_x << d;
    let y0 = anchor_y << d;
    let mut out = Vec::with_capacity((side * side) as usize);
    for yy in y0..y0 + side {
        for xx in x0..x0 + side {
            out.push((tile_z, xx, yy));
        }
    }
    out
}

/// Parse an SCB1 bundle and decode every member tile into one Geometry, with all
/// coordinates relative to the anchor tile's world origin.
fn decode_bundle_geometry(bundle: &[u8]) -> Result<Geometry, String> {
    if bundle.len() < SCB1_HEADER || bundle[0..4] != SCB1_MAGIC {
        return Err("bad SCB1 header".into());
    }
    let anchor_z = bundle[5] as u32;
    let tile_z = bundle[6] as u32;
    let anchor_x = be_u32(bundle, 8);
    let anchor_y = be_u32(bundle, 12);
    let entry_count = be_u32(bundle, 16) as usize;

    let (ox, oy, _) = tile_min(anchor_z, anchor_x, anchor_y);
    let origin = (ox, oy);

    let tiles = bundle_tiles(anchor_z, anchor_x, anchor_y, tile_z);
    if entry_count != tiles.len() {
        return Err("bundle entry count mismatch".into());
    }

    let mut geo = Geometry::default();
    let mut off = SCB1_HEADER;
    for (z, x, y) in tiles {
        if off + 4 > bundle.len() {
            return Err("bundle truncated".into());
        }
        let len = be_u32(bundle, off);
        off += 4;
        if len == EMPTY_TILE {
            continue;
        }
        let len = len as usize;
        if off + len > bundle.len() {
            return Err("bundle entry exceeds length".into());
        }
        decode_tile_into(&bundle[off..off + len], z, x, y, origin, &mut geo);
        off += len;
    }
    Ok(geo)
}

// ---------------------------------------------------------------------------
// Flat SCG1 encoder
// ---------------------------------------------------------------------------

const SCG1_MAGIC: u32 = 0x3147_4353; // "SCG1" little-endian

struct Writer {
    buf: Vec<u8>,
}
impl Writer {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }
    fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn align4(&mut self) {
        while self.buf.len() % 4 != 0 {
            self.buf.push(0);
        }
    }
}

fn encode(geo: &Geometry, origin: (f64, f64)) -> Vec<u8> {
    let mut w = Writer::new();
    w.u32(SCG1_MAGIC);
    w.align4();
    w.f64(origin.0);
    w.f64(origin.1);

    // streets ----------------------------------------------------------------
    let total_pts: u32 = geo.streets.iter().map(|s| s.points.len() as u32).sum();
    w.u32(geo.streets.len() as u32);
    w.u32(total_pts);
    for s in &geo.streets {
        w.u8(s.road_class);
    }
    w.align4();
    for s in &geo.streets {
        w.i32(s.name);
    }
    let mut acc = 0u32;
    for s in &geo.streets {
        w.u32(acc);
        acc += s.points.len() as u32;
    }
    w.u32(acc); // count+1
    w.align4();
    for s in &geo.streets {
        for p in &s.points {
            w.f32(p[0]);
            w.f32(p[1]);
        }
    }

    // rivers -----------------------------------------------------------------
    write_lines(&mut w, &geo.rivers);

    // water + parks (areas) --------------------------------------------------
    write_areas(&mut w, &geo.water);
    write_areas(&mut w, &geo.parks);

    // places -----------------------------------------------------------------
    w.u32(geo.places.len() as u32);
    for p in &geo.places {
        w.i32(p.name);
    }
    for p in &geo.places {
        w.i32(p.kind);
    }
    for p in &geo.places {
        w.i32(p.rank);
    }
    w.align4();
    for p in &geo.places {
        w.f32(p.pos[0]);
    }
    for p in &geo.places {
        w.f32(p.pos[1]);
    }

    // string table -----------------------------------------------------------
    w.align4();
    w.u32(geo.strings.list.len() as u32);
    for s in &geo.strings.list {
        let b = s.as_bytes();
        w.u32(b.len() as u32);
        w.buf.extend_from_slice(b);
        w.align4();
    }

    w.buf
}

fn write_lines(w: &mut Writer, lines: &[Line]) {
    let total_pts: u32 = lines.iter().map(|l| l.points.len() as u32).sum();
    w.u32(lines.len() as u32);
    w.u32(total_pts);
    let mut acc = 0u32;
    for l in lines {
        w.u32(acc);
        acc += l.points.len() as u32;
    }
    w.u32(acc);
    w.align4();
    for l in lines {
        for p in &l.points {
            w.f32(p[0]);
            w.f32(p[1]);
        }
    }
}

fn write_areas(w: &mut Writer, areas: &[Area]) {
    let total_rings: u32 = areas.iter().map(|a| a.rings.len() as u32).sum();
    let total_pts: u32 = areas
        .iter()
        .flat_map(|a| a.rings.iter())
        .map(|r| r.len() as u32)
        .sum();
    w.u32(areas.len() as u32);
    w.u32(total_rings);
    w.u32(total_pts);
    for a in areas {
        w.i32(a.name);
    }
    // ring offsets (which rings belong to feature i)
    let mut racc = 0u32;
    for a in areas {
        w.u32(racc);
        racc += a.rings.len() as u32;
    }
    w.u32(racc);
    // point offsets (which points belong to ring j)
    let mut pacc = 0u32;
    for a in areas {
        for r in &a.rings {
            w.u32(pacc);
            pacc += r.len() as u32;
        }
    }
    w.u32(pacc);
    w.align4();
    for a in areas {
        for r in &a.rings {
            for p in r {
                w.f32(p[0]);
                w.f32(p[1]);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry points (Phase B wraps these with #[uniffi::export])
// ---------------------------------------------------------------------------

/// Decode an SCB1 privacy bundle into a flat SCG1 geometry buffer.
pub fn decode_bundle(bundle: &[u8]) -> Result<Vec<u8>, String> {
    let (ox, oy, _) = {
        // origin recomputed inside decode for tiles; encode needs it too.
        if bundle.len() >= SCB1_HEADER && bundle[0..4] == SCB1_MAGIC {
            let az = bundle[5] as u32;
            let ax = be_u32(bundle, 8);
            let ay = be_u32(bundle, 12);
            tile_min(az, ax, ay)
        } else {
            (0.0, 0.0, 0.0)
        }
    };
    let geo = decode_bundle_geometry(bundle)?;
    Ok(encode(&geo, (ox, oy)))
}

/// Decode one coarse XYZ tile (z ≤ anchor) into a flat SCG1 geometry buffer.
pub fn decode_tile(bytes: &[u8], z: u32, x: u32, y: u32) -> Vec<u8> {
    let (ox, oy, _) = tile_min(z, x, y);
    let mut geo = Geometry::default();
    decode_tile_into(bytes, z, x, y, (ox, oy), &mut geo);
    encode(&geo, (ox, oy))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- minimal MVT tile builder (for deterministic, JS-free tests) ----
    fn pbf_varint(out: &mut Vec<u8>, mut v: u64) {
        loop {
            let mut b = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                b |= 0x80;
            }
            out.push(b);
            if v == 0 {
                break;
            }
        }
    }
    fn key(field: u64, wire: u64) -> u64 {
        (field << 3) | wire
    }
    fn tagged_bytes(out: &mut Vec<u8>, field: u64, bytes: &[u8]) {
        pbf_varint(out, key(field, 2));
        pbf_varint(out, bytes.len() as u64);
        out.extend_from_slice(bytes);
    }
    fn tagged_varint(out: &mut Vec<u8>, field: u64, v: u64) {
        pbf_varint(out, key(field, 0));
        pbf_varint(out, v);
    }
    fn zz(v: i32) -> u32 {
        ((v << 1) ^ (v >> 31)) as u32
    }
    fn geom_moveline(pts: &[(i32, i32)], close: bool) -> Vec<u8> {
        // single MoveTo + LineTo run
        let mut cmds: Vec<u32> = Vec::new();
        let (mut cx, mut cy) = (0i32, 0i32);
        cmds.push((1 << 3) | 1); // MoveTo count 1
        cmds.push(zz(pts[0].0 - cx));
        cmds.push(zz(pts[0].1 - cy));
        cx = pts[0].0;
        cy = pts[0].1;
        if pts.len() > 1 {
            cmds.push(((pts.len() as u32 - 1) << 3) | 2); // LineTo
            for p in &pts[1..] {
                cmds.push(zz(p.0 - cx));
                cmds.push(zz(p.1 - cy));
                cx = p.0;
                cy = p.1;
            }
        }
        if close {
            cmds.push((1 << 3) | 7);
        }
        let mut out = Vec::new();
        for c in cmds {
            pbf_varint(&mut out, c as u64);
        }
        out
    }
    fn value_str(s: &str) -> Vec<u8> {
        let mut v = Vec::new();
        tagged_bytes(&mut v, 1, s.as_bytes());
        v
    }
    fn value_uint(n: u64) -> Vec<u8> {
        let mut v = Vec::new();
        tagged_varint(&mut v, 5, n);
        v
    }

    /// Build a one-layer tile with a set of features. Each feature: (geom_type, tags, geometry).
    fn build_layer(name: &str, keys: &[&str], values: &[Vec<u8>], feats: &[(u64, Vec<u32>, Vec<u32>)]) -> Vec<u8> {
        let mut layer = Vec::new();
        tagged_varint(&mut layer, 15, 2); // version
        tagged_bytes(&mut layer, 1, name.as_bytes());
        tagged_varint(&mut layer, 5, 4096); // extent
        for k in keys {
            tagged_bytes(&mut layer, 3, k.as_bytes());
        }
        for v in values {
            tagged_bytes(&mut layer, 4, v);
        }
        for (gt, tags, geom) in feats {
            let mut feat = Vec::new();
            // tags packed
            let mut tagbytes = Vec::new();
            for t in tags {
                pbf_varint(&mut tagbytes, *t as u64);
            }
            tagged_bytes(&mut feat, 2, &tagbytes);
            tagged_varint(&mut feat, 3, *gt);
            let mut gbytes = Vec::new();
            for c in geom {
                pbf_varint(&mut gbytes, *c as u64);
            }
            tagged_bytes(&mut feat, 4, &gbytes);
            tagged_bytes(&mut layer, 2, &feat);
        }
        let mut tile = Vec::new();
        tagged_bytes(&mut tile, 3, &layer);
        tile
    }

    fn geom_cmds(pts: &[(i32, i32)], close: bool) -> Vec<u32> {
        let bytes = geom_moveline(pts, close);
        let mut r = PbReader::new(&bytes);
        let mut out = Vec::new();
        while !r.eof() {
            out.push(r.read_varint() as u32);
        }
        out
    }

    #[test]
    fn road_class_mapping_matches_ts() {
        assert_eq!(road_class_of("motorway"), Some(4));
        assert_eq!(road_class_of("trunk"), Some(4));
        assert_eq!(road_class_of("primary"), Some(3));
        assert_eq!(road_class_of("secondary"), Some(2));
        assert_eq!(road_class_of("tertiary"), Some(2));
        assert_eq!(road_class_of("minor"), Some(1));
        assert_eq!(road_class_of("service"), Some(0));
        assert_eq!(road_class_of("rail"), None);
        assert_eq!(road_class_of("ferry"), None);
    }

    #[test]
    fn decodes_transportation_line_with_class_and_name() {
        // keys: class(0), name(1); values: "primary"(0), "Main St"(1)
        let layer = build_layer(
            "transportation",
            &["class", "name"],
            &[value_str("primary"), value_str("Main St")],
            &[(GEOM_LINE, vec![0, 0, 1, 1], geom_cmds(&[(0, 0), (100, 200)], false))],
        );
        let mut geo = Geometry::default();
        let o = tile_min(14, 100, 200);
        decode_tile_into(&layer, 14, 100, 200, (o.0, o.1), &mut geo);
        assert_eq!(geo.streets.len(), 1);
        assert_eq!(geo.streets[0].road_class, 3);
        assert_eq!(geo.streets[0].points.len(), 2);
        let name_idx = geo.streets[0].name;
        assert!(name_idx >= 0);
        assert_eq!(geo.strings.list[name_idx as usize], "Main St");
    }

    #[test]
    fn skips_non_ground_transportation_and_short_lines() {
        let layer = build_layer(
            "transportation",
            &["class"],
            &[value_str("rail")],
            &[(GEOM_LINE, vec![0, 0], geom_cmds(&[(0, 0), (10, 10)], false))],
        );
        let mut geo = Geometry::default();
        let o = tile_min(14, 0, 0);
        decode_tile_into(&layer, 14, 0, 0, (o.0, o.1), &mut geo);
        assert_eq!(geo.streets.len(), 0);
    }

    #[test]
    fn decodes_water_polygon_and_place_point() {
        let water = build_layer(
            "water",
            &[],
            &[],
            &[(GEOM_POLYGON, vec![], geom_cmds(&[(0, 0), (100, 0), (100, 100), (0, 100)], true))],
        );
        let mut geo = Geometry::default();
        let o = tile_min(10, 5, 6);
        decode_tile_into(&water, 10, 5, 6, (o.0, o.1), &mut geo);
        assert_eq!(geo.water.len(), 1);
        assert_eq!(geo.water[0].rings.len(), 1);
        // 4 distinct points + the ClosePath-appended copy of the first point
        assert_eq!(geo.water[0].rings[0].len(), 5);

        let place = build_layer(
            "place",
            &["name", "class", "rank"],
            &[value_str("Testville"), value_str("city"), value_uint(3)],
            &[(1, vec![0, 0, 1, 1, 2, 2], geom_cmds(&[(2048, 2048)], false))],
        );
        let mut g2 = Geometry::default();
        decode_tile_into(&place, 10, 5, 6, (o.0, o.1), &mut g2);
        assert_eq!(g2.places.len(), 1);
        assert_eq!(g2.strings.list[g2.places[0].name as usize], "Testville");
        assert_eq!(g2.strings.list[g2.places[0].kind as usize], "city");
        assert_eq!(g2.places[0].rank, 3);
        // center of tile → delta ~ half a tile span
        let (_, _, span) = tile_min(10, 5, 6);
        assert!((g2.places[0].pos[0] as f64 - span * 0.5).abs() < 1e-6);
    }

    /// Parity against the real JS `decodeMvtTile` on a live z10 Seattle tile.
    /// Ground-truth counts captured by running the actual TS decoder (bun).
    #[test]
    fn parity_with_js_decoder_on_real_tile() {
        let bytes = include_bytes!("../tests/fixtures/z10_164_357.mvt");
        let (z, x, y) = (10u32, 164u32, 357u32);
        let (ox, oy, _) = tile_min(z, x, y);
        let mut geo = Geometry::default();
        decode_tile_into(bytes, z, x, y, (ox, oy), &mut geo);

        let street_pts: usize = geo.streets.iter().map(|s| s.points.len()).sum();
        let river_pts: usize = geo.rivers.iter().map(|r| r.points.len()).sum();
        let water_pts: usize = geo
            .water
            .iter()
            .flat_map(|a| a.rings.iter())
            .map(|r| r.len())
            .sum();
        let park_pts: usize = geo
            .parks
            .iter()
            .flat_map(|a| a.rings.iter())
            .map(|r| r.len())
            .sum();

        assert_eq!(geo.streets.len(), 1697, "streets");
        assert_eq!(street_pts, 7046, "streetPts");
        assert_eq!(geo.rivers.len(), 7, "rivers");
        assert_eq!(river_pts, 375, "riverPts");
        assert_eq!(geo.water.len(), 23, "water");
        assert_eq!(water_pts, 2838, "waterPts");
        assert_eq!(geo.parks.len(), 108, "parks");
        assert_eq!(park_pts, 9000, "parkPts");
        assert_eq!(geo.places.len(), 94, "places");

        // first street: roadClass 4, world coord matches JS to f32 precision
        assert_eq!(geo.streets[0].road_class, 4);
        let wx = ox + geo.streets[0].points[0][0] as f64;
        let wy = oy + geo.streets[0].points[0][1] as f64;
        assert!((wx - 0.160_179_138_183_593_75).abs() < 1e-6, "wx={wx}");
        assert!((wy - 0.349_286_079_406_738_3).abs() < 1e-6, "wy={wy}");

        // first place: Seattle / city / rank 3
        assert_eq!(geo.strings.list[geo.places[0].name as usize], "Seattle");
        assert_eq!(geo.strings.list[geo.places[0].kind as usize], "city");
        assert_eq!(geo.places[0].rank, 3);
    }

    /// Writes the SCG1 buffer for the real z10 tile so the JS `parseScg1` test can
    /// assert byte-for-byte agreement with this encoder. Gated: run with
    /// `GEN_FIXTURES=1 cargo test generate_scg1_fixture` to refresh.
    #[test]
    fn generate_scg1_fixture() {
        if std::env::var("GEN_FIXTURES").is_err() {
            return;
        }
        let bytes = include_bytes!("../tests/fixtures/z10_164_357.mvt");
        let buf = decode_tile(bytes, 10, 164, 357);
        std::fs::write("tests/fixtures/z10_164_357.scg1", &buf).unwrap();
    }

    #[test]
    fn encode_roundtrip_header_and_counts() {
        let layer = build_layer(
            "transportation",
            &["class"],
            &[value_str("motorway")],
            &[(GEOM_LINE, vec![0, 0], geom_cmds(&[(0, 0), (50, 50), (100, 0)], false))],
        );
        let buf = decode_tile(&layer, 12, 1, 1);
        // magic
        assert_eq!(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]), SCG1_MAGIC);
        // origin at bytes 4..20 (after align4, magic already 4-aligned)
        let ox = f64::from_le_bytes(buf[4..12].try_into().unwrap());
        let (tox, _, _) = tile_min(12, 1, 1);
        assert!((ox - tox).abs() < 1e-12);
        // street count right after origin (offset 20)
        let sc = u32::from_le_bytes(buf[20..24].try_into().unwrap());
        assert_eq!(sc, 1);
        let tp = u32::from_le_bytes(buf[24..28].try_into().unwrap());
        assert_eq!(tp, 3);
    }
}
