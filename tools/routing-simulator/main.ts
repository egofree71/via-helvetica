/**
 * Business context: provides a development-only browser interface for replaying
 * uploaded GPX tracks as synthetic route creation sessions. It compares the
 * release-1.2 corridor policy with the certified policy without adding controls
 * or permanent panels to the map-centred production application.
 */
import { parseGpxRoute } from '../../src/import/gpx';
import { fromWgs84Coordinates } from '../../src/map/projection';
import {
  createSimulatorWaypointSequence,
  routingSimulationExportBaseName,
  type SimulatorSourceSegment,
  type WaypointSamplingConfiguration,
} from './core';
import type {
  RoutingSimulatorScenario,
  RoutingSimulatorScenarioResult,
  RoutingSimulatorWorkerResponse,
} from './protocol';
import './styles.css';

/** Parsed projected segment retained between file selection and batch start. */
interface LoadedSourceSegment extends SimulatorSourceSegment {
  /** Original uploaded filename. */
  filename: string;
}

const elements = {
  baseUrl: document.querySelector<HTMLInputElement>('#routing-data-url')!,
  files: document.querySelector<HTMLInputElement>('#gpx-files')!,
  intervalMetres: document.querySelector<HTMLInputElement>('#interval-metres')!,
  intervalPercent: document.querySelector<HTMLInputElement>('#interval-percent')!,
  variationPercent: document.querySelector<HTMLInputElement>('#variation-percent')!,
  randomRuns: document.querySelector<HTMLInputElement>('#random-runs')!,
  seed: document.querySelector<HTMLInputElement>('#seed')!,
  run: document.querySelector<HTMLButtonElement>('#run-simulation')!,
  cancel: document.querySelector<HTMLButtonElement>('#cancel-simulation')!,
  exportJson: document.querySelector<HTMLButtonElement>('#export-json')!,
  exportCsv: document.querySelector<HTMLButtonElement>('#export-csv')!,
  fileSummary: document.querySelector<HTMLElement>('#file-summary')!,
  status: document.querySelector<HTMLElement>('#status')!,
  progress: document.querySelector<HTMLProgressElement>('#progress')!,
  summary: document.querySelector<HTMLElement>('#summary')!,
  resultsBody: document.querySelector<HTMLTableSectionElement>('#results-body')!,
};

let loadedSegments: LoadedSourceSegment[] = [];
let results: RoutingSimulatorScenarioResult[] = [];
let activeWorker: Worker | null = null;

/** Formats byte counts without implying unavailable compressed metadata is zero. */
function formatBytes(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  if (value < 1_024) {
    return `${value.toFixed(0)} B`;
  }

  if (value < 1_024 * 1_024) {
    return `${(value / 1_024).toFixed(1)} KiB`;
  }

  return `${(value / 1_024 / 1_024).toFixed(2)} MiB`;
}

/** Formats metric route distances for compact result tables. */
function formatDistance(value: number): string {
  return value >= 1_000
    ? `${(value / 1_000).toFixed(2)} km`
    : `${value.toFixed(0)} m`;
}

/** Returns a signed percentage difference from legacy to certified. */
function percentageDelta(
  legacy: number | null,
  certified: number | null,
): number | null {
  if (
    legacy === null ||
    certified === null ||
    !Number.isFinite(legacy) ||
    !Number.isFinite(certified) ||
    legacy === 0
  ) {
    return null;
  }

  return ((certified - legacy) / legacy) * 100;
}

/** Formats negative improvements and positive regressions consistently. */
function formatDelta(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(1)}%`;
}

/** Applies a semantic class to one gain or regression cell. */
function deltaClass(value: number | null): string {
  if (value === null || Math.abs(value) < 0.05) {
    return 'neutral';
  }

  return value < 0 ? 'improvement' : 'regression';
}

/** Median of one non-empty numeric series. */
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Escapes local GPX labels before placing them in result-table markup. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Escapes one string for a CSV field. */
function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Downloads generated text without sending GPX or metrics to a server. */
function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Reads and projects every usable independent segment from selected GPX files. */
async function loadSelectedFiles(): Promise<void> {
  loadedSegments = [];
  const files = [...(elements.files.files ?? [])];

  for (const file of files) {
    const route = parseGpxRoute(await file.text(), file.name);

    route.segments.forEach((segment, segmentIndex) => {
      const suffix = route.segments.length > 1 ? ` — segment ${segmentIndex + 1}` : '';
      loadedSegments.push({
        filename: file.name,
        name: `${route.name}${suffix}`,
        coordinates: fromWgs84Coordinates(segment.coordinates),
      });
    });
  }

  elements.fileSummary.textContent =
    loadedSegments.length === 0
      ? 'No usable GPX segment loaded.'
      : `${files.length} file(s), ${loadedSegments.length} independent segment(s) ready.`;
  elements.run.disabled = loadedSegments.length === 0;
}

/** Parses finite input numbers with an actionable field name. */
function numericInput(input: HTMLInputElement, label: string): number {
  const value = Number(input.value);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

/** Builds every configured sampling mode for one complete benchmark run. */
function samplingConfigurations(): WaypointSamplingConfiguration[] {
  const intervalMetres = numericInput(elements.intervalMetres, 'Interval');
  const intervalPercent = numericInput(elements.intervalPercent, 'Percentage');
  const variationRatio =
    numericInput(elements.variationPercent, 'Variation') / 100;
  const runCount = Math.floor(numericInput(elements.randomRuns, 'Run count'));
  const baseSeed = Math.floor(numericInput(elements.seed, 'Seed'));

  if (runCount < 1 || runCount > 100) {
    throw new Error('Irregular run count must be between 1 and 100.');
  }

  return [
    {
      mode: 'regular-distance',
      intervalMetres,
    },
    {
      mode: 'regular-percentage',
      intervalPercent,
    },
    ...Array.from({ length: runCount }, (_, index) => ({
      mode: 'irregular-distance' as const,
      meanIntervalMetres: intervalMetres,
      variationRatio,
      seed: baseSeed + index,
    })),
  ];
}

/** Converts loaded GPX segments and controls into Worker-ready scenarios. */
function createScenarios(): RoutingSimulatorScenario[] {
  const configurations = samplingConfigurations();
  const scenarios: RoutingSimulatorScenario[] = [];

  for (const source of loadedSegments) {
    for (const configuration of configurations) {
      const sequence = createSimulatorWaypointSequence(source, configuration);
      scenarios.push({
        id: `${source.filename}:${source.name}:${sequence.scenarioLabel}`,
        sourceFilename: source.filename,
        sourceName: source.name,
        scenarioLabel: sequence.scenarioLabel,
        sourceDistanceMetres: sequence.sourceDistanceMetres,
        waypoints: sequence.waypoints,
      });
    }
  }

  return scenarios;
}

/** Creates a concise route-quality label for one result row. */
function comparisonLabel(result: RoutingSimulatorScenarioResult): string {
  const comparison = result.comparison;

  if (comparison.routingOutcomeMismatchCount > 0) {
    return `${comparison.routingOutcomeMismatchCount} routing mismatch(es)`;
  }

  if (comparison.differentGeometrySectionCount === 0) {
    return 'all sections identical';
  }

  return (
    `${comparison.differentGeometrySectionCount} different; ` +
    `max ${comparison.maximumSampledDeviationMetres.toFixed(1)} m`
  );
}

/** Appends one completed scenario to the live table. */
function appendResult(result: RoutingSimulatorScenarioResult): void {
  const cellDelta = percentageDelta(
    result.legacy.uniqueCellCount,
    result.certified.uniqueCellCount,
  );
  const byteDelta = percentageDelta(
    result.legacy.compressedBytes,
    result.certified.compressedBytes,
  );
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${escapeHtml(result.scenario.sourceFilename)}</td>
    <td>${escapeHtml(result.scenario.sourceName)}</td>
    <td>${escapeHtml(result.scenario.scenarioLabel)}</td>
    <td>${formatDistance(result.scenario.sourceDistanceMetres)}</td>
    <td>${result.scenario.waypointCount}</td>
    <td>${result.legacy.uniqueCellCount}<br><small>${formatBytes(result.legacy.compressedBytes)}</small></td>
    <td>${result.certified.uniqueCellCount}<br><small>${formatBytes(result.certified.compressedBytes)}</small></td>
    <td class="${deltaClass(cellDelta)}">${formatDelta(cellDelta)}</td>
    <td class="${deltaClass(byteDelta)}">${formatDelta(byteDelta)}</td>
    <td>${result.legacy.graphBuildCount} / ${result.certified.graphBuildCount}</td>
    <td>${result.certified.metricAttemptCount}</td>
    <td>${comparisonLabel(result)}</td>
  `;
  elements.resultsBody.append(row);
}

/** Recomputes batch-level medians and totals after each completed row. */
function renderSummary(): void {
  if (results.length === 0) {
    elements.summary.textContent = 'No results yet.';
    elements.exportJson.disabled = true;
    elements.exportCsv.disabled = true;
    return;
  }

  const cellDeltas = results
    .map((result) =>
      percentageDelta(
        result.legacy.uniqueCellCount,
        result.certified.uniqueCellCount,
      ),
    )
    .filter((value): value is number => value !== null);
  const byteDeltas = results
    .map((result) =>
      percentageDelta(
        result.legacy.compressedBytes,
        result.certified.compressedBytes,
      ),
    )
    .filter((value): value is number => value !== null);
  const totalLegacyCells = results.reduce(
    (sum, result) => sum + result.legacy.uniqueCellCount,
    0,
  );
  const totalCertifiedCells = results.reduce(
    (sum, result) => sum + result.certified.uniqueCellCount,
    0,
  );
  const mismatchCount = results.reduce(
    (sum, result) => sum + result.comparison.routingOutcomeMismatchCount,
    0,
  );

  elements.summary.innerHTML = `
    <strong>${results.length} scenario(s)</strong>
    · cells ${totalLegacyCells} → ${totalCertifiedCells}
    · aggregate ${formatDelta(percentageDelta(totalLegacyCells, totalCertifiedCells))}
    · median cells ${cellDeltas.length > 0 ? formatDelta(median(cellDeltas)) : 'n/a'}
    · median Brotli ${byteDeltas.length > 0 ? formatDelta(median(byteDeltas)) : 'n/a'}
    · routing mismatches ${mismatchCount}
  `;
  elements.exportJson.disabled = false;
  elements.exportCsv.disabled = false;
}

/** Restores controls after completion, cancellation, or failure. */
function finishBatch(): void {
  elements.run.disabled = loadedSegments.length === 0;
  elements.cancel.disabled = true;
  activeWorker?.terminate();
  activeWorker = null;
}

/** Runs the two policies in a dedicated development Worker. */
function startSimulation(): void {
  try {
    const routingDataBaseUrl = elements.baseUrl.value.trim();
    if (!routingDataBaseUrl) {
      throw new Error(
        'Set the public binary routing-data URL, usually the same VITE_ROUTING_DATA_BASE_URL used by the application.',
      );
    }

    const scenarios = createScenarios();
    if (scenarios.length === 0) {
      throw new Error('Load at least one GPX file.');
    }

    activeWorker?.terminate();
    results = [];
    elements.resultsBody.replaceChildren();
    renderSummary();
    elements.progress.max = scenarios.length;
    elements.progress.value = 0;
    elements.status.textContent = `Starting ${scenarios.length} scenario(s)…`;
    elements.run.disabled = true;
    elements.cancel.disabled = false;

    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    activeWorker = worker;
    worker.addEventListener(
      'message',
      (event: MessageEvent<RoutingSimulatorWorkerResponse>) => {
        const response = event.data;

        if (response.type === 'progress') {
          results.push(response.result);
          appendResult(response.result);
          renderSummary();
          elements.progress.value = response.completed;
          elements.status.textContent =
            `Completed ${response.completed} of ${response.total}: ` +
            response.result.scenario.sourceName;
          return;
        }

        if (response.type === 'complete') {
          elements.status.textContent = response.warning
            ? `Complete. ${response.warning}`
            : 'Complete.';
          finishBatch();
          return;
        }

        if (response.type === 'cancelled') {
          elements.status.textContent = 'Simulation cancelled.';
          finishBatch();
          return;
        }

        elements.status.textContent = `${response.name}: ${response.message}`;
        console.error(response.stack ?? response.message);
        finishBatch();
      },
    );
    worker.addEventListener('error', (event) => {
      elements.status.textContent = `Worker error: ${event.message}`;
      finishBatch();
    });
    worker.postMessage({
      type: 'start',
      routingDataBaseUrl,
      scenarios,
    });
  } catch (error) {
    elements.status.textContent =
      error instanceof Error ? error.message : String(error);
  }
}

/** Returns the source-aware basename shared by JSON and CSV downloads. */
function exportBaseName(): string {
  return routingSimulationExportBaseName(
    results.map((result) => result.scenario.sourceFilename),
  );
}

/** Exports compact result rows and all diagnostic counters as JSON. */
function exportJson(): void {
  downloadText(
    `${exportBaseName()}.json`,
    `${JSON.stringify(results, null, 2)}\n`,
    'application/json',
  );
}

/** Exports the main comparison measures for spreadsheet analysis. */
function exportCsv(): void {
  const header = [
    'gpx_filename',
    'source',
    'scenario',
    'source_distance_m',
    'waypoints',
    'legacy_unique_cells',
    'certified_unique_cells',
    'cell_delta_percent',
    'legacy_compressed_bytes',
    'certified_compressed_bytes',
    'compressed_delta_percent',
    'legacy_decoded_bytes',
    'certified_decoded_bytes',
    'legacy_graph_builds',
    'certified_graph_builds',
    'certified_metric_attempts',
    'exact_sections',
    'different_sections',
    'routing_outcome_mismatches',
    'max_sampled_deviation_m',
  ];
  const rows = results.map((result) => [
    result.scenario.sourceFilename,
    result.scenario.sourceName,
    result.scenario.scenarioLabel,
    result.scenario.sourceDistanceMetres,
    result.scenario.waypointCount,
    result.legacy.uniqueCellCount,
    result.certified.uniqueCellCount,
    percentageDelta(
      result.legacy.uniqueCellCount,
      result.certified.uniqueCellCount,
    ),
    result.legacy.compressedBytes,
    result.certified.compressedBytes,
    percentageDelta(
      result.legacy.compressedBytes,
      result.certified.compressedBytes,
    ),
    result.legacy.decodedBytes,
    result.certified.decodedBytes,
    result.legacy.graphBuildCount,
    result.certified.graphBuildCount,
    result.certified.metricAttemptCount,
    result.comparison.exactSectionCount,
    result.comparison.differentGeometrySectionCount,
    result.comparison.routingOutcomeMismatchCount,
    result.comparison.maximumSampledDeviationMetres,
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((value) => csvField(value)).join(','))
    .join('\n');

  downloadText(
    `${exportBaseName()}.csv`,
    `${csv}\n`,
    'text/csv;charset=utf-8',
  );
}

elements.baseUrl.value = import.meta.env.VITE_ROUTING_DATA_BASE_URL ?? '';
elements.files.addEventListener('change', () => {
  void loadSelectedFiles().catch((error) => {
    elements.fileSummary.textContent =
      error instanceof Error ? error.message : String(error);
    loadedSegments = [];
    elements.run.disabled = true;
  });
});
elements.run.addEventListener('click', startSimulation);
elements.cancel.addEventListener('click', () => {
  activeWorker?.postMessage({ type: 'cancel' });
});
elements.exportJson.addEventListener('click', exportJson);
elements.exportCsv.addEventListener('click', exportCsv);
renderSummary();
