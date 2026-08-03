# Via Helvetica Routing Data Pipeline

## Purpose

The routing-data pipeline converts an official swissTLM3D LV95/LN02
GeoPackage into immutable, independently loadable binary graph cells consumed
by the browser routing Worker.

This is an offline maintenance workflow. Large source, intermediate, and
release files stay outside the repository so normal development tools do not
scan tens of thousands of generated files. The application itself does not
need the local pipeline workspace at startup: development and production can
load an already published release through `VITE_ROUTING_DATA_BASE_URL`.

Runtime graph semantics, snapping, A*, caching, provider fallback, and route
calculation are documented in [ROUTING.md](ROUTING.md). This document describes
the reproducible pipeline and its public delivery contract. Machine-specific
paths, credentials, bucket names, domains, and operational notes should remain
in local files outside version control.

## 1. External data layout

Keep the data root outside the Git working tree. A typical layout is:

```text
<project>/
    routing-data.config.example.json
    routing-data.config.local.json
    scripts/
    src/
    docs/

<routing-data-root>/
    source/
        <official-swisstlm3d-source>.gpkg
    work/
        <dataset-id>/
            <scope>-geometry/
            precomputed-binary-routing-build.sqlite
    releases/
        <dataset-id>/
            <format-id>/
                <scope>/
                    manifest.json
                    integrity.json
                    cells/
```

The paths can be on any suitable local drive. The important constraint is that
`<routing-data-root>` is not the repository itself and is not nested below it.
Source GeoPackages, geometry cells, SQLite build databases, and binary releases
must not be committed.

## 2. Local maintenance configuration

Copy `routing-data.config.example.json` to the git-ignored
`routing-data.config.local.json`, then replace the placeholders:

```json
{
  "datasetId": "swisstlm3d-YYYY",
  "formatId": "format-v3",
  "scope": "ch",
  "dataRoot": "C:/Path/To/RoutingData",
  "sourceGeoPackage": "C:/Path/To/RoutingData/source/SWISSTLM3D_YYYY.gpkg",
  "publication": {
    "remote": "r2",
    "bucket": "your-routing-data-bucket",
    "publicRootUrl": "https://data.example.org",
    "publicOrigin": "https://app.example.org",
    "publicSampleCount": 50
  }
}
```

The three release identifiers produce one stable relative path:

```text
<datasetId>/<formatId>/<scope>
```

For the example above, the scripts derive:

```text
geometryRoot
= C:/Path/To/RoutingData/work/swisstlm3d-YYYY/ch-geometry

binaryReleaseRoot
= C:/Path/To/RoutingData/releases/swisstlm3d-YYYY/format-v3/ch

buildDatabasePath
= C:/Path/To/RoutingData/work/swisstlm3d-YYYY/precomputed-binary-routing-build.sqlite

publication.prefix
= swisstlm3d-YYYY/format-v3/ch

publication.publicBaseUrl
= https://data.example.org/swisstlm3d-YYYY/format-v3/ch
```

`datasetId` identifies the official source edition. `formatId` identifies Via
Helvetica's binary encoding and changes only when that encoding becomes
incompatible. `scope` remains a separate segment so national and bounded
releases use the same naming model.

`publication.publicRootUrl` is the public host root, not the complete release
path. The scripts append the derived release path. `publication.publicOrigin`
is the exact browser origin allowed by the storage CORS policy, without a path.
R2 or S3 credentials never belong in this JSON file; they remain in the local
storage-client configuration.

The maintenance configuration is not read by Vite or by the browser. The
application's runtime data URL is configured separately through
`VITE_ROUTING_DATA_BASE_URL`.

Every pipeline command reads `routing-data.config.local.json` by default. Node
and Python scripts accept `--config <path>`, while the PowerShell publication
script accepts `-Config <path>`. Explicit command-line paths override derived
values for one-off experiments.

## 3. Script inventory

| Script | Role | Direct use |
|---|---|---|
| `generate-routing-geometry-cells.py` | Reads the official GeoPackage and produces normalized source-geometry cells | `npm run generate:routing-geometry` |
| `generate-precomputed-binary-routing-graph.mjs` | Builds the graph and emits raw plus Brotli binary cells | `npm run generate:precomputed-binary-routing` |
| `verify-routing-dataset.mjs` | Performs complete local semantic, checksum, and cross-cell verification | `npm run verify:precomputed-binary-routing` |
| `prepare-routing-publication.mjs` | Creates publication-only metadata containing compressed objects | Internal upload helper |
| `upload-routing-dataset-r2.ps1` | Publishes cells first, verifies storage, and writes the manifest last | Run from PowerShell |
| `verify-published-routing-dataset.mjs` | Verifies public transport decoding, headers, CORS, and sampled hashes | `npm run verify:published-routing` |

`generate-localized-pages.mjs` is an application build helper and is unrelated
to routing-data generation.

## 4. Stage 1: import the official GeoPackage

Run:

```powershell
npm run generate:routing-geometry
```

The generator:

- opens the official GeoPackage read-only;
- reads `tlm_strassen_strasse` through its spatial index;
- preserves complete 3D road and path geometries instead of clipping them at
  cell borders;
- carries the source `wanderwege` classification into normalized records;
- assigns each complete feature to every 2.4 km cell overlapped by its bounding
  box;
- uses a temporary SQLite index so national extraction remains disk-backed;
- writes the geometry dataset atomically after successful completion;
- records source size, SHA-256, parsing counts, extent, and duplication
  statistics in its manifest.

A bounded validation extraction can override the configured extent:

```powershell
npm run generate:routing-geometry -- --extent 2496000,1116000,2515200,1135200
```

Explicit source and output paths remain available for experiments:

```powershell
npm run generate:routing-geometry -- "D:/Data/test.gpkg" --output "D:/Data/test-geometry" --scope test
```

Parse errors fail the build by default. Use `--allow-parse-errors` only after the
rejected source geometries have been investigated.

## 5. Stage 2: compile the binary graph

Run:

```powershell
npm run generate:precomputed-binary-routing
```

National generation requires Node.js 22.5 or later because the build uses
the `node:sqlite` API. Use a newer version when required by the application
toolchain, as documented in the README. Run `npm install` before generation so
the script can resolve the project's TypeScript compiler.

The generator:

- validates every geometry cell with the shared TypeScript format reader;
- applies the same walkability, 3D node identity, hiking preference, and cost
  model used by live routing;
- builds a disk-backed global node and edge index;
- assigns deterministic global node and edge IDs;
- writes fixed-point columns in strict ID order;
- emits both `.bin` and `.bin.br` for every non-empty cell;
- writes CRC32-protected v3 headers containing the release `datasetBuildId`;
- creates `manifest.json` and the complete SHA-256 `integrity.json` inventory;
- atomically replaces the configured binary release only after completion.

Raw `.bin` files remain local because full verification compares their semantic
content with the Brotli round trip. Only `.bin.br` objects are intended for
public delivery.

The browser also validates three manifest-level topology invariants before it
marks loaded cells as eligible for future frontier certification:

```json
{
  "sourceCellAssignment": "full-feature-bbox-overlap-no-clipping",
  "edgeOwnership": "global-id-with-logical-cell-references",
  "nodeIdentity": "shared-compiler-quantized-xyz"
}
```

These values guarantee that complete source features are retained across cell
boundaries and that nodes and edges keep one stable national identity. They do
not change the binary byte layout, but they are part of the runtime compatibility
contract. A release that omits or changes one of them is rejected rather than
silently enabling a bounded-route certificate on incompatible data.

The temporary compiler output is created in the operating-system temporary
directory. The SQLite build database is removed after a successful run unless
`--keep-database` is supplied.

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

This command is an offline publication gate and may use substantial memory. It
is not browser work.

## 7. Publication prerequisites

The publication script currently targets an S3-compatible Cloudflare R2 bucket
through rclone. Configure a local rclone remote with object read/write access to
the chosen bucket. Bucket-creation permission is unnecessary because the upload
script uses `--s3-no-check-bucket`.

Keep all access keys in rclone's machine-local configuration. Do not place
credentials, account identifiers, or private endpoint URLs in the repository.
A deployment-specific runbook can record non-secret infrastructure names and
console settings, but that runbook should remain outside version control.

The public endpoint must satisfy these contracts:

- HTTPS is available and HTTP requests redirect to HTTPS;
- the configured application origin receives a matching
  `Access-Control-Allow-Origin` header;
- `GET` requests are permitted by CORS;
- `.bin.br` objects retain `Content-Encoding: br`;
- release objects retain `Cache-Control: public, max-age=31536000, immutable`;
- non-standard binary extensions are eligible for the CDN cache;
- published release roots are immutable.

A custom domain is recommended for production. Provider development URLs can be
useful during setup but may be rate-limited or omit production caching features.

## 8. Publish an immutable release

Preview the operation without modifying remote storage:

```powershell
.\scripts\upload-routing-dataset-r2.ps1 -DryRun
```

Publish the configured release:

```powershell
.\scripts\upload-routing-dataset-r2.ps1
```

The script performs this sequence:

1. complete local verification;
2. generation of publication-only metadata containing compressed objects;
3. upload of all `.bin.br` cells with Brotli content metadata;
4. remote size and checksum comparison;
5. upload of `integrity.json`;
6. upload of `manifest.json` last;
7. public verification of the manifest, integrity inventory, CORS, cache
   headers, Brotli transport decoding, and evenly distributed sample hashes.

`manifest.json` is the release-visibility switch. A failure before its upload
leaves the new release undiscoverable. Cells, integrity metadata, and the
manifest use a one-year immutable cache because the release identity is already
part of the URL.

Never overwrite a published release root. Corrected data must use a new
`datasetId`, `formatId`, or `scope` path. Publishing a new source edition under a
new path also prevents long-lived browser and edge caches from serving mixed
releases.

## 9. Verify an existing public release

Rerun public verification without uploading:

```powershell
npm run verify:published-routing
```

This command compares the public release with the local release selected by
`routing-data.config.local.json`. Before running it, confirm that the local
`datasetId`, `formatId`, and `scope` identify the same release as the public URL.
A manifest mismatch often means that the local configuration still points to a
different annual source edition or an experimental build.

To verify another URL explicitly:

```powershell
npm run verify:published-routing -- --base-url "https://data.example.org/swisstlm3d-YYYY/format-v3/ch"
```

When bypassing the configured public URL, also supply `--origin` when required
by the verifier.

For a direct cache and CORS check, request the same object twice with the
application origin:

```powershell
$url = "https://data.example.org/swisstlm3d-YYYY/format-v3/ch/manifest.json"

curl.exe -sS -D - -o NUL `
  -H "Origin: https://app.example.org" `
  $url
```

A healthy production setup normally returns `200`, the expected CORS and cache
headers, then changes from `CF-Cache-Status: MISS` to `HIT` on a repeated request
from the same Cloudflare location.

## 10. Activate the release in the application

Set the complete public release directory in the git-ignored `.env.local`:

```env
VITE_ROUTING_DATA_BASE_URL=https://data.example.org/swisstlm3d-YYYY/format-v3/ch
```

Restart Vite after changing the value. The URL must identify the directory that
contains `manifest.json`; do not provide only the domain root.

Use the browser network panel to confirm that the manifest and `.bin.br` cells
come from the intended host. Test representative routes in contrasting Swiss
regions before changing the production deployment.

## 11. New source-edition checklist

For a new official swissTLM3D edition:

1. obtain and archive the new official GeoPackage;
2. change `datasetId` and `sourceGeoPackage` in the local maintenance
   configuration;
3. keep `formatId` unchanged unless the binary encoding itself changed;
4. generate the normalized geometry cells;
5. generate the binary release;
6. run complete local verification;
7. compare counts, sizes, parse errors, largest cells, and representative routes
   with the previous release;
8. run a publication dry run;
9. publish under the new immutable release path;
10. run standalone public verification;
11. test several contrasting regions with the application configured to use the
    new release;
12. update the production `VITE_ROUTING_DATA_BASE_URL` only after local testing;
13. run `npm run build` before proposing repository changes.
