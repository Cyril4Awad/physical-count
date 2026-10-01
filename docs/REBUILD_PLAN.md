# Rebuild Plan — Physical Count native Android app (NativeScript + React, direct SOAP)

Inputs: `LEGACY_ANALYSIS.md`, the SOAP samples and WSDL in `docs/service-samples/`, and the service source (`D:\dev\reference\ERPDataCollectorWebService`, read-only).
Earlier designs are kept unchanged: the web app + .NET SOAP adapter in `REBUILD_PLAN_WEB_ADAPTER.md`, and the direct-database design in `REBUILD_PLAN_DIRECT_DB.md`. The service contract confirmed there is carried over in §8 of this plan.

**Status:** step 1 (parser + SQLite spike, §14) is built and passing on the emulator; no screens yet. The project at `D:\dev\physical-count` started from the NativeScript 9.1.1 + React "Hello World" template.

Items marked **to confirm** are open questions. They are collected in §13.

---

## 0. Ground rules

| # | Rule | Where |
|---|---|---|
| C1 | **`Service1.asmx` stays exactly as it is and is never modified** | whole plan |
| C2 | The app calls `Service1.asmx` **directly over SOAP 1.1, as the old Android app did**: `InitPullTables`, `pullRecords`, `InsertDetail`, same parameters, same responses. Envelopes are built by hand. There is **no backend and no web frontend** | §3 |
| C3 | Each location has its own IIS and service. The device keeps **one profile per location** (location code + server address, one selected), as legacy Settings did | §2.2, §4.1 |
| C4 | Local **SQLite, one database per location** (`ERPDataCollectorNDB_<loc>`), tables `phyHeader`, `phyDetails`, `phyBarcodes`, line state `0/1/2`. **One downloaded count per location** | §4 |
| D1 | Exact lookup order: **exact barcode → reference prefix → QR** | §5.2 |
| D2 | Keep the prefix-match behaviour (a single prefix match counts automatically) | §5.2 |
| D3 | No new server tables. The service is unchanged (C1) | — |
| D4 | No login. The machine name is **typed by hand** | §2.2 |
| D5 | Fix the "Incorrect Qty" lock at 10000+ | §5.3 |
| D6 | Beep on a good scan; a **different tone** for not found | §5.4 |
| D7 | Rows are inserted with **bound parameters**. The SQL text the service sends (`InsertInto`, `CreateTable`, `valuesquery`) is **parsed as data and never executed**. No SQL string is ever built from a server value or from user input | §3.5, §4.3 |
| D8 | Warn before a download would discard counted lines that were not uploaded: **"Upload first"**, **"Discard N counted lines and download"**, **"Cancel"** | §6.1 |
| D9 | The app **enforces the input checks itself** (§3.7), because no backend sits between the device and a service that concatenates every parameter into SQL (§8, S20) | §3.7 |

**Shape of the system.**

```
Handheld (NativeScript 9 + React, Android)                       Existing, unchanged, one per location
Settings SQLite: profiles (loc + server), one selected
Location SQLite ERPDataCollectorNDB_<loc>:            SOAP 1.1 over http://
  phyHeader, phyDetails, phyBarcodes, tblPullStatus,  ⇄  http://<server>/ERPDataCollector/Service1.asmx
  stg_* (staged download)                                (reads/writes that location's ERP database)
counting runs offline
```

The device holds the downloaded count and the counted totals, and uploads later, exactly as the legacy app did.

---

## 1. What changes from the web-adapter plan

| Removed | Replaced by |
|---|---|
| .NET backend adapter and its JSON endpoints | The app's own SOAP client (§3) |
| HMAC-signed pull tokens | `TableName` stored locally in `tblPullStatus` and checked against a strict pattern before every `pullRecords` (§3.7) |
| Server URL map in backend config | Server address per location profile in Settings (§2.2) |
| IndexedDB, localStorage | SQLite (§4) and `ApplicationSettings` for two global values |
| Service worker, PWA, HTTPS notes | Native APK; plain `http://` allowed to any host, like the legacy app (§9.1) |
| Backend deployment | Release APK, sideloaded (§11) |
| X1 (API login) and the Login page | Nothing. No login, as legacy (D4) |
| Web Audio beep | Android `ToneGenerator` (§5.4) |
| `inputmode="none"` | Native `EditText` with the soft keyboard suppressed (§9.3) |

Everything else in that plan (service contract, parser design, lookup order, count rules, D5, D8, staged download, resume, upload rules, input checks) is kept and adapted below.

---

## 2. Screens

All screens are native NativeScript views rendered by React (`react-nativescript`). Portrait, sized for a ~360–480 dp wide handheld.

### 2.1 Screen map

| Legacy screen | New screen | Notes |
|---|---|---|
| `MainActivity` | **Home** | Header: active location, server, machine name (**the one stored with the sheet**, `tblSheet.MachineName`, because that decides the upload slot; the Settings name when there is no sheet), count number, warehouse, date. Counters: not counted / counted-pending / uploaded. A **Last upload** line (date, time, lines sent in that run; §6.2) when the sheet has one. Five buttons: **Scan**, **Items**, **Download**, **Upload**, **Settings**. Scan, Items and Upload are disabled until the location has a complete sheet (legacy rule). If no profile is selected, Home shows only Settings and a hint (legacy auto-opened Settings; the new app never closes itself). |
| `MainActivity` count-number dialog + `Synchronize` (download) | **Download** | Step 1: count number (numeric keypad). Step 2: D8 check (§6.1). Step 3: one progress bar per table, labelled with `PullDisplayHeader`, rows x / y, elapsed time, **Cancel**. When a partial download exists: **Continue download** / **Restart download** / **Abandon download** (§6.1). |
| `Synchronize` (upload) | **Upload** | "This Physical Count Contains N Items. Upload?", then "Row x / N", **Cancel**, and a result (sent, failed line, message). |
| `BarcodeScan` | **Scan** | Scan field (§9.3), line details (Id, Reference, Description, Colour, Expiry, Lot, Avlb Qty), **Total Qty Scanned** + **Update Total Scanned**, **Last Scanned** + **Update Last Scan Qty**, **Cancel Last Scan**, status line, sound. Opened from Items with a line id → display only, no increment (legacy). |
| `MultiSearchActivity` | **Pick item** pop-up on Scan | Opens when the prefix search matches more than one line. Search box pre-filled with the scan, re-filters on every keystroke (prefix, §5.2). Tapping a line counts +1, as legacy. Closing it returns focus to the scan field. **Each row** (step 8): bold first line **Lot · Expiry**, the line id as small muted text, then the reference, the description and the line's current counted total. With `SP_Expiry='N'` the lot and expiry are hidden and the reference is the bold line. The list is ordered by **expiry, oldest first, then `RowNumber`** (lines without a readable expiry last; a month-only expiry `MM.YYYY` sorts before the days of that month); with expiry hidden, by `RowNumber`. The sort happens in SQLite before the 100-row limit. Row texts come from `domain/itemText.ts` (`pickRowText`), pinned by Node tests. |
| `ViewOptions` + `ViewItems` | **Items** | Two tabs: **Counted** (`updated='1'`) and **Not counted** (`updated='0'`), each with its number in the tab label. Uploaded lines (`'2'`) stay hidden, as legacy. Virtualised `ListView`. Tapping a row opens Scan in display mode. Expiry and Lot hidden when `SP_Expiry='N'`. Details in §2.3. |
| `Settings` + `ServerSettingsActivity` + `ConfigurationSettingsList` | **Settings** | See §2.2. |
| `ListNotScannedItems` | *(dropped)* | Dead code in legacy. |

### 2.2 Settings

One screen with three parts:

1. **Location profiles** — a list of saved profiles (Location code, Server address, a mark on the selected one), plus **Add**, **Edit**, **Delete**, and **Select** (tap a row). Selecting a profile switches the whole app to that location's database, exactly as legacy `ConfigurationSettingsList` did. A handheld is moved between locations by selecting another profile.
   - **Location code:** 1–2 letters/digits (§3.7), **kept exactly as typed**, like the legacy app: it is sent to the service and used in the database file name (`ERPDataCollectorNDB_<code as typed>`) without upper-casing. The case-insensitive uniqueness check is only a guard against adding the same location twice (`V2` and `v2`).
   - **Server address:** host or `host:port`, **without** `http://` and without a path (legacy format). The app builds `http://<server>/ERPDataCollector/Service1.asmx`.
   - A **Test connection** button sends a GET for `…/Service1.asmx?WSDL` and reports reachable / not reachable (it does not call any method, so nothing is written on the server).
   - Delete asks for confirmation. If the location database still has counted lines not uploaded (`updated='1'`), the message says so and names the number. Deleting a profile **does not delete its database**; re-adding the same location finds it again.
2. **Device** — **Machine name** (typed by hand, D4; 1–5 letters/digits, §3.7) and **Download page size** (default **1000**, adjustable 1–5000; an empty field is rejected, not a crash). Legacy used 5000; the smaller default keeps each page's UI pause short (Q13). Both are global, not per profile, as in legacy preferences. Changing the machine name while the selected location has a complete or partial download shows a warning, because the sheet was downloaded for the old name's slot (`UserToUpdate`).
3. **Restore uploaded** — confirmation, then `UPDATE phyDetails SET updated='1' WHERE updated='2'` on the selected location's DB. Disabled when there is no sheet. Safe because the service replaces values (S2, S3).
4. **Advanced** (step 8) — one switch, **Scanner input: Key events / Text input** (§9.3). Key events is the default. Stored at once in `ApplicationSettings` (`scannerInput`, global like the machine name) and applied the next time Scan opens.

Debug builds also show **Debug tools** (never in a release build, §14 step 6): mark N lines as counted, mark N counted lines as uploaded (`updated='2'`, nothing is sent), open a line in Scan.

### 2.3 Items (step 8)

- **Tabs:** `Counted (n)` = `updated='1'`, `Not counted (n)` = `updated='0'`; the numbers are the Home counters ("counted, not uploaded" and "not counted"). Uploaded lines are in neither list.
- **Row:** reference (bold), description, and on the right the counted total (Counted tab) or the available quantity `Pcd_Qty` (Not counted tab), both formatted like Scan (no trailing zeros). A third line shows expiry and lot unless `SP_Expiry='N'`. Order: `RowNumber`.
- **Paging:** the list is a native `ListView` whose `items` is a `PagedList` (`domain/pagedList.ts`): it knows the total and loads 100-row pages from SQLite on demand (`LocationDb.listLines(state, offset, limit)`), reads one page ahead in the scroll direction, loads one page at a time taking the most recently requested first (so a fling skips the pages it passed), and keeps at most 6 pages (600 lines) in memory. A row whose page has not arrived shows `…` and is redrawn when it does.
- **Rows are plain NativeScript views** (`platform/itemCell.ts`), created once and re-bound by setting label texts; no React render per row.
- **Open a line:** tapping a row writes the tab and scroll position (first visible row + pixel offset) into the Items route, then pushes Scan with the line id (display mode, no count). Back pops to Items, which re-reads the counters and restores the tab and position. Each tab also keeps its own position while the screen is open.
- **Empty and blocked states:** one sentence per empty tab; "No count has been downloaded for this location yet…" when there is no sheet; the download-in-progress message while one runs. Home only enables Items with a complete sheet and no download (§5.1); the screen checks again itself.

---

## 3. SOAP client

### 3.1 Mechanics (confirmed from the WSDL)

| Item | Value |
|---|---|
| Endpoint | `http://<server>/ERPDataCollector/Service1.asmx` from the selected profile |
| Transport | `Http.request` from `@nativescript/core`, `method: 'POST'`, `timeout` in ms. Response body read as text (`response.content.toString()`) |
| Headers | `Content-Type: text/xml; charset=utf-8`, `SOAPAction: "http://tempuri.org/<Method>"` (quoted, as .NET ASMX expects) |
| Envelope | `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Method xmlns="http://tempuri.org/"><Param>value</Param>…</Method></soap:Body></soap:Envelope>` — the exact form of the saved request samples. Parameters in WSDL order. Every value is a string, XML-escaped (`& < > " '`); that is the only transformation |
| Timeouts | 30 s (legacy) for `pullRecords` and `InsertDetail`; `InitPullTables` 120 s by default, because it builds staging tables for the whole count (**to confirm** real duration on a 39k-line count). Both are constants in one config module |
| Threading | `Http.request` runs off the UI thread. XML parsing and SQLite inserts run on the JS thread between pages, with the progress bar updated per page (§6.1). Step 1 measured ~2 s of blocked UI per 5000-row page on the emulator, so the default page size is 1000 and step 3 compares the plugin's background-thread option (Q13) |

**Envelope builder** — one pure function per method, no NativeScript imports, unit-tested byte-for-byte against the `*.request.xml` samples (after normalising the `DeviceInfo` text).

**Response reading** — one pure function per method. XML is parsed with **`fast-xml-parser`** (pure JS, current major 5.x, pinned exactly), because NativeScript has no `DOMParser` and the same code must run in Node unit tests and on the device. Required options: `removeNSPrefix: true`, `ignoreAttributes: true`, **`parseTagValue: false`** (otherwise `'5285002192105'`-style values and `"0"` become numbers), `trimValues: true` (only whitespace around a whole element text is trimmed; every service value sits inside quotes, and pretty-printed XML would otherwise leave whitespace text nodes), `processEntities: true` with `htmlEntities: true` for numeric character references (checked in step 1), and `isArray` for `TableInfo` and `Record` so one-element lists stay lists. Values are read by element name (`InitPullTablesResult/mTableInfo/TableInfo[]`, `pullRecordsResult/mRecords/Record[]/valuesquery`, `InsertDetailResult`).

### 3.2 Outcomes

| SOAP-side outcome | App result |
|---|---|
| HTTP 200, normal body | parsed result |
| `pullRecordsResult` without `mRecords` (`<pullRecordsResult />`) | `noResults` (also what a swallowed server error looks like, S12) |
| `InitPullTablesResult` without `mTableInfo` | `noResults` → *"No Data Found."* |
| SOAP Fault (malformed request only) | error "Service fault: <faultstring>" |
| HTTP error status, connection refused, DNS failure | error "Cannot reach the server at <server>" + the technical text in a details line |
| Timeout | error "The server did not answer in N s" |
| Unparseable body (§3.5) | error "Unexpected answer from the server"; the whole page is rejected, no partial rows stored |

### 3.3 `InitPullTables` — start a download

Called **only after the D8 check** (§6.1), because it drops and rebuilds this location + machine's staging tables on the server (S8).

| SOAP parameter (WSDL order) | Value |
|---|---|
| `ApplicationName` | constant `ERPDATACOLLECTOR` |
| `SelectedLocation` | selected profile's location code |
| `MachineName` | machine name from Settings |
| `Extras` | the count number typed on Download |
| `DeviceInfo` | `Device Model: <Build.MODEL>\nDevice Manufacturer: <Build.MANUFACTURER>\nDevice Brand: <Build.BRAND>\n` (legacy format; ignored by the service, S16) |

Reading the response (samples `InitPullTables.*.response.xml`):
1. `TableInfo[]`, each with `TableName, RowsCount, OriginalTableName, LastImportedRow, PullDisplayHeader, InsertInto, PullFinished, PullPreparedDT, SelectedLocation, MachineName, CreateTable, Notes`.
2. Keep records where `SelectedLocation` and `MachineName` equal what was sent (legacy filter; the service echoes both).
3. Check each `TableName` against the pattern in §3.7 and each `OriginalTableName` against `phyHeader | phyDetails | phyBarcodes`. Any failure rejects the download.
4. Parse the column list out of `InsertInto` (§3.5.1). `CreateTable` is only used as a cross-check of the column names; it is **never executed**.
5. **Not downloadable** — no `phyDetails` record, **or** `phyHeader.RowsCount = 0` → *"Selected Inventory Not Download Or Does Not Exist!!!"* with the likely causes: wrong count number, count cancelled or already posted, count belongs to another location, or this machine name is not one of the count's machine users (samples `…count999999-not-found…`, `…machine-not-assigned…`). Nothing local changes.
   - **Step 6 refinement:** the two conditions are told apart. `phyHeader.RowsCount = 0` (or no header) is the legacy "not downloadable" case above. A header **with** `RowsCount ≥ 1` but **no `phyDetails` table** means the service found the count and then failed while preparing its lines; it swallows its errors (S12), and on the local server this was a SQL timeout (30 s, `RESOURCE_SEMAPHORE` memory-grant wait). The screen then says *"The server found count N but did not send its lines (it answered after X s)… Try again"* instead of listing causes that do not apply (`ManifestResult.reason = 'incomplete'`).
   - **Step 7 refinement:** "incomplete" is used **only when the answer has no `phyDetails` entry at all**. A `phyDetails` entry with `RowsCount = 0` means the count has no lines: the screen says *"This count has no lines…"* and nothing is downloaded (`reason = 'noLines'`). `phyBarcodes` with 0 rows is normal; the download summary then adds *"This count has no barcodes. Scanning product barcodes won't find items; use the reference or the QR sticker."*
6. Otherwise write the manifest to `tblPullStatus` (§4.2) and start paging.

### 3.4 `pullRecords` — one page of one table

| SOAP parameter | Value |
|---|---|
| `TableName` | from `tblPullStatus`, re-checked against §3.7 before every call |
| `PIndex` | constant `0` (ignored by the service when `StartFromRow` is set, S13) |
| `PSize` | download page size from Settings |
| `StartFromRow` | `rowsStored + 1` (1-based, inclusive, S13) |

Reading the response: one `valuesquery` per `Record`; tokenize (§3.5.2), check the value count equals the column count, sort by `RowNumber` (the service has no `ORDER BY`), drop any `RowNumber` already stored (resume de-duplication), insert (§4.3).

**Stop rule (fixes the legacy infinite loop):** a table is complete when stored rows ≥ `RowsCount`. If a page comes back `noResults`, empty, or adds no new `RowNumber` while stored rows < `RowsCount`, the download stops with *"Server returned x of y rows — restart download"* (e.g. another device with the same location + machine name ran `InitPullTables` meanwhile, S8). A table with `RowsCount = 0` is complete without any call.

### 3.5 Parsing the service's SQL strings (parse only, never execute)

#### 3.5.1 Column list from `InsertInto`
Built by the service as `"Insert Into " & OriginalTableName & "(" & cols & ") Values"` (S10). Exact strings:

| Table | `InsertInto` |
|---|---|
| phyHeader | `Insert Into phyHeader(RowNumber,Pch_Recid,Warehouse,Pch_DateCount,Pch_MachUser1,Pch_MachUser2,Pch_MachUser3,Pch_MachUser4,Pch_MachUser5,Pch_MachUser6,Pch_Status,Pch_Updated,Pch_NbrItems,UserToUpdate,SP_DecNo,SP_Fashion,SP_Expiry,updated,InvID) Values` |
| phyDetails | `Insert Into phyDetails(RowNumber,Pcd_RecId,Pcd_Loc,Pcd_stkId,Refernce,stk_Desc,Pcd_Grid,Pcd_DetGrid,Pcd_Color,Color_Desc,exp,Pcd_Batch,Pcd_DateCount,Pcd_Qty,Pcd_QtyCounted1,Pcd_Type1,Pcd_QtyCounted2,Pcd_Type2,Pcd_QtyCounted3,Pcd_Type3,Pcd_QtyCounted4,Pcd_Type4,Pcd_QtyCounted5,Pcd_Type5,Pcd_QtyCounted6,Pcd_Type6,usercounted,updated) Values` |
| phyBarcodes | `Insert Into phyBarcodes(RowNumber,PcBarc_RecId,PcBarc_DRecId,PcBarc_Barcode,updated) Values` |

Rule: case-insensitive `^\s*Insert\s+Into\s+(\w+)\s*\((.*)\)\s*Values\s*$`; group 1 must equal `OriginalTableName`; split group 2 on `,`, trim; every name must match `^[A-Za-z_][A-Za-z0-9_]*$`.
**The parsed list must be exactly the app's known column list for that table** (same names, any order, no extras, none missing, compared case-insensitively). The list is then used **only to map value positions to the app's own column constants**; the INSERT statement text is built from the app's constants, never from server text (D7). A mismatch rejects the download at the start with *"The service's table layout has changed"*.

#### 3.5.2 Tokenizing one `valuesquery`
Built by the service in `GetInsertValuesSqlQuery` (S11): every value single-quoted (numbers too), apostrophes removed from text (so `''` escapes never occur), NULL → `''`, numbers as `cast(… as nvarchar(18))` (e.g. `'0.000'`), datetimes as SQL Server default text (`'Dec 31 2022 12:00AM'`).

Tokenizer: a state machine expecting `'` … `'`, then `,` or end of string, repeated; whitespace outside quotes ignored. An unquoted token, an unterminated quote, or a stray character is a parse error and the **whole page is rejected**. Commas, parentheses and Unicode inside quotes are literal. After tokenizing, a `'` can never appear in a value; if the service ever changed and one appeared, it would only be data, because values are bound parameters.

#### 3.5.3 Safety
Nothing from these strings is executed. Limits: maximum response size (default 20 MB), maximum values per row (column count), maximum value length (4000, the staging column width).

### 3.6 Rows → local columns

Local tables use the **legacy column names** (§4.2), so the mapping is 1:1 by name. Rules on top:

| Column | Rule |
|---|---|
| `RowNumber` | integer, required, > 0; used for order, resume and de-duplication |
| `Pcd_RecId` | digits (§3.7); unique in the sheet. A duplicate rejects the download |
| `Refernce` | stored as received; prefix search is case-insensitive (§5.2) |
| `exp` | stored **as received** (`DD.MM.YYYY` or `MM.YYYY`), used verbatim by the QR match (§5.2) |
| `Pcd_Qty` | decimal text; `0` when the service hides quantities |
| `usercounted` | decimal text (`'0.000'`, `'7.000'`): **this machine's current value on the server** (S14), so counting continues from what was already uploaded |
| `updated` | always `'0'` from the service; this is the line state `0/1/2` |
| `_id` | not in the values; SQLite assigns it in `RowNumber` order. Only sent as `InsertDetail.id`, which the service ignores (S5) |
| `PcBarc_Barcode` | stored trimmed; rows with an empty barcode are stored but can never match (an empty scan is ignored) |
| header `UserToUpdate` | must be `1`–`6`, else the download is rejected |
| header `SP_DecNo` | **the number of allowed decimals** for quantities (`0` = whole numbers). Must be digits; NULL arrives as `0` (S15) |
| header `SP_Expiry` | `N` hides Expiry and Lot |
| header `SP_Fashion` | stored, not used (legacy) |

**`usercounted` on upload:** invariant format, `.` decimal separator, at least one decimal digit (`12` → `12.0`), no exponent, no thousands separators, never more than the allowed decimals (S6).

### 3.7 Input checks enforced in the app (D9)

The service concatenates every parameter into SQL (S20), and nothing sits between the device and the service, so these checks are done in the app **before any call**. A value that fails is refused with a message and the service is not called. The same checks run when a value is typed (Settings, Download) and again right before the SOAP call.

| Value | Rule |
|---|---|
| Location code | `^[A-Za-z0-9]{1,2}$` |
| Server address | `^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$`, port 1–65535, no empty dot-separated part, no part starting or ending with `-`. A typed `http://` or path gets its own message. Format check only; any host is accepted (§9.1) |
| Machine name | `^[A-Za-z0-9]{1,5}$` (the width of `Pch_MachUserN`, S17) |
| Count number (`Extras`, `uInvID`) | `^[0-9]{1,18}$` |
| `Pcd_RecId` | `^[0-9]{1,18}$`, and it must exist in the local sheet (S21) |
| `UserToUpdate` | `^[1-6]$` |
| `transCount` | integer ≥ 1; every upload run starts at 1 (S21) |
| `usercounted` | finite, ≥ 0, **at most 3 decimals regardless of `SP_DecNo`** (the server column holds 3; Q14), at most 99,999,999,999,999.999 (S19). `SP_DecNo` limits only what the operator types (§5.3) |

Where the checks live (step 2): `domain/validation.ts` (codes, names, numbers, page size, server address), `domain/decimal.ts` (quantities), `parse/manifest.ts` (exact `TableName`). The request builders in `soap/envelopes.ts` run the checks again and throw instead of building a request, so an unchecked value can never reach an envelope. The location code is used exactly as typed (no trimming); the count number and page size are trimmed.
| `TableName` | `^_ERPDATACOLLECTOR_tbl_PhysicalCount(Header|Detail|DetBarcode)_` + location code + machine name + `$` (case-insensitive), and the table kind must fit its `OriginalTableName` |
| Page size | integer 1–5000 (default 1000) |

---

## 4. Local storage (SQLite)

### 4.1 Databases

| File | Contents |
|---|---|
| `PhysicalCountSettings` | `tblProfiles(_id INTEGER PRIMARY KEY, LocCode TEXT NOT NULL, ServerAddress TEXT NOT NULL, Selected INTEGER NOT NULL DEFAULT 0)`, unique index on `LocCode COLLATE NOCASE`. Exactly one or zero rows have `Selected = 1`, enforced by doing the switch in one transaction and by a partial unique index (`ON tblProfiles(Selected) WHERE Selected = 1`). Deleting the selected profile leaves none selected |
| `ERPDataCollectorNDB_<LocCode>` | one per location, created on first use (§4.2); `<LocCode>` exactly as typed in the profile, no case change |
| `ApplicationSettings` (key/value, `@nativescript/core`) | `machineName`, `downloadPageSize` |

Opening: the app keeps one open connection to the settings DB and one to the selected location's DB; switching profile closes one and opens the other.

### 4.2 Location database schema

Created by the app from its own constants (never from the service's `CreateTable`). All legacy columns are `TEXT` except `_id` and `RowNumber`, matching the service's `CreateTable` so the data looks the same as on the legacy device.

- `phyHeader(_id INTEGER PRIMARY KEY, RowNumber INTEGER NOT NULL, <the 18 other phyHeader columns> TEXT)`
- `phyDetails(_id INTEGER PRIMARY KEY, RowNumber INTEGER NOT NULL, <the 27 other phyDetails columns> TEXT)`; `updated` is the line state: `'0'` not counted, `'1'` counted and pending upload, `'2'` uploaded
- `phyBarcodes(_id INTEGER PRIMARY KEY, RowNumber INTEGER NOT NULL, PcBarc_RecId TEXT, PcBarc_DRecId TEXT, PcBarc_Barcode TEXT, updated TEXT)`
- `stg_phyHeader`, `stg_phyDetails`, `stg_phyBarcodes`: same shapes, used only while a download is in progress
- `tblPullStatus(_id INTEGER PRIMARY KEY, CountNumber TEXT, SelectedLocation TEXT, MachineName TEXT, TableName TEXT, OriginalTableName TEXT, PullDisplayHeader TEXT, RowsCount INTEGER, RowsStored INTEGER, PullFinished INTEGER, Columns TEXT /* JSON array of parsed names */, StartedAt TEXT)` — the manifest of the **download in progress**; empty when none
- `tblSheet(_id INTEGER PRIMARY KEY CHECK (_id = 1), CountNumber TEXT, MachineName TEXT, DownloadedAt TEXT, LastUploadAt TEXT, LastUploadLines INTEGER)` — which count the live tables hold, for which machine name, and its last upload (the last two columns from schema version 3)

Indexes: `phyDetails(Pcd_RecId)` unique; `phyDetails(Refernce COLLATE NOCASE)`; `phyDetails(updated)`; `phyDetails(Pcd_stkId, exp, Pcd_Batch)`; `phyBarcodes(PcBarc_Barcode)`; the same on the staging tables where resume needs them (`RowNumber`).

A `schema_version` pragma (`PRAGMA user_version`) guards future changes.

**Schema version 2 (step 8):** adds `ix_phyDetails_state_row` on `phyDetails(updated, RowNumber)` (live table only), so one page of an Items list (`WHERE updated = ? ORDER BY RowNumber LIMIT n OFFSET k`) is read straight from the index without sorting the sheet. Every schema statement is `IF NOT EXISTS`, so a version 1 database is upgraded by running them again when the location is next opened; no data changes. The profile-delete warning counts pending lines in any database that has a schema (version ≥ 1), not only a current one.

**Schema version 3 (step 9):** `tblSheet` gets `LastUploadAt TEXT` and `LastUploadLines INTEGER` (Home's "Last upload", §6.2). New databases get them from `CREATE TABLE`; an older `tblSheet` gets them with `ALTER TABLE … ADD COLUMN` (only the columns it lacks, checked with `PRAGMA table_info`), in the same transaction as the other schema statements. Device tests upgrade a version 1 and a version 2 database holding lines in states 0, 1 and 2 and compare every line's `usercounted` and `updated` before and after.

### 4.3 Parameterized writes

- Every statement uses `?` placeholders and a value array. The only statement texts are constants in the storage module; table and column names in them come from the app's own constants.
- Page inserts run inside **one transaction per page** (`BEGIN`/`COMMIT`, rollback on any error), so a page is stored completely or not at all, and `RowsStored` is updated in the same transaction. This also fixes the legacy transaction leak.
- Lookups: `SELECT … FROM phyBarcodes WHERE PcBarc_Barcode = ? ORDER BY RowNumber LIMIT 1`; `SELECT … FROM phyDetails WHERE Refernce LIKE ? ESCAPE '\'` with `%`, `_` and `\` escaped in the scanned text and `%` appended; QR `WHERE Pcd_stkId = ? AND exp = ? AND Pcd_Batch = ?`. The barcode query joins `phyDetails`, so a barcode whose line is not in the sheet (count 10's barcode sample points at lines outside the first page, for example) is not a match and the lookup moves on to the reference search; legacy would have found the barcode and then shown an empty item. These are the three methods of the `LookupRepository` interface in `domain/lookup.ts` (step 2). The scan lookup asks the prefix query for at most 2 lines (it only needs to know one vs. several); Pick item runs its own query for the list.

### 4.4 SQLite plugin choice

**`@nativescript-community/sqlite`** (3.5.9, published 2026-05-18; earlier releases in September 2025 and April 2026; repository `github.com/nativescript-community/sqlite`).

Why:
- It is the **only maintained** SQLite plugin for NativeScript. The long-standing alternative `nativescript-sqlite` (NathanaelA) last published 2.8.6 in October 2021, predates NativeScript 8/9 and the current Android runtime; the old `nativescript-toolbox`/fork plugins are abandoned.
- On Android it wraps the platform's own `android.database.sqlite`, so there is no extra native library to match against the Android runtime version, and the database files are ordinary SQLite files (they can be pulled with `adb` and opened in any SQLite browser for debugging).
- API fits the plan: `openOrCreate(path)`, `execute(sql, params)`, `select(sql, params)`, `get(sql, params)`, `transaction(fn)` with rollback, `deleteDatabase(path)`, `?` placeholders with value arrays.
- Its peer dependencies (`typeorm`, `@nano-sql/core`) are optional adapters and are not installed.

**Confirmed in step 1** (emulator, API 36, x86_64):
- It builds and runs with `@nativescript/core` 9.1.2 / `@nativescript/android` 9.1.1 (it ships a small `sqlite.aar`).
- The API returns promises (`select`, `get`, `execute`, `transaction(async cancel => …)`), but with the default `threading: false` the work runs **synchronously on the JS (UI) thread**. `transaction()` rolls back when its callback throws (checked in the plugin source and by a test). An option `threading: true` moves the calls to a worker.
- Files live in Android's standard `databases/` folder (`Context.getDatabasePath`), e.g. `/data/data/com.physicalcount/databases/ERPDataCollectorNDB_TEST`.
- Timing for a count-10-sized download (11,131 `phyDetails` rows, 5000-row pages, ~1.1 MB XML per page): parse 110–230 ms and insert 1.3–2.0 s per 5000-row page; about 4–5 s in total. Because it runs on the UI thread, **each 5000-row page freezes the screen for ~2 s on the emulator**, and the handheld will be slower. This is carried to Q13.

The fallback (a thin wrapper over `android.database.sqlite.SQLiteDatabase`) is no longer needed.

**Transactions and the background-thread option (step 3).** With `threading: true` the plugin sends every statement to its worker thread, but its `transaction()` begins the transaction on the UI thread; Android binds a transaction to the thread that began it, so a page insert would wait on itself. The app therefore does not use `transaction()`: `storage/database.ts` runs `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` as statements through `execute()`, so they run on the same thread as the statements between them, in both modes (proven by the device tests, including rollback). `PRAGMA user_version` is read and written the same way. Worker errors arrive as plain strings and are turned into `Error`s. Android binds every parameter as text, so `LIMIT` values are checked integers written into the SQL, never parameters.

**Measured in step 3** (emulator; 11,131 lines, count 10's real first line repeated; real SOAP XML parsed per page; staging, `RowsStored` and swap included; two runs):

| Background thread | Page size | Total | Per details page | Longest UI block |
|---|---|---|---|---|
| off | 1000 | 3.3–4.2 s | 280–350 ms | 443–450 ms |
| off | 5000 | 2.7–3.8 s | 0.9–1.25 s | 1.1–2.1 s |
| on | 1000 | 8.0–9.3 s | 670–770 ms | 36–45 ms |
| on | 5000 | 8.0–9.2 s | 2.7–3.1 s | 169–174 ms |

Parsing stays on the UI thread in both modes (one 1000-row page: 50–200 ms; 5000 rows: 100–180 ms). With the background thread, a download takes about 2–2.5× longer, but the UI thread is never blocked for more than ~45 ms at 1000-row pages.

---

## 5. Counting

### 5.1 When Scan is available
Scan, Items and Upload are enabled when the selected location has a live sheet (`tblSheet` row, `phyHeader` has 1 row) and **no download is in progress** (`tblPullStatus` empty). While a download is in progress the live sheet is locked but untouched (§6.1).

### 5.2 Lookup (D1, D2, legacy order)
The scan field fires on Enter (§9.3). The value is trimmed; an empty value is ignored.

1. **Exact barcode:** `phyBarcodes.PcBarc_Barcode = value`. **First row by `RowNumber` wins**, as legacy took the first row (decided, Q7). This is a real case: in count 10 / CV, barcode `2000000000848` is on two different items (stock ids 246 and 1416, different lots and expiries), and counts 10 to 15 at CV each have 1 to 11 such barcodes (database check). Scanning the barcode always counts the first line; **the operator reaches the second item by typing its reference** into the scan field (step 2, prefix search, then Pick item if needed).
2. **Reference prefix:** `Refernce` starts with `value`, case-insensitive for ASCII (SQLite `LIKE`, as legacy).
   - Exactly one match → counted automatically (D2).
   - More than one → Pick item opens, pre-filled with the value; the chosen line is counted +1.
   - Deviation kept from the old plan: `%` and `_` are literal (legacy treated them as wildcards by accident).
3. **QR** (value contains `|`): format `stkId|DD/MM/YY|Batch`, converted **exactly like legacy**: split the date on `/`; if the day part is `00`, `exp1 = MM + "." + YY`, otherwise `exp1 = DD + "." + MM + "." + YY`, copying the parts **as they are on the sticker** (no year expansion). Then match `Pcd_stkId = stkId`, `exp = exp1`, `Pcd_Batch = Batch` exactly. Fewer than 3 `|` parts or fewer than 3 date parts → **"Invalid QR"** (legacy showed a generic "Error"). Parts are counted the way legacy's Java `split` counted them, which drops **trailing** empty parts, so `992|01/01/25|` (empty batch) and `992|01/01/|L1` (empty year) are invalid, as they were in legacy. An empty day or month is also reported as invalid, because it could never match. Extra parts after the batch are ignored (legacy). Note: the service sends `exp` with a 4-digit year (`01.01.2025`), so a sticker with a 2-digit year would not match — the go-live checklist tests a real sticker (§12).
4. **Not found:** clear the line fields, show **"Item Not Found: <value>"** in red in the status line, play the not-found tone (§5.4). The value is not stored (legacy). No blocking dialog, so the next scan goes straight into the scan field (legacy's dialog swallowed the next scan until dismissed).

### 5.3 Count rules (legacy formulas) and D5

| Action | Formula |
|---|---|
| Scan (or pick from Pick item) | `total = stored usercounted + 1`, Last Scanned = 1; last-scan controls enabled |
| Update Last Scan Qty | `total = Total field + (Last Scanned − 1)`, then last-scan controls lock |
| Cancel Last Scan | `total = Total field − Last Scanned`, then last-scan controls lock |
| Update Total Scanned | `total = Total field` |
| Open from Items | no change (display only) |

Every change writes `usercounted = total, updated = '1'` for that line in one parameterized `UPDATE`. A line already uploaded (`'2'`) goes back to `'1'`.

**D5 fix:** the legacy 6-character check is removed. Quantities are parsed as decimals and must be finite, ≥ 0 (S19), at most the S19 maximum, with no more decimals than `SP_DecNo`. Arithmetic is done in **scaled integers** (thousandths), not floating point, so `0.1 + 0.2` never drifts. Totals are displayed without trailing zeros (`12`, not `12.0` or `12.000`). An invalid entry shows a message naming the problem and the field ("Last Scanned: Whole numbers only.", "Total: At most 2 decimals.") and **never blocks the next scan**. The quantity fields use the number keyboard (`integer` when `SP_DecNo = 0`, `number` otherwise).

Details settled in step 2 (`domain/decimal.ts`, `domain/countRules.ts`):
- Quantities are `bigint` thousandths: the cap is 10¹⁷ thousandths, beyond the exact range of a JavaScript number.
- Allowed decimals = `SP_DecNo` capped at 3; an empty or unreadable `SP_DecNo` means whole numbers.
- Typed quantities accept `.` or `,` as the decimal separator (the Android number keyboard can give either); no sign, exponent or thousands separators. Trailing zeros don't count as decimals (`3.500` is fine with 1 decimal). **Step 7 note:** on the emulator (en-US) the Android number field itself drops a typed `,` before the app sees it (`4,125` arrived as `4125`); the parser's `,` support only matters for locales whose number keyboard sends `,`. Check the handheld's keyboard and locale (§12.1).
- Values from the service (`'7.000'`, `''` → 0) are read with up to 3 decimals and may be negative (S19).
- `SP_DecNo` limits **only what the operator types**. A scan on a line whose stored value has more decimals than `SP_DecNo` **keeps those decimals and adds 1** (`7.5` with `SP_DecNo = 0` → `8.5`), and upload accepts up to 3 decimals whatever `SP_DecNo` is (Q14, `checkUploadQuantity`).
- If the stored value is negative, the scan is refused with *"The stored total is negative; correct it with Update Total Scanned."* That is the one case where scanning a line needs a correction first.
- Cancel Last Scan and Update Last Scan Qty lock the last-scan controls; Update Total Scanned leaves them as they were. A result below 0 is refused (legacy allowed negative totals).

### 5.4 Sound (D6)
Android `android.media.ToneGenerator`, created once when Scan opens and **released** when it closes (legacy leaked one per miss). No permission needed.
- **Good scan:** one short beep (`TONE_PROP_BEEP`, ~100 ms).
- **Not found / invalid QR:** the legacy alert (`TONE_CDMA_ALERT_CALL_GUARD`, 200 ms), clearly different.
- Stream: `STREAM_MUSIC`, volume 100. **To confirm** on the handheld that it is loud enough and does not clash with the scanner's own good-read beep (it may be turned off in the scanner settings).

---

## 6. Download and upload flows

### 6.1 Download

1. **D8 check first, before `InitPullTables`:** count `updated='1'` lines in the selected location's live sheet. If N > 0: *"N counted lines on this device have not been uploaded. Downloading will discard them."* with **Upload first** (primary; opens Upload), **Discard N counted lines and download**, **Cancel**.
2. Validate location, machine name and count number (§3.7).
3. Call `InitPullTables` (§3.3). If not downloadable → message, nothing changes.
4. Clear the `stg_*` tables and `tblPullStatus`, write the manifest (one row per table), in one transaction.
5. Page each table in manifest order into `stg_*` with `pullRecords` (§3.4), one transaction per page, `StartFromRow = RowsStored + 1`. The screen stays on (`FLAG_KEEP_SCREEN_ON` on the window, no wake-lock permission). Cancel is checked between pages.
6. When every table is complete: in **one transaction**, delete the live `phyHeader`/`phyDetails`/`phyBarcodes` rows, copy `stg_*` into them (`INSERT INTO phyX SELECT … FROM stg_phyX`), write `tblSheet`, clear `stg_*` and `tblPullStatus`. Only now are the old sheet and any discarded counts replaced.
7. Copy nothing to preferences: `SP_*` are read from `phyHeader` when needed.

**Resume.** If the app is closed, cancelled, or loses the network mid-download, `tblPullStatus` still holds the manifest and `RowsStored`. Download then offers:
- **Continue download** — continues with `pullRecords` from `RowsStored + 1`, **without calling `InitPullTables` again** (the server's staging tables persist until the next `InitPullTables` for this location + machine, S8).
- **Restart download** — D8 check, then from step 3.
- **Abandon download** — clears `stg_*` and `tblPullStatus`; the live sheet (and its counts) is unlocked again.

A failed or cancelled download **never** touches the live sheet. This fixes the legacy bug that dropped the tables before contacting the server.

### 6.2 Upload

1. Count `updated='1'` lines. None → *"No Counted Items Found."*
2. Confirm *"This Physical Count Contains N Items. Upload?"*
3. Read `InvID` and `UserToUpdate` from `phyHeader`; validate (§3.7).
4. For each `updated='1'` line in `_id` order, **one `InsertDetail` at a time**, with `transCount` = 1, 2, 3… **starting at 1 on every run** (so the service re-checks that the count is still open, S4, S21):

   | SOAP parameter (WSDL order) | Value |
   |---|---|
   | `transCount` | 1, 2, 3… |
   | `SelectedLocation` | location code |
   | `uInvID` | `phyHeader.InvID` |
   | `id` | `_id` (ignored by the service) |
   | `Pcd_RecId` | the line's `Pcd_RecId` |
   | `usercounted` | the absolute total, formatted per §3.6 |
   | `uUserToUpdate` | `phyHeader.UserToUpdate` |

5. `InsertDetailResult` exactly `ok` → set that line `updated='2'`. Anything else → **stop** and show the message. For `<UPDATE statement>:<SQL error>` (text starting with `Update tbl_PhysicalCountDetail`), show only the SQL error after the first `:` — the statement itself contains no `:`, because every value in it passed §3.7 — and keep the full text in the app log. Known texts: "This Physical Count Was Cancelled", "This Physical Count Was Already Updated To Stock", "This Physical Count Does Not Exist".
6. Timeout or network error → stop; the line stays `'1'`. Cancel is checked between lines. The screen stays on for the whole upload (`FLAG_KEEP_SCREEN_ON`, as for download).
7. **Resending is safe:** the service **replaces** `Pcd_QtyCounted<N>` with the value sent (S2, confirmed by the 5-then-7 test), so a line sent twice ends with the same value.
8. Caution kept from the old plan: `ok` does not prove a row matched (S4). The go-live checklist compares the first real upload with the VB.NET count screen (§12).

**Details settled in step 9** (`storage/upload.ts`, `domain/uploadText.ts`, `screens/UploadScreen.tsx`):
- **Before any call:** the location code, `InvID` and `UserToUpdate` are checked (§3.7); a bad value ends the run with "The count on this device cannot be uploaded: … Download the count again." and nothing is sent. Each line is checked just before it is sent (`Pcd_RecId` digits, total readable, ≥ 0, within the cap); a line that fails **stops the run at that line** (it is not skipped), with "Correct its total in Scan, then upload again."
- **`ok` means exactly the two characters `ok`** after the XML reader's whitespace trim; `OK`, `ok.` or an empty answer stop the run as "Unexpected answer from the server".
- **Messages.** The three refusals have their own title and text and end with "Nothing was sent. Your counts are still on this device." (they can only come at `transCount` 1). An answer starting with `Update tbl_PhysicalCountDetail` shows only the text after the first `:`; the full answer goes to the app log (`[upload] line … not saved; the server answered: …`). A timeout, a lost connection or an unreadable answer adds "Line N may already have been saved on the server. It is still marked as not uploaded here, and sending it again is safe."
- **Lines are read in batches of 200** by `_id` (`pendingLinesAfter`), so a large count is not loaded at once.
- **Screen:** confirmation ("This Physical Count Contains N Items. Upload?" / "No Counted Items Found."), then "Row x / N" with a progress bar, elapsed time and Cancel (checked before every line; the line on its way finishes), then the result: lines sent, lines still pending, time taken, and the failed line (id and reference) with its message. One button, **Home**. Back during a run asks "Cancel the upload?".
- **Last upload on Home:** `tblSheet.LastUploadAt` / `LastUploadLines` (schema version 3, §4.2) are written at the end of every run that sent at least one line (complete, cancelled or stopped) and shown as "Last upload: DD/MM/YYYY HH:MM · N lines" in local time. The download that replaces the sheet clears them.
- **Debug builds only:** Settings → Debug tools has a "pause before each line" value, used to switch the network off in the middle of a short upload.

---

## 7. Legacy defects: fixed or kept

| Legacy issue | Native rebuild |
|---|---|
| 10000+ locks the screen | Fixed (D5) |
| No good-scan sound; `ToneGenerator` leak | Fixed (D6, §5.4) |
| Service SQL executed on the device; string-built local SQL | Fixed: service SQL parsed as data; all local SQL parameterized (D7) |
| Re-download drops unsent counts; tables dropped before contacting the server | Fixed: D8 + staged download |
| Download could loop forever | Fixed: stop rule (§3.4) |
| Transaction leak on insert | Fixed: one transaction per page with rollback |
| App closes when leaving Settings without a server; empty page size crashes | Fixed: Home shows Settings only; field validated |
| Not-found dialog swallows the next scan | Changed: inline message + tone |
| Unused permissions (camera, storage, phone state…) | Dropped: only `INTERNET` and `ACCESS_NETWORK_STATE` (the template's storage permissions are removed) |
| One `InsertDetail` per line; stop on first error | **Kept** (C2) |
| Prefix auto-count on a single partial match | **Kept** (D2) |
| Unknown barcodes not recorded; uploaded lines hidden from lists | **Kept** |

---

## 8. Service behaviour (confirmed, carried over from the web-adapter plan §6)

Answered from the VB source `Service1.asmx.vb`, the WSDL (`docs/service-samples/Service1.wsdl`), and test calls to the local copy under IIS Express against the local database. Line numbers refer to `Service1.asmx.vb`. Where the old text said "adapter" or "browser", the app now does that job.

| # | Question | What the code and tests show | Status |
|---|---|---|---|
| **S1** | Exact contract | Namespace `http://tempuri.org/`, document/literal, SOAPAction `http://tempuri.org/<Method>`. **All parameters `s:string`, `minOccurs=0`.** `InitPullTables(ApplicationName, SelectedLocation, MachineName, Extras, DeviceInfo)` → `InitPullTablesResult: TableInfos{ mTableInfo: ArrayOfTableInfo{ TableInfo[] } }`. `pullRecords(TableName, PIndex, PSize, StartFromRow)` → `pullRecordsResult: Records{ mRecords: ArrayOfRecord{ Record[]{ valuesquery } } }`. `InsertDetail(transCount, SelectedLocation, uInvID, id, Pcd_RecId, usercounted, uUserToUpdate)` → `InsertDetailResult: string` | **confirmed** |
| **S2** | Does `InsertDetail` replace, add or insert? | `Update tbl_PhysicalCountDetail set Pcd_QtyCounted<uUserToUpdate> = <usercounted>, Pcd_Type<N> = 10, Pcd_DateCount=getdate() where Pcd_RecId='<Pcd_RecId>' and Pcd_loc='<SelectedLocation>'` (386–390). **Replaces.** 5-then-7 test on count 9 / V2, `Pcd_RecId` 47842, slot 4: result `7.000`, not 12 | **confirmed: replace** |
| **S3** | Is resending safe? | Yes; only `Pcd_DateCount` moves to the resend time | **confirmed** |
| **S4** | `InsertDetail` return values | `"ok"` after the UPDATE runs, **even if it matched 0 rows**. Header refusals only when `transCount = "1"`: cancelled, already updated to stock, does not exist. On exception: `UpdateSQL & ":" & ex.Message`. No SOAP faults for SQL errors | **confirmed** |
| **S5** | `transCount`, `id`, `_id` | `transCount` only switches on the header check when `"1"`. **`id` is never used.** `_id` is not in `InsertInto` | **confirmed** |
| **S6** | `usercounted` formats | Concatenated unquoted into T-SQL; any T-SQL numeric literal works. A comma decimal separator or empty value → SQL error text | **confirmed** |
| **S7** | How rows are picked for a count | Header: `Pch_Updated='N' AND Pch_RecId=<Extras> AND Pch_Loc='<loc>' AND Pch_Status<>'C' AND Pch_Updated<>'Y' AND machine in Pch_MachUser1..6`. `UserToUpdate` = first matching slot. No header → no details/barcodes. Details: joins to stock, item type, supplier (inner) and colour, brand (left); **no warehouse filter**; `RowNumber` ordered by `Pcd_RecId`. Tests: count 9/V2/UN3 → 1 / 102 / 0; count 10/CV/UN → 1 / 11131 / 9; count 999999 and unassigned machine → `phyHeader` only with `RowsCount 0` | **confirmed** |
| **S8** | Side effects of `InitPullTables`; resume | **Writes to the ERP database**: drops and recreates six staging tables per location + machine (`_ERPDATACOLLECTOR_tbl_PhysicalCount{Header,Detail,DetBarcode}_<loc><machine>` + `…xyz`). They persist until the next `InitPullTables` for the same location + machine, so resume works until then. **Two devices with the same location + machine name overwrite each other's staging** | **confirmed** |
| **S9** | Tables returned | Always `phyHeader`, `phyDetails`, `phyBarcodes` in that order, or `phyHeader` only | **confirmed** |
| **S10** | `InsertInto` / `CreateTable` text | Exact strings in §3.5.1 | **confirmed** |
| **S11** | `valuesquery` syntax | Every value quoted; apostrophes removed from text; NULL → `''`; `valuesquery` is `nvarchar(4000)`; datetimes like `'Dec 31 2022 12:00AM'` | **confirmed** |
| **S12** | XML shape, no-results, errors | One `valuesquery` per `Record`. No rows → `<pullRecordsResult />`. All exceptions swallowed, so SQL errors look like no or partial results | **confirmed** |
| **S13** | Paging | `WHERE RowNumber BETWEEN StartFromRow AND StartFromRow + PSize − 1`, 1-based inclusive; `PIndex` ignored; no max `PSize`; **no `ORDER BY`**. Pages 1–50, 51–100, 101–102 of count 9 correct; 103+ no results | **confirmed** |
| **S14** | Initial `usercounted` / `updated` | `usercounted` = this machine's slot value, NULL → 0; `updated` always `'0'` | **confirmed** |
| **S15** | Header `InvID`, `UserToUpdate`, `SP_*` | `InvID` = `Extras`; `UserToUpdate` = `'1'`–`'6'`; `SP_*` from the last row of `stk04_SysParam`, NULL `SP_DecNo` → `"0"`. **`SP_DecNo` is the number of allowed decimals** (decided for this plan). Local value `3` | **confirmed** |
| **S16** | `DeviceInfo`, `ApplicationName` | `DeviceInfo` ignored; `ApplicationName` matched case-insensitively, used verbatim in staging-table names | **confirmed** |
| **S17** | Machine name | Must equal one of `Pch_MachUser1..6` (`varchar(5)`), collation `SQL_Latin1_General_CP1256_CI_AS`: case-insensitive, trailing spaces ignored. Part of the staging-table names | **confirmed** |
| **S18** | Hosts and timeouts | One service per location's IIS (C3). Real host names/addresses per location and `InitPullTables` duration on large counts are not in the code | **to confirm** (§13) |
| **S19** | Negative / large values | Written as sent, including negatives. ≥ 10¹⁴ with 3 decimals breaks the next `InitPullTables` (`cast(… as nvarchar(18))`) silently | **confirmed** (app blocks negatives and caps, §3.7) |
| **S20** | Injection surface | **Every parameter of all three methods is concatenated into SQL without escaping** | **confirmed** (app checks, §3.7) |
| **S21** | Writes to other counts? | UPDATE filters on `Pcd_RecId` + `Pcd_loc` only; the cancelled/posted check only runs at `transCount = "1"` | **confirmed** (runs start at 1; only IDs from the sheet) |

**Changes made to the local test database by those tests** (still to clean up, §12): `tbl_PhysicalCountDetail` `Pcd_RecId=47842`, `Pcd_Loc='V2'` has `Pcd_QtyCounted4 = 7.000`, `Pcd_Type4 = 10`, `Pcd_DateCount` = test time (before: NULL / NULL / 2022-12-31). Ten staging tables were created: `_ERPDATACOLLECTOR_…_CVUN` (×6), `…Header_V2UN3` (×2), `…Header_V2ZZ9` (×2).

---

## 9. Android platform specifics

### 9.1 Plain `http://` (network security config)

Android 9+ blocks cleartext HTTP unless the app allows it. **Decision: allow plain `http://` to any host, like the legacy app.** Each location's service is typed as a server address in Settings, so no host list is baked into the build and adding a location never needs a new APK.

Release config (`App_Resources/Android/src/main/res/xml/network_security.xml`, already referenced by `android:networkSecurityConfig="@xml/network_security"` in the manifest):

```xml
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors><certificates src="system" /></trust-anchors>
  </base-config>
</network-security-config>
```

The template's version also trusts user-installed certificates and lists `localhost`, `127.0.0.1` and `10.0.2.2`; those go. User certificates are not needed (no HTTPS is used).

**Checked in step 5:** the packaged release config (`aapt2 dump xmltree`) is exactly the base-config above, with system certificates only, and no file in the release APK contains `10.0.2.2`.

Debug-only override (`App_Resources/Android/src/debug/res/xml/network_security.xml`, a standard Gradle debug source set) keeps a `domain-config` for `10.0.2.2` (the emulator's address for the development PC, where the local IIS Express copy runs) and `localhost`. It changes nothing functionally while the base config already allows cleartext, but it documents the emulator host and keeps working if the release base config is ever tightened. The release APK never contains it.

The Server address field keeps only its **format check** (§3.7); any host that passes it is accepted.

### 9.2 System bars (NativeScript 9 edge-to-edge)

NativeScript 9 renders **edge-to-edge** on Android (content draws behind the status and navigation bars; enforced by Android 15+ when targeting SDK 35+, and the template targets SDK 36). By default NativeScript **applies the system-bar insets automatically as padding** on the page's content, so layouts don't slide under the bars. The plan relies on that default and pins it down:

- One `Frame` with one `Page` with `actionBarHidden`; the app draws its own header bar (§10), so there is a single place to reason about the top inset.
- The root layout keeps the default inset handling (no `androidOverflowEdge` override). If a coloured header should extend behind the status bar, the root sets `androidOverflowEdge="bottom"` (apply only the bottom inset) and the header adds the top inset itself from the `androidOverflowInset` event — only if the design wants it; the default is simpler.
- Bottom action buttons (Scan's three buttons, Download/Upload Cancel) sit in the last row of the root `GridLayout`, so the bottom inset keeps them above the 3-button or gesture navigation bar.
- Status bar icons: `statusBarStyle` on the page (`'dark'` icons on a light header), or `Utils.android.enableEdgeToEdge(activity, { statusBarLightColor, … })` once at startup if colours need to be set explicitly. **Step 5:** with the default insets the status-bar area shows the page's white background, so the page uses `statusBarStyle="dark"` (dark icons); light icons were invisible. Checked on the emulator (API 34) with gesture and 3-button navigation: the header clears the status bar and the last button on every screen sits above the navigation bar.
- Soft keyboard (Settings, Download, quantity fields): the IME inset is reported as `imeBottom`; the form screens are `ScrollView`s so a focused field can scroll above the keyboard. The scan field never shows the keyboard (§9.3).
- Older Android versions (before 15) are not forced edge-to-edge; `Utils.android.setIgnoreEdgeToEdgeOnOlderDevices` exists if the handheld's version behaves differently. **To confirm** on the handheld (§12, deferred).
- Test on the emulator with both **3-button** and **gesture** navigation, portrait, API 36 and the handheld's API level.

### 9.3 Scanner input (keyboard wedge)

The handheld's scanner types the barcode into the focused field and presses Enter (LEGACY_ANALYSIS §6). The Scan screen's scan field is a `TextField` configured natively when it is `loaded` (`textField.android` is an `android.widget.EditText`):

| Setting | How | Why |
|---|---|---|
| No soft keyboard | `editText.setShowSoftInputOnFocus(false)`; also `Utils.dismissSoftInput()` on focus | The keyboard would cover half the screen; the wedge does not need it |
| Single line | `setSingleLine(true)` | A CR/LF from the wedge never lands in the text (legacy) |
| No IME connection | `inputType = TYPE_NULL` (**changed in step 7** from `TYPE_CLASS_TEXT \| TYPE_TEXT_FLAG_NO_SUGGESTIONS`) | With a text input type the keyboard app (Gboard on the emulator) stays attached to the field even when hidden and handles some hardware key events itself, asynchronously: in step 7, 3 of 20 rapid scans arrived with characters out of order and 1 of 20 was lost. With `TYPE_NULL` the field's own key listener types the characters and 80 of 80 rapid scans were counted. **Risk to check on the handheld:** a scanner whose "keyboard" output goes through an input method (text committed by an IME) instead of key events would type nothing into a `TYPE_NULL` field (§12.1) |
| Enter = scan complete | native `View.OnKeyListener`: on `KEYCODE_ENTER` (and `KEYCODE_NUMPAD_ENTER`) with `ACTION_DOWN`, read `getText().toString().trim()` and run the lookup; **consume both `ACTION_DOWN` and `ACTION_UP`** (return `true`) | NativeScript's own `returnPress` also fires on a hardware Enter but can fire for both key actions and dismisses the keyboard/focus; the key listener is exactly what legacy did (`BarcodeScan.java:100-115`). `returnPress` is kept only as a fallback for an IME "Done", guarded so one Enter processes one scan |
| Re-arm after every scan | after the lookup and after any pop-up or message closes: 100 ms later `focus()`, then `editText.selectAll()` | The next scan **replaces** the text (legacy `Reinit()`) |
| Focus return | also on screen `navigatedTo`, when Pick item closes, and after the Update/Cancel buttons | The wedge must always have a target |
| Tap to re-focus | tapping the field focuses it without showing the keyboard | recovery if the operator tapped a quantity field |

**Scanner input setting (step 8, Settings → Advanced):** *Key events* (default) is the `TYPE_NULL` field above. *Text input* restores the normal text field (`TYPE_CLASS_TEXT | TYPE_TEXT_FLAG_NO_SUGGESTIONS`, soft keyboard still suppressed), for a scanner whose output is committed through an input method; in that mode an Enter that arrives as an editor action (IME "Done") also completes a scan, and an Enter seen both ways within 50 ms counts once. The choice is read when Scan opens. Text input brings back the step 7 risk with fast scans when a keyboard app is attached; use it only if Key events types nothing.

The quantity fields (Total, Last Scanned) do show the soft keyboard when tapped, as legacy. While one of them is focused, a scan would type into it (legacy behaviour); after their buttons are pressed, focus returns to the scan field.

On the emulator, the PC keyboard behaves like a wedge (characters + `KEYCODE_ENTER`), so Scan can be tested fully without the handheld.

**Deferred / optional:** a broadcast-receiver integration (the scanner service sends an intent with the barcode instead of typing it). Not needed while the wedge works; revisit only if the handheld's wedge mode proves unreliable (§12, deferred).

### 9.4 Back button and lifecycle
- `Application.android.on('activityBackPressed', args => …)`: pop the app's screen stack (§10). **On Home the app also cancels the event and calls `moveTaskToBack(true)`** instead of letting Android finish the activity (step 5): react-nativescript's `start()` renders the root once, so when Back finished the activity and the user reopened the app (same process), Android recreated the activity and the page was blank. Moving the task to the background behaves the same for the user and keeps the activity. **Step 5 (Q6):** the event fires on the emulator's API 34 (Android 14) with gesture and 3-button navigation; before the fix it fired twice on Home when not cancelled. During a running download or upload, Back will ask "Cancel the download/upload?" (steps 6 and 9).
- **Activity recreation must be tested for a blank screen** (dark-mode or font-size change, low memory), because react-nativescript renders the root once (see Back above). Step 6 findings on the emulator (API 34), with lifecycle logging in the shell (`[shell] activityCreated / activityDestroyed (finishing …)`):
  - **Dark mode:** no recreation (`uiMode` is in the manifest's `configChanges`); the app stays light (fixed colours, forced dark off) and readable.
  - **Font size (1.3×):** the activity **is** recreated (`finishing false`, then created) and the current screen comes back intact (Settings, with its field values). **Not blank.** NativeScript keeps the root view when the system recreates the activity; only a *finishing* activity (Back) loses it.
  - **Low memory:** the usual case is process death; after `am kill` in the background the app restarts cleanly on Home. The developer option "Don't keep activities" did not take effect on the running app in this test (no destroy logged), so that path is **not yet proven**; re-test on the handheld (§12.1).
  - Not yet tested: a recreation **during a running download** (the download promise keeps running in the same process; the screen should keep updating).
- The Scan screen reloads the current line from SQLite on resume, so nothing is held only in memory. Counting writes go straight to SQLite on every action; killing the app never loses a count.

### 9.5 Manifest
Keep `INTERNET`, `ACCESS_NETWORK_STATE`. Remove the template's `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE`. Portrait only (`android:screenOrientation="portrait"` on the activity). Application id: **`com.physicalcount`**, set in `nativescript.config.ts` (`id`) in step 1, **before anything is installed on a handheld**, because changing it later installs a second app with empty data.

**Step 5:** the storage permissions are removed from the app manifest, and the activity is portrait only. Inspecting the release APK showed the **manifest merger adds `READ_PHONE_STATE`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` anyway**: the SQLite plugin's `.aar` declares no `targetSdkVersion`, so Android implies them for it, and NativeScript's widgets library adds the storage ones for API ≤ 28. The app manifest removes all three with `tools:node="remove"`; the rebuilt APK lists only `INTERNET`, `ACCESS_NETWORK_STATE` and androidx's own `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (signature-level, the app's own). The debug-signed release APK is about 110 MB because it carries every ABI; step 10 should build per-ABI or restrict to the handheld's ABI.

---

## 10. Navigation

**Decision:** no navigation library. Remove `react-nativescript-navigation` (5.0.0, last published 2023) and the `@react-navigation/core` 5.x it pulls in (the current release is 7.x; 5.x is unmaintained and was written for React Native). Delete the template's `MainStack`, `ScreenOne`, `ScreenTwo`, `NavigationParamList`.

Instead:
- The app renders one `<frame>` → one `<page actionBarHidden>` → an **app shell** component with a small typed screen stack in React state (`useReducer`: `push`, `pop`, `replace`, `reset`), e.g. `{ name: 'scan', params: { lineId } }`.
- Only the top screen is rendered. Screens load what they need from SQLite on mount, so unmounting lower screens loses nothing.
- A shared header component (title, Back arrow, location badge) and the §9.2 inset handling live in the shell, once.
- Back button → `pop` (§9.4). Home is the root; `reset` returns to Home after a completed download.
- **Pick item** and confirmation prompts are overlays rendered inside the Scan page (a `GridLayout` layer over the content), not native modal pages, so focus can be returned to the scan field reliably. Simple yes/no questions use `Dialogs.confirm`/`Dialogs.action` from `@nativescript/core` (D8 uses `action` with the three buttons).

Why: six screens and one pop-up don't need a library; it removes an unmaintained dependency; no native page transitions interfere with scan-field focus; and the whole flow can be unit-tested as a reducer.

`react-nativescript` 5.0.0 itself stays (it declares `@nativescript/core ^8.3.5` as a peer; the template's `overrides` entry pins core 9.1, and the template runs). **To confirm** nothing in it breaks under core 9.1 as screens grow; there is no newer release.

---

## 11. Build, test, release and sideload

### 11.1 Code layout (pure logic separated from NativeScript)

```
src/
  app.ts                       entry: ReactNativeScript.start(<AppShell/>)
  shell/                       AppShell, screenStack.ts (pure reducer), Header, back handling
  screens/                     Home, Settings, Download, Scan (+ PickItem overlay), Items, Upload
  platform/                    ScanField (EditText setup), Beeper (ToneGenerator), keepScreenOn, deviceInfo,
                               itemCell (native Items row)
  config.ts    (pure)          DEFAULT_PAGE_SIZE, DOWNLOAD_BACKGROUND_THREAD, SOAP_TIMEOUT_MS (Q13, §3.1)
  soap/        (pure)          envelopes.ts, responses.ts, client.ts (typed outcomes over an injected transport);
                               httpTransport.ts is the only file using Http
  debug/                       liveDownload.ts: debug-only live check, built only with --env.liveDownload
  parse/       (pure)          errors.ts, insertInto.ts, valuesQuery.ts, rows.ts, manifest.ts (InitPullTables → manifest, §3.3)
  domain/      (pure)          check.ts (Check result type), validation.ts, decimal.ts (scaled integers, parsing
                               and formatting), countRules.ts, lookup.ts (over a small repository interface), qr.ts
  storage/                     database.ts (open, transactions, user_version), settingsDb.ts, deviceSettings.ts
                               (ApplicationSettings), locationDb.ts, schema.ts, download.ts (paging loop), upload.ts
  test.ts                      on-device test entry (used only by `ns test android`)
  tests/*.spec.ts              on-emulator tests (SQLite, storage flows); the runner only bundles specs under src/
tests/
  node/*.test.ts               vitest in Node, pure modules, fixtures read from docs/service-samples/
vitest.config.mts              device runs (`npm run test:android`)
vitest.node.config.mts         Node runs (`npm run test:node`)
```

Pure modules import nothing from `@nativescript/*`, so they run under plain Node.

### 11.2 Tests
- **Node unit tests (vitest ~4.1):** envelope builders vs every `*.request.xml`; response readers vs every `*.response.xml` (including `<pullRecordsResult />`, not-found, machine-not-assigned); `InsertInto` parser (exact strings, mismatch, bad identifiers); `valuesquery` tokenizer (all samples, commas/parentheses/Unicode inside quotes, empty values, unterminated quote, unquoted token, stray text); a synthetic fixture with `&amp;`, `&lt;` and a numeric character reference; validation table (§3.7) edge cases; decimal and count rules incl. 10000+, decimals by `SP_DecNo`, negative and overflow; QR conversion (`00` day, bad formats); lookup order with an in-memory repository; screen-stack reducer.
- **Device tests** with `@nativescript/unit-test-runner` 5.0.0 (vitest 4.1 on the emulator, `npm run test:android`): SQLite schema, parameterized inserts, staged swap, resume de-duplication, restore uploaded. **Works with NativeScript 9.1** (step 1). Setup notes found on the way:
  - `ns test init --framework vitest` fails (it asks npm for `@nativescript/unit-test-runner@^5.0.0-alpha.0`, which doesn't exist). The same files were created by hand from the CLI's own templates: `src/test.ts`, `vitest.config.mts`, `tsconfig.spec.json`, plus the `@valor/nativescript-websockets` and `@vitest/runner` packages it installs.
  - On Windows the runner's default launch (`npx ns run …`) cannot be spawned; `vitest.config.mts` runs the global CLI with `node` instead, and raises `connectTimeout` to 10 min to cover the first Gradle build.
  - `docs/service-samples/*.xml` are bundled as text for device tests by a `webpack.config.js` rule (`asset/source`), excluded from NativeScript's XML-UI loader.
  - npm 10.9 crashes (`Cannot read properties of null (reading 'edgesOut')`) resolving vitest's optional peers; the project's `.npmrc` sets `legacy-peer-deps=true` so plain `npm install` / `npm ci` work (a clean `npm ci` from `package-lock.json` was checked), and `vite` 8 is listed explicitly as a dev dependency.
  - Shells started by Claude Code set `NoDefaultCurrentDirectoryInExePath=1`, which stops the CLI from finding `gradlew.bat`; clear it in that shell (`Remove-Item Env:NoDefaultCurrentDirectoryInExePath`). A normal terminal is unaffected.
- **Manual on emulator against the local service** (server address `10.0.2.2`, full IIS on port 80, Q11): download count 9/V2/UN3 and count 10/CV/UN; resume after killing the app mid-download; upload **only on test count 9 / V2** (the only count already used for write tests).

### 11.3 Release APK
1. Once: create an upload keystore with `keytool -genkeypair -v -keystore physical-count.jks -alias physicalcount -keyalg RSA -keysize 2048 -validity 10000`, stored **outside the repository** and backed up. Every future update must be signed with the same key, or Android refuses to install it over the old one. Passwords are never written into the project (`Claude.md` rule).
2. Each release: bump `versionCode` (and `versionName`) in `App_Resources/Android/app.gradle`.
3. Build:
   `ns build android --release --key-store-path <path>\physical-count.jks --key-store-password <…> --key-store-alias physicalcount --key-store-alias-password <…> --copy-to dist\physical-count-<version>.apk`
   (passwords typed or passed from environment variables, not saved in scripts in the repo).
4. Check the APK: `apksigner verify --print-certs`, and install it on the emulator first.

### 11.4 Sideloading onto the handheld
- **USB (preferred):** enable Developer options → USB debugging on the handheld, connect, `adb devices`, then `adb install -r dist\physical-count-<version>.apk` (`-r` keeps the app's data: profiles and location databases survive an update).
- **Without a PC:** copy the APK to the device (USB storage or a share), open it in the file manager, allow "Install unknown apps" for that file manager once, install.
- Never uninstall to update: uninstalling deletes the location databases, including counts not uploaded.
- The legacy app (`com.example.erpdatacollectorn`) can stay installed side by side; it has its own data.

---

## 12. Deferred until the handheld is available, and go-live checklist

### 12.1 Deferred (needs the Newland handheld)
- [ ] **Scanner keyboard mode:** confirm the scanner service is in keyboard/wedge output and the **suffix is Enter** (CR or LF, sent as `KEYCODE_ENTER`); no prefix characters; check which key code actually arrives (log it once in a debug build).
- [ ] **Scanner output reaches a `TYPE_NULL` field** (§9.3): the Newland must send key events ("keystroke" / keyboard-emulation output), not text committed through an input method; test 20 fast scans of mixed codes (letters, digits, `/`, `|`) and compare the count. Also check the number keyboard's decimal key and locale on the Quantity fields (§5.3).
- [ ] Whether the scanner's own good-read beep should be turned off so it doesn't overlap the app's beep (§5.4); tone volume.
- [ ] **Android version** of the Newland (and its API level): must be ≥ the app's `minSdkVersion` (24 in the template; **to confirm** NativeScript 9's own minimum); check edge-to-edge/inset behaviour on that version (§9.2) and Back handling (§9.4).
- [ ] **Activity recreation on the handheld** (§9.4): font-size change, dark mode, "Don't keep activities" (then leave and reopen), and a font-size change during a running download; the screen must never come back blank.
- [ ] **Network:** the handheld reaches **each location's service over that location's Wi-Fi** (`Test connection` in Settings for every profile); note whether a location needs a different address on-site vs. elsewhere.
- [ ] Screen size/density: all six screens and the Pick item pop-up fit without clipping; buttons reachable one-handed.
- [ ] **Download speed on the handheld** (Q13): time a count-10-sized download with the default 1000-row pages (and with the background-thread option if step 3 adopts it); check the UI pause per page and that Cancel responds; adjust the default page size if needed.
- [ ] **Items scroll on the handheld** (step 8): fling the Not counted tab of a count-10-sized sheet top to bottom; it should feel smooth and show few `…` rows. The debug build logs `[items] N rows filled, X ms each` (2.2 ms on the emulator). If the scanner types nothing in Scan, try Settings → Advanced → Scanner input: Text input, then repeat the 20-fast-scans check.
- [ ] Optional, only if the wedge proves unreliable: broadcast-receiver scanner integration (§9.3).

### 12.2 Go-live checklist
- [ ] **First real upload:** after the first real upload at each location, compare the uploaded lines with the **VB.NET count screen** (the machine's slot column `Pcd_QtyCounted<N>`). The service returns `ok` even when the UPDATE matched no row (S4), so the app's "all sent" is not proof.
- [ ] **QR expiry:** scan a **real QR sticker** and check it finds its line. The legacy conversion keeps the sticker's year as printed (§5.2) while the service sends `exp` with a 4-digit year; if a 2-digit-year sticker fails, decide the fix (a deliberate deviation from legacy).
- [ ] **Finish the local test cleanup** in the local database (done by you in SSMS, not by the app): restore `Pcd_RecId=47842`, `Pcd_Loc='V2'` to `Pcd_QtyCounted4 = NULL`, `Pcd_Type4 = NULL`, `Pcd_DateCount = 2022-12-31`; drop the ten `_ERPDATACOLLECTOR_…` staging tables listed in §8 and any created by later emulator tests.
- [ ] **Machine names:** confirm each device's machine name is assigned in the VB.NET physical-count module (`Pch_MachUser1..6` of the count) and **typed identically** on the device (1–5 letters/digits; the service compares case-insensitively, but staging-table names use it verbatim). No two devices at the same location use the same name (S8).
- [ ] The release APK contains the release `network_security.xml` (cleartext to any host), not the debug override.
- [ ] Application id is `com.physicalcount`, `versionCode` bumped, keystore backed up.
- [ ] One profile per location created on each handheld, with the right server address; `Test connection` passes on-site.

---

## 13. To confirm

| # | Question | Default until answered |
|---|---|---|
| Q1 | Host name/IP and port of each location's service (S18) | typed per profile in Settings; not needed for the build |
| Q2 | How long `InitPullTables` takes on the largest real count | 120 s timeout. Local measurement (step 4): 0.8–3.4 s warm, 24.3 s on a cold IIS application pool; the real count sizes and server are still to measure |
| Q3 | `@nativescript-community/sqlite` 3.5.x builds and runs on NativeScript 9.1.1; sync or async API; insert speed for 11k rows | **answered in step 1:** works; promise API running on the UI thread by default; ~2 s per 5000-row page on the emulator (§4.4) |
| Q4 | `@nativescript/unit-test-runner` 5.0.0 works with NativeScript 9.1 + webpack 5 | **answered in step 1:** works, with the setup notes in §11.2 |
| Q5 | `react-nativescript` 5.0.0 stays stable under core 9.1 | keep; it runs the template today |
| Q6 | `activityBackPressed` still fires with predictive back on API 33+ | **answered (step 5):** yes on API 34 (emulator); Back on Home moves the app to the background (§9.4). Re-check on the handheld's API level (§12.1) |
| Q7 | A barcode that points to two lines: first line (legacy) or Pick item? Real at CV: count 10 barcode `2000000000848` → stock ids 246 and 1416; counts 10–15 have 1–11 such barcodes each | **decided:** first line by `RowNumber`, as legacy; the operator types the reference to reach the second item (§5.2) |
| Q8 | QR stickers: 2- or 4-digit year | legacy conversion unchanged; tested at go-live |
| Q9 | Newland Android version, scanner Enter suffix, Wi-Fi reachability | §12.1 |
| Q10 | Final application id | **decided:** `com.physicalcount`, set in step 1 |
| Q11 | Local service for emulator tests | **answered:** full IIS (not IIS Express) at `http://10.0.2.2/ERPDataCollector/Service1.asmx` from the emulator: port 80, server address `10.0.2.2` |
| Q12 | `SP_DecNo` above 3 (the server column is `numeric(18,3)`, a hint only) | allowed decimals = `min(SP_DecNo, 3)` |
| Q13 | Page size and UI freezes. **Measured in step 1:** about **2 s of frozen UI per 5000-row page** on the emulator (parse 110–230 ms + insert 1.3–2.0 s, on the UI thread; §4.4) | **decided:** default page size **1000** (≈ 0.4 s per page on the emulator), still adjustable 1–5000 in Settings. **Step 3 measured the background-thread option** (§4.4 table): at 1000-row pages the longest UI block drops from ~450 ms to ~40 ms, at the cost of a ~2–2.5× longer download (≈ 9 s instead of ≈ 4 s for 11,131 lines). **Decided (after step 3): default page size 1000 with the background thread on.** Both are single constants in `src/config.ts` (`DEFAULT_PAGE_SIZE`, `DOWNLOAD_BACKGROUND_THREAD`) so they can change after the handheld test. The real-handheld measurement stays deferred (§12.1) |
| Q14 | A line whose server value already has more decimals than `SP_DecNo` allows (e.g. `7.5` with `SP_DecNo = 0`, entered elsewhere or before `SP_DecNo` changed) | **decided:** upload accepts up to 3 decimals regardless of `SP_DecNo` (the server column holds 3); `SP_DecNo` limits only typed input; a scan keeps the stored decimals and adds 1 (§3.7, §5.3) |
| Q15 | The service's own SQL command timeout (ADO.NET default 30 s) caps how long `InitPullTables` may take to prepare a count; past it the service returns the header only (S12). Locally, count 10 (11,131 lines) normally prepares in ~1 s but took >30 s when the PC was short of memory (SQL Server waited for a memory grant). The largest real count (~39k lines) on the production server has not been measured | **to confirm** on each location's server with its largest count; if it times out, the fix is on the server (memory / indexes), since the service cannot change (C1) |

---

## 14. Build order

1. **Spike — no screens.** Goal: prove parser + SQLite on NativeScript 9 before anything else.
   - Set the application id to `com.physicalcount` in `nativescript.config.ts` (Q10).
   - Add `@nativescript-community/sqlite`, `fast-xml-parser`, `vitest` (~4.1) and `@nativescript/unit-test-runner`.
   - Write only `soap/responses.ts`, `parse/insertInto.ts`, `parse/valuesQuery.ts`, `parse/rows.ts`, `storage/schema.ts` and a minimal `storage/locationDb.ts`.
   - **A test** (on the emulator, `ns test android`; fallback: debug spike entry point, Q4) that reads the saved `InitPullTables.count9-V2-UN3.response.xml` and the `pullRecords.count9-V2-UN3.*` responses (header from1; details from1, from51, from101, from103-past-end; barcodes empty) plus `pullRecords.count10-CV-UN.phyDetails.from1` / `phyBarcodes.from1`, parses them with the parser, and inserts them with bound parameters into a fresh `ERPDataCollectorNDB_TEST` database.
   - **Done (2026-09-30):** 74 Node tests and 12 device tests pass (`npm run test:node`, `npm run test:android`). A corrupted `valuesquery` is rejected by the tokenizer before anything is stored; the page rollback is proven with a database failure instead (a duplicate `Pcd_RecId` in the second row of a page leaves the first row unstored). Findings are recorded in §4.4 and §11.2, and in Q3, Q4 and Q13.
   - Pass criteria: `phyHeader` 1 row with `InvID='9'`, `UserToUpdate='4'`, `SP_DecNo='3'`; `phyDetails` 102 rows for count 9 in `RowNumber` order with row 1 = `Pcd_RecId 47842`, `Refernce 'N/PD/SEL/1/N'`, `exp '01.01.2025'`; past-end page adds nothing and triggers no error; count 10 barcodes 9 rows incl. the empty and duplicate ones; the column list check passes; a re-inserted page is de-duplicated; a corrupted `valuesquery` rolls back its page. Record the time per 50-row page and extrapolate to 11,131 rows (Q3, Q13).
   - Same parser modules also get their Node unit tests here (§11.2), run with `npm run test:node`.
2. **Pure core + Node tests:** envelope builders, validation (§3.7), decimal and count rules, QR conversion, lookup over a repository interface, screen-stack reducer.
   - **Done (2026-09-30):** `soap/envelopes.ts`, `domain/{check,validation,decimal,countRules,qr,lookup}.ts`, `shell/screenStack.ts`. `npm run test:node`: 10 files, **279 tests** pass (205 new in step 2; the step 1 parser tests also still pass). All 14 request builders match the saved `*.request.xml` byte for byte, and the test fails if a sample is left uncovered. A mutation check (a wrong `PIndex`; Pick item skipped) made 9 tests fail as expected. Pure modules pass a `--strict` TypeScript check. Decisions recorded in §3.7, §4.3, §5.2, §5.3 and Q14.
3. **Storage:** settings DB and profiles; location DB schema; staging, swap, resume, D8 count, restore uploaded; device tests. Includes a **device test that times page inserts with the plugin's background-thread option (`threading: true`) on and off** (same 1000- and 5000-row synthetic pages as the step 1 timing test) and records the result under Q13, so step 6 can choose.
   - **Done (2026-09-30):** `storage/{database,settingsDb,deviceSettings,locationDb,download}.ts`. Device tests (`npm run test:android`): 4 files, **51 tests** pass — 11 settings and profiles, 22 location database and staged download, 6 timing, and the 12 step 1 spike tests. Node tests: **286** pass. Covered: add / edit / delete / select profiles (one transaction, at most one selected, case-insensitive duplicate check, delete warns with the pending count and keeps the database, re-adding finds it again); schema and `user_version`; manifest, pages into `stg_*` with `RowsStored` in the same transaction, swap only when complete, staging cleared; network failure, Cancel, corrupted page and a database failure mid-page all leave the live sheet and its counts untouched; the live sheet is locked during a download; resume after closing and reopening the database continues from `RowsStored + 1`; overlapping pages de-duplicated; stalled download; Abandon; counting writes (`'8.500'` stored), the D8 count, Home counters, Restore uploaded; the lookup repository against real SQLite (unique reference, 7 lots of one item → Pick item, `%`/`_` literal, QR with day `00`, first barcode by RowNumber); switching profiles switches databases. The timing results are in §4.4 and Q13.
   - `tsconfig.json` now has `strict: true`: with `strict: false` TypeScript does not narrow the `Check` result type (`ok: true | false`), so valid code would not compile. The template files still compile.
   - Also added, because the storage layer needed them: `markUploaded` (used by step 9) and `getLine` (used by Scan).
   - The on-device vitest shim lacks `expect.any()` (and `vi.*`, §11.2); device tests use plain assertions instead.
4. **SOAP client + network config:** `client.ts` over `Http.request` with timeouts and the §3.2 outcomes; release and debug `network_security.xml`; manual download of counts 9 and 10 from the local service via `10.0.2.2` (Q11).
   - **Done (2026-09-30):** `soap/client.ts` + `soap/httpTransport.ts`, `src/config.ts`, release and debug `network_security.xml`, and `src/debug/liveDownload.ts`. The manifest needed no change for this step (`INTERNET` and the `networkSecurityConfig` reference were already there; the storage-permission clean-up stays in step 5).
   - The client returns every §3.2 outcome as a typed result with a message: `ok`, `noResults` ("No Data Found." for InitPullTables), `fault`, `unreachable` (refused, DNS, cleartext blocked, or an HTTP error status with a non-SOAP body; ASMX sends a Fault with HTTP 500, so the body is read before the status), `timeout` (the transport's own timeout, plus a JS guard 5 s later), `unparseable`, and `invalidInput` (a §3.7 check failed, nothing sent). `pageSourceFor(client)` plugs it into the step 3 download loop; a failure throws `SoapCallError` and leaves the download resumable. `insertDetail` exists and is tested against a fake transport only; it was not called against the service.
   - Node tests: 11 files, **308** (22 new, all with a fake transport). Device tests: still **51**.
   - **Live check against the local service** (`npm run debug:live-download`, emulator → `10.0.2.2`, full IIS, page size 1000, background thread on): **RESULT PASS** twice. Count 9 / V2 / UN3 → 1 / 102 / 0; count 10 / CV / UN → 1 / 11131 / 9, interrupted after 4 pages, database closed and reopened, resumed with Continue download (no second InitPullTables). Every downloaded row of the saved samples matched them exactly (count 9: header + all 102 lines; count 10: first 20 lines + all 9 barcodes), which also confirms the UTF-8 text survives the transport.

     | | InitPullTables | Paging | Total |
     |---|---|---|---|
     | Count 9 (102 lines), first run | 24.3 s | 1.6 s (2 pages) | 25.9 s |
     | Count 9, second run | 3.4 s | 0.3 s | 3.7 s |
     | Count 10 (11,131 lines, with the resume), first run | 2.5 s | 11.0 s (14 pages) | 13.6 s |
     | Count 10, second run | 0.8 s | 9.7 s | 10.5 s |

     The 24.3 s first call is most likely IIS starting the application pool after it had been idle; it is well inside the 120 s timeout. Each InitPullTables call rebuilt the local server's staging tables for V2UN3 and CVUN (S8), as expected; nothing else was written.
   - Observation for the go-live clean-up item (§12.2): line 47842 at V2 came back identical to the saved sample (slot 4 empty, `Pcd_DateCount` Dec 31 2022), so the 5-then-7 test value appears to have been reverted on the local database already.
   - **Timing split (added before step 5).** `runDownload` takes an optional `stats` object (fetch, row parsing, storage, swap) and the live check times the transport, so each download is split into its parts; the live check also prints a PASS/FAIL line per count with the rows checked. Two runs, emulator → local IIS, 1000-row pages, background thread on:

     | | InitPullTables | Network (pages) | XML read | Row parsing | Storage | Swap | Paging total | Result |
     |---|---|---|---|---|---|---|---|---|
     | Count 9 (1 / 102 / 0) | 1.85 / 3.41 s | 0.09 / 0.07 s | 0.01 / 0.00 s | 0.00 / 0.00 s | 0.12 / 0.12 s | 0.03 / 0.02 s | 0.25 / 0.21 s | PASS / PASS |
     | Count 10 (1 / 11131 / 9, with resume) | 0.82 / 0.60 s | 2.83 / 1.08 s | 0.21 / 0.18 s | 0.05 / 0.04 s | 7.86 / 8.69 s | 0.62 / 0.15 s | 11.63 / 10.19 s | PASS / PASS |

     Storage is about 75–85 % of a large download: with the background thread every row is its own message to the worker (Q13 trade-off). If the handheld is too slow, a batched insert inside the worker would cut this; not done.
5. **App shell:** remove the template screens and navigation packages; shell, header, screen stack, Back handling (Q6), system bars (§9.2) checked with 3-button and gesture navigation; manifest clean-up; Home and Settings (profiles, machine name, page size, test connection, restore uploaded).
   - **Done (2026-09-30):** `src/shell/{AppShell,AppContext,Header}.tsx`, `src/screens/{HomeScreen,SettingsScreen,PlaceholderScreen}.tsx`, `src/soap/connectionTest.ts` (+ `httpGet`), `src/app.css`. Removed: `MainStack`, `ScreenOne`, `ScreenTwo`, `NavigationParamList`, `react-nativescript-navigation` (and with it `@react-navigation/core`). One `Frame`, one `Page` with the action bar hidden; the shell holds the settings database, the selected profile and its location database (opened with the background thread, §4.4), and swaps the location database when the selected profile changes.
   - Home and Settings as specified (§2.1, §2.2). Settings checks every field on each keystroke and again on save; the duplicate-location message comes from the settings database. Test connection is a GET for `…/Service1.asmx?WSDL` (10 s, `CONNECTION_TEST_TIMEOUT_MS`) and reports reachable only when the answer is the service's WSDL; it calls no method. Scan, Items, Download and Upload are placeholders with a Back button.
   - `tsconfig.json` `include` was `"./src/**/*.tsx?"`, which is not a valid glob, so `.tsx` files were never type-checked; it is now `["./src/**/*.ts", "./src/**/*.tsx"]`.
   - The device settings test now restores the emulator's real machine name and page size (the test build shares the app's storage).
   - Tests: Node **313** (5 new, Test connection); device **51**. The screens were checked by driving the emulator with adb (UI dumps and screenshots): profile V2 → `10.0.2.2`, machine UN3, Test connection "Reachable: 10.0.2.2"; duplicate `v2` refused; second profile CV; switching shows count 9 / 102 lines at V2 and count 10 / 11131 lines at CV, each only its own; the machine-name-change warning and the delete confirmation appear and Cancel changes nothing; Back pops, and on Home moves the app to the background.
   - Release APK built once, debug-signed (`ns build android --release` with the standard debug keystore), and inspected with `aapt2`: see §9.1 and §9.5.
6. **Download screen:** D8 prompt, progress per table, cancel, continue/restart/abandon, keep-screen-on. **Requirement: the screen stays responsive between pages** — the progress bar and row counter update after every page, and **Cancel** is accepted between pages (the UI thread is released after each page, e.g. by awaiting the next frame before the next `pullRecords`, or by the background-thread option from step 3).
   - **Done (2026-09-30):** `src/screens/DownloadScreen.tsx`, `src/storage/downloadFlow.ts` (InitPullTables + manifest + `startDownload`; operator messages for page errors), `src/domain/downloadText.ts` (texts, unit-tested), `src/platform/{keepScreenOn,deviceInfo}.ts`, a Back guard in the shell (`goBack`, `setBackGuard`), and the debug-only `src/debug/DebugTools.tsx` (Settings → "Mark lines as counted"). Debug-only code is behind `__DEBUG_TOOLS__` (webpack DefinePlugin, `!env.production`); a release bundle was prepared and contains none of it. Download uses the Settings page size (default `DEFAULT_PAGE_SIZE` 1000) and `DOWNLOAD_BACKGROUND_THREAD`.
   - Settings' machine-name warning now appears only when the new name differs from the sheet's machine (it also fired when changing back to the sheet's own name).
   - Tests: Node **324** (13 files), device **56** (5 files: 5 new download-flow tests through the real client over a fake transport).
   - **Emulator walkthrough (API 34, local IIS)** through the real screens:
     1. Count 9 (V2 / UN3): 1 / 102 / 0 in 3.7 s; Home 102 not counted. Count 10 (CV / UN): 1 / 11131 / 9; Home 11131, machine UN (from the sheet).
     2. Cancel mid-download (count 9 at 46 of 102; count 10 at 8000 of 11131): Home kept the old sheet and its counts, said why Scan / Items / Upload are locked, and Scan did nothing; Continue resumed without InitPullTables and completed. Abandon cleared staging and left the old sheet (11131).
     3. Force-stop at 3000 of 11131, reopen: Home showed the lock, Download showed "stopped at 3001 of 11141 rows", Continue completed (10.7 s).
     4. Debug "mark 5 lines": Home 97 / 5; the D8 prompt showed the exact text and three buttons; no server call before a choice; Cancel → count field, Upload first → Upload placeholder, Discard → download.
     5. Count 999999 and machine ZZ9 on count 10: the legacy title and the four causes (0.5–0.6 s); nothing changed.
     6. Network (Wi-Fi and mobile data) off at 4000 of 11131: the next page failed within ~1 s with "Cannot reach the server at 10.0.2.2. The count already on this device is unchanged."; back on, Continue completed (6.5 s). Network off before starting: same message, nothing changed.
     7. Count 10 end to end: **20.8 s** (InitPullTables 7.7 s + 12 pages 12.6 s, ~1.1 s per 1000-row page). **Cancel took effect 268 ms and 401 ms after the tap** (the current page finishes first). Back during a download asks "Cancel the download?" (Keep downloading / Cancel download).
   - **Local server was unstable during these tests:** the PC had ~0.6–1 GB free of 7.7 GB, SQL Server was trimmed to ~90 MB and queued the details query for a memory grant until its 30 s timeout, so InitPullTables often returned the header only (now shown as the "incomplete" message above) or the connection was dropped ("Software caused connection abort", "Failed to connect"); IIS also shuts idle app pools down, so the first call after a pause is slow. Each failure showed the right message and Try again; retries eventually succeeded. See Q15.
7. **Scan screen:** scan field (§9.3), lookup, count rules and D5, beep/tone, Pick item overlay, display mode.
   - **Done (2026-09-30):** `src/screens/ScanScreen.tsx` (with the Pick item overlay), `src/platform/scanField.ts`, `src/platform/beeper.ts`, `LocationDb.searchByReferencePrefix`, and a debug-only "Open line in Scan" in Settings → Debug tools (display mode until Items exists).
   - Behaviour added on top of §5 / §9.3: scans and correction buttons run **one at a time in a queue**, so fast scans never read the same stored total twice; at Enter the field's text is selected **at once** (so the next code replaces it even if it starts within 100 ms), and the 100 ms re-arm only re-selects when no new characters arrived; a scan while Pick item is open closes it and counts as a normal scan (focus stays on the scan field under the overlay); Back closes Pick item first. The last-scan controls are disabled in display mode.
   - Tests: Node **326**; device **57** (Pick item search against SQLite).
   - **Emulator walkthrough (API 34), adb typing as a wedge (text + Enter):**
     1. Count 10 (CV / UN): `5285002192105` → line 43377; `2000000000848` → line 40767 (first barcode row, stock 1416); typing `A/PD/CS6/1/F` (the second item, stock 246) opened Pick item with its 28 lots; tapping line 36341 counted it.
     2. `a/fp/jv1/5/` (one match, lower case) counted line 34897 directly; `A/PD/CS6/1/F` and `N/PD/SEL/1/N` (28 and 7 lines) opened Pick item.
     3. `829|00/06/2019|17347003` → 43377 (`06.2019`); `9|31/12/2017|LT0` → 34366; `9|31/12/17|LT0` → Item Not Found (2-digit year, legacy conversion; go-live check); `9|31/12|LT0` → "Invalid QR".
     4. `9999999999999` → red "Item Not Found: 9999999999999", no dialog, text selected; an empty Enter is ignored.
     5. Update Last Scan Qty (3 + (5 − 1) = 7), Cancel Last Scan (8 → 7), Update Total Scanned (20); after either last-scan action both last-scan buttons are locked (taps do nothing) until the next scan; every change was in the database at once (`20.000`, state 1).
     6. 9999 → scan → 10000 → 10001; 1234567 → 1234568; Last Scanned 100000 → 1334567 (no length lock). V2 (SP_DecNo 3): 2.5 → 3.5 → Last 0.25 → 2.75; 1.2345 → "Total: At most 3 decimals."
     7. 20 rapid scans of one reference and 20 alternating between two: first build lost 1 and garbled 3 (IME), after the `TYPE_NULL` change **80 of 80 counted** (47901: 26 → 86, 47902: 10 → 30).
     8. After every scan, button, Pick open / Close / Back / scan-while-open: scan field focused, soft keyboard hidden (`mInputShown=false`); tapping the scan field shows no keyboard; the Pick search field does show it and it is hidden again after Close.
     9. Scan, force-stop 0.5 s later, reopen: 31.000 in the database, Home 99 / 3, display mode shows 31 without counting.
     10. `[scan] ToneGenerator created` on every open and `released` on every close (4 opens, 4 releases).
   - Not exercised on the emulator: the negative-stored-total block (no negative values in the local data; covered by Node tests).
8. **Items screen:** two tabs, virtualised list, open in Scan.
   - **Done (2026-10-01):** `src/screens/ItemsScreen.tsx`, `src/platform/itemCell.ts`, `src/domain/{itemText,pagedList}.ts`, `LocationDb.listLines`, schema version 2 (§4.2), the Items route's `position`. Design in §2.3. Also in this step: Pick item rows and order (§2.1), Settings → Advanced → Scanner input (§2.2, §9.3), and the debug-only "Mark counted lines as uploaded".
   - Changed from the plan as written: the extra index and schema version 2 (§4.2); list rows are plain NativeScript views instead of React cells (§2.3); the debug "Mark lines as counted" now reads only the lines it needs instead of the whole sheet.
   - Tests: Node **353** (15 files; 27 new: row texts incl. `SP_Expiry = 'N'`, expiry order, tab labels, empty states, the paged list incl. "never more than 600 lines in memory over 11,131 rows", the Items route position). Device **66** (5 files; 9 new: list pages by state and RowNumber, uploaded lines in neither list, version 1 → 2 upgrade with the query plan using the index and no sort, Pick item order by expiry before the limit, scanner input setting).
   - **Emulator walkthrough (API 34), through the real screens:**
     1. Count 10 (CV / UN), freshly downloaded: tabs `Counted (0)` / `Not counted (11,131)`; Counted shows "Nothing has been counted yet. Counted lines appear here."
     2. Scanned three lines (43377 three times, 34897, 40767): Home 11128 / 3 / 0; tabs `Counted (3)` / `Not counted (11,128)`; Counted lists the three in RowNumber order with totals 1, 1, 3.
     3. Not counted scrolled part-way (a row cut at the top), tapped a row: Scan showed "Viewing line 34507 (not counted). Scan to count.", total 0, numbers unchanged. Back: same tab, and the screen was pixel-identical to before the tap apart from the status bar. Same on the Counted tab (line 40767). After returning from Scan, the *other* tab starts at its top.
     4. Debug "mark 2 counted lines as uploaded": Settings "2 lines uploaded", Home 11128 / 1 / 2, tabs `Counted (1)` / `Not counted (11,128)`; the two lines are in neither tab.
     5. Not counted, top to bottom (270 flings, 154 s with the measuring in between): first row shown **235–270 ms** after opening (537 ms the first time after a download, 358 ms after an app restart); at most **600 lines in memory** throughout (115 page loads); app memory (PSS) **145.7 MB with Items open → 157.3 MB peak** (+11.6 MB); only the first screenful appeared as placeholders (10 of 1,500 rows in a later run). Filling one row takes ~2.2 ms of app time. **Smoothness could not be judged on this emulator:** `dumpsys gfxinfo` reports a median frame of 105–117 ms for Items flings and 77 ms for slow drags, but a plain scroll of the Settings screen on the same emulator reports 101 ms, so the emulator (and the PC's free memory) is the limit, not the list. To measure on the handheld (§12.1).
     6. Count 9 (V2 / UN3, `SP_DecNo` 3): totals set to 12.345, 31.5 and 0.125 show exactly so on the Counted tab; Home 99 / 3 / 0. The V2 database was a real version 1 file and was upgraded on opening.
     7. `SP_Expiry = 'N'`: no local count has it; covered by Node tests (Items rows on both tabs and Pick item rows show no expiry or lot).
     8. Scanner input: Key events (`inputType 0`) → 1 scan + 10 rapid scans all counted; switched to Text input in Settings (`inputType 524289`) → single scan counted once, **8 of 10 rapid scans counted and 2 arrived with characters out of order** (the step 7 keyboard-app problem, as expected for this mode); switched back → 10 of 10. Soft keyboard hidden in both modes.
   - Pick item on count 9, `N/PD/SEL/1/N`: 7 rows, `Lot J16-3135 · Exp 01.01.2025` first, then the five `01.2050` lots by RowNumber, then `01.01.2050`.
   - Not exercised on the emulator: the screen's own "no sheet" / "download in progress" messages (Home disables Items in those states, so they can't be reached by tapping).
9. **Upload screen:** confirmation, sequential `InsertDetail` from `transCount` 1, stop on first error, **screen kept on during the upload** (as during download); tested only on count 9 / V2.
   - **Built (2026-10-01), emulator upload tests still to run:** `src/screens/UploadScreen.tsx`, `src/storage/upload.ts`, `src/domain/uploadText.ts`, `LocationDb.pendingLinesAfter` / `recordUpload`, schema version 3 (§4.2), Home's "Last upload" line, debug-only `src/debug/uploadDelay.ts`. `PlaceholderScreen` is removed (no screen uses it any more). Details in §6.2.
   - Changed from the plan as written: schema version 3 for the last upload; a line that fails its own check stops the run instead of being skipped (§6.2).
   - Tests: Node **387** (16 files; 34 new, built on the saved `InsertDetail` response: full run, the three refusals, SQL-error shortening, non-`ok` answers, timeout, lost connection, cancel, next run from `transCount` 1, header and line checks, texts). Device **76** (6 files; 10 new: upload over the real database, last upload stored and cleared by a download, and upgrades from schema versions 1 and 2 with lines in states 0, 1 and 2 keeping every total and state).
   - Step 8 follow-up: the empty-tab sentence on Items sits at the top, directly under the tabs (checked on the emulator).
   - Emulator, before any upload: with nothing counted, Upload shows "No Counted Items Found."; with 7 lines counted on count 9 / V2 / UN3 it shows "This Physical Count Contains 7 Items. Upload?" and Cancel returns to Home without a call.
10. **Release:** keystore, signed release APK, install on the emulator with `adb install -r`.
11. **Handheld:** §12.1 deferred checks, then the §12.2 go-live checklist.
