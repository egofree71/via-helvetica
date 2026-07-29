/**
 * Business context: centralizes routing values shared by the main-thread client,
 * the routing worker, and pure cell-selection helpers. Keeping the snapping
 * radius outside the graph implementation avoids pulling the full router into
 * the application bundle only to calculate a first-waypoint cell footprint.
 */

/**
 * Maximum user-to-network snapping distance in metres. Larger values may
 * attach a waypoint to an unrelated road.
 */
export const MAX_SNAP_DISTANCE = 260;

/**
 * Maximum direct distance in metres between consecutive waypoints when network
 * routing is enabled. Above 15 km a single section no longer describes the
 * hiker's intended corridor reliably; lowering the value requires more
 * waypoints, while raising it permits more ambiguous and expensive searches.
 */
export const MAX_NETWORK_SECTION_DIRECT_DISTANCE_METERS = 15_000;

