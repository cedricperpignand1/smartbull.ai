// lib/l2Pressure.ts
export type L2Level = { px: number; sz: number };
export type L2Book = { bids: L2Level[]; asks: L2Level[]; history?: Array<{ bidPx:number; askPx:number; bidSz:number; askSz:number; t:number }>; };

const clamp01 = (x:number)=>Math.max(0,Math.min(1,x));

function proxWeighted(levels:L2Level[], best:number, side:'bid'|'ask', depth=10){
  let s=0; for (let i=0;i<Math.min(depth,levels.length);i++){
    const {px,sz}=levels[i]; const d=Math.abs((px-best)/(best||1)); const w=1/(1+100*d); s+=w*(sz||0);
  } return s;
}
function nearTouch(levels:L2Level[], best:number, bps=5, depth=10){
  const cut = (bps/1e4)*(best||1); let s=0;
  for(let i=0;i<Math.min(depth,levels.length);i++){
    const {px,sz}=levels[i]; if (Math.abs(px-best)<=cut) s+=sz||0; else break;
  } return s;
}
function stepTrend(h: L2Book['history']){
  if(!h || h.length<4) return 0.5;
  const last=h.slice(-4); let up=0, down=0;
  for(let i=1;i<last.length;i++){ if(last[i].bidPx>last[i-1].bidPx) up++; if(last[i].askPx<last[i-1].askPx) down++; }
  return clamp01((up+down)/(2*(last.length-1)));
}
function resilience(h: L2Book['history']){
  if(!h || h.length<6) return 0.5;
  const last=h.slice(-5); let rise=0, fall=0;
  for(let i=1;i<last.length;i++){ if(last[i].bidSz>last[i-1].bidSz) rise++; if(last[i].bidSz<last[i-1].bidSz) fall++; }
  return clamp01((rise-fall+4)/8);
}

export function buyPressure(book:L2Book){
  if(!book.bids.length || !book.asks.length) return { score: null as number|null, parts:null as any };
  const bb=book.bids[0].px, ba=book.asks[0].px;
  const wBid=proxWeighted(book.bids,bb,'bid'), wAsk=proxWeighted(book.asks,ba,'ask');
  const imb = (wBid+wAsk)>0 ? wBid/(wBid+wAsk) : 0.5;         // 0..1 (0.5 neutral)
  const ntb = nearTouch(book.bids,bb), nta=nearTouch(book.asks,ba);
  const nt  = (ntb+nta)>0 ? ntb/(ntb+nta) : 0.5;               // 0..1
  const st  = stepTrend(book.history);                          // 0..1
  const rs  = resilience(book.history);                         // 0..1
  const composite = 0.40*imb + 0.30*nt + 0.20*st + 0.10*rs;
  return { score: Math.round(100*clamp01(composite)), parts: {imb:Math.round(imb*100), nt:Math.round(nt*100), st:Math.round(st*100), rs:Math.round(rs*100)} };
}
