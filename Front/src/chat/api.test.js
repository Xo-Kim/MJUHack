import {createChatSession,sendChatMessage} from './api';
afterEach(()=>jest.restoreAllMocks());
test('uses current Spring session/message DTOs without sending GPS or browser secrets',async()=>{
 global.fetch=jest.fn().mockResolvedValueOnce({ok:true,json:async()=>({id:'test-session'})}).mockResolvedValueOnce({ok:true,json:async()=>({message:{content:'실제 서버 응답'}})});
 const id=await createChatSession({id:'JNG09',name:'의금부 터'});expect(id).toBe('test-session');
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({startSpotId:'JNG09',startLabel:'의금부 터'});
 expect(await sendChatMessage(id,'카페')).toBe('실제 서버 응답');expect(fetch.mock.calls[1][0]).toBe('/api/chat/sessions/test-session/messages');expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({content:'카페'});
});
test('location is sent only when known, and a place the server removed still starts a chat',async()=>{
 global.fetch=jest.fn().mockResolvedValueOnce({ok:true,json:async()=>({message:{content:'답변'}})});
 await sendChatMessage('s','근처',undefined,{latitude:37.58,longitude:126.9238,fallback:true});
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({content:'근처',location:{latitude:37.58,longitude:126.9238,fallback:true}});
 global.fetch=jest.fn().mockResolvedValueOnce({ok:false,status:400}).mockResolvedValueOnce({ok:true,json:async()=>({id:'after-retry'})});
 expect(await createChatSession({id:'EPY04',name:'수국사'})).toBe('after-retry');
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({startSpotId:null,startLabel:'수국사'});
});
test('backend error is surfaced without a local simulated answer',async()=>{
 global.fetch=jest.fn().mockResolvedValue({ok:false,status:503});await expect(createChatSession()).rejects.toThrow('추천을 연결하지 못했어요');
});
