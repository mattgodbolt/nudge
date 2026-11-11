import { CATEGORIES } from './types.js';
import type { EvalItem } from './types.js';

/**
 * What the labeller sees: only what a classifier would see, never the owner's later reply and never the state they
 * put it in, so the labels are not anchored on what happened.
 */
function labelData(sample: { stratum: string; item: EvalItem }[]) {
  return sample.map(({ item: i }) => ({
    id: i.id,
    provider: i.provider,
    kind: i.kind,
    container: i.container,
    title: i.title,
    author: i.author,
    text: i.text,
    thread: i.thread ?? [],
    github: i.github
      ? { authorType: i.github.authorType, association: i.github.association, labels: i.github.labels }
      : null,
  }));
}

/**
 * A single self-contained HTML page for hand-labelling, opened from disk (file://). Progress lives in localStorage;
 * "Download" writes labels.json for `eval:classify score`.
 */
export function labelPageHtml(sample: { stratum: string; item: EvalItem }[]): string {
  const json = JSON.stringify(labelData(sample)).replace(/</g, '\\u003c');
  const cats = JSON.stringify(CATEGORIES);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nudge triage labelling</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#ddd;--acc:#2b6cb0;--card:#f6f6f6}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#999;--line:#333;--acc:#63b3ed;--card:#202020}}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:760px;margin:0 auto;padding:16px}
.bar{display:flex;gap:12px;align-items:center;justify-content:space-between;color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.meta{color:var(--mut);font-size:13px;margin-bottom:8px}
.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:17px}
.msg{border-left:3px solid var(--line);padding-left:10px;margin:6px 0;color:var(--mut);font-size:14px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
button{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
kbd{font:12px monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:4px;color:var(--mut)}
button.on kbd{color:#fff;border-color:#fff8}
.hint{color:var(--mut);font-size:13px}
</style></head><body><main>
<div class="bar"><span id="pos"></span><span><button id="dl">Download labels.json</button></span></div>
<div class="card"><div class="meta" id="meta"></div><div id="thread"></div><div class="text" id="text"></div></div>
<div class="hint">Would Matt need to act on this? (what a perfect assistant should put in his inbox)</div>
<div class="row" id="verdicts"></div>
<div class="hint">Best label (optional)</div>
<div class="row" id="cats"></div>
<details class="hint"><summary>What do the labels mean?</summary><ul>
<li><b>question</b>: asks Matt something</li>
<li><b>technical</b>: corrects, adds to or disagrees with technical content (what the video or PR says), without asking anything</li>
<li><b>bug</b>: reports something broken</li>
<li><b>idea</b>: asks for a feature or a future video</li>
<li><b>collab</b>: sponsor, partnership or reuse request</li>
<li><b>chat</b>: praise, thanks, jokes, banter</li>
<li><b>support</b>: needs help with something</li>
<li><b>bot</b>: automated PR, release or notification</li>
<li><b>other</b>: none of these. Categories are optional; the verdict matters most.</li></ul></details>
<div class="row"><button id="prev">← Back</button><button id="next">Next →</button><span class="hint">r reply · a action · n none · s spam · 1-9, 0 category · ← → move · labels save as you go</span></div>
</main>
<script>
const DATA=${json};const CATS=${cats};
const VERDICTS=[['needs_reply','r','Needs a reply'],['needs_action','a','Needs action (merge, review)'],['no_reply_needed','n','No reply needed'],['spam','s','Spam / scam']];
const KEY='nudge-triage-labels-v1';
let labels={};try{labels=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
let i=0;const first=DATA.findIndex(d=>!labels[d.id]);if(first>0)i=first;
const $=id=>document.getElementById(id);
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(labels))}catch(e){}};
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function render(){
 const d=DATA[i],l=labels[d.id]||{};
 $('pos').textContent=(i+1)+' / '+DATA.length+' · '+Object.keys(labels).length+' labelled';
 let m=d.provider+' · '+d.kind+' · '+d.container+' · '+(d.author||'');
 if(d.github)m+=' · '+[d.github.authorType,d.github.association].filter(Boolean).join('/')+(d.github.labels.length?' · ['+d.github.labels.join(', ')+']':'');
 $('meta').textContent=m;
 const t=$('thread');t.replaceChildren();
 for(const x of d.thread)t.append(el('div','msg',(x.own?'Matt: ':'')+x.text));
 $('text').textContent=(d.title?d.title+'\\n\\n':'')+d.text;
 const v=$('verdicts');v.replaceChildren();
 for(const [k,key,name] of VERDICTS){const b=el('button',l.verdict===k?'on':'');b.append(el('kbd','',key),name);b.onclick=()=>set({verdict:k});v.append(b)}
 const c=$('cats');c.replaceChildren();
 CATS.forEach((k,n)=>{const b=el('button',l.category===k?'on':'');b.append(el('kbd','',String((n+1)%10)),k);b.onclick=()=>set({category:l.category===k?undefined:k});c.append(b)});
}
function set(p){const d=DATA[i];labels[d.id]={...(labels[d.id]||{}),...p};save();render()}
function go(n){i=Math.min(Math.max(i+n,0),DATA.length-1);render()}
$('prev').onclick=()=>go(-1);$('next').onclick=()=>go(1);
$('dl').onclick=()=>{const a=el('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(labels,null,1)],{type:'application/json'}));a.download='labels.json';a.click()};
addEventListener('keydown',e=>{
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 const v=VERDICTS.find(x=>x[1]===e.key);
 if(v){set({verdict:v[0]});setTimeout(()=>go(1),120);return}
 if(/^[0-9]$/.test(e.key)){const k=CATS[(+e.key+9)%10];if(k)set({category:k});return}
 if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1);
});
render();
</script></body></html>
`;
}

/**
 * The same labelling UI as a published Artifact page, for when the owner is on another device. Labels are saved one
 * document per item (`labels/i001`...) in the artifact's database so they can be read back with no download step.
 * Item ids stay inside the documents: GitHub ids contain "/" and "#", which are not valid path segments.
 */
export function labelArtifactHtml(sample: { stratum: string; item: EvalItem }[], collection = 'labels'): string {
  const json = JSON.stringify(labelData(sample)).replace(/</g, '\\u003c');
  const cats = JSON.stringify(CATEGORIES);
  return `<title>Triage labelling</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root{--bg:#fbfaf8;--fg:#1d1b19;--mut:#6b665f;--line:#ddd8d0;--card:#f1eee9;--acc:#1f5f8b;--acc-fg:#fff;--ok:#2f7d4f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171615;--fg:#ece8e2;--mut:#a09a91;--line:#35322e;--card:#211f1d;--acc:#6db3e0;--acc-fg:#10202c;--ok:#6fcf97;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#171615;--fg:#ece8e2;--mut:#a09a91;--line:#35322e;--card:#211f1d;--acc:#6db3e0;--acc-fg:#10202c;--ok:#6fcf97;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0;padding-block:12px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
main{max-width:760px;margin:0 auto}
.bar{display:flex;gap:12px;align-items:center;justify-content:space-between;color:var(--mut);font-size:14px;flex-wrap:wrap}
.saved{color:var(--ok)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0;min-width:0}
.meta{color:var(--mut);font-size:13px;margin-bottom:8px;overflow-wrap:anywhere}
.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:17px}
.msg{border-left:3px solid var(--line);padding-left:10px;margin:6px 0;color:var(--mut);font-size:14px;overflow-wrap:anywhere}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
button{font:inherit;min-height:44px;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button.on{background:var(--acc);color:var(--acc-fg);border-color:var(--acc)}
kbd{font:12px monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:6px;color:var(--mut)}
button.on kbd{color:var(--acc-fg);border-color:currentColor}
.hint{color:var(--mut);font-size:13px}
@media (hover:none){kbd{display:none}}
</style>
<main>
<div class="bar"><span id="pos">Loading...</span><span id="status" class="hint"></span></div>
<div class="card"><div class="meta" id="meta"></div><div id="thread"></div><div class="text" id="text"></div></div>
<div class="hint">Would Matt need to act on this? (what a perfect assistant should put in his inbox)</div>
<div class="row" id="verdicts"></div>
<div class="hint">Best label (optional)</div>
<div class="row" id="cats"></div>
<details class="hint"><summary>What do the labels mean?</summary><ul>
<li><b>question</b>: asks Matt something</li>
<li><b>technical</b>: corrects, adds to or disagrees with technical content (what the video or PR says), without asking anything</li>
<li><b>bug</b>: reports something broken</li>
<li><b>idea</b>: asks for a feature or a future video</li>
<li><b>collab</b>: sponsor, partnership or reuse request</li>
<li><b>chat</b>: praise, thanks, jokes, banter</li>
<li><b>support</b>: needs help with something</li>
<li><b>bot</b>: automated PR, release or notification</li>
<li><b>other</b>: none of these. Categories are optional; the verdict matters most.</li></ul></details>
<div class="row"><button id="prev">Back</button><button id="next">Next</button></div>
<div class="hint">Keys: r (needs a reply), a (needs action: merge or review), n (nothing needed), s (spam) for the verdict; 1-9 and 0 for the label; left and right arrows to move. Each choice saves as you make it.</div>
</main>
<script>
const DATA=${json};const CATS=${cats};
const VERDICTS=[['needs_reply','r','Needs a reply'],['needs_action','a','Needs action (merge, review)'],['no_reply_needed','n','No reply needed'],['spam','s','Spam or scam']];
const key=n=>'i'+String(n).padStart(3,'0');
const $=id=>document.getElementById(id);
let labels={},i=0,col=null,failed=false;
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function status(){const n=Object.keys(labels).length;$('pos').textContent=(i+1)+' / '+DATA.length+' · '+n+' labelled';
 $('status').textContent=failed?'Not saving: labels stay in this tab only':col?'Saved to the page database':'';$('status').className=failed?'hint':'saved'}
function render(){
 const d=DATA[i],l=labels[d.id]||{};status();
 let m=d.provider+' · '+d.kind+' · '+d.container+' · '+(d.author||'');
 if(d.github)m+=' · '+[d.github.authorType,d.github.association].filter(Boolean).join('/')+(d.github.labels.length?' · ['+d.github.labels.join(', ')+']':'');
 $('meta').textContent=m;
 const t=$('thread');t.replaceChildren();
 for(const x of d.thread)t.append(el('div','msg',(x.own?'Matt: ':'')+x.text));
 $('text').textContent=(d.title?d.title+'\\n\\n':'')+d.text;
 const v=$('verdicts');v.replaceChildren();
 for(const [k,kk,name] of VERDICTS){const b=el('button',l.verdict===k?'on':'');b.append(el('kbd','',kk),name);b.onclick=()=>set({verdict:k},false);v.append(b)}
 const c=$('cats');c.replaceChildren();
 CATS.forEach((k,n)=>{const b=el('button',l.category===k?'on':'');b.append(el('kbd','',String((n+1)%10)),k);b.onclick=()=>set({category:l.category===k?null:k},false);c.append(b)});
}
async function set(p,advance){
 const d=DATA[i];labels[d.id]={...(labels[d.id]||{}),...p};
 render();
 if(col){try{await col.doc(key(i)).set({id:d.id,verdict:labels[d.id].verdict||null,category:labels[d.id].category||null});failed=false}catch(e){failed=true}status()}
 if(advance)setTimeout(()=>go(1),120);
}
function go(n){i=Math.min(Math.max(i+n,0),DATA.length-1);render()}
$('prev').onclick=()=>go(-1);$('next').onclick=()=>go(1);
addEventListener('keydown',e=>{
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 const v=VERDICTS.find(x=>x[1]===e.key);
 if(v){set({verdict:v[0]},true);return}
 if(/^[0-9]$/.test(e.key)){const k=CATS[(+e.key+9)%10];if(k)set({category:k},false);return}
 if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1);
});
render();
(async()=>{
 try{
  const db=await claude.use('db');
  if(!db){failed=true;status();return}
  col=db.collection(${JSON.stringify(collection)});
  const snap=await col.get();
  snap.docs.forEach(s=>{const x=s.data();if(x&&x.id&&x.verdict)labels[x.id]={verdict:x.verdict,category:x.category||undefined}});
  const first=DATA.findIndex(d=>!labels[d.id]);if(first>0)i=first;
  render();
 }catch(e){failed=true;status()}
})();
</script>
`;
}
