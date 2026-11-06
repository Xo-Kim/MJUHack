import { evaluateVisit, newspaperLanguage, positionAtDistance, VISIT_FIX_MAX_AGE_MS } from './visit';

const place = { latitude: 37.57, longitude: 126.98 };
const now = Date.parse('2026-11-06T00:00:00Z');
const fix = metres => ({ ...positionAtDistance(place, metres), accuracyM: 20, observedAt: new Date(now).toISOString() });
const check = (position, extra = {}) => evaluateVisit({ place, position, source: 'gps', now, ...extra });

test.each([[999.9, true], [1000, true], [1000.1, false]])('visit distance %sm has allowed=%s', (metres, allowed) => {
  expect(check(fix(metres)).allowed).toBe(allowed);
});
test('accuracy, age, denied, missing coordinates and demo each have their own denial', () => {
  expect(check({ ...fix(0), accuracyM: 1000.01 }).reason).toBe('accuracy');
  expect(check({ ...fix(0), observedAt: new Date(now - VISIT_FIX_MAX_AGE_MS - 1).toISOString() }).reason).toBe('stale');
  expect(check(fix(0), { issue: 'denied' }).reason).toBe('denied');
  expect(check(null).reason).toBe('missing');
  expect(check(fix(0), { place: { latitude: null, longitude: null } }).reason).toBe('coordinates');
  expect(check(fix(0), { source: 'demo' }).reason).toBe('demo');
  expect(check({ ...fix(0), observedAt: 'bad date' }).reason).toBe('stale');
  expect(check({ ...fix(0), accuracyM: null }).reason).toBe('accuracy');
});
test('simulation only works with an explicit development preview option', () => {
  expect(check(fix(0), { source: 'simulation' }).allowed).toBe(false);
  expect(check(fix(0), { source: 'simulation', allowSimulation: true }).allowed).toBe(true);
});
test.each([['ko', 'ko'], ['ko-KR', 'ko'], ['en-US', 'en'], ['ja', 'en'], ['zh-CN', 'en']])('primary locale %s selects %s', (language, result) => {
  expect(newspaperLanguage({ language, languages: ['en', 'ko'] })).toBe(result);
});
test('only a missing primary language falls back to the first language', () => {
  expect(newspaperLanguage({ language: 'en', languages: ['ko'] })).toBe('en');
  expect(newspaperLanguage({ languages: ['ja', 'ko'] })).toBe('en');
  expect(newspaperLanguage({ languages: ['ko-KR'] })).toBe('ko');
});

test('the MCC fallback opens places within 1km by distance alone, whatever the issue or age', () => {
  const fallback = { ...positionAtDistance(place, 1000), accuracyM: null, observedAt: new Date(now - VISIT_FIX_MAX_AGE_MS * 10).toISOString() };
  expect(check(fallback, { source: 'fallback', issue: 'denied' }).allowed).toBe(true);
  expect(check({ ...fallback, ...positionAtDistance(place, 1000.1) }, { source: 'fallback' }).reason).toBe('outside');
  expect(check(fallback, { source: 'demo' }).reason).toBe('demo');
});
