const badgeTypes = [
  ['재검토 필요', 'review'],
  ['확인 대기', 'check'],
  ['보류', 'hold'],
  ['승인 대기', 'pending'],
  ['승인', 'approved'],
];

export function originBadge(label) {
  return '<small class="origin-badge">' + label + '</small>';
}

export function statusBadge(label) {
  const type = badgeTypes.find(([status]) => label.includes(status))?.[1] ?? 'neutral';
  return '<span class="status-badge status-' + type + '">' + label + '</span>';
}

export const workspaceStyles = `
:root{color-scheme:light;--accent:#2467d6;--blue-light:#edf5ff;--border:#e5eaf0;--muted:#526074;--paper:#fff}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:#f3f5f8;color:#182638;font:16px/1.6 Inter,"Malgun Gothic",system-ui,sans-serif}
.workspace{display:grid;grid-template-columns:15.5rem minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:2rem 1rem;background:var(--paper);border-right:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:.7rem;margin:0 .5rem 2.1rem;line-height:1.35}
.brand-mark{display:grid;place-items:center;width:2.4rem;height:2.4rem;border-radius:12px;background:var(--accent);color:white;font-weight:800}
.brand strong{display:block;font-size:1.13rem;letter-spacing:-.025em}
.brand div span{display:block;color:var(--muted);font-size:.77rem}
.sidebar nav{display:grid;gap:.3rem}
.sidebar a{display:block;padding:.72rem .85rem;border-radius:10px;color:#35455a;text-decoration:none;font-weight:600}
.sidebar a:hover{background:#f0f4fa}
.sidebar a[aria-current=page]{background:var(--blue-light);color:var(--accent)}
main{width:100%;max-width:88rem;margin:0 auto;padding:2.75rem clamp(1rem,3.7vw,3.75rem) 3rem}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.6rem}
h1{margin:0;font-size:clamp(1.8rem,3vw,2.2rem);line-height:1.22;letter-spacing:-.045em}
h2{margin:0 0 1.1rem;font-size:1.35rem;letter-spacing:-.025em}
h2 small{font-size:.9rem;color:var(--muted);margin-left:.35rem}
h3{font-size:1.08rem;margin:1.5rem 0 .6rem}
h4{margin:1rem 0 .5rem}
.content{background:var(--paper);border:1px solid var(--border);border-radius:20px;padding:clamp(1rem,3vw,2rem)}
.content section+section{margin-top:2rem}
.filters{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin:0}
.filters label{font-size:.9rem;color:var(--muted);font-weight:600}
form{margin:1rem 0}
button,select,textarea,input{font:inherit}
button,select,input:not([type=file]),textarea{border:1px solid #d8dfe8;border-radius:10px;background:#fff;color:inherit;padding:.55rem .78rem}
button{font-weight:600;cursor:pointer}
button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
button.primary{color:#fff;background:var(--accent);border-color:var(--accent)}
button.primary:hover:not(:disabled){color:#fff;background:#1955b8}
button:disabled,fieldset:disabled button{cursor:default;opacity:.6}
textarea{vertical-align:middle;width:min(100%,34rem)}
fieldset{min-width:0;border:1px solid var(--border);border-radius:12px;padding:.9rem 1rem 1rem}
a{color:var(--accent);text-underline-offset:.15em}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.table-scroll{overflow-x:auto;margin:.8rem 0 1.25rem;border:1px solid var(--border);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:34rem;overflow-wrap:anywhere;font-size:.94rem}
th,td{text-align:left;padding:.95rem 1.1rem;border-bottom:1px solid var(--border);vertical-align:top}
th{background:#f5f7fa;color:#3b4b60;font-weight:650}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#fafbfd}
.amount{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.status-badge{display:inline-block;padding:.2rem .6rem;border-radius:999px;font-size:.83rem;font-weight:650;line-height:1.45}
.status-neutral{background:#eef1f5;color:#455367}
.status-pending{background:#e9f0fd;color:#214d97}
.status-approved{background:#e5f4ed;color:#1c6245}
.status-hold{background:#fff1d8;color:#704701}
.status-review{background:#fbe9ee;color:#90354e}
.status-check{background:#eeeafb;color:#59438c}
.summary-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:1rem;margin-bottom:1.5rem}
.summary-card{padding:1.25rem;border:1px solid var(--border);border-radius:16px;background:#f8fafc}
.summary-card p{margin:0;color:var(--muted);font-size:.9rem}
.summary-card strong{display:inline-block;margin-top:.3rem;font-size:1.72rem;letter-spacing:-.035em;font-variant-numeric:tabular-nums}
.summary-card:last-child strong{font-size:1.1rem}
.detail-cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))}
.detail-cards .summary-card strong{font-size:1.1rem;overflow-wrap:anywhere}
.decision-explanation{margin:0 0 1.2rem}
.decision-panel,.ai-summary{padding:1.2rem;border:1px solid var(--border);border-radius:14px;background:#f8faff}
.ai-summary{margin:1rem 0}
.ai-summary h3{margin:0 0 .5rem}
.ai-summary form{margin-bottom:0}
.decision-panel h3{margin:0 0 .5rem}
.decision-panel form{margin-bottom:0}
.next-task{margin:0 0 1.2rem;padding:.78rem 1rem;border-radius:12px;background:var(--blue-light);color:#254574}
.next-task strong{margin-inline-end:.55rem}
.role-switch{display:inline-block;padding:.15rem .5rem;border:1px solid var(--border);border-radius:5px;background:#fff;text-decoration:none}
.empty-state{color:var(--muted);margin:.75rem 0}
.content .evidence{margin-top:1rem}
details.evidence{padding:.82rem 1rem;border:1px solid var(--border);border-radius:12px}
.evidence>summary{font-weight:650}
.locations{margin:.65rem 0;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.executive-row td{background:#edf5ff;font-weight:650}
.executive-row td:first-child{box-shadow:inset 5px 0 var(--accent)}
.request-progress{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;padding:0;margin:0 0 1rem;list-style:none;font-size:.87rem}
.request-progress li{color:var(--muted)}
.request-progress li+li::before{content:"→";margin-right:.45rem;color:var(--muted)}
.request-progress li[aria-current]{color:var(--accent);font-weight:750;background:var(--blue-light);border-radius:6px;padding:.2rem .45rem}
.request-progress .not-applicable{opacity:.55}
.case-work,.case-intake,.sample-buttons{margin-top:1rem}
.button-group{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.55rem}
.origin-badge{display:inline-block;margin-inline-start:.4em;padding:.06em .38em;border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:.72rem;font-weight:500;white-space:nowrap;vertical-align:middle}
.toolbar-controls{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
.toolbar-role{display:flex;align-items:center;gap:.55rem;padding:.45rem .7rem;border-radius:10px;background:#fff;font-size:.88rem}
.role-entry{max-width:64rem;margin:6vh auto 0}
.role-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:1rem;margin-top:1rem}
.role-cards form{margin:0;padding:0;background:#fff;overflow:hidden}
.role-card-button{display:flex;width:100%;height:100%;flex-direction:column;align-items:flex-start;gap:.3rem;padding:1.1rem;text-align:left;border:0;background:transparent}
.role-card-title{font-size:1.16rem;font-weight:750;color:#182638}
.role-card-description{font-size:.9rem;color:var(--muted)}
.role-card-action{margin-top:.35rem;color:var(--accent);font-size:.9rem}
.role-cards h2{margin-bottom:.45rem}
.role-cards p{margin-bottom:1rem}
.role-cards button{margin-top:auto}
.settings{position:relative}
.settings summary{list-style:none;border:1px solid var(--border);border-radius:10px;padding:.45rem .65rem;background:#fff}
.settings summary::-webkit-details-marker{display:none}
.settings-panel{position:absolute;z-index:2;right:0;top:calc(100% + .35rem);width:min(18rem,80vw);padding:1rem;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 20px #18263818}
.settings-panel p,.settings-panel form{margin:0 0 .6rem}
.workspace-footer{margin-top:1.25rem;color:var(--muted);font-size:.85rem}
.workspace-footer p{margin:.35rem 0}
summary{cursor:pointer}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:52rem){
  .workspace{display:block}
  .sidebar{height:auto;z-index:1;padding:.65rem 1rem;border-right:0;border-bottom:1px solid var(--border)}
  .brand{margin:0 0 .55rem}
  .brand-mark{width:2rem;height:2rem;border-radius:9px}
  .sidebar nav{display:flex;gap:.2rem;flex-wrap:wrap;overflow:visible}
  .sidebar a{flex:none;padding:.4rem .6rem;font-size:.88rem}
  main{padding-top:1.25rem}
  .role-entry{margin:1rem auto 0}
  .role-cards{gap:.55rem}
  .role-card-button{padding:.8rem 1rem;gap:.15rem}
  .role-card-action{margin-top:.1rem}
  .summary-cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;margin-bottom:1rem}
  .summary-card{padding:.8rem;border-radius:12px}
  .summary-card strong{font-size:1.35rem}
  .summary-cards:not(.detail-cards) .summary-card:last-child{grid-column:1 / -1}
  .detail-cards .summary-card strong{font-size:.98rem}
  .responsive-requests{border:0;overflow:visible}
  .responsive-requests table,.responsive-requests tbody,.responsive-requests tr,.responsive-requests td{display:block;width:100%;min-width:0}
  .responsive-requests thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  .responsive-requests tr{margin:.65rem 0;padding:.65rem .8rem;border:1px solid var(--border);border-radius:12px}
  .responsive-requests td{display:flex;align-items:baseline;justify-content:space-between;gap:.75rem;padding:.22rem 0;border:0;text-align:right}
  .responsive-requests td::before{content:attr(data-label);color:var(--muted);font-size:.82rem;text-align:left;flex:none}
  .responsive-requests .executive-row{background:var(--blue-light);border-left:4px solid var(--accent)}
  .responsive-requests .executive-row td{background:transparent;box-shadow:none}

}
`;
