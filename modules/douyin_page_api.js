(function() {
    'use strict';
    if (window.__DcxzsPageApi__?.version === '1.10.3') return;
    const paths = {
        identity: '/aweme/v1/web/user/profile/self/', profile: '/aweme/v1/web/user/profile/other/',
        works: '/aweme/v1/web/aweme/post/', following: '/aweme/v1/web/user/following/list/',
        detail:'/aweme/v1/web/aweme/detail/'
    };
    function realId(value) { return typeof value === 'string' && value !== 'self' && /^[\w.-]+$/.test(value) ? value : ''; }
    function ownProfileLink() {
        const links = Array.from(document.querySelectorAll('a[href*="/user/"]'));
        return links.find(a => /^(我的|我的主页|个人中心)$/.test((a.textContent || '').trim()) ||
            /^(我的|我的主页|个人中心)$/.test(a.getAttribute('aria-label') || a.getAttribute('title') || ''));
    }
    async function request(kind, args = {}) {
        if (!paths[kind]) throw new Error('不支持的数据请求');
        const url = new URL(paths[kind], location.origin);
        const entries = performance.getEntriesByType('resource');
        // Reuse the site's non-secret client parameters, never stale request signatures.
        const template = entries.slice().reverse().find(entry => entry.name.includes(paths[kind]));
        const allowed = new Set(['aid','device_platform','channel','version_code','version_name','pc_client_type','cookie_enabled',
            'screen_width','screen_height','browser_language','browser_platform','browser_name','browser_version','browser_online',
            'engine_name','engine_version','os_name','os_version','webid']);
        if (template) {
            new URL(template.name).searchParams.forEach((value,key) => { if (allowed.has(key)) url.searchParams.set(key,value); });
        }
        const defaults = { device_platform:'webapp',aid:'6383',channel:'channel_pc_web',cookie_enabled:'true',
            browser_language:navigator.language,browser_platform:navigator.platform, browser_online:'true',
            screen_width:screen.width,screen_height:screen.height };
        Object.entries(defaults).forEach(([key,value]) => { if (!url.searchParams.has(key)) url.searchParams.set(key,String(value)); });
        Object.entries(args).forEach(([key,value]) => { if (value !== null && value !== undefined) url.searchParams.set(key,String(value)); });
        const response = await fetch(url.href, { credentials:'include',signal:AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('抖音请求失败 HTTP '+response.status);
        const body = await response.text();
        if (!body.trim()) throw new Error('抖音返回空响应，请刷新已登录的抖音页后重试');
        let data;
        try { data = JSON.parse(body); } catch { throw new Error('抖音返回非 JSON 内容，请在抖音页面完成登录或验证后重试'); }
        if (Number(data.status_code) !== 0 || data.status_code === undefined) throw new Error(data.status_msg || '抖音未返回有效数据，请检查登录状态');
        return data;
    }
    async function identity() {
        let lastError;
        try {
            const data = await request('identity');
            if (realId(data.user?.sec_uid)) return data.user;
            throw new Error('登录账号接口没有返回真实账号 ID');
        } catch(error) { lastError = error; }
        const link = ownProfileLink();
        const id = link && realId((new URL(link.href).pathname.match(/^\/user\/([^/?#]+)/) || [])[1]);
        if (id) {
            const data = await request('profile',{sec_user_id:id});
            if (data.user?.sec_uid === id) return data.user;
        }
        throw new Error('无法确认自己的账号：'+lastError.message);
    }
    window.__DcxzsPageApi__ = { version:'1.10.3',request,identity,realId };
})();
