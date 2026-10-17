const {test}=require('node:test');
const assert=require('node:assert/strict');
const A=require('../modules/self_analytics.js');
const stats={play_count:0,digg_count:10,comment_count:2,collect_count:3,share_count:5};
test('滚动卸载卡片后保留播放数、来源和采集时间',()=>{
    const item={statistics:{...stats}};
    item.selfAnalytics=A.update(item,1000,1);
    item.statistics.digg_count=20;
    const updated=A.update(item,null,2);
    assert.equal(updated.playCount,1000);assert.equal(updated.playCountSource,'page');assert.equal(updated.collectedAt,1);
    assert.equal(updated.engagementRate,.03);
});
test('空字段和 API 占位零不当作真实零；明确页面零保留',()=>{
    for(const play_count of [null,undefined,'',false,0,-1])assert.equal(A.update({statistics:{...stats,play_count}},null).playCount,null);
    assert.equal(A.update({statistics:stats},0).playCount,0);
    assert.equal(A.update({statistics:stats},0).engagementRate,null);
});
test('综合互动率分子分母只使用同一批有效作品',()=>{
    const rows=[{statistics:stats,selfAnalytics:{playCount:1000}},
        {statistics:{...stats,digg_count:10000},selfAnalytics:{playCount:null}},
        {statistics:{digg_count:50},selfAnalytics:{playCount:2000}}];
    const result=A.summary(rows);
    assert.equal(result.totalPlays,3000);assert.equal(result.playCoverage,2);
    assert.equal(result.rateCoverage,1);assert.equal(result.overallEngagement,.02);
    assert.equal(A.summary([{statistics:stats}]).totalPlays,null);
});
test('单位与字段标签正确解析，标题和点赞不能伪装播放量',()=>{
    assert.equal(A.parseCount('播放量：1.2万次'),12000);
    assert.equal(A.parseCount('浏览量 3.6亿'),360000000);
    assert.equal(A.parseCount('1,234'),1234);
    assert.equal(A.parseCount('点赞 88'),null);
    assert.equal(A.parseCount('3步做出自己的AI'),null);
});
function node(text,attrs={}){return{textContent:text,children:[],getAttribute:key=>attrs[key]??null,hasAttribute:key=>key in attrs};}
function link(marked=[],leaves=[]){const card={querySelectorAll:selector=>selector==='a[href]'?[]:selector==='span, div'?leaves:marked};return{closest:()=>card};}
test('卡片只有点赞/标题数字时不取任何数字；播放按钮不等于播放量',()=>{
    assert.equal(A.readCard(link([node('88',{'aria-label':'播放视频'})],[node('88'),node('2026')])),null);
    assert.equal(A.readCard(link([node('1.2万',{'data-e2e':'video-play-count'})],[node('88')])),12000);
    assert.equal(A.readCard(link([node('',{'aria-label':'播放量：0'})])),0);
    assert.equal(A.readCard(link([],[node('观看次数 250')])),250);
});
