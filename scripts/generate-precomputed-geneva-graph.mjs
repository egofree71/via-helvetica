/**
 * Business context: compiles the experimental Geneva geometry cells into the
 * portable graph format consumed by the routing Worker. It transpiles and runs
 * the same pure TypeScript compiler used by live GeoAdmin routing, preventing
 * offline node, walkability, hiking-cost, or duplicate-edge rules from drifting.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOT = join(ROOT, 'public', 'routing-data', 'geneva');
const OUTPUT_ROOT = join(
  ROOT,
  'public',
  'routing-data',
  'geneva-precomputed',
);
const OUTPUT_CELLS = join(OUTPUT_ROOT, 'cells');
const TEMP_ROOT = join(ROOT, '.tmp-precomputed-routing-compiler');
const COMPILER_SOURCE = join(
  ROOT,
  'src',
  'routing',
  'precomputedRoutingGraph.ts',
);
const CELL_FORMAT_SOURCE = join(
  ROOT,
  'src',
  'routing',
  'staticRoutingCellFormat.ts',
);
const PRECOMPUTED_FORMAT_VERSION = 1;

/** Reads and parses one UTF-8 JSON file. */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Produces the compact local-index representation stored in one graph cell. */
function serializeGraphCell(sourceCell, graph) {
  const nodeIndexes = new Map();
  const nodes = graph.nodes.map((node, index) => {
    nodeIndexes.set(node.key, index);
    return [...node.coordinate];
  });
  const segments = graph.segments.map((segment) => {
    const startIndex = nodeIndexes.get(segment.startNodeKey);
    const endIndex = nodeIndexes.get(segment.endNodeKey);

    if (startIndex === undefined || endIndex === undefined) {
      throw new Error(`Compiled cell ${sourceCell.k} contains a missing node.`);
    }

    return segment.isHikingTrail
      ? [startIndex, endIndex, segment.cost, 1]
      : [startIndex, endIndex, segment.cost];
  });

  return {
    v: PRECOMPUTED_FORMAT_VERSION,
    k: sourceCell.k,
    e: sourceCell.e,
    n: nodes,
    s: segments,
    f: graph.sourceRoadFeatures,
  };
}

/** Transpiles the pure shared compiler without introducing a second algorithm. */
async function loadSharedCompiler() {
  const require = createRequire(import.meta.url);
  let command = 'tsc';
  let commandPrefix = [];

  try {
    const typescriptPackage = require.resolve('typescript/package.json');
    command = process.execPath;
    commandPrefix = [join(dirname(typescriptPackage), 'bin', 'tsc')];
  } catch {
    // A globally installed tsc keeps the standalone generator usable in a
    // diagnostic checkout whose npm registry cannot restore every dependency.
  }

  await rm(TEMP_ROOT, { recursive: true, force: true });
  await mkdir(TEMP_ROOT, { recursive: true });

  const compiledRoot = join(TEMP_ROOT, 'compiled');
  const compilerConfigPath = join(TEMP_ROOT, 'tsconfig.json');
  await writeFile(
    compilerConfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          types: [],
          rootDir: dirname(COMPILER_SOURCE),
          outDir: compiledRoot,
        },
        files: [COMPILER_SOURCE, CELL_FORMAT_SOURCE],
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = spawnSync(
    command,
    [...commandPrefix, '-p', compilerConfigPath],
    { cwd: ROOT, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(
      `Shared graph compiler transpilation failed.\n${result.stdout}${result.stderr}`,
    );
  }

  const compilerModulePath = join(compiledRoot, 'precomputedRoutingGraph.js');
  const cellFormatModulePath = join(compiledRoot, 'staticRoutingCellFormat.js');
  const [compiler, cellFormat] = await Promise.all([
    import(`${pathToFileURL(compilerModulePath).href}?generated=${Date.now()}`),
    import(`${pathToFileURL(cellFormatModulePath).href}?generated=${Date.now()}`),
  ]);
  return { ...compiler, ...cellFormat };
}

async function main() {
  const sourceManifest = await readJson(join(SOURCE_ROOT, 'manifest.json'));

  if (
    sourceManifest.version !== 2 ||
    sourceManifest.format !== 'via-helvetica-static-routing-cells' ||
    !Array.isArray(sourceManifest.nonEmptyCellKeys)
  ) {
    throw new Error('Geneva geometry-cell manifest is missing or incompatible.');
  }

  const {
    compilePrecomputedRoutingGraph,
    readStaticRoutingCell,
    STATIC_ROUTING_FORMAT,
    STATIC_ROUTING_FORMAT_VERSION,
  } = await loadSharedCompiler();
  if (
    sourceManifest.version !== STATIC_ROUTING_FORMAT_VERSION ||
    sourceManifest.format !== STATIC_ROUTING_FORMAT
  ) {
    throw new Error('Shared static-cell contract does not match the manifest.');
  }

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_CELLS, { recursive: true });

  const nonEmptyCellKeys = [];
  let uncompressedCellBytes = 0;
  let totalNodesBeforeCellDeduplication = 0;
  let totalSegmentsBeforeCellDeduplication = 0;
  let hikingSegmentsBeforeCellDeduplication = 0;

  for (const key of sourceManifest.nonEmptyCellKeys) {
    const [column, row] = key.split(':');
    const sourceCell = await readJson(
      join(SOURCE_ROOT, 'cells', `${column}_${row}.json`),
    );
    const validatedCell = readStaticRoutingCell(sourceCell, key);
    const graph = compilePrecomputedRoutingGraph({
      roads: validatedCell.roads,
      hikingTrails: [],
    });

    if (graph.segments.length === 0) {
      continue;
    }

    const outputCell = serializeGraphCell(sourceCell, graph);
    const encoded = JSON.stringify(outputCell);
    await writeFile(
      join(OUTPUT_CELLS, `${column}_${row}.json`),
      encoded,
      'utf8',
    );
    nonEmptyCellKeys.push(key);
    uncompressedCellBytes += Buffer.byteLength(encoded);
    totalNodesBeforeCellDeduplication += graph.nodes.length;
    totalSegmentsBeforeCellDeduplication += graph.segments.length;
    hikingSegmentsBeforeCellDeduplication += graph.segments.filter(
      (segment) => segment.isHikingTrail,
    ).length;
  }

  const manifest = {
    version: PRECOMPUTED_FORMAT_VERSION,
    format: 'via-helvetica-precomputed-routing-graph',
    projection: 'EPSG:2056',
    cellSizeMetres: sourceManifest.cellSizeMetres,
    extent: sourceManifest.extent,
    cellPathTemplate: 'cells/{column}_{row}.json',
    nonEmptyCellCount: nonEmptyCellKeys.length,
    sourceGeometryFormatVersion: sourceManifest.version,
    sourceFiles: sourceManifest.sourceFiles,
    sourceSizeBytes: sourceManifest.sourceSizeBytes,
    sourceSha256: sourceManifest.sourceSha256,
    sourceLayer: sourceManifest.sourceLayer,
    cellAssignment: sourceManifest.cellAssignment,
    nonEmptyCellKeys,
    uncompressedCellBytes,
    totalNodesBeforeCellDeduplication,
    totalSegmentsBeforeCellDeduplication,
    hikingSegmentsBeforeCellDeduplication,
  };

  await writeFile(
    join(OUTPUT_ROOT, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await rm(TEMP_ROOT, { recursive: true, force: true });

  console.log(
    `Generated ${nonEmptyCellKeys.length} precomputed Geneva graph cells.`,
  );
  console.log(
    `Raw JSON size: ${(uncompressedCellBytes / 1024 / 1024).toFixed(2)} MiB.`,
  );
  console.log(
    `Cell-local totals: ${totalNodesBeforeCellDeduplication} nodes, ` +
      `${totalSegmentsBeforeCellDeduplication} segments, ` +
      `${hikingSegmentsBeforeCellDeduplication} hiking segments.`,
  );
}

main().catch(async (error) => {
  await rm(TEMP_ROOT, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
