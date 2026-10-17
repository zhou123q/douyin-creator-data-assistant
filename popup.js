document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('btnMonitor').onclick = function() {
        chrome.tabs.create({ url: chrome.runtime.getURL('monitor.html') });
    };
    var btnBenchmark = document.getElementById('btnBenchmark');
    var btnMyAccount = document.getElementById('btnMyAccount');
    var entryHint = document.getElementById('entryHint');
    var btnRefresh = document.getElementById('btnRefresh');
    var serviceStatus = document.getElementById('serviceStatus');
    var modelStatus = document.getElementById('modelStatus');
    var modelDir = document.getElementById('modelDir');
    var aiBaseUrl = document.getElementById('aiBaseUrl');
    var aiModel = document.getElementById('aiModel');
    var aiApiKey = document.getElementById('aiApiKey');
    var aiStatus = document.getElementById('aiStatus');
    var btnSaveAI = document.getElementById('btnSaveAI');

    function formatBytes(bytes) {
        var value = Number(bytes) || 0;
        if (value >= 1073741824) return (value / 1073741824).toFixed(2) + ' GB';
        return (value / 1048576).toFixed(1) + ' MB';
    }

    function formatEta(seconds) {
        if (seconds === null || seconds === undefined) return '正在计算';
        var value = Math.max(0, Math.round(Number(seconds) || 0));
        if (value < 60) return value + ' 秒';
        if (value < 3600) return Math.ceil(value / 60) + ' 分钟';
        return Math.floor(value / 3600) + ' 小时 ' + Math.ceil((value % 3600) / 60) + ' 分钟';
    }

    function refreshLocalASR() {
        btnRefresh.disabled = true;
        serviceStatus.textContent = '检测中…';
        serviceStatus.className = 'value';
        chrome.runtime.sendMessage({ action: 'local_asr_health' }, function(resp) {
            btnRefresh.disabled = false;
            if (chrome.runtime.lastError || !resp || !resp.ok) {
                serviceStatus.textContent = '未启动';
                serviceStatus.className = 'value err';
                modelStatus.textContent = '无法检测';
                modelStatus.className = 'value err';
                modelDir.textContent = '—';
                return;
            }
            var data = resp.data || {};
            serviceStatus.textContent = '已连接 · ' + (data.version || '未知版本');
            serviceStatus.className = 'value ok';
            modelStatus.textContent = data.model_ready ? (data.model_name || '已就绪') : '模型不完整';
            modelStatus.className = data.model_ready ? 'value ok' : 'value err';
            if (data.model_download && (data.model_download.status === 'preparing' || data.model_download.status === 'downloading')) {
                var dl = data.model_download;
                modelStatus.textContent = (dl.status === 'preparing' ? '正在获取大小 · ' : '正在下载 · ') +
                    Number(dl.percent || 0).toFixed(1) + '% · ' + formatBytes(dl.downloaded_bytes) + '/' +
                    formatBytes(dl.total_bytes || 1530575439) + ' · 剩余 ' + formatEta(dl.eta_seconds);
                modelStatus.className = 'value';
                setTimeout(refreshLocalASR, 1000);
            } else if (data.model_download && data.model_download.status === 'failed') {
                modelStatus.textContent = '下载失败：' + (data.model_download.error || '未知错误');
                modelStatus.className = 'value err';
            }
            modelDir.textContent = data.model_dir || '—';
            chrome.runtime.sendMessage({ action: 'local_ai_settings_get' }, function(aiResp) {
                if (!aiResp || !aiResp.ok) return;
                aiBaseUrl.value = aiResp.data.base_url || 'https://api.deepseek.com/v1';
                aiModel.value = aiResp.data.model || 'deepseek-chat';
                aiStatus.textContent = aiResp.data.configured ? '已配置：' + aiResp.data.api_key_masked : '尚未配置 API Key';
                aiStatus.className = aiResp.data.configured ? 'hint ok' : 'hint';
            });
        });
    }

    btnSaveAI.onclick = function() {
        btnSaveAI.disabled = true;
        aiStatus.textContent = '正在保存并测试…';
        chrome.runtime.sendMessage({ action: 'local_ai_settings_save', payload: {
            base_url: aiBaseUrl.value.trim(), model: aiModel.value.trim(), api_key: aiApiKey.value.trim(), temperature: 0.7
        }}, function(resp) {
            btnSaveAI.disabled = false;
            aiApiKey.value = '';
            aiStatus.textContent = resp && resp.ok ? '配置成功，大模型连接正常' : '配置失败：' + ((resp && resp.error) || '本地伴侣未启动');
            aiStatus.className = resp && resp.ok ? 'hint ok' : 'hint err';
        });
    };

    btnRefresh.onclick = refreshLocalASR;
    refreshLocalASR();

    function openAnalysis(mode) {
        var activeButton = mode === 'self' ? btnMyAccount : btnBenchmark;
        activeButton.textContent = mode === 'self' ? '正在进入我的主页…' : '正在打开…';
        activeButton.disabled = true;
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            var tab = tabs && tabs[0];
            if (!tab || !tab.id) {
                finishEntry(activeButton, mode, '无法读取当前标签页');
                return;
            }
            if (!/^https:\/\/(?:www\.)?douyin\.com\//.test(tab.url || '')) {
                finishEntry(activeButton, mode, '请先打开并登录抖音网页版');
                return;
            }
            if (mode === 'self') {
                (async function() {
                    try {
                        await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['modules/douyin_page_api.js']});
                        var results = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async function() {
                            try {
                                var own = await window.__DcxzsPageApi__.identity();
                                localStorage.setItem('dcxzs-analysis-mode','self');
                                localStorage.setItem('dcxzs-self-sec-uid',own.sec_uid);
                                var path = '/user/'+own.sec_uid;
                                if (location.pathname !== path) { location.href=path; return {ok:true,navigating:true}; }
                                return {ok:true,version:window.__DCXZS_VERSION__||''};
                            } catch(error) { return {ok:false,reason:error.message}; }
                        }});
                        var result = results[0]?.result;
                        if (!result?.ok) throw new Error(result?.reason || '无法确认自己的账号');
                        if (!result.navigating) {
                            if (result.version !== '1.10.3') await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',
                                files:['modules/douyin_page_api.js','modules/self_analytics.js','libs/tailwind.js','libs/fflate.js','libs/chart.js','modules/dy_comment_module.js','inject.js']});
                            await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:function(){
                                window.__DcxzsSetAnalysisMode?.('self');window.__DcxzsToggleDrawer?.(true);
                            }});
                        }
                        window.close();
                    } catch(error) { finishEntry(activeButton,mode,error.message); }
                })();
                return;
            }
            if (!/\/user\//.test(tab.url || '')) {
                finishEntry(activeButton, mode, '请先打开一个博主主页');
                return;
            }
            chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: function() {
                localStorage.setItem('dcxzs-analysis-mode', 'benchmark');
                if (typeof window.__DcxzsSetAnalysisMode === 'function') window.__DcxzsSetAnalysisMode('benchmark');
            }});
            chrome.scripting.executeScript({
                target: { tabId: tab.id }, world: 'MAIN',
                func: function() {
                    return {
                        ok: typeof window.__DcxzsToggleDrawer === 'function',
                        version: window.__DCXZS_VERSION__ || '',
                        open: !!document.getElementById('dy-drawer-wrap')?.classList.contains('open')
                    };
                }
            }, function(results) {
                var resp = results && results[0] && results[0].result;
                if (resp && resp.ok && resp.version === '1.10.3') {
                    chrome.scripting.executeScript({
                        target: { tabId: tab.id }, world: 'MAIN',
                        func: function() { return window.__DcxzsToggleDrawer(); }
                    }, finishToggle);
                } else {
                    // 旧版标签页可能仍保留收费/试用脚本。版本不匹配时直接替换注入，
                    // 不要求用户手动刷新整个抖音页面。
                    var files = resp && resp.ok
                        ? ['modules/douyin_page_api.js','modules/self_analytics.js','inject.js']
                        : ['modules/douyin_page_api.js','modules/self_analytics.js','libs/tailwind.js', 'libs/fflate.js', 'libs/chart.js', 'modules/dy_comment_module.js', 'inject.js'];
                    chrome.scripting.executeScript({
                        target: { tabId: tab.id }, world: 'MAIN',
                        files: files
                    }, function() {
                        setTimeout(function() {
                            chrome.scripting.executeScript({
                                target: { tabId: tab.id }, world: 'MAIN',
                                func: function() {
                                    if (typeof window.__DcxzsToggleDrawer === 'function') return window.__DcxzsToggleDrawer();
                                    return { ok: false };
                                }
                            }, finishToggle);
                        }, 800);
                    });
                }
            });
        });
    }

    btnBenchmark.onclick = function() { openAnalysis('benchmark'); };
    btnMyAccount.onclick = function() { openAnalysis('self'); };

    function finishEntry(button, mode, message) {
        button.disabled = false;
        button.textContent = mode === 'self' ? '分析我的账号' : '分析当前主页';
        entryHint.textContent = message;
        entryHint.className = 'hint err';
    }

    function finishToggle(results) {
        var result = results && results[0] && results[0].result;
        btnBenchmark.textContent = result && result.open ? '关闭当前面板' : '分析当前主页';
        btnBenchmark.disabled = false;
    }
});
