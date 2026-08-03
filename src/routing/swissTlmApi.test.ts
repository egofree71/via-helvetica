/**
 * Business context: protects the bounded GeoAdmin request policy used by the
 * browser-side routing worker. The suite verifies that transient failures get
 * one polite retry while timeouts remain visible errors and user cancellation
 * still stops immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAbortedRequest } from '../network/abort';
import { fetchSwissTlmNetworkData } from './swissTlmApi';

const TEST_EXTENT: [number, number, number, number] = [0, 0, 100, 100];
const EMPTY_IDENTIFY_PAYLOAD = { results: [] };

/** Creates the minimal Response contract consumed by the loader. */
function createResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(EMPTY_IDENTIFY_PAYLOAD),
  } as unknown as Response;
}

/** Lets already-resolved fetch promises reach the retry-delay branch. */
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('fetchSwissTlmNetworkData request resilience', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns a successful tile without retrying', async () => {
    fetchMock.mockResolvedValue(createResponse(200));

    await expect(
      fetchSwissTlmNetworkData(
        TEST_EXTENT,
        new AbortController().signal,
        { allowEmpty: true },
      ),
    ).resolves.toEqual({ roads: [], hikingTrails: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('disables hiking requests for the shared session after a combined rejection', async () => {
    let hikingEnrichmentEnabled = true;
    const onHikingEnrichmentUnavailable = vi.fn(() => {
      hikingEnrichmentEnabled = false;
    });
    fetchMock
      .mockResolvedValueOnce(createResponse(400))
      .mockResolvedValueOnce(createResponse(200))
      .mockResolvedValueOnce(createResponse(200));

    await expect(
      fetchSwissTlmNetworkData(
        TEST_EXTENT,
        new AbortController().signal,
        {
          allowEmpty: true,
          shouldRequestHikingEnrichment: () =>
            hikingEnrichmentEnabled,
          onHikingEnrichmentUnavailable,
        },
      ),
    ).resolves.toEqual({ roads: [], hikingTrails: [] });

    await expect(
      fetchSwissTlmNetworkData(
        TEST_EXTENT,
        new AbortController().signal,
        {
          allowEmpty: true,
          shouldRequestHikingEnrichment: () =>
            hikingEnrichmentEnabled,
          onHikingEnrichmentUnavailable,
        },
      ),
    ).resolves.toEqual({ roads: [], hikingTrails: [] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'ch.swisstopo.swisstlm3d-wanderwege',
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'ch.swisstopo.swisstlm3d-strassen',
    );
    expect(String(fetchMock.mock.calls[1][0])).not.toContain(
      'ch.swisstopo.swisstlm3d-wanderwege',
    );
    expect(String(fetchMock.mock.calls[2][0])).not.toContain(
      'ch.swisstopo.swisstlm3d-wanderwege',
    );
    expect(onHikingEnrichmentUnavailable).toHaveBeenCalledTimes(1);
  });

  it('retries one transient network failure after a jittered delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(createResponse(200));

    const pending = fetchSwissTlmNetworkData(
      TEST_EXTENT,
      new AbortController().signal,
      { allowEmpty: true },
    );

    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ roads: [], hikingTrails: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries one transient GeoAdmin service response', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock
      .mockResolvedValueOnce(createResponse(503))
      .mockResolvedValueOnce(createResponse(200));

    const pending = fetchSwissTlmNetworkData(
      TEST_EXTENT,
      new AbortController().signal,
      { allowEmpty: true },
    );

    await flushPromises();
    await vi.advanceTimersByTimeAsync(400);

    await expect(pending).resolves.toEqual({ roads: [], hikingTrails: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('respects a short Retry-After value for rate limiting', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(createResponse(429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(createResponse(200));

    const pending = fetchSwissTlmNetworkData(
      TEST_EXTENT,
      new AbortController().signal,
      { allowEmpty: true },
    );

    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ roads: [], hikingTrails: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not shorten a long provider-requested Retry-After delay', async () => {
    fetchMock.mockResolvedValue(
      createResponse(429, { 'Retry-After': '60' }),
    );

    await expect(
      fetchSwissTlmNetworkData(
        TEST_EXTENT,
        new AbortController().signal,
        { allowEmpty: true },
      ),
    ).rejects.toThrow('GeoAdmin identify request failed (429).');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the timeout active while the successful response body is read', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        const response = createResponse(200);
        response.json = vi.fn(
          () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            }),
        );
        return Promise.resolve(response);
      })
      .mockResolvedValueOnce(createResponse(200));

    const pending = fetchSwissTlmNetworkData(
      TEST_EXTENT,
      new AbortController().signal,
      { allowEmpty: true },
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(400);

    await expect(pending).resolves.toEqual({ roads: [], hikingTrails: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a timeout once and surfaces the final timeout as a normal error', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();

    const pending = fetchSwissTlmNetworkData(
      TEST_EXTENT,
      controller.signal,
      { allowEmpty: true },
    );
    const rejection = pending.catch((error: unknown) => error);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error).toMatchObject({ name: 'GeoAdminRequestTimeoutError' });
    expect(isAbortedRequest(error, controller.signal)).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry an intentional route cancellation', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = fetchSwissTlmNetworkData(
      TEST_EXTENT,
      controller.signal,
      { allowEmpty: true },
    );

    await flushPromises();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('splits a road at an invalid midpoint instead of creating a shortcut', async () => {
    const response = createResponse(200);
    response.json = vi.fn().mockResolvedValue({
      results: [
        {
          layerBodId: 'ch.swisstopo.swisstlm3d-strassen',
          featureId: 'road-1',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0, 400],
              [10, 0, 401],
              [Number.NaN, 0, 402],
              [20, 0, 403],
              [30, 0, 404],
            ],
          },
        },
      ],
    });
    fetchMock.mockResolvedValue(response);

    const result = await fetchSwissTlmNetworkData(
      TEST_EXTENT,
      new AbortController().signal,
      { allowEmpty: true },
    );

    expect(result.roads[0].lines).toEqual([
      [[0, 0, 400], [10, 0, 401]],
      [[20, 0, 403], [30, 0, 404]],
    ]);
  });

  it('retains different geometries that reuse the same provider feature ID', async () => {
    const response = createResponse(200);
    response.json = vi.fn().mockResolvedValue({
      results: [
        {
          layerBodId: 'ch.swisstopo.swisstlm3d-strassen',
          featureId: 'possibly-local-id',
          geometry: {
            type: 'LineString',
            coordinates: [[0, 0, 400], [10, 0, 401]],
          },
        },
        {
          layerBodId: 'ch.swisstopo.swisstlm3d-strassen',
          featureId: 'possibly-local-id',
          geometry: {
            type: 'LineString',
            coordinates: [[0, 10, 410], [10, 10, 411]],
          },
        },
        // The same conflicting geometry can be repeated by an adjacent request
        // tile and must not produce a third retained feature.
        {
          layerBodId: 'ch.swisstopo.swisstlm3d-strassen',
          featureId: 'possibly-local-id',
          geometry: {
            type: 'LineString',
            coordinates: [[0, 10, 410], [10, 10, 411]],
          },
        },
      ],
    });
    fetchMock.mockResolvedValue(response);
    const onDiagnostics = vi.fn();

    const result = await fetchSwissTlmNetworkData(
      TEST_EXTENT,
      new AbortController().signal,
      { allowEmpty: true, onDiagnostics },
    );

    expect(result.roads).toHaveLength(2);
    expect(new Set(result.roads.map((road) => road.id)).size).toBe(2);
    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ conflictingFeatureIds: 1 }),
    );
  });

  it('reports the actual Z coverage of accepted GeoAdmin road coordinates', async () => {
    const response = createResponse(200);
    response.json = vi.fn().mockResolvedValue({
      results: [
        {
          layerBodId: 'ch.swisstopo.swisstlm3d-strassen',
          featureId: 'mixed-z',
          geometry: {
            type: 'LineString',
            coordinates: [[0, 0, 400], [10, 0]],
          },
        },
      ],
    });
    fetchMock.mockResolvedValue(response);
    const onDiagnostics = vi.fn();

    await fetchSwissTlmNetworkData(
      TEST_EXTENT,
      new AbortController().signal,
      { allowEmpty: true, onDiagnostics },
    );

    expect(onDiagnostics).toHaveBeenCalledWith({
      roadCoordinates: 2,
      roadCoordinatesWithZ: 1,
      conflictingFeatureIds: 0,
    });
  });
});
