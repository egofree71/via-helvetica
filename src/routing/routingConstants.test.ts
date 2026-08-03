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
  it('uses the smallest metric step that covers endpoint snapping and section length', () => {
    expect(initialRouteEnvelopeMarginMetres(0)).toBe(400);
    expect(initialRouteEnvelopeMarginMetres(100)).toBe(400);
    expect(initialRouteEnvelopeMarginMetres(173)).toBe(900);
    expect(initialRouteEnvelopeMarginMetres(500)).toBe(900);
    expect(initialRouteEnvelopeMarginMetres(1_000)).toBe(2_400);
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
