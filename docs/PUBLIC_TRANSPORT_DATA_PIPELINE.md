# Public-transport stop data pipeline

## 1. Purpose

The public-transport stop pipeline converts the official FOT/GeoAdmin national
`ch.bav.haltestellen-oev` download into one small immutable catalog consumed by
Via Helvetica. It handles only comparatively static stop positions and metadata.
Timetable departures remain dynamic and are never embedded in this artifact.

The source download, extracted work files, generated releases, R2 credentials,
and local publication configuration stay outside the repository.

## 2. Source data

Use the complete official GeoAdmin download for `ch.bav.haltestellen-oev` in
LV95 (`EPSG:2056`). The current pipeline expects the extracted
`PointExploitation.csv` table and validates the resolved columns before accepting
it as a national source.

The source asset is discoverable through the official GeoAdmin STAC API. A
manual download remains acceptable during development; the generator records a
SHA-256 of the exact selected CSV bytes, so the release identity does not depend
on a mutable download URL or a manually entered date.

Do not edit the official CSV before generation. If the source schema changes,
adapt and review the importer instead of weakening its plausibility checks.

## 3. Local development artifact

Generate the root-relative development artifact:

```powershell
npm run prepare:public-transport-stops-local -- "C:\Temp\haltestellen-oev"
```

This writes:

```text
public/local-data/public-transport-stops.json
```

The file is ignored by Git and stays directly readable by Vite. Local development
does not create or depend on a Brotli sibling; compression belongs only to the
immutable publication release.

Enable the static provider in `.env.local`:

```text
VITE_PUBLIC_TRANSPORT_STOPS_CATALOG_URL=/local-data/public-transport-stops.json
```

Leaving the variable unset keeps the GeoAdmin identify provider.

## 4. Generator safeguards

Before writing any artifact, the generator must identify a plausible national
`PointExploitation` table. It fails instead of guessing when the source no longer
matches the expected contract.

Current safeguards include:

- exact matching of known semantic source columns;
- a national-scale minimum record count;
- seven-digit DiDok service numbers;
- a broad LV95 coordinate plausibility envelope;
- a minimum share of rows carrying transport metadata;
- explicit logging of the concrete columns selected from the source.

The browser artifact additionally contains:

- source dataset id;
- content-derived `sourceRelease`;
- source CSV basename;
- complete source SHA-256 and source byte length;
- declared final record count;
- compact dictionaries and tuple records.

The browser validates this provenance and checks that `recordCount` equals the
serialized record-array length before building its in-memory index.

## 5. Immutable release layout

Prepare a release outside the repository:

```powershell
npm run prepare:public-transport-stops-release -- `
  "C:\Temp\haltestellen-oev" `
  --release-root "C:\Data\ViaHelveticaPublicTransport"
```

The generator derives the release path from the source SHA-256. A typical layout
is:

```text
C:/Data/ViaHelveticaPublicTransport/
  public-transport-stops-sha256-0123456789abcdef/
    format-v3/
      ch/
        stops.json.br
        release.json
```

`stops.json.br` is the Brotli quality-11 transport representation that will be
served publicly as `stops.json` with HTTP `Content-Encoding: br`. The decoded
JSON is reconstructed only in memory during verification and is not duplicated
in the release directory. `release.json` records source provenance, catalog
SHA-256, decoded and compressed sizes, schema identity, and record count.

Never overwrite a published release path. A source change changes the source
hash and therefore the dataset path. A schema change changes `format-vN`. The
release payload deliberately excludes a generation timestamp, so regenerating
the same source and format produces the same catalog bytes and remains compatible
with immutable publication.

Verify the generated release before publication:

```powershell
npm run verify:public-transport-stops-release -- `
  --source "C:\Data\ViaHelveticaPublicTransport\public-transport-stops-sha256-0123456789abcdef\format-v3\ch"
```

The verifier checks the manifest, Brotli byte length, decoded catalog hash and
byte length, provenance, and record count by decompressing `stops.json.br` in
memory. The R2 upload script runs this verification again automatically before
its first write.

## 6. R2 prerequisites

Publication uses an existing rclone S3-compatible remote. Keep all R2 access
credentials in rclone's machine-local configuration.

Copy:

```text
public-transport-data.config.example.json
```

to the Git-ignored:

```text
public-transport-data.config.local.json
```

Then configure:

- `releaseRoot`: the exact generated `.../format-v3/ch` directory;
- `publication.remote`: local rclone remote name;
- `publication.bucket`: target R2 bucket;
- `publication.publicRootUrl`: public custom-domain root for static data;
- `publication.publicOrigin`: deployed Via Helvetica origin allowed by CORS.

The public bucket/domain must permit browser `GET` requests from the configured
application origin. A production custom domain is preferred over an `r2.dev`
development endpoint so normal Cloudflare caching controls are available.

## 7. Publication metadata contract

R2 stores the compressed bytes under the browser-facing key `stops.json` with:

```text
Content-Type: application/json; charset=utf-8
Content-Encoding: br
Cache-Control: public, max-age=31536000, immutable
```

The browser therefore fetches a normal JSON URL and receives decoded JSON bytes
through standard HTTP content decoding. It does not know about `.br` and does
not run a JavaScript decompressor.

`release.json` uses the same one-year immutable cache without content encoding.
The publication script uploads `stops.json` first and `release.json` last so published
provenance never claims a complete release before the catalog exists. Application
rollout is controlled separately by `VITE_PUBLIC_TRANSPORT_STOPS_CATALOG_URL`.

## 8. Publish

Preview the upload:

```powershell
.\scripts\upload-public-transport-stops-r2.ps1 -DryRun
```

Publish:

```powershell
.\scripts\upload-public-transport-stops-r2.ps1
```

The script:

1. verifies the complete local release, including the Brotli round trip;
2. reads the validated release identity and derives the immutable remote path;
3. uploads the Brotli catalog as `stops.json` with HTTP Brotli metadata;
4. uploads `release.json` last;
5. verifies the release through the configured public URL.

A real upload uses `rclone --immutable`; an existing release path must therefore
be treated as read-only rather than corrected in place.

## 9. Public verification

The upload script runs public verification automatically. It can also be run
explicitly:

```powershell
npm run verify:published-public-transport-stops -- `
  --base-url "https://data.example.org/public-transport-stops-sha256-0123456789abcdef/format-v3/ch" `
  --source "C:\Data\ViaHelveticaPublicTransport\public-transport-stops-sha256-0123456789abcdef\format-v3\ch" `
  --origin "https://viahelvetica.example.org"
```

Verification checks:

- public release identity against the local manifest;
- CORS for the application origin;
- `application/json` metadata;
- one-year immutable cache metadata;
- `Content-Encoding: br` for `stops.json`;
- decoded byte length and SHA-256 against the local release;
- catalog provenance and record count after JSON parsing.

## 10. Application configuration

After a release passes public verification, configure the application with its
immutable object URL:

```text
VITE_PUBLIC_TRANSPORT_STOPS_CATALOG_URL=https://data.example.org/public-transport-stops-sha256-0123456789abcdef/format-v3/ch/stops.json
```

The application loads the catalog only when the public-transport layer is first
used. The GeoAdmin identify implementation remains available as the fallback
while the static provider is still being rolled out and validated.

## 11. Updating the dataset

For a new official source publication:

1. download and extract the new official dataset;
2. generate a new release from the untouched `PointExploitation.csv`;
3. inspect the resolved columns, accepted row count, source SHA-256, and sizes;
4. run `npm test` and `npm run build` when application code changed;
5. publish under the newly derived immutable path;
6. verify the public release;
7. update `VITE_PUBLIC_TRANSPORT_STOPS_CATALOG_URL` to the new immutable URL;
8. retain the previous release until the application deployment using the new
   URL has been validated.

Do not introduce GTFS or timetable joins into this pipeline merely to remove rare
stops without current departures. The static catalog represents official stop
metadata; dynamic departure availability remains a separate concern.
