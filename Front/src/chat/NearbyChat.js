import { useEffect, useRef, useState } from 'react';
import { createChatSession, sendChatMessage } from './api';
import './chat.css';

export default function NearbyChat({ place, location = null, onClose }) {
  const [input,setInput]=useState(''),[messages,setMessages]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const session=useRef(null), request=useRef(null), mounted=useRef(true), dialog=useRef(null), bottom=useRef(null);
  useEffect(()=>{const previous=document.activeElement;mounted.current=true;dialog.current.focus();return()=>{mounted.current=false;request.current?.abort();if(previous?.isConnected)previous.focus({preventScroll:true});};},[]);
  useEffect(()=>{ bottom.current?.scrollIntoView?.({block:'nearest'}); },[messages,busy]);
  async function send(event){
    event.preventDefault();const content=input.trim();if(!content||busy)return;
    setBusy(true);setError('');const controller=new AbortController();request.current=controller;
    try{
      if(!session.current)session.current=await createChatSession(place,controller.signal);
      const answer=await sendChatMessage(session.current,content,controller.signal,location);
      if(mounted.current){setMessages(items=>[...items,{role:'user',text:content},{role:'assistant',text:answer}]);setInput('');}
    }catch(failure){if(mounted.current&&failure.name!=='AbortError')setError(failure.message==='Failed to fetch'?'추천 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.':failure.message);}
    finally{if(mounted.current)setBusy(false);}
  }
  function keyboard(event){
    if(event.key==='Escape'){event.stopPropagation();onClose();}
    if(event.key==='Tab'){
      const nodes=dialog.current.querySelectorAll('button:not([disabled]),textarea:not([disabled]),[tabindex="0"]');const first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }
  return <div className="nearby-chat-overlay"><div className="nearby-chat-shade" onClick={onClose}/><div className="nearby-chat-positioner"><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="주변 추천 챗봇" className="nearby-chat" onKeyDown={keyboard}>
    <header><div><h2>주변 추천</h2><p>{place?place.name:'가고 싶은 장소를 알려주세요.'}</p></div><button className="ui-close" aria-label="주변 추천 닫기" onClick={onClose}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button></header>
    <div className="nearby-chat-messages scroll-without-bar" role="log" aria-label="추천 대화" aria-live="polite" tabIndex={0}>
      {!messages.length&&<p>식당·카페·관광지 중 찾는 곳과 필요한 이동 조건을 알려주세요.</p>}
      {messages.map((item,index)=><p className={`chat-message is-${item.role}`} key={index}>{item.text}</p>)}
      {busy&&<p role="status">주변 장소를 확인하고 있어요…</p>}{error&&<p role="alert">{error}</p>}<div ref={bottom}/>
    </div>
    <form onSubmit={send}><label htmlFor="nearby-message" className="arrival-sr-only">추천 요청</label><textarea id="nearby-message" value={input} onChange={event=>setInput(event.target.value)} placeholder="어떤 곳을 찾으세요?" className="scroll-without-bar" maxLength={2000} rows={1} disabled={busy}/><button type="submit" disabled={busy||!input.trim()}>{error?'다시 보내기':'보내기'}</button></form>
  </section></div></div>;
}
