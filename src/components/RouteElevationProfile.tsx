/**
 * Business context: visualizes the terrain shape of the current hike without
 * replacing the map. The chart is intentionally lightweight and uses the same
 * elevation samples already fetched for ascent/descent calculations.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useI18n } from '../i18n/I18nContext';
import type { RouteElevationPoint } from '../metrics/routeMetrics';

/** Data and identity required by the collapsible elevation chart. */
interface RouteElevationProfileProps {
  /** DOM id referenced by the profile toggle through aria-controls. */
  id: string;
  /** Ordered elevation samples from the start to the end of the route. */
  points: RouteElevationPoint[];
  /** Publishes cumulative route distance while the pointer explores the chart. */
  onHoverDistanceChange?: (distanceMeters: number | null) => void;
  /** Cumulative distance selected by pointer movement over the map route. */
  externalHoverDistanceMeters?: number | null;
}

/** Internal SVG dimensions used to normalize route distance and altitude. */
const CHART_WIDTH = 720;
const CHART_HEIGHT = 150;
const CHART_PADDING = {
  top: 14,
  right: 22,
  bottom: 27,
  left: 64,
};
/**
 * Target vertical exaggeration for routes whose visible relief would otherwise
 * fill the chart. A 5x ratio keeps gentle terrain readable without making it
 * look as steep as an alpine route.
 */
const TARGET_VERTICAL_EXAGGERATION = 5;
/**
 * Smallest displayed elevation range in metres. It prevents genuinely flat
 * profiles from collapsing onto a single horizontal line.
 */
const MINIMUM_ELEVATION_RANGE_METERS = 40;
/** Ten percent of breathing room is kept above and below the real extrema. */
const ELEVATION_RANGE_PADDING_RATIO = 0.10;
/**
 * Limits empty vertical space relative to the route's padded relief. A ratio
 * of two keeps long traverses readable even when their horizontal compression
 * makes the five-times exaggeration target unattainable.
 */
const MAXIMUM_RANGE_TO_RELIEF_RATIO = 2;
/** Roughly three readable vertical intervals avoid crowding the compact chart. */
const TARGET_ELEVATION_INTERVAL_COUNT = 3;
/** Roughly five readable intervals work across both short and long hikes. */
const TARGET_DISTANCE_INTERVAL_COUNT = 5;

/** Converts JavaScript's signed negative zero to the ordinary zero shown to users. */
function normalizeSignedZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/** Formats one chart altitude in whole metres. */
function formatAltitude(
  elevationMeters: number,
  integerFormat: Intl.NumberFormat,
): string {
  const roundedElevation = normalizeSignedZero(Math.round(elevationMeters));

  return `${integerFormat.format(roundedElevation)} m`;
}

/** Formats cumulative profile distance using metres or kilometres. */
function formatDistance(
  distanceMeters: number,
  integerFormat: Intl.NumberFormat,
  distanceFormat: Intl.NumberFormat,
): string {
  if (distanceMeters < 1_000) {
    return `${integerFormat.format(Math.round(distanceMeters))} m`;
  }

  return `${distanceFormat.format(distanceMeters / 1_000)} km`;
}

/** One horizontal-axis graduation projected into the SVG plot. */
interface DistanceTick {
  distanceMeters: number;
  x: number;
}

/**
 * Rounds a raw interval to the nearest value in the familiar 1, 2, 2.5, 5,
 * 10 sequence so distance graduations stay stable and easy to scan.
 */
function calculateNiceDistanceInterval(totalDistance: number): number {
  const rawInterval = totalDistance / TARGET_DISTANCE_INTERVAL_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(rawInterval));
  const normalizedInterval = rawInterval / magnitude;
  const multiplier = [1, 2, 2.5, 5, 10].reduce((closest, candidate) =>
    Math.abs(candidate - normalizedInterval) <
    Math.abs(closest - normalizedInterval)
      ? candidate
      : closest,
  );

  return multiplier * magnitude;
}

/** Builds regular intermediate graduations without redundant endpoints. */
function buildDistanceTicks(
  totalDistance: number,
  plotWidth: number,
): DistanceTick[] {
  const interval = calculateNiceDistanceInterval(totalDistance);
  const ticks: DistanceTick[] = [];

  for (
    let distanceMeters = interval;
    distanceMeters < totalDistance;
    distanceMeters += interval
  ) {
    ticks.push({
      distanceMeters,
      x: CHART_PADDING.left + (distanceMeters / totalDistance) * plotWidth,
    });
  }

  return ticks;
}

/** Display range used to project real elevations into the SVG chart. */
interface ElevationBounds {
  /** Lower chart boundary in metres, possibly below the route minimum. */
  chartMinimumElevation: number;
  /** Upper chart boundary in metres, possibly above the route maximum. */
  chartMaximumElevation: number;
}

/** One horizontal elevation guide projected into the SVG plot. */
interface ElevationTick {
  /** Round altitude displayed next to the guide. */
  elevationMeters: number;
  /** Vertical SVG coordinate of the guide. */
  y: number;
}

/**
 * Chooses a route-aware vertical scale from the chart aspect ratio. Gentle
 * routes keep visible headroom, while steep routes still use most of the plot.
 */
function calculateElevationBounds(
  minimumElevation: number,
  maximumElevation: number,
  totalDistanceMeters: number,
  plotWidth: number,
  plotHeight: number,
): ElevationBounds {
  const actualRange = maximumElevation - minimumElevation;
  const reliefRange = Math.max(
    MINIMUM_ELEVATION_RANGE_METERS,
    actualRange * (1 + 2 * ELEVATION_RANGE_PADDING_RATIO),
  );
  const targetExaggerationRange =
    ((totalDistanceMeters / plotWidth) / TARGET_VERTICAL_EXAGGERATION) *
    plotHeight;
  const displayedRange = Math.max(
    reliefRange,
    Math.min(
      targetExaggerationRange,
      reliefRange * MAXIMUM_RANGE_TO_RELIEF_RATIO,
    ),
  );
  const centreElevation = (minimumElevation + maximumElevation) / 2;
  let chartMinimumElevation = centreElevation - displayedRange / 2;

  // A long route entirely above sea level should not reserve chart space for
  // negative altitudes merely to keep the display window centred.
  if (minimumElevation >= 0 && chartMinimumElevation < 0) {
    chartMinimumElevation = 0;
  }

  return {
    chartMinimumElevation,
    chartMaximumElevation: chartMinimumElevation + displayedRange,
  };
}

/** Rounds one raw elevation interval to the familiar 1, 2, 2.5, 5, 10 sequence. */
function calculateNiceElevationInterval(displayedRange: number): number {
  const rawInterval = displayedRange / TARGET_ELEVATION_INTERVAL_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(rawInterval));
  const normalizedInterval = rawInterval / magnitude;
  const multiplier = [1, 2, 2.5, 5, 10].reduce((closest, candidate) =>
    Math.abs(candidate - normalizedInterval) <
    Math.abs(closest - normalizedInterval)
      ? candidate
      : closest,
  );

  return multiplier * magnitude;
}

/** Builds round altitude guides independently from the exact display bounds. */
function buildElevationTicks(
  chartMinimumElevation: number,
  chartMaximumElevation: number,
  plotHeight: number,
): ElevationTick[] {
  const displayedRange = chartMaximumElevation - chartMinimumElevation;
  const interval = calculateNiceElevationInterval(displayedRange);
  const ticks: ElevationTick[] = [];

  for (
    let elevationMeters =
      Math.ceil(chartMinimumElevation / interval) * interval;
    elevationMeters <= chartMaximumElevation;
    elevationMeters += interval
  ) {
    ticks.push({
      elevationMeters: normalizeSignedZero(elevationMeters),
      y:
        CHART_PADDING.top +
        (1 -
          (elevationMeters - chartMinimumElevation) / displayedRange) *
          plotHeight,
    });
  }

  return ticks;
}

/** Geometry and real-world bounds reused by every render of one profile. */
export interface ElevationChartGeometry {
  /** Polyline coordinates encoded for the SVG `points` attribute. */
  linePoints: string;
  /** Closed SVG path used to fill the terrain area below the profile. */
  areaPath: string;
  /** Lowest real elevation sample in metres. */
  minimumElevation: number;
  /** Highest real elevation sample in metres. */
  maximumElevation: number;
  /** Lower SVG boundary in metres. */
  chartMinimumElevation: number;
  /** Upper SVG boundary in metres. */
  chartMaximumElevation: number;
  /** Round horizontal guides shown inside the vertical range. */
  elevationTicks: ElevationTick[];
  /** Final cumulative sample distance in metres, clamped above zero. */
  totalDistance: number;
}

/**
 * Converts ordered elevation samples into the immutable SVG geometry used by
 * the profile. Min/max accumulation stays iterative so dense multi-segment GPX
 * profiles cannot exceed the JavaScript function-argument limit.
 *
 * @param points - Ordered cumulative-distance and elevation samples.
 * @returns Encoded line/fill paths plus real and route-aware elevation bounds.
 */
export function buildChartPoints(
  points: RouteElevationPoint[],
): ElevationChartGeometry {
  let minimumElevation = Number.POSITIVE_INFINITY;
  let maximumElevation = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minimumElevation = Math.min(
      minimumElevation,
      point.elevationMeters,
    );
    maximumElevation = Math.max(
      maximumElevation,
      point.elevationMeters,
    );
  }

  const totalDistance = Math.max(points[points.length - 1].distanceMeters, 1);
  const plotWidth =
    CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight =
    CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const { chartMinimumElevation, chartMaximumElevation } =
    calculateElevationBounds(
      minimumElevation,
      maximumElevation,
      totalDistance,
      plotWidth,
      plotHeight,
    );
  const elevationRange = chartMaximumElevation - chartMinimumElevation;
  const elevationTicks = buildElevationTicks(
    chartMinimumElevation,
    chartMaximumElevation,
    plotHeight,
  );

  const chartCoordinates = points.map((point) => {
    const x =
      CHART_PADDING.left +
      (point.distanceMeters / totalDistance) * plotWidth;
    const y =
      CHART_PADDING.top +
      (1 -
        (point.elevationMeters - chartMinimumElevation) / elevationRange) *
        plotHeight;

    return [x, y] as const;
  });

  const linePoints = chartCoordinates
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  const baselineY = CHART_HEIGHT - CHART_PADDING.bottom;
  const firstPoint = chartCoordinates[0];
  const lastPoint = chartCoordinates[chartCoordinates.length - 1];
  const areaPath = [
    `M ${firstPoint[0].toFixed(2)} ${baselineY}`,
    ...chartCoordinates.map(
      ([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`,
    ),
    `L ${lastPoint[0].toFixed(2)} ${baselineY}`,
    'Z',
  ].join(' ');

  return {
    linePoints,
    areaPath,
    minimumElevation,
    maximumElevation,
    chartMinimumElevation,
    chartMaximumElevation,
    elevationTicks,
    totalDistance,
  };
}

/** One interpolated point currently explored through the profile pointer. */
interface HoveredProfilePoint {
  distanceMeters: number;
  elevationMeters: number;
  x: number;
  y: number;
}

/** Finds the first profile sample at or beyond one cumulative distance. */
function findUpperProfilePointIndex(
  points: RouteElevationPoint[],
  distanceMeters: number,
): number {
  let lowerIndex = 0;
  let upperIndex = points.length - 1;

  while (lowerIndex < upperIndex) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);

    if (points[middleIndex].distanceMeters < distanceMeters) {
      lowerIndex = middleIndex + 1;
    } else {
      upperIndex = middleIndex;
    }
  }

  return lowerIndex;
}

/** Interpolates altitude between adjacent profile samples for a smooth cursor. */
function elevationAtDistance(
  points: RouteElevationPoint[],
  distanceMeters: number,
): number {
  if (distanceMeters <= points[0].distanceMeters) {
    return points[0].elevationMeters;
  }

  const lastPoint = points[points.length - 1];

  if (distanceMeters >= lastPoint.distanceMeters) {
    return lastPoint.elevationMeters;
  }

  const upperIndex = findUpperProfilePointIndex(points, distanceMeters);
  const lowerIndex = Math.max(0, upperIndex - 1);
  const lowerPoint = points[lowerIndex];
  const upperPoint = points[upperIndex];
  const distanceSpan =
    upperPoint.distanceMeters - lowerPoint.distanceMeters;
  const fraction =
    distanceSpan > 0
      ? (distanceMeters - lowerPoint.distanceMeters) / distanceSpan
      : 0;

  return (
    lowerPoint.elevationMeters +
    (upperPoint.elevationMeters - lowerPoint.elevationMeters) * fraction
  );
}

/** Compact SVG elevation profile displayed above the route statistics bar. */
export default function RouteElevationProfile({
  id,
  points,
  onHoverDistanceChange,
  externalHoverDistanceMeters = null,
}: RouteElevationProfileProps) {
  const { locale, t } = useI18n();
  const integerFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );
  const distanceFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const {
    linePoints,
    areaPath,
    minimumElevation,
    maximumElevation,
    chartMinimumElevation,
    chartMaximumElevation,
    elevationTicks,
    totalDistance,
  } = useMemo(() => buildChartPoints(points), [points]);
  const plotHeight =
    CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const formattedMinimum = formatAltitude(minimumElevation, integerFormat);
  const formattedMaximum = formatAltitude(maximumElevation, integerFormat);
  const [hoveredPoint, setHoveredPoint] =
    useState<HoveredProfilePoint | null>(null);
  const activeTouchPointerIdRef = useRef<number | null>(null);
  const plotWidth =
    CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const chartElevationRange =
    chartMaximumElevation - chartMinimumElevation;
  const distanceTicks = useMemo(
    () => buildDistanceTicks(totalDistance, plotWidth),
    [plotWidth, totalDistance],
  );

  const profilePointAtDistance = useCallback(
    (distanceMeters: number): HoveredProfilePoint => {
      const boundedDistance = Math.min(
        totalDistance,
        Math.max(0, distanceMeters),
      );
      const x =
        CHART_PADDING.left +
        (boundedDistance / totalDistance) * plotWidth;
      const elevationMeters = elevationAtDistance(points, boundedDistance);
      const y =
        CHART_PADDING.top +
        (1 -
          (elevationMeters - chartMinimumElevation) /
            chartElevationRange) *
          plotHeight;

      return {
        distanceMeters: boundedDistance,
        elevationMeters,
        x,
        y,
      };
    },
    [
      chartElevationRange,
      chartMinimumElevation,
      plotHeight,
      plotWidth,
      points,
      totalDistance,
    ],
  );

  const externalHoveredPoint = useMemo(
    () =>
      externalHoverDistanceMeters === null
        ? null
        : profilePointAtDistance(externalHoverDistanceMeters),
    [externalHoverDistanceMeters, profilePointAtDistance],
  );
  const displayedHoveredPoint = hoveredPoint ?? externalHoveredPoint;

  const clearHover = useCallback(() => {
    setHoveredPoint(null);
    onHoverDistanceChange?.(null);
  }, [onHoverDistanceChange]);

  const updateFromPointer = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const chartBounds = event.currentTarget.getBoundingClientRect();

      if (chartBounds.width <= 0) {
        return;
      }

      const chartX =
        ((event.clientX - chartBounds.left) / chartBounds.width) * CHART_WIDTH;
      const boundedX = Math.min(
        CHART_WIDTH - CHART_PADDING.right,
        Math.max(CHART_PADDING.left, chartX),
      );
      const distanceMeters =
        ((boundedX - CHART_PADDING.left) / plotWidth) * totalDistance;

      setHoveredPoint(profilePointAtDistance(distanceMeters));
      onHoverDistanceChange?.(distanceMeters);
    },
    [
      onHoverDistanceChange,
      plotWidth,
      profilePointAtDistance,
      totalDistance,
    ],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!event.isPrimary || event.pointerType !== 'touch') {
        return;
      }

      // Capturing the finger keeps exploration continuous when it drifts
      // outside the compact plot before release.
      activeTouchPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();

      updateFromPointer(event);
    },
    [updateFromPointer],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (
        event.pointerType === 'touch' &&
        activeTouchPointerIdRef.current !== event.pointerId
      ) {
        return;
      }

      if (event.pointerType === 'touch') {
        event.preventDefault();
      }

      updateFromPointer(event);
    },
    [updateFromPointer],
  );

  const finishTouchExploration = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (activeTouchPointerIdRef.current !== event.pointerId) {
        return;
      }

      activeTouchPointerIdRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      clearHover();
    },
    [clearHover],
  );

  const handlePointerLeave = useCallback(() => {
    if (activeTouchPointerIdRef.current === null) {
      clearHover();
    }
  }, [clearHover]);

  const handleLostPointerCapture = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (activeTouchPointerIdRef.current === event.pointerId) {
        activeTouchPointerIdRef.current = null;
        clearHover();
      }
    },
    [clearHover],
  );

  useEffect(() => {
    clearHover();

    return () => onHoverDistanceChange?.(null);
  }, [clearHover, onHoverDistanceChange, points]);

  const headerValue = displayedHoveredPoint
    ? `${formatDistance(
        displayedHoveredPoint.distanceMeters,
        integerFormat,
        distanceFormat,
      )} · ${formatAltitude(
        displayedHoveredPoint.elevationMeters,
        integerFormat,
      )}`
    : `${formattedMinimum} – ${formattedMaximum}`;

  return (
    <section
      id={id}
      className="route-elevation-profile"
      aria-label={t('profile.aria')}
    >
      <div className="route-elevation-profile-header">
        <strong>{t('profile.title')}</strong>
        <span>{headerValue}</span>
      </div>

      <svg
        className="route-elevation-profile-chart"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={t('profile.rangeAria', {
          minimum: formattedMinimum,
          maximum: formattedMaximum,
        })}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishTouchExploration}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={finishTouchExploration}
        onLostPointerCapture={handleLostPointerCapture}
      >
        {elevationTicks.map((tick) => (
          <g key={tick.elevationMeters}>
            <line
              className="route-elevation-profile-grid"
              x1={CHART_PADDING.left}
              x2={CHART_WIDTH - CHART_PADDING.right}
              y1={tick.y}
              y2={tick.y}
            />
            <text
              className="route-elevation-profile-axis-label"
              x={CHART_PADDING.left - 8}
              y={tick.y + 4}
              textAnchor="end"
            >
              {integerFormat.format(tick.elevationMeters)}
            </text>
          </g>
        ))}

        {distanceTicks.map((tick) => (
          <g key={tick.distanceMeters}>
            <line
              className="route-elevation-profile-distance-grid"
              x1={tick.x}
              x2={tick.x}
              y1={CHART_PADDING.top}
              y2={CHART_HEIGHT - CHART_PADDING.bottom}
            />
            <text
              className="route-elevation-profile-distance-label"
              x={tick.x}
              y={CHART_HEIGHT - 7}
              textAnchor="middle"
            >
              {formatDistance(
                tick.distanceMeters,
                integerFormat,
                distanceFormat,
              )}
            </text>
          </g>
        ))}

        <path className="route-elevation-profile-area" d={areaPath} />
        <polyline
          className="route-elevation-profile-line"
          points={linePoints}
        />

        {displayedHoveredPoint && (
          <g className="route-elevation-profile-hover" aria-hidden="true">
            <line
              x1={displayedHoveredPoint.x}
              x2={displayedHoveredPoint.x}
              y1={CHART_PADDING.top}
              y2={CHART_HEIGHT - CHART_PADDING.bottom}
            />
            <circle
              cx={displayedHoveredPoint.x}
              cy={displayedHoveredPoint.y}
              r="5"
            />
          </g>
        )}

        <rect
          className="route-elevation-profile-hit-area"
          x={CHART_PADDING.left}
          y={CHART_PADDING.top}
          width={plotWidth}
          height={plotHeight}
        />
      </svg>
    </section>
  );
}
