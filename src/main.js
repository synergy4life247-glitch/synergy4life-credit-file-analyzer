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
  tradelines: [], negativeItems: [], positiveItems: [], bureauDifferences: [], rebuildNeeds: []
});
let rawText = ''; let analysis = emptyAnalysis(); let approved = false;
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
    bureauDifferences: tradelines.filter((t) => t.bureaus && t.bureaus.split(',').length < 3).map((t) => `${t.creditor}: appears to vary by bureau (${t.bureaus || 'bureau not specified'}).`),
    rebuildNeeds: []
  };
}
function makeStrategy(data) {
  const blockers = [];
  if (data.negativeItems.length) blockers.push(`${data.negativeItems.length} verified negative tradeline(s) need factual review.`);
  if (data.accountSummary.collections) blockers.push(`Collections reported in summary: ${data.accountSummary.collections}.`);
  if (data.accountSummary.derogatoryAccounts) blockers.push(`Derogatory accounts reported in summary: ${data.accountSummary.derogatoryAccounts}.`);
  if (!blockers.length) blockers.push('No specific score blockers were verified from the pasted text. Review manually before advising the client.');
  const disputes = data.negativeItems.map((item) => `${item.creditor}: verify balance, dates, status, ownership, payment history, and bureau-level reporting.`);
  return { fileSummary: `${data.clientProfile.clientName || 'Client'} file parsed from ${data.clientProfile.provider}. Scores captured: ${BUREAUS.filter((b) => data.scores[b]).join(', ') || 'none verified'}. Tradelines captured: ${data.tradelines.length}.`, biggestScoreBlockers: blockers, disputePriorities: disputes.length ? disputes : ['No account-level dispute priority can be created until a negative tradeline is verified.'], factualDisputeAngles: ['Verify account ownership.', 'Verify current balance and past-due amount.', 'Verify open/closed status and date fields.', 'Verify payment history and derogatory notation accuracy.'], bureauInconsistencyAngles: data.bureauDifferences.length ? data.bureauDifferences : ['No bureau inconsistency was verified from the pasted text.'], rebuildStrategy: ['Protect every open positive account with on-time payments.', 'Keep revolving utilization low if revolving balances are present.', 'Add positive credit only after verified negatives and utilization risks are understood.'], mortgageReadinessNotes: ['Do not add new debt before lender review.', 'Resolve or document verified collections/public records before pre-approval.', 'Maintain clean 30/60/90-day payment history.'], thirtyDayPlan: ['Complete verification edits.', 'Prioritize verified negative items.', 'Prepare factual dispute letters from verified inaccuracies.'], sixtyDayPlan: ['Review bureau responses.', 'Update utilization and payment status.', 'Escalate unresolved factual inaccuracies.'], ninetyDayPlan: ['Re-pull and compare bureau changes.', 'Confirm score movement and remaining blockers.', 'Prepare lender-readiness checklist if mortgage-bound.'], clientUpdateMessage: 'Your pasted credit report has been reviewed and organized. We will focus first on verified score blockers, bureau inconsistencies, and rebuild steps that support your 30/60/90-day plan.' };
}
const el = (tag, attrs = {}, children = []) => { const node = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => { if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v); }); children.forEach((c) => node.append(c)); return node; };
function input(value, oninput, placeholder = '') { const node = el('input', { value, placeholder }); node.addEventListener('input', (e) => oninput(e.target.value)); return node; }
function render() { const root = document.getElementById('root'); root.innerHTML = ''; root.append(el('main', {}, [el('section', { class: 'hero' }, [el('p', { class: 'eyebrow', text: 'Synergy4Life' }), el('h1', { text: 'Credit File Analyzer' }), el('p', { text: 'Paste copied report text, verify extracted fields, then approve a strategic credit game plan. Stage 1 supports pasted text only.' })]), pasteCard(), verificationCard(), strategyCard()])); }
function pasteCard() { const area = el('textarea', { placeholder: 'Paste IdentityIQ, Credit Hero, SmartCredit, or unknown provider report text here...' }); area.value = rawText; area.addEventListener('input', (e) => rawText = e.target.value); const button = el('button', { text: 'Analyze Credit File', onclick: () => { analysis = parseReport(rawText); approved = false; render(); } }); if (!rawText.trim()) button.disabled = true; return el('section', { class: 'card' }, [el('h2', { text: '1. Paste Credit Report Text' }), area, button]); }
function verificationCard() { const grid = el('div', { class: 'grid' }); [['clientProfile', analysis.clientProfile], ['scores', analysis.scores], ['accountSummary', analysis.accountSummary]].forEach(([section, obj]) => Object.entries(obj).forEach(([key, value]) => grid.append(el('label', {}, [document.createTextNode(labelText(key)), input(value, (v) => { analysis[section][key] = v; })])))); return el('section', { class: 'card' }, [el('h2', { text: '2. Manual Verification' }), el('p', { class: 'notice', text: 'Review and edit parsed data. Strategy stays locked until approval.' }), grid, listEditor('Tradelines', 'tradelines'), listEditor('Positive Items', 'positiveItems'), listEditor('Negative Items', 'negativeItems'), textListEditor('Bureau Differences', 'bureauDifferences'), el('button', { class: 'approve', text: 'Approve Credit File Analysis', onclick: () => { approved = true; render(); } })]); }
function listEditor(title, key) { const box = el('div', { class: 'subcard' }, [el('h3', { text: title })]); if (!analysis[key].length) box.append(el('p', { class: 'muted', text: `No verified ${title.toLowerCase()} parsed.` })); analysis[key].forEach((row, i) => box.append(el('div', { class: 'row' }, [input(row.creditor || '', (v) => analysis[key][i].creditor = v, 'creditor'), input(row.type || '', (v) => analysis[key][i].type = v, 'type'), input(row.balance || '', (v) => analysis[key][i].balance = v, 'balance'), input(row.status || '', (v) => analysis[key][i].status = v, 'status')]))); return box; }
function textListEditor(title, key) { const box = el('div', { class: 'subcard' }, [el('h3', { text: title })]); if (!analysis[key].length) box.append(el('p', { class: 'muted', text: `No verified ${title.toLowerCase()} parsed.` })); analysis[key].forEach((row, i) => box.append(input(row, (v) => analysis[key][i] = v))); return box; }
function strategyCard() { const box = el('section', { class: `card ${approved ? '' : 'locked'}` }, [el('h2', { text: '3. Strategy & 30/60/90 Game Plan' })]); if (!approved) box.append(el('p', { class: 'notice', text: 'Approve the verified credit file analysis to generate strategy.' })); else { const strategy = makeStrategy(analysis); box.append(el('p', { text: strategy.fileSummary })); Object.entries(strategy).filter(([k]) => k !== 'fileSummary').forEach(([k, v]) => { const part = el('div', {}, [el('h3', { text: labelText(k) })]); if (Array.isArray(v)) part.append(el('ul', {}, v.map((x) => el('li', { text: x })))); else part.append(el('p', { text: v })); box.append(part); }); } return box; }
render();