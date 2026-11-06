const base = (process.env.REACT_APP_API_BASE_URL || '').replace(/\/$/, '');
async function post(path, body, signal) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) { const failure = new Error(response.status === 410 ? '대화가 만료됐어요. 창을 닫고 다시 열어 주세요.' : '추천을 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'); failure.status = response.status; throw failure; }
  try { return await response.json(); } catch { throw new Error('추천 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.'); }
}
export async function createChatSession(place, signal) {
  // 서버에서 삭제된 장소는 400 이 난다. 그 경우 장소 없이 대화를 시작한다.
  const data = await post('/api/chat/sessions', { startSpotId: place?.id || null, startLabel: place?.name || null }, signal)
    .catch(failure => { if (failure.status === 400 && place?.id) return post('/api/chat/sessions', { startSpotId: null, startLabel: place.name || null }, signal); throw failure; });
  if (typeof data.id !== 'string') throw new Error('대화를 시작하지 못했어요. 다시 시도해 주세요.');
  return data.id;
}
export async function sendChatMessage(sessionId, content, signal, location = null) {
  const data = await post(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { content, ...(location ? { location } : {}) }, signal);
  if (typeof data.message?.content !== 'string') throw new Error('추천 답변을 받지 못했어요. 다시 시도해 주세요.');
  return data.message.content;
}
