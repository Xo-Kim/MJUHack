import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CloudCanvas from './CloudCanvas';
import HeroCanvas from './HeroCanvas';
import LandingMap from './LandingMap';
import WorldControls from './WorldControls';
import { ARRIVAL_TIMING, NEXT_PHASE } from './heroConfig';
import { demoPosition, fallbackPosition, requestPosition, watchPosition } from './location';
import { containsPoint } from '../data/mapArea';
import { filterPlaces } from '../data/places';
import useVisitReader from '../newspaper/useVisitReader';
import NearbyChat from '../chat/NearbyChat';
import VisitOverlays from '../newspaper/VisitOverlays';
import './arrival.css';

const MAP_PHASES = ['following', 'preparing', 'clearing', 'falling', 'impact', 'pullback', 'landed'];
const FALLBACK_MESSAGES = {
  denied: '위치 권한이 꺼져 있어 명지대 MCC를 기준으로 보여줘요.',
  missing: '현재 위치를 받지 못해 명지대 MCC를 기준으로 보여줘요.',
  outside: '서비스 지역 밖이라 명지대 MCC를 기준으로 보여줘요.'
};

export default function CloudArrival({ onLocated, onDemo, active = true }) {
  const development = process.env.NODE_ENV === 'development';
  const [phase, setPhase] = useState('clouds'), [heroReady, setHeroReady] = useState(false);
  const [cloudsCleared, setCloudsCleared] = useState(false), [position, setPosition] = useState(null), [demo, setDemo] = useState(false);
  const [error, setError] = useState(''), [tracking, setTracking] = useState(false), [updates, setUpdates] = useState(0);
  const [locationIssue, setLocationIssue] = useState(null), [chat, setChat] = useState(null), [notice, setNotice] = useState('');
  const [paused, setPaused] = useState(false), [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false);
  const [filters, setFilters] = useState({ districtId: '', eraId: '', query: '' });
  const reader = useVisitReader({ position, demo, issue: locationIssue, active: active && phase === 'landed' });
  const { selectedId } = reader;
  const places = useMemo(() => filterPlaces(filters), [filters]);
  const sceneRoot = useRef(null), mounted = useRef(true), requestId = useRef(0), stageTime = useRef(0), worldAction = useRef(null);
  const scrollDistance = useRef(0), touchStart = useRef(null), startScroll = useRef(null);
  const anchorRef = useRef(null), mapControlRef = useRef(null), mapPrepared = useRef(false), phaseRef = useRef(phase), callback = useRef(onLocated), activeRef = useRef(active), lastFix = useRef(0), hasRealFix = useRef(false), usingFallback = useRef(false);
  phaseRef.current = phase; callback.current = onLocated; activeRef.current = active;

  const applyFallback = useCallback(reason => {
    if (hasRealFix.current) return;
    if (!usingFallback.current) {
      usingFallback.current = true;
      const next = fallbackPosition();
      setPosition(next); setDemo(true); mapControlRef.current?.center(next);
    }
    if (reason) setNotice(FALLBACK_MESSAGES[reason]);
  }, []);
  // 실제 위치가 늦거나 실패해도 지도와 캐릭터가 기준점을 갖도록, 지도가 뜨기 전에 MCC 를 잡아 둔다.
  useEffect(() => { if (!position && MAP_PHASES.includes(phase)) applyFallback(); }, [position, phase, applyFallback]);
  useEffect(() => {
    if (!notice || phase !== 'landed') return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice, phase]);
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
      if (!containsPoint(next)) { applyFallback('outside'); return; }
      const wasFallback = usingFallback.current;
      hasRealFix.current = true; usingFallback.current = false;
      setPosition(next); setDemo(false); setNotice(''); setUpdates(value => value + 1); setError(''); setLocationIssue(null); callback.current?.(next, false);
      if (wasFallback) mapControlRef.current?.center(next);
    }, failure => { setError(failure.message); setLocationIssue(failure.code === 1 ? 'denied' : failure.code === 'accuracy' ? 'accuracy' : 'missing'); if (failure.code === 1) { setTracking(false); applyFallback('denied'); } }, lastFix.current);
  }, [tracking, phase, active, hidden, applyFallback]);

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
  async function locate(real = !development, automatic = false) {
    const id = ++requestId.current, alreadyLanded = phase === 'landed';
    setError(''); if (!alreadyLanded && !automatic) setPhase('locating');
    try {
      const next = real ? await requestPosition() : demoPosition();
      if (!mounted.current || !activeRef.current || id !== requestId.current) return;
      lastFix.current = Date.parse(next.observedAt);
      setTracking(real); setLocationIssue(null);
      if (real && !containsPoint(next)) applyFallback('outside');
      else {
        if (real) hasRealFix.current = true;
        usingFallback.current = false;
        setPosition(next); setDemo(!real); setNotice(''); setUpdates(value => value + 1); callback.current?.(next, !real);
        mapControlRef.current?.center(next);
      }
      if (!alreadyLanded && !automatic) {
        stageTime.current = 0; setCloudsCleared(false);
        setPhase(mapPrepared.current ? 'clearing' : 'preparing');
      }
    } catch (failure) { if (mounted.current && id === requestId.current) { setError(failure.message); setLocationIssue(failure.code === 1 ? 'denied' : failure.code === 'accuracy' ? 'accuracy' : 'missing'); setTracking(failure.code !== 1); applyFallback(failure.code === 1 ? 'denied' : 'missing'); if (!alreadyLanded && !automatic) setPhase('flying'); } }
  }
  function revealFromScroll() {
    if (!active || !heroReady || paused || phaseRef.current !== 'clouds') return;
    phaseRef.current = 'revealing'; stageTime.current = 0; setPhase('revealing');
    locate(!development, true);
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
    {position && <div className="arrival-anchor"><div className="avatar-ground-shadow"/>{['impact', 'pullback'].includes(phase) && <div className="impact-waves"><div className="impact-ring impact-one"/><div className="impact-ring impact-two"/></div>}</div>}
    {!cloudsCleared && <CloudCanvas opening={landing} paused={isPaused} reduced={reduced} showcase={landing ? 0 : phase === 'clouds' ? .72 : 1} onCleared={cloudClear}/>}
    <HeroCanvas phase={phase} paused={isPaused} reduced={reduced} onReady={modelReady} onCamera={cameraUpdate} anchorRef={anchorRef} hasPosition={!!position || ['falling', 'impact', 'pullback'].includes(phase)}/>
    <h1 className="arrival-sr-only">seoul times</h1>
    <button className="arrival-motion-control" onClick={() => setPaused(value => !value)} aria-pressed={paused} aria-keyshortcuts="Escape">{paused ? '모션 재생' : '모션 멈추기'}</button>
    {phase === 'clouds' && <div className="arrival-scroll-hint" aria-hidden="true"><span>아래로 스크롤</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 4v15m-6-6 6 6 6-6"/></svg></div>}
    {phase === 'clouds' && <p className="arrival-sr-only">아래로 스크롤하거나 위로 쓸어 올려 시작합니다. 키보드 아래 방향키로도 시작할 수 있습니다.</p>}
    {['revealing', 'flying', 'departing', 'following', 'preparing'].includes(phase) && <span className="flight-wordmark brand-wordmark">Seoul Times</span>}
    {error && phase !== 'landed' && <p className="arrival-sr-only" role="alert">{error}</p>}
    <div className="arrival-sr-only" role="status" aria-live="polite">{phase === 'revealing' ? '근두운을 탄 홍길동이 나타납니다.' : phase === 'flying' ? '홍길동이 잠시 우리를 바라봅니다.' : phase === 'departing' ? '홍길동이 먼저 아래로 뛰어내립니다.' : phase === 'following' ? '홍길동을 따라 구름 속으로 내려갑니다.' : phase === 'falling' ? '홍길동이 서울 지도 위로 떨어집니다.' : phase === 'landed' ? '같은 서울 지도에서 장소를 탐색합니다.' : ''}</div>
    {phase === 'landed' && <><WorldControls entryRef={worldAction} places={places} selectedId={selectedId} onSelect={reader.select} filters={filters} onFilter={next => { setFilters(next); reader.clear(); }} position={position} demo={demo} tracking={tracking} status={error} onTrack={() => locate(true)} onStop={() => { setTracking(false); setError('위치 추적을 멈췄습니다.'); }} mapControlRef={mapControlRef} onMoveDemo={moveDemo} onDemo={onDemo} onRestart={restart} onSimulate={reader.simulate} onChat={openChat}/><VisitOverlays reader={reader} onChat={openChat} onTrack={() => locate(true)} reduced={reduced}/>{notice && <div className="visit-toast location-fallback-notice" role="status" aria-live="polite">{notice}</div>}{chat && <NearbyChat place={chat.place} onClose={() => setChat(null)}/>}</>}
  </section>;
}
