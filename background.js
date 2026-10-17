const LOCAL_ASR_BASE = 'http://127.0.0.1:8765';
let monitorLoadError = '';
try { importScripts('modules/monitor_core.js', 'modules/monitor_background.js'); }
catch(error) { monitorLoadError = error.message; }

async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.message || `HTTP ${response.status}`);
    return data;
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg?.target === 'monitor-background') {
        if (monitorLoadError || typeof handleMonitorMessage !== 'function') {
            sendResponse({ok:false,error:'关注采集模块加载失败：'+(monitorLoadError || '入口缺失')+'。请确认加载完整 extension 文件夹并重新加载插件。'});
            return;
        }
        handleMonitorMessage(msg, sender, sendResponse);
        return true;
    }
    if (msg?.action === 'extension_status') {
        sendResponse({ ok:true, version:chrome.runtime.getManifest().version,
            monitorReady:!monitorLoadError && typeof handleMonitorMessage === 'function',moduleError:monitorLoadError });
        return;
    }
    if (msg.action === 'local_asr_health') {
        fetch(LOCAL_ASR_BASE + '/health', { cache: 'no-store' })
            .then(readJson)
            .then(data => sendResponse({ ok: true, data }))
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }
    if (msg.action === 'local_ai_settings_get') {
        fetch(LOCAL_ASR_BASE + '/api/ai/settings').then(readJson)
            .then(data => sendResponse({ ok: true, data }))
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }
    if (msg.action === 'local_ai_settings_save') {
        fetch(LOCAL_ASR_BASE + '/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload || {}) })
            .then(readJson)
            .then(() => fetch(LOCAL_ASR_BASE + '/api/ai/test', { method: 'POST' }))
            .then(readJson)
            .then(data => sendResponse({ ok: true, data }))
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }
});
