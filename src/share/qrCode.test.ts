/** Regression tests for the bounded dependency-free QR encoder. */
import { describe, expect, it } from 'vitest';
import {
  createQrCodeMatrix,
  createQrCodeSvgPath,
  QR_MAX_TEXT_BYTES,
} from './qrCode';

describe('createQrCodeMatrix', () => {
  it('builds the fixed Version 8 symbol used by swisstopo hand-offs', () => {
    const matrix = createQrCodeMatrix(
      'https://swisstopo.app/u/aHR0cHM6Ly9zaGFyZS52aWFoZWx2ZXRpY2EuY2gvZ3B4L3JvdXRlLmdweA',
    );

    expect(matrix.modules).toHaveLength(49);
    expect(matrix.modules.every((row) => row.length === 49)).toBe(true);
    expect(matrix.viewBoxSize).toBe(57);
    expect(createQrCodeSvgPath(matrix)).toMatch(/^M/u);
  });

  it('rejects payloads beyond the deliberately bounded byte capacity', () => {
    expect(() => createQrCodeMatrix('x'.repeat(QR_MAX_TEXT_BYTES + 1))).toThrow(
      /capacity/iu,
    );
  });
});
