import { useEffect, useRef, useState } from 'react';
import { loadNaverMaps } from '../api/naverMaps';
import { mapOptions, mapStyleId } from '../api/mapOptions';
import { hasCoordinates } from '../data/places';
import { AREA_MAX_ZOOM, AREA_MIN_ZOOM, clampToArea, districtAreas } from '../data/mapArea';
import { createMapAreaLayer } from '../api/mapAreaLayer';
import useMapGestures from '../arrival/mapGestures';
import './PlacesMap.css';

export default function PlacesMap({ places, selectedId, onSelect, position, positionIsDemo = false, isMock = false, world = false, enabled = true, interactive = true, anchorRef, mapControlRef, onReady }) {
  const container = useRef(null), viewport = useRef(null), mapRef = useRef(null), mapsRef = useRef(null);
  const markers = useRef(new Map()), currentMarker = useRef(null), fitted = useRef(false), previousSelected = useRef(null);
  const displayedPosition = useRef(null);
  const latest = useRef({ places, onSelect, position, onReady });
  const [state, setState] = useState('waiting'), [retry, setRetry] = useState(0), [tilesLoaded, setTilesLoaded] = useState(false);
  const clientId = process.env.REACT_APP_NAVER_MAP_CLIENT_ID;
  useMapGestures(viewport, mapRef, mapsRef, world && interactive, state, AREA_MIN_ZOOM, AREA_MAX_ZOOM);
  useEffect(() => { latest.current = { places, onSelect, position, onReady }; }, [places, onSelect, position, onReady]);

  useEffect(() => {
    if (!enabled) return;
    if (!clientId) { setState('unconfigured'); latest.current.onReady?.({ unavailable: true }); return; }
    let cancelled = false, observer, areaLayer;
    const listeners = [];
    const registry = markers.current;
    setState('loading'); setTilesLoaded(false);
    loadNaverMaps(clientId).then(maps => {
      if (cancelled) return;
      mapsRef.current = maps;
      const first = world ? latest.current.position : latest.current.places.find(hasCoordinates);
      const initial = !isMock ? clampToArea(first || { latitude: 37.57, longitude: 126.96 }) : first;
      const center = initial ? new maps.LatLng(initial.latitude, initial.longitude) : new maps.LatLng(37.57, 126.96);
      const map = new maps.Map(container.current, { ...mapOptions(maps), center, zoom: world ? 17 : 13, zoomControl: !world, draggable: !world, scrollWheel: !world, pinchZoom: !world, keyboardShortcuts: !world,
        ...(!isMock ? { minZoom: AREA_MIN_ZOOM, maxZoom: AREA_MAX_ZOOM } : {}) });
      mapRef.current = map;
      if (!isMock) areaLayer = createMapAreaLayer(maps, map);
      const fitCoordinates = coordinates => {
        let horizontal = 80, vertical = 80;
        const view = world && container.current.closest('.arrival');
        if (view) {
          const style = getComputedStyle(view), scale = Number(style.getPropertyValue('--landing-scale')) || 1;
          const tilt = parseFloat(style.getPropertyValue('--landing-tilt')) || 0;
          const visibleWidth = view.clientWidth / scale * .65;
          const visibleHeight = view.clientHeight / (scale * Math.cos(tilt * Math.PI / 180)) * .65;
          horizontal = Math.max(40, (container.current.clientWidth - visibleWidth) / 2 + 40);
          vertical = Math.max(40, (container.current.clientHeight - visibleHeight) / 2 + 40);
        }
        map.fitBounds(coordinates, { top: vertical, right: horizontal, bottom: vertical, left: horizontal, maxZoom: 15 });
      };
      if (mapControlRef) mapControlRef.current = {
        center: next => { const point = isMock ? next : clampToArea(next); map.panTo(new maps.LatLng(point.latitude, point.longitude)); },
        zoom: delta => map.setZoom(Math.max(AREA_MIN_ZOOM, Math.min(AREA_MAX_ZOOM, map.getZoom() + delta))),
        area: () => fitCoordinates(districtAreas.flatMap(area => area.ring.map(([longitude, latitude]) => new maps.LatLng(latitude, longitude)))),
        fit: () => {
          const located = latest.current.places.filter(hasCoordinates);
          if (!located.length) return;
          fitCoordinates(located.map(place => new maps.LatLng(place.latitude, place.longitude)));
        }
      };
      listeners.push(maps.Event.addListener(map, 'tilesloaded', () => { if (!cancelled) setTilesLoaded(true); }));
      observer = new ResizeObserver(() => {
        if (viewport.current.clientWidth && viewport.current.clientHeight) map.setSize(new maps.Size(viewport.current.clientWidth, viewport.current.clientHeight));
      });
      observer.observe(viewport.current);
      setState('ready');
      latest.current.onReady?.({ maps, map });
    }).catch(() => { if (!cancelled) { setState('error'); latest.current.onReady?.({ unavailable: true }); } });
    return () => {
      cancelled = true; observer?.disconnect();
      areaLayer?.destroy();
      const maps = mapsRef.current;
      listeners.forEach(listener => maps?.Event.removeListener(listener));
      registry.forEach(({ marker, listener }) => { maps?.Event.removeListener(listener); marker.setMap(null); });
      registry.clear(); currentMarker.current?.setMap(null); currentMarker.current = null;
      displayedPosition.current = null;
      mapRef.current?.destroy(); mapRef.current = null; mapsRef.current = null;
      fitted.current = false; previousSelected.current = null;
      if (mapControlRef) mapControlRef.current = null;
      if (anchorRef) anchorRef.current = null;
    };
  }, [clientId, retry, enabled, world, isMock, anchorRef, mapControlRef]);

  useEffect(() => {
    if (world && state === 'ready') mapRef.current?.setOptions({ draggable: false, scrollWheel: interactive, pinchZoom: false, keyboardShortcuts: false, disableDoubleClickZoom: !interactive });
  }, [world, interactive, state]);

  useEffect(() => {
    const map = mapRef.current, maps = mapsRef.current;
    if (state !== 'ready' || !map || !maps) return;
    const located = places.filter(hasCoordinates), ids = new Set(located.map(place => place.id));
    markers.current.forEach(({ marker, listener }, id) => {
      if (!ids.has(id)) { maps.Event.removeListener(listener); marker.setMap(null); markers.current.delete(id); }
    });
    located.forEach(place => {
      let entry = markers.current.get(place.id);
      if (!entry) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'history-map-pin'; button.title = place.name;
        const image = document.createElement('img');
        image.src = `${process.env.PUBLIC_URL}/assets/map-pin-mint.png`; image.alt = ''; image.width = 46; image.height = 56; image.draggable = false;
        button.appendChild(image);
        button.dataset.historyPin = place.id; button.setAttribute('aria-label', `${place.name} 지도 핀`);
        button.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); latest.current.onSelect(place.id); } };
        const marker = new maps.Marker({ map, position: new maps.LatLng(place.latitude, place.longitude), title: place.name,
          icon: { content: button, size: new maps.Size(72, 82), anchor: new maps.Point(36, 64) } });
        const listener = maps.Event.addListener(marker, 'click', () => latest.current.onSelect(place.id));
        entry = { marker, listener, button, latitude: place.latitude, longitude: place.longitude };
        markers.current.set(place.id, entry);
      } else if (entry.latitude !== place.latitude || entry.longitude !== place.longitude) {
        entry.marker.setPosition(new maps.LatLng(place.latitude, place.longitude));
        entry.latitude = place.latitude; entry.longitude = place.longitude;
      }
      entry.button.setAttribute('aria-pressed', String(place.id === selectedId));
      entry.marker.setZIndex(place.id === selectedId ? 100 : 1);
    });
    if (!world && !fitted.current && located.length && container.current.clientWidth) {
      map.fitBounds(located.map(place => new maps.LatLng(place.latitude, place.longitude)), { top: 65, right: 45, bottom: 65, left: 45, maxZoom: 15 });
      fitted.current = true;
    }
    if (selectedId !== previousSelected.current) {
      const selected = located.find(place => place.id === selectedId);
      if (selected) map.panTo(new maps.LatLng(selected.latitude, selected.longitude));
      previousSelected.current = selectedId;
    }
  }, [places, selectedId, state, world]);

  useEffect(() => {
    const map = mapRef.current, maps = mapsRef.current;
    if (state !== 'ready' || !map || !maps) return;
    if (world && currentMarker.current && position && hasCoordinates(position)) {
      currentMarker.current.setTitle?.(positionIsDemo ? '가상 현재 위치' : position?.accuracyM > 20 ? '대략적인 위치' : '현재 위치');
      const from = displayedPosition.current || position;
      let frame, start;
      const duration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 450;
      const move = now => {
        if (start === undefined) start = now;
        const progress = duration ? Math.min(1, (now - start) / duration) : 1;
        const eased = progress * progress * (3 - 2 * progress);
        const next = { latitude: from.latitude + (position.latitude - from.latitude) * eased, longitude: from.longitude + (position.longitude - from.longitude) * eased };
        displayedPosition.current = next;
        currentMarker.current?.setPosition(new maps.LatLng(next.latitude, next.longitude));
        if (progress < 1) frame = requestAnimationFrame(move);
      };
      frame = requestAnimationFrame(move);
      return () => cancelAnimationFrame(frame);
    }
    currentMarker.current?.setMap(null); currentMarker.current = null;
    displayedPosition.current = null;
    if (anchorRef) anchorRef.current = null;
    if (position && hasCoordinates(position)) {
      const dot = document.createElement('span'); dot.className = world ? 'world-avatar-anchor' : 'current-map-pin';
      if (world) { dot.setAttribute('aria-hidden', 'true'); dot.dataset.avatarAnchor = ''; if (anchorRef) anchorRef.current = dot; }
      else { dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', positionIsDemo ? '가상 현재 위치' : position?.accuracyM > 20 ? '대략적인 위치' : '현재 위치'); }
      currentMarker.current = new maps.Marker({ map, position: new maps.LatLng(position.latitude, position.longitude),
        title: positionIsDemo ? '가상 현재 위치' : position?.accuracyM > 20 ? '대략적인 위치' : '현재 위치', zIndex: 200,
        icon: { content: dot, size: new maps.Size(world ? 1 : 24, world ? 1 : 24), anchor: new maps.Point(world ? 0 : 12, world ? 0 : 12) } });
      displayedPosition.current = position;
    }
  }, [position, positionIsDemo, state, world, anchorRef]);

  function fitPlaces() {
    const maps = mapsRef.current, located = places.filter(hasCoordinates);
    if (maps && located.length) mapRef.current.fitBounds(located.map(place => new maps.LatLng(place.latitude, place.longitude)), { top: 65, right: 45, bottom: 65, left: 45, maxZoom: 15 });
  }
  const count = places.filter(hasCoordinates).length;
  return <div className={`map-region ${world ? 'world-map-region' : ''}`} data-map-state={state} data-history-marker-count={state === 'ready' ? count : 0} data-tiles-loaded={tilesLoaded}>
    {!world && <div className="map-toolbar"><button disabled={state !== 'ready' || !count} onClick={fitPlaces}>전체 핀 보기</button><button disabled={state !== 'ready' || !position || !hasCoordinates(position)} onClick={() => mapRef.current.panTo(new mapsRef.current.LatLng(position.latitude, position.longitude))}>{positionIsDemo ? '가상 위치 보기' : '현재 위치 보기'}</button></div>}
    <div ref={viewport} className={`map-viewport ${world && interactive ? 'map-gestures-enabled' : ''}`} tabIndex={world && interactive ? 0 : undefined} aria-label={world ? '지도 이동 영역' : undefined}><div ref={container} className="naver-map" hidden={['error', 'unconfigured'].includes(state)} aria-label="네이버 장소 지도" /></div>
    {state !== 'ready' && <div className="map-fallback" role="status"><p>{state === 'error' ? '네이버 지도 연결에 실패했습니다.' : state === 'unconfigured' ? '네이버 지도 공개 ID가 설정되지 않았습니다.' : '네이버 지도를 불러오는 중…'}</p><p>장소 목록에서 계속 선택할 수 있습니다.</p>{state === 'error' && <button onClick={() => setRetry(value => value + 1)}>지도 다시 연결</button>}</div>}
    {!world && <p className="caption">{state === 'ready' ? `NAVER Maps · ${count}개 장소 핀 · ${isMock ? '가상 시연 장소' : '엑셀 원본 좌표 / 정확도 미검증'}` : '지도 연결 상태와 관계없이 전체 장소 목록을 유지합니다.'}{state === 'ready' && !mapStyleId ? ' · 배경 전용 지도' : ''}</p>}
  </div>;
}
