import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CloudCanvas from './CloudCanvas';
import HeroCanvas from './HeroCanvas';
import LandingMap from './LandingMap';
import WorldControls from './WorldControls';
import { ARRIVAL_TIMING, NEXT_PHASE } from './heroConfig';
import { demoPosition, requestPosition, watchPosition } from './location';
import { filterPlaces } from '../data/places';
import { containsPoint } from '../data/mapArea';
import useVisitReader from '../newspaper/useVisitReader';
import NearbyChat from '../chat/NearbyChat';
import VisitOverlays from '../newspaper/VisitOverlays';
import './arrival.css';

export default function CloudArrival({ onLocated, onDemo, active = true }) {
  const [phase, setPhase] = useState('clouds'), [heroReady, setHeroReady] = useState(false);
  const [cloudsCleared, setCloudsCleared] = useState(false), [position, setPosition] = useState(null), [demo, setDemo] = useState(false);
  const [error, setError] = useState(''), [tracking, setTracking] = useState(false), [updates, setUpdates] = useState(0);
  const [locationIssue, setLocationIssue] = useState(null), [chat, setChat] = useState(null);
  const [paused, setPaused] = useState(false), [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false);
  const [filters, setFilters] = useState({ districtId: '', eraId: '', query: '' });
  const reader = useVisitReader({ position, demo, issue: locationIssue, active: active && phase === 'landed' });
  const { selectedId } = reader;
  const places = useMemo(() => filterPlaces(filters), [filters]);
  const sceneRoot = useRef(null), mounted = useRef(true), requestId = useRef(0), stageTime = useRef(0), worldAction = useRef(null);
  const scrollDistance = useRef(0), touchStart = useRef(null), startScroll = useRef(null);
  const anchorRef = useRef(null), mapControlRef = useRef(null), mapPrepared = useRef(false), phaseRef = useRef(phase), callback = useRef(onLocated), activeRef = useRef(active), lastFix = useRef(0);
  phaseRef.current = phase; callback.current = onLocated; activeRef.current = active;

  useEffect(() => {
    mounted.current = true;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = event => setReduced(event.matches), visibility = () => setHidden(document.hidden);
    const keyboard = event => {
      if (!activeRef.current) return;
      if (event.key === 'Escape') setPaused(value => !value);
      if (phaseRef.current === 'clouds' && ['ArrowDown', 'PageDown', ' '].includes(event.key) && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) { event.preventDefault(); startScroll.current?.(); }
    };
    media?.addEventListener('change', change); document.addEventListener('visibilitychange', visibility); window.addEventListener('keydown', keyboard);
    return () => { mounted.current = false; media?.removeEventListener('change', change); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('keydown', keyboard); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [active]);
  useEffect(() => {
    if (!NEXT_PHASE[phase] || paused || hidden || !active) return;
    let frame, last;
    const duration = reduced && phase !== 'flying' ? 0 : ARRIVAL_TIMING[phase];
    const tick = now => {
      if (last) stageTime.current += Math.min(now - last, 50); last = now;
      if (stageTime.current >= duration) { stageTime.current = 0; setPhase(NEXT_PHASE[phase]); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [phase, paused, reduced, hidden, active]);
  useEffect(() => { if (phase === 'landed') worldAction.current?.focus({ preventScroll: true }); }, [phase]);
  useEffect(() => {
    if (phase === 'preparing' && mapPrepared.current) { stageTime.current = 0; setPhase('clearing'); }
  }, [phase]);
  useEffect(() => {
    if (phase === 'clearing' && cloudsCleared && !paused && !hidden && active) { stageTime.current = 0; setPhase('falling'); }
  }, [phase, cloudsCleared, paused, hidden, active]);
  useEffect(() => {
    if (!tracking || phase !== 'landed' || !active || hidden) return;
    return watchPosition(next => {
      if (Date.parse(next.observedAt) <= lastFix.current) return;
      lastFix.current = Date.parse(next.observedAt);
      setPosition(next); setDemo(false); setUpdates(value => value + 1); setError(''); setLocationIssue(null); callback.current?.(next, false);
    }, failure => { setError(failure.message); setLocationIssue(failure.code === 1 ? 'denied' : failure.code === 'accuracy' ? 'accuracy' : 'missing'); if ([1, 'insecure', 'unsupported'].includes(failure.code)) setTracking(false); }, lastFix.current);
  }, [tracking, phase, active, hidden]);

  const mapReady = useCallback(() => {
    mapPrepared.current = true;
    if (phaseRef.current === 'preparing') { stageTime.current = 0; setCloudsCleared(false); setPhase('clearing'); }
  }, []);
  const cloudClear = useCallback(() => setCloudsCleared(true), []);
  const modelReady = useCallback(() => setHeroReady(true), []);
  const cameraUpdate = useCallback(view => {
    if (!sceneRoot.current) return;
    sceneRoot.current.style.setProperty('--landing-scale', String(1 / view.distance));
    sceneRoot.current.style.setProperty('--landing-tilt', `${view.tilt}deg`);
    sceneRoot.current.style.setProperty('--avatar-x', view.anchor ? `${view.anchor.x}px` : '50%');
    sceneRoot.current.style.setProperty('--avatar-y', view.anchor ? `${view.anchor.y}px` : '50%');
  }, []);
  async function locate(real = true, automatic = false) {
    const id = ++requestId.current, alreadyLanded = phase === 'landed';
    setError(''); if (!alreadyLanded && !automatic) setPhase('locating');
    try {
      const next = real ? await requestPosition() : demoPosition();
      if (!mounted.current || !activeRef.current || id !== requestId.current) return;
      lastFix.current = Date.parse(next.observedAt);
      setPosition(next); setDemo(!real); setTracking(real); setLocationIssue(null); setUpdates(value => value + 1); callback.current?.(next, !real);
      mapControlRef.current?.center(next);
      if (!alreadyLanded && !automatic) {
        stageTime.current = 0; setCloudsCleared(false);
        setPhase(mapPrepared.current ? 'clearing' : 'preparing');
      }
    } catch (failure) { if (mounted.current && id === requestId.current) { setError(failure.message); setLocationIssue(failure.code === 1 ? 'denied' : failure.code === 'accuracy' ? 'accuracy' : 'missing'); if ([1, 'insecure', 'unsupported'].includes(failure.code)) setTracking(false); if (real && ![1, 'insecure', 'unsupported'].includes(failure.code)) setTracking(true); if (!alreadyLanded && !automatic) setPhase('flying'); } }
  }
  function revealFromScroll() {
    if (!active || !heroReady || paused || phaseRef.current !== 'clouds') return;
    phaseRef.current = 'revealing'; stageTime.current = 0; setPhase('revealing');
    locate(true, true);
  }
  startScroll.current = revealFromScroll;
  function moveDemo(east, north) {
    if (!demo || !position) return;
    const next = { ...position, latitude: position.latitude + north / 111320, longitude: position.longitude + east / (111320 * Math.cos(position.latitude * Math.PI / 180)), observedAt: new Date().toISOString() };
    setPosition(next); setUpdates(value => value + 1); callback.current?.(next, true);
  }
  function openChat() { setChat({ place: reader.place }); reader.clear(); }
  function restart() { ++requestId.current; setTracking(false); setError(''); setCloudsCleared(false); reader.clear(); scrollDistance.current = 0; stageTime.current = 0; setPhase('clouds'); }
  const landing = ['clearing', 'falling', 'impact', 'pullback', 'landed'].includes(phase), isPaused = paused || hidden || !active;
  return <section ref={sceneRoot} data-location-updates={updates} className={`arrival phase-${phase} ${cloudsCleared ? 'clouds-cleared' : ''} ${isPaused ? 'motion-paused' : ''} ${reduced ? 'motion-reduced' : ''}`} aria-label="seoul times 서울 지도" aria-busy={!heroReady || ['locating', 'preparing'].includes(phase)}
    onWheel={event => { if (phase === 'clouds') { scrollDistance.current += Math.max(0, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? sceneRoot.current.clientHeight : 1)); if (scrollDistance.current >= 36) revealFromScroll(); } }}
    onPointerDown={event => { if (phase === 'clouds' && event.pointerType !== 'mouse') touchStart.current = event.clientY; }}
    onPointerMove={event => { if (touchStart.current !== null && touchStart.current - event.clientY > 36) { touchStart.current = null; revealFromScroll(); } }}
    onPointerUp={() => { touchStart.current = null; }} onPointerCancel={() => { touchStart.current = null; }}>
    <LandingMap position={position} demo={demo} phase={phase} places={places} selectedId={selectedId} onSelect={reader.select} anchorRef={anchorRef} mapControlRef={mapControlRef} onReady={mapReady}/><div className="arrival-ground-shade"/>
    {position && (demo || (position.accuracyM <= 20 && containsPoint(position))) && <div className="arrival-anchor"><div className="avatar-ground-shadow"/>{['impact', 'pullback'].includes(phase) && <div className="impact-waves"><div className="impact-ring impact-one"/><div className="impact-ring impact-two"/></div>}</div>}
    {!cloudsCleared && <CloudCanvas opening={landing} paused={isPaused} reduced={reduced} showcase={landing ? 0 : phase === 'clouds' ? .72 : 1} onCleared={cloudClear}/>}
    <HeroCanvas phase={phase} paused={isPaused} reduced={reduced} onReady={modelReady} onCamera={cameraUpdate} anchorRef={anchorRef} hasPosition={!!position && (demo || (position.accuracyM <= 20 && containsPoint(position)))}/>
    <h1 className="arrival-sr-only">seoul times</h1>
    <button className="arrival-motion-control" onClick={() => setPaused(value => !value)} aria-pressed={paused} aria-keyshortcuts="Escape">{paused ? '모션 재생' : '모션 멈추기'}</button>
    {phase === 'clouds' && <div className="arrival-scroll-hint" aria-hidden="true"><span>아래로 스크롤</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 4v15m-6-6 6 6 6-6"/></svg></div>}
    {phase === 'clouds' && <p className="arrival-sr-only">아래로 스크롤하거나 위로 쓸어 올려 시작합니다. 키보드 아래 방향키로도 시작할 수 있습니다.</p>}
    {['revealing', 'flying', 'departing', 'following', 'preparing'].includes(phase) && <span className="flight-wordmark brand-wordmark">Seoul Times</span>}
    {(error || (phase === 'landed' && !position) || (!demo && position && (position.accuracyM > 20 || !containsPoint(position)))) && <div className="arrival-location-notice">
      {error && <p role="alert">{error}</p>}
      {!position && !error && <p role="status">현재 위치를 확인 중입니다. 지도 중심은 탐색용 위치이며 현재 위치가 아닙니다.</p>}
      {!demo && position && position.accuracyM > 20 && <p role="status">대략적인 위치입니다(오차 약 {Math.ceil(position.accuracyM)}m). 신문을 열려면 위치 오차가 20m 이하여야 합니다.</p>}
      {!demo && position && !containsPoint(position) && <p role="status">수신 위치가 서비스 지역 밖입니다. 지도는 서울 탐색 영역을 보여주며 현재 위치를 뜻하지 않습니다.</p>}
      {phase === 'landed' && <button onClick={() => locate(true)}>현재 위치 다시 확인</button>}
    </div>}
    <div className="arrival-sr-only" role="status" aria-live="polite">{phase === 'revealing' ? '근두운을 탄 홍길동이 나타납니다.' : phase === 'flying' ? '홍길동이 잠시 우리를 바라봅니다.' : phase === 'departing' ? '홍길동이 먼저 아래로 뛰어내립니다.' : phase === 'following' ? '홍길동을 따라 구름 속으로 내려갑니다.' : phase === 'falling' ? '홍길동이 서울 지도 위로 떨어집니다.' : phase === 'landed' ? '같은 서울 지도에서 장소를 탐색합니다.' : ''}</div>
    {phase === 'landed' && <><WorldControls entryRef={worldAction} places={places} selectedId={selectedId} onSelect={reader.select} filters={filters} onFilter={next => { setFilters(next); reader.clear(); }} position={position} demo={demo} tracking={tracking} status={error} onTrack={() => locate(true)} onStop={() => { setTracking(false); setError('위치 추적을 멈췄습니다.'); }} mapControlRef={mapControlRef} onMoveDemo={moveDemo} onDemo={onDemo} onRestart={restart} onSimulate={reader.simulate} onChat={openChat}/><VisitOverlays reader={reader} onChat={openChat} onTrack={() => locate(true)} reduced={reduced}/>{chat && <NearbyChat place={chat.place} onClose={() => setChat(null)}/>}</>}
  </section>;
}
