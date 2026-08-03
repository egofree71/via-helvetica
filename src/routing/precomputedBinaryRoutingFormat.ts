/**
 * Business context: defines the versioned binary contract shared by the
 * offline binary graph generator and the browser Worker. Columnar typed-array
 * sections preserve global integer node identity and final edge costs without
 * JSON parsing or per-node JavaScript objects.
 */
import type { CellKey } from './routingGrid';

/** Four-byte ASCII signature at the start of every binary graph cell. */
export const PRECOMPUTED_BINARY_MAGIC = 'VHRG';
/** Current binary-cell contract version. */
export const PRECOMPUTED_BINARY_FORMAT_VERSION = 3;
/** Manifest format identifier for compatibility checks. */
export const PRECOMPUTED_BINARY_FORMAT =
  'via-helvetica-precomputed-binary-routing-graph';
/** Fixed header length in bytes; all typed-array sections begin on 4-byte boundaries. */
export const PRECOMPUTED_BINARY_HEADER_BYTES = 104;
/** Byte offset of the generator revision in the v3 header. */
export const PRECOMPUTED_BINARY_GENERATOR_VERSION_OFFSET = 64;
/** Byte offset of the 32-byte dataset build identifier in the v3 header. */
export const PRECOMPUTED_BINARY_DATASET_BUILD_ID_OFFSET = 68;
/** Byte length of the binary SHA-256 dataset build identifier. */
export const PRECOMPUTED_BINARY_DATASET_BUILD_ID_BYTES = 32;
/** Byte offset of the CRC32 covering every byte after the fixed header. */
export const PRECOMPUTED_BINARY_PAYLOAD_CRC32_OFFSET = 100;
/** Manifest identifier for the payload-integrity algorithm. */
export const PRECOMPUTED_BINARY_CHECKSUM = 'crc32';
/** Number of stored horizontal integer units per metre (centimetres). */
export const PRECOMPUTED_BINARY_XY_SCALE = 100;
/** Number of stored vertical integer units per metre (decimetres). */
export const PRECOMPUTED_BINARY_Z_SCALE = 10;
/** Number of fixed-point integer units per routing-cost unit (0.0001 precision). */
export const PRECOMPUTED_BINARY_COST_SCALE = 10_000;
/** Signed 32-bit sentinel used when a source node has no elevation. */
export const PRECOMPUTED_BINARY_NO_ELEVATION = -2_147_483_648;
/**
 * Horizontal allowance around a referenced cell in metres. It complements the
 * declared dataset extent for bounded extracts whose complete, unclipped source
 * features continue beyond the exact extraction boundary.
 */
export const PRECOMPUTED_BINARY_COORDINATE_MARGIN_METRES = 6_000;
/** Lowest plausible swissTLM3D elevation accepted by the defensive parser. */
export const PRECOMPUTED_BINARY_MIN_ELEVATION_METRES = -1_000;
/** Highest plausible swissTLM3D elevation accepted by the defensive parser. */
export const PRECOMPUTED_BINARY_MAX_ELEVATION_METRES = 10_000;

/** Dataset identity fields repeated in every v3 cell header. */
export interface PrecomputedBinaryDatasetIdentity {
  /** Offline generator revision expected by the manifest. */
  generatorVersion: number;
  /** Lowercase SHA-256 identifying one complete generated release. */
  datasetBuildId: string;
  /** Dataset-wide exclusive upper bound for global node IDs. */
  globalNodeCount: number;
  /** Dataset-wide exclusive upper bound for global edge IDs. */
  globalEdgeCount: number;
}

/** Typed views over one validated, independently loadable graph cell. */
export interface PrecomputedBinaryRoutingCell {
  /** Routing-grid key encoded by the file header. */
  key: CellKey;
  /** Globally stable node identifiers in strictly increasing order. */
  nodeIds: Uint32Array;
  /** Absolute EPSG:2056 easting values quantized to centimetres. */
  nodeX: Int32Array;
  /** Absolute EPSG:2056 northing values quantized to centimetres. */
  nodeY: Int32Array;
  /** Elevations in decimetres, or `PRECOMPUTED_BINARY_NO_ELEVATION`. */
  nodeZ: Int32Array;
  /** Globally stable edge identifiers in strictly increasing order. */
  edgeIds: Uint32Array;
  /** Global identifier of each edge's first endpoint. */
  edgeStartNodeIds: Uint32Array;
  /** Global identifier of each edge's second endpoint. */
  edgeEndNodeIds: Uint32Array;
  /** Positive final route costs quantized by `PRECOMPUTED_BINARY_COST_SCALE`. */
  edgeCosts: Uint32Array;
  /** Edge flags; bit 0 identifies official hiking segments. */
  edgeFlags: Uint8Array;
  /** Total global node-ID range declared by the generated dataset. */
  globalNodeCount: number;
  /** Total global edge-ID range declared by the generated dataset. */
  globalEdgeCount: number;
  /** Diagnostic source-road count retained by the cell header. */
  sourceRoadFeatures: number;
  /** Original response buffer retained by the typed-array views. */
  buffer: ArrayBuffer;
}

/** Byte offsets for every columnar section in one binary cell. */
export interface PrecomputedBinaryLayout {
  nodeIdsOffset: number;
  nodeXOffset: number;
  nodeYOffset: number;
  nodeZOffset: number;
  edgeIdsOffset: number;
  edgeStartOffset: number;
  edgeEndOffset: number;
  edgeCostOffset: number;
  edgeFlagsOffset: number;
  byteLength: number;
}

/** Aligns a byte count for Uint32Array and Int32Array views without Int32 coercion. */
function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

/**
 * Calculates the deterministic binary section layout.
 * @param nodeCount - Number of node records stored by the cell.
 * @param edgeCount - Number of logical edge references stored by the cell.
 * @returns Four-byte-aligned offsets and exact file length.
 * @throws {RangeError} When counts cannot be represented safely by the format.
 */
export function precomputedBinaryLayout(
  nodeCount: number,
  edgeCount: number,
): PrecomputedBinaryLayout {
  if (
    !Number.isSafeInteger(nodeCount) ||
    nodeCount < 0 ||
    !Number.isSafeInteger(edgeCount) ||
    edgeCount < 0
  ) {
    throw new RangeError('Precomputed binary record counts are invalid.');
  }

  let offset = PRECOMPUTED_BINARY_HEADER_BYTES;
  const nodeIdsOffset = offset;
  offset += nodeCount * Uint32Array.BYTES_PER_ELEMENT;
  const nodeXOffset = offset;
  offset += nodeCount * Int32Array.BYTES_PER_ELEMENT;
  const nodeYOffset = offset;
  offset += nodeCount * Int32Array.BYTES_PER_ELEMENT;
  const nodeZOffset = offset;
  offset += nodeCount * Int32Array.BYTES_PER_ELEMENT;
  const edgeIdsOffset = offset;
  offset += edgeCount * Uint32Array.BYTES_PER_ELEMENT;
  const edgeStartOffset = offset;
  offset += edgeCount * Uint32Array.BYTES_PER_ELEMENT;
  const edgeEndOffset = offset;
  offset += edgeCount * Uint32Array.BYTES_PER_ELEMENT;
  const edgeCostOffset = offset;
  offset += edgeCount * Uint32Array.BYTES_PER_ELEMENT;
  const edgeFlagsOffset = offset;
  offset += edgeCount;
  const byteLength = align4(offset);

  if (!Number.isSafeInteger(byteLength) || byteLength > 0xffffffff) {
    throw new RangeError('Precomputed binary cell exceeds the 32-bit format limit.');
  }

  return {
    nodeIdsOffset,
    nodeXOffset,
    nodeYOffset,
    nodeZOffset,
    edgeIdsOffset,
    edgeStartOffset,
    edgeEndOffset,
    edgeCostOffset,
    edgeFlagsOffset,
    byteLength,
  };
}

/** Precomputed lookup table for the standard IEEE CRC32 polynomial. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

/**
 * Calculates CRC32 for a contiguous byte range.
 * @param bytes - Buffer view containing the protected payload.
 * @param startOffset - First included byte; defaults to the beginning.
 * @returns Unsigned 32-bit CRC32 value.
 */
export function precomputedBinaryCrc32(
  bytes: Uint8Array,
  startOffset = 0,
): number {
  if (!Number.isInteger(startOffset) || startOffset < 0 || startOffset > bytes.length) {
    throw new RangeError('CRC32 start offset is outside the supplied byte view.');
  }

  let crc = 0xffffffff;
  for (let index = startOffset; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Returns a lowercase hexadecimal build ID from the 32 header bytes. */
export function precomputedBinaryBuildIdToHex(bytes: Uint8Array): string {
  if (bytes.length !== PRECOMPUTED_BINARY_DATASET_BUILD_ID_BYTES) {
    throw new RangeError('Precomputed binary dataset build ID has an invalid length.');
  }

  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Parses a lowercase or uppercase 64-character SHA-256 build ID. */
export function precomputedBinaryBuildIdFromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('Precomputed binary dataset build ID is invalid.');
  }

  const bytes = new Uint8Array(PRECOMPUTED_BINARY_DATASET_BUILD_ID_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Returns whether typed arrays use the little-endian order required by the format. */
export function isLittleEndianRuntime(): boolean {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, 0x00ff, true);
  return new Uint16Array(buffer)[0] === 0x00ff;
}
