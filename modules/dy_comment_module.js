/**
 * dy_comment_module.js — 抖音评论模块 v1.0
 * 
 * 独立模块，通过 window.DyComment 暴露接口。
 * 在主文件 fetch_dy_user_profile.js 末尾动态加载本文件即可。
 *
 * 使用方式（主文件）：
 *   window.DyComment.open(item)   // 打开指定作品的评论弹窗
 *   window.DyComment.close()      // 关闭弹窗
 *
 * 参数 item 为作品数据对象，至少需要 { aweme_id, desc, statistics.comment_count }
 */

(function () {
    'use strict';

    try {

    // ============================================================
    //  0. 配置
    // ============================================================
    const CONFIG = {
        BASE_HOST: 'https://www.douyin.com',
        COMMENT_API: '/aweme/v1/web/comment/list/',
        REPLY_API: '/aweme/v1/web/comment/list/reply/',
        MAX_ROWS: 2000,                // 最大拉取总条数
        PAGE_SIZE_OPTIONS: [20, 50, 100, 200, 500, 1000],
        DEFAULT_PAGE_SIZE: 20,
        REQUEST_DELAY: 350,            // 每次请求间隔 ms（防限流）
        MAX_RETRIES: 2,                // 失败重试次数
        RETRY_DELAY: 1000,             // 重试间隔
        CACHE_VERSION: 2,              // 缓存版本，结构变更时递增，旧缓存自动失效
    };

    // ============================================================
    //  1. 状态
    // ============================================================
    const STATE = {
        modalVisible: false,
        itemId: null,
        itemDesc: '',
        itemCommentTotal: 0,
        allRows: [],                   // 扁平化全部数据 [{ _rowIndex, type, cid, parent_cid, parent_text, text, nickname, digg_count, create_time, create_time_str }]
        isLoading: false,
        loadingCancelled: false,
        progress: 0,
        progressText: '',
        currentPage: 1,
        pageSize: CONFIG.DEFAULT_PAGE_SIZE,
        sortField: null,               // null=原始顺序, 'create_time'=时间排序
        sortOrder: 'asc',              // asc / desc
        reachedLimit: false,           // 是否已达拉取上限
        parentColumnVisible: true,     // 「所属评论」列是否可见
        // 缓存 { aweme_id: { rows, loadedAt, reachedLimit } }
        cache: {}
    };

    // ============================================================
    //  2. 工具函数（模块内自包含，不依赖主文件）
    // ============================================================

    /** 数字简化显示（万） */
    function formatNumber(n) {
        n = Number(n) || 0;
        if (n >= 10000) return (n / 10000).toFixed(1) + '万';
        return n.toLocaleString();
    }

    /** 时间戳 → "2024-01-15 14:30:00" */
    function formatDateTime(ts) {
        if (!ts) return '-';
        const d = new Date(Number(ts) * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /** 相对时间 */
    function timeAgo(ts) {
        if (!ts) return '';
        const now = Math.floor(Date.now() / 1000);
        const diff = now - Number(ts);
        if (diff < 60) return '刚刚';
        if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
        if (diff < 2592000) return Math.floor(diff / 86400) + '天前';
        if (diff < 31536000) return Math.floor(diff / 2592000) + '个月前';
        return Math.floor(diff / 31536000) + '年前';
    }

    /** 触发浏览器下载 */
    function triggerDownload(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    }

    /** 等待指定毫秒 */
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /** 安全获取 nested 属性 */
    function safeGet(obj, path, fallback) {
        return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? fallback;
    }

    /** 检测当前是否深色模式 */
    function isDarkMode() {
        const wrap = document.getElementById('dy-drawer-wrap');
        if (wrap) return wrap.classList.contains('dark-mode');
        return localStorage.getItem('hankin-dy-drawer-theme') === 'dark';
    }

    /** 获取当前主题变量 */
    function getTheme() {
        return isDarkMode() ? 'dark' : 'light';
    }

    /** 切换评论抽屉的主题（与主抽屉共享 localStorage + dark-mode 类） */
    function toggleCommentTheme() {
        var wrap = document.getElementById('dy-drawer-wrap');
        if (!wrap) return;
        var isDark = wrap.classList.contains('dark-mode');
        if (isDark) {
            wrap.classList.remove('dark-mode');
            localStorage.setItem('hankin-dy-drawer-theme', 'light');
        } else {
            wrap.classList.add('dark-mode');
            localStorage.setItem('hankin-dy-drawer-theme', 'dark');
        }
        syncCommentThemeButton();
        // 同步主抽屉的 theme button（如果存在）
        var mainBtn = document.getElementById('themeToggleBtn');
        if (mainBtn) {
            var newDark = wrap.classList.contains('dark-mode');
            mainBtn.innerHTML = newDark
                ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.636l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.636l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>\u6d45\u8272\u6a21\u5f0f'
                : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>\u6df1\u8272\u6a21\u5f0f';
        }
    }

    /** 同步评论抽屉主题按钮的图标和文字 */
    function syncCommentThemeButton() {
        var btn = document.getElementById('cmt-btn-theme');
        if (!btn) return;
        var dark = isDarkMode();
        btn.innerHTML = dark
            ? '<svg class="cmt-theme-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.636l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.636l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>\u6d45\u8272\u6a21\u5f0f'
            : '<svg class="cmt-theme-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>\u6df1\u8272\u6a21\u5f0f';
    }

    // ============================================================
    //  3. DOM 注入（只执行一次）
    // ============================================================
    let _domInjected = false;

    function injectStyles() {
        if (document.getElementById('dy-comment-module-styles')) return;
        const css = /* css */ `
/* ====== 评论抽屉 ====== */
/* 遮罩层 */
.comment-modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.25); z-index: 200002;
    display: block; opacity: 0; pointer-events: none;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    transition: opacity 0.35s ease;
}
.comment-modal-overlay.show { opacity: 1; pointer-events: auto; }

/* 抽屉面板 — 从右侧滑入 */
.comment-modal-panel {
    position: fixed; right: -75vw; top: 0; width: 75vw; height: 100vh; z-index: 200003;
    background: #fff; box-shadow: -4px 0 24px rgba(0,0,0,0.12);
    display: flex; flex-direction: column; overflow: hidden;
    transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    border-radius: 12px 0 0 12px;
}
.comment-modal-overlay.show ~ .comment-modal-panel { right: 0; }
#dy-drawer-wrap.dark-mode .comment-modal-panel { background: #1a1a1a; }

/* 顶部栏 */
.comment-modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; border-bottom: 1px solid #eee; flex-shrink: 0;
}
#dy-drawer-wrap.dark-mode .comment-modal-header { border-color: #404040; }
.comment-modal-title {
    font-size: 16px; font-weight: 600; color: #1a1a1a; display: flex; align-items: center; gap: 8px;
}
#dy-drawer-wrap.dark-mode .comment-modal-title { color: #e5e5e5; }
.comment-modal-title .aweme-desc {
    font-size: 13px; font-weight: 400; color: #999; max-width: 400px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.comment-modal-header-btns { display: flex; align-items: center; gap: 8px; }
.comment-modal-header-btn {
    padding: 6px 14px; border-radius: 7px; border: 1px solid #e8e8e8; background: #f5f5f5;
    font-size: 13px; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; gap: 4px;
    color: #333; white-space: nowrap;
}
.comment-modal-header-btn:hover { background: #eee; }
#dy-drawer-wrap.dark-mode .comment-modal-header-btn { background: #404040; border-color: #555; color: #e5e5e5; }
#dy-drawer-wrap.dark-mode .comment-modal-header-btn:hover { background: #555; }
.comment-modal-header-btn.danger { color: #fe2c55; border-color: #fe2c5540; }
.comment-modal-header-btn.danger:hover { background: #fe2c5510; }
.comment-modal-header-btn.primary { background: #fe2c55; color: #fff; border-color: #fe2c55; }
.comment-modal-header-btn.primary:hover { background: #e5264c; }
.comment-modal-close {
    width: 32px; height: 32px; border-radius: 6px; border: none; background: transparent;
    font-size: 20px; cursor: pointer; color: #999; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; line-height: 1;
}
.comment-modal-close:hover { background: #f5f5f5; color: #333; }
#dy-drawer-wrap.dark-mode .comment-modal-close:hover { background: #404040; color: #e5e5e5; }

/* 统计栏 */
.comment-modal-stats {
    padding: 10px 20px; border-bottom: 1px solid #eee; flex-shrink: 0;
    font-size: 13px; color: #666; display: flex; align-items: center; justify-content: space-between;
}
#dy-drawer-wrap.dark-mode .comment-modal-stats { border-color: #404040; color: #aaa; }
.comment-modal-stats .stats-left { display: flex; align-items: center; gap: 16px; }
.comment-modal-stats .stats-left span { display: flex; align-items: center; gap: 4px; }
.comment-modal-stats .stats-warn { font-size: 12px; color: #f59e0b; display: flex; align-items: center; gap: 4px; }

/* 进度条 */
.comment-modal-progress {
    padding: 20px 20px; border-bottom: 1px solid #eee; flex-shrink: 0; display: none;
}
#dy-drawer-wrap.dark-mode .comment-modal-progress { border-color: #404040; }
.comment-modal-progress.show { display: block; }
.comment-modal-progress .progress-info { font-size: 13px; color: #666; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .progress-info { color: #aaa; }
.comment-modal-progress .progress-bar-wrap { width: 100%; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .progress-bar-wrap { background: #404040; }
.comment-modal-progress .progress-bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #fe2c55, #ff6b81); transition: width 0.3s; }
.comment-modal-progress .progress-text { font-size: 12px; color: #999; margin-top: 6px; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .progress-text { color: #777; }
.comment-modal-progress .cancel-btn {
    margin-top: 10px; padding: 5px 16px; border-radius: 6px; border: 1px solid #ddd;
    background: #fff; font-size: 12px; cursor: pointer; color: #666; transition: all 0.15s;
}
.comment-modal-progress .cancel-btn:hover { background: #f5f5f5; color: #fe2c55; border-color: #fe2c5540; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .cancel-btn { background: #2d2d2d; border-color: #555; color: #aaa; }
#dy-drawer-wrap.dark-mode .comment-modal-progress .cancel-btn:hover { background: #404040; }

/* 空状态 */
.comment-modal-empty {
    flex: 1; display: none; align-items: center; justify-content: center;
    color: #999; font-size: 14px; text-align: center; padding: 40px;
}
.comment-modal-empty.show { display: flex; }
#dy-drawer-wrap.dark-mode .comment-modal-empty { color: #777; }

/* 表格容器 */
.comment-table-wrap { flex: 1; overflow: auto; position: relative; display: none; }
.comment-table-wrap.show { display: block; }

/* 评论表格 */
.comment-table { min-width: 1300px; border-collapse: collapse; table-layout: fixed; }
.comment-table thead { position: sticky; top: 0; z-index: 10; }
.comment-table thead th {
    background: #fafafa; padding: 10px 10px; font-size: 12px; font-weight: 600;
    color: #666; text-align: left; border-bottom: 2px solid #eee; white-space: nowrap;
}
#dy-drawer-wrap.dark-mode .comment-table thead th { background: #333; color: #bbb; border-color: #444; }
.comment-table thead th.sortable { cursor: pointer; user-select: none; transition: color 0.15s; }
.comment-table thead th.sortable:hover { color: #fe2c55; }
.comment-table thead th.sort-active .sort-arrow { color: #fe2c55; }
.comment-table thead th .sort-arrow { display: inline-block; margin-left: 3px; font-size: 10px; color: #ccc; }
.comment-table thead th.sort-active .sort-arrow { color: #fe2c55; }

.comment-table tbody td {
    padding: 10px 10px; font-size: 13px; color: #333; border-bottom: 1px solid #f0f0f0;
    vertical-align: top; word-break: break-word;
}
#dy-drawer-wrap.dark-mode .comment-table tbody td { color: #e5e5e5; border-color: #3a3a3a; }
#dy-drawer-wrap.dark-mode .comment-table tbody td[style*="color:#666"] { color: #aaa !important; }
#dy-drawer-wrap.dark-mode .comment-table tbody td[style*="color:#999"] { color: #777 !important; }
.comment-table tbody tr:hover { background: #fafbff; }
#dy-drawer-wrap.dark-mode .comment-table tbody tr:hover { background: #333; }
.comment-table tbody tr.row-reply { background: #fafafa; }
#dy-drawer-wrap.dark-mode .comment-table tbody tr.row-reply { background: #2a2a2a; }

/* 类型标签 */
.cmt-type-tag {
    display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px;
    border-radius: 4px; font-size: 11px; font-weight: 600; white-space: nowrap;
}
.cmt-type-tag.comment { background: #2d3d4d29; color: #4ade80; }
.cmt-type-tag.reply { background: #2d3d4d29; color: #4fa3ff; }
#dy-drawer-wrap.dark-mode .cmt-type-tag.comment { background: #1a3d2d; color: #4ade80; }
#dy-drawer-wrap.dark-mode .cmt-type-tag.reply { background: #2d3d4d; color: #4fa3ff; }

/* 所属评论列折叠按钮 */
.cmt-parent-toggle { cursor: pointer; color: #999; font-size: 11px; transition: color 0.15s; margin-left: 4px; }
.cmt-parent-toggle:hover { color: #fe2c55; }

/* JSON原数据 按钮 */
.cmt-json-btn {
    padding: 3px 10px; border-radius: 4px; border: 1px solid #ddd; background: #fff;
    cursor: pointer; font-size: 11px; color: #666; transition: all 0.15s; white-space: nowrap;
}
.cmt-json-btn:hover { background: #fe2c55; color: #fff; border-color: #fe2c55; }
#dy-drawer-wrap.dark-mode .cmt-json-btn { background: #2d2d2d; border-color: #555; color: #aaa; }
#dy-drawer-wrap.dark-mode .cmt-json-btn:hover { background: #fe2c55; color: #fff; border-color: #fe2c55; }

/* JSON原数据 查看弹层 */
.cmt-json-modal {
    position: fixed; inset: 0; z-index: 200003; display: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
}
.cmt-json-modal.show { display: flex; }
.cmt-json-modal-inner {
    background: #fff; border-radius: 12px; box-shadow: 0 8px 40px rgba(0,0,0,0.2);
    width: 600px; max-width: 90vw; max-height: 80vh; display: flex; flex-direction: column;
    overflow: hidden;
}
#dy-drawer-wrap.dark-mode .cmt-json-modal-inner { background: #2d2d2d; }
.cmt-json-modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 18px; border-bottom: 1px solid #eee; flex-shrink: 0;
    font-size: 14px; font-weight: 600; color: #333;
}
#dy-drawer-wrap.dark-mode .cmt-json-modal-header { border-color: #444; color: #e5e5e5; }
.cmt-json-modal-close {
    background: none; border: none; font-size: 18px; cursor: pointer;
    color: #999; padding: 0; line-height: 1; transition: color 0.15s;
}
.cmt-json-modal-close:hover { color: #fe2c55; }
.cmt-json-copy-btn {
    padding: 4px 12px; border-radius: 4px; border: 1px solid #ddd;
    background: #fff; cursor: pointer; font-size: 12px; color: #666;
    transition: all 0.15s;
}
.cmt-json-copy-btn:hover { background: #fe2c55; color: #fff; border-color: #fe2c55; }
#dy-drawer-wrap.dark-mode .cmt-json-copy-btn { background: #333; border-color: #555; color: #aaa; }
#dy-drawer-wrap.dark-mode .cmt-json-copy-btn:hover { background: #fe2c55; color: #fff; border-color: #fe2c55; }
.cmt-json-modal-body {
    padding: 16px 18px; overflow: auto; flex: 1;
}
.cmt-json-modal-body pre {
    margin: 0; font-family: 'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace;
    font-size: 12px; line-height: 1.6; color: #333; white-space: pre-wrap;
    word-break: break-all;
}
#dy-drawer-wrap.dark-mode .cmt-json-modal-body pre { color: #e5e5e5; }

/* 分页栏 */
.comment-modal-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 20px; border-top: 1px solid #eee; flex-shrink: 0; display: none;
}
.comment-modal-footer.show { display: flex; }
#dy-drawer-wrap.dark-mode .comment-modal-footer { border-color: #404040; }
.comment-modal-footer select {
    padding: 4px 8px; border-radius: 5px; border: 1px solid #ddd; font-size: 13px;
    cursor: pointer; background: #fff; color: #333;
}
#dy-drawer-wrap.dark-mode .comment-modal-footer select { background: #2d2d2d; border-color: #555; color: #e5e5e5; }
.comment-modal-footer .page-nav { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #666; }
#dy-drawer-wrap.dark-mode .comment-modal-footer .page-nav { color: #aaa; }
.comment-modal-footer .page-nav button {
    padding: 4px 12px; border-radius: 5px; border: 1px solid #ddd; background: #fff;
    cursor: pointer; font-size: 12px; color: #333; transition: all 0.15s;
}
.comment-modal-footer .page-nav button:hover:not(:disabled) { background: #f5f5f5; border-color: #fe2c55; color: #fe2c55; }
.comment-modal-footer .page-nav button:disabled { opacity: 0.4; cursor: not-allowed; }
#dy-drawer-wrap.dark-mode .comment-modal-footer .page-nav button { background: #2d2d2d; border-color: #555; color: #e5e5e5; }
.comment-modal-footer .page-nav .page-input { width: 42px; padding: 4px 6px; border-radius: 5px; border: 1px solid #ddd; text-align: center; font-size: 12px; }
#dy-drawer-wrap.dark-mode .comment-modal-footer .page-nav .page-input { background: #2d2d2d; border-color: #555; color: #e5e5e5; }

/* 导出菜单 */
.cmt-export-menu {
    position: absolute; background: #fff; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    min-width: 130px; padding: 4px 0; z-index: 200003; display: none; border: 1px solid #eee;
}
.cmt-export-menu.show { display: block; }
#dy-drawer-wrap.dark-mode .cmt-export-menu { background: #2d2d2d; border-color: #444; }
.cmt-export-menu-item {
    padding: 8px 16px; font-size: 13px; cursor: pointer; display: flex; align-items: center;
    gap: 8px; color: #333; transition: background 0.1s; white-space: nowrap;
}
.cmt-export-menu-item:hover { background: #f5f5f5; }
#dy-drawer-wrap.dark-mode .cmt-export-menu-item { color: #e5e5e5; }
#dy-drawer-wrap.dark-mode .cmt-export-menu-item:hover { background: #404040; }

	/* AI 评论洞察按钮与结果弹窗 */
	.cmt-insight-btn { background: #6366f1; color: #fff; border-color: #6366f1; font-weight: 600; }
	.cmt-insight-btn:hover { background: #4f46e5 !important; color: #fff !important; }
	.cmt-insight-btn:disabled { opacity: 0.5; cursor: not-allowed; background: #a5b4fc; border-color: #a5b4fc; }
	.cmt-insight-btn.loading { background: #818cf8; border-color: #818cf8; }
	#dy-drawer-wrap.dark-mode .cmt-insight-btn:hover { background: #4f46e5 !important; }
	.cmt-insight-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200010; display: none; align-items: flex-start; justify-content: center; padding: 40px 20px 20px; overflow-y: auto; }
	.cmt-insight-overlay.show { display: flex; }
	.cmt-insight-card { background: #fff; border-radius: 14px; box-shadow: 0 12px 48px rgba(0,0,0,0.25); width: 90%; max-width: 750px; display: flex; flex-direction: column; overflow: hidden; margin-bottom: 20px; }
	.cmt-insight-header { padding: 16px 20px; border-bottom: 1px solid #e8e8e8; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
	.cmt-insight-title { font-weight: 600; font-size: 16px; display: flex; align-items: center; gap: 8px; }
	.cmt-insight-close { font-size: 20px; line-height: 1; cursor: pointer; padding: 4px 8px; border-radius: 4px; border: none; background: transparent; transition: background 0.2s; }
	.cmt-insight-close:hover { background: #f5f5f5; }
	.cmt-insight-body { padding: 20px; overflow: auto; flex: 1; max-height: 70vh; }
	.cmt-insight-section { margin-bottom: 18px; }
	.cmt-insight-section h3 { font-size: 14px; font-weight: 600; color: #333; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
	.cmt-insight-section p, .cmt-insight-section li { font-size: 13px; color: #555; line-height: 1.6; margin: 4px 0; }
	.cmt-insight-evidence { font-size: 12px; color: #999; font-style: italic; padding: 2px 0 2px 12px; border-left: 2px solid #e0e0e0; margin: 4px 0; }
	.cmt-insight-tag { display: inline-block; padding: 3px 12px; border-radius: 14px; font-size: 12px; background: #eef2ff; color: #6366f1; white-space: nowrap; margin: 2px 4px 2px 0; }
	.cmt-insight-tag.high { background: #fef2f2; color: #ef4444; }
	.cmt-insight-tag.mid { background: #fffbeb; color: #f59e0b; }
	.cmt-insight-tag.low { background: #f0fdf4; color: #22c55e; }
	.cmt-insight-sampling { font-size: 12px; color: #999; padding: 8px 12px; background: #f9fafb; border-radius: 8px; margin-bottom: 16px; }
	.cmt-insight-topic-card { padding: 10px 14px; background: #f9fafb; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid #6366f1; }
	.cmt-insight-topic-card h4 { font-size: 13px; font-weight: 600; color: #1a1a1a; margin-bottom: 4px; }
	.cmt-insight-topic-card p { font-size: 12px; color: #666; margin: 2px 0; }
	/* dark mode */
	#dy-drawer-wrap.dark-mode .cmt-insight-card { background: #2d2d2d; }
	#dy-drawer-wrap.dark-mode .cmt-insight-header { border-color: #404040; }
	#dy-drawer-wrap.dark-mode .cmt-insight-section h3 { color: #e5e5e5; }
	#dy-drawer-wrap.dark-mode .cmt-insight-section p { color: #bbb; }
	#dy-drawer-wrap.dark-mode .cmt-insight-evidence { color: #888; border-left-color: #555; }
	#dy-drawer-wrap.dark-mode .cmt-insight-sampling { background: #333; color: #888; }
	#dy-drawer-wrap.dark-mode .cmt-insight-topic-card { background: #333; }
	#dy-drawer-wrap.dark-mode .cmt-insight-topic-card h4 { color: #e5e5e5; }
	#dy-drawer-wrap.dark-mode .cmt-insight-topic-card p { color: #aaa; }
	#dy-drawer-wrap.dark-mode .cmt-insight-close:hover { background: #404040; }
`;
        const el = document.createElement('style');
        el.id = 'dy-comment-module-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function injectModalDOM() {
        if (document.getElementById('dy-comment-modal')) return;
        const html = /* html */ `
<div class="comment-modal-overlay" id="dy-comment-modal-overlay"></div>
<div class="comment-modal-panel" id="dy-comment-modal">
        <!-- 顶部栏 -->
        <div class="comment-modal-header">
            <div class="comment-modal-title">
                评论数据
                <span class="aweme-desc" id="cmt-aweme-desc"></span>
            </div>
            <div class="comment-modal-header-btns">
                <button class="comment-modal-header-btn" id="cmt-btn-theme" title="切换深色/浅色模式">
                    <svg class="cmt-theme-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>
                    </svg>
                    深色模式
                </button>
                <button class="comment-modal-header-btn" id="cmt-btn-reload" title="重新解析">重新解析</button>
                <button class="comment-modal-header-btn cmt-insight-btn" id="cmt-btn-insight" title="使用自己配置的大模型分析评论">评论洞察</button>
                <div style="position:relative;">
                    <button class="comment-modal-header-btn" id="cmt-btn-export" title="导出数据">导出 ▾</button>
                    <div class="cmt-export-menu" id="cmt-export-menu">
                        <div class="cmt-export-menu-item" data-format="json">导出 JSON</div>
                        <div class="cmt-export-menu-item" data-format="csv">导出 CSV</div>
                        <div class="cmt-export-menu-item" data-format="txt">导出 TXT</div>
                    </div>
                </div>
                <button class="comment-modal-close" id="cmt-btn-close" title="关闭">✕</button>
            </div>
        </div>
        <!-- 统计栏 -->
        <div class="comment-modal-stats" id="cmt-stats-bar" style="display:none;">
            <div class="stats-left">
                <span id="cmt-stats-total">共加载 0 条</span>
                <span id="cmt-stats-breakdown" style="color:#999;"></span>
            </div>
            <span class="stats-warn" id="cmt-stats-warn" style="display:none;"></span>
        </div>
        <!-- 进度条 -->
        <div class="comment-modal-progress" id="cmt-progress">
            <div class="progress-info">
                <span>正在拉取评论数据，请稍候...</span>
                <span id="cmt-progress-pct">0%</span>
            </div>
            <div class="progress-bar-wrap">
                <div class="progress-bar-fill" id="cmt-progress-bar" style="width:0%;"></div>
            </div>
            <div class="progress-text" id="cmt-progress-text"></div>
            <button class="cancel-btn" id="cmt-progress-cancel">取消拉取</button>
        </div>
        <!-- 空状态 -->
        <div class="comment-modal-empty" id="cmt-empty">
            <div>暂无评论数据</div>
        </div>
        <!-- 表格容器 -->
        <div class="comment-table-wrap" id="cmt-table-wrap">
            <table class="comment-table" id="cmt-table">
                <thead>
                    <tr>
                        <th style="width:50px;text-align:center;">#</th>
                        <th style="width:130px;">评论ID</th>
                        <th style="width:72px;">类型</th>
                        <th style="width:200px;" data-col="parent" id="cmt-col-parent">
                            所属评论 <span class="cmt-parent-toggle" id="cmt-parent-toggle" title="折叠/展开此列">◀</span>
                        </th>
                        <th>评论内容</th>
                        <th style="width:120px;">用户</th>
                        <th style="width:120px;">抖音ID</th>
                        <th style="width:100px;">抖音号</th>
                        <th style="width:80px;">IP</th>
                        <th style="width:72px;text-align:center;cursor:pointer;user-select:none;" 
                            class="sortable" id="cmt-sort-digg" data-sort="digg_count">
                            点赞 <span class="sort-arrow">▲</span>
                        </th>
                        <th style="width:160px;text-align:center;cursor:pointer;user-select:none;" 
                            class="sortable" id="cmt-sort-time" data-sort="create_time">
                            时间 <span class="sort-arrow">▲</span>
                        </th>
                        <th style="width:72px;text-align:center;">操作</th>
                    </tr>
                </thead>
                <tbody id="cmt-table-body"></tbody>
            </table>
        </div>
        <!-- 分页栏 -->
        <div class="comment-modal-footer" id="cmt-footer">
            <div>
                每页
                <select id="cmt-page-size"></select>
            </div>
            <div class="page-nav">
                <button id="cmt-prev-page">« 上一页</button>
                <span>第 <span id="cmt-page-current">1</span> / <span id="cmt-page-total">1</span> 页</span>
                <input type="number" class="page-input" id="cmt-page-jump" min="1" placeholder="跳转" style="width:50px;">
                <button id="cmt-next-page">下一页 »</button>
                <span style="font-size:12px;color:#999;">共 <span id="cmt-total-count">0</span> 条</span>
            </div>
        </div>
    </div>
    <!-- JSON原数据 查看弹层 -->
    <div class="cmt-json-modal" id="cmt-json-modal">
        <div class="cmt-json-modal-inner">
            <div class="cmt-json-modal-header">
                <span id="cmt-json-title">JSON 原数据</span>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button class="cmt-json-copy-btn" id="cmt-json-btn-copy" title="复制JSON数据">复制</button>
                    <button class="cmt-json-modal-close" id="cmt-json-btn-close" title="关闭">✕</button>
                </div>
            </div>
            <div class="cmt-json-modal-body">
                <pre id="cmt-json-content"></pre>
            </div>
        </div>
    </div>
</div>
`;
        const container = document.getElementById('dy-drawer-wrap') || document.body;
        const el = document.createElement('div');
        el.innerHTML = html;
        container.appendChild(el.firstElementChild); // 遮罩层
        container.appendChild(el.firstElementChild); // 抽屉面板
        container.appendChild(el.firstElementChild); // JSON 查看弹层
    }

    function ensureDOM() {
        if (!_domInjected) {
            injectStyles();
            injectModalDOM();
            _domInjected = true;
        }
    }

    // ============================================================
    //  4. API 层（极简参数，模拟用户浏览行为）
    // ============================================================

    /**
     * 构建评论 API URL（只加必要参数，不加任何签名/逆向参数）
     */
    function buildApiUrl(apiPath, awemeId, extraParams) {
        var url = new URL(CONFIG.BASE_HOST + apiPath);
        url.searchParams.set('aweme_id', String(awemeId));
        url.searchParams.set('device_platform', 'webapp');
        url.searchParams.set('aid', '6383');
        // 额外参数
        for (var k in extraParams) {
            if (extraParams.hasOwnProperty(k)) {
                url.searchParams.set(k, String(extraParams[k]));
            }
        }
        return url.toString();
    }

    /**
     * 带重试的 fetch
     */
    async function fetchWithRetry(url, retries) {
        retries = retries !== undefined ? retries : CONFIG.MAX_RETRIES;
        for (var attempt = 0; attempt <= retries; attempt++) {
            try {
                var res = await fetch(url, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        Referer: CONFIG.BASE_HOST + '/video/' + STATE.itemId,
                        'User-Agent': navigator.userAgent
                    }
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var json = await res.json();
                if (json.status_code !== 0) {
                    throw new Error(json.status_msg || 'API error (status_code=' + json.status_code + ')');
                }
                return json;
            } catch (err) {
                if (attempt < retries) {
                    console.warn('[评论模块] 请求失败 (' + (attempt + 1) + '/' + (retries + 1) + ')，' + CONFIG.RETRY_DELAY + 'ms 后重试:', err.message);
                    await sleep(CONFIG.RETRY_DELAY);
                } else {
                    throw err;
                }
            }
        }
    }

    /**
     * 拉取一页评论（单次 API 调用）
     */
    async function fetchCommentPage(awemeId, cursor) {
        var url = buildApiUrl(CONFIG.COMMENT_API, awemeId, {
            'cursor': String(cursor || 0),
            'count': '20'
        });
        console.log('[评论模块] 评论 API: ' + url);
        return await fetchWithRetry(url, 0);
    }

    /**
     * 拉取某条评论的全部回复（支持翻页）
     */
    async function fetchAllReplies(awemeId, commentId) {
        var replies = [];
        var cursor = 0;
        var maxPages = 10;
        var pageNum = 0;
        while (true) {
            if (STATE.loadingCancelled || pageNum >= maxPages) break;
            pageNum++;
            var url = buildApiUrl(CONFIG.REPLY_API, awemeId, {
                'comment_id': String(commentId),
                'cursor': String(cursor),
                'count': '10'
            });
            try {
                var res = await fetchWithRetry(url, 0);
                var list = res.comments || [];
                replies.push.apply(replies, list);
                if (!res.has_more || res.cursor === 0 || res.cursor === cursor) break;
                cursor = res.cursor;
                await sleep(600);
            } catch (err) {
                console.warn('[评论模块] 拉取评论 ' + commentId + ' 的回复失败:', err.message);
                break;
            }
        }
        return replies;
    }

    // ============================================================
    //  5. 数据加载（含 localStorage 缓存）
    // ============================================================

    /** localStorage 缓存 key */
    function getCacheKey(awemeId) {
        return 'hankin_dy_comment_cache_' + awemeId;
    }

    /** 从 localStorage 读取缓存 */
    function loadFromLocalStorage(awemeId) {
        try {
            var raw = localStorage.getItem(getCacheKey(awemeId));
            if (!raw) return null;
            var data = JSON.parse(raw);
            // 版本不匹配则丢弃旧缓存
            if (data._v !== CONFIG.CACHE_VERSION) return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    /** 写入 localStorage 缓存 */
    function saveToLocalStorage(awemeId, data) {
        try {
            // 限制缓存体积：如果数据太大就只存前500条
            var toSave = data;
            if (toSave.rows && toSave.rows.length > 500) {
                toSave = {
                    rows: data.rows.slice(0, 500),
                    loadedAt: data.loadedAt,
                    reachedLimit: true,
                    _truncated: true,
                    _total: data.rows.length
                };
            }
            toSave._v = CONFIG.CACHE_VERSION;  // 写入缓存版本号
            localStorage.setItem(getCacheKey(awemeId), JSON.stringify(toSave));
            console.log('[评论模块] 缓存已写入 localStorage: ' + toSave.rows.length + ' 条 (v' + CONFIG.CACHE_VERSION + ')');
        } catch (e) {
            console.warn('[评论模块] localStorage 缓存写入失败:', e.message);
        }
    }

    /**
     * 主加载流程：拉取评论 + 回复，扁平化合并
     */
    async function loadComments(item) {
        var itemId = item.aweme_id;
        var totalEstimate = Number(item.statistics?.comment_count) || 0;

        // ① 先查 localStorage 缓存
        var localCached = loadFromLocalStorage(itemId);
        if (localCached && localCached.rows && localCached.rows.length > 0) {
            console.log('[评论模块] 从 localStorage 缓存加载: ' + localCached.rows.length + ' 条');
            STATE.allRows = localCached.rows;
            STATE.reachedLimit = !!localCached.reachedLimit;
            STATE.itemId = itemId;
            STATE.itemDesc = item.desc || '';
            STATE.itemCommentTotal = totalEstimate;
            STATE.currentPage = 1;
            renderAfterLoad();
            return;
        }

        // ② 再查内存缓存
        var memCached = STATE.cache[itemId];
        if (memCached) {
            STATE.allRows = [...memCached.rows];
            STATE.reachedLimit = memCached.reachedLimit;
            STATE.itemId = itemId;
            STATE.itemDesc = item.desc || '';
            STATE.itemCommentTotal = totalEstimate;
            STATE.currentPage = 1;
            renderAfterLoad();
            return;
        }

        // ③ 开始网络拉取
        STATE.isLoading = true;
        STATE.loadingCancelled = false;
        STATE.progress = 0;
        STATE.progressText = '';
        STATE.allRows = [];
        STATE.reachedLimit = false;
        STATE.itemId = itemId;
        STATE.itemDesc = item.desc || '';
        STATE.itemCommentTotal = totalEstimate;
        STATE.currentPage = 1;
        STATE.sortField = null;
        STATE.sortOrder = 'asc';

        showProgress(true);
        showTable(false);
        showEmpty(false);
        showFooter(false);
        updateStats();

        var allRows = [];
        var cursor = 0;
        var commentPageNum = 0;

        try {
            while (true) {
                if (STATE.loadingCancelled) {
                    console.log('[评论模块] 用户取消拉取');
                    break;
                }
                if (allRows.length >= CONFIG.MAX_ROWS) {
                    STATE.reachedLimit = true;
                    console.log('[评论模块] 已达拉取上限 ' + CONFIG.MAX_ROWS + ' 条');
                    break;
                }

                var pageData;
                try {
                    pageData = await fetchCommentPage(itemId, cursor);
                } catch (err) {
                    console.error('[评论模块] 拉取评论页失败:', err.message);
                    break;
                }

                var comments = pageData.comments || [];
                if (!comments.length) break;

                commentPageNum++;

                for (var ci = 0; ci < comments.length; ci++) {
                    var cmt = comments[ci];
                    if (allRows.length >= CONFIG.MAX_ROWS) { STATE.reachedLimit = true; break; }

                    // 添加评论行
                    allRows.push({
                        type: '评论',
                        cid: cmt.cid,
                        parent_cid: null,
                        parent_text: '',
                        text: (cmt.text || '').replace(/\n/g, ' '),
                        nickname: safeGet(cmt, 'user.nickname', '用户'),
                        uid: safeGet(cmt, 'user.uid', ''),
                        unique_id: safeGet(cmt, 'user.unique_id', ''),
                        ip_label: cmt.ip_label || '',
                        digg_count: Number(cmt.digg_count || 0),
                        create_time: Number(cmt.create_time || 0),
                        create_time_str: formatDateTime(cmt.create_time),
                        reply_total: Number(cmt.reply_comment_total || 0),
                        _raw: cmt
                    });

                    updateProgressUI(allRows.length, Math.max(totalEstimate, 1),
                        '拉取评论 (' + commentPageNum + '页)');

                    // 如果有回复，拉取
                    if (cmt.reply_comment_total > 0 && !STATE.loadingCancelled) {
                        var parentText = ((cmt.text || '').replace(/\n/g, ' ')).substring(0, 25);
                        updateProgressUI(allRows.length, Math.max(totalEstimate, 1),
                            '拉取回复... (' + (parentText || '(空)') + ')');
                        await sleep(CONFIG.REQUEST_DELAY);

                        var replies = await fetchAllReplies(itemId, cmt.cid);
                        for (var ri = 0; ri < replies.length; ri++) {
                            var rpy = replies[ri];
                            if (allRows.length >= CONFIG.MAX_ROWS) { STATE.reachedLimit = true; break; }
                            allRows.push({
                                type: '回复',
                                cid: rpy.cid,
                                parent_cid: cmt.cid,
                                parent_text: parentText.substring(0, 30),
                                text: (rpy.text || '').replace(/\n/g, ' '),
                                nickname: safeGet(rpy, 'user.nickname', '用户'),
                                uid: safeGet(rpy, 'user.uid', ''),
                                unique_id: safeGet(rpy, 'user.unique_id', ''),
                                ip_label: rpy.ip_label || '',
                                digg_count: Number(rpy.digg_count || 0),
                                create_time: Number(rpy.create_time || 0),
                                create_time_str: formatDateTime(rpy.create_time),
                                reply_total: 0,
                                _raw: rpy
                            });
                        }
                    }

                    if (STATE.reachedLimit) break;
                }

                if (STATE.reachedLimit) break;
                if (!pageData.has_more || pageData.cursor === 0) break;

                cursor = pageData.cursor;
                console.log('[评论模块] 已拉取 ' + allRows.length + ' 条，继续下一页 cursor=' + cursor);
                await sleep(1000);
            }
        } catch (err) {
            console.error('[评论模块] 加载评论出错:', err);
        }

        STATE.isLoading = false;
        STATE.loadingCancelled = false;

        // 设置序号
        allRows.forEach(function(r, i) { r._rowIndex = i + 1; });
        STATE.allRows = allRows;

        // 写入缓存（内存 + localStorage）
        STATE.cache[itemId] = {
            rows: allRows.slice(),
            loadedAt: Date.now(),
            reachedLimit: STATE.reachedLimit
        };
        saveToLocalStorage(itemId, {
            rows: allRows,
            loadedAt: Date.now(),
            reachedLimit: STATE.reachedLimit
        });

        renderAfterLoad();
    }

    function updateProgressUI(loaded, total, text) {
        STATE.progress = Math.min(Math.round((loaded / Math.min(total || 1, CONFIG.MAX_ROWS)) * 100), 99);
        STATE.progressText = text;
        renderProgress();
    }

    function renderAfterLoad() {
        showProgress(false);
        updateStats();
        if (STATE.allRows.length === 0) {
            showTable(false);
            showEmpty(true);
            showFooter(false);
        } else {
            showEmpty(false);
            showTable(true);
            showFooter(true);
            STATE.currentPage = 1;
            renderTableBody();
            renderPagination();
            updateSortIndicator();
        }
    }

    // ============================================================
    //  6. UI 渲染
    // ============================================================

    /** 获取当前排序后的分页数据 */
    function getSortedRows() {
        let rows = [...STATE.allRows];
        if (STATE.sortField === 'create_time' || STATE.sortField === 'digg_count') {
            rows.sort((a, b) => {
                const diff = (a[STATE.sortField] || 0) - (b[STATE.sortField] || 0);
                return STATE.sortOrder === 'asc' ? diff : -diff;
            });
            rows.forEach((r, i) => { r._rowIndex = i + 1; });
        }
        return rows;
    }

    function getTotalPages() {
        return Math.ceil(STATE.allRows.length / STATE.pageSize) || 1;
    }

    function renderTableBody() {
        const rows = getSortedRows();
        const start = (STATE.currentPage - 1) * STATE.pageSize;
        const pageRows = rows.slice(start, start + STATE.pageSize);
        const tbody = document.getElementById('cmt-table-body');
        if (!tbody) return;

        tbody.innerHTML = '';
        for (const r of pageRows) {
            const isReply = r.type === '回复';
            const allIdx = STATE.allRows.indexOf(r);
            const tr = document.createElement('tr');
            tr.className = isReply ? 'row-reply' : '';
            tr.innerHTML = `
                <td style="text-align:center;color:#999;font-size:12px;">${r._rowIndex}</td>
                <td style="font-size:12px;color:#666;font-family:monospace;">${r.cid}</td>
                <td><span class="cmt-type-tag ${isReply ? 'reply' : 'comment'}">${isReply ? '回复' : '评论'}</span></td>
                <td data-col="parent" style="font-size:12px;color:#999;${STATE.parentColumnVisible ? '' : 'display:none;'}">${r.parent_text || '-'}</td>
                <td style="line-height:1.6;">${escapeHtml(r.text)}</td>
                <td style="color:#666;font-size:12px;">${escapeHtml(r.nickname)}</td>
                <td style="font-size:12px;color:#666;font-family:monospace;">${escapeHtml(r.uid) || '-'}</td>
                <td style="font-size:12px;color:#666;">${escapeHtml(r.unique_id) || '-'}</td>
                <td style="font-size:12px;color:#999;">${escapeHtml(r.ip_label) || '-'}</td>
                <td style="text-align:center;font-weight:500;">${formatNumber(r.digg_count)}</td>
                <td style="text-align:center;font-size:12px;color:#999;" title="${r.create_time_str}">${r.create_time_str}</td>
                <td style="text-align:center;">
                    <button class="cmt-json-btn" data-row-idx="${allIdx}" title="查看原始JSON数据">json数据</button>
                </td>
            `;
            tbody.appendChild(tr);
        }
    }

    function renderPagination() {
        const totalPages = getTotalPages();
        const total = STATE.allRows.length;

        document.getElementById('cmt-page-current').textContent = STATE.currentPage;
        document.getElementById('cmt-page-total').textContent = totalPages;
        document.getElementById('cmt-total-count').textContent = total;
        document.getElementById('cmt-page-jump').max = totalPages;
        document.getElementById('cmt-page-jump').value = '';

        const prevBtn = document.getElementById('cmt-prev-page');
        const nextBtn = document.getElementById('cmt-next-page');
        prevBtn.disabled = STATE.currentPage <= 1;
        nextBtn.disabled = STATE.currentPage >= totalPages;
    }

    function updateStats() {
        const total = STATE.allRows.length;
        const commentRows = STATE.allRows.filter(r => r.type === '评论').length;
        const replyRows = STATE.allRows.filter(r => r.type === '回复').length;
        const actualTotal = STATE.itemCommentTotal;

        document.getElementById('cmt-stats-total').innerHTML = `共加载 ${formatNumber(total)} 条`;
        document.getElementById('cmt-stats-breakdown').textContent = `评论 ${formatNumber(commentRows)} / 回复 ${formatNumber(replyRows)}`;

        const warnEl = document.getElementById('cmt-stats-warn');
        if (STATE.reachedLimit || (total < actualTotal && total >= CONFIG.MAX_ROWS)) {
            warnEl.style.display = 'flex';
            warnEl.innerHTML = `实际评论数 ${formatNumber(actualTotal)}，已达拉取上限（${CONFIG.MAX_ROWS}条），可修改上限后重新解析`;
        } else if (total < actualTotal && total < CONFIG.MAX_ROWS) {
            warnEl.style.display = 'flex';
            warnEl.innerHTML = `实际评论 ${formatNumber(actualTotal)} 条，已加载 ${formatNumber(total)} 条（部分评论可能被删除或无法访问）`;
        } else {
            warnEl.style.display = 'none';
        }
    }

    function updateSortIndicator() {
        // 更新所有可排序列的指示器状态
        const sortableCols = [
            { id: 'cmt-sort-time', field: 'create_time' },
            { id: 'cmt-sort-digg', field: 'digg_count' }
        ];
        sortableCols.forEach(col => {
            const th = document.getElementById(col.id);
            if (!th) return;
            const arrow = th.querySelector('.sort-arrow');
            const isActive = STATE.sortField === col.field;
            th.classList.toggle('sort-active', isActive);
            if (arrow) {
                arrow.textContent = isActive ? (STATE.sortOrder === 'asc' ? '▲' : '▼') : '▲';
            }
        });
    }

    function renderProgress() {
        const pct = STATE.progress;
        document.getElementById('cmt-progress-pct').textContent = pct + '%';
        document.getElementById('cmt-progress-bar').style.width = pct + '%';
        document.getElementById('cmt-progress-text').textContent = STATE.progressText || '';
    }

    function showProgress(show) {
        const el = document.getElementById('cmt-progress');
        if (el) el.classList.toggle('show', show);
    }

    function showTable(show) {
        const el = document.getElementById('cmt-table-wrap');
        if (el) el.classList.toggle('show', show);
    }

    function showEmpty(show) {
        const el = document.getElementById('cmt-empty');
        if (el) el.classList.toggle('show', show);
    }

    function showFooter(show) {
        const el = document.getElementById('cmt-footer');
        if (el) el.classList.toggle('show', show);
        document.getElementById('cmt-stats-bar').style.display = show ? 'flex' : 'none';
    }

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ============================================================
    //  7. 导出
    // ============================================================

    function getExportRows() {
        return getSortedRows();
    }

    function exportJSON() {
        const rows = getExportRows();
        const data = rows.map(r => ({
            index: r._rowIndex,
            type: r.type,
            cid: r.cid,
            parent_cid: r.parent_cid || '',
            parent_text: r.parent_text || '',
            text: r.text,
            nickname: r.nickname,
            digg_count: r.digg_count,
            create_time: r.create_time_str
        }));
        const filename = `comments_${STATE.itemId}.json`;
        triggerDownload(JSON.stringify(data, null, 2), filename, 'application/json');
    }

    function exportCSV() {
        const rows = getExportRows();
        const BOM = '\uFEFF';
        const header = '序号,评论ID,类型,所属评论,评论内容,昵称,点赞,时间\n';
        const body = rows.map(r => {
            const esc = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
            return [r._rowIndex, r.cid, r.type, r.parent_text || '', esc(r.text), esc(r.nickname), r.digg_count, r.create_time_str].join(',');
        }).join('\n');
        triggerDownload(BOM + header + body, `comments_${STATE.itemId}.csv`, 'text/csv;charset=utf-8');
    }

    function exportTXT() {
        const rows = getExportRows();
        const lines = rows.map(r => `[${r.cid}] [${r.type}] ${r.nickname}：${r.text} (${r.create_time_str})`);
        triggerDownload(lines.join('\n'), `comments_${STATE.itemId}.txt`, 'text/plain;charset=utf-8');
    }

    function exportData(format) {
        if (STATE.allRows.length === 0) {
            alert('暂无数据可导出');
            return;
        }
        try {
            if (typeof window.__reportUsage__ === 'function') {
                window.__reportUsage__('export_comment_' + format, '导出评论 ' + STATE.allRows.length + '条');
            }
        } catch(e) {}
        switch (format) {
            case 'json': exportJSON(); break;
            case 'csv': exportCSV(); break;
            case 'txt': exportTXT(); break;
        }
        // 关闭导出菜单
        document.getElementById('cmt-export-menu').classList.remove('show');
    }

    // ============================================================
    //  7.5. AI 评论洞察
    // ============================================================

    function getAIConfig() {
        return window.__AI_CONFIG__ || {
            API_BASE: 'http://127.0.0.1:8765',
            getLimiterCount: function() { return 0; },
            incrementLimiter: function() {},
            decrementLimiter: function() {},
            aiLimiterMax: 3
        };
    }

    /**
     * 本地预过滤评论，构建发送给 DeepSeek 的评论文本
     * 过滤规则：去重、最小5字符、去除纯表情/无意义内容
     * 只取一级评论（type === '评论'），排除回复
     */
    function buildCommentsText() {
        var rows = STATE.allRows;
        if (!rows.length) return '';

        var seen = {};
        var validComments = [];

        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            // 只取一级评论
            if (r.type !== '评论') continue;
            var text = (r.text || '').trim();
            // 去重
            if (seen[text]) continue;
            seen[text] = true;
            // 最小5字符
            if (text.length < 5) continue;
            // 过滤纯表情/重复字符
            if (/^[\uD800-\uDFFF\s]+$/.test(text)) continue;
            if (/^(.)\1{4,}$/.test(text)) continue;
            // 过滤无意义单字
            if (/^[哈嘿嘻呵嗯哦啊呀哎哟]{1,4}$/.test(text)) continue;

            validComments.push({
                text: text,
                nickname: r.nickname || '用户',
                digg_count: r.digg_count || 0,
                create_time: r.create_time_str || ''
            });
        }

        // 按点赞数降序排列
        validComments.sort(function(a, b) { return b.digg_count - a.digg_count; });

        // 构建文本
        var lines = [];
        for (var j = 0; j < validComments.length; j++) {
            var c = validComments[j];
            lines.push('[点赞:' + c.digg_count + '] ' + c.nickname + '：' + c.text);
        }

        return lines.join('\n');
    }

    async function startCommentInsight() {
        if (STATE.isLoading) {
            alert('评论数据正在加载中，请等待完成后再试');
            return;
        }
        if (!STATE.allRows.length) {
            alert('暂无评论数据，请先加载评论');
            return;
        }

        var aiConfig = getAIConfig();
        if (aiConfig.getLimiterCount() >= aiConfig.aiLimiterMax) {
            alert('当前已有 ' + aiConfig.aiLimiterMax + ' 个 AI 任务正在运行，请等待完成后再试');
            return;
        }

        var btn = document.getElementById('cmt-btn-insight');
        btn.disabled = true;
        btn.classList.add('loading');
        btn.textContent = '分析中...';

        aiConfig.incrementLimiter();

        try {
            var commentsText = buildCommentsText();
            if (!commentsText) {
                alert('有效评论数为0，无法进行分析');
                return;
            }

            var videoTitle = STATE.itemDesc || '未知作品';

            // 通过后端代理调用 DeepSeek（后端验证许可证，API Key 不暴露在前端）
            var apiBase = (window.__AI_CONFIG__ && window.__AI_CONFIG__.API_BASE) || 'http://127.0.0.1:8765';
            var deviceId = '';
            try { deviceId = localStorage.getItem('dcxzs_device_id') || ''; } catch(e) {}
            if (!deviceId) {
                deviceId = 'dev_' + Math.random().toString(36).substr(2, 16) + Date.now().toString(36);
                try { localStorage.setItem('dcxzs_device_id', deviceId); } catch(e) {}
            }

            var resp = await fetch(apiBase + '/api/ai/comment-insight', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: deviceId,
                    comments_text: commentsText,
                    video_title: videoTitle
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

            showInsightResult(result);
        } catch (e) {
            console.error('[评论洞察] 失败:', e);
            alert('评论洞察分析失败: ' + e.message);
        } finally {
            aiConfig.decrementLimiter();
            btn.disabled = false;
            btn.classList.remove('loading');
            btn.textContent = '评论洞察';
        }
    }

    function showInsightResult(result) {
        var existing = document.querySelector('.cmt-insight-overlay');
        if (existing) existing.remove();

        function esc(s) { return escapeHtml(String(s == null ? '' : s)); }

        var overlay = document.createElement('div');
        overlay.className = 'cmt-insight-overlay show';
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

        var html = '<div class="cmt-insight-card">' +
            '<div class="cmt-insight-header">' +
            '<span class="cmt-insight-title">📊 评论深度洞察 - ' + esc(STATE.itemDesc.substring(0, 20)) + '</span>' +
            '<button class="cmt-insight-close">&times;</button></div>' +
            '<div class="cmt-insight-body">';

        // 采样信息
        if (result.sampling_info) {
            var si = result.sampling_info;
            html += '<div class="cmt-insight-sampling">' +
                '📋 <b>采样说明：</b>总评论 ' + esc(si.total_raw) + ' 条，有效 ' + esc(si.total_valid) + ' 条，' +
                '采样 ' + esc(si.sampled) + ' 条，高赞强制保留 ' + esc(si.high_praise_forced) + ' 条 | ' +
                esc(si.strategy || '') + '</div>';
        }

        // 总结
        if (result.summary) {
            html += '<div class="cmt-insight-section"><h3>💡 整体总结</h3>' +
                '<p>' + esc(result.summary) + '</p></div>';
        }

        // 痛点
        if (result.pain_points && result.pain_points.length) {
            html += '<div class="cmt-insight-section"><h3>🎯 核心痛点 (' + result.pain_points.length + ')</h3>';
            for (var i = 0; i < result.pain_points.length; i++) {
                var pp = result.pain_points[i];
                var intensityTag = '';
                if (pp.intensity === '高') intensityTag = ' <span class="cmt-insight-tag high">高</span>';
                else if (pp.intensity === '中') intensityTag = ' <span class="cmt-insight-tag mid">中</span>';
                else intensityTag = ' <span class="cmt-insight-tag low">低</span>';

                html += '<p style="font-weight:600;margin-top:10px;">' + (i + 1) + '. [' + esc(pp.category) + '] ' + esc(pp.description) + intensityTag +
                    (pp.evidence_tier ? ' <span class="cmt-insight-tag">' + esc(pp.evidence_tier) + '</span>' : '') + '</p>';
                if (pp.evidence && pp.evidence.length) {
                    for (var j = 0; j < pp.evidence.length; j++) {
                        html += '<div class="cmt-insight-evidence">"' + esc(pp.evidence[j]) + '"</div>';
                    }
                }
            }
            html += '</div>';
        }

        // 选题
        if (result.topics && result.topics.length) {
            html += '<div class="cmt-insight-section"><h3>🔥 推荐选题 (' + result.topics.length + ')</h3>';
            for (var k = 0; k < result.topics.length; k++) {
                var tp = result.topics[k];
                html += '<div class="cmt-insight-topic-card">' +
                    '<h4>' + esc(tp.title) + '</h4>' +
                    '<p>类型：' + esc(tp.type || '') + ' | 痛点：' + esc(tp.pain_point || '') +
                    (tp.evidence_tier ? ' | 依据：' + esc(tp.evidence_tier) : '') + '</p>' +
                    '</div>';
            }
            html += '</div>';
        }

        html += '</div></div>';
        overlay.innerHTML = html;
        document.body.appendChild(overlay);

        overlay.querySelector('.cmt-insight-close').onclick = function() { overlay.remove(); };
        overlay.querySelector('.cmt-insight-card').onclick = function(e) { e.stopPropagation(); };
    }

    // ============================================================
    //  8. 弹窗显示/隐藏
    // ============================================================

    function showModal(item) {
        ensureDOM();
        const overlay = document.getElementById('dy-comment-modal-overlay');
        if (!overlay) return;

        STATE.modalVisible = true;
        STATE.currentPage = 1;
        STATE.pageSize = CONFIG.DEFAULT_PAGE_SIZE;

        // 设置每页条数下拉
        renderPageSizeSelect();

        // 作品标题
        const desc = (item.desc || '').substring(0, 50) + ((item.desc || '').length > 50 ? '...' : '');
        document.getElementById('cmt-aweme-desc').textContent = '「' + (desc || '无标题') + '」';

        // 重置排序
        STATE.sortField = null;
        STATE.sortOrder = 'asc';

        overlay.classList.add('show');

        // 同步主题按钮
        syncCommentThemeButton();

        // 开始加载
        loadComments(item);
    }

    function hideModal() {
        STATE.modalVisible = false;
        const overlay = document.getElementById('dy-comment-modal-overlay');
        if (overlay) overlay.classList.remove('show');
        document.getElementById('cmt-export-menu').classList.remove('show');
        // 同时关闭 JSON 查看弹层
        hideRawJSON();
    }

    function showRawJSON(rowIndex) {
        const row = STATE.allRows[rowIndex];
        if (!row || !row._raw) return;
        document.getElementById('cmt-json-title').textContent = 'JSON 原数据 — ' + (row.nickname || '用户');
        document.getElementById('cmt-json-content').textContent = JSON.stringify(row._raw, null, 2);
        document.getElementById('cmt-json-modal').classList.add('show');
    }

    function hideRawJSON() {
        const modal = document.getElementById('cmt-json-modal');
        if (modal) modal.classList.remove('show');
    }

    function renderPageSizeSelect() {
        const sel = document.getElementById('cmt-page-size');
        if (!sel) return;
        sel.innerHTML = CONFIG.PAGE_SIZE_OPTIONS.map(n => `<option value="${n}" ${n === STATE.pageSize ? 'selected' : ''}>${n} 条/页</option>`).join('');
    }

    // ============================================================
    //  9. 事件绑定
    // ============================================================

    function bindEvents() {
        ensureDOM();

        // 关闭按钮
        document.getElementById('cmt-btn-close').onclick = hideModal;

        // 主题切换按钮
        document.getElementById('cmt-btn-theme').onclick = toggleCommentTheme;
        syncCommentThemeButton();

        // 点击遮罩关闭
        document.getElementById('dy-comment-modal-overlay').onclick = (e) => {
            if (e.target === e.currentTarget) hideModal();
        };

        // 重新解析
        document.getElementById('cmt-btn-reload').onclick = () => {
            if (STATE.isLoading) return;
            if (STATE.itemId) {
                // 清除内存和 localStorage 缓存后重新加载
                delete STATE.cache[STATE.itemId];
                try { localStorage.removeItem(getCacheKey(STATE.itemId)); } catch(e) {}
                STATE.allRows = [];
                showTable(false);
                showEmpty(false);
                showFooter(false);
                loadComments({ aweme_id: STATE.itemId, desc: STATE.itemDesc, statistics: { comment_count: STATE.itemCommentTotal } });
            }
        };

        // 评论洞察按钮
        var insightButton = document.getElementById('cmt-btn-insight');
        if (insightButton) insightButton.onclick = startCommentInsight;

        // 导出按钮 + 菜单
        const exportBtn = document.getElementById('cmt-btn-export');
        const exportMenu = document.getElementById('cmt-export-menu');
        exportBtn.onclick = (e) => {
            e.stopPropagation();
            exportMenu.classList.toggle('show');
        };
        exportMenu.querySelectorAll('.cmt-export-menu-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                exportData(item.dataset.format);
            };
        });
        // 点击其他地方关闭导出菜单
        document.addEventListener('click', () => {
            exportMenu.classList.remove('show');
        });

        // 取消拉取
        document.getElementById('cmt-progress-cancel').onclick = () => {
            STATE.loadingCancelled = true;
        };

        // 时间排序
        document.getElementById('cmt-sort-time').onclick = () => {
            if (STATE.isLoading || STATE.allRows.length === 0) return;
            if (STATE.sortField === 'create_time') {
                STATE.sortOrder = STATE.sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                STATE.sortField = 'create_time';
                STATE.sortOrder = 'asc';
            }
            STATE.currentPage = 1;
            renderTableBody();
            renderPagination();
            updateSortIndicator();
        };

        // 点赞排序
        document.getElementById('cmt-sort-digg').onclick = () => {
            if (STATE.isLoading || STATE.allRows.length === 0) return;
            if (STATE.sortField === 'digg_count') {
                STATE.sortOrder = STATE.sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                STATE.sortField = 'digg_count';
                STATE.sortOrder = 'desc'; // 默认降序（点赞最多排最前）
            }
            STATE.currentPage = 1;
            renderTableBody();
            renderPagination();
            updateSortIndicator();
        };

        // 所属评论列折叠
        document.getElementById('cmt-parent-toggle').onclick = (e) => {
            e.stopPropagation();
            STATE.parentColumnVisible = !STATE.parentColumnVisible;
            const toggle = document.getElementById('cmt-parent-toggle');
            toggle.textContent = STATE.parentColumnVisible ? '◀' : '▶';

            // 更新表头
            const colTh = document.getElementById('cmt-col-parent');
            colTh.style.display = STATE.parentColumnVisible ? '' : 'none';

            // 更新数据列
            const rows = document.querySelectorAll('#cmt-table-body td[data-col="parent"]');
            rows.forEach(td => { td.style.display = STATE.parentColumnVisible ? '' : 'none'; });
        };

        // JSON原数据 按钮事件委托
        document.getElementById('cmt-table-body').addEventListener('click', (e) => {
            const btn = e.target.closest('.cmt-json-btn');
            if (!btn) return;
            e.stopPropagation();
            const rowIdx = parseInt(btn.dataset.rowIdx, 10);
            if (!isNaN(rowIdx)) showRawJSON(rowIdx);
        });

        // JSON查看弹层关闭
        document.getElementById('cmt-json-btn-close').onclick = hideRawJSON;
        document.getElementById('cmt-json-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) hideRawJSON();
        });

        // JSON复制按钮
        document.getElementById('cmt-json-btn-copy').onclick = () => {
            const text = document.getElementById('cmt-json-content').textContent;
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('cmt-json-btn-copy');
                btn.textContent = '已复制';
                btn.style.background = '#4ade80';
                btn.style.color = '#fff';
                btn.style.borderColor = '#4ade80';
                setTimeout(() => {
                    btn.textContent = '复制';
                    btn.style.background = '';
                    btn.style.color = '';
                    btn.style.borderColor = '';
                }, 1500);
            }).catch(() => {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            });
        };

        // 每页条数切换
        document.getElementById('cmt-page-size').onchange = (e) => {
            STATE.pageSize = Number(e.target.value);
            STATE.currentPage = 1;
            renderTableBody();
            renderPagination();
        };

        // 上一页
        document.getElementById('cmt-prev-page').onclick = () => {
            if (STATE.currentPage > 1) {
                STATE.currentPage--;
                renderTableBody();
                renderPagination();
            }
        };

        // 下一页
        document.getElementById('cmt-next-page').onclick = () => {
            if (STATE.currentPage < getTotalPages()) {
                STATE.currentPage++;
                renderTableBody();
                renderPagination();
            }
        };

        // 跳页
        document.getElementById('cmt-page-jump').onkeydown = (e) => {
            if (e.key === 'Enter') {
                const page = Number(e.target.value);
                const totalPages = getTotalPages();
                if (page >= 1 && page <= totalPages) {
                    STATE.currentPage = page;
                    renderTableBody();
                    renderPagination();
                }
                e.target.value = '';
            }
        };

        // ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && STATE.modalVisible) hideModal();
        });
    }

    // ============================================================
    //  10. 初始化
    // ============================================================

    function init() {
        try {
            bindEvents();
            console.log('[评论模块] 初始化完成，弹窗 DOM 已就绪');
        } catch (err) {
            console.error('[评论模块] 初始化失败:', err);
        }
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ============================================================
    //  11. 公开 API
    // ============================================================
    window.DyComment = {
        open(item) {
            // 上报使用统计
            try {
                if (typeof window.__reportUsage__ === 'function') {
                    window.__reportUsage__('view_comments', (item && item.aweme_id) ? String(item.aweme_id) : '');
                }
            } catch(e) {}
            // 关闭已有的（如果有的话），重新打开
            if (STATE.modalVisible) {
                hideModal();
                // 短暂延迟确保 DOM 更新
                setTimeout(() => showModal(item), 50);
            } else {
                showModal(item);
            }
        },
        close: hideModal,
        /** 清除所有缓存 */
        clearCache() {
            // 清除所有 hankin_dy_comment_cache_ 前缀的 localStorage
            try {
                var keysToRemove = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.startsWith('hankin_dy_comment_cache_')) keysToRemove.push(k);
                }
                keysToRemove.forEach(function(k) { localStorage.removeItem(k); });
            } catch(e) {}
            STATE.cache = {};
        },
        /** 设置最大拉取条数 */
        setMaxRows(n) {
            CONFIG.MAX_ROWS = Number(n);
        },
        /** 获取当前配置 */
        get config() { return { ...CONFIG }; }
    };

    console.log('[评论模块] dy_comment_module.js 已加载，使用 window.DyComment.open(item) 打开评论弹窗');

    } catch (initErr) {
        console.error('[评论模块] 模块初始化异常，window.DyComment 将不可用:', initErr);
        // 异常详情输出到控制台帮助排查
        console.error('[评论模块] 错误类型:', initErr.name);
        console.error('[评论模块] 错误消息:', initErr.message);
        console.error('[评论模块] 错误堆栈:', initErr.stack);
    }

})();
