import { metadataFields, metadataView } from './audit.mjs';
import { documentSamples, fields } from './condition.mjs';

export function documentView({ data, documents, calls, selectedId, selectedAgency, link, escape, table, role, open, agency, period, time }) {
  const canEdit = open && role === '영업지원팀';
  const canSubmit = open && role === '대리점';
  const samples = canSubmit ? Object.fromEntries(Object.entries(documentSamples(data)).filter(([key]) =>
    agency === (key === 'explanation' ? 'D-024' : 'D-011'))) : {};
  const selected = documents.find(row => String(row.id) === selectedId);
  const action = link({ view: 'documents', ...(selected ? { document: selected.id } : {}) });
  const post = (name, label) => '<button' + (['document_add', 'document_confirm'].includes(name) ? ' class="primary"' : '') +
    ' name="action" value="' + name + '">' + label + '</button>';
  const disabled = canEdit ? '' : ' disabled';
  let html = '<h2>서류 접수 목록</h2><p class="muted">텍스트 입력 또는 .txt 접수만 지원합니다. 통장 사본 등의 이미지·PDF는 받지 않으며, 확인 내용과 별도 자료 위치를 텍스트에 적어 주세요.</p>' + (canSubmit ?
    '<form method="post" action="' + link({ view: 'documents' }) + '"><fieldset' +
    '><legend>서류 접수</legend><label>거래처 <select name="agency">' +
    data.agencies.filter(row => row.agency_id === agency).map(row => '<option' + (row.agency_id === (selected?.agency_id ?? selectedAgency) ? ' selected' : '') +
      '>' + escape(row.agency_id) + '</option>').join('') +
    '</select></label> <label>.txt <input type="file" id="text-file" accept=".txt,text/plain"></label>' +
    '<div class="sample-buttons"><strong>추가 시나리오 자료</strong><div class="button-group">' +
    Object.entries(samples).map(([id, [name]]) =>
      '<button type="button" data-sample="' + id + '">' + name + '</button>').join(' ') + '</div></div>' +
    '<p><label>서류 내용 <textarea id="document-text" name="text" maxlength="6000" required></textarea></label></p>' +
    metadataFields(period, escape) + post('document_add', '접수') + '</fieldset></form>' +
    '<script>const sampleText=' + JSON.stringify(Object.fromEntries(Object.entries(samples).map(([id, [, text]]) => [id, text]))).replace(/</g, '\\u003c') +
    ';const original=document.getElementById("document-text");' +
    'for(const button of document.querySelectorAll("[data-sample]"))button.onclick=()=>{const sample=button.dataset.sample;original.value=sampleText[sample];button.form.elements.source.value="scenario";button.form.elements.agency.value=sample==="explanation"?"D-024":"D-011";};' +
    'document.getElementById("text-file").onchange=async(e)=>{const f=e.target.files[0];if(f&&/\\.txt$/i.test(f.name)&&f.size<=24000)original.value=(await f.text()).slice(0,6000);};</script>' : '') +
    table(['접수 번호', '거래처', '상태'], documents.map(row => [
      '<a href="' + link({ view: 'documents', document: row.id }) + '">' + escape(row.id) + '</a>',
      escape(row.agency_id), row.applied ? '변경 적용' : row.confirmed ? '담당자 확인' : '접수',
    ]));
  if (!selected) return html;
  html += '<p>' + metadataView(selected.metadata, escape) + ' · 기록 시각 ' + (selected.received_at ? time(selected.received_at) : '기존 기록 · 미확인') + '</p>';
  if (role === '대리점') return html + '<h3>접수 ' + escape(selected.id) + '</h3><pre>' + escape(selected.original) + '</pre>';
  const latest = calls.filter(row => row.document_id === selected.id && row.kind === 'extract').at(-1);
  const status = latest ? latest.finished_at ? latest.result ? 'AI 추출 완료 · 후보' : 'AI 추출 실패, 직접 입력'
    : 'AI 추출 요청 중 · 직접 입력 가능' : '추출 전 · 직접 입력 가능';
  html += '<section class="document-review" id="document-confirmation"><h3>접수 ' +
    escape(selected.id) + ' · ' + escape(selected.agency_id) + '</h3><p>' + status + '</p>' +
    '<form method="post" action="' + action + '" data-ai="extract"><fieldset' + disabled + '>' +
    post('document_extract', 'AI 추출') + ' ' +
    (Object.values(documentSamples(data)).some(([, text]) => text === selected.original)
      ? post('document_timeout', '시간 초과 확인') : '') + '</fieldset></form>' +
    '<form method="post" action="' + action + '"><fieldset' + (canEdit && !selected.applied ? '' : ' disabled') +
    '><legend>담당자 확인</legend>' +
    table(['서류 내용', '추출 후보 · 줄 번호', '확인 값'], [[
      '<pre>' + escape(selected.original) + '</pre>',
      Object.entries(fields).map(([key, label]) => {
        const result = latest?.result?.[key];
        return '<p>' + label + ' · ' + (result?.needsReview !== false ? '확인 필요' : '후보 1개') +
          '<br>' + (result?.candidates.map(candidate => escape(candidate.value) + ' · ' + candidate.lines.join(', ') + '행').join('<br>') ?? '') + '</p>';
      }).join(''),
      Object.entries(fields).map(([key, label]) => {
        const result = latest?.result?.[key];
        const confirmed = selected.confirmed?.[key];
        const value = confirmed ? confirmed.value ?? '' : result?.needsReview === false ? result.candidates[0].value : '';
        const labels = { reject: '반려/미확인', accept: '수락', edit: '수정/직접 입력' };
        return '<p><label>' + label + ' <input name="' + key + '" value="' + escape(value) + '" maxlength="200"></label> ' +
          '<select aria-label="' + label + ' 판정" name="' + key + '_decision">' +
          Object.entries(labels).map(([key, value]) => '<option value="' + key + '"' +
            (confirmed?.decision === key ? ' selected' : '') + '>' + value + '</option>').join('') + '</select>' +
          (confirmed ? ' · 저장: ' + labels[confirmed.decision] : '') + '</p>';
      }).join(''),
    ]]) + '<label>확인 근거 <input name="reason" maxlength="1000" required></label> ' +
    post('document_confirm', '확인 저장') + '</fieldset></form>';
  if (selected.confirmed && !selected.applied && canEdit) {
    html += '<form method="post" action="' + action + '">' +
      metadataFields(period, escape) + post('group_confirm', '관련자 그룹 확인') +
      (selected.confirmed.bank_account_no?.value ? ' ' + post('account_apply', '확인된 계좌 변경 적용') : '') + '</form>';
  }
  return html + '</section>';
}

export function aiLog(calls, escape, table, time) {
  const labels = { draft: '소명 요청서 초안', extract: '서류 추출', summary: '승인 근거 요약' };
  return '<h2>AI 요청·응답 기록</h2>' + table(['호출 시각 (한국)', '정산월', '용도', '결과', '실패 사유', '상세'],
    [...calls].reverse().map(row => [
      time(row.created_at), escape(row.period), escape(labels[row.kind] ?? row.kind),
      row.finished_at ? row.result ? '성공' : '실패' : '처리 중',
      row.finished_at && !row.result ? escape(row.raw?.error ?? '응답을 처리할 수 없습니다.') : '—',
      '<details><summary>요청·응답 보기</summary><h3>전송 내용</h3><pre>' +
        escape(JSON.stringify(row.request, null, 2)) + '</pre><h3>응답</h3><pre>' +
        escape(JSON.stringify(row.raw, null, 2)) + '</pre></details>',
    ]));
}

export function reviewView(records, { escape, table, source, money, link }) {
  return '<h2 id="historical-review">재검토 대상 목록</h2><p>변경 전후 연결 거래처의 이번 달 지급 검토 건과 올해 이전 승인 건을 확인합니다.</p>' +
    records.map(record => {
      const scope = record.details.scope;
      const heading = record.kind === 'change' ? '계좌 변경 적용' : '관련자 그룹 확인';
      const requests = (items, title) => '<h4>' + title + '</h4>' +
        table(['거래처 · 원본', '합계 · 계산', '승인권자 · 계산', '원본 행'], items.map(item =>
          [item.members.map(escape).join(', '), money(item.amount), escape(item.approver), item.sources.map(source).join('<br>')]));
      return '<section id="review-' + escape(record.id) + '"><h3>' + heading + ' · ' + escape(record.agency_id) + '</h3><p>대상 ' +
        scope.agencies.map(escape).join(', ') + ' · 정산월 ' + escape(record.period) + '</p><p>' + metadataView(record.details.metadata, escape) + '</p>' +
        (record.kind === 'change' ? '<p><strong>변경 내용</strong> 정산계좌 끝자리 ' + escape(record.details.beforeAccount?.slice(-4)) + ' → ' + escape(record.details.afterAccount?.slice(-4)) + '</p>' : '') +
        (scope.retained.length ? '<p><strong>실제 승인 경로 · 기존 임원 경로 유지' +
          (record.resolved ? ' · 재검토 승인' : ' · 재검토 중') + '</strong></p><p>동일 입금계좌 기록 ' +
          scope.retained.map(row => escape(row.agencyId) + ' · ' + source(row.source)).join('<br>') + '</p>'
          : '<p>실제 승인 경로 · 현재 등록 정보의 승인권자 기준</p>') +
        '<h4>이번 달 처리 · ' + (record.resolved ? '임원 재검토 승인 후 회계 증빙 확인' : '영업지원팀 소명 확인 후 임원 재검토') + '</h4><p><a href="' +
        link({ view: 'requests', group: scope.before[0]?.id }) + '">연결된 승인 요청</a></p>' +
        '<details class="evidence"><summary>등록정보 기준 재계산 비교</summary>' + requests(scope.before, '변경 전 등록 정보') + requests(scope.after, '변경 후 등록 정보') + '</details>' +
        '<details class="evidence"><summary>이전 정산월 사후 검토 · 이미 지급된 건은 되돌리지 않음</summary>' + table(['정산월 · 원본', '거래처 · 원본', '장려금 · 원본', '지급일 · 원본', '검토 상태', '원본 행'],
          scope.history.map(row => [escape(row.period), escape(row.agency), money(Number(row.amount)),
            escape(row.date), row.paid ? '사후 검토 대상' : '재검토 필요', source(row.source)])) + '</details></section>';
    }).join('');
}
