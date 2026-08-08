/**
 * Business context: owns the lifecycle of the single read-only GPX itinerary.
 * It validates and parses a user-selected file locally, converts geometry to
 * native LV95, reuses complete embedded elevations when possible, updates the
 * purple OpenLayers display, and frames the imported route without exposing
 * file-read sessions or stale-result guards to the application shell.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { Coordinate } from 'ol/coordinate.js';
import { isEmpty, type Extent } from 'ol/extent.js';
import type Map from 'ol/Map.js';
import type { Size } from 'ol/size.js';
import {
  MAX_GPX_FILE_SIZE_BYTES,
  parseGpxRoute,
} from '../import/gpx';
import type { TranslationKey } from '../i18n/translations';
import {
  createImportedRouteElevationSummary,
  type RouteElevationSummary,
} from '../metrics/routeMetrics';
import { IMPORTED_ROUTE_MAX_ZOOM } from './config';
import { updateImportedRouteDisplay } from './importedRoute';
import { calculateResponsiveMapFitPadding } from './viewFit';
import type { MapRuntime } from './mapRuntime';
import {
  fromWgs84Coordinates,
  LV95_STANDARD_SOURCE_MATRIX_INDICES,
  LV95_VIEW_RESOLUTIONS,
} from './projection';

/** Inputs required by the imported-GPX workflow. */
export interface UseImportedRouteOptions {
  /** Shared OpenLayers runtime containing the map and imported-route display. */
  mapRuntimeRef: RefObject<MapRuntime | null>;
  /** Typed interface translation helper. */
  t: (key: TranslationKey) => string;
  /** Clears incompatible workflows after a valid GPX has been fully prepared. */
  onImportAccepted: () => void;
  /** Publishes one localized import error through the shared route message area. */
  onImportError: (message: string) => void;
}

/** Retained source document for export and explicit swisstopo transfer. */
export interface ImportedRouteSource {
  /** Parsed itinerary name proposed by the export dialog. */
  name: string;
  /** Complete original GPX XML retained only while this read-only route is current. */
  gpxDocument: string;
}

/** State and actions exposed to the application shell and metrics pipeline. */
export interface ImportedRouteController {
  /** Independent projected GPX segments; an empty array means no imported route. */
  segments: Coordinate[][];
  /** Original GPX source retained only while the imported route remains current. */
  source: ImportedRouteSource | null;
  /** Embedded GPX profile summary, or null when GeoAdmin must provide elevations. */
  elevationSummary: RouteElevationSummary | null;
  /** Validates and loads one browser-selected GPX file. */
  importRouteFile: (file: File) => Promise<void>;
  /** Cancels pending reads and clears the current imported route immediately. */
  clearImportedRoute: () => void;
}

/** Map animation duration in milliseconds; long enough to reveal the framed route without feeling sluggish. */
const IMPORTED_ROUTE_FIT_DURATION_MS = 600;

/**
 * View padding in screen pixels. The larger bottom margin keeps the framed GPX
 * visible above the itinerary statistics and elevation profile controls.
 */
const IMPORTED_ROUTE_FIT_PADDING_PX: [number, number, number, number] = [
  80,
  80,
  180,
  80,
];

/** Minimum map width and height in pixels left available to display the GPX. */
const IMPORTED_ROUTE_MIN_FIT_AREA_PX = 160;

/**
 * Maximum animation frames spent waiting for the map size to settle after the
 * native file picker closes. This bounds the delay while covering mobile
 * viewport and browser-toolbar transitions.
 */
const IMPORTED_ROUTE_FIT_STABILIZATION_FRAME_LIMIT = 12;

/**
 * Two equal size readings are enough to avoid fitting against a transient
 * viewport.
 */
const IMPORTED_ROUTE_REQUIRED_STABLE_SIZE_READINGS = 2;

/**
 * Adapts desktop-oriented GPX framing margins to the current map size.
 * OpenLayers subtracts padding before calculating the fit resolution; leaving
 * too little effective height can otherwise select the country-wide zoom.
 *
 * @param size - Current OpenLayers viewport size in CSS pixels.
 * @returns Top, right, bottom, and left padding safe for that viewport.
 */
export function calculateImportedRouteFitPadding(
  size: Size,
): [number, number, number, number] {
  return calculateResponsiveMapFitPadding(
    size,
    IMPORTED_ROUTE_FIT_PADDING_PX,
    IMPORTED_ROUTE_MIN_FIT_AREA_PX,
  );
}

/** Finest native national-map resolution allowed by imported-route framing. */
const IMPORTED_ROUTE_MIN_FIT_RESOLUTION =
  LV95_VIEW_RESOLUTIONS[IMPORTED_ROUTE_MAX_ZOOM];

/**
 * Snaps one calculated fit resolution to a matrix actually published by the
 * standard swisstopo backgrounds. OpenLayers normally permits intermediate
 * resolutions, which can leave a raster background visibly resampled after
 * successive GPX fits. Choosing the next coarser native matrix keeps the whole
 * itinerary visible without stretching a tile level.
 *
 * @param requiredResolution - Resolution in LV95 metres per CSS pixel needed to fit the route.
 * @returns A native standard-map resolution that still contains the complete route.
 */
export function snapImportedRouteFitResolution(
  requiredResolution: number,
): number {
  const boundedResolution = Math.max(
    requiredResolution,
    IMPORTED_ROUTE_MIN_FIT_RESOLUTION,
  );
  let snappedResolution = LV95_VIEW_RESOLUTIONS[
    LV95_STANDARD_SOURCE_MATRIX_INDICES[0]
  ];

  for (const matrixIndex of LV95_STANDARD_SOURCE_MATRIX_INDICES) {
    if (matrixIndex > IMPORTED_ROUTE_MAX_ZOOM) {
      break;
    }

    const nativeResolution = LV95_VIEW_RESOLUTIONS[matrixIndex];

    if (nativeResolution >= boundedResolution) {
      snappedResolution = nativeResolution;
      continue;
    }

    break;
  }

  return snappedResolution;
}

/** Returns whether two OpenLayers size readings describe the same viewport. */
function sizesMatch(first: Size | null, second: Size): boolean {
  return first !== null && first[0] === second[0] && first[1] === second[1];
}

/**
 * Frames a GPX only after the map has recovered from the native file picker.
 * Mobile browsers can briefly expose a stale or very small viewport while the
 * picker closes, so fitting immediately can animate to the national overview.
 * The callback also stops silently when a newer import supersedes this one.
 *
 * @param map - Shared OpenLayers map whose viewport must be stable before fitting.
 * @param extent - LV95 extent of the imported route to keep fully visible.
 * @param isCurrentImport - Guard that becomes false when another import starts.
 * @returns Nothing; the fit is scheduled through animation frames.
 */
function fitImportedRouteWhenViewportSettles(
  map: Map,
  extent: Extent,
  isCurrentImport: () => boolean,
): void {
  let previousSize: Size | null = null;
  let stableSizeReadings = 0;
  let inspectedFrames = 0;

  const inspectViewport = () => {
    if (!isCurrentImport()) {
      return;
    }

    map.updateSize();
    const size = map.getSize();
    inspectedFrames += 1;

    if (size && size[0] > 0 && size[1] > 0) {
      stableSizeReadings = sizesMatch(previousSize, size)
        ? stableSizeReadings + 1
        : 1;
      previousSize = [size[0], size[1]];

      if (
        stableSizeReadings >= IMPORTED_ROUTE_REQUIRED_STABLE_SIZE_READINGS ||
        inspectedFrames >= IMPORTED_ROUTE_FIT_STABILIZATION_FRAME_LIMIT
      ) {
        const padding = calculateImportedRouteFitPadding(size);
        const fitSize: Size = [
          Math.max(1, size[0] - padding[1] - padding[3]),
          Math.max(1, size[1] - padding[0] - padding[2]),
        ];
        const view = map.getView();
        const rotation = view.getRotation();
        const extentWidth = extent[2] - extent[0];
        const extentHeight = extent[3] - extent[1];
        const cosRotation = Math.abs(Math.cos(rotation));
        const sinRotation = Math.abs(Math.sin(rotation));
        const rotatedWidth =
          extentWidth * cosRotation + extentHeight * sinRotation;
        const rotatedHeight =
          extentWidth * sinRotation + extentHeight * cosRotation;
        const requiredResolution = Math.max(
          rotatedWidth / fitSize[0],
          rotatedHeight / fitSize[1],
        );
        const fitResolution =
          snapImportedRouteFitResolution(requiredResolution);

        // A previous GPX fit may still be animating when another file is
        // selected. Starting from the current rendered state avoids competing
        // target resolutions and stale interim tiles.
        view.cancelAnimations();
        view.fit(extent, {
          size,
          duration: IMPORTED_ROUTE_FIT_DURATION_MS,
          minResolution: fitResolution,
          padding,
        });
        return;
      }
    }

    if (inspectedFrames < IMPORTED_ROUTE_FIT_STABILIZATION_FRAME_LIMIT) {
      window.requestAnimationFrame(inspectViewport);
    }
  };

  window.requestAnimationFrame(inspectViewport);
}

/**
 * Coordinates local GPX file handling and the read-only map display.
 *
 * @param options - Shared runtime plus cross-workflow and message callbacks.
 * @returns Imported geometry, retained source GPX, optional elevations, and lifecycle actions.
 */
export function useImportedRoute(
  options: UseImportedRouteOptions,
): ImportedRouteController {
  const importSessionRef = useRef(0);
  const [segments, setSegments] = useState<Coordinate[][]>([]);
  const [source, setSource] = useState<ImportedRouteSource | null>(null);
  const [elevationSummary, setElevationSummary] =
    useState<RouteElevationSummary | null>(null);

  const clearImportedRoute = useCallback(() => {
    // Advancing the session invalidates a file read that may still be resolving
    // when route creation or another workflow takes priority.
    importSessionRef.current += 1;

    const display = options.mapRuntimeRef.current?.importedRouteDisplay;

    if (display) {
      updateImportedRouteDisplay(display, []);
    }

    setSegments([]);
    setSource(null);
    setElevationSummary(null);
  }, [options.mapRuntimeRef]);

  const importRouteFile = useCallback(
    async (file: File) => {
      const map = options.mapRuntimeRef.current?.map;
      const display = options.mapRuntimeRef.current?.importedRouteDisplay;

      if (!map || !display) {
        return;
      }

      const importSession = ++importSessionRef.current;

      if (file.size > MAX_GPX_FILE_SIZE_BYTES) {
        options.onImportError(options.t('route.importTooLarge'));
        return;
      }

      try {
        const gpxDocument = await file.text();
        const importedRoute = parseGpxRoute(gpxDocument, file.name);

        // A slower previous file read must not replace a newer selection or a
        // route-creation action that explicitly cleared the imported workflow.
        if (importSession !== importSessionRef.current) {
          return;
        }

        const projectedSegments = importedRoute.segments.map((segment) =>
          fromWgs84Coordinates(segment.coordinates),
        );
        let embeddedElevationSummary: RouteElevationSummary | null = null;

        if (
          importedRoute.segments.every(
            (segment) => segment.elevationsMeters !== null,
          )
        ) {
          try {
            embeddedElevationSummary = createImportedRouteElevationSummary(
              importedRoute.segments.map((segment, index) => ({
                coordinates: projectedSegments[index],
                elevationsMeters: segment.elevationsMeters ?? [],
              })),
            );
          } catch (error) {
            // Geometry remains useful when unusual embedded elevations cannot
            // be measured; the shared metrics hook will request GeoAdmin data.
            console.warn(
              'Unable to use GPX elevations; falling back to GeoAdmin.',
              error,
            );
          }
        }

        options.onImportAccepted();
        updateImportedRouteDisplay(display, projectedSegments);
        setSegments(projectedSegments);
        setSource({
          name: importedRoute.name,
          gpxDocument,
        });
        setElevationSummary(embeddedElevationSummary);

        const sourceExtent = display.source.getExtent();

        if (sourceExtent && !isEmpty(sourceExtent)) {
          const importedExtent: Extent = [...sourceExtent];

          fitImportedRouteWhenViewportSettles(
            map,
            importedExtent,
            () => importSession === importSessionRef.current,
          );
        }
      } catch (error) {
        if (importSession !== importSessionRef.current) {
          return;
        }

        console.error('Unable to import the GPX route.', error);
        options.onImportError(options.t('route.importError'));
      }
    },
    [
      options.mapRuntimeRef,
      options.onImportAccepted,
      options.onImportError,
      options.t,
    ],
  );

  useEffect(
    () => () => {
      // File.text() cannot be aborted. Session invalidation prevents a resolved
      // promise from mutating state after the hook has unmounted.
      importSessionRef.current += 1;
    },
    [],
  );

  return {
    segments,
    source,
    elevationSummary,
    importRouteFile,
    clearImportedRoute,
  };
}
