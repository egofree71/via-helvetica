// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertCors } from './verify-published-public-transport-stops.mjs';

describe('published public-transport CORS verification', () => {
  it('accepts wildcard CORS', () => {
    const response = new Response('', { headers: { 'Access-Control-Allow-Origin': '*' } });
    expect(() => assertCors(response, 'https://viahelvetica.ch', 'catalog')).not.toThrow();
  });

  it('requires Vary: Origin for origin-specific CORS', () => {
    const unsafe = new Response('', { headers: { 'Access-Control-Allow-Origin': 'https://viahelvetica.ch' } });
    expect(() => assertCors(unsafe, 'https://viahelvetica.ch', 'catalog')).toThrow(/Vary: Origin/);
    const safe = new Response('', { headers: {
      'Access-Control-Allow-Origin': 'https://viahelvetica.ch',
      Vary: 'Origin',
    } });
    expect(() => assertCors(safe, 'https://viahelvetica.ch', 'catalog')).not.toThrow();
  });
});
