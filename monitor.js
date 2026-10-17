'use strict';
const $ = id => document.getElementById(id);
let state = MonitorCore.emptyState();
let detailId = null;
const statusNames = { pending: '待转写', transcribing: '转写中', done: '已完成', failed: '失败', no_speech: '无人声', image: '图文' };
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
const count = value => value === null || value === undefined ? '-' : Number(value).toLocaleString('zh-CN');
async function send(action, extra = {}) {
    let result;
    try { result = await chrome.runtime.sendMessage({ target: 'monitor-background', action, ...extra }); }
    catch(error) { throw new Error('扩展后台连接失败，请在扩展管理页重新加载插件，并关闭后重新打开此页面。'+error.message); }
    if (!result) throw new Error('后台未加载关注采集模块。请在扩展管理页重新加载插件，再关闭此页面，从插件图标重新打开。');
    if (!result.ok) throw new Error(result.error || '后台返回了无效响应');
    return result;
}
function message(text) { $('message').hidden = !text; $('message').textContent = text || ''; }
async function command(action, extra = {}) {
    try { message(''); await send(action, extra); await load(); }
    catch(error) { message(error.message); }
}
function filtered() {
    const query = $('workSearch').value.trim().toLowerCase();
    return Object.values(state.records).filter(r => (!$('authorFilter').value || r.authorId === $('authorFilter').value) &&
        (!$('statusFilter').value || r.status === $('statusFilter').value) &&
        (!query || (r.title + r.authorName + r.transcript).toLowerCase().includes(query)))
        .sort((a,b) => b.publishedAt-a.publishedAt);
}
function renderAuthors() {
    const busy = state.run?.status === 'running';
    const query = $('authorSearch').value.trim().toLowerCase();
    $('selectedCount').textContent = state.authors.filter(a => a.selected).length + ' 位';
    $('authors').innerHTML = state.authors.filter(a => a.nickname.toLowerCase().includes(query)).map(a =>
        '<label class="author"><input type="checkbox" data-author="'+esc(a.secUid)+'" '+(a.selected?'checked ':'')+(busy?'disabled':'')+'>'+
        '<span class="avatar-fallback">'+esc(a.nickname.slice(0,1))+'</span><span class="author-info"><span class="author-name">'+esc(a.nickname)+'</span><small>'+esc(date(a.lastChecked))+'</small>'+
        (a.error?'<small class="error">'+esc(a.error)+'</small>':'')+'</span><a href="https://www.douyin.com/user/'+encodeURIComponent(a.secUid)+'" target="_blank" rel="noopener" title="打开博主主页">主页</a></label>').join('');
    $('authors').querySelectorAll('[data-author]').forEach(input => {
        input.onchange = () => {
            const ids = new Set(state.authors.filter(a=>a.selected).map(a=>a.secUid));
            input.checked ? ids.add(input.dataset.author) : ids.delete(input.dataset.author);
            command('select', { ids: Array.from(ids) });
        };
    });
}
function render() {
    const busy = state.run?.status === 'running';
    $('owner').textContent = state.owner ? state.owner.nickname : '未同步账号';
    $('runStatus').textContent = state.run?.message || '等待采集';
    ['start','retry','sync','selectAll','selectNone','clear'].forEach(id => { $(id).disabled = busy; });
    $('addForm').querySelectorAll('input,button').forEach(e=>{ e.disabled=busy; });
    $('stop').hidden = !busy;
    const sync = state.followingSync;
    $('coverage').textContent = sync ? (sync.complete?'同步完成':'可能不完整')+' · '+sync.count+'/'+(Number.isFinite(sync.expected)?sync.expected:'未知')+' 位 · '+date(sync.at) : '尚未同步关注列表';
    $('coverage').classList.toggle('warning', !!sync && !sync.complete);
    renderAuthors();
    const authorFilter = $('authorFilter').value;
    $('authorFilter').innerHTML = '<option value="">全部博主</option>'+state.authors.map(a=>'<option value="'+esc(a.secUid)+'">'+esc(a.nickname)+'</option>').join('');
    $('authorFilter').value = authorFilter;
    const rows = Object.values(state.records);
    $('total').textContent = rows.length;
    $('done').textContent = rows.filter(r=>r.status==='done').length;
    $('pending').textContent = rows.filter(r=>['pending','transcribing'].includes(r.status)).length;
    $('failed').textContent = rows.filter(r=>r.status==='failed').length;
    renderWorks();
    if (detailId && $('detail').open) showDetail(detailId);
}
function renderWorks() {
    const rows = filtered();
    $('empty').hidden = !!rows.length;
    $('empty').querySelector('h2').textContent = Object.keys(state.records).length ? '没有匹配作品' : '还没有采集结果';
    $('works').innerHTML = rows.map(r=>'<tr><td><button class="work-main" data-work="'+esc(r.id)+'" style="border:0;background:transparent;padding:0;text-align:left;white-space:normal;width:100%">'+
        (r.cover && /^https:\/\//.test(r.cover)?'<img class="cover" loading="lazy" referrerpolicy="no-referrer" src="'+esc(r.cover)+'" alt="作品封面">':'<span class="cover"></span>')+
        '<span><span class="work-title">'+esc(r.title||'无标题')+'</span><small>'+esc(r.authorName)+' · '+(r.type==='image'?'图文':'视频')+'</small></span></button></td><td>'+esc(date(r.publishedAt))+'</td>'+['likes','comments','collects','shares'].map(key=>'<td>'+count(r[key])+'</td>').join('')+
        '<td><button class="status '+esc(r.status)+'" data-work="'+esc(r.id)+'">'+esc(statusNames[r.status]||r.status)+'</button></td></tr>').join('');
    $('works').querySelectorAll('[data-work]').forEach(button=>{ button.onclick=()=>showDetail(button.dataset.work); });
}
function showDetail(id) {
    const r=state.records[id]; if(!r)return;
    detailId=id;
    $('detailTitle').textContent=r.title||'无标题';
    $('detailMeta').textContent=r.authorName+' · '+date(r.publishedAt)+' · '+statusNames[r.status];
    $('videoLink').href=r.url;
    $('transcript').textContent=r.transcript || (r.type==='image'?r.title:'暂无口播稿');
    $('copyText').disabled=!r.transcript && r.type!=='image';
    $('detailError').textContent=r.error||'';
    if(!$('detail').open)$('detail').showModal();
}
function exportData(format) {
    const rows=MonitorCore.exportRows(filtered());
    if(!rows.length){message('没有可导出的结果');return;}
    let content, mime;
    if(format==='json'){content=JSON.stringify({export_time:new Date().toISOString(),account:state.owner?.nickname,following_sync:state.followingSync,list:rows},null,2);mime='application/json';}
    else if(format==='csv'){
        const headers=['博主','作品ID','标题','类型','发布时间','作品链接','点赞','评论','收藏','分享','采集时间','转写状态','口播稿','错误'];
        content='\uFEFF'+[headers.map(MonitorCore.escapeCsv).join(','),...rows.map(r=>Object.entries(r).map(([key,value])=>MonitorCore.escapeCsv(key==='aweme_id'?'\t'+value:key==='status'?(statusNames[value]||value):value)).join(','))].join('\r\n');mime='text/csv;charset=utf-8';
    }else{
        const names={author:'博主',aweme_id:'作品ID',title:'标题',type:'类型',published_at:'发布时间',url:'作品链接',likes:'点赞',comments:'评论',collects:'收藏',shares:'分享',collected_at:'采集时间',status:'转写状态',transcript:'口播稿',error:'错误'};
        content=rows.map(r=>Object.entries(r).map(([key,value])=>names[key]+': '+(key==='status'?(statusNames[value]||value):(value??''))).join('\n')).join('\n\n----------------\n\n');mime='text/plain;charset=utf-8';
    }
    const url=URL.createObjectURL(new Blob([content],{type:mime}));
    const a=document.createElement('a');a.href=url;a.download='关注博主更新_'+new Date().toISOString().slice(0,10)+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function load(){state=(await send('state')).state;render();}
$('sync').onclick=()=>command('sync');
$('start').onclick=()=>command('start',{autoTranscribe:$('autoTranscribe').checked});
$('retry').onclick=()=>command('retry');
$('stop').onclick=()=>command('stop');
$('addForm').onsubmit=event=>{event.preventDefault();command('add',{url:$('authorUrl').value.trim()});};
$('authorSearch').oninput=renderAuthors;
['workSearch','authorFilter','statusFilter'].forEach(id=>{$(id).addEventListener(id==='workSearch'?'input':'change',renderWorks);});
['selectAll','selectNone'].forEach(id=>{$(id).onclick=()=>{
    const query=$('authorSearch').value.trim().toLowerCase();
    const ids=state.authors.filter(a=>a.nickname.toLowerCase().includes(query)?id==='selectAll':a.selected).map(a=>a.secUid);
    command('select',{ids});
};});
$('clear').onclick=()=>{if(confirm('清理所有已保存结果？博主选择、检查时间和去重记录会保留；已清理的口播稿需从导出文件查看。'))command('clear');};
$('closeDetail').onclick=()=>{$('detail').close();detailId=null;};
$('copyText').onclick=async()=>{try{await navigator.clipboard.writeText($('transcript').textContent);$('copyText').textContent='已复制';setTimeout(()=>{$('copyText').textContent='复制文稿';},1500);}catch{message('复制失败，请选中文稿复制');}};
document.querySelectorAll('[data-export]').forEach(button=>{button.onclick=()=>exportData(button.dataset.export);});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.dcxzs_monitor_v1){state=changes.dcxzs_monitor_v1.newValue||MonitorCore.emptyState();render();}});
chrome.runtime.sendMessage({action:'local_asr_health'}).then(result=>{$('service').textContent=result?.ok?(result.data.model_ready?'本地转写已就绪':'本地模型未就绪'):'本地伴侣未启动 · 可先采集数据';}).catch(()=>{$('service').textContent='本地伴侣未启动';});
(async function initialize() {
    try {
        const status = await chrome.runtime.sendMessage({action:'extension_status'});
        if (!status?.monitorReady) throw new Error(status?.moduleError ? '后台模块加载失败：'+status.moduleError : '后台仍是旧版本或采集模块未加载。请在扩展管理页重新加载插件，关闭旧的关注页面，再从插件图标打开。');
        if (status.version !== '1.10.3') throw new Error('页面与后台版本不一致，请关闭本页面后从插件图标重新打开。后台版本：'+status.version);
        await load();
    } catch(error) { message(error.message); }
})();
