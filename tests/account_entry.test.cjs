const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
function background(broken=false) {
    const listeners=[],stored={};
    let context;
    const chrome={runtime:{id:'sample-extension',getManifest:()=>JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')),getURL:p=>'chrome-extension://sample-extension/'+p,
        getContexts:async()=>[],onMessage:{addListener:fn=>listeners.push(fn)}},
        storage:{local:{get:async key=>({[key]:stored[key]}),set:async data=>Object.assign(stored,data)}}};
    context=vm.createContext({chrome,console,fetch:async()=>({ok:true,json:async()=>({model_ready:true})}),
        importScripts:(...names)=>names.forEach(name=>{if(broken && name.includes('monitor_background'))throw Error('Missing monitor module');vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context);})});
    vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
    return async(msg,sender={id:'sample-extension'})=>new Promise((resolve,reject)=>{
        let handled=false;
        const timer=setTimeout(()=>reject(Error('消息没有回复')),1000);
        const respond=value=>{clearTimeout(timer);handled=true;resolve(value);};
        const deferred=listeners.map(fn=>fn(msg,sender,respond)).some(value=>value===true);
        if(!deferred&&!handled){clearTimeout(timer);reject(Error('消息未被处理'));}
    });
}
test('实际 background.js 入口可回复新监控状态和版本握手',async()=>{
    const send=background();
    const status=await send({action:'extension_status'});assert.equal(status.monitorReady,true);
    const result=await send({target:'monitor-background',action:'state'});
    assert.equal(result.ok,true);assert.equal(result.state.authors.length,0);
});
test('没有 sender.id 的内部消息仍会回复，外部来源明确拒绝',async()=>{
    const send=background();
    assert.equal((await send({target:'monitor-background',action:'state'},{})).ok,true);
    assert.equal((await send({target:'monitor-background',action:'state'},{id:'other-extension'})).ok,false);
});
test('原有本地转写健康检测通道保持工作',async()=>{
    const send=background();const result=await send({action:'local_asr_health'});
    assert.equal(result.ok,true);assert.equal(result.data.model_ready,true);
});
test('关注模块加载失败有明确回复，且不拖垮原转写后台',async()=>{
    const send=background(true);
    assert.equal((await send({action:'extension_status'})).monitorReady,false);
    assert.match((await send({target:'monitor-background',action:'state'})).error,/Missing monitor module/);
    assert.equal((await send({action:'local_asr_health'})).ok,true);
});
function page(fetcher,links=[]) {
    const window={};
    const context=vm.createContext({window,URL,Set,Array,Object,Number,String,Error,JSON,AbortSignal,
        location:{origin:'https://www.douyin.com',pathname:'/user/self'},navigator:{language:'zh-CN',platform:'Win32'},screen:{width:1920,height:1080},
        performance:{getEntriesByType:()=>[]},document:{querySelectorAll:()=>links},fetch:fetcher});
    vm.runInContext(fs.readFileSync(path.join(root,'modules/douyin_page_api.js'),'utf8'),context);
    return window.__DcxzsPageApi__;
}
const response=data=>({ok:true,text:async()=>JSON.stringify(data)});
test('/user/self 通过自己资料接口解析真实 ID，不把 self 当 ID',async()=>{
    const api=page(async()=>response({status_code:0,user:{sec_uid:'MS4wOwn',nickname:'本人'}}));
    assert.equal(api.realId('self'),'');assert.equal((await api.identity()).sec_uid,'MS4wOwn');
});
test('自己资料失败时仅使用明确的我的链接，不能取其他作者链接',async()=>{
    const links=[{href:'https://www.douyin.com/user/other',textContent:'其他博主',getAttribute:()=>''},
        {href:'https://www.douyin.com/user/my-real-id',textContent:'我的',getAttribute:()=>''}];
    const api=page(async url=>url.includes('/self/')?response({status_code:1}):response({status_code:0,user:{sec_uid:'my-real-id'}}),links);
    assert.equal((await api.identity()).sec_uid,'my-real-id');
});
test('空响应和网页响应输出可读错误，不会无限等待或假定未登录',async()=>{
    const empty=page(async()=>({ok:true,text:async()=>''}));
    await assert.rejects(empty.request('following'),/空响应/);
    const html=page(async()=>({ok:true,text:async()=>'<html>login<\/html>'}));
    await assert.rejects(html.request('following'),/非 JSON/);
});
