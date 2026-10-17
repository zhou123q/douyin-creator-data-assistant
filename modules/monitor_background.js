const MONITOR_KEY = 'dcxzs_monitor_v1';
let monitorCreating = null;
let monitorMutation = false;

async function monitorState() {
    return (await chrome.storage.local.get(MONITOR_KEY))[MONITOR_KEY] || MonitorCore.emptyState();
}
async function monitorSave(state) {
    await chrome.storage.local.set({ [MONITOR_KEY]: state });
}
async function monitorDocument() {
    const url = chrome.runtime.getURL('monitor_offscreen.html');
    if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length) return;
    if (!monitorCreating) monitorCreating = chrome.offscreen.createDocument({
        url: 'monitor_offscreen.html', reasons: ['WORKERS'],
        justification: 'Run the user-started collection and transcription worker after the results tab closes.'
    }).finally(() => { monitorCreating = null; });
    await monitorCreating;
}
async function monitorBusy() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) return false;
    const answer = await chrome.runtime.sendMessage({ target: 'monitor-offscreen', action: 'status' }).catch(() => null);
    return !!answer?.busy;
}
async function monitorPageRequest(kind, args = {}) {
    const tabs = await chrome.tabs.query({ url: 'https://www.douyin.com/*' });
    const tab = tabs.find(t => t.active) || tabs[0];
    if (!tab) throw new Error('请打开抖音网页版并登录，再重试');
    await chrome.scripting.executeScript({ target:{tabId:tab.id},world:'MAIN',files:['modules/douyin_page_api.js'] });
    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', args: [kind, args],
        func: async function(kind, args) {
            try {
                const api = window.__DcxzsPageApi__;
                if (!api) throw new Error('抖音页面请求模块未加载，请刷新抖音页');
                const data = kind === 'identity' ? {user:await api.identity()} : await api.request(kind,args);
                return { ok: true, data };
            } catch(error) { return { ok: false, error: error.message }; }
        }
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || '抖音标签页已关闭或无法读取');
    return result.data;
}
async function monitorIdentity() {
    const data = await monitorPageRequest('identity');
    if (!data.user?.sec_uid) throw new Error('无法确认登录账号，请重新登录抖音');
    const owner = { secUid: String(data.user.sec_uid), uid: String(data.user.uid || ''),
        nickname: String(data.user.nickname || ''), followingCount: Number(data.user.following_count) };
    const state = await monitorState();
    if (state.owner && state.owner.secUid !== owner.secUid) throw new Error('登录账号已切换，请回到原账号再同步，避免混入其他账号的关注列表');
    state.owner = owner;
    await monitorSave(state);
    return owner;
}
async function monitorHandle(msg) {
    if (msg.action === 'state') {
        const state = await monitorState();
        if (state.run?.status === 'running' && !(await monitorBusy())) {
            state.run.status = 'interrupted';
            state.run.message = '任务已中断，可点击继续转写或重新采集';
            Object.values(state.records).forEach(r => { if (r.status === 'transcribing') r.status = 'pending'; });
            await monitorSave(state);
        }
        return { state };
    }
    if (msg.action === 'worker-save') { await monitorSave(msg.state); return {}; }
    if (msg.action === 'page') return { data: await monitorPageRequest(msg.kind, msg.args) };
    if (msg.action === 'identity') return { owner: await monitorIdentity() };
    if (msg.action === 'open') { await chrome.tabs.create({ url: chrome.runtime.getURL('monitor.html') }); return {}; }
    if (msg.action === 'select') {
        if (await monitorBusy()) throw new Error('任务运行中，请先停止再修改博主');
        const state = await monitorState();
        state.authors.forEach(a => { a.selected = (msg.ids || []).includes(a.secUid); });
        await monitorSave(state);
        return { state };
    }
    if (msg.action === 'add') {
        if (await monitorBusy()) throw new Error('任务运行中，请先停止再添加博主');
        const match = String(msg.url || '').match(/^https:\/\/www\.douyin\.com\/user\/([\w.-]+)(?:[/?#]|$)/);
        if (!match) throw new Error('请输入完整的抖音博主主页链接');
        await monitorIdentity();
        const data = await monitorPageRequest('profile', { sec_user_id: match[1] });
        if (!data.user?.sec_uid) throw new Error('无法读取该博主资料');
        const state = await monitorState();
        const exists = state.authors.find(a => a.secUid === data.user.sec_uid);
        if (exists) exists.selected = true;
        else state.authors.push({ secUid: data.user.sec_uid, nickname: data.user.nickname || '未知博主',
            avatar: data.user.avatar_thumb?.url_list?.[0] || '', selected: true, lastChecked: null, seen: [], source: 'manual' });
        await monitorSave(state);
        return { state };
    }
    if (msg.action === 'clear') {
        if (await monitorBusy()) throw new Error('请先停止任务再清理');
        const state = await monitorState();
        state.records = {};
        await monitorSave(state);
        return { state };
    }
    if (msg.action === 'start' || msg.action === 'sync' || msg.action === 'retry') {
        if (await monitorBusy()) throw new Error('已有任务正在运行');
        if (msg.action !== 'retry') await monitorIdentity();
        const state = await monitorState();
        if (msg.action === 'start' && !state.authors.some(a => a.selected)) throw new Error('请先选择博主');
        state.run = { status: 'running', kind: msg.action, startedAt: Date.now(), message: '准备中', checked: 0, added: 0 };
        await monitorSave(state);
        try {
            await monitorDocument();
            const result = await chrome.runtime.sendMessage({ target: 'monitor-offscreen', action: 'run', kind: msg.action, autoTranscribe: msg.autoTranscribe !== false });
            if (!result?.ok) throw new Error('后台队列未启动，请重试');
        } catch(error) {
            state.run.status = 'failed';
            state.run.message = error.message;
            await monitorSave(state);
            throw error;
        }
        return {};
    }
    if (msg.action === 'stop') {
        if (await monitorBusy()) await chrome.runtime.sendMessage({ target: 'monitor-offscreen', action: 'stop' });
        return {};
    }
    throw new Error('未知采集操作');
}
function handleMonitorMessage(msg, sender, respond) {
    if (sender.id && sender.id !== chrome.runtime.id) { respond({ok:false,error:'消息来源不属于当前扩展'});return; }
    const mutates = ['start','sync','retry','select','add','clear'].includes(msg.action);
    if (mutates && monitorMutation) { respond({ ok: false, error: '正在处理另一个操作，请稍后再试' }); return; }
    if (mutates) monitorMutation = true;
    monitorHandle(msg).then(data => respond({ ok: true, ...data })).catch(error => respond({ ok: false, error: error.message }))
        .finally(() => { if (mutates) monitorMutation = false; });
}
