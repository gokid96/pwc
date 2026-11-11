import { fields, samples } from './condition.mjs';
import { originBadge } from './workspace-view.mjs';

export function documentView({ data, documents, calls, selectedId, selectedAgency, link, escape, table, role }) {
  const canEdit = role === '영업지원팀';
  const selected = documents.find(row => row.id === selectedId);
  const action = link({ view: 'documents', ...(selected ? { document: selected.id } : {}) });
  const post = (name, label) => '<button name="action" value="' + name + '">' + label + '</button>';
  const disabled = canEdit ? '' : ' disabled';
  let html = '<h2>서류 접수 목록</h2>' +
    '<form method="post" action="' + link({ view: 'documents' }) + '"><fieldset' + disabled +
    '><legend>서류 접수</legend><label>거래처 <select name="agency">' +
    data.agencies.map(row => '<option' + (row.agency_id === (selected?.agency_id ?? selectedAgency) ? ' selected' : '') +
      '>' + escape(row.agency_id) + '</option>').join('') +
    '</select></label> <label>.txt <input type="file" id="text-file" accept=".txt,text/plain"></label>' +
    '<div class="sample-buttons">' + Object.entries(samples).map(([id, [name]]) =>
      '<button type="button" data-sample="' + id + '">' + name + ' · 추가 자료</button>').join(' ') + '</div>' +
    '<p><label>서류 내용 ' + originBadge('모의') + ' <textarea id="document-text" name="text" maxlength="6000" required></textarea></label></p>' +
    post('document_add', '접수') + '</fieldset></form>' +
    '<script>const sampleText=' + JSON.stringify(Object.fromEntries(Object.entries(samples).map(([id, [, text]]) => [id, text]))) +
    ';const original=document.getElementById("document-text");' +
    'for(const button of document.querySelectorAll("[data-sample]"))button.onclick=()=>{const sample=button.dataset.sample;original.value=sampleText[sample];button.form.elements.agency.value=sample==="explanation"?"D-024":"D-011";};' +
    'document.getElementById("text-file").onchange=async(e)=>{const f=e.target.files[0];if(f&&/\\.txt$/i.test(f.name)&&f.size<=24000)original.value=(await f.text()).slice(0,6000);};</script>' +
    table(['접수 번호', '거래처', '상태'], documents.map(row => [
      '<a href="' + link({ view: 'documents', document: row.id }) + '">' + escape(row.id) + '</a>',
      escape(row.agency_id), row.applied ? '변경 적용' : row.confirmed ? '담당자 확인' : '접수',
    ]));
  if (!selected) return html;
  const latest = calls.filter(row => row.document_id === selected.id && row.kind === 'extract').at(-1);
  const status = latest ? latest.finished_at ? latest.result ? 'AI 추출 완료 · 후보' : 'AI 추출 실패, 직접 입력'
    : 'AI 추출 요청 중 · 직접 입력 가능' : '추출 전 · 직접 입력 가능';
  html += '<h3>접수 ' + escape(selected.id) + ' · ' + escape(selected.agency_id) + '</h3><p>' + status + '</p>' +
    '<form method="post" action="' + action + '" data-ai><fieldset' + disabled + '>' +
    post('document_extract', 'AI 추출') + ' ' +
    (Object.values(samples).some(([, text]) => text === selected.original)
      ? post('document_timeout', '시간 초과 확인' + originBadge('모의')) : '') + '</fieldset></form>' +
    '<form method="post" action="' + action + '"><fieldset' + (canEdit && !selected.applied ? '' : ' disabled') +
    '><legend>담당자 확인</legend>' +
    table(['서류 내용', '추출 후보 · 줄 번호', '확인 값'], [[
      originBadge('모의') + '<pre>' + escape(selected.original) + '</pre>',
      Object.entries(fields).map(([key, label]) => {
        const result = latest?.result?.[key];
        return '<p>' + label + ' · ' + (result?.needsReview !== false ? '확인 필요' : '후보 1개') +
          '<br>' + (result?.candidates.map(candidate => escape(candidate.value) + ' · ' + candidate.lines.join(', ') + '행').join('<br>') ?? '') + '</p>';
      }).join(''),
      Object.entries(fields).map(([key, label]) => {
        const result = latest?.result?.[key];
        const value = selected.confirmed?.[key]?.value ?? (result?.needsReview === false ? result.candidates[0].value : '');
        return '<p><label>' + label + ' <input name="' + key + '" value="' + escape(value) + '" maxlength="200"></label> ' +
          '<select aria-label="' + label + ' 판정" name="' + key + '_decision"><option value="reject">반려/미확인</option>' +
          '<option value="accept">수락</option><option value="edit">수정/직접 입력</option></select>' +
          (selected.confirmed?.[key] ? ' · 저장: ' + escape(selected.confirmed[key].decision) : '') + '</p>';
      }).join(''),
    ]]) + '<label>확인 근거 <input name="reason" maxlength="1000" required></label> ' +
    post('document_confirm', '확인 저장') + '</fieldset></form>';
  if (selected.confirmed && !selected.applied && canEdit) {
    html += '<form method="post" action="' + action + '">' +
      post('group_confirm', '관련자 그룹 확인') +
      (selected.confirmed.bank_account_no?.value ? ' ' + post('account_apply', '확인된 계좌 변경 적용') : '') + '</form>';
  }
  return html;
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
  return '<h2>재검토 대상 목록</h2><p>변경 전후 연결 거래처의 이번 달 지급 검토 건과 올해 이전 승인 건을 봅니다.' + originBadge('프로젝트 가정') + '</p>' +
    records.map(record => {
      const scope = record.details.scope;
      const heading = record.kind === 'change' ? '계좌 변경 적용' : '관련자 그룹 확인';
      const requests = (items, title) => '<h4>' + title + '</h4>' +
        table(['거래처 · 원본', '합계 · 계산', '승인권자 · 계산', '원본 행'], items.map(item =>
          [item.members.map(escape).join(', '), money(item.amount), escape(item.approver), item.sources.map(source).join('<br>')]));
      return '<section id="review-' + escape(record.id) + '"><h3>' + heading + ' · ' + escape(record.agency_id) + '</h3><p>대상 ' +
        scope.agencies.map(escape).join(', ') + ' · 정산월 ' + escape(record.period) + '</p>' +
        requests(scope.before, '변경 전 등록 정보') + requests(scope.after, '변경 후 등록 정보') +
        (scope.retained.length ? '<p><strong>실제 승인 경로 · 기존 임원 경로 유지 · 소명 대기</strong></p><p>동일 입금계좌 기록 ' +
          scope.retained.map(row => escape(row.agencyId) + ' · ' + source(row.source)).join('<br>') + '</p>'
          : '<p>실제 승인 경로 · 현재 등록 정보의 승인권자 기준</p>') +
        '<h4>선택한 월 지급 검토 · 재검토 필요</h4><p><a href="' +
        link({}) + '">승인 요청 목록</a> · <a href="' + link({ view: 'accounting' }) +
        '">회계 작업 목록</a></p>' +
        '<h4>이전 정산월 승인 건</h4>' + table(['정산월 · 원본', '거래처 · 원본', '장려금 · 원본', '지급일 · 원본', '검토 상태', '원본 행'],
          scope.history.map(row => [escape(row.period), escape(row.agency), money(Number(row.amount)),
            escape(row.date), row.paid ? '사후 검토 대상' : '재검토 필요', source(row.source)])) + '</section>';
    }).join('');
}
