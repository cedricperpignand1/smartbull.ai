let ACTIVE: string[] = [];
let lastSetAt = 0;

export function getActiveSymbols(){ return { symbols:[...ACTIVE], lastSetAt }; }
export function setActiveSymbols(symbols:string[]){
  const next = symbols.map(s=>String(s||"").trim().toUpperCase()).filter(Boolean).slice(0,2);
  const changed = next.length!==ACTIVE.length || next.some((s,i)=>s!==ACTIVE[i]);
  ACTIVE = next;
  if (changed) lastSetAt = Date.now();
  return { symbols:[...ACTIVE], changed };
}
