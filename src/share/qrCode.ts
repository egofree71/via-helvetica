/**
 * Business context: renders the short swisstopo hand-off URL as a QR code
 * without adding a third-party QR service or a runtime dependency. The share
 * URL format is deliberately bounded by `swisstopoShare.ts`, so a fixed
 * Version 8 / Level L QR symbol is sufficient for this focused transfer flow.
 */

/** QR Code Version 8 is a 49 × 49 module symbol. */
const QR_VERSION = 8;
/** Version 8 / Level L carries 194 data codewords split across two blocks. */
const QR_DATA_CODEWORDS = 194;
/** Each Version 8 / Level L block contains 97 data codewords. */
const QR_DATA_CODEWORDS_PER_BLOCK = 97;
/** Each Version 8 / Level L block adds 24 Reed-Solomon codewords. */
const QR_ECC_CODEWORDS_PER_BLOCK = 24;
/** Four light modules on each edge are required as the QR quiet zone. */
const QR_QUIET_ZONE_MODULES = 4;
/** Byte-mode capacity after the mode and character-count fields. */
export const QR_MAX_TEXT_BYTES = 192;
/** Version 8 alignment-pattern centres measured from the top-left module. */
const QR_ALIGNMENT_PATTERN_CENTERS = [6, 24, 42] as const;
/** Level L format bits defined by ISO/IEC 18004. */
const QR_ERROR_CORRECTION_FORMAT_BITS = 1;
/** A fixed valid mask keeps this tiny encoder deterministic. */
const QR_MASK_PATTERN = 0;
/** Primitive polynomial used by QR Reed-Solomon arithmetic in GF(2^8). */
const QR_REED_SOLOMON_PRIMITIVE_POLYNOMIAL = 0x11d;

/** Boolean QR matrix plus the quiet-zone-aware SVG viewBox size. */
export interface QrCodeMatrix {
  /** Dark/light modules without the quiet zone. */
  modules: boolean[][];
  /** Number of modules including the four-module quiet zone on each side. */
  viewBoxSize: number;
}

/**
 * Appends one unsigned integer to the QR bit stream, most-significant bit first.
 *
 * @param bits - Mutable output bit buffer.
 * @param value - Unsigned value whose low `length` bits are appended.
 * @param length - Number of bits to append.
 * @returns Nothing; `bits` is extended in place.
 */
function appendBits(bits: number[], value: number, length: number): void {
  for (let bit = length - 1; bit >= 0; bit -= 1) {
    bits.push((value >>> bit) & 1);
  }
}

/**
 * Multiplies two bytes in the QR Code GF(2^8) field.
 * Reduction by the QR primitive polynomial keeps intermediate values inside
 * one byte while preserving the field arithmetic required by Reed-Solomon.
 *
 * @param left - First field element in the range 0..255.
 * @param right - Second field element in the range 0..255.
 * @returns Product in the QR GF(2^8) field.
 */
function reedSolomonMultiply(left: number, right: number): number {
  let result = 0;
  let multiplicand = left;
  let multiplier = right;

  while (multiplier > 0) {
    if ((multiplier & 1) !== 0) {
      result ^= multiplicand;
    }

    multiplier >>>= 1;
    multiplicand <<= 1;

    if ((multiplicand & 0x100) !== 0) {
      multiplicand ^= QR_REED_SOLOMON_PRIMITIVE_POLYNOMIAL;
    }
  }

  return result;
}

/**
 * Builds the monic Reed-Solomon generator polynomial for one QR block.
 * The roots are successive powers of two, as required by QR error correction.
 *
 * @param degree - Number of error-correction codewords in the block.
 * @returns Generator coefficients ordered for the remainder calculation.
 */
function createReedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;

  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < degree; coefficient += 1) {
      result[coefficient] = reedSolomonMultiply(
        result[coefficient],
        root,
      );

      if (coefficient + 1 < degree) {
        result[coefficient] ^= result[coefficient + 1];
      }
    }

    root = reedSolomonMultiply(root, 0x02);
  }

  return result;
}

/**
 * Calculates the Reed-Solomon remainder appended to one QR data block.
 * The fixed-size shift register avoids allocating a polynomial per input byte.
 *
 * @param data - Data codewords belonging to one QR error-correction block.
 * @param divisor - Generator polynomial returned by `createReedSolomonDivisor`.
 * @returns Error-correction codewords for that block.
 */
function calculateReedSolomonRemainder(
  data: number[],
  divisor: number[],
): number[] {
  const result = new Array<number>(divisor.length).fill(0);

  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;

    for (let index = 0; index < result.length; index += 1) {
      result[index] ^= reedSolomonMultiply(divisor[index], factor);
    }
  }

  return result;
}

/**
 * Encodes UTF-8 text into the 194 Version 8 / Level L data codewords.
 * Byte mode is intentionally fixed because the payload is a URL and the
 * application values deterministic behaviour over broader QR optimizations.
 *
 * @param text - swisstopo hand-off URL to encode.
 * @returns Exactly 194 padded data codewords.
 * @throws {Error} If the UTF-8 payload exceeds the fixed Version 8 capacity.
 */
function encodeDataCodewords(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));

  if (bytes.length > QR_MAX_TEXT_BYTES) {
    throw new Error(
      `QR payload exceeds the ${QR_MAX_TEXT_BYTES}-byte Version 8 capacity.`,
    );
  }

  const bits: number[] = [];

  // Byte mode is appropriate for URLs and keeps the encoder independent from
  // locale-specific character-mode optimizations.
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);

  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }

  const capacityBits = QR_DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords: number[] = [];

  for (let offset = 0; offset < bits.length; offset += 8) {
    let byte = 0;

    for (let bit = 0; bit < 8; bit += 1) {
      byte = (byte << 1) | bits[offset + bit];
    }

    codewords.push(byte);
  }

  for (let padByte = 0xec; codewords.length < QR_DATA_CODEWORDS; padByte ^= 0xfd) {
    codewords.push(padByte);
  }

  return codewords;
}

/**
 * Adds and interleaves the two Version 8 / Level L error-correction blocks.
 * QR readers expect block interleaving rather than each data/remainder block
 * being written contiguously into the matrix.
 *
 * @param dataCodewords - Complete padded Version 8 / Level L data payload.
 * @returns Interleaved data and Reed-Solomon codewords ready for matrix placement.
 */
function addErrorCorrection(dataCodewords: number[]): number[] {
  const firstBlock = dataCodewords.slice(0, QR_DATA_CODEWORDS_PER_BLOCK);
  const secondBlock = dataCodewords.slice(QR_DATA_CODEWORDS_PER_BLOCK);
  const divisor = createReedSolomonDivisor(QR_ECC_CODEWORDS_PER_BLOCK);
  const firstRemainder = calculateReedSolomonRemainder(firstBlock, divisor);
  const secondRemainder = calculateReedSolomonRemainder(secondBlock, divisor);
  const interleaved: number[] = [];

  for (let index = 0; index < QR_DATA_CODEWORDS_PER_BLOCK; index += 1) {
    interleaved.push(firstBlock[index], secondBlock[index]);
  }

  for (let index = 0; index < QR_ECC_CODEWORDS_PER_BLOCK; index += 1) {
    interleaved.push(firstRemainder[index], secondRemainder[index]);
  }

  return interleaved;
}

/** Marks one function module so data placement and masking never overwrite it. */
function setFunctionModule(
  modules: boolean[][],
  functionModules: boolean[][],
  x: number,
  y: number,
  isDark: boolean,
): void {
  modules[y][x] = isDark;
  functionModules[y][x] = true;
}

/** Draws one finder pattern including its one-module light separator. */
function drawFinderPattern(
  modules: boolean[][],
  functionModules: boolean[][],
  centerX: number,
  centerY: number,
): void {
  const size = modules.length;

  for (let deltaY = -4; deltaY <= 4; deltaY += 1) {
    for (let deltaX = -4; deltaX <= 4; deltaX += 1) {
      const x = centerX + deltaX;
      const y = centerY + deltaY;

      if (x < 0 || x >= size || y < 0 || y >= size) {
        continue;
      }

      const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      setFunctionModule(
        modules,
        functionModules,
        x,
        y,
        distance !== 2 && distance !== 4,
      );
    }
  }
}

/** Draws one 5 × 5 alignment pattern. */
function drawAlignmentPattern(
  modules: boolean[][],
  functionModules: boolean[][],
  centerX: number,
  centerY: number,
): void {
  for (let deltaY = -2; deltaY <= 2; deltaY += 1) {
    for (let deltaX = -2; deltaX <= 2; deltaX += 1) {
      setFunctionModule(
        modules,
        functionModules,
        centerX + deltaX,
        centerY + deltaY,
        Math.max(Math.abs(deltaX), Math.abs(deltaY)) !== 1,
      );
    }
  }
}

/** Calculates and draws the 15 format bits for Level L and the selected mask. */
function drawFormatBits(
  modules: boolean[][],
  functionModules: boolean[][],
): void {
  const size = modules.length;
  const data =
    (QR_ERROR_CORRECTION_FORMAT_BITS << 3) | QR_MASK_PATTERN;
  let remainder = data;

  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }

  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index: number) => ((bits >>> index) & 1) !== 0;

  for (let index = 0; index <= 5; index += 1) {
    setFunctionModule(modules, functionModules, 8, index, bit(index));
  }

  setFunctionModule(modules, functionModules, 8, 7, bit(6));
  setFunctionModule(modules, functionModules, 8, 8, bit(7));
  setFunctionModule(modules, functionModules, 7, 8, bit(8));

  for (let index = 9; index < 15; index += 1) {
    setFunctionModule(
      modules,
      functionModules,
      14 - index,
      8,
      bit(index),
    );
  }

  for (let index = 0; index < 8; index += 1) {
    setFunctionModule(
      modules,
      functionModules,
      size - 1 - index,
      8,
      bit(index),
    );
  }

  for (let index = 8; index < 15; index += 1) {
    setFunctionModule(
      modules,
      functionModules,
      8,
      size - 15 + index,
      bit(index),
    );
  }

  // This fixed dark module is part of the QR function pattern rather than data.
  setFunctionModule(modules, functionModules, 8, size - 8, true);
}

/** Draws the 18 version-information bits required for Version 7 and later. */
function drawVersionBits(
  modules: boolean[][],
  functionModules: boolean[][],
): void {
  const size = modules.length;
  let remainder = QR_VERSION;

  for (let index = 0; index < 12; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }

  const bits = (QR_VERSION << 12) | remainder;

  for (let index = 0; index < 18; index += 1) {
    const isDark = ((bits >>> index) & 1) !== 0;
    const x = size - 11 + (index % 3);
    const y = Math.floor(index / 3);
    setFunctionModule(modules, functionModules, x, y, isDark);
    setFunctionModule(modules, functionModules, y, x, isDark);
  }
}

/** Draws every non-data pattern and reserves the corresponding matrix cells. */
function drawFunctionPatterns(
  modules: boolean[][],
  functionModules: boolean[][],
): void {
  const size = modules.length;

  for (let index = 0; index < size; index += 1) {
    setFunctionModule(
      modules,
      functionModules,
      6,
      index,
      index % 2 === 0,
    );
    setFunctionModule(
      modules,
      functionModules,
      index,
      6,
      index % 2 === 0,
    );
  }

  drawFinderPattern(modules, functionModules, 3, 3);
  drawFinderPattern(modules, functionModules, size - 4, 3);
  drawFinderPattern(modules, functionModules, 3, size - 4);

  for (let row = 0; row < QR_ALIGNMENT_PATTERN_CENTERS.length; row += 1) {
    for (
      let column = 0;
      column < QR_ALIGNMENT_PATTERN_CENTERS.length;
      column += 1
    ) {
      const last = QR_ALIGNMENT_PATTERN_CENTERS.length - 1;

      if (
        (row === 0 && column === 0) ||
        (row === 0 && column === last) ||
        (row === last && column === 0)
      ) {
        continue;
      }

      drawAlignmentPattern(
        modules,
        functionModules,
        QR_ALIGNMENT_PATTERN_CENTERS[column],
        QR_ALIGNMENT_PATTERN_CENTERS[row],
      );
    }
  }

  drawFormatBits(modules, functionModules);
  drawVersionBits(modules, functionModules);
}

/**
 * Places the interleaved payload through the standard two-column QR scan.
 * Function modules are skipped so finder, timing, alignment, version, and
 * format patterns can never be overwritten by payload bits.
 *
 * @param modules - Mutable dark/light QR matrix.
 * @param functionModules - Reservation mask for non-data modules.
 * @param codewords - Interleaved data and error-correction bytes.
 * @returns Nothing; `modules` is updated in place.
 * @throws {Error} If matrix traversal does not consume the complete payload.
 */
function drawCodewords(
  modules: boolean[][],
  functionModules: boolean[][],
  codewords: number[],
): void {
  const size = modules.length;
  const dataBits: number[] = [];

  for (const codeword of codewords) {
    appendBits(dataBits, codeword, 8);
  }

  let bitIndex = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }

    for (let vertical = 0; vertical < size; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vertical : vertical;

      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;

        if (functionModules[y][x]) {
          continue;
        }

        modules[y][x] = dataBits[bitIndex] === 1;
        bitIndex += 1;
      }
    }
  }

  if (bitIndex !== dataBits.length) {
    throw new Error('QR data placement did not consume the complete payload.');
  }
}

/**
 * Applies the deterministic mask to data modules only.
 * Function modules are deliberately excluded because the format bits already
 * advertise mask pattern 0 to QR readers.
 *
 * @param modules - Mutable dark/light QR matrix.
 * @param functionModules - Reservation mask for non-data modules.
 * @returns Nothing; data modules are toggled in place.
 */
function applyMask(
  modules: boolean[][],
  functionModules: boolean[][],
): void {
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (!functionModules[y][x] && (x + y) % 2 === 0) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

/**
 * Encodes a bounded text payload into a valid QR Code matrix.
 *
 * @param text - Short hand-off URL to encode.
 * @returns Dark/light modules and the quiet-zone-aware SVG size.
 * @throws {Error} If the UTF-8 payload exceeds Version 8 / Level L capacity.
 */
export function createQrCodeMatrix(text: string): QrCodeMatrix {
  const size = QR_VERSION * 4 + 17;
  const modules = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const functionModules = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const codewords = addErrorCorrection(encodeDataCodewords(text));

  drawFunctionPatterns(modules, functionModules);
  drawCodewords(modules, functionModules, codewords);
  applyMask(modules, functionModules);
  // Format modules were excluded from masking and already describe mask 0.

  return {
    modules,
    viewBoxSize: size + QR_QUIET_ZONE_MODULES * 2,
  };
}

/**
 * Converts a QR matrix into one compact SVG path using horizontal dark runs.
 *
 * @param matrix - Matrix returned by `createQrCodeMatrix`.
 * @returns SVG path data positioned inside the required quiet zone.
 */
export function createQrCodeSvgPath(matrix: QrCodeMatrix): string {
  const commands: string[] = [];

  for (let y = 0; y < matrix.modules.length; y += 1) {
    const row = matrix.modules[y];
    let x = 0;

    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }

      const start = x;

      while (x < row.length && row[x]) {
        x += 1;
      }

      const runLength = x - start;
      const drawX = start + QR_QUIET_ZONE_MODULES;
      const drawY = y + QR_QUIET_ZONE_MODULES;
      commands.push(
        `M${drawX} ${drawY}h${runLength}v1h-${runLength}z`,
      );
    }
  }

  return commands.join('');
}
