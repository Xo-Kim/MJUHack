import { act, fireEvent, render, screen } from '@testing-library/react';
import useVisitReader from './useVisitReader';
import VisitOverlays, { VisitToast } from './VisitOverlays';
import { places } from '../data/places';
import { positionAtDistance, VISIT_FIX_MAX_AGE_MS } from './visit';
jest.mock('./NewspaperSheet',()=>function Sheet({record,onClose,initialLanguage,simulation}){return <div role="dialog" aria-label="신문"><span>{record.spotId} {initialLanguage} {String(simulation)}</span><button onClick={onClose}>닫기</button></div>;});
const place=places.find(item=>item.id==='JNG09');
let locale;
const originalEnvironment=process.env.NODE_ENV;
beforeEach(()=>{jest.useFakeTimers();locale=jest.spyOn(navigator,'language','get').mockReturnValue('ko-KR');});
afterEach(()=>{process.env.NODE_ENV=originalEnvironment;locale.mockRestore();jest.useRealTimers();});
function fix(metres){return {...positionAtDistance(place,metres),accuracyM:20,observedAt:new Date().toISOString()};}
function Harness({position=fix(1000.1),demo=false,issue}){
  const reader=useVisitReader({position,demo,issue,active:true});
  return <><button onClick={()=>reader.select('JNG09')}>핀</button><button onClick={()=>reader.select('JNG09')}>목록</button><button onClick={()=>reader.simulate({placeId:'JNG09',metres:20,language:'ko',accuracyM:20,condition:'fresh'})}>명시적 시뮬레이션</button><VisitOverlays reader={reader} onTrack={()=>{}} reduced={false}/></>;
}
test('a labeled simulation can reopen its preview, while ordinary selection still uses real GPS',()=>{
  process.env.NODE_ENV='development';render(<Harness/>);
  fireEvent.click(screen.getByText('명시적 시뮬레이션'));expect(screen.getByRole('dialog')).toHaveTextContent('JNG09 ko true');
  fireEvent.click(screen.getByText('닫기'));fireEvent.click(screen.getByRole('button',{name:'신문 펼치기'}));expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByText('핀'));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
test('pin and list share the gate; outside click floats a card and repeated attempts keep one toast',()=>{
  const {container}=render(<Harness/>);fireEvent.click(screen.getByText('핀'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByRole('region',{name:'선택 장소'})).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('이 장소의 신문은 1km 안에 들어오면 볼 수 있어요.');
  act(()=>jest.advanceTimersByTime(2000));fireEvent.click(screen.getByText('목록'));
  expect(container.querySelectorAll('.visit-toast')).toHaveLength(1);
  act(()=>jest.advanceTimersByTime(2579));expect(container.querySelector('.visit-toast')).not.toHaveClass('is-leaving');
  act(()=>jest.advanceTimersByTime(2));expect(container.querySelector('.visit-toast')).toHaveClass('is-leaving');
  act(()=>jest.advanceTimersByTime(220));expect(container.querySelector('.visit-toast')).toBeNull();
});
test('within 1km opens only after explicit selection; moving out closes and entering again does not reopen',()=>{
  const {rerender}=render(<Harness position={fix(1000)}/>);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('핀'));expect(screen.getByRole('dialog')).toHaveTextContent('JNG09 ko false');
  rerender(<Harness position={fix(1000.1)}/>);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<Harness position={fix(19.9)}/>);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('목록'));expect(screen.getByRole('dialog')).toBeInTheDocument();
});
test('an open paper locks on stale GPS, denied permission and poor accuracy; a demo is never a real visit',()=>{
  const {rerender}=render(<Harness position={fix(0)}/>);fireEvent.click(screen.getByText('핀'));expect(screen.getByRole('dialog')).toBeInTheDocument();
  act(()=>jest.advanceTimersByTime(VISIT_FIX_MAX_AGE_MS+1));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<Harness position={fix(0)} issue="denied"/>);fireEvent.click(screen.getByText('핀'));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<Harness position={{...fix(0),accuracyM:1001}}/>);fireEvent.click(screen.getByText('핀'));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<Harness position={fix(0)} demo/>);fireEvent.click(screen.getByText('핀'));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
test('reduced motion toast keeps announcement and short opacity-only timing',()=>{
  const done=jest.fn();const {container}=render(<VisitToast toast={{id:1,message:'안내'}} onDone={done} reduced/>);
  expect(screen.getByRole('status')).toHaveTextContent('안내');expect(container.firstChild).toHaveClass('is-reduced');
  act(()=>jest.advanceTimersByTime(2480));expect(container.firstChild).toHaveClass('is-leaving');
  act(()=>jest.advanceTimersByTime(80));expect(done).toHaveBeenCalledTimes(1);
});

test('a locked card shows only its existing title and the source-ID introduction', () => {
  render(<Harness/>); fireEvent.click(screen.getByText('핀'));
  const card = screen.getByRole('region', { name: '선택 장소' });
  expect(card).toHaveTextContent(place.name);
  expect(card).toHaveTextContent(place.descriptionKo);
  expect(card.querySelectorAll('p')).toHaveLength(1);
  expect(card.querySelector('p')).toHaveAttribute('lang', 'ko');
  expect(card).not.toHaveTextContent('현장에서 20m');
  expect(card).not.toHaveTextContent(place.address);
  expect(screen.queryByRole('button', { name: '현재 위치 확인' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('card accessibility disclosure is separate from close and cannot unlock a newspaper', () => {
  const clear = jest.fn(), openPaper = jest.fn();
  const target = places.find(item => item.id === 'JNG12');
  const reader = { place:target, opened:false, language:'ko', gate:{allowed:false,reason:'outside'}, clear, openPaper };
  const { container } = render(<VisitOverlays reader={reader}/>);
  const badge = screen.getByRole('button', {name:'경복궁: 접근 조건 확인'});
  fireEvent.click(badge);
  expect(screen.getByRole('region', {name:'경복궁: 접근 조건 확인'})).toHaveTextContent('핀 20m 내 접근: 미검증');
  expect(clear).not.toHaveBeenCalled(); expect(openPaper).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', {name:'신문 펼치기'})).not.toBeInTheDocument();
  expect(container.querySelector('.place-card-heading')).toContainElement(screen.getByRole('heading', {name:'경복궁'}));
  expect(container.querySelector('.place-card-tools')).toContainElement(badge);
  fireEvent.click(screen.getByRole('button', {name:'장소 카드 닫기'}));
  expect(clear).toHaveBeenCalledTimes(1);
});
