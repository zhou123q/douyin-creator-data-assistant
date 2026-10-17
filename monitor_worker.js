importScripts('modules/monitor_core.js');
let rpcId = 0;
const waiting = new Map();
let stopped = false;
let aborter = null;
function rpc(payload) {
    return new Promise((resolve,reject) => {
        const id = ++rpcId;
        waiting.set(id, { resolve, reject });
        postMessage({ type: 'rpc', id, payload });
    });
}
const page = (kind,args) => rpc({ action: 'page', kind, args }).then(r => r.data);
const save = state => rpc({ action: 'worker-save', state });
const delay = () => new Promise(resolve => setTimeout(resolve, 900));
function checkStop() { if (stopped) throw new Error('任务已停止'); }

async function syncFollowing(state) {
    const users = new Map();
    const cursors = new Set();
    let offset = 0, maxTime = Math.floor(Date.now()/1000), complete = false;
    state.followingSync = { at: Date.now(), count: 0, expected: state.owner.followingCount, complete: false };
    await save(state);
    for (let index = 0; index < 500; index++) {
        checkStop();
        const data = await page('following', { sec_user_id: state.owner.secUid, user_id: state.owner.uid,
            count: 20, offset, max_time: maxTime, min_time: 0 });
        const list = data.followings || data.user_list;
        if (!Array.isArray(list) || typeof data.has_more === 'undefined') throw new Error('关注接口格式异常，无法确认完整列表');
        list.forEach(user => {
            if (user.sec_uid) users.set(String(user.sec_uid), { secUid: String(user.sec_uid), nickname: String(user.nickname || '未知博主'),
                avatar: user.avatar_thumb?.url_list?.[0] || '', source: 'following' });
        });
        const previous = new Map(state.authors.map(a => [a.secUid,a]));
        users.forEach(user => previous.set(user.secUid, { selected: false, lastChecked: null, seen: [], ...previous.get(user.secUid), ...user }));
        state.authors = Array.from(previous.values());
        state.followingSync.count = users.size;
        state.run.message = '正在同步关注 · 已读取 ' + users.size + ' 位';
        await save(state);
        if (!data.has_more) { complete = true; break; }
        offset = Number(data.offset ?? offset + list.length);
        maxTime = Number(data.min_time ?? maxTime);
        const key = offset + ':' + maxTime;
        if (!list.length || cursors.has(key)) throw new Error('关注列表分页中断，已保存读到的博主，请稍后重新同步');
        cursors.add(key);
        await delay();
    }
    const previous = new Map(state.authors.map(a => [a.secUid,a]));
    users.forEach(user => previous.set(user.secUid, { selected: false, lastChecked: null, seen: [], ...previous.get(user.secUid), ...user }));
    state.authors = Array.from(previous.values());
    const expected = state.owner.followingCount;
    state.followingSync = { at: Date.now(), count: users.size, expected, complete: complete && Number.isFinite(expected) && users.size === expected };
    if (!complete) throw new Error('关注分页达到上限，列表未完整，请稍后重试');
    state.run.message = state.followingSync.complete ? '关注同步完成 · ' + users.size + ' 位' :
        '关注列表可能不完整：读取 ' + users.size + ' 位，账号显示 ' + (Number.isFinite(expected) ? expected : '未知') + ' 位；可重试或手动补充链接';
}
async function collectAuthor(state, author) {
    const items = new Map();
    const cursors = new Set(['0']);
    let cursor = 0, complete = false;
    let chronological = true, oldest = null, pages = 0;
    const checkedAt = Date.now();
    for (let index = 0; index < 500; index++) {
        checkStop();
        const data = await page('works', { sec_user_id: author.secUid, max_cursor: cursor, count: 35 });
        if (!Array.isArray(data.aweme_list) || typeof data.has_more === 'undefined') throw new Error('作品响应不完整，未更新检查时间');
        data.aweme_list.forEach(item => { if (item.aweme_id) items.set(String(item.aweme_id),item); });
        pages++;
        state.run.message = '正在检查 · '+author.nickname+' · 第 '+pages+' 页';
        if (!data.has_more) { complete = true; break; }
        const boundary=MonitorCore.pageBoundary(data.aweme_list,data.max_cursor,cursor,oldest);
        chronological=chronological && boundary.safe;
        oldest=boundary.oldest;
        if (chronological && MonitorCore.canFinishRecent(items,author,boundary.boundary)) { complete=true;break; }
        cursor = data.max_cursor;
        if (cursor === undefined || cursors.has(String(cursor))) throw new Error('作品分页中断，未更新检查时间');
        cursors.add(String(cursor));
        await delay();
    }
    if (!complete) throw new Error('作品分页达到上限，未更新检查时间');
    author.lastPageCount=pages;
    return MonitorCore.mergeWorks(state, author, Array.from(items.values()), checkedAt);
}
async function refreshVideoAddresses(row) {
    const data=await page('detail',{aweme_id:row.id});
    checkStop();
    const detail=data?.aweme_detail;
    if (!detail) throw new Error('无法读取最新作品详情，作品可能已删除或不可访问');
    if (String(detail.aweme_id)!==row.id) throw new Error('作品详情 ID 不匹配，未更新视频地址');
    if (row.authorId && detail.author?.sec_uid && detail.author.sec_uid!==row.authorId) throw new Error('作品作者不匹配，未更新视频地址');
    const urls=MonitorCore.mediaUrls(detail);
    if (!urls.length) throw new Error('作品详情没有可用的视频地址');
    row.urls=urls;
    row.addressRefreshedAt=Date.now();
    if (detail.statistics) {
        const fields={likes:'digg_count',comments:'comment_count',collects:'collect_count',shares:'share_count'};
        Object.entries(fields).forEach(([field,key])=>{
            const value=detail.statistics[key];
            if (value!==undefined && value!==null && Number.isFinite(Number(value)) && Number(value)>=0) row[field]=Number(value);
        });
    }
}
async function transcribe(state,refreshBeforeRetry=false) {
    const rows = Object.values(state.records).filter(r => r.type === 'video' && ['pending','failed','transcribing'].includes(r.status));
    if (!rows.length) return;
    try {
        const response = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('本地伴侣健康检查失败');
        const health = await response.json();
        if (!health.model_ready) throw new Error('本地转写模型未就绪');
    } catch(error) {
        rows.forEach(row => { row.status = 'pending'; row.error = '请启动本地伴侣并准备模型，随后点击继续转写'; });
        await save(state);
        return;
    }
    for (const row of rows) {
        checkStop();
        row.status = 'transcribing'; row.error = '';
        state.run.message = '正在转写 · ' + row.authorName + ' · ' + row.title.slice(0,30);
        await save(state);
        let success = false, lastError = '作品没有可用视频地址';
        let refreshed=false,refreshError='',refreshable=false;
        if (refreshBeforeRetry || !row.urls?.length) {
            state.run.message='正在刷新视频地址 · '+row.authorName;
            await save(state);
            try { await refreshVideoAddresses(row); } catch(error) { if(stopped)throw error;refreshError=error.message; }
            refreshed=true;
        }
        for (let round=0;round<2 && !success;round++) {
          refreshable=false;
          for (const url of row.urls || []) {
            checkStop();
            try {
                aborter = new AbortController();
                const response = await fetch('http://127.0.0.1:8765/api/transcribe', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: aborter.signal,
                    body: JSON.stringify({ video_url: url, video_id: row.id })
                });
                const data = await response.json();
                if (!response.ok) {
                    refreshable=refreshable || response.status===502 || /视频下载|403|404|过期|expired/i.test(data.detail||'');
                    throw new Error(data.detail || '转写失败 HTTP ' + response.status);
                }
                if (!['succeeded','no_speech'].includes(data.status)) throw new Error('转写返回状态异常');
                row.transcript = data.text || '';
                row.status = data.status === 'no_speech' ? 'no_speech' : 'done';
                row.error = ''; success = true; break;
            } catch(error) { lastError = error.message; }
            finally { aborter = null; }
          }
          if (success || stopped || refreshed || !refreshable) break;
          state.run.message='下载失败，正在刷新视频地址 · '+row.authorName;
          await save(state);
          try { await refreshVideoAddresses(row); }
          catch(error) { if(stopped)throw error;refreshError=error.message;break; }
          refreshed=true;
        }
        row.status = success ? row.status : (stopped ? 'pending' : 'failed');
        if (!success) row.error = lastError+(refreshError?'；地址刷新失败：'+refreshError:'');
        await save(state);
    }
}
async function run(msg) {
    stopped = false;
    let state;
    try {
        state = (await rpc({ action: 'state' })).state;
        state.run.status = 'running';
        if (msg.kind === 'sync') await syncFollowing(state);
        if (msg.kind === 'start') {
            const authors = state.authors.filter(a => a.selected);
            for (const author of authors) {
                checkStop();
                state.run.message = '正在检查 · ' + author.nickname;
                await save(state);
                try { state.run.added += await collectAuthor(state,author); }
                catch(error) { if (stopped) throw error; author.error = error.message; }
                state.run.checked++;
                await save(state);
                await delay();
            }
        }
        if (msg.kind === 'retry' || (msg.kind === 'start' && msg.autoTranscribe)) await transcribe(state,msg.kind==='retry');
        state.run.status = msg.kind === 'start' && state.authors.some(a => a.selected && a.error) ? 'partial' : 'completed';
        if (msg.kind !== 'sync') state.run.message = '采集结束 · 检查 ' + state.run.checked + ' 位 · 新增 ' + state.run.added + ' 条';
    } catch(error) {
        if (state) { state.run.status = stopped ? 'stopped' : 'failed'; state.run.message = error.message; }
    } finally {
        if (state) {
            Object.values(state.records).forEach(r => { if (r.status === 'transcribing') r.status = 'pending'; });
            state.run.finishedAt = Date.now();
            await save(state).catch(() => {});
        }
        postMessage({ type: 'done' });
    }
}
onmessage = event => {
    const msg = event.data;
    if (msg.type === 'rpc-result') {
        const entry = waiting.get(msg.id);
        if (!entry) return;
        waiting.delete(msg.id);
        msg.result?.ok ? entry.resolve(msg.result) : entry.reject(new Error(msg.result?.error || '后台请求失败'));
    } else if (msg.type === 'stop') { stopped = true; aborter?.abort(); }
    else if (msg.type === 'run') run(msg);
};
