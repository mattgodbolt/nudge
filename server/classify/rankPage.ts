import type { Group } from './rank.js';
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
    at: i.occurredAt,
    thread: i.thread ?? [],
    github: i.github
      ? { authorType: i.github.authorType, association: i.github.association, labels: i.github.labels }
      : null,
  };
}

/**
 * A published Artifact page for collecting priority judgements from another device, built for a phone: a handful of
 * items at a time, tapped in the order he would handle them, with an optional "must do today" flag on each. One
 * document per group (`groups/g000`...) in the artifact's database so the answers can be read back directly. Item ids
 * stay inside the documents: GitHub ids contain "/" and "#", which are not valid path segments.
 */
export function rankArtifactHtml(items: EvalItem[], groups: Group[], collection = 'groups'): string {
  const data = JSON.stringify({ items: items.map(view), groups }).replace(/</g, '\\u003c');
  return `<title>What first</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root{--bg:#fbfaf8;--fg:#1d1b19;--mut:#6b665f;--line:#ddd8d0;--card:#f1eee9;--acc:#1f5f8b;--acc-fg:#fff;--ok:#2f7d4f;--warn:#b4620b}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171615;--fg:#ece8e2;--mut:#a09a91;--line:#35322e;--card:#211f1d;--acc:#6db3e0;--acc-fg:#10202c;--ok:#6fcf97;--warn:#f0a050;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#171615;--fg:#ece8e2;--mut:#a09a91;--line:#35322e;--card:#211f1d;--acc:#6db3e0;--acc-fg:#10202c;--ok:#6fcf97;--warn:#f0a050;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif;margin:0;padding-block:10px;padding-left:max(14px,env(safe-area-inset-left,0px));padding-right:max(14px,env(safe-area-inset-right,0px))}
main{max-width:720px;margin:0 auto}
.bar{display:flex;gap:10px;align-items:center;justify-content:space-between;color:var(--mut);font-size:13px;flex-wrap:wrap}
.saved{color:var(--ok)}
.hint{color:var(--mut);font-size:13px;margin:4px 0}
.card{position:relative;background:var(--card);border:2px solid var(--line);border-radius:10px;padding:8px 44px 8px 10px;margin:8px 0;min-width:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.card.pick{border-color:var(--acc)}
.badge{position:absolute;right:8px;top:8px;width:28px;height:28px;border-radius:50%;border:2px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:var(--mut)}
.card.pick .badge{background:var(--acc);border-color:var(--acc);color:var(--acc-fg)}
.meta{color:var(--mut);font-size:12px;overflow-wrap:anywhere}
.text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:2px}
.msg{border-left:3px solid var(--line);padding-left:8px;margin:4px 0;color:var(--mut);font-size:13px;overflow-wrap:anywhere}
.small{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.small button{min-height:34px;padding:2px 10px;font-size:13px;flex:0 0 auto}
button{font:inherit;min-height:46px;padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;flex:1 1 100px}
button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button.on{background:var(--warn);color:#fff;border-color:var(--warn)}
button.primary{background:var(--acc);color:var(--acc-fg);border-color:var(--acc)}
button:disabled{opacity:.45}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
kbd{font:11px monospace;border:1px solid var(--line);border-radius:4px;padding:0 3px;margin-right:4px;color:var(--mut)}
@media (hover:none){kbd{display:none}}
</style>
<main>
<div class="bar"><span id="pos">Loading...</span><span id="status" class="hint"></span></div>
<div class="hint">Imagine these landed in your inbox together. Tap them in the order you would handle them, most important first. Tap one again to take it back. Flag the ones that must happen today. If the rest are equal, press Done.</div>
<div id="cards"></div>
<div class="row"><button id="back">Back</button><button id="done" class="primary">Done</button></div>
<div class="hint">Keys: 1-4 pick the card at that position, top to bottom, Enter = Done, Backspace = clear, left and right arrows move. Each group saves as you finish it; some repeat on purpose.</div>
</main>
<script>
const D=${data};const ITEMS=Object.fromEntries(D.items.map(x=>[x.id,x]));const GROUPS=D.groups;
const key=n=>'g'+String(n).padStart(3,'0');
const $=id=>document.getElementById(id);
const answers={};let i=0,col=null,failed=false,order=[],today=new Set(),open=new Set();
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function ago(iso){const d=(Date.now()-Date.parse(iso))/864e5;if(d<1)return 'today';if(d<2)return 'yesterday';if(d<60)return Math.round(d)+' days ago';if(d<700)return Math.round(d/30)+' months ago';return Math.round(d/365)+' years ago'}
function status(){$('pos').textContent=(i+1)+' / '+GROUPS.length+' · '+Object.keys(answers).length+' done';
 $('status').textContent=failed?'Not saving: answers stay in this tab only':col?'Saved to the page database':'';$('status').className=failed?'hint':'saved'}
function load(){const g=GROUPS[i],a=answers[g.n];order=a?[...a.order]:[];today=new Set(a?a.today:[]);open=new Set();render()}
function render(){
 const g=GROUPS[i];status();const box=$('cards');box.replaceChildren();
 g.ids.forEach(id=>{
  const d=ITEMS[id],rank=order.indexOf(id)+1;
  const c=el('div','card'+(rank?' pick':''));c.onclick=()=>toggle(id);
  c.append(el('div','badge',rank?String(rank):''));
  let m=d.provider+' · '+d.kind+' · '+(d.github?d.container:d.container+(d.channel?' ('+d.channel+(d.ownChannel?', yours':'')+')':''))+' · '+(d.author||'')+' · '+ago(d.at);
  if(d.github)m+=' · '+[d.github.authorType,d.github.association].filter(Boolean).join('/')+(d.github.labels.length?' ['+d.github.labels.join(', ')+']':'');
  c.append(el('div','meta',m));
  for(const x of d.thread.slice(-1))c.append(el('div','msg',(x.own?'Matt: ':'')+x.text.slice(0,140)));
  const full=(d.title?d.title+' — ':'')+d.text,long=full.length>200,shown=open.has(id)||!long;
  c.append(el('div','text',shown?full:full.slice(0,200)+'…'));
  const s=el('div','small');
  if(long){const b=el('button','',shown?'Less':'More');b.onclick=e=>{e.stopPropagation();open.has(id)?open.delete(id):open.add(id);render()};s.append(b)}
  const t=el('button',today.has(id)?'on':'',today.has(id)?'Today ✓':'Do today');t.onclick=e=>{e.stopPropagation();today.has(id)?today.delete(id):today.add(id);render()};s.append(t);
  c.append(s);box.append(c)});
 $('back').disabled=i===0;$('done').disabled=false;
}
function toggle(id){const k=order.indexOf(id);if(k>=0)order.splice(k,1);else order.push(id);
 render();if(order.length===GROUPS[i].ids.length-1){const last=GROUPS[i].ids.find(x=>!order.includes(x));order.push(last);render();setTimeout(finish,350)}}
async function finish(){
 const g=GROUPS[i];const a={n:g.n,ids:g.ids,order:[...order],today:[...today],repeat:!!g.repeat};answers[g.n]=a;status();
 if(col){try{await col.doc(key(g.n)).set(a);failed=false}catch(e){failed=true}status()}
 if(i<GROUPS.length-1){i++;load();scrollTo(0,0)}else status();
}
$('done').onclick=finish;$('back').onclick=()=>{if(i>0){i--;load();scrollTo(0,0)}};
addEventListener('keydown',e=>{
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 if(/^[1-4]$/.test(e.key)){const id=GROUPS[i].ids[+e.key-1];if(id)toggle(id)}
 else if(e.key==='Enter')finish();else if(e.key==='Backspace'){order=[];render()}
 else if(e.key==='ArrowRight'&&i<GROUPS.length-1){i++;load()}else if(e.key==='ArrowLeft'&&i>0){i--;load()}
});
load();
(async()=>{
 try{
  const db=await claude.use('db');
  if(!db){failed=true;status();return}
  col=db.collection(${JSON.stringify(collection)});
  const snap=await col.get();
  snap.docs.forEach(s=>{const x=s.data();if(x&&typeof x.n==='number'&&Array.isArray(x.order))answers[x.n]=x});
  const first=GROUPS.findIndex(g=>!answers[g.n]);if(first>0)i=first;
  load();
 }catch(e){failed=true;status()}
})();
</script>
`;
}
