import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const files = {
  agencies: '01_corevia/master/m_agency_cv.csv',
  rebates: '01_corevia/sales/sales_rebate_payment_cv.csv',
  collections: '01_corevia/financials/fin_collection_history_cv.csv',
};
const fields = ['representative_name', 'address', 'bank_account_no'];
const limit = 2_000_000;

export async function readW07Data(sourceDirectory) {
  const entries = await Promise.all(Object.entries(files).map(async ([key, file]) => {
    const text = await readFile(join(sourceDirectory, file), 'utf8');
    const [header, ...lines] = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const columns = header.split('|');
    const rows = lines.flatMap((line, index) => {
      if (!line.trim()) return [];
      const values = line.split('|');
      const source = { file, row: index + 2 };
      if (values.length !== columns.length) {
        throw new Error(`Invalid CSV row: ${file}:${source.row}`);
      }
      return [{ ...Object.fromEntries(columns.map((column, i) => [column, values[i]])), source }];
    });
    return [key, rows];
  }));
  return Object.fromEntries(entries);
}

function present(value) {
  const normalized = value?.trim();
  return normalized && normalized !== 'NONE' ? normalized : undefined;
}

export function calculateW07({ agencies, rebates, collections }) {
  const agencyById = new Map(agencies.map(agency => [agency.agency_id, agency]));
  if (agencyById.size !== agencies.length) throw new Error('Duplicate agency ID');

  const ids = [...agencyById.keys()].sort();
  const parents = new Map(ids.map(id => [id, id]));
  function find(id) {
    while (parents.get(id) !== id) id = parents.get(id);
    return id;
  }

  const links = [];
  for (const [index, id] of ids.entries()) {
    const left = agencyById.get(id);
    for (const otherId of ids.slice(index + 1)) {
      const right = agencyById.get(otherId);
      const matchedFields = fields.filter(field => {
        const value = present(left[field]);
        return value !== undefined && value === present(right[field]);
      });
      if (matchedFields.length < 2) continue;
      const [firstRoot, secondRoot] = [find(id), find(otherId)].sort();
      parents.set(secondRoot, firstRoot);
      links.push({ agencyIds: [id, otherId], matchedFields, sources: [left.source, right.source] });
    }
  }

  const groups = new Map();
  for (const id of ids) {
    const groupId = find(id);
    if (!groups.has(groupId)) groups.set(groupId, { groupId, members: [], links: [] });
    groups.get(groupId).members.push({ agencyId: id, source: agencyById.get(id).source });
  }
  for (const link of links) groups.get(find(link.agencyIds[0])).links.push(link);

  const accounts = new Map();
  for (const agency of agencies) {
    const account = present(agency.bank_account_no);
    if (!account) continue;
    if (!accounts.has(account)) accounts.set(account, { registered: [], deposits: [] });
    accounts.get(account).registered.push({ agencyId: agency.agency_id, source: agency.source });
  }
  for (const row of collections) {
    const account = present(row.bank_account_no);
    if (!account) continue;
    if (!accounts.has(account)) accounts.set(account, { registered: [], deposits: [] });
    accounts.get(account).deposits.push({
      agencyId: row.agency_id,
      depositId: row.deposit_id,
      depositDate: row.deposit_date,
      source: row.source,
    });
  }
  const collectionEvidence = [];
  for (const [account, evidence] of accounts) {
    const depositAgencies = new Set(evidence.deposits.map(row => row.agencyId));
    const sharedDeposits = depositAgencies.size > 1;
    const crossAgencyRegistration = evidence.deposits.some(deposit =>
      evidence.registered.some(row => row.agencyId !== deposit.agencyId));
    if (sharedDeposits || crossAgencyRegistration) {
      collectionEvidence.push({ account, sharedDeposits, crossAgencyRegistration, ...evidence });
    }
  }

  const requests = new Map();
  for (const row of rebates) {
    if (!agencyById.has(row.agency_id)) {
      throw new Error(`Unknown agency at ${row.source.file}:${row.source.row}`);
    }
    const amount = Number(row.rebate_amount_krw);
    if (!/^-?\d+$/.test(row.rebate_amount_krw) || !Number.isSafeInteger(amount)) {
      throw new Error(`Invalid rebate amount at ${row.source.file}:${row.source.row}`);
    }
    const group = groups.get(find(row.agency_id));
    const key = JSON.stringify([row.period_ym, group.groupId]);
    if (!requests.has(key)) {
      requests.set(key, { period: row.period_ym, group, totalKrw: 0, rebateRows: [] });
    }
    const request = requests.get(key);
    request.totalKrw += amount;
    if (!Number.isSafeInteger(request.totalKrw)) throw new Error('Rebate total exceeds integer range');
    request.rebateRows.push({ rebateId: row.rebate_id, agencyId: row.agency_id, amountKrw: amount, source: row.source });
  }

  return {
    groups: [...groups.values()],
    collectionEvidence,
    requests: [...requests.values()].map(request => {
      const exceedsLimit = request.totalKrw > limit;
      const memberIds = new Set(request.group.members.map(member => member.agencyId));
      return {
        ...request,
        limitKrw: limit,
        exceedsLimit,
        approver: exceedsLimit ? '영업임원' : '영업지원팀',
        collectionEvidence: collectionEvidence.filter(evidence =>
          [...evidence.registered, ...evidence.deposits].some(row => memberIds.has(row.agencyId))),
      };
    }),
  };
}
