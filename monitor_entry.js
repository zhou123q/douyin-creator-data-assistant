'use strict';
function attachMonitorEntry() {
    const anchor = document.getElementById('userDataBtn');
    if (!anchor || document.getElementById('dcxzs-monitor-add')) return;
    const button = document.createElement('button');
    button.id = 'dcxzs-monitor-add';
    button.className = 'action-btn data';
    button.textContent = '加入采集列表';
    button.onclick = async event => {
        if (!event.isTrusted) return;
        button.disabled = true;
        try {
            const result = await chrome.runtime.sendMessage({ target: 'monitor-background', action: 'add', url: location.href });
            if (!result?.ok) throw new Error(result?.error || '添加失败');
            button.textContent = '已加入 · 查看';
            button.onclick = () => chrome.runtime.sendMessage({ target: 'monitor-background', action: 'open' });
        } catch(error) { button.textContent = '添加失败'; button.title = error.message; }
        finally { button.disabled = false; }
    };
    anchor.after(button);
}
attachMonitorEntry();
new MutationObserver(attachMonitorEntry).observe(document.body, { childList: true, subtree: true });
