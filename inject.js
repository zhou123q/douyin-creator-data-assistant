/**
 * df对标拆解助手 — Chrome 扩展注入版本
 *
 * 所有 CDN 依赖（Tailwind/fflate/Chart.js）改为本地加载，
 * 评论模块（dy_comment_module.js）由 manifest.json 预加载。
 *
 * @version 1.5-chrome-ext
 */

/**
 * df对标拆解助手 (Chrome 控制台注入脚本)
 * 
 * 功能概述：
 *   在抖音用户主页 (/user/xxx) 的控制台执行此脚本，注入一个侧边抽屉面板，
 *   支持分页拉取用户全部公开作品、表格/网格双视图展示、多维度排序、搜索过滤、
 *   批量导出 JSON/CSV/TXT、导出视频（zip 压缩包）。
 * 
 * 数据来源：
 *   - 用户信息：douyin.com/aweme/v1/web/user/profile/other
 *   - 作品列表：douyin.com/aweme/v1/web/aweme/post（分页拉取至 has_more=false）
 * 
 * 使用方式：
 *   1. 打开目标抖音用户主页（如 https://www.douyin.com/user/MS4wLjAB...）
 *   2. F12 打开开发者工具 → Console 面板
 *   3. 粘贴本脚本并回车执行
 *   4. 页面右侧出现抽屉面板，自动开始拉取数据
 * 
 * 注意事项：
 *   - 必须在抖音 /user/ 路由页面执行，否则会报错
 *   - 需要登录态 cookie（在已登录的抖音页面执行）
 *   - API 仅返回用户公开作品，私密/已删除作品无法获取
 *   - 重复执行会自动清理旧面板实例
 *   - 视频导出：四级降级策略下载（HEAD重定向→匿名fetch→带cookie→候选兜底），打包为 ZIP
 * 
 * @version 2026-06-21
 */
(async function DouyinDrawerTableFull() {
    // ============================================================
    //  0. 旧实例清理 & 全局状态变量
    // ============================================================
    // 清理旧实例，避免重复运行导致多个面板堆叠
    const old = document.getElementById("dy-drawer-wrap");
    if (old) old.remove();
    const oldBtn = document.getElementById("dy-drawer-btn");
    if (oldBtn) oldBtn.remove();
    const oldMask = document.getElementById("dy-drawer-mask");
    if (oldMask) oldMask.remove();
    window.__DCXZS_VERSION__ = '1.10.3';

    // API 基础地址（用于 fetch 请求和 Referer 头）
    const baseHost = "https://www.douyin.com";

    // ---- 全局状态变量 ----
    let userProfile = null;                              // 用户信息对象（API 返回的 json.user）
    let allWorksList = [];                               // 全部拉取到的作品原始列表
    let filterWorks = [];                                // 搜索/排序后的作品列表（实际渲染源）
    let pageSize = parseInt(localStorage.getItem('hankin-dy-page-size')) || 20; // 每页显示条数（可切换）
    let currentPage = 1;                                 // 当前页码
    let selectedIds = new Set();                         // 已选中的作品 aweme_id 集合
    let currentView = localStorage.getItem('hankin-dy-drawer-view') || 'table'; // 当前视图：'table' | 'grid'
    let isLoading = false;                               // 是否正在加载数据
    let sortField = "create_time";                       // 当前排序字段
    let sortOrder = "desc";                              // 排序方向：'asc' | 'desc'
    let totalWorksExpected = 0;                          // 预期总作品数（用于进度条初始值）
    const currentPageSecUid = (location.pathname.match(/^\/user\/([^/?#]+)/) || [])[1] || '';
    let knownSelfSecUid = localStorage.getItem('dcxzs-self-sec-uid') || '';
    if (knownSelfSecUid === 'self') { knownSelfSecUid = ''; localStorage.removeItem('dcxzs-self-sec-uid'); }
    let analysisMode = currentPageSecUid === 'self' || (localStorage.getItem('dcxzs-analysis-mode') === 'self' && (!knownSelfSecUid || knownSelfSecUid === currentPageSecUid))
        ? 'self' : 'benchmark';
    let playCountObserver = null;
    let playCountRefreshTimer = null;

    // 主题状态（从 localStorage 读取，默认浅色）
    let isDarkMode = localStorage.getItem('hankin-dy-drawer-theme') === 'dark';

    // 列显示控制（type/author/tags 默认隐藏，需在列选项中勾选才可见）
    let columnVisibility = {
        select: true,
        id: true,
        cover: true,
        title: true,
        tags: false,
        type: false,
        create_time: true,
        digg_count: true,
        share_count: true,
        comment_count: true,
        collect_count: true,
        promote_count: true,
        play_count: true,
        engagement_rate: true,
        operation: true
    };

    // 这些是核心数据列，发布版中不允许被列选项隐藏，避免用户勾选其他列后误以为数据丢失。
    const alwaysVisibleColumns = new Set([
        "digg_count",
        "share_count",
        "comment_count",
        "collect_count",
        "promote_count",
        "play_count",
        "engagement_rate",
        "operation"
    ]);

    // ---- ASR 转文字状态 ----
    var asrTasks = {};
    try {
        var savedASR = JSON.parse(localStorage.getItem('dcxzs_asr_tasks') || '{}');
        Object.keys(savedASR).forEach(function(k) { asrTasks[k] = savedASR[k]; });
    } catch(e) { localStorage.removeItem('dcxzs_asr_tasks'); }

    function saveASRState() {
        try { localStorage.setItem('dcxzs_asr_tasks', JSON.stringify(asrTasks)); } catch(e) {}
    }

    // ---- AI 配置（API Key 仅在后端，前端不持有） ----
    var aiLimiterCount = 0;
    const aiLimiterMax = 3;
    var aiAnalysisCache = {};
    try {
        var savedCache = JSON.parse(localStorage.getItem('dcxzs_ai_analysis_cache') || '{}');
        Object.keys(savedCache).forEach(function(k) { aiAnalysisCache[k] = savedCache[k]; });
    } catch(e) { localStorage.removeItem('dcxzs_ai_analysis_cache'); }
    function saveAICache() {
        try { localStorage.setItem('dcxzs_ai_analysis_cache', JSON.stringify(aiAnalysisCache)); } catch(e) {}
    }
    // 暴露 AI 配置给评论模块等外部脚本（不含 API Key，Key 仅在后端）
    window.__AI_CONFIG__ = {
        API_BASE: 'http://127.0.0.1:8765',
        getLimiterCount: function() { return aiLimiterCount; },
        incrementLimiter: function() { aiLimiterCount++; },
        decrementLimiter: function() { aiLimiterCount--; },
        aiLimiterMax: aiLimiterMax
    };

    // 免费开源版不做许可证、试用额度或使用统计。
    function reportUsage() {}
    window.__reportUsage__ = reportUsage;

    function parseCompactCount(value) {
        const text = String(value == null ? '' : value).trim().replace(/,/g, '');
        const match = text.match(/^(\d+(?:\.\d+)?)\s*([万亿wW]?)$/);
        if (!match) return null;
        let number = Number(match[1]);
        if (match[2] === '万' || /w/i.test(match[2])) number *= 10000;
        if (match[2] === '亿') number *= 100000000;
        return Number.isFinite(number) ? Math.round(number) : null;
    }

    function extractAwemeIdFromHref(href) {
        const match = String(href || '').match(/\/(?:video|note)\/(\d+)/);
        return match ? match[1] : '';
    }

    function extractPlayCountFromCard(link) {
        return window.DcxzsSelfAnalytics.readCard(link);
    }

    function collectVisiblePlayCounts() {
        const result = new Map();
        document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]').forEach(link => {
            if (link.closest('#dy-drawer-wrap')) return;
            const aid = extractAwemeIdFromHref(link.href || link.getAttribute('href'));
            if (!aid || result.has(aid)) return;
            const value = extractPlayCountFromCard(link);
            if (value !== null) result.set(aid, value);
        });
        return result;
    }

    function updateSelfAnalytics(renderAfter) {
        if (analysisMode !== 'self' || !allWorksList.length) return 0;
        const visible = collectVisiblePlayCounts();
        let changed = 0;
        allWorksList.forEach(item => {
            const aid = String(item.aweme_id || '');
            const domValue = visible.has(aid) ? visible.get(aid) : null;
            const previous = item.selfAnalytics?.playCount;
            const previousRate = item.selfAnalytics?.engagementRate;
            item.selfAnalytics = window.DcxzsSelfAnalytics.update(item, domValue);
            if (previous !== item.selfAnalytics.playCount || previousRate !== item.selfAnalytics.engagementRate) changed++;
        });
        updateAnalysisModeUi();
        if (changed && renderAfter) renderTable();
        return changed;
    }

    function formatRate(value) {
        return Number.isFinite(value) ? (value * 100).toFixed(value >= 0.1 ? 1 : 2) + '%' : '-';
    }

    function updateAnalysisModeUi() {
        const wrap = document.getElementById('dy-drawer-wrap');
        if (!wrap) return;
        wrap.classList.toggle('self-analysis', analysisMode === 'self');
        wrap.querySelectorAll('[data-analysis-mode]').forEach(button => button.classList.toggle('active', button.dataset.analysisMode === analysisMode));
        const title = document.getElementById('drawerMainTitle');
        const titleText = analysisMode === 'self' ? '我的账号数据分析' : '对标账号作品数据';
        if (title && title.textContent !== titleText) title.textContent = titleText;
        const coverage = document.getElementById('selfPlayCoverage');
        if (coverage) {
            const count = allWorksList.filter(item => Number.isFinite(item.selfAnalytics?.playCount)).length;
            const coverageText = `播放量 ${count}/${allWorksList.length || 0}`;
            if (coverage.textContent !== coverageText) coverage.textContent = coverageText;
        }
    }

    function setAnalysisMode(mode) {
        knownSelfSecUid = localStorage.getItem('dcxzs-self-sec-uid') || '';
        if (knownSelfSecUid === 'self') knownSelfSecUid = '';
        const requested = mode === 'self' ? 'self' : 'benchmark';
        if (requested === 'self' && knownSelfSecUid && knownSelfSecUid !== currentPageSecUid) {
            localStorage.setItem('dcxzs-analysis-mode', 'self');
            location.href = `${baseHost}/user/${knownSelfSecUid}`;
            return { ok: true, navigating: true, mode: 'self' };
        }
        if (requested === 'self' && !knownSelfSecUid) {
            alert('请先从插件弹窗点击“分析我的账号”，让插件确认已登录账号。');
            return { ok: false, mode: analysisMode };
        }
        analysisMode = requested;
        localStorage.setItem('dcxzs-analysis-mode', analysisMode);
        updateAnalysisModeUi();
        if (analysisMode === 'self') updateSelfAnalytics(false);
        renderTable();
        return { ok: true, mode: analysisMode };
    }
    window.__DcxzsSetAnalysisMode = setAnalysisMode;

    // 本地 CPU 转写串行执行，避免同时加载多个重任务。
    var asrQueue = [];
    var asrRunning = 0;
    var ASR_MAX_CONCURRENT = 1;
    function runASRQueue() {
        while (asrQueue.length > 0 && asrRunning < ASR_MAX_CONCURRENT) {
            asrRunning++;
            var task = asrQueue.shift();
            task.fn().finally(function() { asrRunning--; runASRQueue(); });
        }
    }
    function enqueueASR(fn) {
        return new Promise(function(resolve, reject) {
            asrQueue.push({ fn: async function() {
                try { resolve(await fn()); } catch(e) { reject(e); }
            }});
            runASRQueue();
        });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
        });
    }

    function renderASRButton(aid) {
        var t = asrTasks[aid];
        var progress = t && t.progress ? t.progress : '';
        var tip = '\u6ce8\u610f\uff1a&#10;1\u3001\u89c6\u9891\u8d8a\u957f\u7b49\u5f85\u8d8a\u4e45\uff1b&#10;2\u3001\u65e0\u58f0\u3001\u56fe\u6587\u6216\u79c1\u5bc6\u89c6\u9891\u53ef\u80fd\u65e0\u6cd5\u8bc6\u522b\u3002&#10;3\u3001\u4e00\u4e2a\u89c6\u9891\u65f6\u957f\u6700\u591a20\u5206\u949f\u3002';
        if (!t) return '<button class="action-btn asr-action-btn" data-aid="'+aid+'" data-action="start-asr" title="'+tip+'" style="color:#fff;background:#2563eb;border-color:#2563eb;font-weight:600">\u8f6c\u6587\u5b57</button>';
        if (t.status === 'processing') return '<button class="action-btn asr-action-btn" data-aid="'+aid+'" disabled title="'+escapeHtml(progress || '\u6b63\u5728\u8f6c\u6587\u5b57')+'" style="min-width:98px;color:#fff;background:#3b82f6;border-color:#3b82f6;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:6px"><span class="asr-progress-ring"></span><span>'+(progress || '\u8f6c\u5199\u4e2d')+'</span></button>';
        if (t.status === 'completed') return '<button class="action-btn asr-action-btn" data-aid="'+aid+'" data-action="view-asr" style="color:#fff;background:#16a34a;border-color:#16a34a;font-weight:600">\u5df2\u8f6c\u5199</button>';
        if (t.status === 'no_speech') return '<button class="action-btn asr-action-btn" data-aid="'+aid+'" style="color:#9ca3af;font-weight:600" title="\u672a\u68c0\u6d4b\u5230\u4eba\u58f0">\u65e0\u4eba\u58f0</button>';
        return '<button class="action-btn asr-action-btn" data-aid="'+aid+'" data-action="start-asr" style="color:#fff;background:#dc2626;border-color:#dc2626;font-weight:600" title="'+escapeHtml((t.error ? t.error + '\n\n' : '') + '\u6ce8\u610f\uff1a\n1\u3001\u89c6\u9891\u8d8a\u957f\u7b49\u5f85\u8d8a\u4e45\uff1b\n2\u3001\u65e0\u58f0\u3001\u56fe\u6587\u6216\u79c1\u5bc6\u89c6\u9891\u53ef\u80fd\u65e0\u6cd5\u8bc6\u522b\u3002\n3\u3001\u4e00\u4e2a\u89c6\u9891\u65f6\u957f\u6700\u591a20\u5206\u949f\u3002')+'">\u91cd\u8bd5</button>';
    }

    function refreshASRButton(aid, oldBtn) {
        var html = renderASRButton(aid);
        if (oldBtn && oldBtn.parentNode) {
            oldBtn.outerHTML = html;
        } else {
            document.querySelectorAll('.asr-action-btn[data-aid="'+aid+'"]').forEach(function(btn) {
                btn.outerHTML = html;
            });
        }
        bindActionButtons(document);
        // 同步刷新 AI 拆解按钮状态
        refreshAIAnalysisButton(aid);
    }

    // ============================================================
    //  1. 工具函数
    // ============================================================

    /**
     * 从当前页面 URL 动态提取 sec_uid
     * 兼容旧版数字 ID 及新版 Base64 编码格式（含 . _ - 等字符）
     * @returns {string} 用户 sec_uid
     * @throws {Error} 页面路径不匹配 /user/ 模式时抛出
     */
    function getCurrentSecUid() {
        const path = window.location.pathname;
        const match = path.match(/^\/user\/([A-Za-z0-9._\-]+)/);
        if (!match || !match[1]) {
            throw new Error("未识别到抖音用户主页，请在 /user/ 开头的账号页面执行脚本");
        }
        if (match[1] === 'self') {
            if (userProfile?.sec_uid && userProfile.sec_uid !== 'self') return userProfile.sec_uid;
            throw new Error('自己的真实账号 ID 尚未识别，请重新解析');
        }
        return match[1];
    }

    /**
     * 数字格式化：大数缩写为 w（万）/ k（千）
     * @param {number} num - 原始数字
     * @returns {string} 格式化后的字符串，如 "1.2w", "999"
     */
    function formatNumber(num) {
        if (num >= 10000) {
            return (num / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
        }
        if (num >= 1000) {
            return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        }
        return num.toString();
    }

    /**
     * Unix 时间戳转可读日期字符串
     * @param {number} timestamp - 秒级 Unix 时间戳
     * @returns {string} 格式 "YYYY-MM-DD HH:mm:ss"
     */
    function formatDateTime(timestamp) {
        const date = new Date(timestamp * 1000);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    /**
     * 切换深色/浅色主题，状态持久化到 localStorage
     */
    function toggleTheme() {
        isDarkMode = !isDarkMode;
        applyTheme();
        localStorage.setItem('hankin-dy-drawer-theme', isDarkMode ? 'dark' : 'light');
    }

    /**
     * 根据 isDarkMode 状态应用主题样式到 DOM
     * 切换 #dy-drawer-wrap 的 .dark-mode 类，更新主题按钮图标+文字
     */
    function applyTheme() {
        const root = document.getElementById('dy-drawer-wrap');
        if (!root) return;
        
        if (isDarkMode) {
            root.classList.add('dark-mode');
            const themeBtn = document.getElementById('themeToggleBtn');
            if (themeBtn) {
                themeBtn.innerHTML = `
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.636l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.636l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>
                    </svg>
                    浅色模式
                `;
            }
        } else {
            root.classList.remove('dark-mode');
            const themeBtn = document.getElementById('themeToggleBtn');
            if (themeBtn) {
                themeBtn.innerHTML = `
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>
                    </svg>
                    深色模式
                `;
            }
        }
    }

    // ============================================================
    //  2. DOM 创建 —— 注入 CSS、HTML、绑定事件
    // ============================================================

    /**
     * 创建整个抽屉面板的 DOM 结构
     * 包含：Tailwind CDN 加载、自定义 CSS 注入、HTML 模板渲染、事件绑定
     * 这是脚本中最大的函数，一次性完成全部 UI 初始化
     */
    function createDrawerDom() {
        // 自定义Tailwind配置 —— 需等待 tailwind 脚本加载完成后才能设置
        const customConfig = document.createElement("script");
        customConfig.textContent = `
            function __initTailwindConfig() {
                if (typeof tailwind === 'undefined') {
                    return setTimeout(__initTailwindConfig, 50);
                }
                tailwind.config = {
                    theme: {
                        extend: {
                            colors: {
                                'dy-red': '#fe2c55',
                                'dy-red-hover': '#e5264c',
                                'dy-bg': '#f5f6f7',
                                'dy-border': '#e8e8e8',
                                'dy-text': '#1a1a1a',
                                'dy-text-secondary': '#666666',
                                'sort-active': '#1677ff',
                                'row-hover': '#f0f7ff',
                                'row-even': '#fafbfc',
                                'dark-bg': '#1a1a1a',
                                'dark-bg-secondary': '#2d2d2d',
                                'dark-border': '#404040',
                                'dark-text': '#e5e5e5',
                                'dark-text-secondary': '#a0a0a0'
                            }
                        }
                    }
                };
            }
            __initTailwindConfig();
        `;
        document.head.appendChild(customConfig);

        // 全局样式（包含深色模式）
        const style = document.createElement("style");
        style.textContent = `
#dy-drawer-mask{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.25);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:99999;opacity:0;pointer-events:none;transition:opacity 0.35s ease}
#dy-drawer-mask.show{opacity:1;pointer-events:auto}
#dy-drawer-wrap{transition:right 0.35s cubic-bezier(0.4,0,0.2,1);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
#dy-drawer-wrap.dark-mode{background-color:#1a1a1a !important;color:#e5e5e5 !important}
#dy-drawer-wrap.dark-mode .drawer-header,#dy-drawer-wrap.dark-mode .drawer-user-info,#dy-drawer-wrap.dark-mode .drawer-toolbar,#dy-drawer-wrap.dark-mode .page-bar{background-color:#2d2d2d !important;border-color:#404040 !important}
/* 试用状态条 */
/* 用户信息卡片背景封面图 + 遮罩（保证文字可读） */
.drawer-user-info{
    position:relative;
    background-image:var(--cover-bg,none);
    background-size:cover;
    background-position:center;
    background-repeat:no-repeat
}
.drawer-user-info::before{
    content:'';
    position:absolute;
    inset:0;
    z-index:0;
    background:var(--cover-overlay,rgba(255,255,255,0.82))
}
#dy-drawer-wrap.dark-mode .drawer-user-info::before{
    background:var(--cover-overlay-dark,rgba(26,26,26,0.85))
}
.drawer-user-info>*{position:relative;z-index:1}
#dy-drawer-wrap.dark-mode input,#dy-drawer-wrap.dark-mode select,#dy-drawer-wrap.dark-mode table,#dy-drawer-wrap.dark-mode thead{background-color:#2d2d2d !important;color:#e5e5e5 !important;border-color:#404040 !important}
#dy-drawer-wrap.dark-mode tbody tr.bg-white{background-color:#2d2d2d !important}
#dy-drawer-wrap.dark-mode tbody tr.bg-row-even{background-color:#333333 !important}
#dy-drawer-wrap.dark-mode tbody tr:hover{background-color:#404040 !important}
#dy-drawer-wrap.dark-mode .text-dy-text{color:#e5e5e5 !important}
#dy-drawer-wrap.dark-mode .text-dy-text-secondary{color:#a0a0a0 !important}
#dy-drawer-wrap.dark-mode .border-dy-border{border-color:#404040 !important}
#dy-drawer-wrap.dark-mode .bg-dy-bg{background-color:#2d2d2d !important}
#dy-drawer-wrap.dark-mode .drawer-table-box{background-color:#1a1a1a !important}
#dy-drawer-wrap.dark-mode input::placeholder{color:#808080 !important}
#dy-drawer-wrap.dark-mode thead th{background-color:#333333 !important}
#dy-drawer-wrap::-webkit-scrollbar{width:6px;height:6px}
#dy-drawer-wrap::-webkit-scrollbar-track{background:#f1f1f1;border-radius:3px}
#dy-drawer-wrap.dark-mode::-webkit-scrollbar-track{background:#2d2d2d}
#dy-drawer-wrap::-webkit-scrollbar-thumb{background:#c1c1c1;border-radius:3px}
#dy-drawer-wrap.dark-mode::-webkit-scrollbar-thumb{background:#555555}
#dy-drawer-wrap::-webkit-scrollbar-thumb:hover{background:#a8a8a8}
#dy-drawer-wrap.dark-mode::-webkit-scrollbar-thumb:hover{background:#666666}
th[data-sort] .sort-icon{display:inline-flex;flex-direction:column;align-items:center;margin-left:4px;opacity:0.3;transition:opacity 0.2s ease}
th[data-sort]:hover .sort-icon{opacity:0.7}
th.sort-active .sort-icon{opacity:1 !important}
#workTable{border-spacing:0;table-layout:fixed;min-width:100%}
#workTable thead th{font-weight:600;letter-spacing:0.3px;user-select:none;white-space:nowrap}
#workTable tbody td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#workTable tbody td[data-col="title"]{white-space:nowrap}
td[data-col="digg_count"],td[data-col="share_count"],td[data-col="comment_count"],td[data-col="collect_count"],td[data-col="promote_count"]{overflow:visible;text-overflow:clip}
.drawer-table-box::-webkit-scrollbar{height:8px}
.drawer-table-box::-webkit-scrollbar-track{background:#f1f1f1;border-radius:4px}
.drawer-table-box::-webkit-scrollbar-thumb{background:#c7c7c7;border-radius:4px}
th[data-col="select"],td[data-col="select"]{min-width:60px;width:60px}th[data-col="id"],td[data-col="id"]{min-width:190px;width:190px}th[data-col="cover"],td[data-col="cover"]{min-width:90px;width:90px}th[data-col="title"],td[data-col="title"]{min-width:280px;width:280px}th[data-col="tags"],td[data-col="tags"]{min-width:240px;width:240px}th[data-col="type"],td[data-col="type"]{min-width:90px;width:90px}th[data-col="create_time"],td[data-col="create_time"]{min-width:180px;width:180px}th[data-col="digg_count"],td[data-col="digg_count"],th[data-col="share_count"],td[data-col="share_count"],th[data-col="comment_count"],td[data-col="comment_count"],th[data-col="collect_count"],td[data-col="collect_count"],th[data-col="promote_count"],td[data-col="promote_count"]{min-width:90px;width:90px}
th[data-col="operation"],td[data-col="operation"]{min-width:290px!important;width:290px!important}
.asr-progress-ring{width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;display:inline-block;animation:asr-spin .8s linear infinite}
@keyframes asr-spin{to{transform:rotate(360deg)}}
.btn-press:active{transform:scale(0.97)}
.cover-wrapper{width:60px;height:40px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f5f5f5 0%,#e8e8e8 100%);border-radius:6px;overflow:hidden;margin:0 auto}
#dy-drawer-wrap.dark-mode .cover-wrapper{background:linear-gradient(135deg,#333333 0%,#404040 100%)}
@keyframes shimmer{0%{background-position:-200% 0}
100%{background-position:200% 0}
}.loading-shimmer{background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
#dy-drawer-wrap.dark-mode .loading-shimmer{background:linear-gradient(90deg,#2d2d2d 25%,#404040 50%,#2d2d2d 75%)}
.progress-bar-container{width:100%;height:6px;background-color:#e8e8e8;border-radius:3px;overflow:hidden;margin-top:8px}
#dy-drawer-wrap.dark-mode .progress-bar-container{background-color:#404040}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,#fe2c55,#ff6b81);border-radius:3px;transition:width 0.3s ease;width:0%}
#dy-drawer-wrap.dark-mode .progress-bar-fill{background:linear-gradient(90deg,#fe2c55,#ff6b81)}
#searchInput{pointer-events:auto !important;min-width:200px}
/* 导出下拉按钮 */
.export-dropdown{position:relative;display:inline-flex}
.export-dropdown-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid #e8e8e8;border-radius:8px;background:#fff;color:#333;font-size:13px;font-weight:500;cursor:pointer;outline:none;transition:border-color 0.2s,background 0.15s;white-space:nowrap;user-select:none}
.export-dropdown-btn:hover{background:#f5f6f7}
.export-dropdown-btn .arrow{font-size:10px;transition:transform 0.2s;color:#999}
.export-dropdown.open .export-dropdown-btn{border-color:#fe2c55}
.export-dropdown.open .arrow{transform:rotate(180deg)}
#dy-drawer-wrap.dark-mode .export-dropdown-btn{border-color:#404040;background:#2d2d2d;color:#e5e5e5}
#dy-drawer-wrap.dark-mode .export-dropdown-btn:hover{background:#3a3a3a}
#dy-drawer-wrap.dark-mode .export-dropdown.open .export-dropdown-btn{border-color:#fe2c55}
.export-dropdown-menu{position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #e8e8e8;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.1);z-index:1000;display:none;overflow:hidden}
.export-dropdown.open .export-dropdown-menu{display:block}
.export-dropdown-item{display:block;width:100%;padding:8px 14px;border:none;background:transparent;color:#333;font-size:13px;cursor:pointer;text-align:left;transition:background 0.1s;outline:none}
.export-dropdown-item:hover{background:#f5f6f7;color:#fe2c55}
.export-dropdown-item:active{background:#fee}
#dy-drawer-wrap.dark-mode .export-dropdown-menu{background:#2d2d2d;border-color:#404040;box-shadow:0 4px 16px rgba(0,0,0,0.4)}
#dy-drawer-wrap.dark-mode .export-dropdown-item{color:#e5e5e5}
#dy-drawer-wrap.dark-mode .export-dropdown-item:hover{background:#3a3a3a;color:#fe2c55}
#dy-drawer-wrap.dark-mode .export-dropdown-item:active{background:#4a2020}
.export-dropdown-label{padding:8px 14px 4px;font-size:11px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;cursor:default;pointer-events:none}
.export-dropdown-divider{height:1px;background:#eee;margin:4px 0}
#dy-drawer-wrap.dark-mode .export-dropdown-label{color:#777}
#dy-drawer-wrap.dark-mode .export-dropdown-divider{background:#404040}
.view-switch-menu{position:absolute;top:100%;left:0;margin-top:4px;background:white;border:1px solid #e8e8e8;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:8px 0;min-width:140px;z-index:100001;display:none}
.view-switch-menu.show{display:block}
.view-switch-item{display:flex;align-items:center;gap:8px;padding:8px 16px;cursor:pointer;font-size:14px;color:#333;transition:background 0.15s}
.view-switch-item:hover{background:#f5f6f7}
.view-switch-item.active{color:#fe2c55;font-weight:500}
#dy-drawer-wrap.dark-mode .view-switch-menu{background:#2d2d2d;border-color:#404040}
#dy-drawer-wrap.dark-mode .view-switch-item{color:#e5e5e5}
#dy-drawer-wrap.dark-mode .view-switch-item:hover{background:#3a3a3a}
#dy-drawer-wrap.dark-mode .view-switch-item.active{color:#fe2c55}
#dy-drawer-wrap.dark-mode .view-switch-divider{background:#404040 !important}
.grid-view-container{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;padding:12px}
.grid-card{background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e8e8e8;transition:all 0.2s;cursor:pointer;position:relative}
.grid-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,0.1);border-color:#fe2c55}
.grid-card.selected{border-color:#fe2c55;box-shadow:0 0 0 2px rgba(254,44,85,0.2)}
#dy-drawer-wrap.dark-mode .grid-card{background:#2d2d2d;border-color:#404040}
#dy-drawer-wrap.dark-mode .grid-card:hover{border-color:#fe2c55;box-shadow:0 4px 16px rgba(254,44,85,0.2)}
.grid-card-cover{width:100%;aspect-ratio:1 / 1;object-fit:cover;display:block;background:#f0f0f0}
.grid-card-body{padding:10px}
.grid-card-title{font-size:12px;color:#1a1a1a;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:8px;min-height:32px}
#dy-drawer-wrap.dark-mode .grid-card-title{color:#e5e5e5}
.grid-card-meta{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#999}
.grid-card-stats{display:flex;gap:8px;align-items:center}
.grid-card-stat{display:flex;align-items:center;gap:2px;white-space:nowrap}
.grid-card-check{position:absolute;top:6px;left:6px;width:20px;height:20px;z-index:2;accent-color:#fe2c55;cursor:pointer}
.grid-card-type{position:absolute;top:6px;right:6px;font-size:10px;padding:1px 6px;border-radius:4px;color:#fff;z-index:2}
.grid-card-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity 0.2s}
.grid-card:hover .grid-card-play{opacity:1}
#dy-drawer-wrap.grid-view #workTable{display:none}
#dy-drawer-wrap.grid-view .grid-view-container{display:grid}
#dy-drawer-wrap.table-view .grid-view-container{display:none}
#dy-drawer-wrap.table-view #workTable{display:table}
#dy-drawer-wrap.grid-view #columnOptionsWrapper{display:none}
#dy-drawer-wrap.table-view #columnOptionsWrapper{display:block}
.column-options-menu{position:absolute;top:100%;left:0;margin-top:4px;background:white;border:1px solid #e8e8e8;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:8px 0;min-width:160px;z-index:100001;display:none}
#dy-drawer-wrap.dark-mode .column-options-menu{background:#2d2d2d;border-color:#404040}
.column-options-menu.show{display:block}
.column-option-item{display:flex;align-items:center;padding:8px 16px;cursor:pointer;transition:background 0.2s;font-size:14px}
.column-option-item:hover{background:#f5f5f5}
#dy-drawer-wrap.dark-mode .column-option-item:hover{background:#404040}
.column-option-item input{margin-right:8px;cursor:pointer}
.id-cell{font-family:monospace;font-size:11px;word-break:break-all;white-space:normal !important;overflow:visible !important;line-height:1.4}
th[data-col="create_time"],td[data-col="create_time"]{min-width:180px!important;width:180px!important;max-width:180px}
td[data-col="create_time"]{font-size:11px}
th[data-col="title"],td[data-col="title"]{min-width:280px!important;width:280px!important;max-width:280px}
th[data-col="operation"],td[data-col="operation"]{min-width:290px!important;width:290px!important;text-align:center;overflow:visible!important;text-overflow:clip!important}
#workTable tbody td.digg_count{font-size:11px!important}
#workTable tbody td.share_count{font-size:11px!important}
#workTable tbody td.comment_count{font-size:11px!important}
#workTable tbody td.collect_count{font-size:11px!important}
#workTable tbody td.promote_count{font-size:11px!important}
.dy-comment-link{color:#fe2c55 !important;cursor:pointer;font-weight:600;transition:color 0.2s}
.dy-comment-link:hover{color:#e5264c !important;text-decoration:underline}
#dy-drawer-wrap.dark-mode .dy-comment-link{color:#ff4d6a !important}
#dy-drawer-wrap.dark-mode .dy-comment-link:hover{color:#ff6b82 !important}
.action-btn{padding:2px 8px;border-radius:4px;font-size:12px;border:1px solid #e8e8e8;background:#f5f5f5;cursor:pointer;transition:all 0.2s;margin:0 2px}
.action-btn:hover{background:#e8e8e8}
.action-btn.delete{color:#fe2c55;border-color:#ffd1d9;background:#fff0f2}
.action-btn.delete:hover{background:#ffd1d9}
.action-btn.data{color:#1677ff;border-color:#d1e9ff;background:#f0f7ff}
.action-btn.data:hover{background:#d1e9ff}
.action-btn.download{color:#16a34a;border-color:#d1fae5;background:#f0fdf4}
.action-btn.download:hover{background:#d1fae5}
.action-btn.download:disabled{opacity:0.5;cursor:not-allowed}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.action-btn-spinner{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;vertical-align:middle;margin-right:3px}
#dy-drawer-wrap.dark-mode .action-btn{background:#2d2d2d;border-color:#404040;color:#e5e5e5}
#dy-drawer-wrap.dark-mode .action-btn.delete{color:#ff6b81;background:#3d2d2d;border-color:#5d4040}
#dy-drawer-wrap.dark-mode .action-btn.delete:hover{background:#5d4040}
#dy-drawer-wrap.dark-mode .action-btn.data{color:#4fa3ff;background:#2d3d4d;border-color:#405060}
#dy-drawer-wrap.dark-mode .action-btn.data:hover{background:#405060}
#dy-drawer-wrap.dark-mode .action-btn.download{color:#4ade80;background:#1a3d2d;border-color:#2d5d40}
#dy-drawer-wrap.dark-mode .action-btn.download:hover{background:#2d5d40}
#dy-drawer-wrap.dark-mode td[data-col="type"] .bg-purple-50{background-color:#2d1a3d !important;color:#c084fc !important}
#dy-drawer-wrap.dark-mode td[data-col="type"] .bg-blue-50{background-color:#1a2a3d !important;color:#93c5fd !important}
#dy-drawer-wrap.dark-mode td[data-col="tags"] .bg-blue-50{background-color:#1a2a3d !important}
#dy-drawer-wrap.dark-mode td[data-col="tags"] .text-blue-700{color:#93c5fd !important}
.json-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:100002;display:none;align-items:center;justify-content:center;padding:20px}
.json-modal-overlay.show{display:flex}
.json-modal-content{background:white;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.2);width:90%;max-width:900px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden}
#dy-drawer-wrap.dark-mode .json-modal-content{background:#2d2d2d;color:#e5e5e5}
.json-modal-header{padding:16px 20px;border-bottom:1px solid #e8e8e8;display:flex;justify-content:space-between;align-items:center}
#dy-drawer-wrap.dark-mode .json-modal-header{border-color:#404040}
.json-modal-title{font-weight:600;font-size:16px}
.json-modal-actions{display:flex;align-items:center;gap:8px}
.json-modal-btn{padding:6px 12px;border-radius:6px;font-size:13px;border:1px solid #e8e8e8;background:#f5f5f5;cursor:pointer;transition:all 0.2s}
.json-modal-btn:hover{background:#e8e8e8}
#dy-drawer-wrap.dark-mode .json-modal-btn{background:#404040;border-color:#555555;color:#e5e5e5}
#dy-drawer-wrap.dark-mode .json-modal-btn:hover{background:#555555}
.json-modal-close{font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:4px;transition:background 0.2s}
.json-modal-close:hover{background:#f5f5f5}
#dy-drawer-wrap.dark-mode .json-modal-close:hover{background:#404040}
.json-modal-body{padding:20px;overflow:auto;flex:1}
.json-modal-body pre{margin:0;font-family:'SF Mono',Monaco,'Courier New',monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#333}
#dy-drawer-wrap.dark-mode .json-modal-body pre{color:#e5e5e5}
.video-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:200000;display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.video-modal-overlay.show{display:flex}
.video-modal-content{position:relative;max-width:90vw;max-height:90vh;border-radius:12px;overflow:hidden;background:#000;box-shadow:0 8px 48px rgba(0,0,0,0.5)}
.video-modal-close{position:absolute;top:12px;right:16px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.2);border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:10;transition:background 0.2s;line-height:1}
.video-modal-close:hover{background:rgba(255,255,255,0.4)}
.video-modal-content video{display:block;max-width:90vw;max-height:90vh;border-radius:12px}
.cover-wrapper{cursor:pointer;position:relative}
.cover-wrapper::after{content:'';position:absolute;inset:0;background:rgba(0,0,0,0);transition:background 0.2s;border-radius:6px}
.cover-wrapper:hover::after{background:rgba(0,0,0,0.2)}
.cover-wrapper .play-icon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);opacity:0;transition:opacity 0.2s;z-index:2}
.cover-wrapper:hover .play-icon{opacity:1}
.image-slideshow-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:200001;display:none;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
.image-slideshow-overlay.show{display:flex}
.image-slideshow-container{position:relative;max-width:90vw;max-height:90vh;display:flex;align-items:center;justify-content:center}
.image-slideshow-img{max-width:85vw;max-height:85vh;border-radius:8px;object-fit:contain;box-shadow:0 8px 48px rgba(0,0,0,0.6);transition:opacity 0.3s}
.image-slideshow-btn{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;z-index:10}
.image-slideshow-btn:hover{background:rgba(255,255,255,0.35)}
.image-slideshow-prev{left:-56px}
.image-slideshow-next{right:-56px}
.image-slideshow-close{position:absolute;top:-40px;right:-8px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;z-index:10;line-height:1}
.image-slideshow-close:hover{background:rgba(255,255,255,0.35)}
.image-slideshow-dots{position:absolute;bottom:-36px;left:50%;transform:translateX(-50%);display:flex;gap:8px}
.image-slideshow-dot{width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,0.3);border:none;cursor:pointer;padding:0;transition:background 0.2s,transform 0.2s}
.image-slideshow-dot.active{background:#fe2c55;transform:scale(1.2)}
.image-slideshow-music-info{position:absolute;bottom:-60px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;color:rgba(255,255,255,0.7);font-size:13px;white-space:nowrap}
.image-slideshow-music-info .music-note{animation:musicBounce 0.6s infinite alternate;display:inline-block}
@keyframes musicBounce{from{transform:translateY(0)}
to{transform:translateY(-4px)}
}.image-slideshow-counter{position:absolute;top:-40px;left:0;color:rgba(255,255,255,0.7);font-size:14px;font-variant-numeric:tabular-nums}
.export-video-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:100003;display:none;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.export-video-overlay.show{display:flex}
.export-video-panel{background:#fff;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,0.25);width:420px;padding:28px 32px;display:flex;flex-direction:column;gap:16px;animation:exportVideoFadeIn 0.25s ease}
#dy-drawer-wrap.dark-mode .export-video-panel{background:#2d2d2d;color:#e5e5e5}
@keyframes exportVideoFadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.export-video-title{font-size:16px;font-weight:600;color:#1a1a1a;display:flex;align-items:center;gap:8px}
#dy-drawer-wrap.dark-mode .export-video-title{color:#e5e5e5}
.export-video-progress-wrap{display:flex;flex-direction:column;gap:8px}
.export-video-progress-bar{width:100%;height:8px;background:#eee;border-radius:4px;overflow:hidden}
#dy-drawer-wrap.dark-mode .export-video-progress-bar{background:#404040}
.export-video-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#fe2c55,#ff6b81);border-radius:4px;transition:width 0.3s}
.export-video-progress-text{font-size:13px;color:#666;text-align:center;min-height:20px}
#dy-drawer-wrap.dark-mode .export-video-progress-text{color:#aaa}
.export-video-count{font-size:12px;color:#999;text-align:center}
#dy-drawer-wrap.dark-mode .export-video-count{color:#777}
.export-video-btn-row{display:flex;gap:10px;justify-content:center;margin-top:4px}
.export-video-btn{padding:8px 20px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid #e8e8e8;background:#f5f5f5;transition:all 0.2s}
.export-video-btn:hover{background:#eee}
.export-video-btn.primary{background:#fe2c55;color:#fff;border-color:#fe2c55}
.export-video-btn.primary:hover{background:#e5264c}
.export-video-btn:disabled{opacity:0.5;cursor:not-allowed}
.clip-modal-form{display:flex;flex-direction:column;gap:14px}.clip-field{display:flex;flex-direction:column;gap:6px}.clip-field label{font-size:13px;font-weight:600;color:#333}.clip-field input,.clip-field textarea{width:100%;border:1px solid #d1d5db;border-radius:7px;padding:9px 10px;font-size:13px;color:#222;background:#fff;outline:none}.clip-field textarea{min-height:74px;resize:vertical;line-height:1.45}.clip-field input:focus,.clip-field textarea:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.12)}.clip-time-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.clip-hint{font-size:12px;color:#6b7280;line-height:1.55}.clip-status{min-height:20px;font-size:13px;color:#4b5563}.clip-status.error{color:#dc2626}.clip-actions{display:flex;justify-content:flex-end;gap:9px}.clip-actions button{padding:8px 16px;border-radius:7px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:13px}.clip-actions .primary{border-color:#2563eb;background:#2563eb;color:#fff;font-weight:600}.clip-actions button:disabled{opacity:.55;cursor:default}#dy-drawer-wrap.dark-mode .clip-field label{color:#e5e5e5}#dy-drawer-wrap.dark-mode .clip-field input,#dy-drawer-wrap.dark-mode .clip-field textarea{background:#222;color:#e5e5e5;border-color:#555}#dy-drawer-wrap.dark-mode .clip-hint,#dy-drawer-wrap.dark-mode .clip-status{color:#aaa}
/* ====== AI 文案拆解弹窗 ====== */
.ai-analysis-btn{color:#fff;background:#7c3aed;border-color:#7c3aed;font-weight:600;width:76px;min-width:76px;max-width:76px;white-space:nowrap;overflow:hidden;text-overflow:clip;display:inline-flex;align-items:center;justify-content:center;gap:4px;vertical-align:middle}
.ai-analysis-btn:disabled{opacity:0.5;cursor:not-allowed}
.ai-analysis-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100004;display:none;align-items:flex-start;justify-content:center;padding:40px 20px 20px;overflow-y:auto}
.ai-analysis-overlay.show{display:flex}
.ai-analysis-card{background:#fff;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,0.25);width:90%;max-width:720px;display:flex;flex-direction:column;overflow:hidden;margin-bottom:20px}
.ai-analysis-header{padding:16px 20px;border-bottom:1px solid #e8e8e8;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
.ai-analysis-title{font-weight:600;font-size:16px}
.ai-analysis-close{font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:4px;transition:background 0.2s;border:none;background:transparent}
.ai-analysis-close:hover{background:#f5f5f5}
.ai-analysis-body{padding:20px;overflow:auto;flex:1}
.ai-analysis-section{margin-bottom:18px}
.ai-analysis-section h3{font-size:14px;font-weight:600;color:#333;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.ai-analysis-section p{font-size:13px;color:#555;line-height:1.6;margin:4px 0}
.ai-analysis-tags{display:flex;flex-wrap:wrap;gap:6px}
.ai-analysis-tag{display:inline-block;padding:3px 12px;border-radius:14px;font-size:12px;background:#f5f3ff;color:#7c3aed;white-space:nowrap}
.ai-analysis-summary{font-size:15px!important;font-weight:600;color:#7c3aed!important;padding:10px 14px;background:#f5f3ff;border-radius:8px;border-left:3px solid #7c3aed}
.ai-analysis-table{width:100%;border-collapse:collapse;margin-top:8px;border:1px solid #eee;border-radius:8px;overflow:hidden;table-layout:fixed}
.ai-analysis-table th,.ai-analysis-table td{border-bottom:1px solid #eee;padding:10px 12px;font-size:13px;line-height:1.55;text-align:left;vertical-align:top;white-space:normal;word-break:break-word}
.ai-analysis-table th{width:110px;background:#fafafa;color:#333;font-weight:600}
.ai-analysis-table tr:last-child th,.ai-analysis-table tr:last-child td{border-bottom:none}
.ai-analysis-empty{color:#999;font-size:13px;padding:12px;background:#fafafa;border-radius:8px}
/* dark mode */
#dy-drawer-wrap.dark-mode .ai-analysis-card{background:#2d2d2d;color:#e5e5e5}
#dy-drawer-wrap.dark-mode .ai-analysis-header{border-color:#404040}
#dy-drawer-wrap.dark-mode .ai-analysis-section h3{color:#e5e5e5}
#dy-drawer-wrap.dark-mode .ai-analysis-section p{color:#bbb}
#dy-drawer-wrap.dark-mode .ai-analysis-tag{background:#3d2d5d;color:#c4b5fd}
#dy-drawer-wrap.dark-mode .ai-analysis-summary{background:#2d1f4e;color:#c4b5fd!important;border-left-color:#7c3aed}
#dy-drawer-wrap.dark-mode .ai-analysis-table{border-color:#404040}
#dy-drawer-wrap.dark-mode .ai-analysis-table th,#dy-drawer-wrap.dark-mode .ai-analysis-table td{border-color:#404040}
#dy-drawer-wrap.dark-mode .ai-analysis-table th{background:#333;color:#e5e5e5}
#dy-drawer-wrap.dark-mode .ai-analysis-empty{background:#333;color:#aaa}
#dy-drawer-wrap.dark-mode .ai-analysis-close:hover{background:#404040}
/* ====== 仪表盘视图 ====== */
.dashboard-container{display:none;flex:1;overflow:auto;padding:16px 24px;background:#f5f6f7}
#dy-drawer-wrap.dark-mode .dashboard-container{background:#1a1a1a}
#dy-drawer-wrap.dashboard-view .dashboard-container{display:block}
#dy-drawer-wrap.dashboard-view #workTable{display:none}
#dy-drawer-wrap.dashboard-view .grid-view-container{display:none}
#dy-drawer-wrap.dashboard-view #columnOptionsWrapper{display:none}
.dash-summary-cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}
.dash-card{background:#fff;border-radius:10px;padding:16px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.06);transition:transform 0.15s}
.dash-card:hover{transform:translateY(-2px)}
#dy-drawer-wrap.dark-mode .dash-card{background:#2d2d2d;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
.dash-card-value{font-size:24px;font-weight:700;color:#1a1a1a;line-height:1.2}
#dy-drawer-wrap.dark-mode .dash-card-value{color:#e5e5e5}
.dash-card-label{font-size:12px;color:#999;margin-top:4px}
.dash-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.dash-section{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
#dy-drawer-wrap.dark-mode .dash-section{background:#2d2d2d;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
.dash-section-title{font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #eee}
#dy-drawer-wrap.dark-mode .dash-section-title{color:#e5e5e5;border-color:#404040}
.dash-rank-item{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5;font-size:12px}
#dy-drawer-wrap.dark-mode .dash-rank-item{border-color:#3a3a3a}
.dash-rank-item:last-child{border-bottom:none}
.dash-rank-num{width:20px;text-align:center;font-weight:700;color:#999;flex-shrink:0}
.dash-rank-num.top3{color:#fe2c55}
.dash-rank-cover{width:32px;height:42px;border-radius:4px;object-fit:cover;flex-shrink:0;background:#eee}
.dash-rank-info{flex:1;min-width:0;overflow:hidden}
.dash-rank-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#333;line-height:1.3}
#dy-drawer-wrap.dark-mode .dash-rank-title{color:#e5e5e5}
.dash-rank-val{color:#999;font-size:11px;margin-top:2px}
.dash-dist-item{display:flex;align-items:center;padding:10px 0;gap:12px}
.dash-dist-icon{font-size:20px;flex-shrink:0}
.dash-dist-info{flex:1}
.dash-dist-name{font-size:13px;font-weight:500;color:#333}
#dy-drawer-wrap.dark-mode .dash-dist-name{color:#e5e5e5}
.dash-dist-detail{font-size:11px;color:#999;margin-top:2px}
.dash-dist-bar-wrap{flex:1;min-width:60px;height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden;align-self:center}
#dy-drawer-wrap.dark-mode .dash-dist-bar-wrap{background:#404040}
.dash-dist-bar{height:100%;border-radius:3px;transition:width .4s ease}
.dash-dist-bar.video{background:linear-gradient(90deg,#fe2c55,#ff6b81)}
.dash-dist-bar.image{background:linear-gradient(90deg,#4fa3ff,#7fc4ff)}
.dash-dist-pct{font-size:12px;font-weight:600;color:#333;flex-shrink:0;text-align:right;min-width:36px}
#dy-drawer-wrap.dark-mode .dash-dist-pct{color:#e5e5e5}
/* ====== 仪表盘图表容器 ====== */
.dash-chart-wrap{position:relative;width:100%}
.dash-chart-wrap-pie{max-width:220px;margin:0 auto}
.dash-chart-wrap-bar{height:220px}
.dash-chart-wrap-hbar{height:300px}
.dash-section-full{grid-column:1/-1}
/* ====== 对比视图 ====== */
.compare-container{display:none;flex:1;overflow:auto;padding:20px 24px;background:#f5f6f7}
#dy-drawer-wrap.dark-mode .compare-container{background:#1a1a1a}
#dy-drawer-wrap.compare-view .compare-container{display:block}
#dy-drawer-wrap.compare-view #workTable{display:none}
#dy-drawer-wrap.compare-view .grid-view-container{display:none}
#dy-drawer-wrap.compare-view #columnOptionsWrapper{display:none}
.compare-header{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.compare-card{flex:1;min-width:140px;max-width:220px;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);text-align:center}
#dy-drawer-wrap.dark-mode .compare-card{background:#2d2d2d}
.compare-card-cover{width:100%;aspect-ratio:9/16;object-fit:cover;background:#eee}
.compare-card-title{font-size:12px;color:#333;padding:8px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dy-drawer-wrap.dark-mode .compare-card-title{color:#e5e5e5}
.compare-no-select{text-align:center;padding:80px 20px;color:#999;font-size:14px}
.compare-table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
#dy-drawer-wrap.dark-mode .compare-table{background:#2d2d2d}
.compare-table th,.compare-table td{padding:10px 14px;text-align:center;font-size:13px;border-bottom:1px solid #eee}
#dy-drawer-wrap.dark-mode .compare-table th,#dy-drawer-wrap.dark-mode .compare-table td{border-color:#404040}
.compare-table th{background:#fafafa;font-weight:600;color:#666;white-space:nowrap}
#dy-drawer-wrap.dark-mode .compare-table th{background:#333;color:#aaa}
.compare-table tr:hover td{background:#fafafa}
#dy-drawer-wrap.dark-mode .compare-table tr:hover td{background:#333}
.compare-metric{text-align:left;font-weight:500;color:#333;white-space:nowrap}
#dy-drawer-wrap.dark-mode .compare-metric{color:#e5e5e5}
.compare-highlight{color:#fe2c55;font-weight:700;position:relative}
.compare-highlight::after{content:'👑';font-size:10px;position:absolute;top:-8px;left:50%;transform:translateX(-50%)}
/* ====== 时间线视图 ====== */
.timeline-container{display:none;flex:1;overflow:auto;padding:20px 28px;background:#f5f6f7}
#dy-drawer-wrap.dark-mode .timeline-container{background:#1a1a1a}
#dy-drawer-wrap.timeline-view .timeline-container{display:block}
#dy-drawer-wrap.timeline-view #workTable{display:none}
#dy-drawer-wrap.timeline-view .grid-view-container{display:none}
#dy-drawer-wrap.timeline-view #columnOptionsWrapper{display:none}
.timeline-month-group{margin-bottom:24px}
.timeline-month-header{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:10px 16px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
#dy-drawer-wrap.dark-mode .timeline-month-header{background:#2d2d2d}
.timeline-month-label{font-size:15px;font-weight:700;color:#1a1a1a}
#dy-drawer-wrap.dark-mode .timeline-month-label{color:#e5e5e5}
.timeline-month-stats{font-size:12px;color:#999;margin-left:auto}
.timeline-list{position:relative;padding-left:28px}
.timeline-list::before{content:'';position:absolute;left:10px;top:4px;bottom:4px;width:2px;background:#e0e0e0;border-radius:1px}
#dy-drawer-wrap.dark-mode .timeline-list::before{background:#404040}
.timeline-item{position:relative;display:flex;align-items:flex-start;gap:12px;padding:10px 14px;margin-bottom:8px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.05);transition:box-shadow 0.15s}
.timeline-item:hover{box-shadow:0 2px 8px rgba(0,0,0,0.1)}
#dy-drawer-wrap.dark-mode .timeline-item{background:#2d2d2d}
#dy-drawer-wrap.dark-mode .timeline-item:hover{box-shadow:0 2px 8px rgba(0,0,0,0.4)}
.timeline-dot{position:absolute;left:-22px;top:14px;width:10px;height:10px;border-radius:50%;background:#fe2c55;border:2px solid #fff;flex-shrink:0;z-index:1}
#dy-drawer-wrap.dark-mode .timeline-dot{border-color:#2d2d2d}
.timeline-thumb{width:56px;height:74px;border-radius:4px;object-fit:cover;flex-shrink:0;background:#eee}
.timeline-info{flex:1;min-width:0}
.timeline-time{font-size:11px;color:#999;margin-bottom:2px}
.timeline-title{font-size:13px;color:#333;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:6px}
#dy-drawer-wrap.dark-mode .timeline-title{color:#e5e5e5}
.timeline-stats{display:flex;gap:10px;font-size:11px;color:#999}
.timeline-stat{display:flex;align-items:center;gap:2px}
.analysis-mode-switch{display:flex;align-items:center;padding:3px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px}
.analysis-mode-btn{border:0;background:transparent;color:#6b7280;padding:6px 11px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer}
.analysis-mode-btn.active{background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.12)}
#dy-drawer-wrap.dark-mode .analysis-mode-switch{background:#242424;border-color:#404040}
#dy-drawer-wrap.dark-mode .analysis-mode-btn.active{background:#3a3a3a;color:#fff}
.self-only{display:none!important}
#dy-drawer-wrap.self-analysis th.self-only,#dy-drawer-wrap.self-analysis td.self-only{display:table-cell!important}
#dy-drawer-wrap.self-analysis .self-only:not(th):not(td){display:inline-flex!important}
.play-coverage{font-size:12px;color:#0f766e;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;padding:5px 9px;white-space:nowrap}
.metric-missing{color:#9ca3af;font-weight:400}
#workTable th[data-col="play_count"],#workTable td[data-col="play_count"]{width:120px!important;min-width:120px!important;max-width:120px;white-space:nowrap}
#workTable th[data-col="engagement_rate"],#workTable td[data-col="engagement_rate"]{width:130px!important;min-width:130px!important;max-width:130px;white-space:nowrap}
#workTable th[data-col="play_count"] .sort-icon,#workTable th[data-col="engagement_rate"] .sort-icon{flex-shrink:0}
        `;
        document.head.appendChild(style);

        // Hide the in-page floating entry; use popup as the only visible entry.
        const btn = document.createElement("button");
        btn.id = "dy-drawer-btn";
        btn.type = "button";
        btn.style.display = "none";
        document.body.appendChild(btn);

        // 毛玻璃遮罩层
        const mask = document.createElement("div");
        mask.id = "dy-drawer-mask";
        document.body.appendChild(mask);

        // 抽屉容器
        const wrap = document.createElement("div");
        wrap.id = "dy-drawer-wrap";
        wrap.className = "fixed right-[-1200px] top-0 w-[1180px] h-screen bg-white shadow-[-4px_0_24px_rgba(0,0,0,0.12)] z-[100000] flex flex-col rounded-l-2xl";
        wrap.innerHTML = `
            <!-- 顶部头部 -->
            <div class="drawer-header flex justify-between items-center px-6 py-4 border-b border-dy-border shrink-0 bg-white">
                <div class="flex items-center gap-3">
                    <h3 class="text-lg font-semibold text-dy-text m-0" id="drawerMainTitle">对标账号作品数据</h3>
                    <div class="analysis-mode-switch">
                        <button type="button" class="analysis-mode-btn" data-analysis-mode="benchmark">对标分析</button>
                        <button type="button" class="analysis-mode-btn" data-analysis-mode="self">我的账号</button>
                    </div>
                    <span class="play-coverage self-only" id="selfPlayCoverage">播放量 0/0</span>
                </div>
                <div class="flex items-center gap-3">                    <button id="themeToggleBtn" class="flex items-center gap-2 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>
                        </svg>
                        深色模式
                    </button>
                    <button id="reloadParseBtn" class="flex items-center gap-2 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        重新解析
                    </button>
                    <span id="fullscreenBtn" class="text-gray-400 text-lg cursor-pointer hover:text-dy-red transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100" title="全屏">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
                    </span>
                    <span class="drawer-close text-gray-400 text-2xl cursor-pointer hover:text-dy-red transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100">&times;</span>
                </div>
            </div>

            <!-- 用户信息卡片 -->
            <div class="drawer-user-info px-6 py-4 border-b border-dy-border text-sm shrink-0" id="userInfoBox">
                <div class="flex items-center gap-3">
                    <div class="loading-shimmer w-12 h-12 rounded-full"></div>
                    <div class="flex-1">
                        <div class="loading-shimmer h-4 w-48 rounded mb-2"></div>
                        <div class="loading-shimmer h-3 w-64 rounded"></div>
                    </div>
                </div>
            </div>

            <!-- 加载进度条（默认隐藏） -->
            <div class="loading-progress px-6 py-3 border-b border-dy-border shrink-0" id="loadingProgress" style="display: none;">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-medium text-dy-text" id="loadingStatusText">正在加载作品数据...</span>
                    <span class="text-sm text-dy-text-secondary" id="loadingCountText">0 / 0</span>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar-fill" id="progressBarFill"></div>
                </div>
            </div>

            <!-- 工具栏（包含搜索框和列选项） -->
            <div class="drawer-toolbar px-6 py-3 border-b border-dy-border flex gap-3 flex-wrap items-center shrink-0 bg-white">
                <button id="selectAll" class="flex items-center gap-2 bg-dy-bg hover:bg-blue-50 hover:text-blue-600 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border hover:border-blue-300">
                    全选
                </button>
                <button id="cancelAll" class="flex items-center gap-2 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border">
                    取消全选
                </button>
                <div class="export-dropdown" id="exportDropdown">
                    <button class="export-dropdown-btn" id="exportDropdownBtn">
                        导出数据 (<span id="selCount">0</span>) <span class="arrow">▾</span>
                    </button>
                    <div class="export-dropdown-menu" id="exportDropdownMenu">
                        <button class="export-dropdown-item" data-format="json" data-scope="selected">JSON</button>
                        <button class="export-dropdown-item" data-format="csv" data-scope="selected">CSV</button>
                        <button class="export-dropdown-item" data-format="txt" data-scope="selected">TXT</button>
                    </div>
                </div>
                
                <!-- 视图切换 -->
                <div class="relative" id="viewSwitchWrapper">
                    <button id="viewSwitchBtn" class="flex items-center gap-2 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border">
                        <svg class="w-4 h-4 view-switch-icon-table" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                        </svg>
                        <svg class="w-4 h-4 view-switch-icon-grid" style="display:none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path>
                        </svg>
                        <svg class="w-4 h-4 view-switch-icon-dashboard" style="display:none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                        </svg>
                        <svg class="w-4 h-4 view-switch-icon-compare" style="display:none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"></path>
                        </svg>
                        <svg class="w-4 h-4 view-switch-icon-timeline" style="display:none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                        <span id="viewSwitchLabel">表格视图</span>
                        <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                        </svg>
                    </button>
                    <div class="view-switch-menu" id="viewSwitchMenu">
                        <div class="view-switch-item" id="viewTableBtn" data-view="table">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                            </svg>
                            表格视图
                        </div>
                        <div class="view-switch-item" id="viewGridBtn" data-view="grid">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path>
                            </svg>
                            网格视图
                        </div>
                        <div class="view-switch-divider" style="height:1px;background:#eee;margin:4px 12px"></div>
                        <div class="view-switch-item" id="viewDashboardBtn" data-view="dashboard">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                            </svg>
                            仪表盘
                        </div>
                        <div class="view-switch-item" id="viewCompareBtn" data-view="compare">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"></path>
                            </svg>
                            对比视图
                        </div>
                        <div class="view-switch-item" id="viewTimelineBtn" data-view="timeline">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                            时间线
                        </div>
                    </div>
                </div>

                <!-- 列选项按钮 -->
                <div class="relative" id="columnOptionsWrapper">
                    <button id="columnOptionsBtn" class="flex items-center gap-2 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"></path>
                        </svg>
                        列选项
                    </button>
                    <div class="column-options-menu" id="columnOptionsMenu">
                        <div class="column-option-item">
                            <input type="checkbox" id="col-cover" checked data-col="cover">
                            <label for="col-cover">封面</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-title" checked data-col="title">
                            <label for="col-title">标题</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-tags" data-col="tags">
                            <label for="col-tags">标签</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-type" data-col="type">
                            <label for="col-type">类型</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-create-time" checked data-col="create_time">
                            <label for="col-create-time">发布时间</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-digg" checked disabled data-col="digg_count">
                            <label for="col-digg">点赞</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-share" checked disabled data-col="share_count">
                            <label for="col-share">分享</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-comment" checked disabled data-col="comment_count">
                            <label for="col-comment">评论</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-collect" checked disabled data-col="collect_count">
                            <label for="col-collect">收藏</label>
                        </div>
                        <div class="column-option-item">
                            <input type="checkbox" id="col-promote" checked disabled data-col="promote_count">
                            <label for="col-promote">推荐</label>
                        </div>
                        <div class="column-option-item self-only">
                            <input type="checkbox" id="col-play" checked disabled data-col="play_count">
                            <label for="col-play">播放量</label>
                        </div>
                        <div class="column-option-item self-only">
                            <input type="checkbox" id="col-engagement" checked disabled data-col="engagement_rate">
                            <label for="col-engagement">互动率</label>
                        </div>
                    </div>
                </div>

                <!-- 搜索框移到右侧 -->
                <div class="ml-auto flex items-center gap-2">
                    <input 
                        type="text"
                        placeholder="搜索作品ID或标题..." 
                        id="searchInput" 
                        class="px-4 py-2 border border-dy-border rounded-lg focus:outline-none focus:ring-2 focus:ring-dy-red/20 focus:border-dy-red text-sm transition-all duration-200"
                    />
                    <button id="searchBtn" class="flex items-center gap-2 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border">搜索</button>
                    <button id="resetSearch" class="bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 btn-press border border-dy-border">重置</button>
                </div>
            </div>

            <!-- 表格容器 -->
            <div class="drawer-table-box flex-1 overflow-auto bg-dy-bg" style="min-width:0;">
                <table id="workTable" class="w-full border-collapse text-sm">
                    <thead class="sticky top-0 z-10">
                        <tr class="bg-white shadow-sm">
                            <th width="30" class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text bg-white" data-col="select">选择</th>
                            <th class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text bg-white" data-col="id" >ID</th>
                            <th class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text bg-white" data-col="cover" >封面</th>
                            <th class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text bg-white" data-col="title" >标题</th>
                            <th class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text bg-white" data-col="tags" >标签</th>
                            <th class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text bg-white" data-col="type" >类型</th>
                            <th data-sort="create_time" class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="create_time" >
                                <div class="flex items-center justify-center gap-1">
                                    <span>发布时间</span>
                                    <div class="sort-icon flex flex-col items-center text-[10px] leading-[1]">
                                        <span class="sort-up text-gray-300">▲</span>
                                        <span class="sort-down text-gray-300">▼</span>
                                    </div>
                                </div>
                            </th>
                            <th data-sort="digg_count" class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="digg_count">
                                <div class="flex items-center justify-center gap-1">
                                    <span>点赞</span>
                                    <div class="sort-icon flex flex-col items-center text-[10px] leading-[1]">
                                        <span class="sort-up text-gray-300">▲</span>
                                        <span class="sort-down text-gray-300">▼</span>
                                    </div>
                                </div>
                            </th>
                            <th data-sort="share_count" class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="share_count">
                                <div class="flex items-center justify-center gap-1">
                                    <span>分享</span>
                                    <div class="sort-icon flex flex-col items-center text-[10px] leading-[1]">
                                        <span class="sort-up text-gray-300">▲</span>
                                        <span class="sort-down text-gray-300">▼</span>
                                    </div>
                                </div>
                            </th>
                            <th data-sort="comment_count" class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="comment_count">
                                <div class="flex items-center justify-center gap-1">
                                    <span>评论</span>
                                    <div class="sort-icon flex flex-col items-center text-[10px] leading-[1]">
                                        <span class="sort-up text-gray-300">▲</span>
                                        <span class="sort-down text-gray-300">▼</span>
                                    </div>
                                </div>
                            </th>
                            <th data-sort="collect_count" class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="collect_count">
                                <div class="flex items-center justify-center gap-1">
                                    <span>收藏</span>
                                    <div class="sort-icon flex flex-col items-center text-[10px] leading-[1]">
                                        <span class="sort-up text-gray-300">▲</span>
                                        <span class="sort-down text-gray-300">▼</span>
                                    </div>
                                </div>
                            </th>
                            <th data-sort="promote_count" class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="promote_count">
                                <div class="flex items-center justify-center gap-1">
                                    <span>推荐</span>
                                    <div class="sort-icon flex flex-col items-center text-[10px] leading-[1]">
                                        <span class="sort-up text-gray-300">▲</span>
                                        <span class="sort-down text-gray-300">▼</span>
                                    </div>
                                </div>
                            </th>
                            <th data-sort="play_count" class="self-only border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="play_count"><div class="flex items-center justify-center gap-1"><span>播放量</span><div class="sort-icon flex flex-col items-center text-[10px] leading-[1]"><span class="sort-up text-gray-300">▲</span><span class="sort-down text-gray-300">▼</span></div></div></th>
                            <th data-sort="engagement_rate" class="self-only border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text cursor-pointer hover:bg-gray-50 transition-colors bg-white" data-col="engagement_rate"><div class="flex items-center justify-center gap-1"><span>互动率</span><div class="sort-icon flex flex-col items-center text-[10px] leading-[1]"><span class="sort-up text-gray-300">▲</span><span class="sort-down text-gray-300">▼</span></div></div></th>
                            <th class="border-b-2 border-dy-border px-3 py-3 text-center select-none font-semibold text-dy-text bg-white" data-col="operation">操作</th>
                        </tr>
                    </thead>
                    <tbody id="tableBody">
                        <tr>
                            <td colspan="14" class="px-3 py-12 text-center text-gray-400">
                                <div class="flex flex-col items-center gap-3">
                                    <svg class="w-12 h-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                                    </svg>
                                    <span class="text-base">正在加载作品数据...</span>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>

                <!-- 网格视图容器 -->
                <div class="grid-view-container" id="gridViewContainer"></div>

                <!-- 仪表盘容器 -->
                <div class="dashboard-container" id="dashboardContainer"></div>

                <!-- 对比视图容器 -->
                <div class="compare-container" id="compareContainer"></div>

                <!-- 时间线容器 -->
                <div class="timeline-container" id="timelineContainer"></div>
            </div>

            <!-- 分页栏 -->
            <div class="page-bar px-6 py-4 border-t-2 border-dy-border flex gap-3 items-center shrink-0 text-sm bg-white justify-between">
                <div class="flex items-center gap-4 text-dy-text-secondary">
                    <span>筛选后共 <span id="totalNum" class="font-semibold text-dy-text">0</span> 条</span>
                    <span>每页
                        <select id="pageSizeSelect" class="mx-1 px-2 py-0.5 rounded border border-dy-border bg-white text-dy-text text-sm font-medium cursor-pointer focus:outline-none focus:border-dy-red transition-colors hover:border-gray-300">
                            ${[20, 50, 100, 200, 500].map(n => `<option value="${n}" ${pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
                        </select>条</span>
                    <span>共 <span id="totalPageNum" class="font-semibold text-dy-text">0</span> 页</span>
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-dy-text-secondary">当前第</span>
                    <span id="currentPageShow" class="font-semibold text-dy-red text-base">1</span>
                    <span class="text-dy-text-secondary">/</span>
                    <span id="pageMaxShow" class="font-semibold text-dy-text">1</span>
                    <span class="text-dy-text-secondary">页</span>
                    <button id="prevPage" class="flex items-center gap-1 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg transition-all duration-200 btn-press border border-dy-border font-medium">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
                        </svg>
                        上一页
                    </button>
                    <button id="nextPage" class="flex items-center gap-1 bg-dy-bg hover:bg-gray-200 px-4 py-2 rounded-lg transition-all duration-200 btn-press border border-dy-border font-medium">
                        下一页
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                        </svg>
                    </button>
                </div>
            </div>

            <!-- JSON 数据弹窗 -->
            <div class="json-modal-overlay" id="jsonModalOverlay">
                <div class="json-modal-content">
                    <div class="json-modal-header">
                        <span class="json-modal-title" id="jsonModalTitle">JSON 数据</span>
                        <div class="json-modal-actions">
                            <button class="json-modal-btn" id="jsonModalCopy">复制</button>
                            <span class="json-modal-close" id="jsonModalClose">&times;</span>
                        </div>
                    </div>
                    <div class="json-modal-body">
                        <pre id="jsonModalPre"></pre>
                    </div>
                </div>
            </div>

            <!-- 视频播放弹窗 -->
            <div class="video-modal-overlay" id="videoModalOverlay">
                <div class="video-modal-content">
                    <button class="video-modal-close" id="videoModalClose">&times;</button>
                    <video id="videoPlayer" controls autoplay playsinline></video>
                </div>
            </div>

            <!-- 图片幻灯片弹窗 -->
            <div class="image-slideshow-overlay" id="imageSlideshowOverlay">
                <div class="image-slideshow-container" id="imageSlideshowContainer">
                    <button class="image-slideshow-close" id="imageSlideshowClose">&times;</button>
                    <button class="image-slideshow-btn image-slideshow-prev" id="imageSlideshowPrev">&#10094;</button>
                    <img class="image-slideshow-img" id="imageSlideshowImg" src="" alt="图片">
                    <button class="image-slideshow-btn image-slideshow-next" id="imageSlideshowNext">&#10095;</button>
                    <div class="image-slideshow-counter" id="imageSlideshowCounter"></div>
                    <div class="image-slideshow-dots" id="imageSlideshowDots"></div>
                    <div class="image-slideshow-music-info" id="imageSlideshowMusicInfo" style="display:none;">
                        <span class="music-note">&#9835;</span>
                        <span id="imageSlideshowMusicName"></span>
                    </div>
                </div>
                <audio id="imageSlideshowAudio" loop></audio>
            </div>

        `;
        document.body.appendChild(wrap);

        // 应用初始主题
        applyTheme();

        // 初始化视图模式
        switchView(currentView);

        // 视图切换下拉菜单
        const viewSwitchBtn = document.getElementById("viewSwitchBtn");
        const viewSwitchMenu = document.getElementById("viewSwitchMenu");

        viewSwitchBtn.onclick = (e) => {
            e.stopPropagation();
            viewSwitchMenu.classList.toggle("show");
        };

        // 点击页面其他地方关闭视图菜单
        document.addEventListener("click", (e) => {
            const wrapper = document.getElementById("viewSwitchWrapper");
            if (wrapper && !wrapper.contains(e.target)) {
                viewSwitchMenu.classList.remove("show");
            }
        });

        viewSwitchMenu.querySelectorAll(".view-switch-item").forEach(item => {
            item.onclick = () => {
                switchView(item.dataset.view);
                viewSwitchMenu.classList.remove("show");
            };
        });

        wrap.querySelectorAll('[data-analysis-mode]').forEach(button => {
            button.onclick = () => setAnalysisMode(button.dataset.analysisMode);
        });
        updateAnalysisModeUi();

        // 每页条数切换
        document.getElementById("pageSizeSelect").onchange = function() {
            pageSize = parseInt(this.value);
            localStorage.setItem('hankin-dy-page-size', pageSize);
            currentPage = 1;
            renderTable();
        };

        // Unified drawer toggle for popup and internal calls.
        window.__DcxzsToggleDrawer = function(forceOpen) {
            const drawer = document.getElementById("dy-drawer-wrap");
            const drawerMask = document.getElementById("dy-drawer-mask");
            if (!drawer) return { ok: false, msg: "drawer_not_ready" };
            const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !drawer.classList.contains("open");
            drawer.classList.toggle("open", shouldOpen);
            if (!shouldOpen) drawer.classList.remove("fullscreen");
            if (drawerMask) drawerMask.classList.toggle("show", shouldOpen && !drawer.classList.contains("fullscreen"));
            return { ok: true, open: shouldOpen };
        };

        window.__DcxzsCloseDrawer = function() {
            return window.__DcxzsToggleDrawer(false);
        };

        btn.onclick = () => window.__DcxzsToggleDrawer();
        wrap.querySelector(".drawer-close").onclick = () => window.__DcxzsCloseDrawer();
        // 全屏按钮
        document.getElementById("fullscreenBtn").onclick = () => {
            const isFull = wrap.classList.toggle("fullscreen");
            // 全屏时确保面板打开并隐藏遮罩
            if (isFull) {
                wrap.classList.add("open");
                mask.classList.remove("show");
            } else {
                mask.classList.toggle("show", wrap.classList.contains("open"));
            }
        };
        mask.onclick = () => window.__DcxzsCloseDrawer();
        
        // 打开类控制
        const styleOpen = document.createElement("style");
        styleOpen.textContent = `#dy-drawer-wrap.open{right:0}#dy-drawer-wrap.fullscreen{right:0 !important;left:0 !important;top:0 !important;bottom:0 !important;width:100% !important;border-radius:0 !important}#dy-drawer-wrap.fullscreen~#dy-drawer-mask{opacity:0 !important;pointer-events:none !important}`;
        document.head.appendChild(styleOpen);

        // 主题切换按钮
        document.getElementById("themeToggleBtn").onclick = toggleTheme;

        // 重新解析按钮事件
        document.getElementById("reloadParseBtn").onclick = async () => {
            if (isLoading) return alert("正在加载中，请稍后再试");
            allWorksList = [];
            filterWorks = [];
            selectedIds.clear();
            currentPage = 1;
            document.getElementById("tableBody").innerHTML = `
                <tr>
                    <td colspan="14" class="px-3 py-12 text-center text-gray-400">
                        <div class="flex flex-col items-center gap-3">
                            <svg class="w-12 h-12 text-gray-300 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                            </svg>
                            <span class="text-base">重新解析加载中...</span>
                        </div>
                    </td>
                </tr>`;
            document.getElementById("userInfoBox").innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="loading-shimmer w-12 h-12 rounded-full"></div>
                    <div class="flex-1">
                        <div class="loading-shimmer h-4 w-48 rounded mb-2"></div>
                        <div class="loading-shimmer h-3 w-64 rounded"></div>
                    </div>
                </div>`;
            await init();
        };

        // 列选项按钮事件（每次直接从 DOM 查询，避免变量引用问题）
        const columnOptionsBtn = document.getElementById("columnOptionsBtn");
        const columnOptionsMenu = document.getElementById("columnOptionsMenu");

        columnOptionsBtn.onclick = (e) => {
            e.stopPropagation();
            columnOptionsMenu.classList.toggle("show");
        };

        // 点击页面其他地方关闭菜单
        document.addEventListener("click", (e) => {
            const wrapper = document.getElementById("columnOptionsWrapper");
            if (wrapper && !wrapper.contains(e.target)) {
                columnOptionsMenu.classList.remove("show");
            }
        });

        // 列选项复选框事件
        columnOptionsMenu.querySelectorAll("input[type=checkbox]").forEach(cb => {
            if (alwaysVisibleColumns.has(cb.dataset.col)) {
                cb.checked = true;
                cb.disabled = true;
                columnVisibility[cb.dataset.col] = true;
            }
            cb.onchange = () => {
                const col = cb.dataset.col;
                if (alwaysVisibleColumns.has(col)) {
                    cb.checked = true;
                    columnVisibility[col] = true;
                    updateColumnVisibility();
                    return;
                }
                columnVisibility[col] = cb.checked;
                updateColumnVisibility();
            };
        });

        // JSON 弹窗事件
        const jsonModalOverlay = document.getElementById("jsonModalOverlay");
        const jsonModalClose = document.getElementById("jsonModalClose");
        const jsonModalCopy = document.getElementById("jsonModalCopy");
        if (jsonModalOverlay) {
            jsonModalOverlay.onclick = (e) => {
                if (e.target === jsonModalOverlay) hideJsonModal();
            };
        }
        if (jsonModalClose) jsonModalClose.onclick = hideJsonModal;
        if (jsonModalCopy) {
            jsonModalCopy.onclick = () => {
                const preEl = document.getElementById("jsonModalPre");
                if (!preEl) return;
                navigator.clipboard.writeText(preEl.textContent).then(() => {
                    const originalText = jsonModalCopy.textContent;
                    jsonModalCopy.textContent = "已复制";
                    setTimeout(() => jsonModalCopy.textContent = originalText, 1500);
                }).catch(() => alert("复制失败，请手动复制"));
            };
        }

        // 视频播放弹窗事件
        const videoModalOverlay = document.getElementById("videoModalOverlay");
        const videoModalClose = document.getElementById("videoModalClose");
        const videoPlayer = document.getElementById("videoPlayer");
        if (videoModalOverlay) {
            videoModalOverlay.onclick = (e) => {
                if (e.target === videoModalOverlay) closeVideoModal();
            };
        }
        if (videoModalClose) videoModalClose.onclick = closeVideoModal;
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && videoModalOverlay && videoModalOverlay.classList.contains("show")) {
                closeVideoModal();
            }
        });

        // 评论数点击 → 打开评论弹窗
        document.getElementById("tableBody").addEventListener("click", (e) => {
            const commentLink = e.target.closest(".dy-comment-link");
            if (!commentLink) return;
            e.stopPropagation();
            if (!window.DyComment) {
                console.warn('[主模块] 评论模块未加载，请检查 dy_comment_module.js 是否可访问');
                alert('评论模块未加载，请查看控制台中 [评论模块] 开头的错误信息\n加载地址：' + (window.__DyCommentUrl__ || '未知'));
                return;
            }
            const aid = commentLink.dataset.aid;
            const desc = commentLink.dataset.desc || '';
            const commentTotal = parseInt(commentLink.dataset.commentTotal) || 0;
            const item = allWorksList.find(w => String(w.aweme_id) === aid);
            const payload = item || { aweme_id: aid, desc, statistics: { comment_count: commentTotal } };
            console.log('[主模块] 打开评论弹窗, aid=', aid, 'payload=', payload);
            window.DyComment.open(payload);
        });

        // 封面点击 → 视频或图文幻灯片（表格视图）
        document.getElementById("tableBody").addEventListener("click", (e) => {
            const coverWrapper = e.target.closest(".cover-wrapper");
            if (!coverWrapper) return;
            const imageUrls = coverWrapper.dataset.imageUrls;
            if (imageUrls) {
                openImageSlideshow(JSON.parse(imageUrls), coverWrapper.dataset.musicUrl || '');
            } else {
                const url = coverWrapper.dataset.videoUrl;
                if (url) openVideoModal(url);
            }
        });

        // 封面点击 → 视频或图文幻灯片（网格视图）
        document.getElementById("gridViewContainer")?.addEventListener("click", (e) => {
            const card = e.target.closest(".grid-card");
            if (!card) return;
            // 点击了封面图或播放按钮区域
            if (e.target.closest('.grid-card-cover') || e.target.closest('.grid-card-play')) {
                const imageUrls = card.dataset.imageUrls;
                if (imageUrls) {
                    openImageSlideshow(JSON.parse(imageUrls), card.dataset.musicUrl || '');
                } else {
                    const url = card.dataset.videoUrl;
                    if (url) openVideoModal(url);
                }
            }
        });

        // 搜索按钮绑定
        setTimeout(() => {
            const searchInput = document.getElementById("searchInput");
            const searchBtn = document.getElementById("searchBtn");
            const resetSearchBtn = document.getElementById("resetSearch");
            
            if (searchBtn) searchBtn.onclick = doSearch;
            if (resetSearchBtn) resetSearchBtn.onclick = resetSearch;
            if (searchInput) {
                searchInput.onkeydown = e => {
                    if (e.key === "Enter") doSearch();
                };
                searchInput.disabled = false;
                searchInput.readOnly = false;
            }
        }, 1000);

        // 工具栏事件
        document.getElementById("selectAll").onclick = selectAllItems;
        document.getElementById("cancelAll").onclick = cancelAllItems;
        // 导出下拉按钮弹窗
        const exportDropdown = document.getElementById("exportDropdown");
        const exportDropdownBtn = document.getElementById("exportDropdownBtn");
        const exportDropdownMenu = document.getElementById("exportDropdownMenu");
        
        exportDropdownBtn.onclick = (e) => {
            e.stopPropagation();
            exportDropdown.classList.toggle("open");
        };
        
        // 下拉菜单项点击 → 执行导出
        exportDropdownMenu.querySelectorAll(".export-dropdown-item").forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                const fmt = item.dataset.format;
                exportDropdown.classList.remove("open");
                if (["json", "csv", "txt"].includes(fmt)) exportSelectData(fmt);
            };
        });
        
        // 点击外部关闭下拉
        document.addEventListener("click", () => {
            exportDropdown.classList.remove("open");
        });

        // 表头排序点击
        document.querySelectorAll("#workTable thead th[data-sort]").forEach(th => {
            th.onclick = () => {
                if(isLoading) return;
                const field = th.dataset.sort;
                if (sortField === field) {
                    sortOrder = sortOrder === "desc" ? "asc" : "desc";
                } else {
                    sortField = field;
                    sortOrder = "desc";
                }
                renderTable();
            };
        });
    }

    // ============================================================
    //  3. 表格渲染辅助函数
    // ============================================================

    /**
     * 根据 columnVisibility 配置控制表格列的显示/隐藏
     * 同步更新 thead 和 tbody 中对应的 th/td
     */
    function updateColumnVisibility() {
        const table = document.getElementById("workTable");
        if (!table) return;

        alwaysVisibleColumns.forEach(col => {
            columnVisibility[col] = true;
        });

        document.querySelectorAll(".column-option-item input[data-col]").forEach(cb => {
            if (alwaysVisibleColumns.has(cb.dataset.col)) {
                cb.checked = true;
                cb.disabled = true;
            }
        });

        table.querySelectorAll("thead th").forEach(th => {
            const col = th.dataset.col;
            if (col) {
                th.style.display = (alwaysVisibleColumns.has(col) || columnVisibility[col]) ? "" : "none";
            }
        });

        table.querySelectorAll("tbody td[data-col]").forEach(td => {
            const col = td.dataset.col;
            if (col) {
                td.style.display = (alwaysVisibleColumns.has(col) || columnVisibility[col]) ? "" : "none";
            }
        });
        const widths = {select:60,id:190,cover:90,title:280,tags:240,type:90,create_time:180,digg_count:90,
            share_count:90,comment_count:90,collect_count:90,promote_count:90,play_count:120,engagement_rate:130,operation:290};
        const visibleHeaders = Array.from(table.querySelectorAll('thead th[data-col]')).filter(th =>
            th.style.display !== 'none' && (!th.classList.contains('self-only') || analysisMode === 'self'));
        table.style.width = visibleHeaders.reduce((sum,th)=>sum+(widths[th.dataset.col]||90),0)+'px';
    }

    /**
     * 更新加载进度条和状态文字
     * @param {number} current - 当前已加载条数
     * @param {number} total   - 预期总条数（未知时传0，显示"已加载 N 条"）
     */
    function updateLoadingProgress(current, total) {
        const progressBar = document.getElementById("loadingProgress");
        const statusText = document.getElementById("loadingStatusText");
        const countText = document.getElementById("loadingCountText");
        const progressFill = document.getElementById("progressBarFill");

        if (progressBar && statusText && countText && progressFill) {
            progressBar.style.display = 'block';
            
            if (total > 0) {
                const percentage = Math.min((current / total) * 100, 100);
                progressFill.style.width = percentage + '%';
                statusText.textContent = '正在加载作品数据...';
                countText.textContent = `${current} / ${total}`;
            } else {
                // 如果不知道总数，显示已加载数量
                progressFill.style.width = '100%';
                statusText.textContent = '正在加载作品数据...';
                countText.textContent = `已加载 ${current} 条`;
            }
        }
    }

    /**
     * 隐藏加载进度条
     */
    function hideLoadingProgress() {
        const progressBar = document.getElementById("loadingProgress");
        if (progressBar) {
            progressBar.style.display = 'none';
        }
    }

    // ============================================================
    //  4. API 数据获取
    // ============================================================

    /**
     * 调用抖音 API 获取用户资料
     * API: /aweme/v1/web/user/profile/other
     * @returns {Promise<Object>} 用户信息对象（json.user）
     */
    async function getUserProfile() {
        if (location.pathname === '/user/self' || location.pathname.startsWith('/user/self/')) {
            if (!window.__DcxzsPageApi__) throw new Error('账号请求模块未加载，请重新加载插件并刷新抖音页');
            const own = await window.__DcxzsPageApi__.identity();
            knownSelfSecUid = own.sec_uid;
            localStorage.setItem('dcxzs-self-sec-uid', own.sec_uid);
            analysisMode = 'self';
            totalWorksExpected = own.aweme_count || 0;
            return own;
        }
        const secUid = getCurrentSecUid();
        const apiUrl = new URL(`${baseHost}/aweme/v1/web/user/profile/other`);
        apiUrl.searchParams.set("sec_user_id", secUid);
        apiUrl.searchParams.set("device_platform", "webapp");
        apiUrl.searchParams.set("aid", "6383");
        apiUrl.searchParams.set("channel", "douyin");

        const res = await fetch(apiUrl.toString(), {
            signal: AbortSignal.timeout(12000),
            method: "GET",
            credentials: "include",
            headers: {
                Referer: `${baseHost}/user/${secUid}`,
                Origin: baseHost,
                "User-Agent": navigator.userAgent
            }
        });
        const json = await res.json();
        if (json.status_code !== 0) throw new Error(json.status_msg);
        
        // 保存预期作品总数
        totalWorksExpected = json.user?.aweme_count || 0;
        console.log('hankin-user数据==========',json);
        return json.user;
    }

    /**
     * 分页拉取用户全部公开作品
     * API: /aweme/v1/web/aweme/post，每页 35 条，间隔 800ms
     * 
     * 退出条件（满足任一即停止拉取）：
     *   1. has_more = false — 服务器明确表示没有更多
     *   2. max_cursor 不再变化 — 翻页卡住
     *   3. 连续 3 页为空 — 防止空响应的死循环
     * 
     * 为什么实际数量可能少于 aweme_count：
     *   aweme_count 包含私密/已删除作品，API 只能返回公开可见的作品
     */
    async function getAllWorks() {
        const secUid = getCurrentSecUid();
        isLoading = true;
        let maxCursor = 0;
        let prevCursor = -1;   // 防无穷循环：cursor 不变时强制退出
        let emptyStreak = 0;   // 连续空页计数
        let pageCount = 0;
        
        // 显示进度条
        updateLoadingProgress(0, totalWorksExpected || 0);
        
        while (true) {
            const apiUrl = new URL(`${baseHost}/aweme/v1/web/aweme/post`);
            apiUrl.searchParams.set("sec_user_id", secUid);
            apiUrl.searchParams.set("max_cursor", maxCursor);
            apiUrl.searchParams.set("count", "35");
            apiUrl.searchParams.set("device_platform", "webapp");
            apiUrl.searchParams.set("aid", "6383");

            const res = await fetch(apiUrl.toString(), {
                signal: AbortSignal.timeout(12000),
                method: "GET",
                credentials: "include",
                headers: {
                    Referer: `${baseHost}/user/${secUid}`,
                    Origin: baseHost,
                    "User-Agent": navigator.userAgent
                }
            });
            const json = await res.json();
            if (json.status_code !== 0) throw new Error(json.status_msg);
            console.log('hankin-作品数据==========page='+pageCount, json);
            const list = json.aweme_list || [];

            // 空页不 break，只记录连续空页次数
            if (list.length) {
                allWorksList = allWorksList.concat(list);
                emptyStreak = 0;
            } else {
                emptyStreak++;
            }

            // 更新进度
            pageCount++;
            updateLoadingProgress(allWorksList.length, totalWorksExpected || allWorksList.length + 35);
            filterWorks = [...allWorksList];
            renderTable();

            // 退出条件1：服务器明确说没有更多了
            if (!json.has_more) break;

            // 退出条件2：cursor 不再变化，说明已经到底了
            if (maxCursor === prevCursor) break;
            prevCursor = maxCursor;

            // 退出条件3：连续 3 页为空，认为已经拉完
            if (emptyStreak >= 3) break;

            maxCursor = json.max_cursor;
            if (maxCursor === undefined || pageCount >= 500) throw new Error('作品分页未正常结束，请稍后重新解析');
            await new Promise(r => setTimeout(r, 800));
        }
        filterWorks = [...allWorksList];
        isLoading = false;

        // 隐藏进度条
        hideLoadingProgress();

    }

    // ============================================================
    //  5. 搜索与排序
    // ============================================================

    /**
     * 根据搜索框关键字过滤作品列表
     * 匹配范围：aweme_id（精确） + desc/标题（模糊）
     * 搜索后重置到第 1 页
     */
    function doSearch() {
        const kw = document.getElementById("searchInput").value.trim().toLowerCase();
        if (!kw) {
            filterWorks = [...allWorksList];
        } else {
            filterWorks = allWorksList.filter(item => {
                const matchId = String(item.aweme_id).includes(kw);
                const matchTitle = (item.desc || "").toLowerCase().includes(kw);
                const matchTag = (item.text_extra || []).some(t => (t.hashtag_name || "").toLowerCase().includes(kw));
                return matchId || matchTitle || matchTag;
            });
        }
        currentPage = 1;
        renderTable();
    }

    /**
     * 清空搜索框，恢复显示全部作品
     */
    function resetSearch() {
        document.getElementById("searchInput").value = "";
        filterWorks = [...allWorksList];
        currentPage = 1;
        renderTable();
    }

    /**
     * 根据当前 sortField/sortOrder 对作品列表排序
     * 支持字段：create_time / digg_count / share_count / comment_count / collect_count / promote_count
     * @param {Array} list - 待排序的作品数组
     * @returns {Array} 排序后的数组（原地排序）
     */
    function sortData(list) {
        return list.sort((a, b) => {
            let valA, valB;
            switch (sortField) {
                case "create_time":
                    valA = a.create_time; valB = b.create_time; break;
                case "digg_count":
                    valA = Number(a.statistics?.digg_count || 0); valB = Number(b.statistics?.digg_count || 0); break;
                case "share_count":
                    valA = Number(a.statistics?.share_count || 0); valB = Number(b.statistics?.share_count || 0); break;
                case "comment_count":
                    valA = Number(a.statistics?.comment_count || 0); valB = Number(b.statistics?.comment_count || 0); break;
                case "collect_count":
                    valA = Number(a.statistics?.collect_count || 0); valB = Number(b.statistics?.collect_count || 0); break;
                case "promote_count":
                    valA = Number(a.statistics?.recommend_count || 0); 
                    valB = Number(b.statistics?.recommend_count || 0); 
                    break;
                case "play_count":
                    valA = Number(a.selfAnalytics?.playCount ?? -1);
                    valB = Number(b.selfAnalytics?.playCount ?? -1);
                    break;
                case "engagement_rate":
                    valA = Number(a.selfAnalytics?.engagementRate ?? -1);
                    valB = Number(b.selfAnalytics?.engagementRate ?? -1);
                    break;
                default:
                    valA = a[sortField]; valB = b[sortField];
            }
            if (valA > valB) return sortOrder === "desc" ? -1 : 1;
            if (valA < valB) return sortOrder === "desc" ? 1 : -1;
            return 0;
        });
    }

    // ============================================================
    //  6. 渲染函数
    // ============================================================

    /**
     * 渲染顶部用户信息卡片
     * 显示：昵称、sec_uid、签名、粉丝数、关注数、总获赞、作品数（初始值）、IP 属地
     * IP 属地按优先级尝试：ip_location → ip_attr → region → address → city
     * @param {Object} user - API 返回的用户信息对象
     */
    function renderUserInfo(user) {
        const box = document.getElementById("userInfoBox");
        // 背景封面图：cover_and_head_image_info.profile_cover_list → cover_url.url_list
        let coverUrl = '';
        const pcl = userProfile?.cover_and_head_image_info?.profile_cover_list;
        if (pcl) {
            if (Array.isArray(pcl) && pcl[0]?.cover_url?.url_list?.[0]) {
                coverUrl = pcl[0].cover_url.url_list[0];
            } else if (pcl.cover_url?.url_list?.[0]) {
                coverUrl = pcl.cover_url.url_list[0];
            }
        }
        // 浅色/深色封面色调
        const lightCoverColor = userProfile?.light_cover_color || '';
        const darkCoverColor  = userProfile?.dark_cover_color  || '';
        // hex → rgba 辅助
        const hexToRgba = (hex, alpha) => {
            if (!hex || typeof hex !== 'string') return null;
            let h = hex.replace('#', '').trim();
            if (h.length === 3) h = h.split('').map(c => c + c).join('');
            if (h.length !== 6) return null;
            const r = parseInt(h.slice(0, 2), 16);
            const g = parseInt(h.slice(2, 4), 16);
            const b = parseInt(h.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${alpha})`;
        };
        // 设置 CSS 变量：背景图 + 遮罩色
        box.style.setProperty('--cover-bg', coverUrl ? `url("${coverUrl}")` : 'none');
        box.style.setProperty('--cover-overlay', hexToRgba(lightCoverColor, 0.82) || 'rgba(255,255,255,0.82)');
        box.style.setProperty('--cover-overlay-dark', hexToRgba(darkCoverColor, 0.85) || 'rgba(26,26,26,0.85)');

        box.innerHTML = `
            <div class="flex items-start gap-4">
                <div class="flex flex-col items-center gap-1.5 flex-shrink-0">
                    <div class="w-14 h-14 rounded-full overflow-hidden bg-white shadow-md flex items-center justify-center" style="border:3px solid white;">
                        <img src="${userProfile?.avatar_thumb?.url_list?.[0] || userProfile?.avatar_medium?.url_list?.[0] || ''}" 
                             class="w-full h-full object-cover" 
                             onerror="this.style.display='none';this.parentElement.innerHTML='${(user.nickname || '?')[0]}';" 
                             alt="${user.nickname || '?'}">
                    </div>
                    <button class="action-btn download" id="downloadAvatarBtn" title="下载头像">下载头像</button>
                </div>
                <div class="flex-1">
                    <div class="flex items-center gap-3 mb-2 flex-wrap">
                        <h4 class="text-base font-semibold text-dy-text m-0">${user.nickname}</h4>
                        <span class="text-xs text-dy-text-secondary bg-dy-bg px-2 py-0.5 rounded font-mono" title="${user.sec_uid}" style="word-break: break-all;line-height: 1.4;">用户ID: ${user.sec_uid}</span>
                        <button class="action-btn data" id="userDataBtn">json原数据</button>
                        ${coverUrl ? `<button class="action-btn download" id="downloadBgBtn" title="下载背景封面">下载背景</button>` : ''}
                    </div>
                    <p class="text-sm text-dy-text-secondary mb-2">${user.signature || "这个人很懒，还没有签名~"}</p>
                    <div class="flex items-center gap-6 text-sm">
                        <span class="flex items-center gap-1.5">
                            <svg class="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path>
                            </svg>
                            <span class="text-dy-text-secondary">粉丝</span>
                            <span class="font-semibold text-dy-text">${formatNumber(user.follower_count)}</span>
                        </span>
                        <span class="flex items-center gap-1.5">
                            <svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"></path>
                            </svg>
                            <span class="text-dy-text-secondary">关注</span>
                            <span class="font-semibold text-dy-text">${formatNumber(user.following_count)}</span>
                        </span>
                        <span class="flex items-center gap-1.5">
                            <svg class="w-4 h-4 text-orange-500" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
                            </svg>
                            <span class="text-dy-text-secondary">总获赞</span>
                            <span class="font-semibold text-dy-text">${formatNumber(user.total_favorited)}</span>
                        </span>
                        <span class="flex items-center gap-1.5">
                            <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 16h4m10 0h4M21 12H3"></path>
                            </svg>
                            <span class="text-dy-text-secondary">作品</span>
                            <span class="font-semibold text-dy-text" id="userWorkCount">${user.aweme_count}</span>
                        </span>
                        <span class="flex items-center gap-1.5">
                            <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path>
                            </svg>
                            <span class="text-dy-text-secondary">IP属地</span>
                            <span class="font-semibold text-dy-text">${user.ip_location || user.ip_attr || user.region || user.address || user.city || "未知"}</span>
                        </span>
                    </div>
                </div>
            </div>
        `;
        // 绑定用户数据按钮
        const userDataBtn = document.getElementById("userDataBtn");
        if (userDataBtn) {
            userDataBtn.onclick = () => showJsonModal(user, `用户数据 - ${user.nickname || ""}`);
        }
        // 绑定下载头像按钮
        const downloadAvatarBtn = document.getElementById("downloadAvatarBtn");
        if (downloadAvatarBtn) {
            downloadAvatarBtn.onclick = async () => {
                const avatarUrl = userProfile?.avatar_larger?.url_list?.[0] 
                    || userProfile?.avatar_medium?.url_list?.[0] 
                    || userProfile?.avatar_thumb?.url_list?.[0];
                if (!avatarUrl) return alert("未找到头像地址");
                try {
                    const resp = await fetch(avatarUrl);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const blob = await resp.blob();
                    triggerDownload(blob, `头像_${user.nickname || "用户"}.jpg`);
                } catch (e) {
                    window.open(avatarUrl, "_blank");
                }
            };
        }
        // 绑定下载背景按钮
        const downloadBgBtn = document.getElementById("downloadBgBtn");
        if (downloadBgBtn) {
            downloadBgBtn.onclick = async () => {
                let bgUrl = '';
                const pcl = userProfile?.cover_and_head_image_info?.profile_cover_list;
                if (pcl) {
                    if (Array.isArray(pcl) && pcl[0]?.cover_url?.url_list?.[0]) {
                        bgUrl = pcl[0].cover_url.url_list[0];
                    } else if (pcl.cover_url?.url_list?.[0]) {
                        bgUrl = pcl.cover_url.url_list[0];
                    }
                }
                if (!bgUrl) return alert("未找到背景图地址");
                try {
                    const resp = await fetch(bgUrl);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const blob = await resp.blob();
                    triggerDownload(blob, `背景_${user.nickname || "用户"}.jpg`);
                } catch (e) {
                    window.open(bgUrl, "_blank");
                }
            };
        }
    }

    /**
     * 统一更新分页栏显示和按钮状态
     */
    function updatePageBar(total, curPage, totalPage, showPager) {
        const pageBar = document.querySelector('.page-bar');
        if (pageBar) pageBar.style.display = showPager ? '' : 'none';
        if (!showPager) return;
        document.getElementById("totalNum").innerText = total;
        document.getElementById("totalPageNum").innerText = totalPage;
        document.getElementById("currentPageShow").innerText = curPage;
        document.getElementById("pageMaxShow").innerText = totalPage;
        const prevBtn = document.getElementById("prevPage");
        const nextBtn = document.getElementById("nextPage");
        if (prevBtn) {
            prevBtn.disabled = curPage <= 1;
            prevBtn.classList.toggle("opacity-50", curPage <= 1);
            prevBtn.onclick = () => { if (curPage > 1) { currentPage--; renderTable(); } };
        }
        if (nextBtn) {
            nextBtn.disabled = curPage >= totalPage;
            nextBtn.classList.toggle("opacity-50", curPage >= totalPage);
            nextBtn.onclick = () => { if (curPage < totalPage) { currentPage++; renderTable(); } };
        }
    }

    /**
     * 渲染仪表盘视图
     * 数据源：allWorksList 全量，不分页
     * 展示：概览卡片、类型分布、互动均值、点赞/评论/分享/收藏 Top 10
     */
    function renderDashboard(allData) {
        const container = document.getElementById("dashboardContainer");
        if (!container) return;

        // 先销毁旧图表实例，避免 Canvas 残留报错
        container.querySelectorAll("canvas").forEach(c => {
            const inst = window.Chart?.getChart?.(c);
            if (inst) inst.destroy();
        });

        const data = allData || allWorksList;
        if (!data.length) {
            container.innerHTML = '<div style="text-align:center;padding:60px;color:#999;font-size:14px">暂无数据，请先解析作品</div>';
            return;
        }
        let totalLikes = 0, totalComments = 0, totalShares = 0, totalCollects = 0;
        const {totalPlays,playCoverage,averagePlays,overallEngagement,rateCoverage} = window.DcxzsSelfAnalytics.summary(data);
        let videoCount = 0, imageCount = 0;
        data.forEach(item => {
            const s = item.statistics || {};
            totalLikes += s.digg_count || 0;
            totalComments += s.comment_count || 0;
            totalShares += s.share_count || 0;
            totalCollects += s.collect_count || 0;
            item.images ? imageCount++ : videoCount++;
        });
        const avgLikes = data.length ? Math.round(totalLikes / data.length) : 0;
        const avgComments = data.length ? Math.round(totalComments / data.length) : 0;
        const avgShares = data.length ? Math.round(totalShares / data.length) : 0;
        const avgCollects = data.length ? Math.round(totalCollects / data.length) : 0;
        const rankLikes = [...data].sort((a,b) => (b.statistics?.digg_count||0) - (a.statistics?.digg_count||0)).slice(0,10);
        const rankComments = [...data].sort((a,b) => (b.statistics?.comment_count||0) - (a.statistics?.comment_count||0)).slice(0,10);
        const rankShares = [...data].sort((a,b) => (b.statistics?.share_count||0) - (a.statistics?.share_count||0)).slice(0,10);
        const rankCollects = [...data].sort((a,b) => (b.statistics?.collect_count||0) - (a.statistics?.collect_count||0)).slice(0,10);
        const rankPlays = [...data].filter(item => Number.isFinite(item.selfAnalytics?.playCount))
            .sort((a,b) => b.selfAnalytics.playCount - a.selfAnalytics.playCount).slice(0,10);

        container.innerHTML =
            // Row 1: 概览卡片
            '<div class="dash-summary-cards">'+
                '<div class="dash-card"><div class="dash-card-value">'+data.length+'</div><div class="dash-card-label">作品总数</div></div>'+
                (analysisMode === 'self' ? '<div class="dash-card"><div class="dash-card-value">'+(totalPlays === null ? '-' : formatNumber(totalPlays))+'</div><div class="dash-card-label">'+(playCoverage===data.length?'累计播放':'已获取播放合计')+' · '+playCoverage+'/'+data.length+'</div></div>' : '')+
                (analysisMode === 'self' ? '<div class="dash-card"><div class="dash-card-value">'+(averagePlays === null ? '-' : formatNumber(averagePlays))+'</div><div class="dash-card-label">平均播放 · '+playCoverage+' 条</div></div>' : '')+
                (analysisMode === 'self' ? '<div class="dash-card"><div class="dash-card-value">'+formatRate(overallEngagement)+'</div><div class="dash-card-label">综合互动率 · '+rateCoverage+' 条有效作品</div></div>' : '')+
                '<div class="dash-card"><div class="dash-card-value">'+formatNumber(totalLikes)+'</div><div class="dash-card-label">累计点赞</div></div>'+
                '<div class="dash-card"><div class="dash-card-value">'+formatNumber(totalComments)+'</div><div class="dash-card-label">累计评论</div></div>'+
                '<div class="dash-card"><div class="dash-card-value">'+formatNumber(totalShares)+'</div><div class="dash-card-label">累计分享</div></div>'+
                '<div class="dash-card"><div class="dash-card-value">'+formatNumber(totalCollects)+'</div><div class="dash-card-label">累计收藏</div></div>'+
            '</div>'+
            // Row 2: 类型分布 (环形图) + 互动概览 (柱状图)
            '<div class="dash-row">'+
                '<div class="dash-section"><div class="dash-section-title">📹 类型分布</div><div class="dash-chart-wrap dash-chart-wrap-pie"><canvas id="dashTypeChart"></canvas></div></div>'+
                '<div class="dash-section"><div class="dash-section-title">📈 互动均值</div><div class="dash-chart-wrap dash-chart-wrap-bar"><canvas id="dashOverviewChart"></canvas></div></div>'+
            '</div>'+
            // Row 3: 点赞 Top 10 + 评论 Top 10 (并排)
            '<div class="dash-row">'+
                '<div class="dash-section"><div class="dash-section-title">🔥 点赞 Top 10</div><div class="dash-chart-wrap dash-chart-wrap-hbar"><canvas id="dashLikesChart"></canvas></div></div>'+
                '<div class="dash-section"><div class="dash-section-title">💬 评论 Top 10</div><div class="dash-chart-wrap dash-chart-wrap-hbar"><canvas id="dashCommentsChart"></canvas></div></div>'+
            '</div>'+
            // Row 4: 分享 Top 10 + 收藏 Top 10 (并排)
            '<div class="dash-row">'+
                '<div class="dash-section"><div class="dash-section-title">📤 分享 Top 10</div><div class="dash-chart-wrap dash-chart-wrap-hbar"><canvas id="dashSharesChart"></canvas></div></div>'+
                '<div class="dash-section"><div class="dash-section-title">⭐ 收藏 Top 10</div><div class="dash-chart-wrap dash-chart-wrap-hbar"><canvas id="dashCollectsChart"></canvas></div></div>'+
            '</div>'+
            (analysisMode === 'self' ? '<div class="dash-row"><div class="dash-section" style="width:100%"><div class="dash-section-title">播放量 Top 10 <span style="font-size:12px;color:#999;font-weight:400">· 已获取 '+playCoverage+'/'+data.length+'</span></div><div class="dash-chart-wrap dash-chart-wrap-hbar"><canvas id="dashPlaysChart"></canvas></div></div></div>' : '');

        // 等待 Chart.js 加载完成后初始化图表
        waitChartJs().then(() => {
            const wrap = document.getElementById("dy-drawer-wrap");
            const isDark = wrap && wrap.classList.contains("dark-mode");
            const tc = isDark ? "#e5e5e5" : "#333";
            const gc = isDark ? "#404040" : "#eee";

            // 1. 类型分布 —— 环形图
            const typeCtx = document.getElementById("dashTypeChart");
            if (typeCtx) {
                new window.Chart(typeCtx, {
                    type: "doughnut",
                    data: {
                        labels: ["视频", "图文"],
                        datasets: [{
                            data: [videoCount, imageCount],
                            backgroundColor: ["#fe2c55", "#4fa3ff"],
                            borderColor: isDark ? "#2d2d2d" : "#fff",
                            borderWidth: 2,
                            hoverBorderColor: isDark ? "#3a3a3a" : "#fff"
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        cutout: "55%",
                        plugins: {
                            legend: {
                                position: "bottom",
                                labels: { color: tc, padding: 16, font: { size: 12 }, usePointStyle: true, pointStyleWidth: 8 }
                            },
                            tooltip: {
                                callbacks: {
                                    label: ctx => ctx.label + ": " + ctx.parsed + " 条 (" + (data.length ? Math.round(ctx.parsed / data.length * 100) : 0) + "%)"
                                }
                            }
                        }
                    }
                });
            }

            // 2. 互动均值 —— 柱状图
            const ovCtx = document.getElementById("dashOverviewChart");
            if (ovCtx) {
                new window.Chart(ovCtx, {
                    type: "bar",
                    data: {
                        labels: ["点赞", "评论", "分享", "收藏"],
                        datasets: [{
                            data: [avgLikes, avgComments, avgShares, avgCollects],
                            backgroundColor: ["rgba(254,44,85,0.85)", "rgba(79,163,255,0.85)", "rgba(255,193,7,0.85)", "rgba(82,196,26,0.85)"],
                            borderColor: ["#fe2c55", "#4fa3ff", "#ffc107", "#52c41a"],
                            borderWidth: 1,
                            borderRadius: 6,
                            borderSkipped: false
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: {
                                    label: ctx => "平均" + ctx.label + ": " + formatNumber(ctx.parsed.y) + " 条"
                                }
                            }
                        },
                        scales: {
                            x: { ticks: { color: tc, font: { size: 12 } }, grid: { display: false } },
                            y: { beginAtZero: true, ticks: { color: tc, callback: v => formatNumber(v) }, grid: { color: gc } }
                        }
                    }
                });
            }

            // 3. Top 10 辅助函数 —— 水平柱状图
            function renderTop10Chart(canvasId, rankData, valueKey, color, colorTop3, tooltipPrefix) {
                const ctx = document.getElementById(canvasId);
                if (!ctx) return;
                const labels = rankData.map((item, i) => {
                    const title = item.desc || "无标题";
                    return (i + 1) + ". " + (title.length > 25 ? title.slice(0, 24) + "…" : title);
                });
                const values = rankData.map(item => (item.statistics||{})[valueKey] || 0);
                new window.Chart(ctx, {
                    type: "bar",
                    data: {
                        labels: labels,
                        datasets: [{
                            data: values,
                            backgroundColor: values.map((_, i) => i < 3 ? colorTop3 : color),
                            borderWidth: 0,
                            borderRadius: 4,
                            borderSkipped: false
                        }]
                    },
                    options: {
                        indexAxis: "y",
                        responsive: true,
                        maintainAspectRatio: false,
                        layout: { padding: { left: 8 } },
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: { label: ctx => tooltipPrefix + formatNumber(ctx.parsed.x) }
                            }
                        },
                        scales: {
                            x: { beginAtZero: true, ticks: { color: tc, callback: v => formatNumber(v) }, grid: { color: gc } },
                            y: { ticks: { color: tc, font: { size: 11 }, padding: 4 }, grid: { display: false } }
                        }
                    }
                });
            }

            renderTop10Chart("dashLikesChart", rankLikes, "digg_count", "rgba(254,44,85,0.55)", "#fe2c55", "👍 ");
            renderTop10Chart("dashCommentsChart", rankComments, "comment_count", "rgba(79,163,255,0.55)", "#4fa3ff", "💬 ");
            renderTop10Chart("dashSharesChart", rankShares, "share_count", "rgba(255,193,7,0.55)", "#ffc107", "📤 ");
            renderTop10Chart("dashCollectsChart", rankCollects, "collect_count", "rgba(82,196,26,0.55)", "#52c41a", "⭐ ");
            if (analysisMode === 'self') {
                const ctx = document.getElementById('dashPlaysChart');
                if (ctx) {
                    new window.Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: rankPlays.map((item, index) => (index + 1) + '. ' + ((item.desc || '无标题').slice(0, 24))),
                            datasets: [{ data: rankPlays.map(item => item.selfAnalytics.playCount), backgroundColor: '#0f766e', borderRadius: 4 }]
                        },
                        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: tc, callback: v => formatNumber(v) }, grid: { color: gc } }, y: { ticks: { color: tc, font: { size: 11 } }, grid: { display: false } } } }
                    });
                }
            }
        }).catch(err => {
            console.error("[仪表盘] Chart.js 初始化失败:", err);
        });
    }

    /**
     * 渲染对比视图
     * 从 allWorksList 中筛选 selectedIds 勾选的作品（2-6 条）
     * 并排展示封面卡 + 指标对比表，高亮每项最高值
     */
    function renderCompareView() {
        const container = document.getElementById("compareContainer");
        if (!container) return;
        const selected = allWorksList.filter(item => selectedIds.has(String(item.aweme_id)));
        if (selected.length < 2) {
            container.innerHTML = '<div class="compare-no-select"><svg style="width:48px;height:48px;color:#ddd;margin-bottom:12px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"></path></svg><p>请先在表格或网格视图中<b>勾选 2 条以上作品</b>，再切换到对比视图</p></div>';
            return;
        }
        const compareItems = selected.slice(0, 6);
        const metrics = [
            { key: 'create_time', label: '发布时间', formatV: item => formatDateTime(item.create_time) },
            { key: 'type', label: '类型', formatV: item => item.images ? '图文' : '视频' },
            { key: 'digg_count', label: '👍 点赞', formatV: item => formatNumber(item.statistics?.digg_count||0), num: item => item.statistics?.digg_count||0 },
            { key: 'comment_count', label: '💬 评论', formatV: item => formatNumber(item.statistics?.comment_count||0), num: item => item.statistics?.comment_count||0 },
            { key: 'share_count', label: '📤 分享', formatV: item => formatNumber(item.statistics?.share_count||0), num: item => item.statistics?.share_count||0 },
            { key: 'collect_count', label: '⭐ 收藏', formatV: item => formatNumber(item.statistics?.collect_count||0), num: item => item.statistics?.collect_count||0 },
        ];

        // 封面卡片
        let coverCards = '';
        let tableHead = '<th style="width:100px">指标</th>';
        compareItems.forEach((item, i) => {
            const cover = item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || '');
            const escTitle = (item.desc || '无标题').replace(/"/g, '&quot;');
            coverCards += '<div class="compare-card">'+
                (cover ? '<img class="compare-card-cover" src="'+cover+'" loading="lazy" onerror="this.style.background=\'#eee\'">' : '<div class="compare-card-cover" style="background:#eee;display:flex;align-items:center;justify-content:center;color:#ccc">无封面</div>')+
                '<div class="compare-card-title" title="'+escTitle+'">#'+(i+1)+' '+(item.desc || '无标题')+'</div></div>';
            tableHead += '<th>作品 #'+(i+1)+'</th>';
        });

        // 对比表格
        let tableRows = '';
        metrics.forEach(m => {
            let maxVal = -1;
            if (m.num) {
                maxVal = Math.max(...compareItems.map(m.num));
            }
            tableRows += '<tr><td class="compare-metric">'+m.label+'</td>';
            compareItems.forEach((item, i) => {
                const val = m.formatV(item);
                const isMax = m.num && m.num(item) === maxVal && maxVal > 0;
                tableRows += '<td' + (isMax ? ' class="compare-highlight"' : '') + '>'+val+'</td>';
            });
            tableRows += '</tr>';
        });

        container.innerHTML = '<div class="compare-header">'+coverCards+'</div>'+
            '<table class="compare-table"><thead><tr>'+tableHead+'</tr></thead><tbody>'+tableRows+'</tbody></table>';
    }

    /**
     * 渲染时间线视图
     * 数据源：filterWorks（分页），按月分组展示发布节奏
     */
    function renderTimelineView(pageData) {
        const container = document.getElementById("timelineContainer");
        if (!container) return;
        if (!pageData.length) {
            container.innerHTML = '<div style="text-align:center;padding:60px;color:#999;font-size:14px">暂无匹配数据</div>';
            return;
        }
        const monthGroups = {};
        pageData.forEach(item => {
            const d = new Date(item.create_time * 1000);
            const key = d.getFullYear()+'年'+(d.getMonth()+1)+'月';
            if (!monthGroups[key]) monthGroups[key] = [];
            monthGroups[key].push(item);
        });

        let html = '';
        for (const [month, items] of Object.entries(monthGroups)) {
            const totalLikes = items.reduce((s, i) => s + (i.statistics?.digg_count||0), 0);
            const avgLikes = Math.round(totalLikes / items.length);
            html += '<div class="timeline-month-group"><div class="timeline-month-header"><span class="timeline-month-label">📅 '+month+'</span>'+
                '<span class="timeline-month-stats">'+items.length+' 条作品 · 平均点赞 '+formatNumber(avgLikes)+'</span></div><div class="timeline-list">';
            items.forEach(item => {
                const cover = item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || '');
                const s = item.statistics || {};
                const isVideo = !item.images;
                const timeStr = formatDateTime(item.create_time);
                const escTitle = (item.desc || '无标题').replace(/"/g, '&quot;');
                html += '<div class="timeline-item"><div class="timeline-dot"></div>'+
                    (cover ? '<img class="timeline-thumb" src="'+cover+'" loading="lazy" onerror="this.style.background=\'#eee\'">' : '<div class="timeline-thumb" style="background:#eee;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:10px">无封面</div>')+
                    '<div class="timeline-info"><div class="timeline-time">'+timeStr+' · '+(isVideo?'🎬 视频':'🖼️ 图文')+'</div>'+
                    '<div class="timeline-title" title="'+escTitle+'">'+(item.desc || '无标题')+'</div>'+
                    '<div class="timeline-stats"><span class="timeline-stat">👍 '+formatNumber(s.digg_count||0)+'</span>'+
                    '<span class="timeline-stat">💬 '+formatNumber(s.comment_count||0)+'</span>'+
                    '<span class="timeline-stat">📤 '+formatNumber(s.share_count||0)+'</span>'+
                    '<span class="timeline-stat">⭐ '+formatNumber(s.collect_count||0)+'</span></div></div></div>';
            });
            html += '</div></div>';
        }
        container.innerHTML = html;
    }

    /**
     * 切换视图模式，状态持久化到 localStorage
     * @param {'table'|'grid'|'dashboard'|'compare'|'timeline'} view - 目标视图模式
     */
    function switchView(view) {
        currentView = view;
        localStorage.setItem('hankin-dy-drawer-view', view);
        const wrap = document.getElementById('dy-drawer-wrap');
        const viewClasses = ['table-view', 'grid-view', 'dashboard-view', 'compare-view', 'timeline-view'];
        if (wrap) {
            wrap.classList.remove(...viewClasses);
            wrap.classList.add(view + '-view');
        }
        // 更新下拉菜单选中状态
        document.querySelectorAll('#viewSwitchMenu .view-switch-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });
        // 更新按钮图标和标签
        const labelEl = document.getElementById('viewSwitchLabel');
        const iconMap = {
            table: '.view-switch-icon-table',
            grid: '.view-switch-icon-grid',
            dashboard: '.view-switch-icon-dashboard',
            compare: '.view-switch-icon-compare',
            timeline: '.view-switch-icon-timeline'
        };
        const labelMap = { table: '表格视图', grid: '网格视图', dashboard: '仪表盘', compare: '对比视图', timeline: '时间线' };
        document.querySelectorAll('.view-switch-icon-table,.view-switch-icon-grid,.view-switch-icon-dashboard,.view-switch-icon-compare,.view-switch-icon-timeline').forEach(el => el.style.display = 'none');
        const activeIcon = document.querySelector(iconMap[view]);
        if (activeIcon) activeIcon.style.display = '';
        if (labelEl) labelEl.textContent = labelMap[view] || '表格视图';
        renderTable();
    }

    /**
     * 渲染网格视图（卡片模式）
     * 每张卡片显示：复选框、类型标签、封面图、标题、日期、点赞数
     * 视频卡片有播放图标，图文卡片存储图片和音乐 URL 到 dataset
     * @param {Array} pageData - 当前页的作品数据
     */
    function renderGridView(pageData) {
        const container = document.getElementById("gridViewContainer");
        if (!container) return;
        container.innerHTML = "";

        if (!pageData.length) {
            container.innerHTML = `
                <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 16px; color: #999;">
                    <svg style="width: 64px; height: 64px; color: #e0e0e0;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
                    </svg>
                    <span style="font-size: 15px;">暂无匹配数据</span>
                    <span style="font-size: 13px;">尝试调整搜索条件或重新解析</span>
                </div>`;
            return;
        }

        pageData.forEach(item => {
            const aid = String(item.aweme_id);
            const checked = selectedIds.has(aid) ? "checked" : "";
            const cover = item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || "");
            const stats = item.statistics || {};
            const videoUrl = item.video?.play_addr?.url_list?.[item.video.play_addr.url_list.length - 1] || "";
            const isVideo = !item.images && videoUrl;

            const card = document.createElement("div");
            card.className = `grid-card${checked ? " selected" : ""}`;
            card.innerHTML = `
                <input type="checkbox" class="grid-card-check" data-aid="${aid}" ${checked}>
                ${item.images ? '<span class="grid-card-type" style="background:#8b5cf6">图文</span>' : '<span class="grid-card-type" style="background:#3b82f6">视频</span>'}
                ${isVideo ? '<div class="grid-card-play"><svg width="32" height="32" viewBox="0 0 24 24" fill="white" opacity="0.85"><circle cx="12" cy="12" r="12" fill="rgba(0,0,0,0.4)"/><polygon points="10,8 16,12 10,16" fill="white"/></svg></div>' : ''}
                ${cover ? `<img class="grid-card-cover" src="${cover}" alt="封面" loading="lazy" onerror="this.style.background='#f0f0f0'; this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect fill=%22%23f0f0f0%22 width=%2240%22 height=%2240%22/></svg>'">` : '<div class="grid-card-cover" style="display:flex;align-items:center;justify-content:center;background:#f0f0f0"><svg width="24" height="24" fill="none" stroke="#ccc" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg></div>'}
                <div class="grid-card-body">
                    <div class="grid-card-title">${(item.desc || "无标题").replace(/"/g, '&quot;')}</div>
                    <div class="grid-card-meta">
                        <span>${formatDateTime(item.create_time).slice(0, 10)}</span>
                        <div class="grid-card-stats">
                            <span class="grid-card-stat">❤️ ${formatNumber(stats.digg_count || 0)}</span>
                        </div>
                    </div>
                </div>`;
            
            if (isVideo && videoUrl) {
                card.dataset.videoUrl = videoUrl;
            } else if (item.images && item.images.length) {
                // 图文：将所有图片 URL 存到 dataset，同时保存音乐地址
                const imgUrls = item.images.map(img => (img.url_list || [])[0]).filter(Boolean);
                card.dataset.imageUrls = JSON.stringify(imgUrls);
                const musicUrl = item.music?.play_url?.url_list?.[0] || '';
                if (musicUrl) card.dataset.musicUrl = musicUrl;
            }
            container.appendChild(card);
        });

        // 复选框事件委托
        container.querySelectorAll('.grid-card-check').forEach(cb => {
            cb.onclick = (e) => e.stopPropagation();
            cb.onchange = function() {
                const aid = this.dataset.aid;
                if (this.checked) {
                    selectedIds.add(aid);
                } else {
                    selectedIds.delete(aid);
                }
                this.closest('.grid-card')?.classList.toggle('selected', this.checked);
                updateSelCount();
            };
        });
    }

    /**
     * 核心渲染函数 —— 表格视图
     * 负责：排序 → 分页计算 → 渲染表格行 → 绑定复选框/按钮事件 → 更新分页栏
     * 如果 currentView === 'grid'，则委托给 renderGridView()
     * 封面图的 videoUrl/imageUrls/musicUrl 通过 JS dataset 设置，避免 HTML 转义问题
     */
    function renderTable() {
        const sortedList = sortData([...filterWorks]);
        const total = sortedList.length;
        const totalPage = Math.ceil(total / pageSize);
        if (currentPage > totalPage) currentPage = totalPage || 1;
        const start = (currentPage - 1) * pageSize;
        const pageData = sortedList.slice(start, start + pageSize);

        // 仪表盘视图（全量数据，不分页）
        if (currentView === 'dashboard') {
            renderDashboard();
            updatePageBar(0, 0, 0, false);
            return;
        }

        // 对比视图（选中数据，不分页）
        if (currentView === 'compare') {
            renderCompareView();
            updatePageBar(0, 0, 0, false);
            return;
        }

        // 时间线视图（分页）
        if (currentView === 'timeline') {
            renderTimelineView(pageData);
            updatePageBar(total, currentPage, totalPage, true);
            return;
        }

        // 网格视图委托
        if (currentView === 'grid') {
            renderGridView(pageData);
            // 更新分页信息
            document.getElementById("totalNum").innerText = total;
            document.getElementById("currentPageShow").innerText = totalPage ? currentPage : 0;
            document.getElementById("pageMaxShow").innerText = totalPage;

            // 分页按钮状态（网格视图也需要）
            const prevBtn = document.getElementById("prevPage");
            const nextBtn = document.getElementById("nextPage");
            if (prevBtn) {
                prevBtn.disabled = currentPage <= 1;
                prevBtn.classList.toggle("opacity-50", currentPage <= 1);
                prevBtn.onclick = () => {
                    if (currentPage > 1) { currentPage--; renderTable(); }
                };
            }
            if (nextBtn) {
                nextBtn.disabled = currentPage >= totalPage;
                nextBtn.classList.toggle("opacity-50", currentPage >= totalPage);
                nextBtn.onclick = () => {
                    if (currentPage < totalPage) { currentPage++; renderTable(); }
                };
            }

            updateSelCount();
            return;
        }

        // 重置表头样式
        document.querySelectorAll("#workTable thead th[data-sort]").forEach(th => {
            th.classList.remove("sort-active");
            th.querySelectorAll('.sort-up, .sort-down').forEach(arrow => {
                arrow.classList.remove("active");
                arrow.classList.add("text-gray-300");
                arrow.classList.remove("text-sort-active");
            });
        });

        // 激活当前排序
        const activeTh = document.querySelector(`#workTable thead th[data-sort="${sortField}"]`);
        if (activeTh) {
            activeTh.classList.add("sort-active");
            const upArrow = activeTh.querySelector(".sort-up");
            const downArrow = activeTh.querySelector(".sort-down");
            if (sortOrder === "asc") {
                upArrow.classList.add("active", "text-sort-active");
                upArrow.classList.remove("text-gray-300");
            } else {
                downArrow.classList.add("active", "text-sort-active");
                downArrow.classList.remove("text-gray-300");
            }
        }

        const tbody = document.getElementById("tableBody");
        tbody.innerHTML = "";
        
        if (!pageData.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="14" class="px-3 py-12 text-center text-gray-400">
                        <div class="flex flex-col items-center gap-3">
                            <svg class="w-16 h-16 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
                            </svg>
                            <span class="text-base font-medium">暂无匹配数据</span>
                            <span class="text-sm">尝试调整搜索条件或重新解析</span>
                        </div>
                    </td>
                </tr>`;
        } else {
            pageData.forEach((item, idx) => {
                const tr = document.createElement("tr");
                tr.className = `transition-all duration-150 ${idx % 2 === 1 ? "bg-row-even" : "bg-white"} hover:bg-row-hover cursor-default group`;
                const aid = String(item.aweme_id);
                const checked = selectedIds.has(aid) ? "checked" : "";
                
                const cover = item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || "");
                const videoUrl = item.video?.play_addr?.url_list?.[item.video.play_addr.url_list.length - 1] || "";
                const isVideo = !item.images && videoUrl;
                // coverHtml：不在 HTML 字符串里嵌入 videoUrl，改用 JS 后续设置 dataset
                const coverHtml = cover 
                    ? `<div class="cover-wrapper"${isVideo ? ` title="点击播放视频"` : ""}>
                           <img class="w-full h-full object-cover" src="${cover}" alt="封面" loading="lazy" onerror="this.parentElement.innerHTML='<svg class=\\'w-6 h-6 text-gray-400\\' fill=\\'none\\' stroke=\\'currentColor\\' viewBox=\\'0 0 24 24\\'><path stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'2\\' d=\\'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z\\'></path></svg>'">${isVideo ? '<div class="play-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="white" opacity="0.9"><circle cx="12" cy="12" r="12" fill="rgba(0,0,0,0.45)"/><polygon points="10,8 16,12 10,16" fill="white"/></svg></div>' : ''}
                       </div>` 
                    : `<div class="cover-wrapper">
                           <svg class="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                           </svg>
                       </div>`;
                
                const stats = item.statistics || {};
                // 正确字段为 statistics.recommend_count
                const promoteCount = stats.recommend_count || 0;

                tr.innerHTML = `
                    <td class="border-b border-dy-border px-3 py-3 text-center" data-col="select">
                        <input type="checkbox" data-aid="${aid}" ${checked} class="w-4 h-4 cursor-pointer rounded border-gray-300 text-dy-red focus:ring-dy-red/20 transition-all duration-150">
                    </td>
                    <td class="border-b border-dy-border px-3 py-3 text-center id-cell" data-col="id" title="${aid}">${aid}</td>
                    <td class="border-b border-dy-border px-3 py-3 text-center" data-col="cover">${coverHtml}</td>
                    <td class="border-b border-dy-border px-3 py-3 text-sm" data-col="title" style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;">
                        <span class="block truncate text-dy-text hover:text-dy-red transition-colors cursor-default" title="${(item.desc || '').replaceAll('"','&quot;')}">${item.desc || "-"}</span>
                    </td>
                    <td class="border-b border-dy-border px-3 py-3 text-sm" data-col="tags" style="max-width: 200px; overflow: hidden;">
                        ${((item.text_extra || []).filter(t => t.hashtag_name).map(t => `<span class="inline-block bg-blue-50 text-blue-700 rounded px-1.5 py-0.5 text-xs mr-1 mb-0.5 cursor-pointer hover:bg-blue-100 transition-colors dy-tag-search" data-tag="${t.hashtag_name}">#${t.hashtag_name}</span>`).join('') || '<span class="text-gray-400">-</span>')}
                    </td>
                    <td class="border-b border-dy-border px-3 py-3 text-center text-sm" data-col="type">
                        <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${item.images ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-blue-700'}">${item.images ? '图文' : '视频'}</span>
                    </td>
                    <td class="border-b border-dy-border px-3 py-3 text-center text-sm text-dy-text-secondary" data-col="create_time" >${formatDateTime(item.create_time)}</td>
                    <td class="border-b border-dy-border px-3 py-3 text-center font-medium text-dy-text digg_count" data-col="digg_count">${formatNumber(stats.digg_count || 0)}</td>
                    <td class="border-b border-dy-border px-3 py-3 text-center font-medium text-dy-text share_count" data-col="share_count">${formatNumber(stats.share_count || 0)}</td>
                    <td class="border-b border-dy-border px-3 py-3 text-center font-medium text-dy-text comment_count" data-col="comment_count">
    ${(stats.comment_count || 0) > 0 
        ? `<span class="dy-comment-link" style="color:#fe2c55;cursor:pointer;font-weight:600" data-aid="${aid}" data-desc="${(item.desc || '').replace(/"/g, '&quot;')}" data-comment-total="${stats.comment_count || 0}" title="点击查看评论">${formatNumber(stats.comment_count)}</span>`
        : `<span class="text-gray-400">0</span>`}
</td>
                    <td class="border-b border-dy-border px-3 py-3 text-center font-medium text-dy-text collect_count" data-col="collect_count">${formatNumber(stats.collect_count || 0)}</td>
                    <td class="border-b border-dy-border px-3 py-3 text-center font-medium text-dy-text promote_count" data-col="promote_count">${formatNumber(promoteCount)}</td>
                    <td class="self-only border-b border-dy-border px-3 py-3 text-center font-medium text-dy-text" data-col="play_count">${Number.isFinite(item.selfAnalytics?.playCount) ? formatNumber(item.selfAnalytics.playCount) : '<span class="metric-missing">未获取</span>'}</td>
                    <td class="self-only border-b border-dy-border px-3 py-3 text-center font-medium text-dy-text" data-col="engagement_rate" title="(点赞+评论+收藏+分享) ÷ 播放">${formatRate(item.selfAnalytics?.engagementRate)}</td>
                    <td class="border-b border-dy-border px-3 py-3 text-center" data-col="operation">
                        ${isVideo ? '<button class="action-btn download" data-aid="'+aid+'" data-action="download" title="下载完整视频">下载视频</button> <button class="action-btn" data-aid="'+aid+'" data-action="clip-video" title="截取指定时间段" style="color:#fff;background:#0f766e;border-color:#0f766e;font-weight:600">截取片段</button> ' + renderASRButton(aid) + ' ' + renderAIAnalysisButton(aid) : ''}
                    </td>
                `;
                tbody.appendChild(tr);

                // 用 JS 设置 dataset，避免 HTML 转义问题
                if (isVideo && videoUrl) {
                    const wrapper = tr.querySelector('.cover-wrapper');
                    if (wrapper) wrapper.dataset.videoUrl = videoUrl;
                } else if (item.images && item.images.length) {
                    // 图文：将所有图片 URL 存到 dataset，同时保存音乐地址
                    const wrapper = tr.querySelector('.cover-wrapper');
                    if (wrapper) {
                        const imgUrls = item.images.map(img => (img.url_list || [])[0]).filter(Boolean);
                        wrapper.dataset.imageUrls = JSON.stringify(imgUrls);
                        const musicUrl = item.music?.play_url?.url_list?.[0] || '';
                        if (musicUrl) wrapper.dataset.musicUrl = musicUrl;
                    }
                }

            });
        }

        // 复选框事件
        tbody.querySelectorAll("input[type=checkbox]").forEach(cb => {
            cb.onchange = () => {
                const aid = cb.dataset.aid;
                cb.checked ? selectedIds.add(aid) : selectedIds.delete(aid);
                updateSelCount();
            };
        });

        // 标签点击搜索
        tbody.querySelectorAll(".dy-tag-search").forEach(tag => {
            tag.onclick = (e) => {
                e.stopPropagation();
                const kw = tag.dataset.tag;
                const searchInput = document.getElementById("searchInput");
                if (searchInput) {
                    searchInput.value = kw;
                    doSearch();
                }
            };
        });

        bindActionButtons(tbody);

        // 应用列显示设置
        updateColumnVisibility();

        // 分页更新
        document.getElementById("totalNum").innerText = total;
        document.getElementById("totalPageNum").innerText = totalPage;
        document.getElementById("currentPageShow").innerText = currentPage;
        document.getElementById("pageMaxShow").innerText = totalPage;

        const prevBtn = document.getElementById("prevPage");
        const nextBtn = document.getElementById("nextPage");
        prevBtn.disabled = currentPage <= 1;
        nextBtn.disabled = currentPage >= totalPage;
        prevBtn.classList.toggle("opacity-50", currentPage <= 1);
        nextBtn.classList.toggle("opacity-50", currentPage >= totalPage);
        
        prevBtn.onclick = () => {
            if (currentPage > 1) { currentPage--; renderTable(); }
        };
        nextBtn.onclick = () => {
            if (currentPage < totalPage) { currentPage++; renderTable(); }
        };
        
        updateSelCount();
    }

    // ============================================================
    //  7. 行操作 & 弹窗
    // ============================================================

    /**
     * 从列表中删除指定作品（仅在脚本内存中移除，不影响抖音服务器）
     * @param {string} aid - 作品 aweme_id
     */
    function deleteRow(aid) {
        if (!confirm("确定要删除这条作品数据吗？")) return;
        allWorksList = allWorksList.filter(item => String(item.aweme_id) !== aid);
        filterWorks = filterWorks.filter(item => String(item.aweme_id) !== aid);
        selectedIds.delete(aid);
        renderTable();
        updateSelCount();
    }

    /**
     * 显示 JSON 数据弹窗（格式化查看作品或用户原始数据）
     * @param {Object} data  - 要展示的 JSON 对象
     * @param {string} title - 弹窗标题
     */
    function showJsonModal(data, title) {
        const overlay = document.getElementById("jsonModalOverlay");
        const titleEl = document.getElementById("jsonModalTitle");
        const preEl = document.getElementById("jsonModalPre");
        if (!overlay || !titleEl || !preEl) return;
        titleEl.textContent = title || "JSON 数据";
        preEl.textContent = JSON.stringify(data, null, 2);
        overlay.classList.add("show");
    }

    /**
     * 关闭 JSON 数据弹窗
     */
    function hideJsonModal() {
        const overlay = document.getElementById("jsonModalOverlay");
        if (overlay) overlay.classList.remove("show");
    }

    /**
     * 打开视频播放弹窗 —— 加载 play_addr.url_list 最后一个元素（最高清）
     * @param {string} url - 视频播放地址
     */
    function openVideoModal(url) {
        const overlay = document.getElementById("videoModalOverlay");
        const player = document.getElementById("videoPlayer");
        if (!overlay || !player) return;
        player.src = url;
        overlay.classList.add("show");
        player.play().catch(() => {});
    }

    /**
     * 关闭视频播放弹窗，暂停并释放 video 资源
     */
    function closeVideoModal() {
        const overlay = document.getElementById("videoModalOverlay");
        const player = document.getElementById("videoPlayer");
        if (overlay) overlay.classList.remove("show");
        if (player) {
            player.pause();
            player.removeAttribute("src");
            player.load();
        }
    }

    // ============================================================
    //  8. 图片幻灯片模块
    // ============================================================

    // 幻灯片运行时状态
    let _slideshowIndex = 0;       // 当前显示的图片索引
    let _slideshowUrls = [];       // 图片 URL 列表
    let _slideshowAudio = null;    // 当前播放的音频对象

    /**
     * 打开图片幻灯片弹窗（图文作品专用）
     * 支持：左右箭头/圆点指示器/键盘 ← → 切换、ESC 关闭、背景音乐自动播放
     * @param {string[]} imageUrls - 图片 URL 数组
     * @param {string}   musicUrl  - 背景音乐地址（可选）
     */
    function openImageSlideshow(imageUrls, musicUrl) {
        const overlay = document.getElementById("imageSlideshowOverlay");
        const imgEl = document.getElementById("imageSlideshowImg");
        const counter = document.getElementById("imageSlideshowCounter");
        const dotsWrap = document.getElementById("imageSlideshowDots");
        const musicInfo = document.getElementById("imageSlideshowMusicInfo");
        const musicName = document.getElementById("imageSlideshowMusicName");
        const audioEl = document.getElementById("imageSlideshowAudio");
        if (!overlay || !imgEl || !imageUrls.length) return;

        _slideshowUrls = imageUrls;
        _slideshowIndex = 0;

        // 显示幻灯片
        overlay.classList.add("show");
        imgEl.style.opacity = "0";

        // 构建指示点
        dotsWrap.innerHTML = "";
        imageUrls.forEach((_, i) => {
            const dot = document.createElement("button");
            dot.className = "image-slideshow-dot" + (i === 0 ? " active" : "");
            dot.onclick = () => { _slideshowIndex = i; _showSlide(); };
            dotsWrap.appendChild(dot);
        });

        // 音乐
        _slideshowAudio = null;
        if (musicUrl) {
            audioEl.src = musicUrl;
            audioEl.loop = true;
            musicInfo.style.display = "flex";
            // 尝试取音乐名
            try {
                const item = _findItemByImageUrl(imageUrls[0]);
                const name = item?.music?.title || "背景音乐";
                musicName.textContent = name;
            } catch(e) { musicName.textContent = "背景音乐"; }
            audioEl.play().then(() => { _slideshowAudio = audioEl; }).catch(()=>{});
        } else {
            musicInfo.style.display = "none";
            audioEl.pause();
            audioEl.src = "";
        }

        _showSlide();

        // 左右按钮
        document.getElementById("imageSlideshowPrev").onclick = () => {
            _slideshowIndex = (_slideshowIndex - 1 + _slideshowUrls.length) % _slideshowUrls.length;
            _showSlide();
        };
        document.getElementById("imageSlideshowNext").onclick = () => {
            _slideshowIndex = (_slideshowIndex + 1) % _slideshowUrls.length;
            _showSlide();
        };

        // 关闭按钮
        document.getElementById("imageSlideshowClose").onclick = closeImageSlideshow;

        // 点击遮罩关闭
        overlay.onclick = (e) => {
            if (e.target === overlay) closeImageSlideshow();
        };

        // 键盘导航
        document.addEventListener("keydown", _onSlideshowKey);
    }

    /**
     * 渲染当前幻灯片图片（带淡入过渡动画）
     * 同步更新计数器文字和底部圆点状态
     */
    function _showSlide() {
        const imgEl = document.getElementById("imageSlideshowImg");
        const counter = document.getElementById("imageSlideshowCounter");
        const dots = document.querySelectorAll("#imageSlideshowDots .image-slideshow-dot");
        if (!_slideshowUrls.length) return;
        imgEl.style.opacity = "0";
        setTimeout(() => {
            imgEl.src = _slideshowUrls[_slideshowIndex];
            imgEl.style.opacity = "1";
        }, 150);
        counter.textContent = `${_slideshowIndex + 1} / ${_slideshowUrls.length}`;
        dots.forEach((d, i) => d.classList.toggle("active", i === _slideshowIndex));
    }

    /**
     * 幻灯片键盘导航：← → 切换，ESC 关闭
     * @param {KeyboardEvent} e
     */
    function _onSlideshowKey(e) {
        const overlay = document.getElementById("imageSlideshowOverlay");
        if (!overlay || !overlay.classList.contains("show")) return;
        if (e.key === "ArrowLeft") {
            _slideshowIndex = (_slideshowIndex - 1 + _slideshowUrls.length) % _slideshowUrls.length;
            _showSlide();
        } else if (e.key === "ArrowRight") {
            _slideshowIndex = (_slideshowIndex + 1) % _slideshowUrls.length;
            _showSlide();
        } else if (e.key === "Escape") {
            closeImageSlideshow();
        }
    }

    /**
     * 根据图片 URL 反向查找作品数据（用于获取音乐标题等关联信息）
     * @param {string} url - 图片 URL
     * @returns {Object|undefined} 匹配的作品对象
     */
    function _findItemByImageUrl(url) {
        // 从 allWorksList 中找包含该图片 URL 的作品
        return allWorksList.find(item => {
            if (!item.images) return false;
            return item.images.some(img => (img.url_list || []).includes(url));
        });
    }

    /**
     * 关闭幻灯片弹窗：隐藏遮罩、停止音乐、移除键盘监听
     */
    function closeImageSlideshow() {
        const overlay = document.getElementById("imageSlideshowOverlay");
        const audioEl = document.getElementById("imageSlideshowAudio");
        if (overlay) overlay.classList.remove("show");
        if (audioEl) { audioEl.pause(); audioEl.src = ""; }
        document.removeEventListener("keydown", _onSlideshowKey);
        _slideshowAudio = null;
    }
    // ===== 图片幻灯片结束 =====

    // ============================================================
    //  9. 选择 & 导出
    function bindActionButtons(scope) {
        (scope || document).querySelectorAll(".action-btn").forEach(btn => {
            if (btn.dataset.boundAction === '1') return;
            btn.dataset.boundAction = '1';
            btn.onclick = async (e) => {
                e.stopPropagation();
                const aid = btn.dataset.aid;
                const action = btn.dataset.action;
                if (!action) return;
                if (action === "delete") {
                    deleteRow(aid);
                } else if (action === "data") {
                    const item = allWorksList.find(i => String(i.aweme_id) === aid);
                    if (item) showJsonModal(item, `作品数据 - ${aid}`);
                } else if (action === "download") {
                    const item = allWorksList.find(i => String(i.aweme_id) === aid);
                    if (!item) return;
                    btn.disabled = true;
                    btn.innerHTML = `<span class="action-btn-spinner"></span>下载中`;
                    try {
                        const result = await fetchVideoBlob(item);
                        if (result) {
                            triggerDownload(result.blob, result.filename);
                        } else {
                            alert(`视频下载失败：${item.desc || aid}\n请查看控制台日志了解详情。`);
                        }
                    } catch (err) {
                        console.error("[下载视频] 异常：", err);
                        alert(`下载出错：${err.message || err}`);
                    } finally {
                        btn.disabled = false;
                        btn.innerHTML = "下载";
                    }
                } else if (action === "clip-video") {
                    const item = allWorksList.find(i => String(i.aweme_id) === aid);
                    if (item) showVideoClipDialog(item);
                } else if (action === "start-asr") {
                    const item = allWorksList.find(i => String(i.aweme_id) === aid);
                    if (item) startASR(item, btn);
                } else if (action === "view-asr") {
                    showASRResult(aid);
                } else if (action === "ai-analysis") {
                    startAIAnalysis(aid);
                } else if (action === "view-ai-analysis") {
                    var cache = aiAnalysisCache[aid];
                    if (cache && cache.result) showAIAnalysisResult(aid, cache.result);
                }
            };
        });
    }

    // ============================================================

    /**
     * 更新顶部已选数量显示
     */
    function updateSelCount() {
        document.getElementById("selCount").innerText = selectedIds.size;
    }

    /**
     * 全选当前筛选结果
     */
    function selectAllItems() {
        filterWorks.forEach(item => selectedIds.add(String(item.aweme_id)));
        renderTable();
    }
    
    /**
     * 取消全部选中
     */
    function cancelAllItems() {
        selectedIds.clear();
        renderTable();
    }

    /**
     * 导出选中作品，支持 JSON / CSV / TXT / caption 四种格式
     * caption 格式仅包含作品文案（desc），纯文本一行一条
     */
    async function exportSelectData(format) {
        // 从 DOM 回读勾选状态，防止 selectedIds 与界面不同步
        document.querySelectorAll("#tableBody input[type=checkbox]:checked, #gridViewContainer .grid-card-check:checked").forEach(cb => {
            selectedIds.add(cb.dataset.aid);
        });
        if (!selectedIds.size) return alert("请勾选至少一条作品！");

        format = format || "json";
        reportUsage('export_' + format, '选中导出 ' + selectedIds.size + '条');
        const selected = allWorksList.filter(item => selectedIds.has(String(item.aweme_id)));
        const nickname = userProfile?.nickname || "未知用户";

        // 构建通用数据行
        const rows = selected.map(item => {
            const st = item.statistics || {};
            const aid = String(item.aweme_id);
            const asrInfo = asrTasks[aid];
            const scriptText = (asrInfo && asrInfo.status === 'completed' && asrInfo.text) ? asrInfo.text : '';
            return {
                aweme_id: item.aweme_id,
                type: item.images ? "图文" : "视频",
                video_url: item.video?.play_addr?.url_list?.[item.video.play_addr.url_list.length - 1] || "",
                play_addr: item.video?.play_addr || null,
                cover_url: item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || ""),
                title: item.desc || "",
                author_name: item.author?.nickname || userProfile?.nickname || "-",
                create_time_str: formatDateTime(item.create_time),
                digg_count: st.digg_count || 0,
                share_count: st.share_count || 0,
                comment_count: st.comment_count || 0,
                collect_count: st.collect_count || 0,
                promote_count: st.recommend_count || 0,
                play_count: item.selfAnalytics?.playCount ?? null,
                like_rate: item.selfAnalytics?.likeRate ?? null,
                comment_rate: item.selfAnalytics?.commentRate ?? null,
                collect_rate: item.selfAnalytics?.collectRate ?? null,
                share_rate: item.selfAnalytics?.shareRate ?? null,
                engagement_rate: item.selfAnalytics?.engagementRate ?? null,
                play_count_source: item.selfAnalytics?.playCountSource || "",
                script_text: scriptText
            };
        });

        let content, filename, mimeType;

        if (format === "json") {
            // ---- JSON 格式 ----
            const obj = {
                user_info: {
                    nickname: userProfile?.nickname || "",
                    unique_id: userProfile?.unique_id || "",
                    sec_uid: userProfile?.sec_uid || "",
                    signature: userProfile?.signature || "",
                    avatar: userProfile?.avatar_thumb?.url_list?.[0] || userProfile?.avatar_medium?.url_list?.[0] || "",
                    ip_location: userProfile?.ip_location || userProfile?.ip_attr || "",
                    region: userProfile?.region || "",
                    follower_count: userProfile?.follower_count || 0,
                    following_count: userProfile?.following_count || 0,
                    aweme_count: userProfile?.aweme_count || 0,
                    total_favorited: userProfile?.total_favorited || 0,
                    page_url: location.href
                },
                export_time: new Date().toLocaleString(),
                select_total: selected.length,
                list: rows
            };
            content = JSON.stringify(obj, null, 2);
            filename = `抖音作品_${nickname}_选中数据.json`;
            mimeType = "application/json";

        } else if (format === "csv") {
            // ---- CSV 格式 ----
            const headers = [
                "作品ID", "类型", "标题", "作者", "发布时间",
                "播放量", "点赞数", "分享数", "评论数", "收藏数", "推广数", "点赞率", "评论率", "收藏率", "分享率", "综合互动率",
                "封面地址", "视频地址", "文案内容"
            ];
            // CSV 转义：包含逗号/换行/双引号时用双引号包裹，内部双引号转义为两个双引号
            const esc = v => {
                const s = String(v ?? "");
                if (s.includes(",") || s.includes("\n") || s.includes('"')) {
                    return '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            };
            const headerLine = headers.map(esc).join(",");
            const dataLines = rows.map(r => [
                "	" + r.aweme_id, r.type, r.title, r.author_name, r.create_time_str,
                r.play_count ?? "", r.digg_count, r.share_count, r.comment_count, r.collect_count, r.promote_count,
                formatRate(r.like_rate), formatRate(r.comment_rate), formatRate(r.collect_rate), formatRate(r.share_rate), formatRate(r.engagement_rate),
                r.cover_url, r.video_url,
                r.script_text || ''
            ].map(esc).join(","));
            // 添加 BOM，确保 Excel 正确识别 UTF-8 中文
            content = "\uFEFF" + [headerLine, ...dataLines].join("\n");
            filename = `抖音作品_${nickname}_选中数据.csv`;
            mimeType = "text/csv;charset=utf-8";

        } else if (format === "caption") {
            // ---- 仅文案 TXT 格式 ----
            const captions = selected.map((item, idx) => {
                const text = item.desc || "";
                return `${idx + 1}. ` + (text.trim() ? text.trim() : `(无文案)`);
            });
            content = captions.join("\n\n");
            filename = `抖音文案_${nickname}_选中.txt`;
            mimeType = "text/plain;charset=utf-8";
        } else {
            const lines = [];
            lines.push(`========================================`);
            lines.push(`  抖音作品导出数据`);
            lines.push(`========================================`);
            lines.push("");
            lines.push(`  【用户信息】`);
            lines.push(`  昵称:        ${userProfile?.nickname || "-"}`);
            lines.push(`  抖音号:      ${userProfile?.unique_id || "-"}`);
            lines.push(`  sec_uid:     ${userProfile?.sec_uid || "-"}`);
            lines.push(`  签名:        ${userProfile?.signature || "-"}`);
            lines.push(`  头像:        ${userProfile?.avatar_thumb?.url_list?.[0] || userProfile?.avatar_medium?.url_list?.[0] || "-"}`);
            if (userProfile?.ip_location) lines.push(`  IP 属地:     ${userProfile.ip_location}`);
            if (userProfile?.ip_attr) lines.push(`  IP 属地:     ${userProfile.ip_attr}`);
            if (userProfile?.region) lines.push(`  地区:        ${userProfile.region}`);
            lines.push(`  粉丝数:      ${userProfile?.follower_count || 0}`);
            lines.push(`  关注数:      ${userProfile?.following_count || 0}`);
            lines.push(`  作品数:      ${userProfile?.aweme_count || 0}`);
            lines.push(`  获赞总数:    ${userProfile?.total_favorited || 0}`);
            lines.push(`  主页链接:    ${location.href}`);
            lines.push("");
            lines.push(`  导出时间:    ${new Date().toLocaleString()}`);
            lines.push(`  选中作品数:  ${selected.length}`);
            lines.push("");
            lines.push(`========================================`);
            lines.push("");
            selected.forEach((item, idx) => {
                const st = item.statistics || {};
                const promoteCount = st.recommend_count || 0;
                const coverUrl = item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || "");
                const videoUrl = item.video?.play_addr?.url_list?.[item.video.play_addr.url_list.length - 1] || "";
                lines.push(`--- 作品 ${idx + 1} / ${selected.length} ---`);
                lines.push(`  ID:      ${item.aweme_id}`);
                lines.push(`  类型:    ${item.images ? "图文" : "视频"}`);
                lines.push(`  标题:    ${item.desc || "(无标题)"}`);
                lines.push(`  作者:    ${item.author?.nickname || userProfile?.nickname || "-"}`);
                lines.push(`  时间:    ${formatDateTime(item.create_time)}`);
                lines.push(`  点赞:    ${st.digg_count || 0}`);
                lines.push(`  分享:    ${st.share_count || 0}`);
                lines.push(`  评论:    ${st.comment_count || 0}`);
                lines.push(`  收藏:    ${st.collect_count || 0}`);
                lines.push(`  推广:    ${promoteCount}`);
                if (videoUrl) lines.push(`  视频:    ${videoUrl}`);
                if (coverUrl) lines.push(`  封面:    ${coverUrl}`);
                var scriptText = (asrTasks[String(item.aweme_id)] && asrTasks[String(item.aweme_id)].status === 'completed') ? (asrTasks[String(item.aweme_id)].text || '') : '';
                if (scriptText) lines.push(`  文案内容: ${scriptText}`);
                lines.push("");
            });
            content = lines.join("\n");
            filename = `抖音作品_${nickname}_选中数据.txt`;
            mimeType = "text/plain;charset=utf-8";
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * 批量导出全部作品，支持 JSON / CSV / TXT / caption 四种格式
     */
    async function exportAllData(format) {
        if (!allWorksList.length) return alert("暂无作品数据！");

        format = format || "json";
        reportUsage('export_' + format, '全部导出 ' + allWorksList.length + '条');
        const nickname = userProfile?.nickname || "未知用户";

        // 构建通用数据行
        const rows = allWorksList.map(item => {
            const st = item.statistics || {};
            return {
                aweme_id: item.aweme_id,
                type: item.images ? "图文" : "视频",
                video_url: item.video?.play_addr?.url_list?.[item.video.play_addr.url_list.length - 1] || "",
                play_addr: item.video?.play_addr || null,
                cover_url: item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || ""),
                title: item.desc || "",
                author_name: item.author?.nickname || userProfile?.nickname || "-",
                create_time_str: formatDateTime(item.create_time),
                digg_count: st.digg_count || 0,
                share_count: st.share_count || 0,
                comment_count: st.comment_count || 0,
                collect_count: st.collect_count || 0,
                promote_count: st.recommend_count || 0,
                play_count: item.selfAnalytics?.playCount ?? null,
                like_rate: item.selfAnalytics?.likeRate ?? null,
                comment_rate: item.selfAnalytics?.commentRate ?? null,
                collect_rate: item.selfAnalytics?.collectRate ?? null,
                share_rate: item.selfAnalytics?.shareRate ?? null,
                engagement_rate: item.selfAnalytics?.engagementRate ?? null,
                play_count_source: item.selfAnalytics?.playCountSource || ""
            };
        });

        let content, filename, mimeType;

        if (format === "json") {
            const obj = {
                user_info: {
                    nickname: userProfile?.nickname || "",
                    unique_id: userProfile?.unique_id || "",
                    sec_uid: userProfile?.sec_uid || "",
                    signature: userProfile?.signature || "",
                    avatar: userProfile?.avatar_thumb?.url_list?.[0] || userProfile?.avatar_medium?.url_list?.[0] || "",
                    ip_location: userProfile?.ip_location || userProfile?.ip_attr || "",
                    region: userProfile?.region || "",
                    follower_count: userProfile?.follower_count || 0,
                    following_count: userProfile?.following_count || 0,
                    aweme_count: userProfile?.aweme_count || 0,
                    total_favorited: userProfile?.total_favorited || 0,
                    page_url: location.href
                },
                export_time: new Date().toLocaleString(),
                total: allWorksList.length,
                list: rows
            };
            content = JSON.stringify(obj, null, 2);
            filename = `抖音作品_${nickname}_全部数据.json`;
            mimeType = "application/json";
        } else if (format === "csv") {
            const headers = ["作品ID", "类型", "标题", "作者", "发布时间", "播放量", "点赞数", "分享数", "评论数", "收藏数", "推广数", "点赞率", "评论率", "收藏率", "分享率", "综合互动率", "封面地址", "视频地址"];
            const esc = v => {
                const s = String(v ?? "");
                if (s.includes(",") || s.includes("\n") || s.includes('"')) {
                    return '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            };
            const headerLine = headers.map(esc).join(",");
            const dataLines = rows.map(r => [
                "	" + r.aweme_id, r.type, r.title, r.author_name, r.create_time_str,
                r.play_count ?? "", r.digg_count, r.share_count, r.comment_count, r.collect_count, r.promote_count,
                formatRate(r.like_rate), formatRate(r.comment_rate), formatRate(r.collect_rate), formatRate(r.share_rate), formatRate(r.engagement_rate),
                r.cover_url, r.video_url,
                r.script_text || ''
            ].map(esc).join(","));
            content = "\uFEFF" + [headerLine, ...dataLines].join("\n");
            filename = `抖音作品_${nickname}_全部数据.csv`;
            mimeType = "text/csv;charset=utf-8";
        } else if (format === "caption") {
            const captions = allWorksList.map((item, idx) => {
                const text = item.desc || "";
                return `${idx + 1}. ` + (text.trim() ? text.trim() : `(无文案)`);
            });
            content = captions.join("\n\n");
            filename = `抖音文案_${nickname}_全部.txt`;
            mimeType = "text/plain;charset=utf-8";
        } else {
            const lines = [];
            lines.push("========================================");
            lines.push("  抖音作品导出数据（全部）");
            lines.push("========================================");
            lines.push("");
            lines.push("  【用户信息】");
            lines.push(`  昵称:        ${userProfile?.nickname || "-"}`);
            lines.push(`  抖音号:      ${userProfile?.unique_id || "-"}`);
            lines.push(`  sec_uid:     ${userProfile?.sec_uid || "-"}`);
            lines.push(`  签名:        ${userProfile?.signature || "-"}`);
            lines.push(`  头像:        ${userProfile?.avatar_thumb?.url_list?.[0] || userProfile?.avatar_medium?.url_list?.[0] || "-"}`);
            if (userProfile?.ip_location) lines.push(`  IP 属地:     ${userProfile.ip_location}`);
            if (userProfile?.ip_attr) lines.push(`  IP 属地:     ${userProfile.ip_attr}`);
            if (userProfile?.region) lines.push(`  地区:        ${userProfile.region}`);
            lines.push(`  粉丝数:      ${userProfile?.follower_count || 0}`);
            lines.push(`  关注数:      ${userProfile?.following_count || 0}`);
            lines.push(`  作品数:      ${userProfile?.aweme_count || 0}`);
            lines.push(`  获赞总数:    ${userProfile?.total_favorited || 0}`);
            lines.push(`  主页链接:    ${location.href}`);
            lines.push("");
            lines.push(`  导出时间:    ${new Date().toLocaleString()}`);
            lines.push(`  全部作品数:  ${allWorksList.length}`);
            lines.push("");
            lines.push("========================================");
            lines.push("");
            allWorksList.forEach((item, idx) => {
                const st = item.statistics || {};
                const promoteCount = st.recommend_count || 0;
                const coverUrl = item.video?.cover?.url_list[0] || (item.images?.[0]?.url_list[0] || "");
                const videoUrl = item.video?.play_addr?.url_list?.[item.video.play_addr.url_list.length - 1] || "";
                lines.push(`--- 作品 ${idx + 1} / ${allWorksList.length} ---`);
                lines.push(`  ID:      ${item.aweme_id}`);
                lines.push(`  类型:    ${item.images ? "图文" : "视频"}`);
                lines.push(`  标题:    ${item.desc || "(无标题)"}`);
                lines.push(`  作者:    ${item.author?.nickname || userProfile?.nickname || "-"}`);
                lines.push(`  时间:    ${formatDateTime(item.create_time)}`);
                lines.push(`  点赞:    ${st.digg_count || 0}`);
                lines.push(`  分享:    ${st.share_count || 0}`);
                lines.push(`  评论:    ${st.comment_count || 0}`);
                lines.push(`  收藏:    ${st.collect_count || 0}`);
                lines.push(`  推广:    ${promoteCount}`);
                if (videoUrl) lines.push(`  视频:    ${videoUrl}`);
                if (coverUrl) lines.push(`  封面:    ${coverUrl}`);
                var scriptText = (asrTasks[String(item.aweme_id)] && asrTasks[String(item.aweme_id)].status === 'completed') ? (asrTasks[String(item.aweme_id)].text || '') : '';
                if (scriptText) lines.push(`  文案内容: ${scriptText}`);
                lines.push("");
            });
            content = lines.join("\n");
            filename = `抖音作品_${nickname}_全部数据.txt`;
            mimeType = "text/plain;charset=utf-8";
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * 用 blob URL 触发浏览器下载（同源 blob URL，download 属性一定生效）
     */
    function triggerDownload(blob, filename) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 60 秒后清理，确保下载已触发
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }

    function parseClipTime(value) {
        const text = String(value == null ? '' : value).trim();
        if (!text) return NaN;
        const parts = text.split(':');
        if (parts.length > 3 || parts.some(part => part.trim() === '' || !/^\d+(\.\d+)?$/.test(part.trim()))) return NaN;
        let seconds = 0;
        for (const part of parts) seconds = seconds * 60 + Number(part);
        return seconds;
    }

    function showVideoClipDialog(item) {
        document.querySelectorAll('.video-clip-overlay').forEach(node => node.remove());
        const aid = String(item.aweme_id || 'video');
        const videoUrl = item.video?.play_addr?.url_list?.[0] || '';
        if (!videoUrl) return alert('当前作品没有可用的视频地址');

        const overlay = document.createElement('div');
        overlay.className = 'json-modal-overlay video-clip-overlay show';
        overlay.innerHTML = `
            <div class="json-modal-content" style="max-width:580px">
                <div class="json-modal-header">
                    <span class="json-modal-title">截取视频片段</span>
                    <span class="json-modal-close" data-clip-close>&times;</span>
                </div>
                <div class="json-modal-body">
                    <div class="clip-modal-form">
                        <div class="clip-field">
                            <label>视频直链</label>
                            <textarea id="clipVideoUrl" spellcheck="false"></textarea>
                        </div>
                        <div class="clip-time-row">
                            <div class="clip-field"><label>开始时间</label><input id="clipStartTime" value="00:00" placeholder="例如 22 或 00:22"></div>
                            <div class="clip-field"><label>结束时间</label><input id="clipEndTime" value="00:05" placeholder="例如 25 或 00:25"></div>
                        </div>
                        <div class="clip-hint">支持秒数、分:秒、时:分:秒；单次最多截取5分钟。裁剪在本机完成，不消耗转文字额度。</div>
                        <div class="clip-status" id="clipStatus"></div>
                        <div class="clip-actions"><button type="button" data-clip-close>取消</button><button type="button" class="primary" id="clipSubmit">开始截取并下载</button></div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const urlInput = overlay.querySelector('#clipVideoUrl');
        const startInput = overlay.querySelector('#clipStartTime');
        const endInput = overlay.querySelector('#clipEndTime');
        const submit = overlay.querySelector('#clipSubmit');
        const status = overlay.querySelector('#clipStatus');
        urlInput.value = videoUrl;
        overlay.querySelectorAll('[data-clip-close]').forEach(button => {
            button.onclick = function() { if (!submit.disabled) overlay.remove(); };
        });
        overlay.onclick = function(event) {
            if (event.target === overlay && !submit.disabled) overlay.remove();
        };

        submit.onclick = async function() {
            const startTime = parseClipTime(startInput.value);
            const endTime = parseClipTime(endInput.value);
            const url = urlInput.value.trim();
            status.className = 'clip-status';
            if (!url) { status.textContent = '请输入视频直链'; status.classList.add('error'); return; }
            if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) { status.textContent = '时间格式不正确'; status.classList.add('error'); return; }
            if (startTime < 0 || endTime <= startTime) { status.textContent = '结束时间必须大于开始时间'; status.classList.add('error'); return; }
            if (endTime - startTime > 300) { status.textContent = '单次最多截取5分钟'; status.classList.add('error'); return; }

            submit.disabled = true;
            startInput.disabled = true;
            endInput.disabled = true;
            urlInput.disabled = true;
            submit.textContent = '正在处理…';
            status.textContent = `正在下载并截取 ${startTime.toFixed(1)} - ${endTime.toFixed(1)} 秒，请保持本地伴侣运行`;
            try {
                const response = await fetch('http://127.0.0.1:8765/api/video/clip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ video_url: url, video_id: aid, start_time: startTime, end_time: endTime })
                });
                if (!response.ok) {
                    const errorData = await readJsonResponse(response);
                    throw new Error(errorData.detail || errorData.message || `HTTP ${response.status}`);
                }
                const blob = await response.blob();
                if (!blob.size) throw new Error('裁剪结果为空');
                const safeTitle = (item.desc || '视频').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 40);
                const timeLabel = `${startTime.toFixed(1)}-${endTime.toFixed(1)}`.replace(/\.0/g, '');
                triggerDownload(blob, `${aid}_${safeTitle}_${timeLabel}秒.mp4`);
                status.textContent = `截取完成，已下载 ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
                submit.textContent = '已完成';
                setTimeout(() => overlay.remove(), 1600);
            } catch (error) {
                let message = error.message || String(error);
                if (message === 'Failed to fetch') {
                    try {
                        await fetch('http://127.0.0.1:8765/health', { cache: 'no-store' });
                        message = '浏览器无法连接裁剪接口，请重启最新版本的本地伴侣后重试';
                    } catch (_) {
                        message = '无法连接本地伴侣，请先运行发布包里的“启动本地伴侣.bat”';
                    }
                }
                status.textContent = '截取失败：' + message;
                status.classList.add('error');
                submit.disabled = false;
                startInput.disabled = false;
                endInput.disabled = false;
                urlInput.disabled = false;
                submit.textContent = '重试';
            }
        };
    }

    /**
     * 等待 fflate 加载完成（最多 10 秒）
     */
    async function waitFflate() {
        let waited = 0;
        while (typeof window.fflate === "undefined" && waited < 10000) {
            await new Promise(r => setTimeout(r, 200));
            waited += 200;
        }
        if (typeof window.fflate === "undefined") throw new Error("fflate 库加载超时，请刷新页面后重试！");
    }

    /**
     * 等待 Chart.js 加载完成（上限 10 秒）
     */
    async function waitChartJs() {
        let waited = 0;
        while (typeof window.Chart === "undefined" && waited < 10000) {
            await new Promise(r => setTimeout(r, 200));
            waited += 200;
        }
        if (typeof window.Chart === "undefined") throw new Error("Chart.js 库加载超时，请刷新页面后重试！");
    }

    /**
     * 匿名 fetch 视频 blob，依次尝试候选地址
     * 策略：同源 HEAD 拿到 CDN 真实地址 → 匿名 fetch CDN（credentials: omit）→ 带 cookie fetch
     * @returns {Promise<{blob: Blob, filename: string}|null>} 成功返回数据，失败返回 null
     */
    async function fetchVideoBlob(item) {
        const safeTitle = (item.desc || "无标题").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 50);
        const filename = `${item.aweme_id}_${safeTitle}.mp4`;

        const candidates = [];
        const paList = item.video?.play_addr?.url_list || [];
        const brList = (item.video?.bit_rate || []).map(br => br?.play_addr?.url_list || []).flat();
        const dlList = item.video?.download_addr?.url_list || [];
        paList.forEach(u => { if (u && !candidates.includes(u)) candidates.push(u); });
        brList.forEach(u => { if (u && !candidates.includes(u)) candidates.push(u); });
        dlList.forEach(u => { if (u && !candidates.includes(u)) candidates.push(u); });

        if (!candidates.length) {
            console.warn("[导出视频] 无视频地址：", item.aweme_id);
            return null;
        }

        for (let ci = 0; ci < candidates.length; ci++) {
            const candidate = candidates[ci];
            const isDouyin = candidate.includes("douyin.com");

            // 同源 HEAD 拿到重定向后的真实 CDN 地址
            let directUrls = [candidate];
            if (isDouyin) {
                try {
                    const rdrResp = await fetch(candidate, { method: "HEAD", redirect: "manual", credentials: "include" });
                    if (rdrResp.status === 301 || rdrResp.status === 302) {
                        const loc = rdrResp.headers.get("Location") || rdrResp.headers.get("location");
                        if (loc) {
                            directUrls = [loc, candidate];
                            console.log(`[导出视频] 重定向 → CDN：${loc.slice(0, 80)}`);
                        }
                    }
                } catch (e) {
                    console.warn(`[导出视频] HEAD 重定向失败：${e.message}`);
                }
            }

            for (const url of directUrls) {
                // 先匿名（CDN 通常允许匿名 CORS），再带 cookie
                for (const creds of ["omit", "include"]) {
                    try {
                        const resp = await fetch(url, { method: "GET", redirect: "follow", credentials: creds });
                        if (resp.type !== "opaque" && resp.type !== "opaqueredirect" && resp.ok) {
                            const blob = await resp.blob();
                            if (blob.size > 0) {
                                console.log(`[导出视频] ✅ 下载成功(${creds})：${filename} ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
                                return { blob, filename };
                            }
                        }
                        console.warn(`[导出视频] ${creds} fetch → type=${resp.type} status=${resp.status}`);
                    } catch (e) {
                        console.warn(`[导出视频] ${creds} fetch 失败：${e.message}`);
                    }
                }
            }
        }

        console.warn("[导出视频] 全部地址失败：", item.aweme_id);
        return null;
    }

    // ============================================================
    //  ASR 语音转文字
    // ============================================================

    function formatDownloadBytes(bytes) {
        var value = Number(bytes) || 0;
        if (value >= 1024 * 1024 * 1024) return (value / 1024 / 1024 / 1024).toFixed(2) + 'GB';
        if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + 'MB';
        return (value / 1024).toFixed(0) + 'KB';
    }

    function formatDownloadEta(seconds) {
        if (seconds === null || seconds === undefined || !isFinite(Number(seconds))) return '计算中';
        var value = Math.max(0, Math.round(Number(seconds)));
        if (value < 60) return value + '秒';
        if (value < 3600) return Math.ceil(value / 60) + '分钟';
        return Math.floor(value / 3600) + '小时' + Math.ceil((value % 3600) / 60) + '分钟';
    }

    async function waitForModelDownload(aid) {
        while (true) {
            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
            var response = await fetch('http://127.0.0.1:8765/health', { cache: 'no-store' });
            var health = await readJsonResponse(response);
            if (!response.ok) throw new Error(health.detail || '无法读取模型下载进度');
            if (health.model_ready) return;
            var download = health.model_download || {};
            if (download.status === 'failed') throw new Error('模型下载失败：' + (download.error || '未知错误'));
            var percent = Number(download.percent || 0).toFixed(1);
            var done = formatDownloadBytes(download.downloaded_bytes || 0);
            var total = formatDownloadBytes(download.total_bytes || 1530575439);
            var eta = formatDownloadEta(download.eta_seconds);
            asrTasks[aid] = {
                status: 'processing',
                progress: (download.status === 'preparing' ? '准备下载 ' : '模型 ') + percent + '% · ' + done + '/' + total + ' · 剩余' + eta
            };
            saveASRState();
            refreshASRButton(aid);
        }
    }

    async function startASR(item, btn) {
        var aid = String(item.aweme_id);
        var videoUrl = (item.video && item.video.play_addr && item.video.play_addr.url_list || [])[0] || "";
        if (!videoUrl) { alert('无视频地址，无法转文字'); return; }

        asrTasks[aid] = { status: 'queued', progress: '排队中…' };
        saveASRState();
        refreshASRButton(aid, btn);

        // 加入队列（同时只跑1个ASR）
        await enqueueASR(async function() {
            try {
                // 本地服务负责下载视频并使用 faster-whisper 转写。
                asrTasks[aid] = { status: 'processing', progress: '本地识别中' };
                saveASRState();
                refreshASRButton(aid);
                var healthResp = await fetch('http://127.0.0.1:8765/health', { cache: 'no-store' });
                var healthData = await readJsonResponse(healthResp);
                if (!healthResp.ok) throw new Error(healthData.detail || '本地转写服务未启动');
                if (!healthData.model_ready) {
                    if (!confirm('首次转文字需要下载 faster-whisper medium 模型（约 1.42GB）。是否现在下载？')) {
                        throw new Error('已取消模型下载');
                    }
                    var downloadResp = await fetch('http://127.0.0.1:8765/api/model/download', { method: 'POST' });
                    var downloadData = await readJsonResponse(downloadResp);
                    if (!downloadResp.ok) throw new Error(downloadData.detail || '模型下载启动失败');
                    await waitForModelDownload(aid);
                    asrTasks[aid] = { status: 'processing', progress: '模型就绪，开始识别' };
                    saveASRState();
                    refreshASRButton(aid);
                }

                var asrResp = await fetch('http://127.0.0.1:8765/api/transcribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ video_url: videoUrl, video_id: aid })
                });
                var asrData = await readJsonResponse(asrResp);
                if (!asrResp.ok) throw new Error(asrData.detail || asrData.message || ('转文字失败: HTTP ' + asrResp.status));

                if (asrData.status === 'succeeded') {
                    asrTasks[aid] = { status: 'completed', text: asrData.text };
                    saveASRState();
                    showASRResult(aid);
                } else if (asrData.status === 'no_speech') {
                    asrTasks[aid] = { status: 'no_speech', text: '' };
                    saveASRState();
                } else {
                    throw new Error(asrData.message || '识别失败');
                }
            } catch (e) {
                asrTasks[aid] = { status: 'failed', error: e.message };
                saveASRState();
                console.error('[转文字] 失败:', aid, e);
            }
        });

        // 刷新按钮状态
        refreshASRButton(aid, btn);
    }

    async function readJsonResponse(resp) {
        try {
            return await resp.json();
        } catch (e) {
            return { message: 'HTTP ' + resp.status };
        }
    }

    function showASRResult(aid) {
        var task = asrTasks[aid];
        if (!task || !task.text) return;
        var item = allWorksList.find(function(i) { return String(i.aweme_id) === aid; });
        var title = (item || {}).desc || '未知作品';

        var overlay = document.createElement('div');
        overlay.className = 'json-modal-overlay show';
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
        overlay.innerHTML =
            '<div class="json-modal-content">' +
            '<div class="json-modal-header">' +
            '<span class="json-modal-title">语音转文字 - ' + escapeHtml(title.substring(0, 30)) + '</span>' +
            '<div class="json-modal-actions">' +
            '<button class="json-modal-btn" id="copyAsrBtn">复制全文</button>' +
            '<span class="json-modal-close">&times;</span>' +
            '</div></div>' +
            '<div class="json-modal-body"><pre style="white-space:pre-wrap;font-size:14px;line-height:1.8">' + escapeHtml(task.text) + '</pre></div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.querySelector('.json-modal-close').onclick = function() { overlay.remove(); };
        overlay.querySelector('#copyAsrBtn').onclick = function() {
            navigator.clipboard.writeText(task.text).then(function() {
                overlay.querySelector('#copyAsrBtn').textContent = '已复制';
            });
        };
    }

    // ============================================================
    //  AI 文案拆解
    // ============================================================

    function renderAIAnalysisButton(aid) {
        var asrTask = asrTasks[aid];
        var cache = aiAnalysisCache[aid];
        var baseStyle = 'width:76px;min-width:76px;max-width:76px;padding-left:0;padding-right:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;overflow:hidden;text-overflow:clip;font-weight:600';

        if (cache && cache.status === 'completed') {
            return '<button class="action-btn ai-analysis-btn" data-aid="'+aid+'" data-action="view-ai-analysis" style="'+baseStyle+';color:#7c3aed;background:#f5f3ff;border-color:#ddd6fe">查看拆解</button>';
        }
        if (cache && cache.status === 'processing') {
            return '<button class="action-btn ai-analysis-btn" data-aid="'+aid+'" disabled title="AI 拆解中" style="'+baseStyle+';color:#fff;background:#8b5cf6;border-color:#8b5cf6"><span class="asr-progress-ring"></span><span>拆解中</span></button>';
        }
        if (!asrTask || asrTask.status !== 'completed') {
            return '<button class="action-btn ai-analysis-btn" data-aid="'+aid+'" disabled title="请先完成转文字" style="'+baseStyle+';color:#9ca3af;background:#f5f5f5;border-color:#e8e8e8;cursor:not-allowed;opacity:0.6">AI 拆解</button>';
        }
        return '<button class="action-btn ai-analysis-btn" data-aid="'+aid+'" data-action="ai-analysis" style="'+baseStyle+';color:#fff;background:#7c3aed;border-color:#7c3aed">AI 拆解</button>';
    }

    function refreshAIAnalysisButton(aid) {
        document.querySelectorAll('.ai-analysis-btn[data-aid="'+aid+'"]').forEach(function(btn) {
            btn.outerHTML = renderAIAnalysisButton(aid);
        });
        bindActionButtons(document);
    }

    async function startAIAnalysis(aid) {
        var asrTask = asrTasks[aid];
        if (!asrTask || asrTask.status !== 'completed' || !asrTask.text) {
            alert('请先完成转文字');
            return;
        }
        // 服务端校验额度（后端 /api/ai/script-analysis 会验证并消耗）
        if (aiAnalysisCache[aid] && aiAnalysisCache[aid].status === 'completed') {
            showAIAnalysisResult(aid, aiAnalysisCache[aid].result);
            return;
        }
        if (aiLimiterCount >= aiLimiterMax) {
            alert('当前已有 ' + aiLimiterMax + ' 个 AI 任务正在运行，请等待完成后再试');
            return;
        }

        aiAnalysisCache[aid] = { status: 'processing' };
        saveAICache();
        refreshAIAnalysisButton(aid);
        aiLimiterCount++;

        try {
            var item = allWorksList.find(function(i) { return String(i.aweme_id) === aid; });
            var stats = item ? (item.statistics || {}) : {};

            // 通过后端代理调用 DeepSeek（后端验证许可证，API Key 不暴露在前端）
            var API_BASE = window.__AI_CONFIG__ ? window.__AI_CONFIG__.API_BASE || 'http://127.0.0.1:8765' : 'http://127.0.0.1:8765';
            var resp = await fetch(API_BASE + '/api/ai/script-analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: localStorage.getItem('dcxzs_device_id') || '',
                    asr_text: asrTask.text,
                    stats: {
                        play_count: stats.play_count || 0,
                        digg_count: stats.digg_count || 0,
                        comment_count: stats.comment_count || 0,
                        collect_count: stats.collect_count || 0,
                        share_count: stats.share_count || 0
                    }
                })
            });

            if (!resp.ok) {
                var errData = await resp.json().catch(function() { return {}; });
                var errMsg = errData.detail || errData.message || ('HTTP ' + resp.status);
                if (resp.status === 402) { alert(errMsg); return; }
                throw new Error(errMsg);
            }

            var data = await resp.json();
            var result = data.result;
            if (!result) throw new Error('后端返回空结果');

            aiAnalysisCache[aid] = { status: 'completed', result: result };
            saveAICache();
            refreshAIAnalysisButton(aid);
            showAIAnalysisResult(aid, result);
        } catch (e) {
            aiAnalysisCache[aid] = { status: 'failed', error: e.message };
            saveAICache();
            refreshAIAnalysisButton(aid);
            console.error('[AI 拆解] 失败:', aid, e);
            alert('AI 拆解失败: ' + e.message);
        } finally {
            aiLimiterCount--;
        }
    }

    function showAIAnalysisResult(aid, result) {
        var existing = document.querySelector('.ai-analysis-overlay');
        if (existing) existing.remove();

        var item = allWorksList.find(function(i) { return String(i.aweme_id) === aid; });
        var title = (item || {}).desc || '未知作品';

        var overlay = document.createElement('div');
        overlay.className = 'ai-analysis-overlay show';
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

        function esc(s) { return escapeHtml(String(s == null ? '' : s)); }
        function firstValue(obj, keys) {
            for (var i = 0; i < keys.length; i++) {
                if (obj && obj[keys[i]] != null && obj[keys[i]] !== '') return obj[keys[i]];
            }
            return '';
        }
        function textValue(value) {
            if (Array.isArray(value)) return value.filter(Boolean).join('；');
            if (value && typeof value === 'object') {
                return Object.keys(value).map(function(k) {
                    return k + '：' + textValue(value[k]);
                }).join('；');
            }
            return value == null ? '' : String(value);
        }
        function sectionTable(titleText, rows) {
            rows = rows.filter(function(row) { return textValue(row[1]); });
            if (!rows.length) return '';
            var body = rows.map(function(row) {
                return '<tr><th>' + esc(row[0]) + '</th><td>' + esc(textValue(row[1])) + '</td></tr>';
            }).join('');
            return '<div class="ai-analysis-section"><h3>' + esc(titleText) + '</h3><table class="ai-analysis-table"><tbody>' + body + '</tbody></table></div>';
        }
        function renderUnknownObject(obj) {
            if (!obj || typeof obj !== 'object') return '';
            var used = {
                one_sentence_summary: true, summary: true, conclusion: true,
                hook: true, opening_hook: true,
                structure: true, narrative_structure: true,
                ending: true, ending_guide: true,
                viral_analysis: true, viral: true,
                reusable_techniques: true, techniques: true, reusable_methods: true
            };
            var rows = Object.keys(obj).filter(function(k) { return !used[k]; }).map(function(k) { return [k, obj[k]]; });
            return sectionTable('其他分析', rows);
        }

        result = result || {};
        var summary = firstValue(result, ['one_sentence_summary', 'summary', 'conclusion', '一句话总结']);
        var hook = firstValue(result, ['hook', 'opening_hook', '开头钩子']) || {};
        var structure = firstValue(result, ['structure', 'narrative_structure', '论述结构', '中间论述结构']) || {};
        var ending = firstValue(result, ['ending', 'ending_guide', '结尾引导']) || {};
        var viral = firstValue(result, ['viral_analysis', 'viral', '爆款归因']) || {};
        var techniques = firstValue(result, ['reusable_techniques', 'techniques', 'reusable_methods', '可复用技巧']);

        var html = '<div class="ai-analysis-card">' +
            '<div class="ai-analysis-header">' +
            '<span class="ai-analysis-title">AI 文案拆解 - ' + esc(title.substring(0, 25)) + '</span>' +
            '<button class="ai-analysis-close">&times;</button></div>' +
            '<div class="ai-analysis-body">';

        var hasContent = false;
        if (summary) {
            hasContent = true;
            html += '<div class="ai-analysis-section"><h3>一句话总结</h3>' +
                '<p class="ai-analysis-summary">' + esc(textValue(summary)) + '</p></div>';
        }

        var block;
        block = sectionTable('开头钩子', [
            ['类型', firstValue(hook, ['type', '类型'])],
            ['原文', firstValue(hook, ['text', 'original_text', 'quote', '原文'])],
            ['分析', firstValue(hook, ['analysis', 'why_effective', 'reason', '分析', '为什么有效'])]
        ]);
        if (block) { hasContent = true; html += block; }

        block = sectionTable('论述结构', [
            ['叙事类型', firstValue(structure, ['narrative_type', 'type', 'structure_type', '叙事类型'])],
            ['情绪曲线', firstValue(structure, ['emotional_curve', 'emotion_curve', '情绪曲线'])],
            ['分析', firstValue(structure, ['analysis', 'reason', '分析'])]
        ]);
        if (block) { hasContent = true; html += block; }

        block = sectionTable('结尾引导', [
            ['类型', firstValue(ending, ['type', 'guide_type', '类型'])],
            ['原文', firstValue(ending, ['text', 'original_text', 'quote', '原文'])],
            ['分析', firstValue(ending, ['analysis', 'effect', '分析', '效果分析'])]
        ]);
        if (block) { hasContent = true; html += block; }

        block = sectionTable('爆款归因', [
            ['完播驱动力', firstValue(viral, ['completion_driver', 'completion', '完播驱动力'])],
            ['点赞触发点', firstValue(viral, ['like_trigger', 'like', '点赞触发点'])],
            ['评论触发点', firstValue(viral, ['comment_trigger', 'comment', '评论触发点'])],
            ['收藏触发点', firstValue(viral, ['save_trigger', 'collect_trigger', 'save', '收藏触发点'])],
            ['分享触发点', firstValue(viral, ['share_trigger', 'share', '分享触发点'])]
        ]);
        if (block) { hasContent = true; html += block; }

        if (techniques) {
            hasContent = true;
            var list = Array.isArray(techniques) ? techniques : [techniques];
            var tags = list.map(function(t, i) {
                return '<span class="ai-analysis-tag">' + (i + 1) + '. ' + esc(textValue(t)) + '</span>';
            }).join('');
            html += '<div class="ai-analysis-section"><h3>可复用技巧</h3><div class="ai-analysis-tags">' + tags + '</div></div>';
        }

        var unknown = renderUnknownObject(result);
        if (unknown) { hasContent = true; html += unknown; }

        if (!hasContent) {
            html += '<div class="ai-analysis-empty">AI 已返回结果，但字段格式和页面预期不一致。请重新拆解或查看控制台原始返回。</div>';
            console.warn('[AI 拆解] 未匹配到可展示字段:', result);
        }

        html += '</div></div>';
        overlay.innerHTML = html;
        document.body.appendChild(overlay);

        overlay.querySelector('.ai-analysis-close').onclick = function() { overlay.remove(); };
        overlay.querySelector('.ai-analysis-card').onclick = function(e) { e.stopPropagation(); };
    }


    /**
     * 导出选中视频，下载后打包为一个 zip 文件
     * 使用 fflate 流式打包（level:0 不压缩，视频已压缩）
     */
    async function exportVideoZip() {
        // 从 DOM 回读勾选状态
        document.querySelectorAll("#tableBody input[type=checkbox]:checked, #gridViewContainer .grid-card-check:checked").forEach(cb => {
            selectedIds.add(cb.dataset.aid);
        });
        if (!selectedIds.size) return alert("请勾选至少一条作品！");

        const videoItems = allWorksList.filter(item =>
            selectedIds.has(String(item.aweme_id)) && !item.images
        );
        if (!videoItems.length) {
            return alert("选中的作品中没有视频类型，请选择视频作品后再试！");
        }

        reportUsage('export_video', '导出视频 ' + videoItems.length + '个');

        // 等待 fflate 加载
        try {
            await waitFflate();
        } catch (e) {
            return alert(e.message);
        }

        const overlay = document.getElementById("exportVideoOverlay");
        const fill = document.getElementById("exportVideoProgressFill");
        const text = document.getElementById("exportVideoProgressText");
        const countEl = document.getElementById("exportVideoCount");
        const cancelBtn = document.getElementById("exportVideoCancelBtn");

        let cancelled = false;
        let successCount = 0;
        let failCount = 0;

        overlay.classList.add("show");
        fill.style.width = "0%";

        cancelBtn.onclick = () => {
            cancelled = true;
            text.textContent = "已取消";
            setTimeout(() => overlay.classList.remove("show"), 1500);
        };

        // 阶段 1：逐个下载视频 blob，收集到内存
        const collected = [];  // [{blob, filename}]
        for (let i = 0; i < videoItems.length; i++) {
            if (cancelled) break;

            const item = videoItems[i];
            const idx = i + 1;
            const safeTitle = (item.desc || "无标题").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 50);

            text.textContent = `正在下载 ${idx}/${videoItems.length}...`;
            countEl.textContent = `当前：${safeTitle.slice(0, 30)}`;
            fill.style.width = `${((idx - 1) / videoItems.length) * 75}%`;  // 75% 留给打包阶段

            try {
                const result = await fetchVideoBlob(item);
                if (result) {
                    collected.push(result);
                    successCount++;
                } else {
                    failCount++;
                }
            } catch (e) {
                console.error("[导出视频] 处理失败：", item.aweme_id, e.message);
                failCount++;
            }
        }

        if (cancelled || collected.length === 0) {
            if (!cancelled) {
                overlay.classList.remove("show");
                alert("没有视频可以打包，请查看控制台日志。");
            }
            updateSelCount();
            return;
        }

        // 阶段 2：fflate 打包所有 blob 为 zip
        text.textContent = "正在打包 zip...";
        countEl.textContent = `共 ${collected.length} 个视频`;
        fill.style.width = "80%";

        try {
            const { zipSync } = window.fflate;

            // 构建文件字典 { filename: Uint8Array }
            const fileMap = {};
            for (const { blob, filename } of collected) {
                const ab = await blob.arrayBuffer();
                fileMap[filename] = [new Uint8Array(ab), { level: 0 }];  // level:0 不压缩（视频已压缩）
            }

            fill.style.width = "95%";
            const zipData = zipSync(fileMap);
            fill.style.width = "100%";

            // 触发 zip 下载
            const nickname = userProfile?.nickname || "导出";
            const dateStr = new Date().toISOString().slice(0, 10);
            const zipFilename = `抖音视频_${nickname}_${dateStr}.zip`;
            triggerDownload(new Blob([zipData], { type: "application/zip" }), zipFilename);

            text.textContent = "打包完成！";
            countEl.textContent = `共 ${successCount} 个视频${failCount > 0 ? `，${failCount} 个失败` : ""}`;
            setTimeout(() => overlay.classList.remove("show"), 3000);

            if (failCount > 0) {
                setTimeout(() => {
                    alert(`${successCount} 个视频已打包下载。\n${failCount} 个视频下载失败，已跳过，请查看控制台日志。`);
                }, 3500);
            }
        } catch (e) {
            console.error("[导出视频] zip 打包失败：", e);
            overlay.classList.remove("show");
            alert(`zip 打包失败：${e.message}`);
        }
    }

    // ============================================================
    //  10. 初始化入口
    // ============================================================

    /**
     * 初始化主流程：
     *   1. 获取用户资料 → 渲染用户卡片
     *   2. 分页拉取全部作品（带进度条）
     *   3. 更新顶部作品数为实际加载数
     *   4. 渲染数据表格
     */
    async function init() {
        try {
            userProfile = await getUserProfile();
            renderUserInfo(userProfile);
            await getAllWorks();
            if (analysisMode === 'self') {
                updateSelfAnalytics(false);
                currentView = 'dashboard';
                localStorage.setItem('hankin-dy-drawer-view', currentView);
                switchView(currentView);
            }
            // 更新顶部作品数为实际加载数
            const el = document.getElementById('userWorkCount');
            if (el) el.textContent = allWorksList.length;
            renderTable();
            updateAnalysisModeUi();
        } catch (err) {
            console.log("数据加载失败：" + err.message + " — 请刷新页面后重新运行脚本");
            console.error(err);
            isLoading = false;
            hideLoadingProgress();
            const box = document.getElementById('userInfoBox');
            if (box && !userProfile) { box.textContent = '解析失败：'+err.message; box.style.color = '#b45309'; }
            const tbody = document.getElementById('tableBody');
            if (tbody && !allWorksList.length) {
                tbody.replaceChildren();
                const row = tbody.insertRow();
                const cell = row.insertCell(); cell.colSpan = 16;
                cell.textContent = '解析失败：'+err.message+'。请检查登录状态后点击重新解析。';
                cell.style.cssText = 'padding:24px;color:#b45309;white-space:normal';
            }
            const dashboard = document.getElementById('dashboardContainer');
            if (dashboard && !allWorksList.length) dashboard.textContent = '解析失败：'+err.message;
        }
    }

    // ============================================================
    //  11. 启动
    // ============================================================

    // 立即创建 DOM 结构（不依赖异步数据）
    createDrawerDom();
    // 记录页面访问（侧边面板已创建）
    reportUsage('page_view', '打开面板|' + (window.location.pathname || ''));
    // 依赖已由扩展预加载，直接启动
    await init();

    if (playCountObserver) playCountObserver.disconnect();
    playCountObserver = new MutationObserver(records => {
        if (analysisMode !== 'self') return;
        if (records.every(record => record.target.nodeType === 1 && record.target.closest?.('#dy-drawer-wrap'))) return;
        clearTimeout(playCountRefreshTimer);
        playCountRefreshTimer = setTimeout(() => updateSelfAnalytics(true), 500);
    });
    playCountObserver.observe(document.body, { childList: true, subtree: true });
    if (analysisMode === 'self') window.__DcxzsToggleDrawer(true);

    // 评论模块已由扩展预加载（window.DyComment 已可用）

    // Chrome 扩展消息监听：允许 popup 控制抽屉开关
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message && message.action === 'toggle_drawer') {
                if (typeof window.__DcxzsToggleDrawer === 'function') {
                    sendResponse(window.__DcxzsToggleDrawer());
                } else {
                    sendResponse({ ok: false, msg: 'drawer_not_ready' });
                }
            }
            return true;
        });
    }
})();
