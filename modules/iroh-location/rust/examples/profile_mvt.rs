use std::hint::black_box;
use std::time::Instant;

use iroh_location::mvt;

const TILE: &[u8] = include_bytes!("../tests/fixtures/z10_164_357.mvt");

fn main() {
    let tile_iterations = argument(1, 200);
    let bundle_iterations = argument(2, 20);
    let bundle = repeated_bundle(TILE, 10, 164, 357, 12);

    run("tile-z10", tile_iterations, || {
        mvt::decode_tile(black_box(TILE), 10, 164, 357)
    });
    run("bundle-z12-16-tiles", bundle_iterations, || {
        mvt::decode_bundle(black_box(&bundle)).expect("benchmark bundle must decode")
    });
}

fn argument(index: usize, default: usize) -> usize {
    std::env::args()
        .nth(index)
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn run(name: &str, iterations: usize, mut decode: impl FnMut() -> Vec<u8>) {
    for _ in 0..5 {
        black_box(decode());
    }

    let mut samples = Vec::with_capacity(iterations);
    let mut output_bytes = 0;
    for _ in 0..iterations {
        let started = Instant::now();
        let output = decode();
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        output_bytes = output.len();
        black_box(output);
    }
    samples.sort_by(f64::total_cmp);
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let p50 = percentile(&samples, 0.50);
    let p95 = percentile(&samples, 0.95);
    let max = *samples.last().expect("iterations is non-zero");
    println!(
        "MAP_MVT_PERF {{\"name\":\"{name}\",\"iterations\":{iterations},\
         \"inputBytes\":{},\"outputBytes\":{output_bytes},\"meanMs\":{mean:.4},\
         \"p50Ms\":{p50:.4},\"p95Ms\":{p95:.4},\"maxMs\":{max:.4}}}",
        if name == "tile-z10" {
            TILE.len()
        } else {
            repeated_bundle(TILE, 10, 164, 357, 12).len()
        }
    );
}

fn percentile(samples: &[f64], quantile: f64) -> f64 {
    let index = ((samples.len() as f64 * quantile).ceil() as usize)
        .saturating_sub(1)
        .min(samples.len() - 1);
    samples[index]
}

fn repeated_bundle(tile: &[u8], anchor_z: u8, anchor_x: u32, anchor_y: u32, tile_z: u8) -> Vec<u8> {
    let side = 1usize << (tile_z - anchor_z);
    let entries = side * side;
    let mut bundle = Vec::with_capacity(20 + entries * (4 + tile.len()));
    bundle.extend_from_slice(b"SCB1");
    bundle.push(1);
    bundle.push(anchor_z);
    bundle.push(tile_z);
    bundle.push(0);
    bundle.extend_from_slice(&anchor_x.to_be_bytes());
    bundle.extend_from_slice(&anchor_y.to_be_bytes());
    bundle.extend_from_slice(&(entries as u32).to_be_bytes());
    for _ in 0..entries {
        bundle.extend_from_slice(&(tile.len() as u32).to_be_bytes());
        bundle.extend_from_slice(tile);
    }
    bundle
}
