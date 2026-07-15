/**
 * Roizin Jewelry — Google Sheet mirror (reporting only).
 *
 * This is OPTIONAL. Cross-device sync runs entirely on the Vercel/Neon
 * backend at /api/sync. This script only mirrors each write into a Google
 * Sheet so you have a spreadsheet for reporting/exports.
 *
 * SETUP
 * 1. Create a new Google Sheet.
 * 2. Extensions -> Apps Script. Paste this file in as Code.gs.
 * 3. Deploy -> New deployment -> Web app.
 *      Execute as: Me.   Who has access: Anyone.
 * 4. Copy the /exec URL.
 * 5. In your Vercel project, add an environment variable:
 *      GOOGLE_SHEET_WEBHOOK_URL = <the /exec URL>
 *    Redeploy. From then on every save in the app is appended here.
 *
 * Each "store" (clients, transactions, lots, etc.) gets its own tab.
 */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var p = body.payload || {};
    var store = p.store || "unknown";
    var record = p.record || {};

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(store);
    if (!sheet) {
      sheet = ss.insertSheet(store);
      sheet.appendRow(["_syncedAt", "_id", "_deleted", "json"]);
    }

    sheet.appendRow([
      new Date(),
      String(p.id != null ? p.id : ""),
      p.deleted ? "DELETED" : "",
      JSON.stringify(record),
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, info: "Roizin Sheet mirror is live." }))
    .setMimeType(ContentService.MimeType.JSON);
}
