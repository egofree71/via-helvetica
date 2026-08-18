/**
 * Business context: represents every map-information object that can legitimately
 * share one click position. The common chooser keeps ambiguity resolution separate
 * from each feature's detailed workflow, so safety, public transport, and
 * SwitzerlandMobility can coexist without one layer silently short-circuiting another.
 */
import type { Coordinate } from 'ol/coordinate.js';
import type { IdentifiedTrailClosure } from '../closures/trailClosures';
import type { IdentifiedShootingDangerZone } from '../dangers/shootingDangerZones';
import type { SwitzerlandMobilityHikingRouteCandidate } from '../switzerlandMobility/hikingRoutes';
import type { PublicTransportStop } from '../transport/publicTransportStops';

/** Official closure or detour identified at the clicked map position. */
export interface TrailClosureMapInformationChoice {
  /** Choice kind used to dispatch the detailed workflow. */
  kind: 'trailClosure';
  /** Lightweight identify result; popup HTML is intentionally loaded only after selection. */
  closure: IdentifiedTrailClosure;
  /** Click coordinate retained while the temporary chooser is open. */
  anchorCoordinate: Coordinate;
}

/** Official shooting notice or danger zone identified at the clicked position. */
export interface ShootingDangerZoneMapInformationChoice {
  /** Choice kind used to dispatch the detailed workflow. */
  kind: 'shootingDangerZone';
  /** Lightweight identify result; detailed popup HTML remains lazy. */
  dangerZone: IdentifiedShootingDangerZone;
  /** Click coordinate retained while the temporary chooser is open. */
  anchorCoordinate: Coordinate;
}

/** Concrete passenger stop represented by a rendered stop symbol. */
export interface PublicTransportStopMapInformationChoice {
  /** Choice kind used to dispatch the detailed workflow. */
  kind: 'publicTransportStop';
  /** Loaded stop kept independent even when it was hidden by decluttering. */
  stop: PublicTransportStop;
  /** Original click coordinate rather than the potentially fanned-out visual position. */
  anchorCoordinate: Coordinate;
}

/** Named SwitzerlandMobility hiking route sharing the clicked path. */
export interface SwitzerlandMobilityHikingMapInformationChoice {
  /** Choice kind used to dispatch the detailed workflow. */
  kind: 'switzerlandMobilityHiking';
  /** Lightweight public-route candidate; complete geometry is loaded only after selection. */
  candidate: SwitzerlandMobilityHikingRouteCandidate;
  /** Click coordinate retained for a uniform choice contract. */
  anchorCoordinate: Coordinate;
}

/** One selectable item in the common map-information ambiguity chooser. */
export type MapInformationChoice =
  | TrailClosureMapInformationChoice
  | ShootingDangerZoneMapInformationChoice
  | PublicTransportStopMapInformationChoice
  | SwitzerlandMobilityHikingMapInformationChoice;
