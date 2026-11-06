const options = { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 };
// 오차가 커도 지도 표시에는 쓴다. 신문을 여는 20m·오차 조건은 newspaper/visit.js 가 따로 검사한다.
function positionValue({ coords, timestamp }) {
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude) || Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180 || !Number.isFinite(coords.accuracy) || coords.accuracy < 0 || !Number.isFinite(timestamp)) {
    const error = new Error('위치 값이 올바르지 않습니다. 마지막 확인 위치를 유지합니다.');
    error.code = 'accuracy';
    throw error;
  }
  return { latitude: coords.latitude, longitude: coords.longitude, accuracyM: coords.accuracy, observedAt: new Date(timestamp).toISOString(), photoGps: null };
}
function positionError(error) {
  const failure = new Error(error.code === 1 ? '위치 권한이 꺼져 있습니다. 브라우저에서 위치를 허용한 뒤 다시 시도해 주세요.' : 'GPS를 가져오지 못했습니다. 마지막 확인 위치를 유지합니다.');
  failure.code = error.code;
  return failure;
}
export function requestPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('이 브라우저는 GPS를 지원하지 않습니다. 장소 목록은 이용할 수 있습니다.'));
    navigator.geolocation.getCurrentPosition(raw => { try { resolve(positionValue(raw)); } catch (error) { reject(error); } }, error => reject(positionError(error)), options);
  });
}
export function watchPosition(onPosition, onError, afterTimestamp = 0) {
  if (!navigator.geolocation?.watchPosition) { onError(new Error('이 브라우저는 실시간 GPS를 지원하지 않습니다.')); return () => {}; }
  let active = true, lastTimestamp = afterTimestamp;
  const watchId = navigator.geolocation.watchPosition(raw => {
    if (!active || raw.timestamp <= lastTimestamp) return;
    try { const next = positionValue(raw); lastTimestamp = raw.timestamp; onPosition(next); }
    catch (error) { onError(error); }
  }, error => { if (active) onError(positionError(error)); }, options);
  return () => { active = false; navigator.geolocation.clearWatch(watchId); };
}
// 위치를 못 받거나 서비스 지역 밖일 때 지도 기준점으로 쓰는 명지대학교 MCC 앞. 방문 인증에는 쓰지 않는다.
export function fallbackPosition() {
  return { latitude: 37.58, longitude: 126.9238, accuracyM: null, observedAt: new Date().toISOString(), photoGps: null };
}
export function demoPosition() {
  return { latitude: 37.57, longitude: 126.98, accuracyM: 10, observedAt: new Date().toISOString(), photoGps: null };
}
