(function(root) {
    'use strict';
    const keys = ['digg_count','comment_count','collect_count','share_count'];
    function count(value) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }
    function parseCount(value) {
        const text = String(value ?? '').trim().replace(/,/g,'');
        const match = text.match(/^(?:播放量|播放次数|观看次数|浏览量)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*([万亿wW]?)\s*(?:次)?$/);
        if (!match) return null;
        const multiplier = match[2] === '亿' ? 1e8 : /万|w/i.test(match[2]) ? 1e4 : 1;
        return count(Math.round(Number(match[1])*multiplier));
    }
    function readCard(link) {
        let card = link.closest('[data-e2e*="post"], li, article') || link;
        const ids = new Set(Array.from(card.querySelectorAll('a[href]')).map(a=>(a.href||'').match(/\/(?:video|note)\/(\d+)/)?.[1]).filter(Boolean));
        if (ids.size > 1) card = link;
        const nodes = card.querySelectorAll('[data-play-count], [data-view-count], [data-e2e*="play-count"], [data-e2e*="view-count"], [class*="play-count"], [class*="view-count"], [class*="playCount"], [class*="viewCount"], [aria-label], [title]');
        for (const node of nodes) {
            const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
            const marker = [node.getAttribute('data-e2e'),node.getAttribute('class')].filter(Boolean).join(' ');
            const explicit = /(?:play|view)[-_]?count/i.test(marker) || node.hasAttribute('data-play-count') || node.hasAttribute('data-view-count');
            if (!explicit && !/播放量|播放次数|观看次数|浏览量/.test(label)) continue;
            const texts = [node.getAttribute('data-play-count'),node.getAttribute('data-view-count'),label,node.textContent];
            for (const text of texts) {
                const value = parseCount(text);
                if (value !== null) return value;
            }
        }
        // Only accept a text leaf explicitly labelled as views; arbitrary numbers may be likes or title text.
        for (const node of card.querySelectorAll('span, div')) {
            if (node.children.length || !/^(播放量|播放次数|观看次数|浏览量)\s*[:：]?\s*\d/.test((node.textContent||'').trim())) continue;
            const value = parseCount(node.textContent);
            if (value !== null) return value;
        }
        return null;
    }
    function update(item, domValue, now = Date.now()) {
        const stats = item.statistics || {};
        const previous = item.selfAnalytics;
        const apiValue = count(stats.play_count);
        const pageValue = count(domValue);
        const useApi = apiValue !== null && apiValue > 0;
        const value = useApi ? apiValue : pageValue !== null ? pageValue : count(previous?.playCount);
        const metrics = keys.map(key=>count(stats[key]));
        const interactions = metrics.every(n=>n !== null) ? metrics.reduce((a,b)=>a+b,0) : null;
        const ratio = n => value > 0 && n !== null ? n/value : null;
        return {
            playCount:value,
            playCountSource:useApi?'api':pageValue !== null?'page':value !== null?(previous?.playCountSource||'cached'):'missing',
            interactions,likeRate:ratio(metrics[0]),commentRate:ratio(metrics[1]),collectRate:ratio(metrics[2]),shareRate:ratio(metrics[3]),
            engagementRate:ratio(interactions),
            collectedAt:useApi || pageValue !== null ? now : (previous?.collectedAt || null)
        };
    }
    function summary(items) {
        let totalPlays=0,playCoverage=0,ratePlays=0,rateInteractions=0,rateCoverage=0;
        for (const item of items) {
            const plays=count(item.selfAnalytics?.playCount);
            if (plays === null) continue;
            totalPlays+=plays;playCoverage++;
            const metrics=keys.map(key=>count(item.statistics?.[key]));
            if (plays > 0 && metrics.every(n=>n !== null)) {
                ratePlays+=plays;rateInteractions+=metrics.reduce((a,b)=>a+b,0);rateCoverage++;
            }
        }
        return {totalPlays:playCoverage?totalPlays:null,playCoverage,averagePlays:playCoverage?Math.round(totalPlays/playCoverage):null,
            overallEngagement:ratePlays>0?rateInteractions/ratePlays:null,rateCoverage};
    }
    const api={parseCount,readCard,update,summary};
    if (typeof module !== 'undefined' && module.exports) module.exports=api;
    else root.DcxzsSelfAnalytics=api;
})(globalThis);
