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
function isAccountStartCandidate(line) {
  const lower = clean(line).toLowerCase();
  if (!line || isAccountType(line) || line.includes(':')) return false;
  if (/^(none reported|back to top|days late|ok\b|co\b|jan-|feb-|mar-|apr-|may-|jun-|jul-|aug-|sep-|oct-|nov-|dec-)/i.test(line)) return false;
  if (/^[\d\s$,.:-]+$/.test(line)) return false;
  if (/^(credit score|personal information|account summary|account history|inquiries|public information)$/i.test(line)) return false;
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
  const pushAccount = (creditor, block) => {
    if (!creditor || !block.length) return;
    const joined = block.join('\n');
    const type = nextValueInBlock(block, ['Account Type']) || (block.find(isAccountType) || '');
    const status = nextValueInBlock(block, ['Status', 'Account Status', 'Account Rating']);
    const paymentStatus = nextValueInBlock(block, ['Payment Status']);
    const balance = nextValueInBlock(block, ['Balance Owed', 'Current Balance', 'Balance', 'High Balance']);
    const creditLimit = nextValueInBlock(block, ['Credit Limit', 'Credit Line', 'Limit']);
    const monthlyPayment = nextValueInBlock(block, ['Monthly Payment', 'Payment Amount']);
    const originalCreditor = nextValueInBlock(block, ['Original Creditor']);
    const bureaus = nextValueInBlock(block, ['Bureau Reporting']) || BUREAUS.filter((b) => new RegExp(b, 'i').test(joined)).join(', ');
    accounts.push({
      id: accounts.length + 1,
      creditor,
      type,
      status: clean(status || paymentStatus || type),
      paymentStatus,
      balance,
      creditLimit,
      monthlyPayment,
      originalCreditor,
      bureaus,
      raw: joined
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const creditor = lines[i];
    if (!isAccountStartCandidate(creditor)) continue;
    const lookahead = lines.slice(i + 1, Math.min(lines.length, i + 8)).join('\n');
    if (!/Account Type\s*:|Payment Status\s*:|Bureau Reporting\s*:|Balance\s*:/i.test(lookahead)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      const nextLookahead = lines.slice(j + 1, Math.min(lines.length, j + 8)).join('\n');
      if (isAccountStartCandidate(candidate) && /Account Type\s*:|Payment Status\s*:|Bureau Reporting\s*:|Balance\s*:/i.test(nextLookahead)) {
        end = j;
        break;
      }
    }
    pushAccount(creditor, lines.slice(i + 1, end));
    i = end - 1;
  }

  if (accounts.length) return accounts;

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
    const creditLimit = nextValueInBlock(block, ['Credit Limit', 'Credit Line', 'Limit']);
    const monthlyPayment = nextValueInBlock(block, ['Monthly Payment', 'Payment Amount']);
    const bureaus = BUREAUS.filter((b) => new RegExp(b, 'i').test(joined)).join(', ');
    accounts.push({ id: accounts.length + 1, creditor, type, status: clean(paymentStatus || accountStatus || rating || type), paymentStatus, balance, creditLimit, monthlyPayment, bureaus, raw: joined });
    i = nextTypeIndex - 1;
  }
  return accounts;
}
function parseReport(text) {
  const provider = detectProvider(text);
  const personal = getSection(text, 'Personal Information', ['Consumer Statement', 'Account Summary', 'Account History']);
  const summary = getSection(text, 'Account Summary', ['Account History', 'Inquiries', 'Public Information']);
  const tradelines = parseTradelines(text);
  const negativeItems = tradelines.filter(classifyNegative);
  const positiveItems = tradelines.filter(classifyPositive);
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
const displayValue = (value, fallback = 'Needs verification') => clean(value) || fallback;
const hasVerifiedValue = (value) => clean(value) !== '';
const confirmedNumber = (value) => {
  if (!hasVerifiedValue(value)) return null;
  const count = Number(parsedCount(value));
  return Number.isFinite(count) ? count : null;
};
const formatMoney = (value) => displayValue(value);
const scoreValue = (data, bureau) => displayValue(data.scores[bureau]);
const itemText = (item) => `${item.creditor || ''} ${item.type || ''} ${item.status || ''} ${item.raw || ''}`;
const isVerifiedItem = (item) => Boolean(clean(item?.creditor) || clean(item?.type) || clean(item?.balance) || clean(item?.status) || clean(item?.raw));
const isCollection = (item) => /collection/i.test(itemText(item));
const isChargeOff = (item) => /charge.?off|\bco\b/i.test(itemText(item));
const hasRecentLate = (item) => /late payment|\b(?:30|60|90)\s*(?:days?\s*)?late\b|past due|delinquent|days late/i.test(itemText(item));
const moneyNumber = (value) => {
  const first = moneyOrNumber(value)[0];
  return first ? Number(first.replace(/[$,]/g, '')) : null;
};
const hasHighUtilization = (item) => {
  const balance = moneyNumber(item?.balance);
  const limit = moneyNumber(item?.creditLimit);
  return Number.isFinite(balance) && Number.isFinite(limit) && limit > 0 && (balance / limit) >= 0.7;
};
const verifiedCount = (value) => {
  const count = confirmedNumber(value);
  return count !== null && count > 0;
};
const hasPublicRecords = (data) => verifiedCount(data.accountSummary.publicRecords);
const hasInquiries = (data) => verifiedCount(data.accountSummary.inquiries);
const hasThinFile = (data) => data.tradelines.length > 0 && data.positiveItems.length < 2;
const NEGATIVE_LANGUAGE = /collection|charge.?off|late payment|\b(?:30|60|90|120|150)\s*(?:days?\s*)?late\b|derogatory|delinquent|\brepo(?:ssession)?\b|foreclosure|bankruptcy|settlement|past due|closed by grantor|negative status|days late|\bco\b/i;
const POSITIVE_LANGUAGE = /open|current|paid as agreed|pays as agreed|never late|satisfactory|\bok\b/i;

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
  return NEGATIVE_LANGUAGE.test(itemText(item));
}
function classifyPositive(item) {
  return !isCollection(item) && !isChargeOff(item) && POSITIVE_LANGUAGE.test(itemText(item));
}
function buildApprovedAnalysis(current) {
  const source = cloneData(current || emptyAnalysis());
  const tradelines = ensureList(source.tradelines);
  const negativeItems = uniqueItems([...ensureList(source.negativeItems), ...tradelines.filter(classifyNegative)]);
  const positiveItems = uniqueItems([...ensureList(source.positiveItems), ...tradelines.filter(classifyPositive)]);
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
  return 'This negative reporting flag may be hurting payment history, derogatory status, utilization, or lender approval review.';
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
  if (derogatoryItems.length && !recentLates.length && !collections.length && !chargeOffs.length) ranked.push({ title: 'Derogatory Flags', detail: `${derogatoryItems.length} verified derogatory flag(s) need factual review.` });
  if (negativeItems.length && !recentLates.length && !collections.length && !chargeOffs.length && !derogatoryItems.length) ranked.push({ title: 'Negative Reporting Flags', detail: `${negativeItems.length} verified negative reporting flag(s) need factual review. One tradeline can be positive overall and still contain negative reporting flags.` });
  const highUtil = uniqueItems([...tradelines, ...(data.positiveItems || []), ...negativeItems]).filter(hasHighUtilization);
  if (highUtil.length) ranked.push({ title: 'High utilization', detail: `${highUtil.length} verified tradeline(s) include high-utilization language.` });
  if (hasPublicRecords(data)) ranked.push({ title: 'Public records', detail: `Summary reports public records: ${firstValue(data.accountSummary.publicRecords)}.` });
  if (hasInquiries(data)) ranked.push({ title: 'Inquiries', detail: `Summary reports inquiries: ${firstValue(data.accountSummary.inquiries)}.` });
  if (hasThinFile(data)) ranked.push({ title: 'Thin file / positive profile review', detail: data.positiveItems.length ? `${data.positiveItems.length} positive tradeline(s) verified across ${data.tradelines.length} total tradeline(s).` : 'Some positive profile details still need manual confirmation before final rebuild targeting.' });
  return ranked;
}
const plural = (count, singular, pluralText = `${singular}s`) => `${count} ${Number(count) === 1 ? singular : pluralText}`;
const countPhrase = (count, singular, pluralText) => count === null ? '' : plural(count, singular, pluralText);
const cleanJoin = (parts, separator = ', ') => parts.map(clean).filter(Boolean).join(separator);
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
  const data = cloneData(sourceData || emptyAnalysis());
  const negativeWithPriority = (data.negativeItems || []).map((item) => ({ ...item, whyItHurts: whyItHurts(item), disputePriority: disputePriority(item), attackAngles: attackAngles(item) }));
  const firstNegative = negativeWithPriority[0];
  const approvedCollections = uniqueItems([...(data.collections || []), ...(data.negativeItems || []).filter(isCollection), ...(data.tradelines || []).filter(isCollection)]);
  const approvedDerogatory = uniqueItems([...(data.derogatoryItems || []), ...(data.negativeItems || []).filter(classifyNegative)]);
  const summaryCollections = confirmedNumber(data.accountSummary.collections);
  const summaryDerogatory = confirmedNumber(data.accountSummary.derogatoryAccounts);
  const summaryInquiries = confirmedNumber(data.accountSummary.inquiries);
  const summaryTotalAccounts = confirmedNumber(data.accountSummary.totalAccounts);
  const summaryDelinquent = confirmedNumber(data.accountSummary.delinquentAccounts);
  const hasApprovedTradelineData = Boolean((data.tradelines || []).length || (data.positiveItems || []).length || (data.negativeItems || []).length || approvedCollections.length || approvedDerogatory.length);
  const totalTradelineCount = (data.tradelines || []).length || uniqueItems([...(data.positiveItems || []), ...(data.negativeItems || [])]).length;
  const totalTradelines = hasApprovedTradelineData ? totalTradelineCount : summaryTotalAccounts;
  const positiveCount = (data.positiveItems || []).length ? data.positiveItems.length : null;
  const negativeCount = (data.negativeItems || []).length ? data.negativeItems.length : (summaryDerogatory ?? summaryDelinquent);
  const collectionCount = approvedCollections.length ? approvedCollections.length : summaryCollections;
  const derogatoryCount = approvedDerogatory.length ? approvedDerogatory.length : summaryDerogatory;
  const valueOrNeeds = (value) => displayValue(value, 'Needs verification');
  const countOrNeeds = (count) => count === null ? 'Needs verification' : String(count);
  const blockerTitles = scoreBlockerRanking(data).slice(0, 3).map((b) => b.title.toLowerCase());
  const clientGreeting = verifiedName(data) ? `Hi ${verifiedName(data)},` : 'Hi there,';
  const approvedCountParts = [
    countPhrase(totalTradelines, 'total tradeline'),
    (positiveCount && positiveCount > 0) ? countPhrase(positiveCount, 'positive tradeline') : '',
    (negativeCount && negativeCount > 0) ? countPhrase(negativeCount, 'negative reporting flag') : '',
    (collectionCount && collectionCount > 0) ? countPhrase(collectionCount, 'collection') : '',
    (derogatoryCount && derogatoryCount > 0) ? countPhrase(derogatoryCount, 'derogatory item') : ''
  ];
  const reviewedPhrase = cleanJoin(approvedCountParts)
    ? `I reviewed and organized the credit report details you provided, including ${cleanJoin(approvedCountParts)}.`
    : 'I reviewed and organized the credit report details provided.';
  const blockerPhrase = blockerTitles.length
    ? `The main score blockers showing in the verified data are ${blockerTitles.join(', ')}.`
    : 'Some items still need manual confirmation before final dispute targeting.';
  return {
    snapshot: {
      clientName: valueOrNeeds(data.clientProfile.clientName),
      provider: valueOrNeeds(data.clientProfile.provider),
      reportDate: valueOrNeeds(data.clientProfile.reportDate),
      scores: { TU: valueOrNeeds(data.scores.TransUnion), EX: valueOrNeeds(data.scores.Experian), EQ: valueOrNeeds(data.scores.Equifax) },
      totalTradelines: countOrNeeds(totalTradelines),
      positiveTradelines: countOrNeeds(positiveCount),
      negativeTradelines: countOrNeeds(negativeCount),
      collections: countOrNeeds(collectionCount),
      derogatory: countOrNeeds(derogatoryCount),
      inquiries: countOrNeeds(summaryInquiries)
    },
    debug: {
      clientName: valueOrNeeds(data.clientProfile.clientName),
      reportDate: valueOrNeeds(data.clientProfile.reportDate),
      scores: `TU ${valueOrNeeds(data.scores.TransUnion)} | EX ${valueOrNeeds(data.scores.Experian)} | EQ ${valueOrNeeds(data.scores.Equifax)}`,
      tradelines: countOrNeeds(totalTradelines),
      positiveItems: countOrNeeds(positiveCount),
      negativeItems: countOrNeeds(negativeCount)
    },
    positiveItems: (data.positiveItems || []).map((item) => ({ ...item, role: 'Protect this account. This helps age, payment history, and positive revolving profile.' })),
    negativeItems: negativeWithPriority,
    scoreBlockers: scoreBlockerRanking(data),
    gamePlan: {
      '30 Days': ['Verify organized data against the report before sending anything.', 'Send factual disputes for verified negative items only.', 'Protect positive accounts with on-time payments and no unnecessary new debt.', 'Give the client rebuild instructions based on verified positives, negatives, and utilization risk.'],
      '60 Days': ['Review bureau responses and document each result.', 'Compare deleted, verified, updated, or stalled accounts by bureau.', 'Prepare second-round escalation for unresolved factual inaccuracies.'],
      '90 Days': ['Re-pull the report and compare against the approved baseline.', 'Update score blockers using only newly verified data.', 'Complete mortgage/rebuild readiness review.', 'Decide the next dispute or rebuild move.']
    },
    clientUpdateMessage: `${clientGreeting} ${reviewedPhrase} ${blockerPhrase} Our first focus area is ${disputeFocus(firstNegative)}. For rebuild and protection, we’ll ${rebuildFocus(data)}. Over the next 30/60/90 days, we will verify and dispute accurate targets first, review bureau responses, then update the plan from the new verified results.`
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
  `Tradelines: ${snap.totalTradelines} total | ${snap.positiveTradelines} positive | ${snap.negativeTradelines} negative reporting flags`,
  `Collections: ${snap.collections}`,
  `Derogatory Flags: ${snap.derogatory}`,
  `Inquiries: ${snap.inquiries}`
].join('\n');
const itemSummaryText = (items, empty, formatter) => items.length ? items.map(formatter).join('\n') : empty;
const disputeHitListText = (strategy) => itemSummaryText(strategy.negativeItems, 'Some items still need manual confirmation before final dispute targeting.', (item, index) => `${index + 1}. ${displayValue(item.creditor, 'Negative reporting flag')} — ${displayValue(item.type)} — ${displayValue(item.status)} — Balance: ${formatMoney(item.balance)}\nPriority: ${item.disputePriority}\nAttack angles: ${item.attackAngles.join(' ')}`);
const rebuildPlanText = (strategy) => itemSummaryText(strategy.positiveItems, 'Some positive profile details still need manual confirmation before final rebuild targeting.', (item, index) => `${index + 1}. ${displayValue(item.creditor, 'Positive account')} — ${displayValue(item.type)} — ${displayValue(item.status)} — Balance: ${formatMoney(item.balance)} — ${item.role}`);
const planText = (strategy) => Object.entries(strategy.gamePlan).map(([period, steps]) => `${period}\n${steps.map((step) => `- ${step}`).join('\n')}`).join('\n\n');
const strategySummaryText = (strategy) => [
  snapshotText(strategy.snapshot),
  '',
  'Positive Items',
  itemSummaryText(strategy.positiveItems, 'Some positive profile details still need manual confirmation before final rebuild targeting.', (item, index) => `${index + 1}. ${displayValue(item.creditor, 'Positive account')} — ${displayValue(item.type)} — ${displayValue(item.status)} — Balance: ${formatMoney(item.balance)} — ${item.role}`),
  '',
  'Dispute Hit List',
  itemSummaryText(strategy.negativeItems, 'Some items still need manual confirmation before final dispute targeting.', (item, index) => `${index + 1}. ${displayValue(item.creditor, 'Negative account')} — ${displayValue(item.type)} — ${displayValue(item.status)} — Balance: ${formatMoney(item.balance)}\n   Why it hurts: ${item.whyItHurts}\n   Priority: ${item.disputePriority}\n   Attack angles: ${item.attackAngles.join(' ')}`),
  '',
  'Score Blocker Ranking',
  strategy.scoreBlockers.length ? strategy.scoreBlockers.map((blocker, index) => `${index + 1}. ${blocker.title}: ${blocker.detail}`).join('\n') : 'Some items still need manual confirmation before final dispute targeting.',
  '',
  '30/60/90 Plan',
  Object.entries(strategy.gamePlan).map(([period, steps]) => `${period}\n${steps.map((step) => `- ${step}`).join('\n')}`).join('\n\n'),
  '',
  'Client Update Message',
  strategy.clientUpdateMessage
].join('\n');
function copyButton(label, textFactory) { return el('button', { class: 'secondary', text: label, onclick: () => copyText(textFactory()) }); }

function input(value, oninput, placeholder = '') { const node = el('input', { value, placeholder }); node.addEventListener('input', (e) => oninput(e.target.value)); return node; }
function checkbox(label, checked, onchange) { const node = el('input', { type: 'checkbox' }); node.checked = Boolean(checked); node.addEventListener('change', (e) => onchange(e.target.checked)); return el('label', { class: 'check' }, [node, document.createTextNode(label)]); }
function render() { const root = document.getElementById('root'); root.innerHTML = ''; root.append(el('main', {}, [el('section', { class: 'hero' }, [el('p', { class: 'eyebrow', text: 'Synergy4Life' }), el('h1', { text: 'Credit File Analyzer' }), el('p', { text: 'Paste copied report text, verify extracted fields, then approve a strategic credit game plan. Stage 1 supports pasted text only.' })]), pasteCard(), verificationCard(), strategyCard()])); }
function pasteCard() { const area = el('textarea', { placeholder: 'Paste IdentityIQ, Credit Hero, SmartCredit, or unknown provider report text here...' }); area.value = rawText; area.addEventListener('input', (e) => rawText = e.target.value); const button = el('button', { text: 'Analyze Credit File', onclick: () => { analysis = parseReport(rawText); approvedAnalysis = null; approved = false; render(); } }); if (!rawText.trim()) button.disabled = true; return el('section', { class: 'card' }, [el('h2', { text: '1. Paste Credit Report Text' }), area, button]); }
function verificationCard() { const grid = el('div', { class: 'grid' }); [['clientProfile', analysis.clientProfile], ['scores', analysis.scores], ['accountSummary', analysis.accountSummary]].forEach(([section, obj]) => Object.entries(obj).forEach(([key, value]) => grid.append(el('label', {}, [document.createTextNode(labelText(key)), input(value, (v) => { analysis[section][key] = v; approved = false; approvedAnalysis = null; })])))); return el('section', { class: 'card' }, [el('h2', { text: '2. Manual Verification' }), el('p', { class: 'notice', text: 'Review and edit organized data. Strategy stays locked until you click Approve Credit File Analysis. One tradeline can be positive overall while still having negative reporting flags.' }), grid, listEditor('Tradelines', 'tradelines'), listEditor('Positive Items', 'positiveItems'), listEditor('Negative Reporting Flags', 'negativeItems'), listEditor('Collections', 'collections'), listEditor('Derogatory Flags', 'derogatoryItems'), textListEditor('Bureau Differences', 'bureauDifferences'), textListEditor('Rebuild Needs', 'rebuildNeeds'), el('button', { class: 'approve', text: 'Approve Credit File Analysis', onclick: () => { approvedAnalysis = buildApprovedAnalysis(analysis); approved = true; render(); } })]); }
function touchAnalysis() { approved = false; approvedAnalysis = null; }
function cloneAccount(row = {}) { return { id: Date.now() + Math.random(), creditor: row.creditor || '', type: row.type || '', balance: row.balance || '', creditLimit: row.creditLimit || '', monthlyPayment: row.monthlyPayment || '', status: row.status || '', bureaus: row.bureaus || '', notes: row.notes || '', raw: row.raw || '' }; }
function sameAccount(a, b) { return clean(`${a.creditor}|${a.type}|${a.balance}|${a.status}|${a.raw}`).toLowerCase() === clean(`${b.creditor}|${b.type}|${b.balance}|${b.status}|${b.raw}`).toLowerCase(); }
function addUniqueAccount(key, row) { const item = cloneAccount(row); if (!analysis[key].some((existing) => sameAccount(existing, item))) analysis[key].push(item); touchAnalysis(); }
function removeMatching(key, row) { analysis[key] = analysis[key].filter((item) => !sameAccount(item, row)); }
function deleteAccount(key, index, row) { analysis[key].splice(index, 1); if (key === 'tradelines') { removeMatching('positiveItems', row); removeMatching('negativeItems', row); removeMatching('collections', row); removeMatching('derogatoryItems', row); } touchAnalysis(); render(); }
function markAccount(row, mode) { if (mode === 'positive' || mode === 'both') addUniqueAccount('positiveItems', row); else removeMatching('positiveItems', row); if (mode === 'negative' || mode === 'both') addUniqueAccount('negativeItems', row); else removeMatching('negativeItems', row); touchAnalysis(); render(); }
function accountFields(row, onChange) { return el('div', { class: 'account-fields' }, [
  input(row.creditor || '', (v) => onChange('creditor', v), 'Creditor name'), input(row.type || '', (v) => onChange('type', v), 'Account type'), input(row.balance || '', (v) => onChange('balance', v), 'Balance'), input(row.creditLimit || '', (v) => onChange('creditLimit', v), 'Credit limit'), input(row.monthlyPayment || '', (v) => onChange('monthlyPayment', v), 'Monthly payment'), input(row.status || '', (v) => onChange('status', v), 'Status'), input(row.bureaus || '', (v) => onChange('bureaus', v), 'Bureau reporting'), input(row.notes || '', (v) => onChange('notes', v), 'Notes')
]); }
function accountControls(key, row, index) { return el('div', { class: 'controls' }, [
  el('button', { class: 'secondary small', text: 'Edit Account', onclick: () => document.getElementById(`${key}-${index}`)?.classList.toggle('collapsed') }),
  el('button', { class: 'secondary small', text: 'Delete Account', onclick: () => deleteAccount(key, index, row) }),
  el('button', { class: 'secondary small', text: 'Mark as Positive', onclick: () => markAccount(row, 'positive') }),
  el('button', { class: 'secondary small', text: 'Mark as Negative', onclick: () => markAccount(row, 'negative') }),
  el('button', { class: 'secondary small', text: 'Mark as Both Positive and Negative', onclick: () => markAccount(row, 'both') })
]); }
function updateBureauDraft(draft, bureau, checked) { const set = new Set((draft.bureaus || '').split(',').map(clean).filter(Boolean)); if (checked) set.add(bureau); else set.delete(bureau); draft.bureaus = [...set].join(', '); }
function listEditor(title, key) { const box = el('div', { class: 'subcard' }, [el('h3', { text: title })]); if (!analysis[key].length) box.append(el('p', { class: 'muted', text: `No verified ${title.toLowerCase()} organized yet.` })); analysis[key].forEach((row, i) => { const editor = el('div', { class: 'account-editor collapsed', id: `${key}-${i}` }, [accountFields(row, (fieldName, value) => { analysis[key][i][fieldName] = value; touchAnalysis(); })]); box.append(el('div', { class: 'account-card' }, [el('strong', { text: row.creditor || 'Account needs creditor name' }), el('p', { class: 'muted', text: `${displayValue(row.type)} • ${displayValue(row.status)} • Balance: ${formatMoney(row.balance)}` }), accountControls(key, row, i), editor])); }); return box; }
function textListEditor(title, key) { const box = el('div', { class: 'subcard' }, [el('h3', { text: title })]); if (!analysis[key].length) box.append(el('p', { class: 'muted', text: `No verified ${title.toLowerCase()} organized yet.` })); analysis[key].forEach((row, i) => box.append(input(row, (v) => { analysis[key][i] = v; touchAnalysis(); }))); return box; }
function field(label, value) { return el('div', { class: 'metric' }, [el('span', { text: label }), el('strong', { text: String(value) })]); }
function itemCard(title, rows, extra = []) { return el('article', { class: 'strategy-item' }, [el('h4', { text: title }), ...rows.map(([label, value]) => field(label, value)), ...extra]); }
function emptyState(text) { return el('p', { class: 'muted empty', text }); }
function strategySection(title, children) { return el('div', { class: 'strategy-section' }, [el('h3', { text: title }), ...children]); }
function strategyCard() {
  const box = el('section', { class: `card strategy ${approved ? '' : 'locked'}` }, [el('h2', { text: '3. Strategy & 30/60/90 Game Plan' })]);
  if (!approved || !approvedAnalysis) {
    box.append(el('p', { class: 'notice', text: 'Approve the verified credit file analysis to generate strategy.' }));
    return box;
  }
  box.append(el('p', { class: 'approval-confirmation', text: 'Credit file analysis approved. Strategy generated from verified fields.' }));
  const strategy = makeStrategy(approvedAnalysis);
  const snap = strategy.snapshot;
  box.append(strategySection('Credit File Snapshot', [
    el('div', { class: 'snapshot-grid' }, [
      field('Client name', snap.clientName), field('Provider', snap.provider), field('Report date', snap.reportDate),
      field('TU score', snap.scores.TU), field('EX score', snap.scores.EX), field('EQ score', snap.scores.EQ),
      field('Total tradelines verified', snap.totalTradelines), field('Positive tradelines', snap.positiveTradelines), field('Negative Reporting Flags', snap.negativeTradelines),
      field('Collections', snap.collections), field('Derogatory Flags', snap.derogatory), field('Inquiries', snap.inquiries)
    ])
  ]));
  box.append(strategySection('Positive Credit Profile', strategy.positiveItems.length ? strategy.positiveItems.map((item) => itemCard(item.creditor || 'Positive account', [
    ['Creditor', displayValue(item.creditor)], ['Account Type', displayValue(item.type)], ['Balance', formatMoney(item.balance)], ['Credit Limit', formatMoney(item.creditLimit)], ['Status', displayValue(item.status || item.paymentStatus)], ['Role in Strategy', item.role]
  ])) : [emptyState('Some positive profile details still need manual confirmation before final rebuild targeting.')]));
  box.append(strategySection('Negative Account Attack Plan', strategy.negativeItems.length ? strategy.negativeItems.map((item) => itemCard(item.creditor || 'Negative account', [
    ['Creditor', displayValue(item.creditor)], ['Account Type', displayValue(item.type)], ['Balance', formatMoney(item.balance)], ['Status', displayValue(item.status || item.paymentStatus)], ['Why It Hurts', item.whyItHurts], ['Dispute Priority', item.disputePriority]
  ], [el('div', { class: 'angles' }, [el('span', { text: 'Factual Attack Angles' }), el('ul', {}, item.attackAngles.map((angle) => el('li', { text: angle })))])])) : [emptyState('Some items still need manual confirmation before final dispute targeting.')]));
  box.append(strategySection('Score Blocker Ranking', strategy.scoreBlockers.length ? [el('div', { class: 'rank-list' }, strategy.scoreBlockers.map((blocker, index) => el('article', { class: 'rank-card' }, [el('strong', { text: `${index + 1}. ${blocker.title}` }), el('p', { text: blocker.detail })])))] : [emptyState('Some items still need manual confirmation before final dispute targeting.')]));
  box.append(strategySection('30/60/90 Game Plan', Object.entries(strategy.gamePlan).map(([period, steps]) => el('article', { class: 'plan-card' }, [el('h4', { text: period }), el('ul', {}, steps.map((step) => el('li', { text: step }))) ]))));
  box.append(strategySection('Client Update Message', [el('div', { class: 'client-message', text: strategy.clientUpdateMessage }), copyButton('Copy Client Update Message', () => strategy.clientUpdateMessage)]));
  box.append(copyButton('Copy Strategy Summary', () => strategySummaryText(strategy)));
  return box;
}
render();
