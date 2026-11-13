// 화면 공통 요소: 스타일, 앱 틀(메뉴·알림 벨), 작은 부품. 화면 내용은 screens.mjs가 만든다.
import { sourceLabels } from './audit.mjs';

export const money = amount => new Intl.NumberFormat('ko-KR').format(amount) + '원';
export const manwon = amount => new Intl.NumberFormat('ko-KR').format(Math.floor(amount / 10000)) + '만원';
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const time = value => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));
export const day = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' })
  .format(new Date(value));
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
export const mask = account => '•••• ' + escape(String(account ?? '').slice(-4));

export const styles = `
*{box-sizing:border-box}
body{margin:0;background:#f3f5f8;color:#182638;font-family:Inter,"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;font-size:15px;line-height:1.5}
a{color:#2467d6;text-decoration:none}a:hover{text-decoration:underline}
p{margin:0}h1{margin:0;font-size:24px;letter-spacing:-.03em}h2{margin:0;font-size:17px}h3{margin:0;font-size:15px}
[hidden]{display:none!important}
.app{min-height:100vh;display:flex;flex-wrap:wrap}
.side{flex:1 1 210px;max-width:260px;background:#fff;border-right:1px solid #e5eaf0;padding:24px 14px;display:flex;flex-direction:column;gap:4px}
.brand{display:flex;gap:10px;align-items:center;margin:0 6px 22px}
.brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:#2467d6;color:#fff;font-weight:800}
.brand div strong{display:block}.brand div span{font-size:12px;color:#526074}
.nav{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:10px;color:#35455a;font-weight:600}
.nav:hover{text-decoration:none;background:#f6f8fb}
.nav[aria-current=page]{background:#edf5ff;color:#2467d6}
.count{min-width:22px;padding:0 7px;border-radius:999px;background:#e8eef7;color:#35455a;font-size:12px;text-align:center;line-height:20px}
.nav[aria-current=page] .count{background:#2467d6;color:#fff}
.side-foot{margin-top:auto;padding:12px 6px 0;font-size:13px;color:#526074;display:flex;flex-direction:column;gap:6px}
main.page{flex:999 1 560px;min-width:0;padding:28px clamp(16px,4vw,48px)}
.wrap{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.wide{max-width:1060px}
.wrap>form{display:flex;flex-direction:column;gap:16px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.crumb{font-size:13px;color:#526074;margin-bottom:6px}
.card{background:#fff;border:1px solid #e5eaf0;border-radius:14px;padding:20px 22px}
.card.tight{padding:14px 18px}.card.focus{border-color:#c9dcf7;background:#f7fbff}.card.warn{background:#fffaf0;border-color:#f3dfb4}
.muted{color:#526074;font-size:13px}
.pill{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:700;white-space:nowrap}
.s-blue{background:#e8f1ff;color:#1a4fa8}.s-green{background:#e6f4ea;color:#1e6b34}.s-amber{background:#fff1d6;color:#7a3f00}.s-red{background:#fde8e8;color:#a12a2a}.s-gray{background:#eef2f7;color:#35455a}
.tag{display:inline-block;white-space:nowrap;padding:2px 8px;border-radius:6px;background:#eef2f7;font-size:12px;font-weight:600;color:#35455a}
.tag.ai{background:#e8f1ff;color:#1a4fa8}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 18px;border-radius:10px;border:1px solid #c9d3e0;background:#fff;color:#182638;font:inherit;font-weight:600;cursor:pointer}
.btn:hover,button:hover{text-decoration:none;background:#f6f8fb}
.primary{background:#2467d6;border-color:#2467d6;color:#fff}.primary:hover{background:#1a4fa8;color:#fff}
.danger{border-color:#e3b4b4;color:#a12a2a}
.small{min-height:34px;padding:0 12px;font-size:13px;white-space:nowrap}
button:disabled{background:#e9edf3;border-color:#e9edf3;color:#8592a6;cursor:not-allowed}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #eef1f5}
.rows>.row:first-child{border-top:0}
.ico{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;font-size:12px;font-weight:800;flex:none}
.i-warn{background:#fff1d6;color:#7a3f00}.i-ok{background:#e6f4ea;color:#1e6b34}.i-no{background:#fde8e8;color:#a12a2a}.i-wait{background:#eef2f7;color:#526074}
.line{display:flex;gap:10px;align-items:center}
details>summary{cursor:pointer;color:#526074;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px}
th{text-align:left;color:#526074;font-weight:600;padding:8px 10px;border-bottom:1px solid #e5eaf0;white-space:nowrap}
td{padding:10px;border-bottom:1px solid #eef1f5;vertical-align:top}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
input[type=text],input[type=date],input[type=search],input:not([type]),select,textarea{font:inherit;padding:10px 12px;border:1px solid #c9d3e0;border-radius:9px;background:#fff;width:100%}
textarea{min-height:72px}
label.field{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}
.agencies{display:flex;gap:10px;flex-wrap:wrap}
.agency{flex:1 1 150px;border:1px solid #e5eaf0;border-radius:12px;padding:12px 14px}
.agency b{display:block}.agency strong{display:block;margin-top:6px;font-size:17px;font-variant-numeric:tabular-nums}
.bar{height:10px;border-radius:999px;background:repeating-linear-gradient(45deg,#f4b4b4 0 6px,#fbd5d5 6px 12px);margin-top:8px;overflow:hidden}
.bar>i{display:block;height:100%;background:#2467d6}
.bar.ok{background:#e9edf3}
.note{margin-top:12px;padding:10px 14px;border-radius:10px;background:#f6f8fb;font-size:14px}
.note.warn{background:#fff7e6}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.stat{display:flex;flex-direction:column;gap:2px;background:#fff;border:1px solid #e5eaf0;border-radius:14px;padding:14px 16px;color:#182638}
.stat:hover{text-decoration:none;border-color:#c9dcf7}
.stat span{font-size:13px;color:#526074}.stat strong{font-size:22px}
.todo{display:flex;gap:12px;align-items:center;padding:14px 20px;border-top:1px solid #eef1f5;color:#182638}
.todo:hover{text-decoration:none;background:#f9fbfd}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tab{min-height:36px;padding:0 14px;border-radius:999px;font-size:14px}
.tab[aria-current=page]{background:#182638;border-color:#182638;color:#fff}
.seg{display:inline-flex;align-self:flex-start;gap:4px;padding:4px;border-radius:10px;background:#e9edf3}
.seg label{border-radius:7px;font-size:14px;font-weight:600;cursor:pointer}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg input:checked+span{background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.seg span{display:block;padding:7px 14px;border-radius:7px}
form:has(input[name=decision][value=approve]:not(:checked)) [data-when=approve]{display:none}
.choice{flex:1 1 200px;display:flex;gap:10px;padding:14px 16px;border:2px solid #e5eaf0;border-radius:12px;cursor:pointer}
.choice:has(input:checked){border-color:#2467d6;background:#f5f9ff}
.check{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid #eef1f5}
.check input[type=checkbox]{width:20px;height:20px;margin-top:2px;flex:none;accent-color:#2467d6}
.dots{display:inline-flex;gap:4px}
.dot{display:inline-grid;place-items:center;min-width:34px;height:22px;padding:0 6px;border-radius:6px;font-size:11px;font-weight:700}
.bell{position:relative}
.bell>summary{list-style:none;display:grid;place-items:center;width:44px;height:44px;border-radius:12px;border:1px solid #e5eaf0;background:#fff;color:#4a5668}
.bell>summary::-webkit-details-marker{display:none}
.bell .badge{position:absolute;top:6px;right:6px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#d64545;color:#fff;font-size:11px;font-weight:700;line-height:16px;text-align:center}
.bell-panel{position:absolute;right:0;top:52px;width:340px;background:#fff;border:1px solid #e5eaf0;border-radius:14px;box-shadow:0 12px 32px rgba(27,37,51,.12);z-index:5;overflow:hidden}
.bell-panel a{display:flex;gap:10px;padding:12px 16px;border-top:1px solid #eef1f5;color:#182638}
.empty{padding:28px;text-align:center;color:#526074}
pre.doc{white-space:pre-wrap;margin:0;font:inherit;font-size:13px;line-height:1.8;background:#fff;border:1px solid #e5eaf0;border-radius:8px;padding:16px}
.flash{padding:10px 14px;border-radius:10px;background:#e6f4ea;color:#1e6b34;font-size:14px}
@media (max-width:720px){.side{max-width:none;flex-basis:100%;flex-direction:row;flex-wrap:wrap;padding:12px}.brand{margin:0 12px 0 0}.side-foot{display:none}}
`;

export const icon = kind => ({
  ok: '<span class="ico i-ok" aria-label="완료">✓</span>',
  warn: '<span class="ico i-warn" aria-label="주의">!</span>',
  no: '<span class="ico i-no" aria-label="부족">✕</span>',
  wait: '<span class="ico i-wait" aria-label="대기">◷</span>',
})[kind];

export const pill = (tone, text) => '<span class="pill s-' + tone + '">' + text + '</span>';

export function bar(total, limit) {
  const over = total > limit;
  return '<div class="bar' + (over ? '' : ' ok') + '" aria-hidden="true"><i style="width:' +
    Math.round(over ? limit / total * 100 : total / limit * 100) + '%"></i></div>' +
    '<div class="line muted" style="justify-content:space-between;font-size:12px;margin-top:4px"><span>' +
    '<span title="영업지원팀이 임원 없이 승인할 수 있는 거래처 묶음별 월 합계 한도" style="border-bottom:1px dotted #8592a6">팀 승인 한도</span> ' +
    manwon(limit) + '</span>' + (over ? '<span style="color:#a12a2a;font-weight:700">▲ ' + manwon(total - limit) + ' 초과</span>'
      : '<span>' + manwon(limit - total) + ' 남음</span>') + '</div>';
}

export function table(headers, rows, { empty = '아직 없어요', numeric = [] } = {}) {
  if (!rows.length) return '<p class="empty">' + empty + '</p>';
  return '<div class="scroll" tabindex="0" role="region" aria-label="표"><table><thead><tr>' +
    headers.map((header, index) => '<th scope="col"' + (numeric.includes(index) ? ' class="num"' : '') + '>' + header + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map((cell, index) =>
      '<td' + (numeric.includes(index) ? ' class="num"' : '') + '>' + cell + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

// 업무 기록 정보(A05 원본·가정 구분). 기본값이 채워진 채 접혀 있어 평소엔 손대지 않아도 된다.
export function recordFields(period, previous) {
  const inherited = previous?.effectivePeriod === period ? previous : null;
  return '<details class="record"><summary>기록 정보 · 업무 발생일 ' + today() + ' · ' +
    escape(sourceLabels[inherited?.source ?? 'manual']) + '</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:8px">' +
    '<label class="field">업무 발생일 <input type="date" name="occurredOn" value="' + today() + '" required></label>' +
    '<label class="field">자료 구분 <select name="source">' + Object.entries(sourceLabels).map(([value, label]) =>
      '<option value="' + value + '"' + (value === (inherited?.source ?? 'manual') ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>' +
    '<input type="hidden" name="sameEffectiveDate" value="yes"><input type="hidden" name="effectivePeriod" value="' + escape(period) + '">' +
    '</div><p class="muted" style="margin-top:6px">가상기업 기준일 2026-07-01 · 적용일은 업무 발생일과 같고, 정산월 ' + escape(period) + '에 바로 반영돼요.</p></details>';
}

export function bell(items) {
  return '<details class="bell"><summary aria-label="알림 ' + items.length + '건"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>' +
    (items.length ? '<span class="badge">' + items.length + '</span>' : '') + '</summary><div class="bell-panel" role="dialog" aria-label="알림">' +
    '<div style="padding:12px 16px"><strong style="font-size:14px">알림</strong></div>' +
    (items.length ? items.map(([href, text, when]) => '<a href="' + href + '"><span class="ico i-wait" aria-hidden="true">•</span><span>' + text +
      (when ? '<br><span class="muted">' + when + '</span>' : '') + '</span></a>').join('') : '<p class="empty">새 알림이 없어요</p>') +
    '</div></details>';
}

export function shell({ title, subtitle, nav, content, role, period, periods, periodLink, wide = false, notifications = null, script = '' }) {
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escape(title) + ' | 판매장려금</title><style>' + styles + '</style></head><body><div class="app">' +
    '<nav class="side" aria-label="업무 메뉴"><div class="brand"><span class="brand-mark" aria-hidden="true">A</span><div><strong>판매장려금</strong><span>' +
    escape(subtitle) + '</span></div></div>' + nav.map(([href, label, count, current]) => '<a class="nav" href="' + href + '"' +
      (current ? ' aria-current="page"' : '') + '>' + label + (count == null ? '' : ' <span class="count">' + count + '</span>') + '</a>').join('') +
    '<div class="side-foot">' + (periods && periods.length > 1 && role !== '대리점' ? '<form method="get" class="line" style="gap:6px"><input type="hidden" name="view" value="' + escape(periodLink) + '">' +
      '<select name="period" aria-label="정산월" style="padding:6px 8px">' + periods.map(value => '<option' + (value === period ? ' selected' : '') + '>' + value + '</option>').join('') +
      '</select><button class="small">보기</button></form>' : '') +
    '<span>' + escape(role) + ' · <a href="/?view=roles">역할 바꾸기</a></span></div></nav>' +
    '<main class="page"><div class="wrap' + (wide ? ' wide' : '') + '">' +
    (notifications ? '<div style="display:flex;justify-content:flex-end;margin-bottom:-8px;position:relative">' + bell(notifications) + '</div>' : '') +
    content + '</div></main></div>' + clientScript + script + '</body></html>';
}

const clientScript = `<script>
document.addEventListener('invalid',event=>{let parent=event.target.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}},true);
document.addEventListener('submit',async event=>{
  const form=event.target;
  if(!form.matches('form[data-ai]')) return;
  event.preventDefault();
  const button=event.submitter??form.querySelector('button');
  const target=document.querySelector(form.dataset.target);
  if(!button||!target) return;
  button.disabled=true;
  const status=target.querySelector('[data-ai-status]');
  if(status) status.textContent='AI가 살펴보는 중이에요 · 기다리지 않고 직접 해도 돼요';
  try{
    const response=await fetch(form.getAttribute('action'),{method:'POST',body:new URLSearchParams([[button.name,button.value]])});
    if(!response.ok) throw Error();
    const page=new DOMParser().parseFromString(await response.text(),'text/html');
    const updated=page.querySelector(form.dataset.target);
    if(!updated) throw Error();
    for(const field of target.querySelectorAll('input,textarea,select')){
      const next=updated.querySelector('[name="'+field.name+'"]'+(field.type==='checkbox'?'[value="'+field.value+'"]':''));
      if(next&&field.dataset.touched){if(field.type==='checkbox')next.checked=field.checked;else next.value=field.value;}
    }
    target.replaceWith(updated);
  }catch{ if(status) status.textContent='AI를 쓸 수 없어요 · 직접 진행해 주세요'; }
  finally{button.disabled=false;}
});
document.addEventListener('input',event=>{if(event.target.name)event.target.dataset.touched='1';});
document.addEventListener('change',event=>{if(event.target.name)event.target.dataset.touched='1';});
for(const automatic of document.querySelectorAll('form[data-ai][data-auto]')) automatic.requestSubmit(automatic.querySelector('button'));
</script>`;
