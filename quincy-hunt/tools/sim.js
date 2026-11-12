// Balance simulator: a kiting bot plays full hunts at max speed and prints loop metrics.
// Usage: node sim.js [runs] [maxSeconds] [skill 0..1]   (needs playwright)
const {chromium}=require('playwright');
const RUNS=+process.argv[2]||4,MAXT=+process.argv[3]||600,SKILL=+process.argv[4]||0.6;
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1400,height:800}});
p.on('pageerror',e=>console.log('PE',e.message));
await p.goto('file://'+require('path').resolve(__dirname,'../index.html'));await p.waitForTimeout(400);
const out=await p.evaluate(async({RUNS,MAXT,SKILL})=>{
 const res=[];
 for(let run=0;run<RUNS;run++){
  try{localStorage.clear()}catch(e){}
  meta.base={};meta.tree={};meta.eq={};meta.bag=[];meta.skills=['heizen','wolke','gritz'];meta.stufe=1;
  startGame();const M={lv:[],hits:0,dmgBy:{},volT:0,chgT:0,starve:0,perf:0,full:0,lull:0,kAt:[]};
  let hold=0,rel=0,volley=0,lastHp=G.hp,nextMin=60,strafe=1,st=0;
  const _hurt=hurt;
  for(let step=0;step<MAXT*60;step++){
   if(G.state==='levelup'){const c=document.querySelectorAll('#cards button');c[Math.random()*c.length|0].click();M.lv.push(G.t|0);continue}
   if(G.state==='win'){document.getElementById('winGo').click();M.win=G.t|0;continue}
   if(G.state!=='play')break;
   // threat field
   let fx=0,fy=0,near=null,nd=1e9,cnt=0;
   for(const e of G.enemies){if(e.hidden&&e.type!=='worm')continue;const dx=G.px-e.x,dy=G.py-e.y,d=Math.hypot(dx,dy)||1;if(d<420){const w=(e.r+60)/(d*d)*(e.type==='rift'?0:1);fx+=dx/d*w*400;fy+=dy/d*w*400;cnt++}
     if(!e.hidden&&(e.boss?d*.5:d)<nd&&e.type!=='rift'){nd=e.boss?d*.5:d;near=e}
     if((e.type==='gil'||e.boss)&&(e.state===1||e.state===2||e.state===3)){const ca=e.ca,px=G.px-e.x,py=G.py-e.y,perp=-Math.sin(ca)*px+Math.cos(ca)*py,al=Math.cos(ca)*px+Math.sin(ca)*py;if(al>0&&Math.abs(perp)<110){const s=perp>=0?1:-1;fx+=-Math.sin(ca)*s*3;fy+=Math.cos(ca)*s*3}}
     if(e.type==='brute'&&e.state>=1){const ca=e.ca,px=G.px-e.x,py=G.py-e.y,perp=-Math.sin(ca)*px+Math.cos(ca)*py;if(Math.abs(perp)<70){const s=perp>=0?1:-1;fx+=-Math.sin(ca)*s*2;fy+=Math.cos(ca)*s*2}}}
   for(const e of G.enemies){if((e.type==='arr'&&e.state===5)||(e.type==='vasto'&&e.state===4)){const dx=G.px-e.tx,dy=G.py-e.ty,d=Math.hypot(dx,dy)||1;if(d<150){fx+=dx/d*4*SKILL;fy+=dy/d*4*SKILL}}
     if(e.type==='esp'&&e.state===7){const ca=e.ca,px=G.px-e.x,py=G.py-e.y,perp=-Math.sin(ca)*px+Math.cos(ca)*py;if(Math.abs(perp)<90){const s2=perp>=0?1:-1;fx+=-Math.sin(ca)*s2*4*SKILL;fy+=Math.cos(ca)*s2*4*SKILL}}}
   for(const bl of G.ebul){const dx=G.px-bl.x,dy=G.py-bl.y,d=Math.hypot(dx,dy)||1;if(d<160){fx+=dx/d*120/d;fy+=dy/d*120/d}}
   if(!near){for(const e of G.enemies)if(e.type==='rift'){near=e;nd=Math.hypot(e.x-G.px,e.y-G.py)}}
   // strafe around target, drift to orbs
   if(near){const dx=near.x-G.px,dy=near.y-G.py,d=Math.hypot(dx,dy)||1;if(++st>180){st=0;if(Math.random()<.4)strafe=-strafe}fx+=-dy/d*.35*strafe;fy+=dx/d*.35*strafe;if(d>330){fx+=dx/d*.5;fy+=dy/d*.5}}
   let ox=0,oy=0,on=0;for(const o of G.orbs){ox+=o.x;oy+=o.y;on++}if(on&&cnt<3){fx+=(ox/on-G.px)/300;fy+=(oy/on-G.py)/300}
   const fl=Math.hypot(fx,fy);keys.w=keys.a=keys.s=keys.d=false;if(fl>.05){if(fx/fl>.38)keys.d=true;if(fx/fl<-.38)keys.a=true;if(fy/fl>.38)keys.s=true;if(fy/fl<-.38)keys.w=true}
   if(nd<70*(.5+SKILL)&&G.dashes>0&&G.dashT<=0&&Math.random()<SKILL)tryDash();
   // aim + attack
   if(near){mouse.x=(near.x-G.camX)*zoom+W/2+(Math.random()-.5)*40*(1-SKILL);mouse.y=(near.y-G.camY)*zoom+H/2+(Math.random()-.5)*40*(1-SKILL)}
   if(volley>0){volley--;mouse.r=G.reishi>2;mouse.l=false;M.volT++}
   else{mouse.r=false;
     if(cnt>=4&&G.reishi>55&&G.charge===0&&Math.random()<.03){volley=70+Math.random()*60|0}
     else if(rel>0){rel--;mouse.l=false}
     else{mouse.l=!!near;M.chgT++;if(G.charge>=1){if(hold--<=0){mouse.l=false;rel=2;M.full++;if(G.t-G.fullAt<S.perfW)M.perf++;hold=Math.random()<SKILL?(Math.random()*8|0):(8+Math.random()*30|0)}}else if(hold<=0)hold=Math.random()<SKILL?(Math.random()*8|0):(8+Math.random()*30|0)}}
   if(G.reishi<5)M.starve++;
   if(cnt>=5){for(let i=0;i<3;i++)if(G.cd[i]<=0&&Math.random()<.02)cast(i)}
   if(G.ult>=100&&cnt>=6)tryUlt();
   if(G.enemies.length<4)M.lull++;
   update(1/60);
   if(G.hp<lastHp-.5){M.hits++}lastHp=G.hp;
   if(G.t>=nextMin){M.kAt.push({m:nextMin/60,k:G.kills,lvl:G.lvl,hp:G.hp|0,e:G.enemies.length,zone:G.zone});nextMin+=60}
  }
  res.push({t:G.t|0,state:G.state,kills:G.kills,lvl:G.lvl,zone:G.zone,bossN:G.bossN,hits:M.hits,perfRate:+(M.perf/Math.max(1,M.full)).toFixed(2),fulls:M.full,volPct:+(M.volT/(M.volT+M.chgT)).toFixed(2),starvePct:+(M.starve/(G.t*60)).toFixed(2),lullPct:+(M.lull/(G.t*60)).toFixed(2),
    lvTimes:M.lv.slice(0,14).join(','),perMin:M.kAt.map(a=>`${a.m}m:k${a.k}/L${a.lvl}/hp${a.hp}/e${a.e}`).join(' '),silver:Math.floor((G.silver+G.t/3)),win:M.win,bossT:G.bossT|0,bossAlive:!!G.boss,up:Object.keys(G.up).length});
 }
 return res},{RUNS,MAXT,SKILL});
for(const r of out)console.log(JSON.stringify(r));
const avg=k=>(out.reduce((a,r)=>a+r[k],0)/out.length).toFixed(1);console.log('AVG t',avg('t'),'kills',avg('kills'),'lvl',avg('lvl'),'hits',avg('hits'),'silver',avg('silver'));
await b.close()})();
