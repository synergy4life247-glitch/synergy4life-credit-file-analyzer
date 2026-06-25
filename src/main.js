const BUREAUS = ['TransUnion', 'Experian', 'Equifax'];
const SUMMARY_FIELDS = [
  ['totalAccounts', ['Total Accounts', 'Accounts']],
  ['openAccounts', ['Open Accounts', 'Open']],
  ['closedAccounts', ['Closed Accounts', 'Closed']],
  ['delinquentAccounts', ['Delinquent Accounts', 'Delinquent']],
  ['derogatoryAccounts', ['Derogatory Accounts', 'Derogatory']],
  ['collections', ['Collections', 'Collection Accounts', 'Collection']],
  ['balances', ['Balances', 'Total Balance', 'Balance']],
  ['payments', ['Payments', 'Monthly Payments', 'Payment']],
  ['publicRecords', ['Public Records', 'Public Information']],
  ['inquiries', ['Inquiries', 'Credit Inquiries', 'Inquiries(2 years)']]
];
const REPORT_LABELS = new Set([
  'credit score','personal information','consumer statement','account summary','account history','inquiries','public information','creditor contacts',
  'account #','high balance','last verified','date of last activity','date reported','date opened','balance owed','closed date','account rating',
  'account description','dispute status','creditor type','account status','payment status','payment amount','last payment','term length','past due amount',
  'account type','payment frequency','credit limit','two-year payment history','days late - 7 year history','back to top','unknown','ok','current',
  '30','60','90','120','150','pp','rf','co','transunion','experian','equifax','type','status','date filed/reported','reference#','closing date',
  'asset amount','court','liability','exempt amount','remarks','creditor name','address','phone number','name','also known as','former','date of birth',
  'current address','previous address(es)','employers','vantage score® 3.0','vantage score 3.0','original creditor','original creditor:',
  'bank credit cards','other collection agencies','loan company','finance company','credit card','medical/health care','utility company'
]);
const ACCOUNT_TYPES = ['Installment', 'Revolving', 'Collection', 'Open Account', 'Mortgage', 'Auto Loan', 'Student Loan'];
const emptyAnalysis = () => ({
  clientProfile: { provider: 'Unknown', clientName: '', reportDate: '' },
  scores: { TransUnion: '', Experian: '', Equifax: '' },
  accountSummary: { totalAccounts: '', openAccounts: '', closedAccounts: '', delinquentAccounts: '', derogatoryAccounts: '', collections: '', balances: '', payments: '', publicRecords: '', inquiries: '' },
  tradelines: [], negativeItems: [], positiveItems: [], collections: [], derogatoryItems: [], bureauDifferences: [], rebuildNeeds: []
});
let rawText = ''; let analysis = emptyAnalysis(); let approvedAnalysis = null; let approved = false;
const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').replace(/^[|:;,-]+|[|:;,-]+$/g, '').trim();
const linesOf = (text) => String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
const escapeReg = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const moneyOrNumber = (value) => String(value || '').match(/\$?\d[\d,]*(?:\.\d{2})?|\b\d+\b/g) || [];
const formatBureauValues = (values) => values.length >= 3 ? `TU ${values[0]} | EX ${values[1]} | EQ ${values[2]}` : (values[0] || '');
const labelText = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
function detectProvider(text) {
  if (/identity\s*iq|identityiq/i.test(text)) return 'IdentityIQ';
  if (/credit\s*hero/i.test(text)) return 'Credit Hero';
  if (/smart\s*credit|smartcredit/i.test(text)) return 'SmartCredit';
  if (/Quick Links\s*:\s*Credit Score|Vantage Score|Account Summary[\s\S]*Account History/i.test(text)) return 'IdentityIQ';
  return 'Unknown';
}
function getSection(text, title, nextTitles = []) {
  const start = text.search(new RegExp(`(^|\\n)\\s*${escapeReg(title)}\\s*($|\\n)`, 'i'));
  if (start < 0) return '';
  const tail = text.slice(start);
  let end = tail.length;
  for (const next of nextTitles) {
    const idx = tail.slice(1).search(new RegExp(`(^|\\n)\\s*${escapeReg(next)}\\s*($|\\n)`, 'i'));
    if (idx >= 0) end = Math.min(end, idx + 1);
  }
  return tail.slice(0, end).trim();
}
function valueAfterLabel(text, labels) {
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) {
    for (const label of labels) {
      const re = new RegExp(`^${escapeReg(label)}\\s*[:#-]?\\s*(.*)$`, 'i');
      const hit = lines[i].match(re);
      if (!hit) continue;
      const inline = clean(hit[1]);
      if (inline && !REPORT_LABELS.has(inline.toLowerCase())) return inline;
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const next = clean(lines[j]);
        if (next && !REPORT_LABELS.has(next.toLowerCase())) return next;
      }
    }
  }
  return '';
}
function summaryValue(summary, labels) {
  const lines = linesOf(summary);
  const allLabels = SUMMARY_FIELDS.flatMap(([, vals]) => vals.map(v => v.toLowerCase()));
  for (let i = 0; i < lines.length; i++) {
    for (const label of labels) {
      const re = new RegExp(`^${escapeReg(label)}(?:\\s|:|$)(.*)$`, 'i');
      const hit = lines[i].match(re);
      if (!hit) continue;
      let values = moneyOrNumber(hit[1]);
      if (!values.length) {
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          const lower = lines[j].toLowerCase();
          if (allLabels.includes(lower)) break;
          values.push(...moneyOrNumber(lines[j]));
          if (values.length >= 3) break;
        }
      }
      if (values.length) return formatBureauValues(values.slice(0, 3));
    }
  }
  return '';
}
function parseScores(text) {
  const scores = { TransUnion: '', Experian: '', Equifax: '' };
  const scoreSection = getSection(text, 'Credit Score', ['Personal Information', 'Account Summary', 'Account History']);
  BUREAUS.forEach((bureau) => {
    const short = bureau === 'TransUnion' ? 'TU' : bureau === 'Experian' ? 'EX' : 'EQ';
    const match = (scoreSection || text).match(new RegExp(`(?:${bureau}|${short})\\s*[:#-]?\\s*([3-8]\\d{2})`, 'i'));
    if (match) scores[bureau] = match[1];
  });
  const numbers = (scoreSection || '').match(/\b[3-8]\d{2}\b/g) || [];
  BUREAUS.forEach((bureau, index) => { if (!scores[bureau] && numbers[index]) scores[bureau] = numbers[index]; });
  return scores;
}
function isAccountType(line) { return ACCOUNT_TYPES.some((type) => new RegExp(`^${escapeReg(type)}$`, 'i').test(line)); }
function isCreditorCandidate(line) {
  const lower = line.toLowerCase();
  if (!line || REPORT_LABELS.has(lower) || isAccountType(line)) return false;
  if (line.includes(':')) return false;
  if (/^(none reported|back to top|days late|ok\b|co\b|jan-|feb-|mar-|apr-|may-|jun-|jul-|aug-|sep-|oct-|nov-|dec-)/i.test(line)) return false;
  if (/^[\d\s$,.:-]+$/.test(line)) return false;
  if (/\b(accounts?|balances?|payments?|records?|inquiries?|delinquent|derogatory)\b/i.test(line) && /\d/.test(line)) return false;
  return /[A-Za-z0-9]{2,}/.test(line) && line.length <= 90;
}
function nextValueInBlock(block, labels) { return valueAfterLabel(block.join('\n'), labels); }
function findNextAccountType(lines, start) {
  for (let i = start; i < lines.length; i++) if (isAccountType(lines[i])) return i;
  return lines.length;
}
function parseTradelines(text) {
  const accountHistory = getSection(text, 'Account History', ['Inquiries', 'Public Information', 'Creditor Contacts']);
  if (!accountHistory) return [];
  const lines = linesOf(accountHistory).filter(line => !/^Account History$/i.test(line));
  const accounts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isAccountType(lines[i])) continue;
    const type = lines[i];
    const nextTypeIndex = findNextAccountType(lines, i + 1);
    const block = lines.slice(i, nextTypeIndex);
    const creditor = block.slice(1).find(isCreditorCandidate) || '';
    if (!creditor) { i = nextTypeIndex - 1; continue; }
    const joined = block.join('\n');
    const paymentStatus = nextValueInBlock(block, ['Payment Status']);
    const accountStatus = nextValueInBlock(block, ['Account Status']);
    const rating = nextValueInBlock(block, ['Account Rating']);
    const balance = nextValueInBlock(block, ['Balance Owed', 'Current Balance', 'Balance', 'High Balance']);
    const bureaus = BUREAUS.filter((b) => new RegExp(b, 'i').test(joined)).join(', ');
    accounts.push({
      id: accounts.length + 1,
      creditor,
      type,
      status: clean(paymentStatus || accountStatus || rating || type),
      balance,
      bureaus,
      raw: joined
    });
    i = nextTypeIndex - 1;
  }
  return accounts;
}
function parseReport(text) {
  const provider = detectProvider(text);
  const personal = getSection(text, 'Personal Information', ['Consumer Statement', 'Account Summary', 'Account History']);
  const summary = getSection(text, 'Account Summary', ['Account History', 'Inquiries', 'Public Information']);
  const tradelines = parseTradelines(text);
  const negativeItems = tradelines.filter((t) => /charge.?off|collection|late|derogatory|delinquent|repossession|foreclosure/i.test(`${t.type} ${t.status} ${t.raw}`));
  const positiveItems = tradelines.filter((t) => /current|paid|open/i.test(`${t.status} ${t.raw}`) && !negativeItems.includes(t));
  const accountSummary = {};
  SUMMARY_FIELDS.forEach(([key, labels]) => accountSummary[key] = summary ? summaryValue(summary, labels) : '');
  return {
    clientProfile: { provider, clientName: valueAfterLabel(personal || text, ['Client Name', 'Consumer Name', 'Name']), reportDate: valueAfterLabel(text, ['Credit Report Date', 'Report Date', 'Date Pulled', 'Prepared For Date']) },
    scores: parseScores(text), accountSummary, tradelines, negativeItems, positiveItems,
    collections: negativeItems.filter((item) => /collection/i.test(`${item.type} ${item.status} ${item.raw}`)),
    derogatoryItems: negativeItems.filter((item) => /derogatory|charge.?off|collection|late|delinquent|repossession|foreclosure/i.test(`${item.type} ${item.status} ${item.raw}`)),
    bureauDifferences: tradelines.filter((t) => t.bureaus && t.bureaus.split(',').length < 3).map((t) => `${t.creditor}: appears to vary by bureau (${t.bureaus || 'bureau not specified'}).`),
    rebuildNeeds: []
  };
}
const firstValue = (value) => clean(String(value || '').split('|')[0].replace(/^(TU|EX|EQ)\s*/i, ''));
const parsedCount = (value) => {
  const numbers = moneyOrNumber(value);
  return numbers.length ? numbers[0] : '';
};
const displayValue = (value, fallback = 'Not verified') => clean(value) || fallback;
const formatMoney = (value) => displayValue(value);
const scoreValue = (data, bureau) => displayValue(data.scores[bureau]);
const itemText = (item) => `${item.creditor || ''} ${item.type || ''} ${item.status || ''} ${item.raw || ''}`;
const isVerifiedItem = (item) => Boolean(clean(item?.creditor) || clean(item?.type) || clean(item?.balance) || clean(item?.status) || clean(item?.raw));
const isCollection = (item) => /collection/i.test(itemText(item));
const isChargeOff = (item) => /charge.?off|\bco\b/i.test(itemText(item));
const hasRecentLate = (item) => /late payment|\b(?:30|60|90)\s*(?:days?\s*)?late\b|past due|delinquent|days late/i.test(itemText(item));
const hasHighUtilization = (item) => /utilization|over limit|maxed|high\s*(?:balance|utilization)|credit\s*limit/i.test(`${item.status} ${item.raw || ''}`);
const verifiedCount = (value) => {
  const count = Number(parsedCount(value));
  return Number.isFinite(count) && count > 0;
};
const hasPublicRecords = (data) => verifiedCount(data.accountSummary.publicRecords);
const hasInquiries = (data) => verifiedCount(data.accountSummary.inquiries);
const hasThinFile = (data) => data.tradelines.length > 0 && data.positiveItems.length < 2;

function cloneData(source) {
  return typeof structuredClone === 'function' ? structuredClone(source) : JSON.parse(JSON.stringify(source));
}
function ensureList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' ? clean(item) : isVerifiedItem(item)) : [];
}
function uniqueItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = clean(`${item.creditor}|${item.type}|${item.balance}|${item.status}|${item.raw}` || JSON.stringify(item)).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function classifyNegative(item) {
  return /charge.?off|collection|late|derogatory|delinquent|repossession|foreclosure|past due|\b(?:30|60|90|120)\b/i.test(itemText(item));
}
function classifyPositive(item) {
  return /current|paid|open|never late|pays as agreed/i.test(itemText(item)) && !classifyNegative(item);
}
function buildApprovedAnalysis(current) {
  const source = cloneData(current || emptyAnalysis());
  const tradelines = ensureList(source.tradelines);
  const manualPositive = ensureList(source.positiveItems);
  const manualNegative = ensureList(source.negativeItems);
  const derivedNegative = tradelines.filter(classifyNegative);
  const derivedPositive = tradelines.filter(classifyPositive);
  const negativeItems = uniqueItems([...manualNegative, ...derivedNegative]);
  const positiveItems = uniqueItems([...manualPositive, ...derivedPositive]);
  const collections = uniqueItems([...ensureList(source.collections), ...negativeItems.filter(isCollection), ...tradelines.filter(isCollection)]);
  const derogatoryItems = uniqueItems([...ensureList(source.derogatoryItems), ...negativeItems.filter(classifyNegative), ...tradelines.filter(classifyNegative)]);
  return {
    clientProfile: { ...emptyAnalysis().clientProfile, ...(source.clientProfile || {}) },
    scores: { ...emptyAnalysis().scores, ...(source.scores || {}) },
    accountSummary: { ...emptyAnalysis().accountSummary, ...(source.accountSummary || {}) },
    tradelines,
    positiveItems,
    negativeItems,
    collections,
    derogatoryItems,
    bureauDifferences: ensureList(source.bureauDifferences),
    rebuildNeeds: ensureList(source.rebuildNeeds)
  };
}

function attackAngles(item) {
  const base = isCollection(item)
    ? ['Verify ownership.', 'Verify original creditor.', 'Verify balance.', 'Verify dates.', 'Verify collection authority.', 'Verify account status.', 'Verify bureau-level reporting accuracy.']
    : ['Verify account ownership.', 'Verify balance and past-due amount.', 'Verify date opened, date reported, and last activity.', 'Verify account status and payment status.', 'Verify bureau-level reporting accuracy.'];
  return base;
}
function whyItHurts(item) {
  if (isCollection(item)) return 'Collection reporting can suppress scores and trigger lender conditions until ownership, balance, dates, authority, and reporting accuracy are verified.';
  if (isChargeOff(item)) return 'Charge-off reporting signals severe delinquency and can weigh heavily on payment history and lender risk review.';
  if (hasRecentLate(item)) return 'Late-payment reporting directly affects payment history and can be a major recent score blocker.';
  return 'This negative tradeline may be hurting payment history, derogatory status, utilization, or lender approval review.';
}
function disputePriority(item) {
  const collection = isCollection(item);
  const chargeOff = isChargeOff(item);
  if (collection && chargeOff) return 'High — collection / charge-off reporting accuracy review.';
  if (collection) return 'High — collection validation and bureau reporting review.';
  if (chargeOff) return 'High — charge-off status, balance, and date accuracy review.';
  if (hasRecentLate(item)) return 'High — recent late-payment accuracy review.';
  return 'Medium — factual tradeline accuracy review.';
}
function scoreBlockerRanking(data) {
  const ranked = [];
  const negativeItems = data.negativeItems || [];
  const tradelines = data.tradelines || [];
  const recentLates = negativeItems.filter(hasRecentLate);
  if (recentLates.length) ranked.push({ title: 'Recent late payments', detail: `${recentLates.length} verified negative item(s) show late-payment or delinquency language.` });
  const collections = uniqueItems([...(data.collections || []), ...negativeItems.filter(isCollection), ...tradelines.filter(isCollection)]);
  const summaryCollections = firstValue(data.accountSummary.collections);
  if (collections.length || verifiedCount(data.accountSummary.collections)) ranked.push({ title: 'Collections', detail: collections.length ? `${collections.length} collection tradeline(s) verified.` : `Summary reports collections: ${summaryCollections}.` });
  const chargeOffs = negativeItems.filter(isChargeOff);
  if (chargeOffs.length) ranked.push({ title: 'Charge-offs', detail: `${chargeOffs.length} charge-off item(s) verified.` });
  const derogatoryItems = uniqueItems([...(data.derogatoryItems || []), ...negativeItems.filter(classifyNegative)]);
  if (derogatoryItems.length && !recentLates.length && !collections.length && !chargeOffs.length) ranked.push({ title: 'Derogatory reporting', detail: `${derogatoryItems.length} verified derogatory item(s) need factual review.` });
  if (negativeItems.length && !recentLates.length && !collections.length && !chargeOffs.length && !derogatoryItems.length) ranked.push({ title: 'Negative tradelines', detail: `${negativeItems.length} verified negative tradeline(s) need factual review.` });
  const highUtil = uniqueItems([...tradelines, ...(data.positiveItems || []), ...negativeItems]).filter(hasHighUtilization);
  if (highUtil.length) ranked.push({ title: 'High utilization', detail: `${highUtil.length} verified tradeline(s) include high-utilization language.` });
  if (hasPublicRecords(data)) ranked.push({ title: 'Public records', detail: `Summary reports public records: ${firstValue(data.accountSummary.publicRecords)}.` });
  if (hasInquiries(data)) ranked.push({ title: 'Inquiries', detail: `Summary reports inquiries: ${firstValue(data.accountSummary.inquiries)}.` });
  if (hasThinFile(data)) ranked.push({ title: 'Thin file / missing positives', detail: `${data.positiveItems.length} positive tradeline(s) verified across ${data.tradelines.length} total tradeline(s).` });
  return ranked;
}
const plural = (count, singular, pluralText = `${singular}s`) => `${count} ${Number(count) === 1 ? singular : pluralText}`;
const rebuildFocus = (data) => {
  const openPositive = data.positiveItems.find((item) => /open|current/i.test(itemText(item))) || data.positiveItems[0];
  const creditor = clean(openPositive?.creditor);
  if (creditor) return `protect your open ${creditor} account and keep revolving utilization low`;
  if (hasThinFile(data)) return 'build and protect positive accounts while keeping revolving utilization low';
  return 'protect positive accounts and keep revolving utilization low';
};
const disputeFocus = (item) => {
  if (!item) return 'confirming the verified file details before any dispute work';
  if (isCollection(item) && isChargeOff(item)) return 'validating the collection reporting, including ownership, original creditor, balance, dates, authority, and bureau-level accuracy';
  if (isCollection(item)) return 'validating the collection reporting, including ownership, original creditor, balance, dates, authority, and bureau-level accuracy';
  if (isChargeOff(item)) return 'reviewing the charge-off status, balance, dates, and bureau-level accuracy';
  if (hasRecentLate(item)) return 'reviewing the recent late-payment reporting for factual accuracy';
  return 'reviewing factual tradeline accuracy across ownership, balances, dates, status, and bureau-level reporting';
};
const verifiedName = (data) => clean(data.clientProfile.clientName);
function makeStrategy(sourceData) {
  const data = cloneData(sourceData);
  const negativeWithPriority = data.negativeItems.map((item) => ({ ...item, whyItHurts: whyItHurts(item), disputePriority: disputePriority(item), attackAngles: attackAngles(item) }));
  const firstNegative = negativeWithPriority[0];
  const approvedCollections = uniqueItems([...(data.collections || []), ...data.negativeItems.filter(isCollection), ...data.tradelines.filter(isCollection)]);
  const approvedDerogatory = uniqueItems([...(data.derogatoryItems || []), ...data.negativeItems.filter(classifyNegative)]);
  const collectionCount = approvedCollections.length || (data.tradelines.length || data.negativeItems.length ? 0 : Number(parsedCount(data.accountSummary.collections)) || 0);
  const derogatoryCount = approvedDerogatory.length || (data.tradelines.length || data.negativeItems.length ? 0 : Number(parsedCount(data.accountSummary.derogatoryAccounts)) || 0);
  const hasApprovedTradelineData = Boolean(data.tradelines.length || data.positiveItems.length || data.negativeItems.length || approvedCollections.length || approvedDerogatory.length);
  const totalTradelineCount = data.tradelines.length || uniqueItems([...data.positiveItems, ...data.negativeItems]).length;
  const displayCount = (count) => hasApprovedTradelineData ? count : 'Not verified';
  const clientCountPhrase = hasApprovedTradelineData
    ? `${plural(data.positiveItems.length, 'positive tradeline')} and ${plural(data.negativeItems.length, 'negative tradeline')}, ${plural(collectionCount || 0, 'collection')} and ${plural(derogatoryCount || 0, 'derogatory item')}`
    : 'Not verified';
  const clientGreeting = verifiedName(data) ? `Hi ${verifiedName(data)},` : 'Hi there,';
  return {
    snapshot: {
      clientName: displayValue(data.clientProfile.clientName),
      provider: displayValue(data.clientProfile.provider),
      reportDate: displayValue(data.clientProfile.reportDate),
      scores: { TU: scoreValue(data, 'TransUnion'), EX: scoreValue(data, 'Experian'), EQ: scoreValue(data, 'Equifax') },
      totalTradelines: displayCount(totalTradelineCount),
      positiveTradelines: displayCount(data.positiveItems.length),
      negativeTradelines: displayCount(data.negativeItems.length),
      collections: collectionCount || 'Not verified',
      derogatory: derogatoryCount || 'Not verified',
      inquiries: parsedCount(data.accountSummary.inquiries) || 'Not verified'
    },
    positiveItems: data.positiveItems.map((item) => ({ ...item, role: 'Protect this account. This helps age, payment history, and positive revolving profile.' })),
    negativeItems: negativeWithPriority,
    scoreBlockers: scoreBlockerRanking(data),
    gamePlan: {
      '30 Days': ['Verify parsed data against the report before sending anything.', 'Send factual disputes for verified negative items only.', 'Protect positive accounts with on-time payments and no unnecessary new debt.', 'Give the client rebuild instructions based on verified positives, negatives, and utilization risk.'],
      '60 Days': ['Review bureau responses and document each result.', 'Compare deleted, verified, updated, or stalled accounts by bureau.', 'Prepare second-round escalation for unresolved factual inaccuracies.'],
      '90 Days': ['Re-pull the report and compare against the approved baseline.', 'Update score blockers using only newly verified data.', 'Complete mortgage/rebuild readiness review.', 'Decide the next dispute or rebuild move.']
    },
    clientUpdateMessage: `${clientGreeting} your credit file review is organized. I verified ${clientCountPhrase}. Our first focus will be ${disputeFocus(firstNegative)}. We’ll also ${rebuildFocus(data)} while we work through the 30/60/90 plan.`
  };
}
const el = (tag, attrs = {}, children = []) => { const node = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => { if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v); }); children.forEach((c) => node.append(c)); return node; };
const copyText = async (text) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = el('textarea');
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
};
const snapshotText = (snap) => [
  'File Snapshot',
  `Client name: ${snap.clientName}`,
  `Provider: ${snap.provider}`,
  `Report date: ${snap.reportDate}`,
  `Scores: TU ${snap.scores.TU} | EX ${snap.scores.EX} | EQ ${snap.scores.EQ}`,
  `Tradelines: ${snap.totalTradelines} total | ${snap.positiveTradelines} positive | ${snap.negativeTradelines} negative`,
  `Collections: ${snap.collections}`,
  `Derogatory: ${snap.derogatory}`,
  `Inquiries: ${snap.inquiries}`
].join('\n');
const itemSummaryText = (items, empty, formatter) => items.length ? items.map(formatter).join('\n') : empty;
const strategySummaryText = (strategy) => [
  snapshotText(strategy.snapshot),
  '',
  'Positive Items',
  itemSummaryText(strategy.positiveItems, 'No positive tradelines verified.', (item, index) => `${index + 1}. ${displayValue(item.creditor, 'Positive account')} — ${displayValue(item.type)} — ${displayValue(item.status)} — Balance: ${formatMoney(item.balance)} — ${item.role}`),
  '',
  'Negative Attack Plan',
  itemSummaryText(strategy.negativeItems, 'No negative tradelines verified.', (item, index) => `${index + 1}. ${displayValue(item.creditor, 'Negative account')} — ${displayValue(item.type)} — ${displayValue(item.status)} — Balance: ${formatMoney(item.balance)}\n   Why it hurts: ${item.whyItHurts}\n   Priority: ${item.disputePriority}\n   Attack angles: ${item.attackAngles.join(' ')}`),
  '',
  'Score Blocker Ranking',
  strategy.scoreBlockers.length ? strategy.scoreBlockers.map((blocker, index) => `${index + 1}. ${blocker.title}: ${blocker.detail}`).join('\n') : 'No score blockers verified.',
  '',
  '30/60/90 Plan',
  Object.entries(strategy.gamePlan).map(([period, steps]) => `${period}\n${steps.map((step) => `- ${step}`).join('\n')}`).join('\n\n'),
  '',
  'Client Update Message',
  strategy.clientUpdateMessage
].join('\n');
function copyButton(label, textFactory) { return el('button', { class: 'secondary', text: label, onclick: () => copyText(textFactory()) }); }

function input(value, oninput, placeholder = '') { const node = el('input', { value, placeholder }); node.addEventListener('input', (e) => oninput(e.target.value)); return node; }
function render() { const root = document.getElementById('root'); root.innerHTML = ''; root.append(el('main', {}, [el('section', { class: 'hero' }, [el('p', { class: 'eyebrow', text: 'Synergy4Life' }), el('h1', { text: 'Credit File Analyzer' }), el('p', { text: 'Paste copied report text, verify extracted fields, then approve a strategic credit game plan. Stage 1 supports pasted text only.' })]), pasteCard(), verificationCard(), strategyCard()])); }
function pasteCard() { const area = el('textarea', { placeholder: 'Paste IdentityIQ, Credit Hero, SmartCredit, or unknown provider report text here...' }); area.value = rawText; area.addEventListener('input', (e) => rawText = e.target.value); const button = el('button', { text: 'Analyze Credit File', onclick: () => { analysis = parseReport(rawText); approvedAnalysis = null; approved = false; render(); } }); if (!rawText.trim()) button.disabled = true; return el('section', { class: 'card' }, [el('h2', { text: '1. Paste Credit Report Text' }), area, button]); }
function verificationCard() { const grid = el('div', { class: 'grid' }); [['clientProfile', analysis.clientProfile], ['scores', analysis.scores], ['accountSummary', analysis.accountSummary]].forEach(([section, obj]) => Object.entries(obj).forEach(([key, value]) => grid.append(el('label', {}, [document.createTextNode(labelText(key)), input(value, (v) => { analysis[section][key] = v; })])))); return el('section', { class: 'card' }, [el('h2', { text: '2. Manual Verification' }), el('p', { class: 'notice', text: 'Review and edit parsed data. Strategy stays locked until approval.' }), grid, listEditor('Tradelines', 'tradelines'), listEditor('Positive Items', 'positiveItems'), listEditor('Negative Items', 'negativeItems'), listEditor('Collections', 'collections'), listEditor('Derogatory Items', 'derogatoryItems'), textListEditor('Bureau Differences', 'bureauDifferences'), textListEditor('Rebuild Needs', 'rebuildNeeds'), el('button', { class: 'approve', text: 'Approve Credit File Analysis', onclick: () => { approvedAnalysis = buildApprovedAnalysis(analysis); approved = true; render(); } })]); }
function listEditor(title, key) { const box = el('div', { class: 'subcard' }, [el('h3', { text: title })]); if (!analysis[key].length) box.append(el('p', { class: 'muted', text: `No verified ${title.toLowerCase()} parsed.` })); analysis[key].forEach((row, i) => box.append(el('div', { class: 'row' }, [input(row.creditor || '', (v) => analysis[key][i].creditor = v, 'creditor'), input(row.type || '', (v) => analysis[key][i].type = v, 'type'), input(row.balance || '', (v) => analysis[key][i].balance = v, 'balance'), input(row.status || '', (v) => analysis[key][i].status = v, 'status')]))); return box; }
function textListEditor(title, key) { const box = el('div', { class: 'subcard' }, [el('h3', { text: title })]); if (!analysis[key].length) box.append(el('p', { class: 'muted', text: `No verified ${title.toLowerCase()} parsed.` })); analysis[key].forEach((row, i) => box.append(input(row, (v) => analysis[key][i] = v))); return box; }
function field(label, value) { return el('div', { class: 'metric' }, [el('span', { text: label }), el('strong', { text: String(value) })]); }
function itemCard(title, rows, extra = []) { return el('article', { class: 'strategy-item' }, [el('h4', { text: title }), ...rows.map(([label, value]) => field(label, value)), ...extra]); }
function emptyState(text) { return el('p', { class: 'muted empty', text }); }
function strategySection(title, children) { return el('div', { class: 'strategy-section' }, [el('h3', { text: title }), ...children]); }
function strategyCard() {
  const box = el('section', { class: `card strategy ${approved ? '' : 'locked'}` }, [el('h2', { text: '3. Strategy & 30/60/90 Game Plan' })]);
  if (!approved) {
    box.append(el('p', { class: 'notice', text: 'Approve the verified credit file analysis to generate strategy.' }));
    return box;
  }
  const strategy = makeStrategy(approvedAnalysis || buildApprovedAnalysis(analysis));
  const snap = strategy.snapshot;
  box.append(strategySection('Credit File Snapshot', [
    el('div', { class: 'snapshot-grid' }, [
      field('Client name', snap.clientName), field('Provider', snap.provider), field('Report date', snap.reportDate),
      field('TU score', snap.scores.TU), field('EX score', snap.scores.EX), field('EQ score', snap.scores.EQ),
      field('Total tradelines verified', snap.totalTradelines), field('Positive tradelines', snap.positiveTradelines), field('Negative tradelines', snap.negativeTradelines),
      field('Collections', snap.collections), field('Derogatory', snap.derogatory), field('Inquiries', snap.inquiries)
    ])
  ]));
  box.append(strategySection('Positive Credit Profile', strategy.positiveItems.length ? strategy.positiveItems.map((item) => itemCard(item.creditor || 'Positive account', [
    ['Creditor', displayValue(item.creditor)], ['Account type', displayValue(item.type)], ['Balance', formatMoney(item.balance)], ['Status', displayValue(item.status)], ['Role in strategy', item.role]
  ])) : [emptyState('No positive tradelines were verified in the approved manual data.')]));
  box.append(strategySection('Negative Account Attack Plan', strategy.negativeItems.length ? strategy.negativeItems.map((item) => itemCard(item.creditor || 'Negative account', [
    ['Creditor', displayValue(item.creditor)], ['Account type', displayValue(item.type)], ['Balance', formatMoney(item.balance)], ['Status', displayValue(item.status)], ['Why it hurts', item.whyItHurts], ['Dispute priority', item.disputePriority]
  ], [el('div', { class: 'angles' }, [el('span', { text: 'Factual attack angles' }), el('ul', {}, item.attackAngles.map((angle) => el('li', { text: angle })))])])) : [emptyState('No negative tradelines were verified in the approved manual data.')]));
  box.append(strategySection('Score Blocker Ranking', strategy.scoreBlockers.length ? [el('div', { class: 'rank-list' }, strategy.scoreBlockers.map((blocker, index) => el('article', { class: 'rank-card' }, [el('strong', { text: `${index + 1}. ${blocker.title}` }), el('p', { text: blocker.detail })])))] : [emptyState('No score blockers were verified from the approved manual verification data.')]));
  box.append(strategySection('30/60/90 Game Plan', Object.entries(strategy.gamePlan).map(([period, steps]) => el('article', { class: 'plan-card' }, [el('h4', { text: period }), el('ul', {}, steps.map((step) => el('li', { text: step }))) ]))));
  box.append(strategySection('Client Update Message', [el('div', { class: 'client-message', text: strategy.clientUpdateMessage }), copyButton('Copy Client Update Message', () => strategy.clientUpdateMessage)]));
  box.append(copyButton('Copy Strategy Summary', () => strategySummaryText(strategy)));
  return box;
}
render();
