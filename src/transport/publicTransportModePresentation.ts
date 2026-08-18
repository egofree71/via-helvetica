/**
 * Business context: keeps the official-looking public-transport pictograms
 * consistent wherever one normalized transport mode is presented in the UI.
 * The map markers, selected-stop details, and mixed map-information chooser
 * must not drift to different symbols for the same passenger mode.
 */
import boatIconUrl from '../assets/public-transport-stops/boat.svg';
import busIconUrl from '../assets/public-transport-stops/bus.svg';
import cableCarIconUrl from '../assets/public-transport-stops/cable-car.svg';
import chairliftIconUrl from '../assets/public-transport-stops/chairlift.svg';
import funicularIconUrl from '../assets/public-transport-stops/funicular.svg';
import trainIconUrl from '../assets/public-transport-stops/train.svg';
import tramIconUrl from '../assets/public-transport-stops/tram.svg';
import type { PublicTransportMode } from './publicTransportStopModel';

/** Bundled pictogram URL used for each normalized passenger transport mode. */
export const PUBLIC_TRANSPORT_MODE_ICON_URLS: Record<
  PublicTransportMode,
  string
> = {
  train: trainIconUrl,
  // Metro keeps its own translated label but uses the clear railway symbol.
  metro: trainIconUrl,
  tram: tramIconUrl,
  bus: busIconUrl,
  boat: boatIconUrl,
  cableCar: cableCarIconUrl,
  chairlift: chairliftIconUrl,
  funicular: funicularIconUrl,
};
