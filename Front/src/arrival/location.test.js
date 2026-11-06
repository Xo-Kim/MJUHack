import { requestPosition } from './location';
function mockPosition(accuracy) {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: jest.fn(success => success({ coords: { latitude: 37.57, longitude: 126.98, accuracy }, timestamp: Date.now() })) } });
}
test('a coarse fix is still usable for the map; only invalid values are rejected', async () => {
  mockPosition(20); expect((await requestPosition()).accuracyM).toBe(20);
  mockPosition(500); expect((await requestPosition()).accuracyM).toBe(500);
  mockPosition(NaN); await expect(requestPosition()).rejects.toThrow('위치 값');
});
test('the fallback is the Myongji MCC point and carries no accuracy, so it can never pass a visit check', () => {
  const { fallbackPosition } = require('./location');
  expect(fallbackPosition()).toEqual(expect.objectContaining({ latitude: 37.58, longitude: 126.9238, accuracyM: null }));
});
test('denial rejects instead of inventing a successful coordinate', async () => {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_, fail) => fail({ code: 1 }) } });
  await expect(requestPosition()).rejects.toThrow('위치 권한');
});

test('live tracking accepts only newer valid fixes and clears the watcher; late events cannot change location', () => {
  const { watchPosition } = require('./location');
  let success, failure;
  const clearWatch = jest.fn();
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    watchPosition: jest.fn((next, error) => { success = next; failure = error; return 42; }), clearWatch
  } });
  const located = jest.fn(), error = jest.fn();
  const stop = watchPosition(located, error, 1000);
  const fix = (timestamp, accuracy) => ({ timestamp, coords: { latitude: 37.57, longitude: 126.98, accuracy } });
  success(fix(999, 10)); expect(located).not.toHaveBeenCalled();
  success(fix(1001, 20)); expect(located).toHaveBeenCalledTimes(1);
  success(fix(1002, NaN)); expect(error).toHaveBeenCalledTimes(1); expect(located).toHaveBeenCalledTimes(1);
  success(fix(1001, 10)); expect(located).toHaveBeenCalledTimes(1);
  success(fix(1003, 500)); expect(located).toHaveBeenCalledTimes(2);
  stop(); expect(clearWatch).toHaveBeenCalledWith(42);
  success(fix(1004, 10)); failure({ code: 1 });
  expect(located).toHaveBeenCalledTimes(2); expect(error).toHaveBeenCalledTimes(1);
});
