#!/usr/bin/env python3
"""
Business context: extracts a reproducible Swiss routing build input from the
national swissTLM3D GeoPackage. It selects the official road/path layer, keeps
complete 3D source geometries, attaches the `wanderwege` classification directly
to each road, and writes compact 2.4 km geometry cells used only by the offline
binary-graph generator and validation tools.

National extraction is disk-backed: source features are staged once in a
temporary SQLite database and referenced by every intersecting cell. This keeps
memory bounded even when the complete Swiss network is processed. The script
uses only Python's standard library and opens the GeoPackage read-only.
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
DEFAULT_SCOPE = "ch"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PROJECT_ROOT / "routing-data.config.local.json"
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
DATABASE_COMMIT_INTERVAL = 1_000


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


def align_extent_to_grid(
    extent: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """Expand LV95 bounds to complete routing cells for unambiguous coverage."""
    min_x, min_y, max_x, max_y = extent
    if (
        not all(math.isfinite(value) for value in extent)
        or min_x >= max_x
        or min_y >= max_y
    ):
        raise ValueError("Extraction extent must contain four finite ordered values.")

    return (
        math.floor(min_x / CELL_SIZE_METRES) * CELL_SIZE_METRES,
        math.floor(min_y / CELL_SIZE_METRES) * CELL_SIZE_METRES,
        math.ceil(max_x / CELL_SIZE_METRES) * CELL_SIZE_METRES,
        math.ceil(max_y / CELL_SIZE_METRES) * CELL_SIZE_METRES,
    )


def source_extent(connection: sqlite3.Connection) -> tuple[float, float, float, float]:
    """Read the complete indexed road extent without scanning geometry blobs."""
    row = connection.execute(
        f"""
        SELECT MIN(minx), MIN(miny), MAX(maxx), MAX(maxy)
        FROM {quote_identifier(RTREE_TABLE)}
        """
    ).fetchone()
    if row is None or any(value is None for value in row):
        raise RuntimeError(f"{RTREE_TABLE} does not contain a usable extent.")
    return align_extent_to_grid(tuple(float(value) for value in row))


def selected_rows(
    connection: sqlite3.Connection,
    extraction_extent: tuple[float, float, float, float],
) -> Iterator[sqlite3.Row]:
    """Stream road features whose indexed bounds intersect the extraction area."""
    min_x, min_y, max_x, max_y = extraction_extent
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
    extraction_extent: tuple[float, float, float, float],
) -> list[tuple[int, int]]:
    """Return in-region 2.4 km cells touched by the complete feature bounds."""
    min_x, min_y, max_x, max_y = geometry_bounds(lines)
    region_min_x, region_min_y, region_max_x, region_max_y = extraction_extent
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
        (column, row)
        for column in range(min_column, max_column + 1)
        for row in range(min_row, max_row + 1)
    ]


def cell_extent(column: int, row: int) -> list[int]:
    """Return the exact LV95 extent represented by one routing-grid cell."""
    return [
        column * CELL_SIZE_METRES,
        row * CELL_SIZE_METRES,
        (column + 1) * CELL_SIZE_METRES,
        (row + 1) * CELL_SIZE_METRES,
    ]


def sha256_file(path: Path) -> str:
    """Hash one source file so the generated manifest identifies its input."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def create_staging_database(path: Path) -> sqlite3.Connection:
    """Create the disk-backed feature-to-cell index used during extraction."""
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode = OFF")
    connection.execute("PRAGMA synchronous = OFF")
    connection.execute("PRAGMA temp_store = MEMORY")
    connection.execute("PRAGMA locking_mode = EXCLUSIVE")
    connection.executescript(
        """
        CREATE TABLE features (
            feature_id INTEGER PRIMARY KEY,
            payload BLOB NOT NULL
        );
        CREATE TABLE cell_features (
            cell_column INTEGER NOT NULL,
            cell_row INTEGER NOT NULL,
            feature_id INTEGER NOT NULL,
            PRIMARY KEY (cell_column, cell_row, feature_id)
        ) WITHOUT ROWID;
        """
    )
    return connection


def write_geometry_cell(
    path: Path,
    column: int,
    row: int,
    staged: sqlite3.Connection,
) -> tuple[int, int]:
    """Write one compact cell by streaming its staged feature payloads."""
    feature_cursor = staged.execute(
        """
        SELECT features.payload
        FROM cell_features
        JOIN features USING (feature_id)
        WHERE cell_column = ? AND cell_row = ?
        ORDER BY feature_id
        """,
        (column, row),
    )
    prefix = json.dumps(
        {
            "v": STATIC_FORMAT_VERSION,
            "k": f"{column}:{row}",
            "e": cell_extent(column, row),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    # Reuse the validated JSON object prefix and replace its final brace with the
    # road array. Feature payloads are already compact JSON objects.
    prefix = prefix[:-1] + b',"r":['

    feature_count = 0
    with path.open("wb") as output:
        output.write(prefix)
        for (payload,) in feature_cursor:
            if feature_count:
                output.write(b",")
            output.write(bytes(payload))
            feature_count += 1
        output.write(b"]}")

    return path.stat().st_size, feature_count


def parse_extent(value: str) -> tuple[float, float, float, float]:
    """Parse `minX,minY,maxX,maxY` supplied for a bounded validation build."""
    try:
        members = tuple(float(member.strip()) for member in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("Extent values must be numbers.") from error
    if len(members) != 4:
        raise argparse.ArgumentTypeError("Extent requires minX,minY,maxX,maxY.")
    try:
        return align_extent_to_grid(members)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def generate(
    source_path: Path,
    output_root: Path,
    scope: str,
    requested_extent: tuple[float, float, float, float] | None,
    allow_parse_errors: bool,
) -> None:
    """Extract and atomically replace one compact routing-geometry dataset."""
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    if not scope.strip():
        raise ValueError("Dataset scope must not be empty.")

    output_parent = output_root.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f".{output_root.name}-", dir=output_parent)
    )
    staging_path = temporary_root / "geometry-index.sqlite"

    source_uri = source_path.resolve().as_uri() + "?mode=ro"
    unique_features = 0
    feature_references = 0
    parse_errors = 0

    try:
        with sqlite3.connect(source_uri, uri=True) as source:
            required_tables = {
                row[0]
                for row in source.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
                )
            }
            if ROAD_TABLE not in required_tables or RTREE_TABLE not in required_tables:
                raise RuntimeError(
                    f"GeoPackage must contain {ROAD_TABLE} and {RTREE_TABLE}."
                )

            extraction_extent = (
                requested_extent if requested_extent is not None else source_extent(source)
            )
            staged = create_staging_database(staging_path)
            try:
                staged.execute("BEGIN")
                for row in selected_rows(source, extraction_extent):
                    try:
                        lines = decode_geopackage_geometry(bytes(row["geom"]))
                    except (TypeError, ValueError, struct.error):
                        parse_errors += 1
                        continue

                    if not lines:
                        continue

                    keys = feature_cell_keys(lines, extraction_extent)
                    if not keys:
                        continue

                    feature_id = unique_features
                    payload: dict[str, object] = {
                        "i": str(row["uuid"] or f"row-{row['id']}"),
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
                    encoded = json.dumps(
                        payload,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    ).encode("utf-8")

                    staged.execute(
                        "INSERT INTO features(feature_id, payload) VALUES (?, ?)",
                        (feature_id, encoded),
                    )
                    staged.executemany(
                        """
                        INSERT INTO cell_features(cell_column, cell_row, feature_id)
                        VALUES (?, ?, ?)
                        """,
                        ((column, cell_row, feature_id) for column, cell_row in keys),
                    )
                    unique_features += 1
                    feature_references += len(keys)

                    if unique_features % DATABASE_COMMIT_INTERVAL == 0:
                        staged.commit()
                        staged.execute("BEGIN")

                staged.commit()

                if parse_errors and not allow_parse_errors:
                    raise RuntimeError(
                        f"{parse_errors} source geometries could not be decoded. "
                        "Rerun with --allow-parse-errors only after investigating them."
                    )

                cells_root = temporary_root / "cells"
                cells_root.mkdir()
                cell_keys: list[str] = []
                cell_sizes: list[int] = []
                cell_feature_counts: list[int] = []

                key_cursor = staged.execute(
                    """
                    SELECT DISTINCT cell_column, cell_row
                    FROM cell_features
                    ORDER BY cell_column, cell_row
                    """
                )
                for column, cell_row in key_cursor:
                    key = f"{column}:{cell_row}"
                    size_bytes, feature_count = write_geometry_cell(
                        cells_root / f"{column}_{cell_row}.json",
                        column,
                        cell_row,
                        staged,
                    )
                    cell_keys.append(key)
                    cell_sizes.append(size_bytes)
                    cell_feature_counts.append(feature_count)
            finally:
                staged.close()

        staging_path.unlink(missing_ok=True)
        source_size = source_path.stat().st_size
        manifest = {
            "version": STATIC_FORMAT_VERSION,
            "format": STATIC_FORMAT,
            "scope": scope,
            "projection": "EPSG:2056",
            "cellSizeMetres": CELL_SIZE_METRES,
            "extent": list(extraction_extent),
            "cellPathTemplate": "cells/{column}_{row}.json",
            "nonEmptyCellCount": len(cell_keys),
            "roadFeatureCountBeforeCellDuplication": unique_features,
            "roadFeatureReferenceCount": feature_references,
            "featureDuplicationFactor": (
                feature_references / unique_features if unique_features else 0
            ),
            "hikingSource": "tlm_strassen_strasse.wanderwege = Wanderweg",
            "sourceLayer": ROAD_TABLE,
            "sourceFiles": [source_path.name],
            "sourceDatasetVersion": source_path.stem,
            "sourceSizeBytes": source_size,
            "sourceSha256": sha256_file(source_path),
            "cellAssignment": "full-feature-bbox-overlap-no-clipping",
            "geometryParseErrors": parse_errors,
            "uncompressedCellBytes": sum(cell_sizes),
            "largestCellBytes": max(cell_sizes, default=0),
            "largestCellFeatureReferences": max(cell_feature_counts, default=0),
            "nonEmptyCellKeys": cell_keys,
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

    print(f"Generated {len(cell_keys)} {scope} geometry cells in {output_root}.")
    print(
        f"Unique source roads: {unique_features}; "
        f"logical cell references: {feature_references}; parse errors: {parse_errors}."
    )
    print(
        f"Geometry size: {sum(cell_sizes) / 1024 / 1024:.2f} MiB; "
        f"largest cell: {max(cell_sizes, default=0) / 1024 / 1024:.2f} MiB."
    )


def load_local_config(path: Path, optional: bool) -> dict[str, object]:
    """Read machine-local pipeline paths without making them repository state."""
    resolved = path.resolve()
    if not resolved.is_file():
        if optional:
            return {}
        raise FileNotFoundError(
            f"Routing-data configuration not found: {resolved}. "
            "Copy routing-data.config.example.json to "
            "routing-data.config.local.json and adjust the paths."
        )

    try:
        parsed = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(
            f"Cannot parse routing-data configuration {resolved}: {error}"
        ) from error
    if not isinstance(parsed, dict):
        raise ValueError("Routing-data configuration must contain one JSON object.")

    for field in ("sourceGeoPackage", "geometryRoot"):
        value = parsed.get(field)
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            raise ValueError(
                f"Routing-data configuration field {field} must be a path string."
            )
        candidate = Path(value.strip())
        parsed[field] = (
            candidate if candidate.is_absolute() else resolved.parent / candidate
        ).resolve()

    scope = parsed.get("scope")
    if scope is not None:
        if not isinstance(scope, str) or not scope.strip():
            raise ValueError(
                "Routing-data configuration field scope must be a non-empty string."
            )
        parsed["scope"] = scope.strip()
    return parsed


def parse_args() -> argparse.Namespace:
    """Parse the national or bounded geometry-generation command line."""
    parser = argparse.ArgumentParser(
        description="Generate Via Helvetica routing geometry cells from swissTLM3D."
    )
    parser.add_argument(
        "geopackage",
        type=Path,
        nargs="?",
        help=(
            "Optional GeoPackage override. Without it, sourceGeoPackage is read "
            "from routing-data.config.local.json."
        ),
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help=f"Local routing-data configuration (default: {DEFAULT_CONFIG.name})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional geometryRoot override.",
    )
    parser.add_argument(
        "--scope",
        help="Optional stable dataset-scope override.",
    )
    parser.add_argument(
        "--extent",
        type=parse_extent,
        help="Optional bounded LV95 extent as minX,minY,maxX,maxY.",
    )
    parser.add_argument(
        "--allow-parse-errors",
        action="store_true",
        help="Keep a dataset with skipped invalid geometries after investigation.",
    )
    return parser.parse_args()


def main() -> int:
    """Run the command-line generator and return a conventional exit status."""
    args = parse_args()
    try:
        config = load_local_config(
            args.config,
            optional=args.geopackage is not None and args.output is not None,
        )
        source_path = args.geopackage or config.get("sourceGeoPackage")
        output_root = args.output or config.get("geometryRoot")
        scope = args.scope or config.get("scope") or DEFAULT_SCOPE
        if source_path is None or output_root is None:
            raise ValueError(
                "sourceGeoPackage and geometryRoot must be configured or supplied "
                "through the command line."
            )
        if not isinstance(scope, str) or not scope.strip():
            raise ValueError("Dataset scope must be a non-empty string.")

        generate(
            Path(source_path).resolve(),
            Path(output_root).resolve(),
            scope.strip(),
            args.extent,
            args.allow_parse_errors,
        )
    except Exception as error:  # noqa: BLE001 - command-line boundary
        print(f"Generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
