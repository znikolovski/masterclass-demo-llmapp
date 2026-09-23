// test/actions/build-route-briefing.test.js
const handler = require('../../actions/build-route-briefing/index.js');

describe('build_route_briefing handler', () => {
  test('happy path — returns a flat single-object briefing for a documented route', async () => {
    const res = await handler({ adventure_id: 'patagonia-trek' });

    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text.length).toBeGreaterThan(0);

    // Detail concept: structuredContent is a plain object, NOT an array or a wrapper key.
    expect(res.structuredContent).toBeInstanceOf(Object);
    expect(Array.isArray(res.structuredContent)).toBe(false);

    const b = res.structuredContent;
    expect(b.adventure_id).toBe('patagonia-trek');
    expect(b.title).toBe('W Circuit: 9 Days, 115 km');
    expect(b.region).toContain('Torres del Paine');
    expect(b.activity).toBe('Hiking');
    expect(Array.isArray(b.daily_stages)).toBe(true);
    expect(b.daily_stages.length).toBeGreaterThan(0);
    expect(Array.isArray(b.hazards)).toBe(true);
    expect(Array.isArray(b.essential_gear)).toBe(true);
    expect(Array.isArray(b.verification_notes)).toBe(true);
    expect(Array.isArray(b.missing_information)).toBe(true);
  });

  test('content is a concise summary, not an itemized stage list', async () => {
    const res = await handler({ adventure_id: 'patagonia-trek' });
    const text = res.content[0].text;
    // The widget renders the stages; the summary should not enumerate every stage line.
    expect(text).not.toContain('Laguna Amarga → Refugio Las Torres');
  });

  test('resolves by title and is case-insensitive', async () => {
    const res = await handler({ adventure_id: 'w circuit' });
    expect(res.structuredContent.adventure_id).toBe('patagonia-trek');
  });

  test('missing required adventure_id — returns guidance and empty object', async () => {
    const res = await handler({});
    expect(res.content[0].text.toLowerCase()).toContain('which');
    expect(res.structuredContent).toEqual({});
  });

  test('empty-string adventure_id is treated as missing', async () => {
    const res = await handler({ adventure_id: '   ' });
    expect(res.structuredContent).toEqual({});
  });

  test('unknown route — returns empty object, same flat shape', async () => {
    const res = await handler({ adventure_id: 'no-such-route-xyz' });
    expect(res.structuredContent).toEqual({});
    expect(Array.isArray(res.structuredContent)).toBe(false);
  });

  test('documented-but-narrative report reports the gap in missing_information', async () => {
    const res = await handler({ adventure_id: 'mountain-photography' });
    const b = res.structuredContent;
    expect(b.adventure_id).toBe('mountain-photography');
    expect(b.daily_stages).toEqual([]);
    expect(b.missing_information.length).toBeGreaterThan(0);
  });

  test('optional args are accepted and reflected in the summary context', async () => {
    const res = await handler({
      adventure_id: 'patagonia-trek',
      travel_window: 'March',
      party_experience: 'moderately fit',
      briefing_depth: 'detailed',
    });
    expect(res.content[0].text).toContain('March');
    expect(res.structuredContent.adventure_id).toBe('patagonia-trek');
  });
});
