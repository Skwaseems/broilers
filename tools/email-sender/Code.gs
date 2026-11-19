// Sharhan Broilers email sender (Google Apps Script, in the business Gmail account).
// Every minute it sends the emails the Worker queued in Firestore email_queue (order copies first,
// then catalogues) from this Gmail account, and marks each one sent or failed. It signs in to
// Firestore as this account (a project Owner), so no password or key is stored anywhere.
// Setup (once): paste this file and appsscript.json into a new project at script.google.com,
// then run setup() and allow the permissions it asks for.

var PROJECT = 'sharhan-broilers';
var BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
var BATCH = 20; // per run; Gmail allows about 100 emails a day on a free account

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(1).create();
  run();
}

function call_(method, url, body) {
  var res = UrlFetchApp.fetch(url, {
    method: method,
    contentType: 'application/json',
    payload: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': PROJECT },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText() || '{}');
}

function str_(f, k) { return f[k] && f[k].stringValue != null ? f[k].stringValue : ''; }

function mark_(name, fields) {
  var mask = Object.keys(fields).map(function (k) { return 'updateMask.fieldPaths=' + k; }).join('&');
  var body = { fields: {} };
  Object.keys(fields).forEach(function (k) { body.fields[k] = { stringValue: String(fields[k]) }; });
  call_('patch', 'https://firestore.googleapis.com/v1/' + name + '?' + mask, body);
}

function run() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  var sent = 0, failed = 0, error = '';
  try {
    var rows = call_('post', BASE + ':runQuery', { structuredQuery: {
      from: [{ collectionId: 'email_queue' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'queued' } } },
      limit: 100
    } }).filter(function (r) { return r.document; }).map(function (r) { return r.document; });
    var prio = function (d) { var p = d.fields.priority || {}; var v = p.integerValue != null ? p.integerValue : p.doubleValue; return v == null ? 1 : Number(v); };
    rows.sort(function (a, b) {
      var pa = prio(a), pb = prio(b);
      return pa - pb || str_(a.fields, 'createdAt').localeCompare(str_(b.fields, 'createdAt'));
    });
    for (var i = 0; i < rows.length && i < BATCH; i++) {
      if (MailApp.getRemainingDailyQuota() < 1) break; // the rest wait for tomorrow
      var f = rows[i].fields;
      try {
        // body: the plain-text copy (mail with only HTML looks like spam); htmlBody: what most apps show.
        MailApp.sendEmail({ to: str_(f, 'to'), subject: str_(f, 'subject'), body: str_(f, 'text') || 'Sharhan Broilers', htmlBody: str_(f, 'html'), name: 'Sharhan Broilers' });
        mark_(rows[i].name, { status: 'sent', sentAt: new Date().toISOString() });
        sent++;
      } catch (e) {
        mark_(rows[i].name, { status: 'failed', error: String(e.message || e).slice(0, 300), sentAt: new Date().toISOString() });
        failed++;
      }
    }
  } catch (e) {
    error = String(e.message || e).slice(0, 300);
  } finally {
    try {
      call_('patch', BASE + '/settings/email_status', { fields: {
        lastRun: { stringValue: new Date().toISOString() },
        left: { integerValue: String(MailApp.getRemainingDailyQuota()) },
        error: { stringValue: error },
        account: { stringValue: Session.getEffectiveUser().getEmail() }
      } });
    } catch (e) {}
    lock.releaseLock();
  }
}
