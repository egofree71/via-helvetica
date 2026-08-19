// @vitest-environment node
/**
 * Business context: protects the STAC discovery step that makes the public-
 * transport stop pipeline reproducible without hard-coding today's mutable
 * GeoAdmin asset URL.
 */
import { describe, expect, it } from 'vitest';
import {
  collectStacAssets,
  discoverOfficialCsvAsset,
  selectOfficialCsvAsset,
} from './download-public-transport-stops-source.mjs';

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('public-transport stop source discovery', () => {
  it('selects the French LV95 CSV ZIP independently of asset ordering', () => {
    const candidates = collectStacAssets(
      {
        assets: {
          wgs84: {
            href: 'https://data.geo.admin.ch/example_4326_fr.csv.zip',
            'proj:epsg': 4326,
            'file:lang': 'fr',
          },
          german: {
            href: 'https://data.geo.admin.ch/example_2056_de.csv.zip',
            'proj:epsg': 2056,
            'file:lang': 'de',
          },
          french: {
            href: 'https://data.geo.admin.ch/example_2056_fr.csv.zip',
            'proj:epsg': 2056,
            'file:lang': 'fr-CH',
          },
        },
      },
      'collection',
    );

    expect(selectOfficialCsvAsset(candidates).href).toBe(
      'https://data.geo.admin.ch/example_2056_fr.csv.zip',
    );
  });

  it('supports legacy STAC assets whose language and projection are encoded in the filename', () => {
    const asset = selectOfficialCsvAsset([
      {
        key: 'asset-haltestellen-oev_2056_fr.csv.zip',
        asset: {
          href: 'https://data.geo.admin.ch/ch.bav.haltestellen-oev/haltestellen-oev/haltestellen-oev_2056_fr.csv.zip',
          type: 'application/zip',
        },
        source: 'item',
      },
    ]);

    expect(asset.key).toBe('asset-haltestellen-oev_2056_fr.csv.zip');
  });

  it('follows the collection items link when download assets are item-level', async () => {
    const collectionUrl =
      'https://data.geo.admin.ch/api/stac/v1/collections/ch.bav.haltestellen-oev';
    const itemsUrl = `${collectionUrl}/items`;
    const requested = [];
    const fetchMock = async (url) => {
      requested.push(String(url));
      if (String(url) === collectionUrl) {
        return jsonResponse({
          id: 'ch.bav.haltestellen-oev',
          links: [{ rel: 'items', href: itemsUrl }],
        });
      }
      if (String(url) === itemsUrl) {
        return jsonResponse({
          type: 'FeatureCollection',
          features: [
            {
              id: 'haltestellen-oev',
              assets: {
                csv: {
                  href: 'https://data.geo.admin.ch/haltestellen-oev_2056_fr.csv.zip',
                  'proj:epsg': 2056,
                  'file:lang': 'fr',
                  type: 'text/csv',
                },
              },
            },
          ],
          links: [],
        });
      }
      return new Response(null, { status: 404 });
    };

    const asset = await discoverOfficialCsvAsset(fetchMock);

    expect(asset.href).toBe(
      'https://data.geo.admin.ch/haltestellen-oev_2056_fr.csv.zip',
    );
    expect(requested).toEqual([collectionUrl, itemsUrl]);
  });

  it('fails loudly when STAC exposes no matching source asset', () => {
    expect(() =>
      selectOfficialCsvAsset([
        {
          key: 'gpkg',
          asset: {
            href: 'https://data.geo.admin.ch/example_2056_fr.gpkg.zip',
            'proj:epsg': 2056,
            'file:lang': 'fr',
          },
          source: 'collection',
        },
      ]),
    ).toThrow(/does not expose a French EPSG:2056 CSV ZIP/);
  });
});
