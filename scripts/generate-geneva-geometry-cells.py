#!/usr/bin/env python3
"""
Business context: extracts the reproducible Geneva routing experiment from the
national swissTLM3D GeoPackage. It selects the official road/path layer, keeps
complete 3D source geometries, attaches the `wanderwege` classification directly
to each road, and writes compact 2.4 km geometry cells used only by the
offline binary-graph generator and validation tools.

The script uses only Python's standard library and opens the GeoPackage read-only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sqlite3
import struct
import sys
import tempfile
from pathlib import Path
from typing import Iterator, Sequence

ROAD_TABLE = "tlm_strassen_strasse"
RTREE_TABLE = "rtree_tlm_strassen_strasse_geom"
STATIC_FORMAT = "via-helvetica-static-routing-cells"
STATIC_FORMAT_VERSION = 2
CELL_SIZE_METRES = 2_400
GENEVA_EXTRACTION_EXTENT = (2_476_800.0, 1_101_600.0, 2_522_400.0, 1_142_400.0)
ROAD_COLUMNS = (
    "id",
    "geom",
    "uuid",
    "objektart",
    "wanderwege",
    "belagsart",
    "verkehrsbeschraenkung",
    "verkehrsbedeutung",
)


def quote_identifier(value: str) -> str:
    """Quote one SQLite identifier without treating user input as SQL."""
    return '"' + value.replace('"', '""') + '"'


def envelope_size_bytes(indicator: int) -> int:
    """Return the GeoPackage binary-envelope size encoded in header flags."""
    sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    if indicator not in sizes:
        raise ValueError(f"Unsupported GeoPackage envelope indicator: {indicator}")
    return sizes[indicator]


def normalize_wkb_type(raw_type: int) -> tuple[int, bool, bool, bool]:
    """Normalize ISO WKB and EWKB dimensional flags."""
    has_z = bool(raw_type & 0x80000000)
    has_m = bool(raw_type & 0x40000000)
    has_srid = bool(raw_type & 0x20000000)
    base_type = raw_type & 0x0FFFFFFF

    if base_type >= 3000:
        has_z = True
        has_m = True
        base_type -= 3000
    elif base_type >= 2000:
        has_m = True
        base_type -= 2000
    elif base_type >= 1000:
        has_z = True
        base_type -= 1000

    return base_type, has_z, has_m, has_srid


def read_wkb_geometry(
    data: memoryview,
    offset: int = 0,
) -> tuple[int, list[list[list[float]]], int]:
    """Decode LineString or MultiLineString WKB while preserving finite Z."""
    if offset >= len(data):
        raise ValueError("Unexpected end of WKB geometry.")

    byte_order = data[offset]
    offset += 1
    if byte_order == 0:
        endian = ">"
    elif byte_order == 1:
        endian = "<"
    else:
        raise ValueError(f"Invalid WKB byte order: {byte_order}")

    raw_type = struct.unpack_from(endian + "I", data, offset)[0]
    offset += 4
    base_type, has_z, has_m, has_srid = normalize_wkb_type(raw_type)
    if has_srid:
        offset += 4

    dimensions = 2 + int(has_z) + int(has_m)

    def read_point(current_offset: int) -> tuple[list[float] | None, int]:
        values = struct.unpack_from(
            endian + ("d" * dimensions), data, current_offset
        )
        current_offset += dimensions * 8
        x, y = float(values[0]), float(values[1])
        if not math.isfinite(x) or not math.isfinite(y):
            return None, current_offset
        coordinate = [x, y]
        if has_z and math.isfinite(values[2]):
            coordinate.append(float(values[2]))
        return coordinate, current_offset

    if base_type == 2:
        point_count = struct.unpack_from(endian + "I", data, offset)[0]
        offset += 4
        lines: list[list[list[float]]] = []
        current_line: list[list[float]] = []

        # Invalid vertices split the source line; joining around them would
        # fabricate a road segment not present in the GeoPackage.
        for _ in range(point_count):
            coordinate, offset = read_point(offset)
            if coordinate is None:
                if len(current_line) >= 2:
                    lines.append(current_line)
                current_line = []
            else:
                current_line.append(coordinate)

        if len(current_line) >= 2:
            lines.append(current_line)
        return base_type, lines, offset

    if base_type == 5:
        line_count = struct.unpack_from(endian + "I", data, offset)[0]
        offset += 4
        lines: list[list[list[float]]] = []
        for _ in range(line_count):
            child_type, child_lines, offset = read_wkb_geometry(data, offset)
            if child_type != 2:
                raise ValueError("MultiLineString contains a non-LineString child.")
            lines.extend(child_lines)
        return base_type, lines, offset

    raise ValueError(f"Unsupported WKB geometry type: {base_type}")


def decode_geopackage_geometry(blob: bytes) -> list[list[list[float]]]:
    """Decode one GeoPackage geometry blob into routing line strings."""
    if len(blob) < 8 or blob[0:2] != b"GP":
        raise ValueError("Invalid GeoPackage geometry header.")

    envelope_indicator = (blob[3] >> 1) & 0b111
    wkb_offset = 8 + envelope_size_bytes(envelope_indicator)
    _, lines, _ = read_wkb_geometry(memoryview(blob), wkb_offset)
    return lines


def read_optional_number(value: object) -> int | float | None:
    """Normalize a GeoPackage coded-domain value to a finite JSON number."""
    if value is None:
        return None
    try:
        number = float(str(value).strip())
    except ValueError:
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def is_hiking_road(value: object) -> bool:
    """Recognize the official hiking designation used by the 2026 package."""
    return str(value or "").strip().casefold() == "wanderweg"


def geometry_bounds(
    lines: Sequence[Sequence[Sequence[float]]],
) -> tuple[float, float, float, float]:
    """Calculate horizontal bounds for assigning a complete feature to cells."""
    coordinates = [coordinate for line in lines for coordinate in line]
    if not coordinates:
        raise ValueError("Geometry contains no valid line coordinates.")
    xs = [coordinate[0] for coordinate in coordinates]
    ys = [coordinate[1] for coordinate in coordinates]
    return min(xs), min(ys), max(xs), max(ys)


def selected_rows(connection: sqlite3.Connection) -> Iterator[sqlite3.Row]:
    """Stream road features whose indexed bounds intersect the extraction area."""
    min_x, min_y, max_x, max_y = GENEVA_EXTRACTION_EXTENT
    connection.row_factory = sqlite3.Row
    columns = ", ".join(f"t.{quote_identifier(column)}" for column in ROAD_COLUMNS)
    query = f"""
        SELECT {columns}
        FROM {quote_identifier(ROAD_TABLE)} AS t
        JOIN {quote_identifier(RTREE_TABLE)} AS r ON r.id = t.id
        WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?
        ORDER BY t.id
    """
    cursor = connection.execute(query, (min_x, max_x, min_y, max_y))
    while True:
        rows = cursor.fetchmany(1_000)
        if not rows:
            return
        yield from rows


def feature_cell_keys(
    lines: Sequence[Sequence[Sequence[float]]],
) -> list[str]:
    """Return in-region 2.4 km cells touched by the complete feature bounds."""
    min_x, min_y, max_x, max_y = geometry_bounds(lines)
    region_min_x, region_min_y, region_max_x, region_max_y = GENEVA_EXTRACTION_EXTENT
    min_column = max(
        math.floor(min_x / CELL_SIZE_METRES),
        math.floor(region_min_x / CELL_SIZE_METRES),
    )
    max_column = min(
        math.floor(max_x / CELL_SIZE_METRES),
        math.ceil(region_max_x / CELL_SIZE_METRES) - 1,
    )
    min_row = max(
        math.floor(min_y / CELL_SIZE_METRES),
        math.floor(region_min_y / CELL_SIZE_METRES),
    )
    max_row = min(
        math.floor(max_y / CELL_SIZE_METRES),
        math.ceil(region_max_y / CELL_SIZE_METRES) - 1,
    )

    return [
        f"{column}:{row}"
        for column in range(min_column, max_column + 1)
        for row in range(min_row, max_row + 1)
    ]


def cell_extent(key: str) -> list[int]:
    """Return the exact LV95 extent represented by one routing-grid key."""
    column, row = (int(value) for value in key.split(":"))
    return [
        column * CELL_SIZE_METRES,
        row * CELL_SIZE_METRES,
        (column + 1) * CELL_SIZE_METRES,
        (row + 1) * CELL_SIZE_METRES,
    ]


def sha256_file(path: Path) -> str:
    """Hash the official source so a generated manifest is reproducible."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def generate(source_path: Path, output_root: Path) -> None:
    """Extract and atomically replace the Geneva compact routing dataset."""
    if not source_path.is_file():
        raise FileNotFoundError(source_path)

    source_uri = source_path.resolve().as_uri() + "?mode=ro"
    cells: dict[str, list[dict[str, object]]] = {}
    unique_features = 0
    parse_errors = 0

    with sqlite3.connect(source_uri, uri=True) as connection:
        required_tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            )
        }
        if ROAD_TABLE not in required_tables or RTREE_TABLE not in required_tables:
            raise RuntimeError(
                f"GeoPackage must contain {ROAD_TABLE} and {RTREE_TABLE}."
            )

        for row in selected_rows(connection):
            try:
                lines = decode_geopackage_geometry(bytes(row["geom"]))
            except (TypeError, ValueError, struct.error):
                parse_errors += 1
                continue

            if not lines:
                continue

            feature_id = str(row["uuid"] or f"row-{row['id']}")
            payload: dict[str, object] = {
                "i": feature_id,
                "l": lines,
                "a": [
                    read_optional_number(row["objektart"]),
                    read_optional_number(row["verkehrsbeschraenkung"]),
                    read_optional_number(row["belagsart"]),
                    read_optional_number(row["verkehrsbedeutung"]),
                ],
            }
            if is_hiking_road(row["wanderwege"]):
                payload["h"] = 1

            keys = feature_cell_keys(lines)
            if not keys:
                continue
            unique_features += 1
            for key in keys:
                cells.setdefault(key, []).append(payload)

    output_parent = output_root.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f".{output_root.name}-", dir=output_parent)
    )

    try:
        cells_root = temporary_root / "cells"
        cells_root.mkdir(parents=True)
        uncompressed_cell_bytes = 0

        for key in sorted(cells, key=lambda value: tuple(map(int, value.split(":")))):
            column, row = key.split(":")
            payload = {
                "v": STATIC_FORMAT_VERSION,
                "k": key,
                "e": cell_extent(key),
                "r": cells[key],
            }
            encoded = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
            (cells_root / f"{column}_{row}.json").write_bytes(encoded)
            uncompressed_cell_bytes += len(encoded)

        source_size = source_path.stat().st_size
        manifest = {
            "version": STATIC_FORMAT_VERSION,
            "format": STATIC_FORMAT,
            "projection": "EPSG:2056",
            "cellSizeMetres": CELL_SIZE_METRES,
            "extent": list(GENEVA_EXTRACTION_EXTENT),
            "cellPathTemplate": "cells/{column}_{row}.json",
            "nonEmptyCellCount": len(cells),
            "roadFeatureCountBeforeCellDuplication": unique_features,
            "hikingSource": "tlm_strassen_strasse.wanderwege = Wanderweg",
            "sourceLayer": ROAD_TABLE,
            "sourceFiles": [source_path.name],
            "sourceSizeBytes": source_size,
            "sourceSha256": sha256_file(source_path),
            "cellAssignment": "full-feature-bbox-overlap-no-clipping",
            "geometryParseErrors": parse_errors,
            "uncompressedCellBytes": uncompressed_cell_bytes,
            "nonEmptyCellKeys": sorted(
                cells, key=lambda value: tuple(map(int, value.split(":")))
            ),
        }
        (temporary_root / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        if output_root.exists():
            shutil.rmtree(output_root)
        temporary_root.replace(output_root)
    except Exception:
        shutil.rmtree(temporary_root, ignore_errors=True)
        raise

    print(f"Generated {len(cells)} Geneva geometry cells in {output_root}.")
    print(f"Unique source roads: {unique_features}; parse errors: {parse_errors}.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Via Helvetica Geneva geometry cells from swissTLM3D."
    )
    parser.add_argument(
        "geopackage",
        type=Path,
        help="Path to SWISSTLM3D_2026_LV95_LN02.gpkg",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".routing-work/geneva-geometry"),
        help="Generated dataset directory (default: .routing-work/geneva-geometry)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        generate(args.geopackage, args.output)
    except Exception as error:  # noqa: BLE001 - command-line boundary
        print(f"Generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
