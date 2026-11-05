import { requestPosition } from './location';
function mockPosition(accuracy) {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: jest.fn(success => success({ coords: { latitude: 37.57, longitude: 126.98, accuracy }, timestamp: Date.now() })) } });
}
test('valid coarse fixes are collected without claiming visit eligibility', async () => {
  mockPosition(20); expect((await requestPosition()).accuracyM).toBe(20);
  mockPosition(200); expect((await requestPosition()).accuracyM).toBe(200);
  mockPosition(NaN); await expect(requestPosition()).rejects.toThrow();
});
test('denial rejects instead of inventing a successful coordinate', async () => {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_, fail) => fail({ code: 1 }) } });
  await expect(requestPosition()).rejects.toThrow('위치 권한');
});

test('live tracking collects newer coarse fixes and clears the watcher; late events cannot change location', () => {
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
  success(fix(1002, 200)); expect(error).not.toHaveBeenCalled(); expect(located).toHaveBeenCalledTimes(2);
  success(fix(1001, 10)); expect(located).toHaveBeenCalledTimes(2);
  success(fix(1003, 10)); expect(located).toHaveBeenCalledTimes(3);
  stop(); expect(clearWatch).toHaveBeenCalledWith(42);
  success(fix(1004, 10)); failure({ code: 1 });
  expect(located).toHaveBeenCalledTimes(3); expect(error).not.toHaveBeenCalled();
});

test('non-HTTPS is reported explicitly before requesting device location',async()=>{
  const previous=Object.getOwnPropertyDescriptor(window,'isSecureContext');
  Object.defineProperty(window,'isSecureContext',{configurable:true,value:false});mockPosition(10);
  try { await expect(requestPosition()).rejects.toMatchObject({code:'insecure'});expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled(); }
  finally { if(previous)Object.defineProperty(window,'isSecureContext',previous);else delete window.isSecureContext; }
});
