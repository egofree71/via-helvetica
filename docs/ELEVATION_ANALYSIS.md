# Elevation Profile Exploration

> **Status: exploratory analysis, not an adopted architecture decision.**
>
> This document records the investigation performed in August 2026 around
> elevation profiles, ascent/descent consistency, GeoAdmin `profile.json`, GPX
> round-trips, long itineraries, and possible future alternatives. The current
> runtime architecture remains defined by `docs/ARCHITECTURE.md` and the source
> code. Nothing in this document should be treated as a commitment to change the
> current elevation provider or sampling convention.

## 1. Why this investigation started

The investigation began after a Via Helvetica route showed a noticeably lower
ascent/descent value after GPX export and re-import. The initial hypothesis was
that GPX export was losing elevation information. That hypothesis was rejected:
the exported GPX preserved a dense elevation series, while the difference was
caused mainly by the two runtime paths using different elevation sampling rules.

The baseline implementation examined during this investigation has two main
behaviours:

- an editable route requests an elevation profile from GeoAdmin and accumulates
  ascent/descent directly over the valid points returned by the provider;
- an imported GPX with complete embedded elevations is resampled on a regular
  distance grid targeting roughly 20 metres before ascent/descent is accumulated.

If imported GPX elevations are incomplete, Via Helvetica falls back to GeoAdmin.
Independent GeoAdmin-backed segments share a global sampling budget.

This means that a route created in Via Helvetica and the same geometry imported
from a GPX do not necessarily use the same sampling density. The investigation
asked whether that difference is a product problem, whether a common sampling
rule would improve the situation, and what new constraints such a rule would
introduce.

## 2. Baseline implementation details

The examined `src/metrics/routeMetrics.ts` defines these relevant parameters:

- `PROFILE_SAMPLE_INTERVAL_METERS = 20` as the target spacing used to size
  regular imported-GPX profiles and GeoAdmin requests;
- `PROFILE_MAX_SAMPLE_POINTS = 1_000` as a global safety budget for GeoAdmin
  requests and as a per-segment cap for complete embedded GPX elevations;
- `PROFILE_MAX_INPUT_COORDINATES = 4_000` as the maximum amount of route
  vertices sent to GeoAdmin;
- `PROFILE_SMOOTHING_OFFSET = 2` as the provider smoothing parameter.

For one continuous GeoAdmin-backed route, the requested `nb_points` is roughly
`distance / 20 m`, capped at 1,000. The current code then accumulates the actual
valid response points returned by GeoAdmin without resampling them again.

For a GPX with complete `<ele>` values, each independent GPX segment is sampled
on its own regular grid, targeting roughly 20 metres and capped at 1,000 points
for that segment. For GeoAdmin-backed independent segments, the 1,000-point
budget is instead shared across all measurable segments.

These rules are intentionally documented here because later experiments showed
that the meaning of the 1,000-point constant changes significantly if a regular
client-side normalization is also applied to GeoAdmin responses.

## 3. What the GeoAdmin HAR revealed

A browser HAR captured six successive `profile.json` requests while an editable
route was being extended. Each request contained the complete current route,
not only the newly added routing section.

Observed request growth:

| Request | Input vertices | Distance | `nb_points` |
| --- | ---: | ---: | ---: |
| 1 | 99 | 1,375 m | 70 |
| 2 | 178 | 2,718 m | 137 |
| 3 | 450 | 4,837 m | 243 |
| 4 | 626 | 7,026 m | 352 |
| 5 | 739 | 7,757 m | 389 |
| 6 | 755 | 7,964 m | 399 |

The most important observation was that `nb_points` did **not** behave as a hard
maximum for the response. In the final captured request, 755 vertices were sent
with `nb_points=399`, while GeoAdmin returned 813 profile points.

Across the six captured responses, the investigation found that all input
vertices were represented in the returned profile and that GeoAdmin inserted
additional subdivisions where input segments were longer than the effective
requested spacing. This is an empirical observation from the captured traffic,
not a provider contract documented by Via Helvetica.

Consequences:

- the density of a GeoAdmin response can be substantially higher than
  `nb_points` when the input geometry is already dense;
- the baseline editable-route ascent/descent therefore depends partly on the
  density of the routing geometry sent to GeoAdmin;
- the current 1,000-point `nb_points` cap does not imply that ascent/descent is
  calculated from at most 1,000 returned points.

The current asynchronous lifecycle was also found to be sound: profile requests
are debounced, superseded requests are aborted, and a result is associated with
the exact immutable segment-array identity that initiated it so stale results
cannot replace newer itinerary state.

## 4. GPX round-trip measurements

Two real Morges-St-Prex GPX cases were used to quantify the difference between a
dense provider-derived elevation series and a regular 20-metre grid.

| Case | Dense/raw ascent | Regular ~20 m ascent | Difference |
| --- | ---: | ---: | ---: |
| Morges-St-Prex, first capture | 133.00 m | 120.15 m | -9.7% |
| Morges-St-Prex, second capture | 108.90 m | 101.32 m | -7.0% |

The exported GPX itself was not the main source of the difference. Its geometry
and elevations were sufficiently dense; the difference appeared when the
embedded elevations were resampled during import.

A later manual Via Helvetica comparison on a similar 7.4 km Morges-St-Prex route
showed 112 m ascent while editing and 107 m after GPX loading, a difference of
about 4.5%.

Manual product-level comparisons were also made with other Swiss hiking tools on
similar Morges-St-Prex routes:

| Tool | Route creation ascent | GPX-loaded ascent | Difference |
| --- | ---: | ---: | ---: |
| SuisseMobile | 168 m | 156 m | about -7.1% |
| Suisse Rando | 144 m | 132 m | about -8.3% |

These comparisons are useful only as product context. The tested route
geometries were not proven identical across applications, and their internal
elevation models, interpolation, smoothing, and GPX handling are unknown. They
do show that a creation-to-GPX round-trip difference of several percent is not,
by itself, evidence that Via Helvetica is unusable for hiking planning.

## 5. Product interpretation

The practical product requirement is not that ascent/descent be mathematically
identical after every export/import cycle. Elevation gain is sensitive to the
terrain model, input geometry, sampling interval, interpolation, smoothing, and
noise handling.

For Via Helvetica, the useful criterion is that elevation figures remain:

- plausible for a hiker preparing an itinerary;
- stable enough that small representation changes do not materially change the
  perceived effort of the route;
- internally understandable and testable;
- free of length-dependent degradation large enough to mislead planning.

The manual comparisons above reduced the urgency of pursuing exact GPX
round-trip equality. A several-percent difference on a short route can be
acceptable when it does not alter the practical assessment of the hike.

## 6. Explored regular normalization

An experimental branch applied one common client-side regular sampling rule to
both GeoAdmin-backed routes and imported GPX elevations. A 20-metre grid was
chosen because it is coarser than the roughly 8-metre median spacing observed in
the examined provider-derived sources and therefore reduces sensitivity to the
accidental density of routing geometry.

Measured on the two real Morges-St-Prex files:

| Sampling | First case | Second case | Interpretation |
| --- | ---: | ---: | --- |
| Dense/raw | 133.00 m | 108.90 m | Maximum retained detail; geometry-density dependent |
| 5 m | 130.22 m | 107.33 m | Close to dense source; little decoupling |
| 10 m | 128.62 m | 105.76 m | Partial decoupling |
| 20 m | 120.15 m | 101.32 m | Stronger decoupling from source density |

This experiment clarified a genuine trade-off: a coarser regular grid improves
reproducibility across source geometries, but it also removes real short-scale
terrain variation. Neither the dense profile nor a 20-metre profile is an
absolute definition of the "true" ascent; they represent different measurement
conventions.

The experiment was therefore useful even though the normalization change was
not considered clearly necessary from a hiker-facing product perspective.

## 7. The 1,000-point regression discovered by the experiment

The regular-normalization experiment exposed an important hidden coupling in the
existing constants.

Before the experiment, `PROFILE_MAX_SAMPLE_POINTS = 1_000` primarily limited the
requested `nb_points`. Because GeoAdmin could still return all dense input
vertices, the editable-route ascent/descent could be accumulated from more than
1,000 points.

When the same 1,000-point value was reused as a hard cap for the **final regular
client-side metric profile**, it became a true resolution limit:

| Route length | 20 m target | Final points with 1,000 cap | Effective spacing |
| --- | ---: | ---: | ---: |
| 10 km | 501 | 501 | ~20 m |
| 20 km | 1,001 | 1,000 | ~20 m |
| 40 km | 2,001 | 1,000 | ~40 m |
| 60 km | 3,001 | 1,000 | ~60 m |
| 100 km | 5,001 | 1,000 | ~100 m |

This would make the metric progressively coarser as the itinerary grows. The
investigation therefore rejected using one constant simultaneously as a network
request budget, a metric-resolution cap, and a possible display-resolution cap.
These are separate concerns.

A synthetic long-route analysis showed that such length-dependent coarsening can
underestimate accumulated ascent materially. Exact percentages depend strongly
on terrain shape, so those synthetic figures should not be interpreted as a
national accuracy estimate. The architectural conclusion is the important part:
if Via Helvetica ever adopts a fixed metric sampling convention, that convention
must not silently degrade only because the itinerary is long.

## 8. Long itineraries and straight sections

The baseline GeoAdmin path sends at most 4,000 route vertices. If the input
routing geometry is sufficiently dense, that can still provide source points
finer than 20 metres for routes up to roughly 80 km. Beyond that distance, a
4,000-vertex input cannot by itself guarantee a source spacing below 20 metres.

This is only an order-of-magnitude observation, not a guarantee: vertex spacing
is not uniform and depends on the route geometry.

Straight sections are a special case because they may contain only their two end
vertices. Their intermediate elevation density therefore depends much more
directly on GeoAdmin subdivision behaviour and the requested `nb_points`.

If a future requirement demands a guaranteed metric resolution for very long
routes, Via Helvetica should first separate provider request limits from metric
sampling. Splitting long provider requests is a possible fallback if provider
limits prevent requesting sufficient source density.

## 9. Section-level caching was considered and deferred

The HAR confirmed that Via Helvetica requests the complete current route after a
committed route change. Caching unchanged routing sections could reduce repeated
GeoAdmin work, but no current performance problem justified the added state.

The main complications are:

- provider smoothing around section boundaries;
- invalidation after waypoint insertion, deletion, or movement;
- reconciliation of partial asynchronous results;
- preservation of the existing simple stale-result protection;
- ensuring one global sampling convention rather than per-section phase shifts.

If section-level caching is revisited, the safer model is to cache **raw provider
responses** for immutable sections and build one global normalized metric profile
after concatenation. Caching already-normalized per-section profiles would make
results depend on edit history and section boundaries.

## 10. Local swissALTI3D tiles were explored as a future provider

A separate architecture exploration considered preprocessing swissALTI3D into
versioned static elevation tiles published on R2, analogous in deployment style
to the precomputed routing dataset.

The attraction is architectural rather than a response to the current GPX
round-trip difference:

- core profile calculation would no longer require the dynamic GeoAdmin profile
  API at runtime;
- route, GPX, straight sections, and SwitzerlandMobility geometry could all query
  one elevation function;
- metric resolution and smoothing would be fully controlled by Via Helvetica;
- a GeoAdmin outage would no longer remove ascent/descent calculation when the
  static Via Helvetica data distribution remains reachable.

The exploration found the idea technically viable but not currently justified by
product need. A raster provider would require a new generation pipeline, binary
format, verifier, loader/cache, interpolation rules, edge handling, smoothing,
provenance documentation, and validation against real hiking routes.

Preliminary estimates suggested that a derived DEM around 10-metre resolution
would be a rational source for a 20-metre metric convention, and that altitude
cells should use a substantially smaller geographic size than the 2,400-metre
routing grid because a profile consumes a narrow one-dimensional corridor rather
than a two-dimensional routing neighbourhood. These estimates were exploratory
only and must be re-measured from real source data before implementation.

Attaching elevations directly to the routing graph was also considered. It would
be much smaller and almost free at runtime, but it cannot provide one common
altitude definition for arbitrary imported GPX geometry, straight sections, or
provider geometries that do not coincide with routing nodes. It was therefore
not considered a complete replacement for the elevation service.

## 11. Current decision

No elevation-behaviour change is adopted solely as a result of this exploration.
The existing implementation remains acceptable for the current hiking-planning
product based on the measurements available so far.

In particular:

- exact equality between route creation and GPX re-import is **not** a product
  requirement;
- the experimental common 20-metre normalization should not be merged merely to
  obtain numerical round-trip equality;
- the experiment's discovery about the 1,000-point cap should be retained as a
  warning for any future normalization work;
- a local swissALTI3D provider remains an architectural option, not a current
  roadmap commitment.

The exploration should be reopened if a concrete user-facing problem appears,
if GeoAdmin changes or restricts the profile service, if profile availability
becomes a reliability concern, or if Via Helvetica deliberately adopts a single
explicit metric-resolution convention across all itinerary sources.

## 12. Validation questions for future changes

Any future elevation change should be tested against a representative matrix,
not only one short GPX round-trip:

- short, medium, and long routes, including routes beyond 20 km and 80 km;
- low-relief and alpine terrain;
- normal routed sections and long straight sections;
- complete-elevation GPX and GPX requiring provider fallback;
- single-segment and genuinely multi-segment itineraries;
- selected SwitzerlandMobility routes;
- route creation, GPX export, re-import, conversion to editable form, edit, and
  undo back to the pristine conversion;
- ascent/descent, Swiss hiking-time estimate, profile shape, and GPX export;
- cancellation and stale-result behaviour during rapid edits.

The goal of such validation should be practical hiking usefulness and stable
behaviour, not equality to a single external number at metre precision.
