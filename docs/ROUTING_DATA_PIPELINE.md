# Via Helvetica Routing Data Pipeline

## Purpose

The routing-data pipeline converts the official national swissTLM3D
LV95/LN02 GeoPackage into immutable, independently loadable binary graph cells
for the browser routing Worker.

The pipeline is an offline maintenance workflow. Its large source,
intermediate, and release files must remain outside the repository. This keeps
Vite startup, JetBrains indexing, Git operations, backups, and antivirus scans
from traversing tens of thousands of generated files whenever the application
is opened.

Runtime routing behaviour, graph semantics, snapping, A*, caching, and fallback
are documented in [ROUTING.md](ROUTING.md). This document covers source import,
binary generation, verification, and publication.

## 1. Filesystem boundary

A recommended Windows layout is:

```text
C:\Dev\via-helvetica\
    routing-data.config.example.json
    routing-data.config.local.json
    scripts\
    src\
    docs\

C:\ViaHelveticaData\
    source\
        SWISSTLM3D_2026_LV95_LN02.gpkg
    work\
        ch-geometry\
        precomputed-binary-routing-build.sqlite
    releases\
        swisstlm3d-2026\
            format-v3\
                ch\
                    manifest.json
                    integrity.json
                    cells\
```

`C:\ViaHelveticaData` may be replaced by another local drive. The important
constraint is that it is not the repository itself and is not nested below the
repository.

The application never needs these local files at startup. Development and
production normally load the published release through
`VITE_ROUTING_DATA_BASE_URL`.

## 2. Local configuration

Copy `routing-data.config.example.json` to the git-ignored
`routing-data.config.local.json`, then adjust the paths and public R2 URL:

```json
{
  "scope": "ch",
  "sourceGeoPackage": "C:/ViaHelveticaData/source/SWISSTLM3D_2026_LV95_LN02.gpkg",
  "geometryRoot": "C:/ViaHelveticaData/work/ch-geometry",
  "binaryReleaseRoot": "C:/ViaHelveticaData/releases/swisstlm3d-2026/format-v3/ch",
  "buildDatabasePath": "C:/ViaHelveticaData/work/precomputed-binary-routing-build.sqlite",
  "publication": {
    "remote": "r2",
    "bucket": "via-helvetica-routing-data",
    "prefix": "swisstlm3d-2026/format-v3/ch",
    "expectedCellCount": 7529,
    "publicBaseUrl": "https://pub-example.r2.dev/swisstlm3d-2026/format-v3/ch",
    "publicOrigin": "https://viahelvetica.ch",
    "publicSampleCount": 50
  }
}
```

Forward slashes avoid JSON escaping on Windows. Relative paths are resolved
from the configuration file directory. R2 credentials never belong in this
file; they remain in the local rclone configuration.

Every user-facing pipeline command reads this file automatically. An explicit
CLI path overrides the corresponding configuration value. A different file can
be supplied with `--config <path>` for Node/Python scripts or `-Config <path>`
for the PowerShell publication script.

## 3. Script inventory

All scripts currently in `scripts/` remain useful:

| Script | Role | Direct use |
|---|---|---|
| `generate-localized-pages.mjs` | Generates localized application and release-history HTML entries | Application build helper; unrelated to routing data |
| `generate-routing-geometry-cells.py` | Reads the official GeoPackage and produces normalized 2.4 km source-geometry cells | `npm run generate:routing-geometry` |
| `generate-precomputed-binary-routing-graph.mjs` | Builds the national graph and emits raw plus Brotli binary cells | `npm run generate:precomputed-binary-routing` |
| `verify-routing-dataset.mjs` | Performs the complete local semantic, checksum, and cross-cell verification | `npm run verify:precomputed-binary-routing` |
| `prepare-routing-publication.mjs` | Derives publication-only metadata containing compressed objects only | Internal helper used by the upload script |
| `upload-routing-dataset-r2.ps1` | Publishes cells first, verifies R2, and writes the manifest last | Run directly from PowerShell |
| `verify-published-routing-dataset.mjs` | Verifies public transport decoding, headers, CORS, and sampled hashes | `npm run verify:published-routing` or upload helper |

No script in this list is obsolete. `prepare-routing-publication.mjs` looks
specialized because it is deliberately an internal safety step rather than a
standalone workflow.

## 4. Stage 1: import the official GeoPackage

Run:

```powershell
npm run generate:routing-geometry
```

The Python generator:

- opens the official GeoPackage read-only;
- reads `tlm_strassen_strasse` and its R-tree index;
- preserves complete 3D road/path geometries rather than clipping them at cell
  borders;
- carries the source `wanderwege` classification into the normalized records;
- assigns each complete feature to every intersecting 2.4 km cell;
- uses a temporary SQLite index so national extraction remains disk-backed;
- writes the geometry dataset atomically only after successful completion;
- records source size, SHA-256, parsing counts, extent, and duplication
  statistics in its manifest.

A bounded validation extraction can override the normal extent:

```powershell
npm run generate:routing-geometry -- --extent 2496000,1116000,2515200,1135200
```

CLI overrides remain available for one-off experiments:

```powershell
npm run generate:routing-geometry -- "D:/Data/test.gpkg" --output "D:/Data/test-geometry" --scope test
```

Parse errors fail the build by default. `--allow-parse-errors` is reserved for a
source edition whose rejected geometries have already been investigated.

## 5. Stage 2: compile the binary graph

Run:

```powershell
npm run generate:precomputed-binary-routing
```

National generation requires Node.js 22.5 or later because the build uses
`node:sqlite`. The initial `Indexed ... geometry cells` phase does not recreate
the geometry dataset and does not reread the GeoPackage. It reads the existing
geometry cells, compiles each one with the shared routing rules, and builds the
disk-backed global node/edge index needed for deterministic cross-cell IDs and
deduplication. The later `Encoded ... binary cells` phase writes the release.

The generator:

- validates every geometry source cell with the shared TypeScript format reader;
- runs the same walkability, 3D node identity, hiking preference, and cost model
  used by live routing;
- builds a disk-backed national graph index at `buildDatabasePath`;
- assigns deterministic global node and edge IDs;
- writes strictly ID-ordered fixed-point columns;
- emits both `.bin` and `.bin.br` for every non-empty cell;
- writes CRC32-protected v3 headers with the release `datasetBuildId`;
- creates `manifest.json` and the complete SHA-256 `integrity.json` inventory;
- atomically replaces `binaryReleaseRoot` only after the new release is complete.

The raw `.bin` files are retained locally because verification compares their
semantic content with the Brotli round trip. Only `.bin.br` objects are
published to R2.

The temporary TypeScript compiler output is created in the operating-system
temporary directory rather than the repository. The SQLite build database is
removed after a successful run unless `--keep-database` is supplied.

The validated 2026 national build produced 7,529 logical cells, approximately
1,030 MiB of raw binary data, and approximately 313 MiB of Brotli data. These
figures describe that source edition and are not hard format limits.

## 6. Complete local verification

Run:

```powershell
npm run verify:precomputed-binary-routing
```

The verifier checks:

- manifest format, provenance, and `datasetBuildId`;
- exact agreement between cell keys and the integrity inventory;
- SHA-256 of every raw and compressed file;
- every Brotli round trip;
- v3 header fields and payload CRC32;
- global ID ordering, endpoint membership, coordinates, elevations, and cost
  plausibility;
- consistency of shared global nodes and edges across all cells;
- aggregate byte and graph counts.

This is intentionally an offline publication gate and may use substantial
memory. It is not browser work.

## 7. R2 publication

The rclone remote must already exist and have object read/write permission for
the target bucket. Bucket creation permission is not required. The upload script
passes `--s3-no-check-bucket`, preventing rclone from attempting `CreateBucket`
with a correctly restricted token.

Preview the complete operation without changing R2:

```powershell
.\scripts\upload-routing-dataset-r2.ps1 -DryRun
```

Publish the configured release:

```powershell
.\scripts\upload-routing-dataset-r2.ps1
```

The script performs the following order:

1. complete local verification;
2. generation of a publication-only manifest and integrity inventory;
3. upload of all `.bin.br` cell objects with `Content-Encoding: br`;
4. remote size and checksum comparison;
5. upload of `integrity.json`;
6. upload of `manifest.json` last;
7. public verification of manifest, integrity, CORS, cache headers, Brotli
   transport decoding, and evenly distributed sample hashes.

`manifest.json` is the release-visibility switch. A failure before that write
leaves the new release undiscoverable. Published version roots are immutable;
use a new source-version, format-version, or scope path for a changed release.

The public verifier retries bounded transient `404`, `429`, and `5xx` responses.
This is useful immediately after a large upload to an `r2.dev` development URL,
but persistent errors still fail the publication.

The public verifier can also be rerun without uploading:

```powershell
npm run verify:published-routing
```

## 8. Application activation

The routing-data configuration is an offline maintenance file and is not read by
Vite or the browser. To test the published release, set the public root in the
git-ignored `.env.local`:

```env
VITE_ROUTING_DATA_BASE_URL=https://pub-example.r2.dev/swisstlm3d-2026/format-v3/ch
```

Restart Vite after changing the value. The URL must identify the directory that
contains the public `manifest.json`.

## 9. Migration from the former in-repository layout

The previous experimental layout used:

```text
.routing-work/ch-geometry
public/routing-data/ch-precomputed-binary
```

Move those directories to the locations selected in
`routing-data.config.local.json`; do not copy them back below the project root.
After the move:

- Vite no longer scans the national binary release as a public directory;
- its file watcher no longer traverses the geometry workspace;
- JetBrains IDEs do not index the generated cells;
- local route testing continues through R2;
- Git and production builds remain independent of the offline data volume.

The old paths stay in `.gitignore`, and Vite ignores legacy workspaces as a
safety net. This prevents accidental regeneration below the repository from
becoming Git noise, but it is not a substitute for the external layout.

## 10. Release checklist

For a new official swissTLM3D edition:

1. place the new GeoPackage under the external source directory;
2. update the local configuration paths and versioned R2 prefix;
3. generate geometry cells;
4. generate the binary release;
5. run complete local verification;
6. compare counts, sizes, parse errors, largest cells, and representative routes
   with the previous release;
7. run an R2 dry run;
8. publish the immutable release;
9. verify contrasting Swiss regions with a test build;
10. promote the new public root through `VITE_ROUTING_DATA_BASE_URL` only after
    local testing.

Do not propose a commit until the changed scripts and documentation have been
tested locally with the external paths.
