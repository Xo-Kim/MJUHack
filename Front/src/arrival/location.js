const options = { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 };
function positionValue({ coords, timestamp }) {
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude) || Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180 || !Number.isFinite(coords.accuracy) || coords.accuracy < 0 || !Number.isFinite(timestamp)) {
    const error = new Error('유효한 위치 값을 받지 못했습니다. 위치를 다시 확인해 주세요.');
    error.code = 'accuracy';
    throw error;
  }
  return { latitude: coords.latitude, longitude: coords.longitude, accuracyM: coords.accuracy, observedAt: new Date(timestamp).toISOString(), photoGps: null };
}
function positionError(error) {
  const failure = new Error(error.code === 1 ? '위치 권한이 꺼져 있거나 사이트에서 차단됐습니다. 기기·브라우저의 위치 권한을 확인해 주세요.' : error.code === 3 ? '위치 요청 시간이 초과됐습니다. 위치를 계속 확인 중이며 다시 시도할 수 있습니다.' : '현재 위치를 얻지 못했습니다. 기기의 위치 서비스를 확인해 주세요.');
  failure.code = error.code;
  return failure;
}
function supportError() {
  if (window.isSecureContext === false) return Object.assign(new Error('위치 수집에는 HTTPS 접속이 필요합니다.'), { code: 'insecure' });
  if (!navigator.geolocation) return Object.assign(new Error('이 브라우저는 위치 수집을 지원하지 않습니다.'), { code: 'unsupported' });
  return null;
}
export function requestPosition() {
  return new Promise((resolve, reject) => {
    const unsupported = supportError();
    if (unsupported) return reject(unsupported);
    navigator.geolocation.getCurrentPosition(raw => { try { resolve(positionValue(raw)); } catch (error) { reject(error); } }, error => reject(positionError(error)), options);
  });
}
export function watchPosition(onPosition, onError, afterTimestamp = 0) {
  const unsupported = supportError();
  if (unsupported || !navigator.geolocation?.watchPosition) { onError(unsupported || Object.assign(new Error('이 브라우저는 실시간 위치를 지원하지 않습니다.'), { code: 'unsupported' })); return () => {}; }
  let active = true, lastTimestamp = afterTimestamp;
  const watchId = navigator.geolocation.watchPosition(raw => {
    if (!active || raw.timestamp <= lastTimestamp) return;
    try { const next = positionValue(raw); lastTimestamp = raw.timestamp; onPosition(next); }
    catch (error) { onError(error); }
  }, error => { if (active) onError(positionError(error)); }, options);
  return () => { active = false; navigator.geolocation.clearWatch(watchId); };
}
export function demoPosition() {
  return { latitude: 37.57, longitude: 126.98, accuracyM: 10, observedAt: new Date().toISOString(), photoGps: null };
}
