/**
 * Provider-popup tests protect the small presentation layer applied to official
 * military danger-zone metadata without depending on the live GeoAdmin service.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchShootingDangerZonePopup,
  type IdentifiedShootingDangerZone,
} from './shootingDangerZones';

const dangerZone: IdentifiedShootingDangerZone = {
  featureId: '4113.010',
  geometry: null,
  context: {
    coordinate: [2_672_000, 1_245_000],
    mapExtent: [2_670_000, 1_243_000, 2_674_000, 1_247_000],
    imageSize: [900, 700],
    language: 'fr',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stubs the official popup endpoint with deterministic HTML. */
function stubPopupResponse(html: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    ),
  );
}

describe('shooting danger-zone popup presentation', () => {
  it('removes PDF links and formats only shooting-notice time ranges', async () => {
    stubPopupResponse(`
      <table>
        <tr><td>ID-No lieu</td><td>4113.010.10</td></tr>
        <tr><td>Altitude</td><td>1200 - 1900 m</td></tr>
        <tr><td>Période</td><td>2026 - 2027</td></tr>
        <tr><td>Dates de tir actuelles</td><td>
          Lun 24.08.2026 0730 - 1900<br>
          Mar 25.08.2026 07:30 - 2200<br>
          Mer 26.08.2026 07:30 - 19:00<br>
          Jeu 27.08.2026 2560 - 1900<br>
          Ven 28.08.2026 0730 - 2400<br>
          Sam 29.08.2026 0730 – 1900
        </td><td><a href="https://example.admin.ch/notice.pdf">PDF</a></td></tr>
      </table>
    `);

    const html = await fetchShootingDangerZonePopup(
      dangerZone,
      new AbortController().signal,
    );
    const documentNode = new DOMParser().parseFromString(html, 'text/html');
    const text = documentNode.body.textContent ?? '';

    expect(text).toContain('24.08.2026 07:30 - 19:00');
    expect(text).toContain('25.08.2026 07:30 - 22:00');
    expect(text).toContain('26.08.2026 07:30 - 19:00');
    expect(text).toContain('27.08.2026 2560 - 1900');
    expect(text).toContain('28.08.2026 07:30 - 24:00');
    expect(text).toContain('29.08.2026 07:30 – 19:00');
    expect(text).toContain('1200 - 1900 m');
    expect(text).toContain('2026 - 2027');
    expect(text).toContain('4113.010.10');
    expect(documentNode.querySelector('a[href$=".pdf"]')).toBeNull();
    expect(text).not.toContain('PDF');
  });

  it('leaves an official date range untouched', async () => {
    stubPopupResponse(`
      <table>
        <tr><td>Dates de tir actuelles</td><td>
          Lun 24.08.2026 - Ven 28.08.2026<br>
          0730 - 1900
        </td><td><a href="https://example.admin.ch/notice.pdf">PDF</a></td></tr>
      </table>
    `);

    const html = await fetchShootingDangerZonePopup(
      dangerZone,
      new AbortController().signal,
    );
    const text = new DOMParser().parseFromString(html, 'text/html').body
      .textContent;

    expect(text).toContain('24.08.2026 - Ven 28.08.2026');
    expect(text).toContain('07:30 - 19:00');
    expect(text).not.toContain('20:26');
  });

  it('preserves sanitized markup and escaping while formatting times', async () => {
    stubPopupResponse(`
      <div class="htmlpopup-container" onclick="alert('bad')">
        <span class="cell-left">Truppe &lt;script&gt;alert(1)&lt;/script&gt;</span>
        <script>alert('removed')</script>
        <table>
          <tr><td>Dates</td><td>0730 - 1900</td>
            <td><a href="https://example.admin.ch/notice.pdf">PDF</a></td></tr>
        </table>
      </div>
    `);

    const html = await fetchShootingDangerZonePopup(
      dangerZone,
      new AbortController().signal,
    );
    const documentNode = new DOMParser().parseFromString(html, 'text/html');

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('07:30 - 19:00');
    expect(documentNode.querySelector('script')).toBeNull();
    expect(documentNode.querySelector('[onclick]')).toBeNull();
    expect(documentNode.querySelector('.htmlpopup-container')).not.toBeNull();
    expect(documentNode.querySelector('.cell-left')).not.toBeNull();
    expect(documentNode.querySelector('a[href$=".pdf"]')).toBeNull();
  });
});
