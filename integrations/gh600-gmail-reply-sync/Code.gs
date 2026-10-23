/**
 * GhoulHouse GH600 — Gmail -> existing Google Sheets CRM, inbox replies only.
 * Public source contains no tokens, addresses of prospects or customer message bodies.
 * Install as a standalone Google Apps Script owned by hello@ghoulhouse.fi.
 * Requires Advanced Gmail service v1 and the scopes in appsscript.json.
 */
var GH600 = Object.freeze({
  MAILBOX: 'hello@ghoulhouse.fi',
  MASTER: 'MASTER_LEADS',
  SUPPRESSION: 'GH600_SUPPRESSION',
  EVENTS: 'GH600_REPLY_EVENTS',
  TEST_LEADS: 'GH600_E2E_TEST_LEADS',
  TEST_EVENTS: 'GH600_E2E_TEST_EVENTS',
  LOOKBACK_DAYS: 14,
  PAGE_LIMIT: 10,
  PAGE_SIZE: 100,
  HEADER: [
    'Gmail ID', 'RFC Message-ID', 'Thread ID', 'Mailbox', 'Received (UTC)',
    'Sender', 'Subject', 'Lead ID', 'Lead row', 'Decision', 'State',
    'Processed (UTC)', 'Detail'
  ]
});

function gh600Install() {
  gh600AssertAccount_();
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('GH600_SPREADSHEET_ID')) throw new Error('Set script property GH600_SPREADSHEET_ID first');
  var s = SpreadsheetApp.openById(p.getProperty('GH600_SPREADSHEET_ID'));
  gh600RequireTab_(s, GH600.MASTER);
  gh600RequireTab_(s, GH600.SUPPRESSION);
  gh600EnsureEvents_(s, GH600.EVENTS);
  // Never install a LIVE trigger here: activate only after successful live isolated E2E.
  p.setProperty('GH600_MODE', 'DRY_RUN');
  p.deleteProperty('GH600_E2E_PASS');
  return 'INSTALLED — DRY_RUN; no scheduled job created';
}

function gh600DryRun() { return gh600Sync_({dryRun: true}); }
function gh600Sync() { return gh600Sync_({dryRun: PropertiesService.getScriptProperties().getProperty('GH600_MODE') !== 'LIVE'}); }

function gh600EnableSchedule() {
  gh600AssertAccount_();
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('GH600_E2E_PASS') !== 'true') throw new Error('Isolated authenticated E2E must PASS first');
  if (p.getProperty('GH600_SPREADSHEET_ID') == null) throw new Error('Missing spreadsheet ID');
  // Explicit manual activation only. The activation also pins LIVE before scheduling.
  p.setProperty('GH600_MODE', 'LIVE');
  ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'gh600Sync'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('gh600Sync').timeBased().everyMinutes(5).create();
  return 'LIVE schedule installed (5 min)';
}

function gh600DisableSchedule() {
  ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'gh600Sync'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  PropertiesService.getScriptProperties().setProperty('GH600_MODE', 'DRY_RUN');
  return 'Schedule removed; DRY_RUN';
}

function gh600Sync_(options) {
  gh600AssertAccount_();
  var p = PropertiesService.getScriptProperties();
  var sid = p.getProperty('GH600_SPREADSHEET_ID');
  if (!sid) throw new Error('Missing GH600_SPREADSHEET_ID');
  var book = SpreadsheetApp.openById(sid);
  var leads = gh600RequireTab_(book, GH600.MASTER);
  var suppress = gh600RequireTab_(book, GH600.SUPPRESSION);
  var events = options.dryRun ? gh600RequireTab_(book, GH600.EVENTS) : gh600EnsureEvents_(book, GH600.EVENTS);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var query = 'in:inbox newer_than:' + GH600.LOOKBACK_DAYS + 'd';
    var snapshots = gh600ListInbox_(query);
    var result = { scanned: snapshots.length, inspectedReplies: 0, appended: 0, duplicates: 0, matched: 0, held: 0, quarantined: 0, dryRun: !!options.dryRun };
    for (var i = 0; i < snapshots.length; i++) {
      var m = snapshots[i];
      if (!gh600IsReply_(m)) continue;
      result.inspectedReplies++;
      var state = gh600Process_(m, leads, suppress, events, !!options.dryRun);
      if (state === 'DUPLICATE') result.duplicates++;
      else if (state === 'DONE') { result.appended++; result.matched++; }
      else if (state === 'HOLD') { result.appended++; result.held++; }
      else if (state === 'QUARANTINE') { result.appended++; result.quarantined++; }
    }
    return result;
  } finally {
    if (!options.dryRun) SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function gh600ListInbox_(query) {
  var pageToken = null, scanned = [], pages = 0;
  do {
    var params = {q: query, maxResults: GH600.PAGE_SIZE};
    if (pageToken) params.pageToken = pageToken;
    var page = Gmail.Users.Messages.list('me', params);
    var ids = page.messages || [];
    for (var i = 0; i < ids.length; i++) {
      var msg = Gmail.Users.Messages.get('me', ids[i].id, {
        format: 'metadata', metadataHeaders: [
          'From', 'To', 'Subject', 'Message-ID', 'In-Reply-To', 'References',
          'Auto-Submitted', 'Precedence', 'List-Id'
        ]
      });
      scanned.push(msg);
    }
    pageToken = page.nextPageToken || null;
    pages++;
    if (pageToken && pages >= GH600.PAGE_LIMIT) throw new Error('SCAN_LIMIT: more than 1,000 recent inbox messages; no unsafe cursor skip');
  } while (pageToken);
  return scanned;
}

function gh600Header_(m, name) {
  var headers = ((m || {}).payload || {}).headers || [];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name).toLowerCase() === name.toLowerCase()) return String(headers[i].value || '');
  }
  return '';
}

function gh600Email_(raw) {
  var m = String(raw || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : '';
}

function gh600IsReply_(m) {
  if (!m || !m.id || (m.labelIds || []).indexOf('INBOX') === -1 || (m.labelIds || []).indexOf('SENT') >= 0) return false;
  var sender = gh600Email_(gh600Header_(m, 'From'));
  if (!sender || sender === GH600.MAILBOX || sender.endsWith('@ghoulhouse.fi')) return false;
  var auto = gh600Header_(m, 'Auto-Submitted').trim().toLowerCase();
  if (auto && auto !== 'no') return false;
  if (gh600Header_(m, 'List-Id') || /^(bulk|list|junk)$/i.test(gh600Header_(m, 'Precedence').trim())) return false;
  if (/^(postmaster|mailer-daemon)@/i.test(sender)) return false;
  return !!(gh600Header_(m, 'In-Reply-To') || gh600Header_(m, 'References') || /^\s*(re|vs|aw)\s*:/i.test(gh600Header_(m, 'Subject')));
}

function gh600HasVerifiedOutbound_(m, sender) {
  if (!m.threadId) return false;
  var thread = Gmail.Users.Threads.get('me', m.threadId, {
    format: 'metadata', metadataHeaders: ['From', 'To', 'Cc']
  });
  return (thread.messages || []).some(function(part) {
    return (part.labelIds || []).indexOf('SENT') >= 0 &&
      gh600Email_(gh600Header_(part, 'From')) === GH600.MAILBOX &&
      gh600Header_(part, 'To').split(',').some(function(addr) { return gh600Email_(addr) === sender; });
  });
}

function gh600Safe_(v) {
  var s = String(v == null ? '' : v).slice(0, 450);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function gh600RequireTab_(ss, name) {
  var tab = ss.getSheetByName(name);
  if (!tab) throw new Error('Missing existing CRM tab ' + name);
  return tab;
}

function gh600EnsureEvents_(ss, name) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, GH600.HEADER.length).setValues([GH600.HEADER]);
    sh.setFrozenRows(1);
  } else if (sh.getRange(1, 1).getDisplayValue() !== GH600.HEADER[0]) {
    throw new Error('Unsafe event ledger header mismatch on ' + name);
  }
  return sh;
}

function gh600Rows_(tab, width) {
  var n = tab.getLastRow();
  return n > 1 ? tab.getRange(2, 1, n - 1, width).getValues() : [];
}

function gh600FindEvent_(events, id) {
  var rows = gh600Rows_(events, 13);
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === String(id)) return {row: i + 2, values: rows[i]};
  return null;
}

function gh600Match_(sender, rows) {
  var matches = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (gh600Email_(r[8]) === sender && String(r[32]).toLowerCase() !== 'dq') matches.push({row: i + 2, id: String(r[0]), status: String(r[32]), lastContact: r[33], nextAction: String(r[35] || '')});
  }
  return matches;
}

function gh600Process_(msg, leads, suppress, events, dryRun) {
  var sender = gh600Email_(gh600Header_(msg, 'From'));
  var existing = gh600FindEvent_(events, msg.id);
  if (existing && existing.values[10] !== 'PENDING') return 'DUPLICATE';
  var matches = gh600Match_(sender, gh600Rows_(leads, 36));
  var candidate = matches.length === 1 ? matches[0] : null;
  var blocked = candidate && gh600Rows_(suppress, 9).some(function(r) { return String(r[0]) === candidate.id; });
  var immutable = candidate && ['Hävitty','Voitettu','DQ'].indexOf(candidate.status) >= 0;
  // From-header alone is spoofable; demand an outbound message in this thread sent to this address.
  var outboundOk = candidate && !blocked && !immutable ? gh600HasVerifiedOutbound_(msg, sender) : false;
  var state = !candidate ? 'QUARANTINE' : (blocked || immutable || !outboundOk ? 'HOLD' : 'DONE');
  var now = new Date();
  var received = msg.internalDate ? new Date(Number(msg.internalDate)) : now;
  var eventRow = [String(msg.id), gh600Header_(msg, 'Message-ID'), String(msg.threadId || ''), GH600.MAILBOX,
    received.toISOString(), sender, gh600Safe_(gh600Header_(msg, 'Subject')), candidate ? candidate.id : '',
    candidate ? candidate.row : '', matches.length > 1 ? 'MULTIPLE_EMAIL_MATCHES' : (candidate ? (blocked ? 'SUPPRESSED' : (immutable ? 'IMMUTABLE_STATUS' : (!outboundOk ? 'NO_VERIFIED_OUTBOUND_IN_THREAD' : 'REPLY_RECEIVED'))) : 'NO_EXACT_MATCH'),
    state === 'DONE' ? 'PENDING' : state, now.toISOString(), state === 'DONE' ? '' : 'No automatic production CRM stage update'];
  if (dryRun) return existing ? 'DUPLICATE' : state;
  if (!existing) {
    events.appendRow(eventRow);
    SpreadsheetApp.flush();
    existing = gh600FindEvent_(events, msg.id);
    if (!existing) throw new Error('Ledger append not visible for ' + msg.id);
  }
  if (state !== 'DONE') {
    events.getRange(existing.row, 11).setValue(state);
    return state;
  }
  // Resume-safe: if earlier run crashed after PENDING insert, recheck the live row.
  var cur = leads.getRange(candidate.row, 1, 1, 36).getValues()[0];
  if (String(cur[0]) !== candidate.id || gh600Email_(cur[8]) !== sender) {
    events.getRange(existing.row, 11).setValue('HOLD');
    events.getRange(existing.row, 13).setValue('Lead changed during processing');
    return 'HOLD';
  }
  var currentStatus = String(cur[32] || '');
  if (['DQ','Hävitty','Voitettu'].indexOf(currentStatus) >= 0) {
    events.getRange(existing.row, 11).setValue('HOLD');
    return 'HOLD';
  }
  // Stage and last-contact update are replay-idempotent; never lower later stages.
  if (currentStatus === '' || currentStatus === 'Uusi' || currentStatus === 'Ei soitettu') leads.getRange(candidate.row, 33).setValue('Kontaktoitu');
  var day = Utilities.formatDate(received, 'Europe/Helsinki', 'yyyy-MM-dd');
  var old = cur[33] instanceof Date ? Utilities.formatDate(cur[33], 'Europe/Helsinki', 'yyyy-MM-dd') : String(cur[33] || '');
  if (!old || old <= day) leads.getRange(candidate.row, 34).setValue(day);
  if (!cur[35]) leads.getRange(candidate.row, 36).setValue('REVIEW GMAIL REPLY — ' + String(msg.id));
  SpreadsheetApp.flush();
  events.getRange(existing.row, 11).setValue('DONE');
  events.getRange(existing.row, 13).setValue('Exact email matched; safe row fields updated');
  return 'DONE';
}

function gh600AssertAccount_() {
  var user = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (user !== GH600.MAILBOX) throw new Error('Run as ' + GH600.MAILBOX + ', got ' + (user || 'unknown'));
}

/** Real isolated test: one Gmail message from the user's own secondary mailbox -> test-only Sheets rows -> reprocess. */
function gh600RunAuthenticatedE2E() {
  gh600AssertAccount_();
  var p = PropertiesService.getScriptProperties();
  var sid = p.getProperty('GH600_SPREADSHEET_ID');
  var id = p.getProperty('GH600_E2E_MESSAGE_ID');
  var from = String(p.getProperty('GH600_E2E_SENDER') || '').toLowerCase();
  if (!sid || !id || !from) throw new Error('Set spreadsheet ID, E2E message ID and E2E sender properties');
  if (from !== 'visualjambo@gmail.com') throw new Error('E2E restricted to owned secondary mailbox');
  var msg = Gmail.Users.Messages.get('me', id, {format: 'metadata', metadataHeaders: ['From','Subject','Message-ID','In-Reply-To','References','Auto-Submitted','List-Id','Precedence']});
  if (gh600Email_(gh600Header_(msg, 'From')) !== from || !gh600IsReply_(msg)) throw new Error('E2E message does not qualify as real received reply from controlled sender');
  var ss = SpreadsheetApp.openById(sid);
  var master = gh600RequireTab_(ss, GH600.MASTER);
  var suppress = gh600RequireTab_(ss, GH600.SUPPRESSION);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var testLeads = ss.getSheetByName(GH600.TEST_LEADS) || ss.insertSheet(GH600.TEST_LEADS);
    var testEvents = gh600EnsureEvents_(ss, GH600.TEST_EVENTS);
    if (testLeads.getLastRow() === 0) {
      testLeads.getRange(1, 1, 1, 49).setValues(master.getRange(1, 1, 1, 49).getValues());
      var row = Array(49).fill('');
      row[0] = 'GH600-E2E-OWNED'; row[1] = 'Internal controlled E2E fixture'; row[8] = from; row[32] = 'Uusi';
      testLeads.getRange(2, 1, 1, 49).setValues([row]);
    }
    if (String(testLeads.getRange(2, 1).getValue()) !== 'GH600-E2E-OWNED' ||
        gh600Email_(testLeads.getRange(2, 9).getValue()) !== from) {
      throw new Error('E2E test lead fixture mismatch');
    }
    if (gh600FindEvent_(testEvents, id)) throw new Error('E2E requires a fresh internal reply ID');
    // Reset the isolated fixture; prior manual E2E may leave it already CONTACTED.
    testLeads.getRange(2, 33, 1, 4).setValues([['Uusi', '', '', '']]);
    SpreadsheetApp.flush();
    var first = gh600Process_(msg, testLeads, suppress, testEvents, false);
    var n1 = gh600Rows_(testEvents, 13).filter(function(x) {return String(x[0]) === id;}).length;
    var firstFields = testLeads.getRange(2, 33, 1, 4).getValues()[0];
    var stagePassed = String(firstFields[0]) === 'Kontaktoitu' && String(firstFields[3]).indexOf(id) >= 0;
    var before = JSON.stringify(testLeads.getRange(2, 33, 1, 4).getValues());
    var second = gh600Process_(msg, testLeads, suppress, testEvents, false);
    var n2 = gh600Rows_(testEvents, 13).filter(function(x) {return String(x[0]) === id;}).length;
    var after = JSON.stringify(testLeads.getRange(2, 33, 1, 4).getValues());
    var pass = first === 'DONE' && stagePassed && second === 'DUPLICATE' && n1 === 1 && n2 === 1 && before === after;
    if (!pass) throw new Error('E2E FAIL: '+JSON.stringify({first:first,second:second,n1:n1,n2:n2,before:before,after:after}));
    p.setProperty('GH600_E2E_PASS', 'true');
    return {result:'PASS',liveGmailId:id,first:first,second:second,eventRows:n2,productionMasterUntouched:true};
  } finally {SpreadsheetApp.flush();lock.releaseLock();}
}