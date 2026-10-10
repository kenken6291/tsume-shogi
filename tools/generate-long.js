// generate-long.js — 長手数の詰将棋を作るツール（短い詰みの局面を少しずつ変えて長い詰みを探す）
// 使い方: node tools/generate-long.js <手数> <問題数> <秒数> <元にする問題ファイル...>
// 例    : node tools/generate-long.js 11 50 3600 詰将棋_検証済み_5手7手9手.txt
// 結果は mut_<手数>.txt に追記されます
const S=require(require('path').join(__dirname,'..','shogi.js'));const fs=require('fs');
const [target,want,seconds,seedFiles]=[+process.argv[2],+process.argv[3],+process.argv[4],process.argv.slice(5)];
const TOT={R:2,B:2,G:4,S:4,N:4,L:4,P:18};
const rnd=n=>Math.floor(Math.random()*n);
function legalize(pos){ // gote hand=rest, validity
 const B=pos.board,cnt={R:0,B:0,G:0,S:0,N:0,L:0,P:0},pf=[[],[]];let k=0;
 for(let r=0;r<9;r++)for(let c=0;c<9;c++){const p=B[r][c];if(!p)continue;const b=S.baseOf(p),sd=S.sideOf(p);
  if(b==='K'){if(sd===0)return null;k++;continue;}cnt[b]++;
  if(!S.isPromoted(p)){const rr=sd===0?r:8-r;if(((b==='P'||b==='L')&&rr===0)||(b==='N'&&rr<=1))return null;if(b==='P'){if(pf[sd][c])return null;pf[sd][c]=1;}}}
 if(k!==1)return null;
 for(const t in cnt)cnt[t]+=pos.hands[0][t];
 const g={};for(const t in TOT){if(cnt[t]>TOT[t])return null;g[t]=TOT[t]-cnt[t];}
 pos.hands[1]=g; pos.turn=0;
 if(S.inCheck(pos,1))return null; return pos;}
function clone(p){return{board:p.board.map(r=>r.slice()),hands:[{...p.hands[0]},{...p.hands[1]}],turn:0};}
const PIECES=['P','L','N','S','G','B','R'];
function mutate(p0){const p=clone(p0),B=p.board;const kp=S.findKing(p,1);
 const near=()=>[Math.max(0,Math.min(8,kp[0]+rnd(5)-2)),Math.max(0,Math.min(8,kp[1]+rnd(5)-2))];
 const occ=[];for(let r=0;r<9;r++)for(let c=0;c<9;c++)if(B[r][c]&&S.baseOf(B[r][c])!=='K')occ.push([r,c]);
 const op=rnd(8);
 if(op===0&&occ.length){const [r,c]=occ[rnd(occ.length)];const [tr,tc]=near();if(B[tr][tc])return null;B[tr][tc]=B[r][c];B[r][c]=null;}
 else if(op===1&&occ.length>1){const [r,c]=occ[rnd(occ.length)];B[r][c]=null;}
 else if(op===2){const [tr,tc]=near();if(B[tr][tc])return null;const t=PIECES[rnd(7)];if(!p.hands[1][t])return null;let pc=rnd(2)?t:t.toLowerCase();if(rnd(5)===0&&t!=='G')pc='+'+pc;B[tr][tc]=pc;}
 else if(op===3){const t=PIECES[rnd(7)];if(rnd(2)){if(!p.hands[1][t])return null;p.hands[0][t]++;}else{if(!p.hands[0][t])return null;p.hands[0][t]--;}}
 else if(op===4&&occ.length){const [r,c]=occ[rnd(occ.length)];const q=B[r][c];const b=S.baseOf(q);if(b==='G')return null;B[r][c]=S.isPromoted(q)?q.slice(1):'+'+q;}
 else if(op===5){const dr=rnd(3)-1,dc=rnd(3)-1;const r=kp[0]+dr,c=kp[1]+dc;if(r<0||r>8||c<0||c>8||B[r][c])return null;B[r][c]='k';B[kp[0]][kp[1]]=null;}
 else if(op===6&&occ.length){const [r,c]=occ[rnd(occ.length)];const q=B[r][c];B[r][c]=S.sideOf(q)?q.toUpperCase():q.toLowerCase();}
 else {const [tr,tc]=near();if(B[tr][tc])return null;const t=PIECES[rnd(7)];if(!p.hands[0][t])return null;p.hands[0][t]--;B[tr][tc]=rnd(3)?t:t.toLowerCase();}
 return legalize(p);}
function evalLen(pos,maxN){try{return S.mateLength(pos,maxN,S.makeCtx(maxN>=9?80000:maxN>=7?80000:40000));}catch(e){if(e===S.BUDGET)return -2;throw e;}}
// seeds
let pool=[];
for(const f of seedFiles)for(const l of fs.readFileSync(f,'utf8').split('\n'))if(l.startsWith('sfen')){const p=S.parseSFEN(l.slice(5).split(' moves ')[0]);pool.push({p,len:l.split(' moves ')[1].trim().split(' ').length});}
const out=[],seen=new Set();const t0=Date.now();let it=0;
const existing=new Set();if(fs.existsSync(`mut_${target}.txt`))for(const l of fs.readFileSync(`mut_${target}.txt`,'utf8').split('\n'))if(l)existing.add(l.slice(5).split(' moves ')[0].split(' ').slice(0,3).join(' '));
while(out.length<want&&Date.now()-t0<seconds*1000){it++;
 // prefer longest seeds
 pool.sort((a,b)=>b.len-a.len); const top=pool.slice(0,Math.min(pool.length,60));
 const base=top[rnd(top.length)];let p=base.p;
 for(let k=0,n=1+rnd(2);k<n&&p;k++)p=mutate(p);
 if(!p)continue;
 const key=S.toSFEN(p).split(' ').slice(0,3).join(' ');if(seen.has(key))continue;seen.add(key);
 const L=evalLen(p,target);
 if(L<0)continue;
 if(L>=target-2&&L<target&&pool.length<400)pool.push({p,len:L});
 if(L!==target)continue;
 if(existing.has(key))continue;
 try{const ctx2=S.makeCtx(600000);
  const firsts=S.legalPairs(p,{checksOnly:true}).filter(x=>S.andNode(x.np,target-1,ctx2));
  if(firsts.length!==1){pool.push({p,len:L});continue;}
  const sol=S.solve(p,target,800000,ctx2);if(!sol||sol.length!==target)continue;
  let q=p;for(const u of sol)q=S.makeMove(q,S.findMoveByUSI(q,u));if(!S.isMated(q))continue;
  out.push(`sfen ${S.toSFEN(p)} moves ${sol.join(' ')}`);existing.add(key);
  if(pool.length<400)pool.push({p,len:L});
 }catch(e){if(e!==S.BUDGET)throw e;}}
fs.appendFileSync(`mut_${target}.txt`,out.map(x=>x+'\n').join(''));
console.log(target,'found',out.length,'iters',it,'pool',pool.length,((Date.now()-t0)/1000|0)+'s');
