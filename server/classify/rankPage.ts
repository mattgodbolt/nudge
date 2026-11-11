import type { Pair } from './rank.js';
import type { EvalItem } from './types.js';

/** What the owner sees of an item: what a ranker would see, never what he later did with it. */
function view(i: EvalItem) {
  return {
    id: i.id,
    provider: i.provider,
    kind: i.kind,
    container: i.container,
    channel: i.channel ?? null,
    ownChannel: i.ownChannel ?? null,
    title: i.title,
    author: i.author,
    text: i.text,
    thread: i.thread ?? [],
    github: i.github
      ? { authorType: i.github.authorType, association: i.github.association, labels: i.github.labels }
      : null,
  };
}

/**
 * A published Artifact page for collecting pairwise priority judgements ("which matters more?") from another device.
 * One document per comparison (`pairs/p000`...) in the artifact's database, so the answers can be read back directly.
 * Item ids stay inside the documents: GitHub ids contain "/" and "#", which are not valid path segments.
 */
export function rankArtifactHtml(items: EvalItem[], pairs: Pair[], collection = 'pairs'): string {
  const data = JSON.stringify({ items: items.map(view), pairs }).replace(/</g, '\\u003c');
  return `<title>Which matters more</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root{--bg:#fbfaf8;--fg:#1d1b19;--mut:#6b665f;--line:#ddd8d0;--card:#f1eee9;--acc:#1f5f8b;--acc-fg:#fff;--ok:#2f7d4f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171615;--fg:#ece8e2;--mut:#a09a91;--line:#35322e;--card:#211f1d;--acc:#6db3e0;--acc-fg:#10202c;--ok:#6fcf97;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#171615;--fg:#ece8e2;--mut:#a09a91;--line:#35322e;--card:#211f1d;--acc:#6db3e0;--acc-fg:#10202c;--ok:#6fcf97;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0;padding-block:12px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
main{max-width:1000px;margin:0 auto}
.bar{display:flex;gap:12px;align-items:center;justify-content:space-between;color:var(--mut);font-size:14px;flex-wrap:wrap}
.saved{color:var(--ok)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:760px){.pair{grid-template-columns:1fr}}
.card{background:var(--card);border:2px solid var(--line);border-radius:10px;padding:14px;margin:12px 0;min-width:0}
.card.pick{border-color:var(--acc)}
.tag{font-weight:700;margin-bottom:4px}
.meta{color:var(--mut);font-size:13px;margin-bottom:8px;overflow-wrap:anywhere}
.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;max-height:340px;overflow:auto}
.msg{border-left:3px solid var(--line);padding-left:10px;margin:6px 0;color:var(--mut);font-size:14px;overflow-wrap:anywhere}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
button{font:inherit;min-height:48px;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;flex:1 1 140px}
button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button.on{background:var(--acc);color:var(--acc-fg);border-color:var(--acc)}
kbd{font:12px monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:6px;color:var(--mut)}
button.on kbd{color:var(--acc-fg);border-color:currentColor}
.hint{color:var(--mut);font-size:13px}
@media (hover:none){kbd{display:none}}
</style>
<main>
<div class="bar"><span id="pos">Loading...</span><span id="status" class="hint"></span></div>
<div class="hint">Which would you rather deal with first? Think about the impact, who is waiting, how time-sensitive it is and how much it is worth to you. Equal is a fine answer. Go with your gut; some pairs will repeat on purpose.</div>
<div class="pair"><div class="card" id="ca"></div><div class="card" id="cb"></div></div>
<div class="row" id="choices"></div>
<div class="row"><button id="prev">Back</button><button id="next">Skip</button></div>
<div class="hint">Keys: 1 = left matters more, 2 = right matters more, 3 = about equal; left and right arrows move. Each choice saves as you make it.</div>
</main>
<script>
const D=${data};const ITEMS=Object.fromEntries(D.items.map(x=>[x.id,x]));const PAIRS=D.pairs;
const key=n=>'p'+String(n).padStart(3,'0');
const $=id=>document.getElementById(id);
let answers={},i=0,col=null,failed=false;
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function status(){const n=Object.keys(answers).length;$('pos').textContent=(i+1)+' / '+PAIRS.length+' · '+n+' answered';
 $('status').textContent=failed?'Not saving: answers stay in this tab only':col?'Saved to the page database':'';$('status').className=failed?'hint':'saved'}
function card(box,d,label,picked){
 box.replaceChildren();box.className='card'+(picked?' pick':'');
 box.append(el('div','tag',label));
 let m=d.provider+' · '+d.kind+' · '+d.container+' · '+(d.author||'')+(d.channel?' · channel: '+d.channel+(d.ownChannel?' (yours)':''):'');
 if(d.github)m+=' · '+[d.github.authorType,d.github.association].filter(Boolean).join('/')+(d.github.labels.length?' · ['+d.github.labels.join(', ')+']':'');
 box.append(el('div','meta',m));
 for(const x of d.thread)box.append(el('div','msg',(x.own?'Matt: ':'')+x.text));
 box.append(el('div','text',(d.title?d.title+'\\n\\n':'')+d.text));
}
function render(){
 const p=PAIRS[i],w=answers[p.n];status();
 card($('ca'),ITEMS[p.a],'Left',w==='a');card($('cb'),ITEMS[p.b],'Right',w==='b');
 const c=$('choices');c.replaceChildren();
 for(const [k,kk,name] of [['a','1','Left matters more'],['t','3','About equal'],['b','2','Right matters more']]){const b=el('button',w===k?'on':'');b.append(el('kbd','',kk),name);b.onclick=()=>choose(k);c.append(b)}
}
async function choose(w){
 const p=PAIRS[i];answers[p.n]=w;render();
 if(col){try{await col.doc(key(p.n)).set({n:p.n,a:p.a,b:p.b,w,repeat:!!p.repeat});failed=false}catch(e){failed=true}status()}
 setTimeout(()=>go(1),150);
}
function go(n){i=Math.min(Math.max(i+n,0),PAIRS.length-1);render();scrollTo(0,0)}
$('prev').onclick=()=>go(-1);$('next').onclick=()=>go(1);
addEventListener('keydown',e=>{
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 if(e.key==='1')choose('a');else if(e.key==='2')choose('b');else if(e.key==='3')choose('t');
 else if(e.key==='ArrowRight')go(1);else if(e.key==='ArrowLeft')go(-1);
});
render();
(async()=>{
 try{
  const db=await claude.use('db');
  if(!db){failed=true;status();return}
  col=db.collection(${JSON.stringify(collection)});
  const snap=await col.get();
  snap.docs.forEach(s=>{const x=s.data();if(x&&typeof x.n==='number'&&x.w)answers[x.n]=x.w});
  const first=PAIRS.findIndex(p=>!answers[p.n]);if(first>0)i=first;
  render();
 }catch(e){failed=true;status()}
})();
</script>
`;
}
