const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Core = require('../modules/monitor_core.js');
const work = (id,time,likes=2) => ({ aweme_id:id, create_time:time, desc:'口播 '+id, statistics:{digg_count:likes,comment_count:1,share_count:0,collect_count:0},video:{play_addr:{url_list:['https://v.douyinvod.com/'+id]}} });
test('首次只取最近三条，置顶旧作品不占名额，重复作品去重',()=>{
    const s=Core.emptyState(), a={secUid:'a',nickname:'博主'};
    assert.equal(Core.mergeWorks(s,a,[work('old',1),work('4',400),work('2',200),work('3',300),work('4',400)],500000),3);
    assert.deepEqual(Object.keys(s.records).sort(),['2','3','4']);
});
test('增量检查保留已转写稿，刷新互动；清理结果后去重记录仍生效',()=>{
    const s=Core.emptyState(),a={secUid:'a',nickname:'博主'};
    Core.mergeWorks(s,a,[work('1',100)],200000);
    s.records['1'].status='done';s.records['1'].transcript='保留原稿';
    Core.mergeWorks(s,a,[work('1',100,99),work('2',250)],300000);
    assert.equal(s.records['1'].likes,99);assert.equal(s.records['1'].transcript,'保留原稿');assert.equal(s.records['1'].status,'done');
    s.records={};Core.mergeWorks(s,a,[work('2',250),work('3',350)],400000);
    assert.deepEqual(Object.keys(s.records),['3']);
});
test('导出保留长文稿、空值和精确 ID，CSV 防公式注入',()=>{
    const s=Core.emptyState(),a={secUid:'a',nickname:'博主'};
    Core.mergeWorks(s,a,[work('7640000000000000001',100)],200000);
    const r=Object.values(s.records)[0];r.transcript='长文稿\n'.repeat(10000);r.comments=null;
    const row=Core.exportRows([r])[0];assert.equal(row.aweme_id,'7640000000000000001');assert.equal(row.transcript,r.transcript);assert.equal(row.comments,null);
    assert.equal(Core.escapeCsv('=SUM(1,2)'), '"\'=SUM(1,2)"');assert.equal(Core.escapeCsv('a"b\nc'),'"a""b\nc"');
});
async function execute(kind,state,responder,fetcher) {
    let doneResolve;const finished=new Promise(resolve=>doneResolve=resolve);
    let saved=structuredClone(state);
    const context=vm.createContext({console,AbortController,AbortSignal,Date,Set,Map,Number,String,Array,Object,Promise,Error,
        fetch:fetcher||(async()=>{throw Error('服务未启动');}), setTimeout:fn=>{queueMicrotask(fn);},
        importScripts:()=>{},MonitorCore:Core,postMessage:msg=>{
            if(msg.type==='done'){doneResolve();return;}
            Promise.resolve().then(async()=>{
                let result;
                try{
                    if(msg.payload.action==='state')result={ok:true,state:structuredClone(saved)};
                    else if(msg.payload.action==='worker-save'){saved=structuredClone(msg.payload.state);result={ok:true};}
                    else result={ok:true,data:await responder(msg.payload)};
                }catch(e){result={ok:false,error:e.message};}
                context.onmessage({data:{type:'rpc-result',id:msg.id,result}});
            });
        }});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../monitor_worker.js'),'utf8'),context);
    context.onmessage({data:{type:'run',kind,autoTranscribe:true}});
    await finished;return saved;
}
test('关注列表多页去重，数量不匹配明确标记不完整',async()=>{
    const s=Core.emptyState();s.owner={secUid:'me',uid:'1',followingCount:3};s.run={status:'running',checked:0,added:0};
    let pages=0;
    const saved=await execute('sync',s,()=>++pages===1?{followings:[{sec_uid:'a',nickname:'A'}],has_more:1,offset:1,min_time:2}:{followings:[{sec_uid:'a',nickname:'A'},{sec_uid:'b',nickname:'B'}],has_more:0});
    assert.equal(pages,2);assert.equal(saved.authors.length,2);assert.equal(saved.followingSync.complete,false);
});
test('分页失败不推进检查时间，成功的其他博主仍采集；伴侣离线保留待转写',async()=>{
    const s=Core.emptyState();s.owner={secUid:'me'};s.authors=[{secUid:'a',nickname:'A',selected:true,lastChecked:1000,seen:[]},{secUid:'b',nickname:'B',selected:true,seen:[]}];s.run={status:'running',checked:0,added:0};
    const saved=await execute('start',s,msg=>{if(msg.args.sec_user_id==='a')return{aweme_list:[work('bad',2)],has_more:1,max_cursor:0};return{aweme_list:[work('good',4)],has_more:0};});
    assert.equal(saved.authors[0].lastChecked,1000);assert.ok(saved.authors[0].error);assert.equal(saved.records.good.status,'pending');assert.equal(saved.run.status,'partial');
});
test('缺少关注总数时不能声明完整，正常完整数量才通过',async()=>{
    const s=Core.emptyState();s.owner={secUid:'me',uid:'1'};s.run={status:'running',checked:0,added:0};
    const data={followings:[{sec_uid:'a',nickname:'A'}],has_more:0};
    const unknown=await execute('sync',s,()=>data);
    assert.equal(unknown.followingSync.complete,false);
    s.owner.followingCount=1;
    const complete=await execute('sync',s,()=>data);
    assert.equal(complete.followingSync.complete,true);
});
test('关注分页后续失败仍保留已读取的博主且不标记完成',async()=>{
    const s=Core.emptyState();s.owner={secUid:'me',uid:'1',followingCount:2};s.run={status:'running',checked:0,added:0};
    let pages=0;
    const saved=await execute('sync',s,()=>{if(++pages===1)return{followings:[{sec_uid:'a',nickname:'A'}],has_more:1,offset:1,min_time:2};throw Error('登录失效');});
    assert.equal(saved.authors.length,1);assert.equal(saved.followingSync.complete,false);assert.equal(saved.run.status,'failed');
});
test('转写地址失败自动切换，已完成稿不重复转写',async()=>{
    const s=Core.emptyState();s.run={status:'running',checked:0,added:0};s.records={a:{id:'a',authorName:'A',title:'标题',type:'video',status:'pending',urls:['https://bad','https://good']},b:{id:'b',type:'video',status:'done',transcript:'原稿'}};
    let calls=0;
    const saved=await execute('retry',s,()=>{},async(url,options)=>{
        if(url.endsWith('/health'))return{ok:true,json:async()=>({model_ready:true})};
        calls++;const body=JSON.parse(options.body);
        return body.video_url==='https://bad'?{ok:false,json:async()=>({detail:'403'})}:{ok:true,json:async()=>({status:'succeeded',text:'新的文稿'})};
    });
    assert.equal(calls,2);assert.equal(saved.records.a.status,'done');assert.equal(saved.records.a.transcript,'新的文稿');assert.equal(saved.records.b.transcript,'原稿');
});
test('首次三条在时间游标越过第三条后只请求一页，旧置顶不占名额',async()=>{
    const now=Math.floor(Date.now()/1000);
    const s=Core.emptyState();s.owner={secUid:'me'};s.authors=[{secUid:'a',nickname:'A',selected:true,seen:[]}];s.run={status:'running',checked:0,added:0};
    let requests=0;
    const saved=await execute('start',s,()=>{requests++;return{aweme_list:[{...work('pin',now-100000),is_top:1},work('1',now-1),work('2',now-2),work('3',now-3),work('4',now-4)],has_more:1,max_cursor:(now-4)*1000};});
    assert.equal(requests,1);assert.deepEqual(Object.keys(saved.records).sort(),['1','2','3']);assert.equal(saved.authors[0].lastPageCount,1);
});
test('增量跨两页到检查时间边界就停止，不继续历史页',async()=>{
    const now=Math.floor(Date.now()/1000);
    const s=Core.emptyState();s.owner={secUid:'me'};s.authors=[{secUid:'a',nickname:'A',selected:true,seen:[],lastChecked:(now-100)*1000}];s.run={status:'running',checked:0,added:0};
    let requests=0;
    const saved=await execute('start',s,()=>++requests===1?{aweme_list:[work('1',now-5),work('2',now-50)],has_more:1,max_cursor:(now-50)*1000}:{aweme_list:[work('3',now-90),work('old',now-150)],has_more:1,max_cursor:(now-150)*1000});
    assert.equal(requests,2);assert.deepEqual(Object.keys(saved.records).sort(),['1','2','3']);
});
test('顺序异常时不提前结束，未知游标也继续完整分页',async()=>{
    const now=Math.floor(Date.now()/1000);
    const s=Core.emptyState();s.owner={secUid:'me'};s.authors=[{secUid:'a',nickname:'A',selected:true,seen:[]}];s.run={status:'running',checked:0,added:0};
    let requests=0;
    const saved=await execute('start',s,()=>++requests===1?{aweme_list:[work('old',now-1000),work('1',now-20),work('2',now-30),work('3',now-40)],has_more:1,max_cursor:(now-1000)*1000}:{aweme_list:[work('latest',now-1)],has_more:0});
    assert.equal(requests,2);assert.ok(saved.records.latest);
    assert.equal(Core.pageBoundary([work('x',now)],'opaque',0,null).safe,false);
});
test('手动重试先取新地址，已完成稿不触发详情或转写',async()=>{
    const s=Core.emptyState();s.run={status:'running',checked:0,added:0};s.records={a:{id:'a',authorId:'author',authorName:'A',title:'标题',type:'video',status:'failed',urls:['https://expired']},b:{id:'b',type:'video',status:'done',transcript:'原稿'}};
    const used=[];let details=0;
    const saved=await execute('retry',s,msg=>{assert.equal(msg.kind,'detail');assert.equal(msg.args.aweme_id,'a');details++;return{aweme_detail:{...work('a',100),author:{sec_uid:'author'},video:{play_addr:{url_list:['https://fresh']}}}};},async(url,options)=>{
        if(url.endsWith('/health'))return{ok:true,json:async()=>({model_ready:true})};
        used.push(JSON.parse(options.body).video_url);return{ok:true,json:async()=>({status:'succeeded',text:'新文稿'})};
    });
    assert.equal(details,1);assert.deepEqual(used,['https://fresh']);assert.equal(saved.records.a.status,'done');assert.equal(saved.records.b.transcript,'原稿');
});
test('自动采集转写下载失败后最多刷新一次再重试',async()=>{
    const s=Core.emptyState();s.owner={secUid:'me'};s.authors=[{secUid:'author',nickname:'A',selected:true,seen:[]}];s.run={status:'running',checked:0,added:0};
    const used=[];let details=0;
    const saved=await execute('start',s,msg=>{
        if(msg.kind==='works')return{aweme_list:[{...work('a',100),video:{play_addr:{url_list:['https://expired']}}}],has_more:0};
        details++;return{aweme_detail:{...work('a',100),video:{play_addr:{url_list:['https://fresh']}}}};
    },async(url,options)=>{
        if(url.endsWith('/health'))return{ok:true,json:async()=>({model_ready:true})};
        const video=JSON.parse(options.body).video_url;used.push(video);
        return video==='https://expired'?{ok:false,status:502,json:async()=>({detail:'视频下载失败: 403'})}:{ok:true,json:async()=>({status:'succeeded',text:'恢复成功'})};
    });
    assert.equal(details,1);assert.deepEqual(used,['https://expired','https://fresh']);assert.equal(saved.records.a.transcript,'恢复成功');
});
test('详情错误不覆盖地址，刷新失败不会修改博主成功检查时间',async()=>{
    const s=Core.emptyState();s.authors=[{secUid:'author',lastChecked:1000}];s.run={status:'running',checked:0,added:0};s.records={a:{id:'a',authorId:'author',authorName:'A',title:'标题',type:'video',status:'failed',urls:['https://old']}};
    const saved=await execute('retry',s,()=>({aweme_detail:{...work('other',100),video:{play_addr:{url_list:['https://wrong']}}}}),async(url)=>url.endsWith('/health')?{ok:true,json:async()=>({model_ready:true})}:{ok:false,status:502,json:async()=>({detail:'403'})});
    assert.deepEqual(saved.records.a.urls,['https://old']);assert.match(saved.records.a.error,/ID 不匹配/);assert.equal(saved.authors[0].lastChecked,1000);
});
test('刷新后的链接仍失败时不会无限刷新或重复转写',async()=>{
    const s=Core.emptyState();s.owner={secUid:'me'};s.authors=[{secUid:'author',nickname:'A',selected:true,seen:[]}];s.run={status:'running',checked:0,added:0};
    let details=0,attempts=0;
    const saved=await execute('start',s,msg=>{
        if(msg.kind==='works')return{aweme_list:[{...work('a',100),video:{play_addr:{url_list:['https://expired']}}}],has_more:0};
        details++;return{aweme_detail:{...work('a',100),video:{play_addr:{url_list:['https://fresh-but-unavailable']}}}};
    },async(url)=>{
        if(url.endsWith('/health'))return{ok:true,json:async()=>({model_ready:true})};
        attempts++;return{ok:false,status:502,json:async()=>({detail:'视频下载失败: 403'})};
    });
    assert.equal(details,1);assert.equal(attempts,2);assert.equal(saved.records.a.status,'failed');
});
