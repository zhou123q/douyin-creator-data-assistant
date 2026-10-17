'use strict';
const runner = new Worker('monitor_worker.js');
let busy = false;
runner.onmessage = async event => {
    const msg = event.data;
    if (msg.type === 'done') { busy = false; return; }
    if (msg.type === 'rpc') {
        try {
            const result = await chrome.runtime.sendMessage({ target: 'monitor-background', ...msg.payload });
            runner.postMessage({ type: 'rpc-result', id: msg.id, result });
        } catch(error) { runner.postMessage({ type: 'rpc-result', id: msg.id, result: { ok: false, error: error.message } }); }
    }
};
runner.onerror = () => { busy = false; };
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.target !== 'monitor-offscreen') return;
    if (msg.action === 'status') { respond({ busy }); return; }
    if (msg.action === 'stop') { runner.postMessage({ type: 'stop' }); respond({ ok: true }); return; }
    if (msg.action === 'run') {
        if (busy) { respond({ ok: false }); return; }
        busy = true;
        runner.postMessage({ type: 'run', kind: msg.kind, autoTranscribe: msg.autoTranscribe });
        respond({ ok: true });
    }
});
