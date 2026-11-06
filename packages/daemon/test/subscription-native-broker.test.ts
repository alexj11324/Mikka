import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeSubscriptionBroker } from "../src/subscription-native-broker";
import { cleanupTempDirs, tempDir } from "./helpers";
import { createLogger } from "../src/log";

afterEach(cleanupTempDirs);
const post = (socket: string, parts: Buffer[]) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const call = request(
      { socketPath: socket, path: "/v1/messages", method: "POST" },
      (response) => {
        let text = "";
        response.on("data", (part) => {
          text += part;
        });
        response.on('error', reject);
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, text }),
        );
      },
    );
    call.on("error", reject);
    for (const part of parts) call.write(part);
    call.end();
  });
it("uses only its bound worker, preserves UTF-8 input and stops all provider use after revocation", async () => {
  let connected = true;
  let checks = 0;
  const nativeRequest = vi.fn(async (_revision, payload) => ({
    contentType: "application/json",
    body: new Response(
      JSON.stringify({ text: payload.body.messages[0].content }),
    ).body!,
  }));
  const broker = await createNativeSubscriptionBroker({
    root: tempDir(),
    revision: 7,
    check: async () => {
      checks++;
      if (!connected) throw new Error("revoked");
    },
    worker: { nativeRequest },
  });
  try {
    const bytes = Buffer.from(
      JSON.stringify({
        model: "bound-model",
        messages: [{ role: "user", content: "汉字🙂" }],
      }),
    );
    const result = await post(
      broker.socket,
      [...bytes].map((byte) => Buffer.from([byte])),
    );
    expect(result).toEqual({
      status: 200,
      text: JSON.stringify({ text: "汉字🙂" }),
    });
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(nativeRequest.mock.calls[0][0]).toBe(7);
    connected = false;
    expect((await post(broker.socket, [bytes])).status).toBe(503);
    expect((await post(broker.socket, [bytes])).status).toBe(503);
    expect(checks).toBe(4);
    expect(nativeRequest).toHaveBeenCalledOnce();
  } finally {
    await broker.close();
  }
});
it("allows the native client's next request after failure without replaying a request itself", async () => {
  const nativeRequest = vi.fn()
    .mockRejectedValueOnce(new Error('synthetic-private-provider-diagnostic'))
    .mockResolvedValue({contentType:'application/json',body:new Response('recovered').body!});
  const check=vi.fn(async()=>{});
  const log=createLogger({level:'silent'}),warn=vi.spyOn(log,'warn');
  const broker = await createNativeSubscriptionBroker({
    root: tempDir(),
    revision: 7,
    check,
    log,
    worker: { nativeRequest },
  });
  try {
    const bytes = Buffer.from('{"model":"bound-model"}');
    const result = await post(broker.socket, [bytes]);
    expect(result.status).toBe(503);
    expect(result.text).not.toContain("synthetic-private");
    expect(nativeRequest).toHaveBeenCalledOnce(); // No broker-generated retry.
    expect(await post(broker.socket, [bytes])).toEqual({status:200,text:'recovered'});
    expect(nativeRequest).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(3); // Creation, then each independent CLI request.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toEqual({event:'subscription_native_broker_failure',phase:'upstream_request',body_bytes:bytes.length,status_class:'local_503'});
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
  } finally {
    await broker.close();
  }
});


it('a transient authority-query failure refuses one request, then requires another fresh successful check',async()=>{
  const check=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('synthetic-private-query')).mockResolvedValue(undefined);
  const nativeRequest=vi.fn(async()=>({contentType:'application/json',body:new Response('ok').body!}));
  const broker=await createNativeSubscriptionBroker({root:tempDir(),revision:7,check,worker:{nativeRequest}});
  try{
    const bytes=Buffer.from('{"model":"bound-model"}');
    expect((await post(broker.socket,[bytes])).status).toBe(503);expect(nativeRequest).not.toHaveBeenCalled();
    expect((await post(broker.socket,[bytes])).status).toBe(200);expect(check).toHaveBeenCalledTimes(3);expect(nativeRequest).toHaveBeenCalledOnce();
  }finally{await broker.close();}
});

it.each(['invalid_json','oversized'])('a refused %s body cannot poison a later valid CLI request',async kind=>{
  const check=vi.fn(async()=>{}),nativeRequest=vi.fn(async()=>({contentType:'application/json',body:new Response('ok').body!}));
  const log=createLogger({level:'silent'}),warn=vi.spyOn(log,'warn');
  const broker=await createNativeSubscriptionBroker({root:tempDir(),revision:7,check,log,worker:{nativeRequest}});
  try{
    const bad=Buffer.from(kind==='invalid_json'?'synthetic-private-invalid-json':JSON.stringify({model:'bound-model',input:'synthetic-private'.repeat(20000)}));
    const refused=await post(broker.socket,[bad]).catch(()=>null);expect(refused?.status).not.toBe(200);
    expect(nativeRequest).not.toHaveBeenCalled();
    expect((await post(broker.socket,[Buffer.from('{"model":"bound-model"}')])).status).toBe(200);
    expect(nativeRequest).toHaveBeenCalledOnce();expect(check).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();expect(warn.mock.calls[0][0]).toMatchObject({event:'subscription_native_broker_failure',phase:kind==='invalid_json'?'body_parse':'body_read',status_class:'local_503'});
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
  }finally{await broker.close();}
});

it('a stream interruption aborts only that request, then the native client may issue a fresh request',async()=>{
  const nativeRequest=vi.fn().mockResolvedValueOnce({contentType:'text/event-stream',body:new ReadableStream({start(c){c.error(new Error('synthetic-private-stream'));}})})
    .mockResolvedValueOnce({contentType:'application/json',body:new Response('recovered').body!});
  const check=vi.fn(async()=>{}),log=createLogger({level:'silent'}),warn=vi.spyOn(log,'warn');
  const broker=await createNativeSubscriptionBroker({root:tempDir(),revision:7,check,log,worker:{nativeRequest}});
  try{
    const bytes=Buffer.from('{"model":"bound-model"}');
    await expect(post(broker.socket,[bytes])).rejects.toBeDefined();expect(nativeRequest).toHaveBeenCalledOnce();
    expect(await post(broker.socket,[bytes])).toEqual({status:200,text:'recovered'});expect(check).toHaveBeenCalledTimes(3);
    expect(nativeRequest).toHaveBeenCalledTimes(2);expect(warn.mock.calls[0][0]).toEqual({event:'subscription_native_broker_failure',phase:'upstream_stream',body_bytes:bytes.length,status_class:'stream_aborted'});
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
  }finally{await broker.close();}
});

it('close aborts the active bound request and permanently closes its socket',async()=>{
  let started!:()=>void;const pending=new Promise<void>(resolve=>{started=resolve;});let signal:AbortSignal|undefined;
  const nativeRequest=vi.fn(async(_revision,_payload,abort:AbortSignal)=>{signal=abort;started();return await new Promise<never>((_resolve,reject)=>{abort.addEventListener('abort',()=>reject(new Error('synthetic-private-cancelled')),{once:true});});});
  const check=vi.fn(async()=>{}),broker=await createNativeSubscriptionBroker({root:tempDir(),revision:7,check,worker:{nativeRequest}});
  const result=post(broker.socket,[Buffer.from('{"model":"bound-model"}')]).catch(()=>null);
  await pending;await broker.close();await result;
  expect(signal?.aborted).toBe(true);await expect(post(broker.socket,[Buffer.from('{}')])).rejects.toBeDefined();expect(nativeRequest).toHaveBeenCalledOnce();
});

it('a disconnected native client aborts its upstream without poisoning the next request',async()=>{
  let started!:()=>void,aborted!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;}),stopped=new Promise<void>(resolve=>{aborted=resolve;});
  const nativeRequest=vi.fn().mockImplementationOnce(async(_revision,_payload,signal:AbortSignal)=>{
    started();return await new Promise<never>((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted();reject(new Error('synthetic-private-disconnect'));},{once:true});});
  }).mockResolvedValueOnce({contentType:'application/json',body:new Response('recovered').body!});
  const check=vi.fn(async()=>{}),broker=await createNativeSubscriptionBroker({root:tempDir(),revision:7,check,worker:{nativeRequest}});
  try{
    const call=request({socketPath:broker.socket,path:'/v1/messages',method:'POST'});call.on('error',()=>{});call.end('{"model":"bound-model"}');
    await began;call.destroy();await stopped;
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(await post(broker.socket,[Buffer.from('{"model":"bound-model"}')])).toEqual({status:200,text:'recovered'});
    expect(check).toHaveBeenCalledTimes(3);expect(nativeRequest).toHaveBeenCalledTimes(2);
  }finally{await broker.close();}
});
