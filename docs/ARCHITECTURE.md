# Via Helvetica Architecture

## Executive summary

Via Helvetica is a map-centered, frontend-only application for planning one
hiking route at a time in Switzerland. React owns the user-interface state,
OpenLayers owns the imperative map runtime, and a dedicated Web Worker owns the
CPU- and network-intensive routing engine. The application is deployed as static
files on GitHub Pages and has no project-owned backend, user database, account
system, or remote route storage. Localized static entries at `/fr/`, `/de/`,
`/it/`, and `/en/` expose language-specific discovery metadata while loading
the same React/OpenLayers application.

The map and internal geometry use the Swiss LV95 projection (`EPSG:2056`).
Official swisstopo backgrounds and geodata are loaded directly from federal
services. Editable routes are stored as immutable route states with exact
section geometry, which makes undo, redo, reversal, and loop operations
predictable. Imported GPX itineraries remain read-only and deliberately do not
enter editable-route history.

Routing is an experimental browser-side capability. It loads bounded
swissTLM3D cells around user-selected positions, builds a regional walkable
graph, snaps waypoints, and runs A* inside a Worker. Optional hiking geometry may
improve route preference, but provider degradation must not disable the required
road-and-path network. Runtime routing details live in
[ROUTING.md](ROUTING.md); offline import, generation, and publication live in
[ROUTING_DATA_PIPELINE.md](ROUTING_DATA_PIPELINE.md).

Information overlays—hiking closures, military danger zones, and public-
transport stops—remain independent from route calculation. They inform the user
but do not silently alter routing costs or connectivity.

## Technology stack

- React and TypeScript provide the user interface and application-state
  composition.
- OpenLayers and `proj4` provide the native LV95 map runtime and coordinate
  transforms.
- A dedicated Web Worker isolates routing-data loading, graph assembly,
  snapping, and A*.
- Vite provides development and static multi-page builds.
- Vitest and JSDOM provide deterministic regression tests.
- GitHub Actions and GitHub Pages provide continuous validation and static
  deployment.

## 1. Product and architectural constraints

### 1.1 Product focus

The application intentionally remains narrow in scope:

- the map occupies almost the complete viewport;
- only one current itinerary is shown at a time;
- an editable route can be created, reshaped, reversed, closed, and exported;
- one external GPX route can replace it as a read-only itinerary;
- no route library, account system, or collaborative workspace is planned for
  the current product scope;
- the application is a planning aid, not a live-navigation or tracking tool.

The complete user-facing feature list belongs in the
[README](../README.md). This document concentrates on internal structure and
cross-module decisions.

### 1.2 Static, no-account operation

The production deployment contains only static assets. The browser contacts
external map and geodata providers directly and performs route calculation in a
Web Worker.

This constraint provides several benefits:

- no registration is required;
- routes are not uploaded to a project-owned service;
- there is no application database to operate;
- recurring infrastructure cost remains low;
- GitHub Pages can host the public application at
  [viahelvetica.ch](https://viahelvetica.ch/).

The current precomputed national routing dataset remains static object storage,
not a project-owned application service. A future backend is not forbidden, but
it should be introduced only after measured routing quality, provider limits, or
real usage justify the operational cost.

### 1.3 Official-data preference

The map, topographic network, and safety information rely primarily on official
Swiss sources. Provider-specific limitations are handled explicitly: optional
enrichment should degrade before core route editing becomes unavailable.

### 1.4 Map-centered interface

Permanent controls remain small and float over the map. Larger surfaces are
contextual and temporary:

- layer selector;
- route action strip;
- information popups;
- elevation profile;
- GPX export dialog;
- one-time release-highlights dialog;
- About dialog.

The responsive layout resolves collisions by moving small controls rather than
permanently reserving large strips of viewport space. The route summary stays on
the bottom edge, while the About control joins the right-side control stack when
horizontal space becomes tight. The metric scale is hidden at phone widths where
it would otherwise remain covered by the summary. Tall temporary dialogs use the
dynamic mobile viewport height, with a conventional viewport fallback, so browser
address and navigation bars cannot cover their header or footer.

### 1.5 Explicit workflow boundaries

The application preserves three important boundaries:

1. **Editable route versus imported GPX** — imported geometry never becomes
   editable-route history.
2. **Information overlays versus routing** — closures, danger zones, and stops
   inform the user without changing the graph.
3. **React state versus OpenLayers runtime** — React coordinates workflows;
   OpenLayers objects remain behind focused imperative modules and hooks.

## 2. System context

```mermaid
flowchart LR
    User[User] --> UI[React UI]
    UI <--> Map[OpenLayers map runtime]
    UI <--> Worker[Routing Web Worker]

    Map --> WMTS[swisstopo WMTS]
    Map --> WMS[GeoAdmin WMS]
    UI --> Search[GeoAdmin SearchServer]
    UI --> Identify[GeoAdmin identify and popup APIs]
    UI --> Elevation[GeoAdmin elevation profile]
    UI --> Timetable[transport.opendata.ch]
    Worker --> Identify
    Worker --> RoutingData[Versioned binary routing cells]

    UI --> FileAPI[Browser File API]
    UI --> Geolocation[Browser Geolocation API]
    UI --> Fullscreen[Browser Fullscreen API]

    Build[GitHub Actions] --> Pages[GitHub Pages]
    Pages --> User
```

### 2.1 External providers

| Provider or API | Purpose | Failure impact |
|---|---|---|
| Federal WMTS (`geo.admin.ch`) | Color, grey, aerial, hiking-trail, and SwitzerlandMobility hiking portrayals | Initial base-map failure is blocking; optional or later isolated tile failures are not |
| GeoAdmin SearchServer | Official place search | Localized, retryable search failure |
| GeoAdmin identify | swissTLM3D routing data and map-feature inspection | Routing requests may fail; information overlays remain non-blocking |
| GeoAdmin HTML popup | Localized closure and military metadata | Popup reports a local error without changing route state |
| GeoAdmin WMS | Closure, detour, and military danger portrayals | Overlay failure does not block map use |
| GeoAdmin elevation profile | Elevation, ascent, descent, and walking-time samples | Distance remains available; altitude-dependent metrics become unavailable |
| Versioned static routing storage | Optional precomputed Swiss graph cells used by the Worker | Coverage misses use GeoAdmin for the affected operation; persistent delivery, compatibility, or integrity failures switch the complete session to GeoAdmin |
| Federal Office of Transport data | Passenger-stop geometry and attributes | Optional stop layer may be incomplete or unavailable |
| transport.opendata.ch | On-demand departure board | Stop remains visible even when departures fail |
| Browser APIs | Local GPX, geolocation, fullscreen | Capability-specific failure only |

### 2.2 Coordinate systems

The map runtime, rendered overlays, editable route, imported route, and routing
graph use Swiss LV95 (`EPSG:2056`). This gives route distances, snapping
thresholds, hit tolerances, and routing cells a shared metre-based coordinate
system and avoids reprojecting the official WMTS map in the browser.

WGS 84 (`EPSG:4326`) is used only at exchange boundaries:

- browser geolocation input;
- SearchServer results and decimal WGS 84 coordinate input;
- GPX import;
- GPX export;
- geodesic calculations where required.

The search control also accepts LV95 directly and validates it against the
navigable map extent before publishing the selected point.

`src/map/projection.ts` registers LV95 through `proj4`, exposes the official
WMTS extent and resolution pyramid, and centralizes WGS 84/LV95 conversion.

## 3. Runtime composition

### 3.1 Component overview

```mermaid
flowchart TB
    App[App.tsx\ncomposition and workflow ownership]

    App --> RuntimeHook[useMapRuntime]
    RuntimeHook --> Runtime[mapRuntime.ts\nOpenLayers factory]

    App --> ViewHook[useMapViewControls]
    App --> InfoHook[useMapInformationLayers]
    App --> EditableHook[useEditableRoute]
    App --> InteractionHook[useRouteInteractions]
    App --> ImportedHook[useImportedRoute]
    App --> MetricsHook[useItineraryMetrics]

    EditableHook --> RoutingFacade[DynamicRoutingNetworkLoader]
    RoutingFacade --> RoutingWorker[Web Worker]

    Runtime --> Layers[Ordered raster and vector layers]
    InteractionHook --> Layers
    ImportedHook --> Layers
    MetricsHook --> Layers

    App --> Components[Presentational components]
```

### 3.2 Responsibility table

| Boundary | Main modules | Responsibility |
|---|---|---|
| Application composition | `src/App.tsx` | Connects focused hooks, resolves which temporary workflow owns the current itinerary, and owns modal state |
| Map lifetime | `src/map/mapRuntime.ts`, `src/map/useMapRuntime.ts` | Creates and disposes the single OpenLayers runtime; synchronizes startup and fullscreen state |
| Map controls | `src/map/useMapViewControls.ts`, `src/map/useMapLayerOpacities.ts`, `src/components/MapLayersSelector.tsx` | Background choice, persisted overlay visibility and opacity, zoom, fullscreen, and explicit geolocation |
| Information overlays | `src/map/useMapInformationLayers.ts`, `src/map/mapInformationViewport.ts`, `src/map/useSwitzerlandMobilityHikingSelection.ts`, `src/switzerlandMobility/hikingRoutes.ts` | Visibility, loading, inspection priority, click-anchor visibility beside temporary panels, public-route selection and fitting, popup state, caching, and cancellation |
| Editable-route domain | `src/map/routeState.ts`, `src/map/useEditableRoute.ts` | Immutable route state, history, snap mode, serialized mutations, and route actions |
| Pointer interaction | `src/map/useRouteInteractions.ts`, `src/map/routePointerInteraction.ts` | Waypoint and section hit detection, drag previews, click/drag lifecycle, and semantic edit requests |
| Route presentation | `src/map/routeDisplay.ts`, `src/map/itineraryDirection.ts`, `src/map/itineraryEndpoints.ts` | Committed geometry, previews, direction arrows, and A/B markers |
| Imported GPX | `src/import/gpx.ts`, `src/map/useImportedRoute.ts`, `src/map/importedRoute.ts` | Local parsing, projection, read-only display, elevation reuse, and responsive view fitting |
| Metrics | `src/metrics/routeMetrics.ts`, `src/metrics/useItineraryMetrics.ts`, `src/map/useRouteProfileSynchronization.ts` | Distance, elevation request identity, ascent/descent, hiking time, profile samples, and exclusive map/profile synchronisation for the active itinerary or selected public route |
| Routing | `src/routing/` | Worker protocol, bounded provider loading, caches, graph construction, snapping, and A* |
| Offline routing data | `routing-data.config.example.json`, `scripts/generate-routing-geometry-cells.py`, `scripts/generate-precomputed-binary-routing-graph.mjs`, `scripts/verify-routing-dataset.mjs`, `scripts/upload-routing-dataset-r2.ps1` | External source/work/release paths, national import, binary compilation, verification, and immutable R2 publication |
| Search | `src/search/locationSearch.ts`, `src/search/coordinateSearch.ts`, `src/components/LocationSearch.tsx` | Local WGS 84/LV95 parsing, provider contract, session cache, result UI, keyboard navigation, and request cancellation |
| Localization | `src/i18n/`, `scripts/generate-localized-pages.mjs` | Typed dictionaries, language persistence, locale paths, runtime document metadata, and generated localized HTML entries |
| Release history | `src/releases/`, `src/components/ReleaseNotesDialog.tsx`, `scripts/templates/releases.html` | Returning-visitor release acknowledgement, compact localized highlights with one explicit footer dismissal, a signposted new-tab history link, a distinct current-version display and history action in About, and generated indexable release-history pages |
| Static deployment | `.github/workflows/deploy.yml`, `vite.config.ts` | Test, build, Pages deployment, and root-relative production assets |

### 3.3 Application composition

`App.tsx` is intentionally a composition point rather than a second map engine.
It accesses one stable `MapRuntime` reference and coordinates independent
capabilities. The application uses no external global state store: focused hooks
own their domain and lifecycle state, while `App.tsx` composes their public state
and actions. Examples of cross-workflow coordination include:

- starting route creation clears an imported GPX and temporary search marker;
- a successful GPX import leaves route mode and clears editable history;
- opening the About dialog closes map-feature information;
- a newer release opens once for returning visitors after the initial map is
  usable, while first-time visitors and unavailable storage skip the courtesy
  dialog; closing it records only the acknowledged version in browser storage;
- selecting a SwitzerlandMobility route keeps the previous itinerary until complete
  public geometry has been validated, then clears editable history or an imported
  GPX and makes the selected public route the single current read-only itinerary;
- changing language updates the shareable locale path through the History API,
  clears temporary search state and provider selections, and preserves the
  loaded map and current itinerary;
- a valid import or route change becomes the single current itinerary for
  metrics.

Imperative OpenLayers sessions, provider requests, route history, and Worker
caches remain owned by focused hooks or modules rather than by `App.tsx`.

## 4. Core state model

### 4.1 Editable route

The editable route is represented by immutable `RouteState` snapshots.

A route contains ordered `RouteStep` values. Each step stores:

- the displayed waypoint;
- the exact geometry of the section arriving from the previous waypoint;
- the section mode: `network` or `straight`.

A closed route additionally stores one `RouteClosure` containing the exact final
section from the last waypoint back to the first. The closure does not create a
second visible start waypoint.

```mermaid
classDiagram
    class RouteState {
      steps: RouteStep[]
      closure: RouteClosure | null
    }
    class RouteStep {
      waypoint: Coordinate
      section: Coordinate[]
      mode: network | straight
    }
    class RouteClosure {
      section: Coordinate[]
      mode: network | straight
    }
    class RouteHistory {
      past: RouteState[]
      present: RouteState
      future: RouteState[]
    }

    RouteState "1" o-- "many" RouteStep
    RouteState "1" o-- "0..1" RouteClosure
    RouteHistory --> RouteState
```

Snapshot history is deliberate. Undo and redo exchange complete stored states,
so exact geometry is restored without recalculation or another provider request.
Moving, inserting, or deleting a waypoint, reversing the route, and closing or
reopening the loop each form one undoable edit. A new edit clears the redo
stack. Complete deletion clears route history intentionally.

### 4.2 Imported GPX

An imported GPX is the current itinerary but not an editable route. It remains a
collection of independent projected segments so deliberate gaps between GPX
track segments are never connected artificially.

The import workflow owns:

- file-size validation;
- local XML parsing;
- stale-read protection;
- batched WGS 84 to LV95 projection;
- optional embedded elevations;
- read-only purple display;
- start/finish and direction markers;
- responsive `View.fit()` framing.

Starting a new editable route removes the imported itinerary without converting
it into route history.

### 4.3 Selected SwitzerlandMobility route

A selected public route is another read-only current itinerary. The selection
workflow retains independent LV95 segments, public identity metadata, calculated
metrics, and the elevation samples required by its profile and GPX export.

The previous editable route or imported GPX is cleared only after complete public
geometry has been retrieved and validated. Identification, overlap choice, or a
failed geometry request therefore cannot destroy the user's current itinerary.

### 4.4 Shared current-itinerary metrics

`useItineraryMetrics` receives either editable-route segments or imported-GPX
segments. It calculates distance immediately and then resolves altitude-
dependent values from embedded GPX elevations or the GeoAdmin elevation-profile
service.

Independent segments sent to the GeoAdmin profile service share one global
sampling budget. This keeps profile size bounded when provider geometry contains
genuine gaps instead of multiplying the normal limit by the number of parts.

Every asynchronous result is tied to the exact immutable segment-array identity
that requested it. Superseded requests are aborted, and stale responses cannot
update a newer itinerary.

The same profile samples support:

- ascent and descent;
- the Schweizer Wanderwege hiking-time estimate;
- the collapsible SVG profile;
- map-to-profile pointer lookup;
- profile-to-map pointer lookup.

## 5. Main workflows

### 5.1 Application startup

1. `main.tsx` mounts React and the language provider from either the root or a
   localized static HTML entry.
2. The language provider gives an explicit `/fr/`, `/de/`, `/it/`, or `/en/`
   path priority over stored and browser preferences, then keeps the path and
   document metadata synchronized without reloading the application.
3. `useMapRuntime` creates the single OpenLayers runtime after the map target is
   mounted.
4. `mapRuntime.ts` creates the LV95 view, explicit layer order, displays, and
   transient markers.
5. Focused hooks apply persisted background, overlay visibility, and opacity
   choices without recreating the map.
6. Once the initial map is usable, the current release dialog opens only for a
   returning visitor whose stored acknowledgement is older and whose browser can
   persist the dismissal. A first visit records the current version silently.
7. Optional providers begin work only when their layer, zoom, or user action
   requires it.

### 5.2 Editable-route creation

```mermaid
sequenceDiagram
    participant User
    participant UI as React route hooks
    participant Worker as Routing Worker
    participant Provider as Binary cells or GeoAdmin
    participant Map as OpenLayers display

    User->>UI: Click or tap waypoint
    alt Straight mode
        UI->>UI: Build direct section
    else Snapping enabled
        UI->>UI: Validate the 15 km direct section limit
        UI->>Worker: Snap or route request
        Worker->>Provider: Load missing bounded cells
        Provider-->>Worker: Graph cells or source geometry
        Worker->>Worker: Assemble graph, snap, run A*
        Worker-->>UI: Routed geometry or normal no-path result
        UI->>UI: Use straight fallback when appropriate
    end
    UI->>UI: Commit immutable RouteState
    UI->>Map: Rebuild route, markers, and arrows
    UI->>UI: Refresh metrics asynchronously
```

The first snapped waypoint loads only cells intersecting its maximum snapping
box. Before any later section reaches the Worker, the editable-route controller
checks that its intended endpoints are no more than 15 km apart in direct LV95
distance. The same product rule covers additions, waypoint movement, insertion,
deletion reconnection, and loop closure. A rejected edit keeps the committed
route unchanged and asks for an intermediate waypoint; explicit straight mode
remains unrestricted because it does not load swissTLM3D data.

Admitted sections load a corridor between the existing endpoint and the new
selection. The routing engine first tries a narrow corridor and retries once
with a wider corridor when coverage or graph connectivity is insufficient.

Normal absence of coverage is different from provider failure. Missing nearby
network data may produce a free first waypoint or a straight incoming section,
while request, parsing, and safety-limit failures leave the existing route
unchanged and surface an actionable message.

See [ROUTING.md](ROUTING.md) for cell selection, caching, provider fallback,
graph construction, snapping, and A*.

### 5.3 Route reshaping

Pointer interaction stays separate from route calculation:

- waypoint or route-section hit detection begins a possible gesture;
- pointer movement renders temporary straight previews only;
- dragging near a viewport edge auto-pans the OpenLayers view and keeps the
  preview attached to the coordinate under the stationary pointer;
- window-level pointer release, focus-loss, and page-visibility guards cancel an
  abandoned drag and stop its animation before restoring committed geometry;
- no routing request is performed during drag;
- release emits one semantic move, insertion, or deletion request;
- `routeEditing.ts` rebuilds only affected sections using the snap mode selected
  at release;
- the edit is committed as one immutable history entry;
- a failed recalculation restores the last committed display.

This separation keeps drag feedback responsive and prevents provider traffic for
every pointer movement.

### 5.4 Reversal, loop closure, and export

Route reversal reuses stored geometry rather than routing again. Open routes
reverse waypoint order and swap A/B endpoints. Closed routes rotate reversed
sections around the original start so the combined A/B marker stays at the same
physical point while travel direction changes.

Loop closure adds a dedicated final section and does not duplicate the start
waypoint. Closing and reopening are undoable snapshots.

GPX export:

- asks for a route name;
- simplifies each section independently so every waypoint remains exact;
- preserves independent read-only geometry as separate GPX track segments, so
  provider gaps are not connected artificially;
- merges valid elevation samples without creating centimetre-scale duplicate
  points;
- converts LV95 geometry to WGS 84;
- writes a GPX 1.1 track with metadata bounds;
- starts a local browser download.

### 5.5 GPX import

```mermaid
sequenceDiagram
    participant User
    participant Import as useImportedRoute
    participant Parser as import/gpx.ts
    participant Route as useEditableRoute
    participant Map as OpenLayers display
    participant Metrics as useItineraryMetrics

    User->>Import: Select local GPX file
    Import->>Parser: Validate and parse locally
    Parser-->>Import: Independent WGS 84 segments and elevations
    Import->>Import: Batch-project to LV95
    Import->>Route: Leave editing and clear editable history
    Import->>Map: Replace current itinerary with purple read-only display
    Import->>Map: Fit geometry after viewport stabilizes
    Import->>Metrics: Publish segments and optional elevations
```

A slower file read is ignored after a newer selection, route creation, or
unmount invalidates its session. Invalid imports leave the current itinerary
untouched.

### 5.6 Information-layer inspection

`useMapInformationLayers` owns one deterministic map-click pipeline outside
route mode:

1. already loaded public-transport stop vectors;
2. visible hiking closures;
3. visible SwitzerlandMobility hiking routes;
4. visible military danger zones.

The stop layer uses validated structured data and a project-owned popup. Closure
and military details arrive as official HTML fragments, pass through a strict
sanitizer, and are rendered inside project-owned popup wrappers. Selected
military geometry is highlighted in a separate vector layer.

For stop, closure, and danger-zone panels, the exact click coordinate remains
the visual anchor and the zoom remains unchanged. Stops use the smallest pan
needed to keep their point visible. A closure or danger-zone click that would be
hidden or leave too little surrounding context is placed near the centre of the
largest useful map region outside the measured panel. Panel size changes are
observed because timetable and provider content can arrive after the initial
render. This click-based rule avoids trying to fit a potentially long closure
line or a broad, irregular danger-zone polygon.

Visibility, zoom, language, and workflow changes abort obsolete requests and
clear stale selections. These overlays never mutate route geometry or routing
costs.

### 5.7 Search, geolocation, fullscreen, About, and releases

Location search first applies a strict local parser to the complete input. It
accepts decimal WGS 84 and Swiss LV95 coordinate pairs, detects safely reversible
axis order inside the Swiss map extent, and reports valid coordinates outside
that extent without contacting GeoAdmin. Unfinished input with strong coordinate
markers remains local and keeps the result panel closed, while ordinary numeric
place searches such as postal codes still reach SearchServer. Text searches then
use a bounded language-aware session cache and abort superseded uncached requests.
Provider labels are converted to plain text before React renders them. Selecting
a place frames the broader planning context; selecting an exact coordinate uses
the closer geolocation scale. Either result creates a temporary marker that is
cleared when a higher-priority workflow takes ownership.

Geolocation is requested only after explicit user action. A valid WGS 84
position is converted to LV95, checked against the configured extent, displayed,
and centered. Continuous tracking is not used.

Fullscreen requests target the complete application root. A
`fullscreenchange` listener remains the source of truth and schedules
`map.updateSize()` after viewport changes.

The About dialog contains project context, experimental-routing guidance,
creator and support details, source and license links, professional profile, a
link to the localized release history, and complete data credits. Its permanently
visible map control provides direct access to the centralized source references
without occupying additional map space.

The release dialog reads the current semantic version and the highlights marked
for compact display from `src/releases/releaseHistory.json`; history-only items
remain available on the static page. It opens only after the map has reached its
usable startup state, only for a returning visitor whose acknowledgement is
older, and only when at least one compact highlight exists. A first visit records
the current version silently. Because version 1.0.0 had no release key, the
existing language preference acts as the migration marker for a returning
visitor. Storage read or write failures suppress this courtesy dialog rather
than risking a modal that returns on every load. Closing
the dialog or opening the complete history stores the current version. The
history link visibly indicates that it opens a localized static page in a new
tab so the current itinerary is not lost.

## 6. Map and geodata integration

### 6.1 Native LV95 map

`src/map/config.ts` and `src/map/projection.ts` define the official LV95 WMTS
grid instead of using an XYZ/Web-Mercator shortcut. Base-map replacement keeps
the same view and overlays.

Selectable backgrounds include:

- official color national map;
- official grey national map, including its detailed source at close zoom;
- SWISSIMAGE aerial imagery.

The rendered hiking-trail layer and optional `ch.astra.wanderland` WMTS layer
add the ordinary official hiking portrayal and the green national, regional, and
local SwitzerlandMobility routes. The green layer starts disabled. Ordinary
hiking trails and trail closures start at 80% opacity, SwitzerlandMobility routes
and military danger zones at 60%, and public-transport stops at 100%; these
defaults balance readability with visibility of labels, roads, and terrain
underneath. The shared layer menu exposes an expandable opacity slider for every
information layer, bounded from 20% to 100%. Complete hiding remains the role of
the visibility toggle, avoiding an apparently enabled but invisible layer. A
layer's settings button is disabled while that layer is hidden, and its temporary
slider closes when visibility is removed because opacity changes would have no
visible feedback.

Only explicit slider changes are persisted in browser storage. Product defaults
therefore remain free to evolve for visitors who never adjusted a layer, and one
slider gesture updates only the corresponding OpenLayers portrayal. Visibility
and opacity preferences remain independent and do not recreate the map. Any
selection overlay created by an explicit click—selected SwitzerlandMobility
route, military danger zone, or public-transport stop—remains opaque while the
overview portrayal follows the visitor's chosen opacity.

The rendered portrayals remain independent from the vector hiking geometry used
to influence route costs.

### 6.2 Ordered layers

The runtime creates one explicit layer order. In broad terms:

1. selected raster background;
2. rendered hiking-trail portrayal;
3. optional green SwitzerlandMobility hiking routes;
4. selected SwitzerlandMobility route vector and closure WMS overlay;
5. public-transport and military information vectors and portrayals;
6. imported read-only itinerary;
7. editable route;
8. temporary search and user-location markers.

Route and endpoint readability takes priority over informational overlays.
Layer construction remains centralized so later features do not depend on
implicit insertion order.

### 6.3 SwitzerlandMobility route inspection

Outside route-creation mode, the information-layer click pipeline can identify a
feature beneath the optional `ch.astra.wanderland` portrayal. Identification first
requests public metadata only. A single match is selected immediately; when
several named routes share the same path, the compact bottom panel presents an
explicit chooser before any map movement.

After selection, a focused get-feature request retrieves the complete public
geometry in LV95. Once that geometry is validated, the workflow clears any
editable route or imported GPX and the public route becomes the single current
read-only itinerary. A temporary vector layer draws an opaque dark-green line with
a white casing above the semitransparent overview. The view fits the complete
selected geometry once, with responsive bottom padding for the panel and the same
maximum fit zoom and screen margins used by GPX imports. These margins keep route
endpoints clear of the search field, the right-side map controls, and the compact
bottom panel. Closing the panel clears the highlight and pending requests but
preserves the fitted map view, so an explicit close does not undo the user's new
navigation context.

The panel uses public route identity, route number, stage number, and localized
section text. Distance, ascent, descent, walking time, and profile samples are
calculated by Via Helvetica from the retrieved geometry and the existing
elevation-profile service; no SwitzerlandMobility editorial descriptions or photos
are reproduced. The profile is collapsed by default and reuses the same chart and
black map marker as editable routes and imported GPX tracks. The header export
action reuses the shared naming dialog and writes the complete selected geometry as
a GPX 1.1 track, preserving independent line segments and embedding calculated
elevations when available. A shared synchronization hook grants marker ownership
only to the visible summary. Starting route creation, hiding the layer, changing
language, selecting another map information feature, or opening another temporary
workflow clears the selection and profile state.

### 6.4 Hiking closures and military danger zones

Both safety layers use official server-rendered WMS portrayals and localized
feature inspection. They are enabled independently and persist their visibility
choice.

The returned information is advisory. Via Helvetica does not automatically
avoid a visible closure or military zone because:

- provider records may require human interpretation;
- current applicability may depend on dates or local conditions;
- information-layer availability should not change graph connectivity silently.

### 6.5 Public-transport stops

The source dataset contains passenger stops as well as technical, retired, and
operational records. Via Helvetica therefore loads vector features and applies a
project-owned normalization layer rather than rendering the complete source
portrayal.

The stop workflow separates:

- provider loading and recursive subdivision;
- passenger-mode normalization and filtering;
- buffered viewport reuse;
- OpenLayers rendering and collision fan-out;
- selected-stop presentation;
- on-demand timetable loading.

A buffered request extent reduces repeated traffic during nearby pans. Zoom,
canvas-size, language, or visibility changes invalidate reuse. Timetable errors
do not remove the selected stop or its official SBB/CFF/FFS links.

## 7. Routing boundary

Routing is a specialized subsystem with its own Worker, protocol, provider
strategy, caches, graph model, and validation scope. `ARCHITECTURE.md` documents
its contract with the rest of the application; algorithmic, binary-format, and
publication details belong in the dedicated routing documents.

The subsystem receives plain LV95 coordinates and returns structured-clone-safe
snap or route results. OpenLayers objects and React state never cross the Worker
boundary. Network loading, graph assembly, snapping, and A* therefore remain
isolated from the map and user-interface thread.

The required graph comes from official swissTLM3D roads and paths. GeoAdmin can
supply bounded source geometry at runtime, while an explicitly configured
versioned binary dataset can supply equivalent precompiled graph cells. Optional
hiking geometry influences route preference but is not required for basic
connectivity; if that enrichment becomes unavailable, required road-and-path
routing continues.

The provider session keeps the binary and GeoAdmin engines independent. Coverage
misses near the published dataset boundary use GeoAdmin only for the affected
operation. Persistent binary delivery, compatibility, or integrity failures
trigger a one-way fallback to GeoAdmin for the rest of the browser session, so
graph representations are never mixed and failed binary storage is not probed
again on every edit. Intentional cancellation does not cause fallback.

Precomputed releases are generated reproducibly from official swissTLM3D source
data outside the repository, published below immutable versioned roots, and
activated through `VITE_ROUTING_DATA_BASE_URL`. The browser reads only published
runtime artifacts; it never reads the maintainer's local source, workspace, or
publication configuration. Public verification checks object integrity, cache
metadata, and the browser-origin CORS contract before a release is considered
usable.

For provider selection, corridor policy, graph construction, snapping, A*, cache
behaviour, fallback semantics, tuning values, and runtime validation, see
[ROUTING.md](ROUTING.md). For the external filesystem, GeoPackage import, binary
build, verification, and immutable publication workflow, see
[ROUTING_DATA_PIPELINE.md](ROUTING_DATA_PIPELINE.md).

## 8. Performance and concurrency

### 8.1 Dedicated Worker

Network loading, optional source-geometry compilation, corridor graph joining,
snapping, and A* stay outside the React/OpenLayers thread. The map remains
interactive while routing work runs. Binary precomputed cells remove source
compilation and replace string-key and per-node object assembly with global
integer IDs, typed arrays, and CSR, while preserving the Worker boundary for
indexing and search.

### 8.2 Bounded work

Provider activity is constrained by:

- a 15 km product-level direct-distance limit checked before network work;
- regular routing cells;
- corridor-based loading rather than national data loading;
- a maximum cell count per operation;
- bounded request and cell concurrency;
- recursive subdivision only when provider result limits require it;
- one wider-corridor retry rather than unbounded expansion.

The national binary representation follows the same corridor and cell-count bounds,
but replaces recursive identify requests with one file request per non-empty
cell. Empty cells are resolved from the manifest without a request. Out-of-region
halo cells are ignored when a corridor still contains covered cells; a completely
out-of-region footprint remains an explicit coverage error. The binary provider
avoids runtime interpretation of source road attributes and performs numeric
rather than string-based cross-cell joining.

### 8.3 Session caches

The routing Worker keeps:

- a least-recently-used raw-cell cache with an approximate 64 MiB byte budget;
- reusable cell-owned in-flight requests with independent consumer cancellation;
- at most two exact-corridor graphs, additionally bounded by an approximate
  128 MiB retained-size budget.

The estimates deliberately over-approximate JavaScript object, adjacency, and
spatial-index overhead. One oversized current entry is retained so an active
operation can complete; real browser-memory measurements remain part of routing
validation.

The binary snapping index traverses only the 250 m buckets touched by each edge,
including both side buckets when a segment passes exactly through a grid corner.
This keeps index growth proportional to edge length rather than to the area of a
diagonal edge's bounding rectangle. A high linear bucket-count guard remains in
place to reject corrupted coordinates before they can exhaust the Worker heap.

Other focused caches include:

- language-specific location-search results;
- buffered public-transport viewport coverage;
- short stationboard responses;
- memoized directional-arrow geometry and styles;
- immutable elevation/profile samples.

Caches remain session-local and do not create persistence semantics.

### 8.4 Cancellation and stale-result guards

Every owner cancels work it supersedes:

- search effects abort older queries;
- information-layer changes abort identify and popup work;
- route mode changes abort active routing;
- new metrics abort older elevation requests;
- GPX sessions ignore obsolete file reads;
- Worker protocol messages support explicit cancellation.

Where platform work cannot stop immediately, request identity and immutable
references prevent obsolete completion from mutating current state.

### 8.5 Presentation performance

The route and elevation profile avoid unnecessary React churn:

- drag previews remain in OpenLayers rather than React state;
- direction arrows are resolution-aware and capped;
- cumulative geometry indexes support binary search;
- profile paths and graduations are memoized from immutable samples;
- pointer exploration updates only transient guide and marker state.

## 9. Error and fallback strategy

The general rule is to preserve the last usable state and localize failure to
the capability that caused it.

| Category | Strategy |
|---|---|
| Initial base map | Blocking startup error because the application is unusable without a map |
| Later raster tiles | Keep the already usable map; isolated failures are non-blocking |
| Search | Show a temporary localized error and allow immediate retry |
| Geolocation and fullscreen | Report capability-specific failure without changing route state |
| Information overlays | Keep map and route usable; abort stale work; show local popup or layer error |
| Routed section over 15 km direct distance | Preserve the current route and ask for an intermediate waypoint before Worker activity |
| Routing coverage miss | Free first waypoint or straight section fallback; keep snap mode enabled |
| Routing provider or parsing error | Preserve current route; report an actionable error |
| Optional hiking enrichment | Switch to roads-only mode and continue required routing |
| Elevation profile | Keep distance; show unavailable altitude-dependent figures |
| GPX validation | Leave current itinerary untouched and report a localized error |
| Timetable | Keep selected stop and official external links visible |

Intentional cancellation is not reported as a user-visible error. There is no
application-wide retry loop or persistent project-owned logging service.

## 10. Module boundaries

### 10.1 Map runtime versus React

`mapRuntime.ts` creates one disposable imperative object that contains the map,
view, ordered layers, displays, and transient markers. React hooks apply changes
through that stable runtime instead of recreating OpenLayers objects on each
render.

### 10.2 Network contracts outside components

Provider parsing, validation, retry, and cancellation live in domain modules:

- `src/search/locationSearch.ts`;
- `src/closures/trailClosures.ts`;
- `src/dangers/shootingDangerZones.ts`;
- `src/transport/`;
- `src/metrics/routeMetrics.ts`;
- `src/routing/`.

Components receive typed data and controlled state rather than raw provider
responses.

### 10.3 Presentation versus domain state

Route history and immutable transformations remain independent from OpenLayers
features. Display modules rebuild features from committed domain state and own
only transient previews or styling metadata.

### 10.4 Compatibility facades

Small facades such as `src/map/route.ts` and
`src/transport/publicTransportStops.ts` preserve stable import surfaces while
implementation responsibilities remain in focused sibling modules. They should
stay small and should not become new orchestration layers.

### 10.5 Localization boundary

General interface strings belong to typed French, German, Italian, and English
dictionaries. Adding a translation key must fail compilation until every
supported language provides it. Search and social metadata shared by the build
generator and runtime live in `src/i18n/seoMetadata.json`. Release announcements
and static history copy live in `src/releases/releaseHistory.json`; the generator
validates that versions and item identifiers match across all languages. Provider
identifiers and domain enums remain language-neutral.

The root URL remains the `x-default` negotiation entry and consolidates on
`/en/` for static discovery. On first application startup it is replaced, without
a reload, by the localized path resolved from persisted or browser preferences.
The four localized paths are static Vite HTML inputs with self-referencing
canonicals and reciprocal `hreflang` links. Selecting another language calls
`history.pushState()` rather than navigating, so OpenLayers, route history, and
imported GPX state are not recreated. A `popstate` listener restores the
corresponding interface language.

## 11. Testing and validation

### 11.1 Test strategy

Automated tests target stable domain contracts rather than browser canvas
appearance. The regression suite is organized around these validation areas:

- **Route state and editing** — immutable transformations and history, affected-
  section reconstruction, pointer-interaction primitives, direction arrows, and
  the 15 km network-section boundary before Worker work begins.
- **Current itineraries and metrics** — GPX parsing, projection, segmented
  read-only geometry, export, distance and elevation processing, the global
  profile-sampling budget, and map/profile synchronization.
- **Map and provider integration** — location-search parsing, caching and zoom
  policy; layer identifiers, defaults and preference persistence; public-
  transport normalization; information-click lifecycle and popup positioning;
  and SwitzerlandMobility identification, complete-geometry selection, fitting,
  export, and profile behaviour.
- **Localization, releases, and interface contracts** — locale-path priority,
  History API navigation, runtime metadata, release acknowledgement and
  localized identifiers, accessibility semantics, and compact layer controls.
- **Routing and offline data** — grid footprints, source-geometry validation,
  manifests and strict binary parsing, compiler equivalence, global-ID joining,
  typed-array A*, Worker correlation and cancellation, caching, retries, provider
  fallback, and typed failures.

Provider calls are mocked. Regression tests must not depend on live external
services.

### 11.2 Manual validation

OpenLayers canvas rendering and complete pointer workflows remain manually
validated where a browser-level test would cost more than it protects. Important
manual checks include:

- mouse, pen, and touch route editing, including edge auto-pan while moving or
  inserting a waypoint and cancellation after focus or pointer loss;
- responsive control collisions, translated layer-label wrapping, the release
  and About dialogs, and the expandable opacity sliders on narrow and short
  viewports;
- official hiking and SwitzerlandMobility portrayals across useful zooms and
  restored opacity preferences after a reload;
- selection, overlap choice, highlighting, full-route fitting, and profile
  synchronization for named SwitzerlandMobility routes;
- GPX fitting on narrow viewports;
- map/profile pointer synchronisation;
- provider portrayals and official popup content;
- stop, closure, and danger-zone clicks near panel and viewport edges on desktop
  and mobile layouts;
- routing behaviour in contrasting geographic regions.

The routing subsystem remains experimental until topology and provider behaviour
are validated in varied Swiss environments, including dense cities, mountains,
bridges, tunnels, borders, and sparse coverage.

### 11.3 Required commands

Before an important commit:

```bash
npm test
npm run build
```

GitHub Actions executes the same regression suite before the production build
and Pages deployment.

## 12. Deployment and discovery

The workflow `.github/workflows/deploy.yml` runs on pushes to `main` and manual
dispatch. It:

1. checks out the repository;
2. installs locked dependencies with `npm ci`;
3. runs `npm test`;
4. runs `npm run build`;
5. uploads `dist/` as a Pages artifact;
6. deploys to the `github-pages` environment.

The build accepts the optional GitHub repository variable
`VITE_ROUTING_DATA_BASE_URL`. When present, it embeds only the public versioned
dataset root; routing objects remain in external static object storage and do
not enter the Pages artifact. When absent, production keeps GeoAdmin as the
initial provider.

The custom domain serves the application at the root, so `vite.config.ts` uses:

```ts
base: '/'
```

GitHub Pages provides HTTPS, which is required for browser geolocation outside
`localhost`.

Production builds disable Vite's automatic public-directory copy and use a small
build plugin to copy ordinary public assets. The historical
`public/routing-data/` exclusion remains a guard against accidentally packaging
an old local experiment, but national releases are generated outside the
repository and loaded through their versioned public URL. Vite also ignores
legacy routing workspaces in its file watcher.

Before development and production builds, `scripts/generate-localized-pages.mjs`
creates `/fr/`, `/de/`, `/it/`, and `/en/` application entries from the root
template and `src/i18n/seoMetadata.json`. The same build step generates
`/releases/` plus `/fr/releases/`, `/de/releases/`, `/it/releases/`, and
`/en/releases/` from `scripts/templates/releases.html` and the shared release
history. Vite treats all entries as multi-page inputs and preserves their
directories in `dist/`, which lets GitHub Pages serve every localized URL
directly after a reload. Generated source directories are ignored by Git because
they are deterministic build inputs.

Generated application and release-history entries carry reciprocal localized
canonicals, `hreflang` links, social and structured metadata, and sitemap
coverage. The root application and history URLs remain `x-default` negotiation
entries whose canonical discovery signal points to English; the four localized
URLs are the canonical pages listed in the sitemap. One shared hiking photograph
serves social and search discovery rather than representing the application UI.

The rendered application also exposes one localized, visually hidden `h1`
without reducing the map area. Transient React interface text is excluded from
search-result snippets. These remain build and discovery concerns rather than
runtime application services.

## 13. Code and documentation conventions

- Keep strict TypeScript enabled.
- Centralize provider identifiers, projections, and geographic constants.
- Keep internal geometry in EPSG:2056 and transform only at exchange boundaries.
- Keep network contracts outside React components.
- Keep every user-facing string in all four typed dictionaries, keep shared
  search/social metadata complete in `seoMetadata.json`, and keep release history
  complete in every locale of `releaseHistory.json`.
- Sanitize provider HTML before rendering its limited semantic markup.
- Abort superseded asynchronous work and guard against stale completion.
- Preserve explicit OpenLayers layer ordering.
- Request privacy-sensitive browser capabilities only after explicit user input.
- Keep route history immutable and restore exact geometry without recalculation.
- Defer routing work during pointer dragging until release.
- Keep information overlays independent from route calculation.
- Give non-trivial modules a short business-context header.
- Comments should explain decisions, constraints, trade-offs, and safeguards—not
  paraphrase obvious code.
- Numeric tuning constants must state units and the effect of changing them.
- Use JSDoc for data contracts and complex public functions, including
  `@throws` where callers must handle failure.
- Explain sensitive algorithmic blocks such as A*, heaps, subdivision,
  concurrency, caches, and stale-result guards.
- Keep `README.md` concise and user-oriented.
- Update this document when module boundaries, primary workflows, deployment, or
  architectural constraints change.
- Update [ROUTING.md](ROUTING.md) when runtime routing data sources, graph
  behaviour, tuning, cache policy, fallback semantics, or validation scope change.
- Update [ROUTING_DATA_PIPELINE.md](ROUTING_DATA_PIPELINE.md) when local paths,
  source import, binary generation, verification, or publication changes.

## 14. Evolution criteria

Create a new abstraction when several modules genuinely repeat the same logic,
not merely because a future feature might need it.

Reconsider the current architecture when one or more of these conditions becomes
true:

- OpenLayers interactions become too numerous for focused hooks to coordinate;
- shared state no longer fits clearly behind `App.tsx` composition;
- multiple new providers require a common request policy;
- measured routing latency or reliability shows that browser-side bounded
  loading is no longer adequate;
- a national preprocessed graph would materially improve quality and can be
  operated sustainably;
- route persistence, collaboration, or accounts become explicit product goals;
- browser-level regression tests provide clear value over their maintenance
  cost.

New features should remain useful for Swiss hiking-route planning and should not
turn Via Helvetica into a general transport or geographic-information portal.

## 15. Key external specifications

- [OpenLayers documentation](https://openlayers.org/)
- [GeoAdmin feature identification](https://docs.geo.admin.ch/access-data/identify-features.html)
- [swissTLM3D landscape model](https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d)
- [GPX 1.1 schema](https://www.topografix.com/GPX/1/1/)
- [Vite documentation](https://vite.dev/)

Provider usage and attribution remain subject to the respective official terms.

## 16. Glossary

| Term | Meaning in Via Helvetica |
|---|---|
| A* | Shortest-path search used by the regional routing graph |
| GeoAdmin | Swiss federal geodata platform and APIs used by the application |
| GPX | XML exchange format used for route import and export |
| LV95 | Current Swiss national coordinate reference system |
| EPSG:2056 | EPSG identifier for LV95 |
| WGS 84 / EPSG:4326 | Longitude/latitude exchange coordinate system |
| WMTS | Tiled map service used for official raster backgrounds, hiking trails, and SwitzerlandMobility route portrayals |
| WMS | Map-image service used for closure and military overlays |
| swissTLM3D | Official topographic landscape model supplying roads, paths, and optional hiking geometry |
| Worker | Browser execution context that isolates routing loading and computation from the map UI |
| Snapping | Projection of a user-selected waypoint onto a nearby routable network segment |
| Straight fallback | Direct section stored when normal coverage or connectivity cannot produce a network path |
| Current itinerary | Either the editable route, one imported GPX, or one selected SwitzerlandMobility route, never several independent active routes |
