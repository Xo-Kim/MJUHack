import { hasCoordinates } from '../data/places';

export const VISIT_RADIUS_M = 1000;
export const VISIT_FIX_MAX_AGE_MS = 30000;
const EARTH_RADIUS_M = 6371000;
const radians = value => value * Math.PI / 180;

export function newspaperLanguage(browser = navigator) {
  return /^ko(?:-|$)/i.test(browser.language || browser.languages?.[0] || '') ? 'ko' : 'en';
}

export function distanceMetres(a, b) {
  const latitude = radians(b.latitude - a.latitude), longitude = radians(b.longitude - a.longitude);
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitude / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function evaluateVisit({ place, position, source, issue, now = Date.now(), allowSimulation = false }) {
  const deny = reason => ({ allowed: false, reason });
  if (!place || !hasCoordinates(place)) return deny('coordinates');
  // 위치를 못 받았을 때의 MCC 기준점: 오차·시간을 따질 값이 없으므로 거리만 본다.
  if (source === 'fallback' && position && hasCoordinates(position)) {
    const fromFallback = distanceMetres(position, place);
    return { allowed: fromFallback <= VISIT_RADIUS_M + 0.000001, reason: fromFallback <= VISIT_RADIUS_M + 0.000001 ? null : 'outside', distanceM: fromFallback };
  }
  if (issue === 'denied') return deny('denied');
  if (issue === 'accuracy') return deny('accuracy');
  if (issue === 'missing') return deny('missing');
  if (!position || !hasCoordinates(position)) return deny('missing');
  if (source !== 'gps' && !(source === 'simulation' && allowSimulation)) return deny('demo');
  if (!Number.isFinite(position.accuracyM) || position.accuracyM < 0 || position.accuracyM > VISIT_RADIUS_M) return deny('accuracy');
  const age = now - Date.parse(position.observedAt);
  if (!Number.isFinite(age) || age < -1000 || age > VISIT_FIX_MAX_AGE_MS) return deny('stale');
  const distanceM = distanceMetres(position, place);
  // Floating-point latitude conversion can add sub-micrometre error at exactly the radius.
  return { allowed: distanceM <= VISIT_RADIUS_M + 0.000001, reason: distanceM <= VISIT_RADIUS_M + 0.000001 ? null : 'outside', distanceM };
}

export function positionAtDistance(place, metres) {
  return { latitude: place.latitude + metres / EARTH_RADIUS_M * 180 / Math.PI, longitude: place.longitude };
}

export const visitMessages = {
  ko: {
    outside: '이 장소의 신문은 1km 안에 들어오면 볼 수 있어요.',
    denied: '위치 권한을 허용하면 이 장소의 신문을 확인할 수 있어요.',
    accuracy: '위치 오차가 1km 이하가 되면 다시 시도해 주세요.',
    stale: '위치 정보가 오래됐어요. 현재 위치를 다시 확인해 주세요.',
    missing: '현재 위치를 확인한 뒤 신문을 열 수 있어요.',
    coordinates: '이 장소는 방문 위치를 확인 중이에요.',
    demo: '실제 GPS 위치를 확인한 뒤 신문을 열 수 있어요.',
  },
  en: {
    outside: 'You can read this newspaper when you are within 1km of this place.',
    denied: 'Allow location access to read the newspaper here.',
    accuracy: 'Please try again when location accuracy is within 1km.',
    stale: 'Your location is out of date. Please check your current location again.',
    missing: 'Check your current location before opening this newspaper.',
    coordinates: 'The visit location for this place is still being verified.',
    demo: 'Use your real GPS location to open this newspaper.',
  },
};
