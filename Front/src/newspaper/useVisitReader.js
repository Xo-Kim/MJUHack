import { useCallback, useEffect, useRef, useState } from 'react';
import { places } from '../data/places';
import newspapers from '../data/newspapers.json';
import { evaluateVisit, newspaperLanguage, positionAtDistance, visitMessages, VISIT_FIX_MAX_AGE_MS } from './visit';

export default function useVisitReader({ position, demo, fallback = false, issue, active }) {
  const [selectedId, setSelectedId] = useState(null), [opened, setOpened] = useState(false);
  const [simulation, setSimulation] = useState(null), [toast, setToast] = useState(null), [clock, setClock] = useState(Date.now);
  const toastId = useRef(0);
  const place = places.find(item => item.id === selectedId);
  const language = simulation?.language || newspaperLanguage();
  const visitPosition = simulation ? simulation.position : position;
  const liveSource = fallback ? 'fallback' : demo ? 'demo' : 'gps';
  const source = simulation ? 'simulation' : liveSource;
  const gate = evaluateVisit({ place, position: visitPosition, source, issue: simulation?.issue || (!simulation && issue), now: Math.max(clock, Date.now()), allowSimulation: process.env.NODE_ENV === 'development' });
  const record = newspapers[selectedId];
  const notify = useCallback(message => setToast({ message, id: ++toastId.current }), []);
  const dismissToast = useCallback(() => setToast(null), []);
  function select(id) {
    setSimulation(null); setSelectedId(id); setOpened(false); setClock(Date.now());
    if (!id) return;
    const nextPlace = places.find(item => item.id === id);
    const nextGate = evaluateVisit({ place: nextPlace, position, source: liveSource, issue });
    if (nextGate.allowed && newspapers[id]) setOpened(true);
    else notify(visitMessages[newspaperLanguage()][nextGate.reason] || (newspaperLanguage() === 'ko' ? '이 장소의 신문을 준비 중이에요.' : 'The newspaper for this place is not available yet.'));
  }
  function simulate({ placeId, metres, language: locale, accuracyM, condition }) {
    if (process.env.NODE_ENV !== 'development') return;
    const target = places.find(item => item.id === placeId), now = Date.now();
    const fix = { ...positionAtDistance(target, metres), accuracyM, observedAt: new Date(now - (condition === 'stale' ? VISIT_FIX_MAX_AGE_MS + 1000 : 0)).toISOString() };
    const next = { position: condition === 'missing' ? null : fix, issue: condition === 'denied' ? 'denied' : null, language: locale };
    const nextGate = evaluateVisit({ place: target, ...next, source: 'simulation', now, allowSimulation: true });
    setSelectedId(placeId); setSimulation(next); setOpened(nextGate.allowed && !!newspapers[placeId]); setClock(now);
    if (!nextGate.allowed) notify(visitMessages[locale][nextGate.reason]);
  }
  function openPaper() {
    if (!simulation) { select(selectedId); return; }
    const current = evaluateVisit({ place, position: simulation.position, source: 'simulation', issue: simulation.issue, allowSimulation: process.env.NODE_ENV === 'development' });
    if (current.allowed && record) setOpened(true);
    else notify(visitMessages[language][current.reason]);
  }
  useEffect(() => {
    setClock(Date.now());
    if (!selectedId) return;
    const age = Date.now() - Date.parse(visitPosition?.observedAt);
    if (!Number.isFinite(age) || age > VISIT_FIX_MAX_AGE_MS) return;
    const timer = setTimeout(() => setClock(Date.now()), VISIT_FIX_MAX_AGE_MS - age + 1);
    return () => clearTimeout(timer);
  }, [selectedId, visitPosition]);
  useEffect(() => {
    if (opened && (!gate.allowed || !active)) {
      setOpened(false);
      if (active) notify(visitMessages[language][gate.reason]);
    }
  }, [opened, gate.allowed, gate.reason, active, language, notify]);
  return { selectedId, place, record, gate, language, simulation, opened, toast, select, simulate,
    clear: () => { setOpened(false); setSelectedId(null); setSimulation(null); },
    closePaper: () => setOpened(false),
    openPaper,
    dismissToast,
  };
}
