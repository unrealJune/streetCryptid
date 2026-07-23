use geo::{Coord, LineString, Polygon};
use h3o::{geom::TilerBuilder, Resolution};

pub fn cells_for_polygon(coordinates: &[f64], resolution: u8) -> Result<Vec<String>, String> {
    if coordinates.len() < 6 || coordinates.len() % 2 != 0 {
        return Err("H3 polygon requires at least three latitude/longitude pairs".into());
    }
    let resolution = Resolution::try_from(resolution)
        .map_err(|error| format!("invalid H3 resolution: {error}"))?;
    let mut ring = coordinates
        .chunks_exact(2)
        .map(|pair| Coord {
            x: pair[1],
            y: pair[0],
        })
        .collect::<Vec<_>>();
    if ring.first() != ring.last() {
        ring.push(ring[0]);
    }

    let mut tiler = TilerBuilder::new(resolution).build();
    tiler
        .add(Polygon::new(LineString::new(ring), vec![]))
        .map_err(|error| format!("invalid H3 polygon: {error}"))?;
    let mut cells = tiler
        .into_coverage()
        .map(|cell| cell.to_string())
        .collect::<Vec<_>>();
    cells.sort_unstable();
    Ok(cells)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerates_sorted_canonical_cells() {
        let cells = cells_for_polygon(
            &[
                47.64, -122.34, 47.64, -122.29, 47.60, -122.29, 47.60, -122.34,
            ],
            10,
        )
        .unwrap();

        assert!(cells.len() > 100);
        assert!(cells.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(cells.iter().all(|cell| cell.len() == 15));
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(cells_for_polygon(&[47.0, -122.0], 10).is_err());
        assert!(cells_for_polygon(&[47.0, -122.0, 48.0, -122.0, 48.0, -121.0], 16).is_err());
    }
}
