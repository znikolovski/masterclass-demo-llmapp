const handler = require('../../actions/prepare-field-submission/index.js');

const validArgs = {
  submission_type: 'route story',
  draft_text: 'I just finished the W Circuit in 9 days across 115 km. Permit strategy, daily stages, and refugio conditions. The river crossing on day 4 needs care for safety.',
  destination: 'Torres del Paine',
  activity: 'Hiking',
  condition_date: 'February 2026',
  contributor_bio: 'Long-distance hiker documenting multi-day mountain routes across the Americas.',
  supporting_sources: ['12 dated trail photos with GPS metadata', 'Permit confirmation numbers'],
};

describe('prepare_field_submission handler', () => {
  test('returns content block shape on happy path', async () => {
    const out = await handler(validArgs);
    expect(out).toHaveProperty('content');
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
  });

  test('"share my completed-route story" prepares a submission package', async () => {
    const out = await handler(validArgs);
    expect(out.content[0].text.length).toBeGreaterThan(0);
    expect(out.structuredContent.proposed_title).toEqual(expect.any(String));
    expect(out.structuredContent.submission_type).toBe('Completed-route story');
    expect(Array.isArray(out.structuredContent.draft_sections)).toBe(true);
    expect(out.structuredContent.draft_sections.length).toBeGreaterThan(0);
  });

  test('structuredContent is a plain object, not a bare array', async () => {
    const out = await handler(validArgs);
    expect(typeof out.structuredContent).toBe('object');
    expect(Array.isArray(out.structuredContent)).toBe(false);
  });

  test('content narrative notes WKND editorial control', async () => {
    const out = await handler(validArgs);
    expect(out.content[0].text).toMatch(/editorial control/i);
  });

  test('returns error message when required args are missing', async () => {
    const out = await handler({});
    expect(out.content[0].text).toMatch(/submission_type|draft_text|contributor_bio|provide/i);
  });

  test('missing required args still returns the full structuredContent key shape', async () => {
    const out = await handler({});
    const keys = Object.keys(out.structuredContent).sort();
    const happy = await handler(validArgs);
    expect(keys).toEqual(Object.keys(happy.structuredContent).sort());
  });

  test('supporting_sources populate the evidence checklist', async () => {
    const out = await handler(validArgs);
    expect(out.structuredContent.evidence_checklist).toEqual(
      expect.arrayContaining(['Permit confirmation numbers']),
    );
  });

  test('flags a safety claim for editorial verification', async () => {
    const out = await handler(validArgs);
    expect(out.structuredContent.editorial_flags.some((f) => /safety/i.test(f))).toBe(true);
  });

  test('edge case: missing condition_date and sources mark the package as needing revision', async () => {
    const out = await handler({
      submission_type: 'field dispatch',
      draft_text: 'Quick trail note from the Sonoran.',
      contributor_bio: 'Desert trekker.',
    });
    expect(out.structuredContent.readiness_status).toMatch(/needs revision/i);
    expect(out.structuredContent.missing_information.length).toBeGreaterThan(0);
  });

  test('a complete package with all evidence reads as ready to send', async () => {
    const out = await handler({
      submission_type: 'gear reflection',
      draft_text: 'Notes on an ultralight kit that held up over four days.',
      destination: 'General',
      activity: 'Backpacking',
      condition_date: 'March 2026',
      contributor_bio: 'Ultralight backpacker.',
      supporting_sources: ['Base weight spreadsheet', 'Photos of the packed kit'],
    });
    expect(out.structuredContent.readiness_status).toMatch(/ready to send/i);
    expect(out.structuredContent.missing_information).toEqual([]);
  });
});
