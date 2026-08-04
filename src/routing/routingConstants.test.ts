/**
 * Business context: protects the discrete binary-routing envelope policy. A
 * regression here can reintroduce excessive first-segment downloads or make
 * neighbouring edits miss the Worker graph cache unnecessarily.
 */
import { describe, expect, it } from 'vitest';
import {
  initialRouteEnvelopeMarginMetres,
  ROUTE_ENVELOPE_MARGIN_LADDER_METRES,
} from './routingConstants';

describe('routingConstants', () => {
  it('starts with typical-case margins because certification handles safe retries', () => {
    expect(initialRouteEnvelopeMarginMetres(0)).toBe(400);
    expect(initialRouteEnvelopeMarginMetres(173)).toBe(400);
    expect(initialRouteEnvelopeMarginMetres(657)).toBe(700);
    expect(initialRouteEnvelopeMarginMetres(928)).toBe(1_100);
    expect(initialRouteEnvelopeMarginMetres(1_500)).toBe(1_600);
    expect(initialRouteEnvelopeMarginMetres(3_000)).toBe(2_400);
  });

  it('keeps intermediate steps between local and legacy-sized footprints', () => {
    expect(ROUTE_ENVELOPE_MARGIN_LADDER_METRES).toEqual([
      400, 700, 1_100, 1_600, 2_400,
    ]);
  });

  it('caps long initial attempts at the final metric step before legacy fallback', () => {
    expect(initialRouteEnvelopeMarginMetres(15_000)).toBe(
      ROUTE_ENVELOPE_MARGIN_LADDER_METRES.at(-1),
    );
  });

  it('rejects invalid direct distances', () => {
    expect(() => initialRouteEnvelopeMarginMetres(-1)).toThrow(RangeError);
    expect(() => initialRouteEnvelopeMarginMetres(Number.NaN)).toThrow(
      RangeError,
    );
  });
});
