import { act, fireEvent, render, screen } from '@testing-library/react';
import CloudArrival from './CloudArrival';
import CloudCanvas from './CloudCanvas';
import { requestPosition, watchPosition } from './location';
const originalEnvironment=process.env.NODE_ENV;
jest.mock('./CloudCanvas',()=>jest.fn());
jest.mock('./HeroCanvas',()=>{
  const React=require('react');
  return function Model({onReady}){React.useEffect(onReady,[onReady]);return <div role="img" aria-label="근두운을 탄 홍길동 3D"/>;};
});
jest.mock('./LandingMap',()=>{
  const React=require('react');
  return function Map({position,onReady,phase,onSelect}){React.useEffect(()=>{if(position||phase==='preparing')onReady();},[position,onReady,phase]);return <div data-testid="persistent-map"><button onClick={()=>onSelect('JNG09')}>테스트 지도 핀</button></div>;};
});
jest.mock('./location',()=>({...jest.requireActual('./location'),requestPosition:jest.fn(),watchPosition:jest.fn()}));
beforeEach(()=>{process.env.NODE_ENV='development';jest.useFakeTimers();window.matchMedia=()=>({matches:false,addEventListener:jest.fn(),removeEventListener:jest.fn()});CloudCanvas.mockImplementation(({opening})=><div data-testid="clearing-clouds" data-opening={opening}/>);watchPosition.mockReturnValue(jest.fn());});
afterEach(()=>{process.env.NODE_ENV=originalEnvironment;jest.useRealTimers();jest.clearAllMocks();});
async function reveal(){fireEvent.wheel(screen.getByRole('region',{name:'seoul times 서울 지도'}),{deltaY:100});await act(async()=>{});act(()=>jest.advanceTimersByTime(2800));}
function clearClouds(){act(()=>CloudCanvas.mock.calls.at(-1)[0].onCleared());}
function land(){for(const duration of [1100,600,500])act(()=>jest.advanceTimersByTime(duration));clearClouds();for(const duration of [400,700,1800])act(()=>jest.advanceTimersByTime(duration));}
test('scroll replaces BEGIN and keeps a one-second look before the hero leaves first and the viewer follows',async()=>{
  const located=jest.fn();const {container}=render(<CloudArrival onLocated={located}/>);
  const mapNode=screen.getByTestId('persistent-map');
  expect(screen.queryByRole('button',{name:'BEGIN'})).not.toBeInTheDocument();
  expect(screen.getByText('아래로 스크롤')).toBeInTheDocument();
  fireEvent.wheel(container.firstChild,{deltaY:-100});expect(container.firstChild).toHaveClass('phase-clouds');
  await reveal();expect(container.firstChild).toHaveClass('phase-flying');
  expect(screen.queryByText('아래로 스크롤')).not.toBeInTheDocument();
  expect(requestPosition).not.toHaveBeenCalled();expect(located).toHaveBeenCalledWith(expect.objectContaining({latitude:37.57}),true);
  expect(screen.queryByRole('button',{name:'가상 위치로 내려가기'})).not.toBeInTheDocument();
  act(()=>jest.advanceTimersByTime(900));expect(container.firstChild).toHaveClass('phase-flying');
  act(()=>jest.advanceTimersByTime(160));expect(container.firstChild).toHaveClass('phase-departing');
  act(()=>jest.advanceTimersByTime(550));expect(container.firstChild).toHaveClass('phase-following');
  act(()=>jest.advanceTimersByTime(450));expect(container.firstChild).toHaveClass('phase-clearing');
  clearClouds();expect(container.firstChild).toHaveClass('phase-falling');
  for(const duration of [400,700,1800])act(()=>jest.advanceTimersByTime(duration));
  expect(container.firstChild).toHaveClass('phase-landed');expect(screen.getByTestId('persistent-map')).toBe(mapNode);
});
test('a denied real GPS never becomes a visit or demo fix and the scroll sequence still permits map browsing',async()=>{
  process.env.NODE_ENV='production';requestPosition.mockRejectedValue(Object.assign(new Error('위치 권한이 꺼져 있습니다.'),{code:1}));
  const located=jest.fn();const {container}=render(<CloudArrival onLocated={located}/>);
  await reveal();expect(screen.getByRole('alert')).toHaveTextContent('위치 권한');expect(located).not.toHaveBeenCalled();
  land();expect(container.firstChild).toHaveClass('phase-landed');expect(located).not.toHaveBeenCalled();
});
test('when GPS fails the map falls back to MCC, stays unverified, and a later real fix replaces it',async()=>{
  process.env.NODE_ENV='production';requestPosition.mockRejectedValue(Object.assign(new Error('GPS를 가져오지 못했습니다.'),{code:2}));
  const located=jest.fn();const {container}=render(<CloudArrival onLocated={located}/>);await reveal();land();
  expect(container.firstChild).toHaveClass('phase-landed');expect(screen.getByText(/명지대 MCC를 기준으로/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'홍길동 위치로 돌아가기'})).toBeEnabled();expect(located).not.toHaveBeenCalled();
  const fix={latitude:37.571,longitude:126.98,accuracyM:150,observedAt:new Date(Date.now()+1000).toISOString()};
  act(()=>watchPosition.mock.calls[0][0](fix));
  expect(located).toHaveBeenLastCalledWith(fix,false);expect(screen.queryByText(/명지대 MCC를 기준으로/)).not.toBeInTheDocument();
});
test('a position outside the service area falls back to MCC instead of leaving the character off screen',async()=>{
  process.env.NODE_ENV='production';requestPosition.mockResolvedValue({latitude:37.4979,longitude:127.0276,accuracyM:10,observedAt:new Date().toISOString()});
  const located=jest.fn();render(<CloudArrival onLocated={located}/>);await reveal();land();
  expect(screen.getByText(/서비스 지역 밖이라 명지대 MCC/)).toBeInTheDocument();expect(located).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'홍길동 위치로 돌아가기'})).toBeEnabled();
});
test('keyboard entry and pause preserve the reveal timeline',()=>{
  const {container}=render(<CloudArrival/>);
  fireEvent.keyDown(window,{key:'ArrowDown'});fireEvent.click(screen.getByRole('button',{name:'모션 멈추기'}));
  act(()=>jest.advanceTimersByTime(8000));expect(container.firstChild).toHaveClass('phase-revealing');
  fireEvent.click(screen.getByRole('button',{name:'모션 재생'}));act(()=>jest.advanceTimersByTime(2800));expect(container.firstChild).toHaveClass('phase-flying');
});
test('reduced motion retains the one-second look but skips the flight transitions',async()=>{
  window.matchMedia=()=>({matches:true,addEventListener:jest.fn(),removeEventListener:jest.fn()});
  const {container}=render(<CloudArrival/>);
  fireEvent.keyDown(window,{key:'PageDown'});await act(async()=>{});act(()=>jest.advanceTimersByTime(32));
  expect(container.firstChild).toHaveClass('phase-flying','motion-reduced');
  act(()=>jest.advanceTimersByTime(900));expect(container.firstChild).toHaveClass('phase-flying');
  act(()=>jest.advanceTimersByTime(160));for(let i=0;i<3;i++)act(()=>jest.advanceTimersByTime(32));
  clearClouds();for(let i=0;i<4;i++)act(()=>jest.advanceTimersByTime(32));
  expect(container.firstChild).toHaveClass('phase-landed');
});
test('the map drop waits for fully cleared clouds and landing emits two waves only once',async()=>{
  const {container}=render(<CloudArrival/>);await reveal();
  for(const duration of [1100,600,500])act(()=>jest.advanceTimersByTime(duration));
  expect(container.firstChild).toHaveClass('phase-clearing');expect(screen.getByTestId('clearing-clouds')).toHaveAttribute('data-opening','true');
  act(()=>jest.advanceTimersByTime(5000));expect(container.firstChild).toHaveClass('phase-clearing');
  expect(container.querySelectorAll('.impact-ring')).toHaveLength(0);
  clearClouds();expect(container.firstChild).toHaveClass('phase-falling');expect(screen.queryByTestId('clearing-clouds')).not.toBeInTheDocument();
  act(()=>jest.advanceTimersByTime(320));expect(container.firstChild).toHaveClass('phase-impact');
  const waves=[...container.querySelectorAll('.impact-ring')];expect(waves).toHaveLength(2);
  act(()=>jest.advanceTimersByTime(650));expect(container.firstChild).toHaveClass('phase-pullback');
  expect([...container.querySelectorAll('.impact-ring')]).toEqual(waves);
  act(()=>jest.advanceTimersByTime(1800));expect(container.firstChild).toHaveClass('phase-landed');
  expect(container.querySelectorAll('.impact-ring')).toHaveLength(0);
  expect(container.querySelectorAll('.avatar-ground-shadow')).toHaveLength(1);
});
test('pin selection shows a floating card without opening the place list or teleporting the avatar',async()=>{
  const located=jest.fn();const {container}=render(<CloudArrival onLocated={located}/>);await reveal();land();
  fireEvent.click(screen.getByRole('button',{name:'테스트 지도 핀'}));
  expect(screen.getByRole('region',{name:'Selected place'})).toBeInTheDocument();
  expect(screen.queryByRole('complementary',{name:'서울 장소 목록'})).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(located).toHaveBeenCalledTimes(1);expect(container.firstChild).toHaveAttribute('data-location-updates','1');
});
test('fresh real GPS updates use the same map and stopping clears tracking',async()=>{
  process.env.NODE_ENV='production';const first={latitude:37.57,longitude:126.98,accuracyM:10,observedAt:new Date().toISOString()};requestPosition.mockResolvedValue(first);
  const stopped=jest.fn();watchPosition.mockReturnValue(stopped);const located=jest.fn();
  const {container,rerender}=render(<CloudArrival onLocated={located}/>);const mapNode=screen.getByTestId('persistent-map');await reveal();land();
  const next={...first,latitude:37.571,observedAt:new Date(Date.now()+1000).toISOString()};act(()=>watchPosition.mock.calls[0][0](next));
  expect(container.firstChild).toHaveClass('phase-landed');expect(screen.getByTestId('persistent-map')).toBe(mapNode);expect(located).toHaveBeenLastCalledWith(next,false);
  rerender(<CloudArrival onLocated={located} active={false}/>);expect(stopped).toHaveBeenCalledTimes(1);
  rerender(<CloudArrival onLocated={located} active/>);expect(watchPosition).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button',{name:'장소 목록 열기'}));fireEvent.click(screen.getByRole('button',{name:'장소 검색 펼치기'}));fireEvent.click(screen.getByText('위치 설정'));fireEvent.click(screen.getByRole('button',{name:'추적 멈추기'}));expect(stopped).toHaveBeenCalledTimes(2);
});
