const badgeTypes = [
  ['재검토 필요', 'review'],
  ['확인 대기', 'check'],
  ['보류', 'hold'],
  ['승인 대기', 'pending'],
  ['승인', 'approved'],
];

export function statusBadge(label) {
  const type = badgeTypes.find(([status]) => label.includes(status))?.[1] ?? 'neutral';
  return '<span class="status-badge status-' + type + '">' + label + '</span>';
}

export const workspaceStyles = `
:root{color-scheme:light;--accent:#2054bd;--border:#dce3eb;--muted:#546375;--paper:#fff}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:#f4f6f9;color:#182638;font:16px/1.55 Inter,"Malgun Gothic",system-ui,sans-serif}
.workspace{display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:1.75rem 1rem;background:var(--paper);border-right:1px solid var(--border)}
.brand{font-size:1.05rem;font-weight:750;margin:0 .65rem 1.75rem}
.sidebar nav{display:grid;gap:.3rem}
.sidebar a{display:block;padding:.65rem .75rem;border-radius:6px;color:#35455a;text-decoration:none;font-weight:600}
.sidebar a:hover{background:#f0f4fa}
.sidebar a[aria-current=page]{background:#e8efff;color:var(--accent)}
main{width:100%;max-width:88rem;margin:0 auto;padding:2.25rem clamp(1rem,3vw,3rem) 3rem}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.35rem}
h1{margin:0;font-size:1.75rem;line-height:1.25}
h2{margin:0 0 1.1rem;font-size:1.3rem}
h2 small{font-size:.9rem;color:var(--muted);margin-left:.35rem}
h3{font-size:1.08rem;margin:1.5rem 0 .6rem}
h4{margin:1rem 0 .5rem}
.content{background:var(--paper);border:1px solid var(--border);border-radius:10px;padding:clamp(1rem,2.3vw,1.65rem)}
.content section+section{margin-top:2rem}
.filters{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin:0}
.filters label{font-size:.9rem;color:var(--muted);font-weight:600}
form{margin:1rem 0}
button,select,textarea,input{font:inherit}
button,select,input:not([type=file]),textarea{border:1px solid #c4cfdd;border-radius:6px;background:#fff;color:inherit;padding:.45rem .65rem}
button{font-weight:600;cursor:pointer}
button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
button.primary{color:#fff;background:var(--accent);border-color:var(--accent)}
button.primary:hover:not(:disabled){color:#fff;background:#19479f}
button:disabled,fieldset:disabled button{cursor:default;opacity:.6}
textarea{vertical-align:middle;width:min(100%,34rem)}
fieldset{min-width:0;border:1px solid var(--border);border-radius:6px}
a{color:var(--accent);text-underline-offset:.15em}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.table-scroll{overflow-x:auto;margin:.8rem 0 1.25rem;border:1px solid var(--border);border-radius:7px}
table{border-collapse:collapse;width:100%;min-width:34rem;overflow-wrap:anywhere;font-size:.94rem}
th,td{text-align:left;padding:.85rem 1rem;border-bottom:1px solid var(--border);vertical-align:top}
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
.reset{margin-top:1.5rem;color:var(--muted);font-size:.9rem}
summary{cursor:pointer}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:52rem){
  .workspace{display:block}
  .sidebar{height:auto;z-index:1;padding:.65rem 1rem;border-right:0;border-bottom:1px solid var(--border)}
  .brand{margin:0 0 .35rem}
  .sidebar nav{display:flex;gap:.25rem;overflow:auto}
  .sidebar a{flex:none;padding:.4rem .6rem;font-size:.88rem}
  main{padding-top:1.25rem}
}
`;
