(function(root) {
    'use strict';
    function emptyState() {
        return { schema: 1, owner: null, authors: [], records: {}, run: null, followingSync: null };
    }
    function mediaUrls(item) {
        const video=item.video || {};
        const urls=[...(video.play_addr?.url_list||[]),...(video.play_addr_h264?.url_list||[]),
            ...(video.bit_rate||[]).flatMap(rate=>rate.play_addr?.url_list||[]),...(video.download_addr?.url_list||[])];
        return Array.from(new Set(urls.filter(url=>typeof url==='string' && /^https?:\/\//.test(url))));
    }
    function cursorTime(cursor) {
        const n=Number(cursor);
        if (!Number.isFinite(n)) return null;
        if (n>=1e12 && n<1e14) return Math.floor(n/1000)*1000;
        if (n>=1e9 && n<1e11) return Math.floor(n)*1000;
        return null;
    }
    function pageBoundary(list,cursor,previousCursor,previousOldest) {
        const ordinary=list.filter(item=>![true,1,'1'].includes(item.is_top) && ![true,1,'1'].includes(item.is_pinned));
        const times=ordinary.map(item=>Number(item.create_time)*1000);
        const boundary=cursorTime(cursor);
        const previousBoundary=cursorTime(previousCursor);
        const ordered=times.length>0 && times.every((time,index)=>Number.isFinite(time) && time>0 && (!index || times[index-1]>=time)) &&
            (previousOldest===null || times[0]<=previousOldest);
        const safe=ordered && boundary!==null && boundary<=times[times.length-1] &&
            (previousBoundary===null || boundary<previousBoundary);
        return { safe,boundary,oldest:ordered?times[times.length-1]:previousOldest };
    }
    function canFinishRecent(items,author,boundary) {
        if (!Number.isFinite(boundary)) return false;
        if (author.lastChecked) return boundary<author.lastChecked;
        const times=Array.from(items.values()).map(item=>Number(item.create_time)*1000).filter(time=>Number.isFinite(time)&&time>0).sort((a,b)=>b-a);
        return times.length>=3 && boundary<times[2];
    }
    function normalizeWork(item, author, now) {
        if (!item.aweme_id || !Number.isFinite(Number(item.create_time))) throw new Error('作品缺少 ID 或发布时间');
        const s = item.statistics || {};
        const count = key => Number.isFinite(Number(s[key])) && s[key] !== null ? Number(s[key]) : null;
        return {
            id: String(item.aweme_id), authorId: author.secUid, authorName: author.nickname,
            title: String(item.desc || ''), type: item.images?.length ? 'image' : 'video',
            publishedAt: Number(item.create_time) * 1000,
            url: 'https://www.douyin.com/' + (item.images?.length ? 'note/' : 'video/') + item.aweme_id,
            cover: item.video?.cover?.url_list?.[0] || item.images?.[0]?.url_list?.[0] || '',
            likes: count('digg_count'), comments: count('comment_count'),
            collects: count('collect_count'), shares: count('share_count'),
            urls: mediaUrls(item),
            collectedAt: now, transcript: '', status: item.images?.length ? 'image' : 'pending', error: ''
        };
    }
    function mergeWorks(state, author, items, checkedAt) {
        const unique = new Map();
        items.forEach(item => { if (item.aweme_id) unique.set(String(item.aweme_id), item); });
        const sorted = Array.from(unique.values()).sort((a,b) => Number(b.create_time) - Number(a.create_time));
        // Sort by publication time so pinned old works cannot displace the latest three.
        const candidates = author.lastChecked ? sorted.filter(item => Number(item.create_time) * 1000 >= author.lastChecked) : sorted.slice(0,3);
        const seen = new Set(author.seen || []);
        let added = 0;
        sorted.forEach(item => {
            const id = String(item.aweme_id);
            if (state.records[id]) {
                const fresh = normalizeWork(item, author, checkedAt);
                state.records[id] = { ...state.records[id], ...fresh,
                    transcript: state.records[id].transcript, status: state.records[id].status,
                    error: state.records[id].error, firstCollectedAt: state.records[id].firstCollectedAt };
            }
        });
        candidates.forEach(item => {
            const id = String(item.aweme_id);
            if (seen.has(id) || state.records[id]) return;
            state.records[id] = { ...normalizeWork(item, author, checkedAt), firstCollectedAt: checkedAt };
            seen.add(id);
            added++;
        });
        author.seen = Array.from(seen);
        author.lastChecked = checkedAt;
        author.error = '';
        return added;
    }
    function escapeCsv(value) {
        let s = String(value ?? '');
        if (/^\s*[=+@-]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    }
    function exportRows(records) {
        return records.map(r => ({ author: r.authorName, aweme_id: r.id, title: r.title,
            type: r.type === 'image' ? '图文' : '视频', published_at: new Date(r.publishedAt).toISOString(),
            url: r.url, likes: r.likes, comments: r.comments, collects: r.collects, shares: r.shares,
            collected_at: new Date(r.collectedAt).toISOString(), status: r.status, transcript: r.transcript, error: r.error || '' }));
    }
    const api = { emptyState, mediaUrls, cursorTime, pageBoundary, canFinishRecent, normalizeWork, mergeWorks, escapeCsv, exportRows };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MonitorCore = api;
})(globalThis);
