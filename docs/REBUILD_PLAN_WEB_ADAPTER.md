# Rebuild Plan — Physical Count web app (SOAP adapter)

Inputs: `LEGACY_ANALYSIS.md`, the service source (`ERPDataCollectorWebService/`, read-only; working copy `ERPDataCollectorWebService_local/`), the `Physical Count Backend` (.NET 8 template), and the `Physical Count FrontEnd` (React CRA + PWA service worker).
The earlier direct-database design is kept, unchanged, in `REBUILD_PLAN_DIRECT_DB.md`.

**Status:** plan only; no application code has been written.
- The service contract has been **confirmed from the VB source**, from the WSDL (`docs/service-samples/Service1.wsdl`), and from test calls to the local copy against the local database. §6 lists what was confirmed.
- Raw SOAP request and response samples for backend tests are in `docs/service-samples/`.

---

## 0. Ground rules

| # | Rule | Where it shows up |
|---|---|---|
| C1 | **`Service1.asmx` stays exactly as it is and is never modified** | whole plan |
| C2 | The new backend calls it **over SOAP the same way the Android app does**: `InitPullTables`, `pullRecords`, `InsertDetail`, with the same parameters and responses (LEGACY_ANALYSIS §4) | §3 |
| C3 | **The backend never connects to the ERP database and runs no SQL** | §3 |
| D1 | Keep the exact lookup order: **exact barcode → reference prefix → QR** | §4.2 |
| D2 | Keep the prefix-match behaviour | §4.2 |
| D3 | No new tables | §4.1 |
| D4 | Machine name is typed by hand, as before | §2, §3.1 |
| D5 | Fix the "Incorrect Qty" lock at 10000+ | §4.3 |
| D6 | Play a sound on a good scan | §4.4 |
| D7 | Parameterized queries. With C3 in place there are **no queries to parameterize**: the SQL fragments the service returns are **parsed as data and never executed** (§3.5). The browser uses IndexedDB key lookups, not SQL. The service itself builds all of its SQL by string concatenation (§6, S20), so the adapter **strictly validates every value before it reaches the service** (§3.7). | §3.5, §3.7, §4.5 |
| D8 | Warn before a re-download would drop counts that haven't been uploaded | §4.1 |

**Shape of the system.**

```
Handheld browser (React PWA)            New .NET backend (adapter)              Existing, unchanged
IndexedDB: sheet, lines, barcodes  ⇄    JSON endpoints  ⇄  SOAP 1.1 client  ⇄   http://<host>/ERPDataCollector/Service1.asmx
counting runs offline                   stateless, no DB, no SQL                (reads/writes the ERP DB itself)
```

As in the Android app, the device holds the downloaded sheet and the counts, and uploads later. The backend only translates between JSON and SOAP.

---

## 1. Database findings: background only

**The backend does not connect to the database (C3).** The earlier metadata-only inspection is in `REBUILD_PLAN_DIRECT_DB.md` §1. The service source has now confirmed what each legacy field really is, so these are **no longer guesses**:

| Legacy field the device receives | What the service puts in it (`Service1.asmx.vb`, `InitERPPhysicalCountTables`) |
|---|---|
| `Pcd_RecId`, `Pcd_Loc`, `Pcd_stkId`, `Pcd_Batch`, `Pcd_Grid`, `Pcd_DetGrid`, `Pcd_Color`, `Pcd_DateCount`, `Pcd_QtyCounted1..6`, `Pcd_Type1..6` | the same columns of `tbl_PhysicalCountDetail` |
| `Refernce`, `stk_Desc` | `STK_ref`, `stk_Desc` from `STK04_stkfil` (or `pos_stkfil` when the location's `loc_Type3 = 'S'`) |
| `Color_Desc` | `Stk04_COLOR.Color_Desc` |
| `exp` | `Pcd_ExpDate` with a leading `00.` removed (`00.MM.YYYY` → `MM.YYYY`) |
| `Pcd_Qty` | `Pcd_Qty`, **or the literal `0`** when any user holds the `mnuOperCountManModify` privilege without the "show available quantity" exception |
| `usercounted` | this machine's slot `Pcd_QtyCountedN`, NULL → 0 |
| `InvID` | the count number the user typed (`Extras`) |
| `UserToUpdate` | the slot number `1`–`6` where `Pch_MachUserN` = the machine name |
| `SP_DecNo`, `SP_Fashion`, `SP_Expiry` | `stk04_SysParam` (last row read) |

---

## 2. Screen → web page map

The routes live in the existing React app and use the brand design system components. The pages are sized for the handheld (portrait, about 360–480 px wide).

| Legacy screen | Web page (route) | Notes |
|---|---|---|
| `MainActivity` | **Home** `/` | Five tiles: Scan, View Items, Download, Upload, Settings. Scan, View and Upload are disabled until a download is complete (same rule as legacy). Shows the active count number, location, and the number of pending and uploaded lines. |
| `MainActivity` "Enter Physical Count Number" dialog | **Download** `/download` step 1 | Input for the count number. It is sent as `Extras`, and the service decides which rows belong to it (S7). |
| `Synchronize` (Download) | **Download** `/download` step 2 | One progress bar per table the service returns, labelled with its `PullDisplayHeader`. Cancel and resume. The D8 warning appears **before** anything is replaced. |
| `Synchronize` (Upload) | **Upload** `/upload` | "This count contains N items — upload?", then per-line progress "Row x/N" (one `InsertDetail` per line), Cancel, and a result screen. |
| `BarcodeScan` | **Scan** `/scan` | The scan input keeps focus. Line details, Total, Last Scanned, the three buttons, and sounds (D6). `/scan?line=<Pcd_RecId>` opens a line in view mode (legacy ViewItems → BarcodeScan). |
| `MultiSearchActivity` | **Pick item** modal on `/scan` | Opens when the prefix search matches more than one line. It has a live search box pre-filled with the scan. Picking a line counts +1, as in legacy. |
| `ViewOptions` + `ViewItems` | **Items** `/items?tab=counted\|not-counted` | Two tabs: `state=1` and `state=0`. Tapping a row opens `/scan?line=…`. Uploaded lines (`state=2`) stay hidden, as in legacy. |
| `Settings` | **Settings** `/settings` | Location (2 characters, as legacy), Machine name (free text, D4), Download page size, and the **Restore uploaded** button (sets `state 2 → 1` on the device). |
| `ServerSettingsActivity` + `ConfigurationSettingsList` | *(folded into Settings)* | The server URL per location moves into **backend configuration** (§3.0). The browser never supplies a URL. |
| `ListNotScannedItems` | *(dropped)* | Dead code in legacy. |
| — | **Login** `/login` (existing template page) | Only if the API is protected. See X1 in §7. |

---

## 3. Adapter endpoints (JSON ⇄ SOAP)

### 3.0 Shared SOAP mechanics (confirmed from the WSDL)

| Item | Service (WSDL / source) | Backend |
|---|---|---|
| Endpoint | `http://<host>/ERPDataCollector/Service1.asmx` | Same URL, read from **backend config** keyed by location code, e.g. `ErpService:Urls:{"01":"http://…/ERPDataCollector/Service1.asmx"}`. The client sends only `loc`. An unknown `loc` → 400. This prevents the browser from pointing the backend at arbitrary hosts. |
| Protocol | SOAP 1.1 binding `Service1Soap`, document/literal. SOAP 1.2, HTTP GET and HTTP POST bindings also exist, but are not used | SOAP 1.1 over `HttpClient`, `Content-Type: text/xml; charset=utf-8` |
| SOAPAction | `http://tempuri.org/InitPullTables`, `…/pullRecords`, `…/InsertDetail` | same |
| Request body | `<Method xmlns="http://tempuri.org/"><param>value</param>…</Method>`. **Every parameter is `s:string`**, with `minOccurs=0` | same, built by hand, with XML-escaping as the only transformation. A WSDL-generated proxy isn't needed; the saved WSDL is the reference |
| Response body | `<MethodResponse><MethodResult>…</MethodResult></MethodResponse>` | read `MethodResult` by name |
| Timeout | the Android app used 30 s | 30 s by default, configurable per method (S18) |
| Errors | **The service catches every exception and returns an empty or partial result.** `InitPullTables` and `pullRecords` never fault on SQL errors. `InsertDetail` returns an error string (S4) | see the table below |

**Error mapping**

| SOAP-side outcome | JSON returned to the browser |
|---|---|
| HTTP 200 with a normal response | 200 with the mapped body |
| `pullRecordsResult` has no `mRecords` (sample: `<pullRecordsResult />`) | 200 with `{"noResults": true}`. This also happens when the staging table is missing or a server error was swallowed |
| `InitPullTablesResult` has no `mTableInfo` | 200 with `{"noResults": true}`, and the UI shows "No Data Found." This means the service failed before building any table (a swallowed exception) |
| SOAP Fault (only for malformed requests) | 502 `{"error":"ServiceFault","message":"<faultstring>"}` |
| HTTP error, or connection refused | 502 `{"error":"ServiceUnavailable","message":…}` |
| Timeout | 504 `{"error":"ServiceTimeout"}` |
| Response not parseable (§3.5) | 502 `{"error":"UnparseableResponse","detail":…}`. The whole page is rejected, and no partial rows are returned |

Base path: `/api/physical-count`. IDs are sent as strings.

---

### 3.1 `POST /api/physical-count/downloads` → `InitPullTables`

This starts a download, replacing legacy `PullInitTransferTables`. **The browser calls it only after the D8 check (§4.1)**, because `InitPullTables` **drops and rebuilds this location + machine's staging tables on the server** (S8, confirmed).

**JSON request**
```json
{ "loc": "01", "machine": "HH01", "countNumber": "1234", "deviceInfo": "Device Model: …\nDevice Manufacturer: …\nDevice Brand: …\n" }
```

**SOAP call** (WSDL order: `ApplicationName, SelectedLocation, MachineName, Extras, DeviceInfo`; all strings)

| SOAP parameter | Value |
|---|---|
| `ApplicationName` | the constant `"ERPDATACOLLECTOR"`. It is also used verbatim in the server's staging-table names |
| `SelectedLocation` | `loc` (validated, §3.7) |
| `MachineName` | `machine` (validated, §3.7) |
| `Extras` | `countNumber` (digits only, §3.7) |
| `DeviceInfo` | `deviceInfo`. The service **ignores** it (`CheckDevice` is commented out), but it is sent in the legacy format for fidelity |

**Reading the SOAP response** (sample: `InitPullTables.count9-V2-UN3.response.xml`)
1. `InitPullTablesResult/mTableInfo/TableInfo[]`. Each `TableInfo` has exactly these string fields: `TableName, RowsCount, OriginalTableName, LastImportedRow, PullDisplayHeader, InsertInto, PullFinished, PullPreparedDT, SelectedLocation, MachineName, CreateTable, Notes`. If `mTableInfo` is missing → `{"noResults": true}`.
2. Keep the records where `SelectedLocation == loc` and `MachineName == machine`, as legacy did. The service always echoes both back.
3. For each record, parse the column list out of `InsertInto` (§3.5.1). **Neither `InsertInto` nor `CreateTable` is executed or sent to the browser.**
4. Put the record's `TableName`, `OriginalTableName` and parsed columns into an **HMAC-signed pull token**. The backend also checks that `TableName` matches `^_ERPDATACOLLECTOR_tbl_PhysicalCount(Header|Detail|DetBarcode)_[A-Za-z0-9]+$`, because the service splices `TableName` straight into SQL.
5. **Not downloadable** → 422 `{"error":"InventoryNotDownloaded"}`, and the UI shows the legacy *"Selected Inventory Not Download Or Does Not Exist!!!"* with the likely causes.
   - **Condition:** no `phyDetails` record, **or** `phyHeader.RowsCount = 0`.
   - **Why it happens:** the service returns **only a `phyHeader` record with `RowsCount = 0`** when the count doesn't exist at this location, is cancelled (`Pch_Status='C'`), has already been posted (`Pch_Updated<>'N'`), or this machine name isn't one of `Pch_MachUser1..6`. The samples `…count999999-not-found…` and `…machine-not-assigned…` show this.

**JSON response**
```json
{ "tables": [
  { "token": "<signed>", "originalTableName": "phyHeader",   "displayHeader": "Synchronizing Physical Count Header", "rowsCount": 1,   "columns": [ … ] },
  { "token": "<signed>", "originalTableName": "phyDetails",  "displayHeader": "Synchronizing Details",               "rowsCount": 102, "columns": [ … ] },
  { "token": "<signed>", "originalTableName": "phyBarcodes", "displayHeader": "Synchronizing Barcodes",              "rowsCount": 0,   "columns": [ … ] } ] }
```
- The service always returns exactly these three tables, in this order (S9).
- `LastImportedRow` is always `"0"` and `PullFinished` is always `"0"`.
- `PullPreparedDT` (`dd/MM/yyyy HH:mm:ss`, server local time) and `Notes` (always empty) are not used.
- A table with `rowsCount = 0` is complete immediately, without any `pullRecords` call. Count 9 has no barcodes, for example.

---

### 3.2 `GET /api/physical-count/downloads/page?token=…&startFromRow=N&pageSize=5000` → `pullRecords`

Fetches one page of one table, replacing legacy `PullRecords` / `NewPullTable`. It is called repeatedly per table, and also by **Continue download**, which **does not call `InitPullTables` again**. The server's staging tables persist until the next `InitPullTables` for the same location + machine (S8).

**SOAP call** (WSDL order: `TableName, PIndex, PSize, StartFromRow`; all strings)

| SOAP parameter | Value |
|---|---|
| `TableName` | from the verified token (never from the query string) |
| `PIndex` | the constant `"0"`. It is **ignored** by the service whenever `StartFromRow` is not empty |
| `PSize` | `pageSize` (default 5000; the backend caps it at a configured maximum) |
| `StartFromRow` | `startFromRow`. The service returns `RowNumber BETWEEN StartFromRow AND StartFromRow + PSize − 1`, which is **1-based and inclusive** |

**Reading the SOAP response** (samples: `pullRecords.count9-V2-UN3.phyDetails.from1/from51/from101/from103-past-end`)
1. `pullRecordsResult/mRecords/Record[]/valuesquery`. There is **exactly one `valuesquery` string per `Record`**, and it is one row's value list. If `mRecords` is missing → `{"noResults": true}` (sample: past-end and empty table).
2. Tokenize each `valuesquery` (§3.5.2) and zip it with the token's columns (§3.5.1). The value count must equal the column count, or the page is rejected.
3. The service's page query has **no `ORDER BY`**, so rows are **sorted by `RowNumber`** (always the first column) before they are returned.

**JSON response**
```json
{ "originalTableName": "phyDetails", "rows": [ { …typed fields…, "fields": { "<column>": "<raw text>", … } } ],
  "rowCountInPage": 50, "noResults": false }
```

**When the browser stops paging** (fixes the legacy infinite loop): a table is complete when stored rows ≥ `rowsCount`. If a page comes back `noResults` or empty, or adds no new `RowNumber`s, while stored rows are still below `rowsCount`, the download stops with *"Server returned x of y rows — restart download"*. This happens, for example, when another `InitPullTables` for the same location + machine has replaced the staging tables.

---

### 3.3 `POST /api/physical-count/uploads/line` → `InsertDetail`

Sends **one line**. The browser calls it once per counted line, **sequentially**, and **stops on the first error**, as legacy `UploadDetails` / `PushItemDetail` did.

**JSON request**
```json
{ "loc": "V2", "transCount": 1, "invId": "9", "localId": "1", "pcdRecId": "47842", "counted": 7, "userToUpdate": "4" }
```

**SOAP call** (WSDL order: `transCount, SelectedLocation, uInvID, id, Pcd_RecId, usercounted, uUserToUpdate`; all strings)

| SOAP parameter | Value | What the service does with it (`InsertDetail`) |
|---|---|---|
| `transCount` | 1-based sequence within this upload run | **Only when it equals `"1"`** does the service check the header: it refuses if the count doesn't exist at this location, is cancelled, or has already been posted. Each run **must** start at 1 |
| `SelectedLocation` | `loc` | header check and `WHERE Pcd_loc = …` |
| `uInvID` | header `invId` (= the count number) | header check only |
| `id` | `localId` | **ignored** |
| `Pcd_RecId` | `pcdRecId` | `WHERE Pcd_RecId = …`. There is **no count filter**, so the browser must only send IDs from the downloaded sheet |
| `usercounted` | `counted`, the **absolute total**, e.g. `"7.0"` | spliced in as a SQL number: **`SET Pcd_QtyCounted<uUserToUpdate> = <usercounted>`, which replaces the stored value** |
| `uUserToUpdate` | header `userToUpdate` (`"1"`–`"6"`) | chooses the column. It also sets `Pcd_Type<N> = 10` and `Pcd_DateCount = getdate()` |

**Reading the SOAP response** (`InsertDetailResult`, a string)
- **Exactly `"ok"`** → 200 `{"ok": true}`. The browser sets the line to `state = 2`.
- **Anything else** → 200 `{"ok": false, "message": …}`. The browser stops the run. The known texts are "This Physical Count Was Cancelled", "This Physical Count Was Already Updated To Stock", "This Physical Count Does Not Exist", and `<UPDATE statement>:<SQL error>`. For the last one, the adapter **logs the full text but returns only the SQL error part**, so the SQL isn't shown to the user.
- **Caution:** `"ok"` does **not** prove a row was updated. The service returns `"ok"` even when the `UPDATE` matched 0 rows (S4).

**Retry rule:** because the service **replaces** (confirmed by the 5-then-7 test: the row shows 7, not 12), sending the same absolute total again is harmless. After a timeout, the line stays `state = 1` and is sent again on the next run, as in legacy. "Restore uploaded" is safe for the same reason.

**Validation before calling the service:** see §3.7.

---

### 3.4 Endpoint summary

| Browser action | JSON endpoint | SOAP call | Calls per action |
|---|---|---|---|
| New download | `POST /downloads` | `InitPullTables` | 1 |
| Download pages / Continue download | `GET /downloads/page` | `pullRecords` | ⌈rows ÷ pageSize⌉ per table with rows |
| Upload | `POST /uploads/line` | `InsertDetail` | 1 per line with `state = 1`, stopping on the first error |

No other endpoints exist. `SP_*` comes from the downloaded `phyHeader` row, exactly as in legacy.

---

### 3.5 Parsing the SQL strings from the service (parse only, never execute)

#### 3.5.1 Column list from `InsertInto` (exact format confirmed)
The service builds it in `CommonInitTablesProc` as `"Insert Into " & OriginalTableName & "(" & cols & ") Values"`, where `cols` is the comma-joined column names of the staging query, in order, with no spaces and no quoting.

Exact strings returned (from `InitPullTables.count9-V2-UN3.response.xml`):

| Table | `InsertInto` |
|---|---|
| phyHeader | `Insert Into phyHeader(RowNumber,Pch_Recid,Warehouse,Pch_DateCount,Pch_MachUser1,Pch_MachUser2,Pch_MachUser3,Pch_MachUser4,Pch_MachUser5,Pch_MachUser6,Pch_Status,Pch_Updated,Pch_NbrItems,UserToUpdate,SP_DecNo,SP_Fashion,SP_Expiry,updated,InvID) Values` |
| phyDetails | `Insert Into phyDetails(RowNumber,Pcd_RecId,Pcd_Loc,Pcd_stkId,Refernce,stk_Desc,Pcd_Grid,Pcd_DetGrid,Pcd_Color,Color_Desc,exp,Pcd_Batch,Pcd_DateCount,Pcd_Qty,Pcd_QtyCounted1,Pcd_Type1,Pcd_QtyCounted2,Pcd_Type2,Pcd_QtyCounted3,Pcd_Type3,Pcd_QtyCounted4,Pcd_Type4,Pcd_QtyCounted5,Pcd_Type5,Pcd_QtyCounted6,Pcd_Type6,usercounted,updated) Values` |
| phyBarcodes | `Insert Into phyBarcodes(RowNumber,PcBarc_RecId,PcBarc_DRecId,PcBarc_Barcode,updated) Values` |

| Table | `CreateTable` |
|---|---|
| phyHeader | `CREATE TABLE IF NOT EXISTS phyHeader(_id INTEGER PRIMARY KEY,RowNumber INTEGER,Pch_Recid  TEXT,Warehouse  TEXT,Pch_DateCount  TEXT,Pch_MachUser1  TEXT,Pch_MachUser2  TEXT,Pch_MachUser3  TEXT,Pch_MachUser4  TEXT,Pch_MachUser5  TEXT,Pch_MachUser6  TEXT,Pch_Status  TEXT,Pch_Updated  TEXT,Pch_NbrItems  TEXT,UserToUpdate  TEXT,SP_DecNo  TEXT,SP_Fashion  TEXT,SP_Expiry  TEXT,updated  TEXT,InvID  TEXT)` |
| phyDetails | `CREATE TABLE IF NOT EXISTS phyDetails(_id INTEGER PRIMARY KEY,RowNumber INTEGER,Pcd_RecId  TEXT,Pcd_Loc  TEXT,Pcd_stkId  TEXT,Refernce  TEXT,stk_Desc  TEXT,Pcd_Grid  TEXT,Pcd_DetGrid  TEXT,Pcd_Color  TEXT,Color_Desc  TEXT,exp  TEXT,Pcd_Batch  TEXT,Pcd_DateCount  TEXT,Pcd_Qty  TEXT,Pcd_QtyCounted1  TEXT,Pcd_Type1  TEXT,Pcd_QtyCounted2  TEXT,Pcd_Type2  TEXT,Pcd_QtyCounted3  TEXT,Pcd_Type3  TEXT,Pcd_QtyCounted4  TEXT,Pcd_Type4  TEXT,Pcd_QtyCounted5  TEXT,Pcd_Type5  TEXT,Pcd_QtyCounted6  TEXT,Pcd_Type6  TEXT,usercounted  TEXT,updated  TEXT)` |
| phyBarcodes | `CREATE TABLE IF NOT EXISTS phyBarcodes(_id INTEGER PRIMARY KEY,RowNumber INTEGER,PcBarc_RecId  TEXT,PcBarc_DRecId  TEXT,PcBarc_Barcode  TEXT,updated  TEXT)` |

Parsing rule: the case-insensitive pattern `^\s*Insert\s+Into\s+(\w+)\s*\((.*)\)\s*Values\s*$`; split group 2 on `,` and trim. The column names are plain identifiers. `CreateTable` is only a cross-check (same columns, plus `_id` which is **not** in `InsertInto`). If the parse fails, the download is rejected at the start; there are no guessed columns.

#### 3.5.2 Tokenizing one `valuesquery` (exact format confirmed)
The service builds each row in `GetInsertValuesSqlQuery`:
- **Every value is single-quoted**, including numbers.
- **Single quotes are stripped from text** (`replace(…,'''','')`), so a value never contains `'`, and `''` escapes never occur.
- **NULL becomes `''`** (the empty string, never the `NULL` keyword).
- Numbers are `cast(… as nvarchar(18))`, e.g. `'0.000'` or `'47842'`.
- Datetimes arrive as SQL Server's default text, e.g. `'Dec 31 2022 12:00AM'`.

Example (sample `…phyDetails.from1…`, row 1):
`'1','47842','V2','992','N/PD/SEL/1/N','JELLY BOXES TAZAH CHERRY 85G','','','','','01.01.2025','J16-3135','Dec 31 2022 12:00AM','0','','','','','','','','','','','','','0.000','0'`

Tokenizer: a state machine that expects `'` … `'`, then `,` or the end of the string, repeated; whitespace outside quotes is ignored. Anything else, such as an unquoted token or an unterminated quote, is a parse error, and the page is rejected. Commas, parentheses and Unicode inside quotes are literal.

#### 3.5.3 Safety
These strings are **never executed** by the backend (which has no database) or by the browser (which has no SQL engine). They are treated as untrusted text. Size limits are enforced: maximum response size, maximum values per row, maximum string length.

---

### 3.6 Turning rows into named JSON fields

The column names are now confirmed (§3.5.1), so the legacy names are used directly; the earlier alias fallback is dropped. Each row also keeps a raw `fields` map. For numeric fields, `''` means null.

**`phyDetails` → line**
| JSON field | Column | Type / rule |
|---|---|---|
| `rowNumber` | `RowNumber` | integer. Used for sorting and de-duplication on resume |
| `id` | `Pcd_RecId` | string |
| `stkId` | `Pcd_stkId` | string (used by QR) |
| `reference` | `Refernce` | string (apostrophes already stripped by the service) |
| `description` | `stk_Desc` | string |
| `colorDescription` | `Color_Desc` | string, may be empty |
| `expiry` | `exp` | string **as received** (`DD.MM.YYYY` or `MM.YYYY`), used verbatim by the legacy QR comparison (§4.2) |
| `batch` | `Pcd_Batch` | string |
| `systemQty` | `Pcd_Qty` | decimal. It is `0` when the service hides quantities (§1) |
| `counted` | `usercounted` | decimal (e.g. `'0.000'`, `'7.000'`). This is **this machine's slot value on the server**, so the device starts from the total already uploaded |
| `initialState` | `updated` | always `'0'` from the service |
| `localId` | *(none)* | `_id` is not in the values. The browser assigns 1, 2, 3… in `RowNumber` order. It is only sent as `InsertDetail.id`, which the service ignores |
| `slotValues` | `Pcd_QtyCounted1..6`, `Pcd_Type1..6` | kept in `fields` only. Not shown and not used |

**`phyBarcodes` → barcode**
| JSON field | Column | Type |
|---|---|---|
| `rowNumber` | `RowNumber` | integer |
| `barcode` | `PcBarc_Barcode` | string (trimmed, as the scan input is) |
| `lineId` | `PcBarc_DRecId` | string (= `Pcd_RecId`) |

**`phyHeader` → header** (one row. The service's query can return more only if the same count number and location had two warehouse headers; the local DB has none of those, S7)
| JSON field | Column | Used by |
|---|---|---|
| `invId` | `InvID` | `InsertDetail.uInvID` |
| `userToUpdate` | `UserToUpdate` | `InsertDetail.uUserToUpdate` (`'1'`–`'6'`) |
| `decimals` | `SP_DecNo` | quantity input and validation (legacy: `"0"` means integers) |
| `fashion` | `SP_Fashion` | not used, as in legacy |
| `expiry` | `SP_Expiry` | `"N"` hides Expiry and Lot |
| `warehouse`, `dateCount`, `status`, `updated`, `nbrItems` | `Warehouse` (`wh1`/`wh2`), `Pch_DateCount` (`dd/mm/yyyy`), `Pch_Status`, `Pch_Updated`, `Pch_NbrItems` | shown on Home and Download |

**`usercounted` format on upload.** Invariant culture, `.` as the decimal separator, at least one decimal digit (`12` → `"12.0"`), no exponent, no thousands separators. The service splices it directly into T-SQL, so a comma decimal separator would break the statement (S6).

---

### 3.7 Input validation (protects the unchanged service)

The service builds every SQL statement by concatenating its parameters (S20), so the adapter only forwards values in these shapes. Anything else → 400, and the service is not called.

| Value | Rule |
|---|---|
| `loc` | `^[A-Za-z0-9]{1,2}$`, and present in the backend URL config |
| `machine` | `^[A-Za-z0-9]{1,5}$`. Five characters is the width of `Pch_MachUserN`, so a longer name can never match (S17) |
| `countNumber` / `invId` | `^[0-9]{1,18}$` |
| `pcdRecId` | `^[0-9]{1,18}$` |
| `userToUpdate` | `^[1-6]$` |
| `transCount` | integer ≥ 1 |
| `counted` | finite; ≥ 0; no more decimals than `SP_DecNo` allows (0 → integers, max 3); at most 99,999,999,999,999.999 so that the next download's `cast(… as nvarchar(18))` doesn't fail (S19) |
| `TableName` | only from a signed token, and matching the pattern in §3.1 |
| `pageSize` | 1…configured maximum |

---

## 4. Page behaviour and device storage

### 4.1 Device storage (IndexedDB, one database per `loc + machine`, as in legacy)

| Store | Key | Fields |
|---|---|---|
| `sheet` | `"current"` | countNumber, loc, machine, header (`invId`, `userToUpdate`, `decimals`, `fashion`, `expiry`), `tables[]` = {token, originalTableName, displayHeader, rowsCount, rowsStored, finished}, `complete` |
| `lines` | `id` | localId, rowNumber, stkId, reference, `referenceUpper` (indexed), description, expiry, batch, systemQty, `counted`, `state` (0/1/2, indexed) |
| `barcodes` | `barcode` | lineId |
| `settings` (localStorage) | — | loc, machine, pageSize |

**Download**
1. **D8 check first, before `InitPullTables` is called:** count the lines with `state = 1`. If there are any, show *"N counted lines on this device have not been uploaded. Downloading will discard them."* with **Upload first** (primary), **Download anyway**, and **Cancel**.
2. `POST /downloads` (§3.1).
3. Page each known table into **staging stores** with `GET /downloads/page`, where `startFromRow = rowsStored + 1`. Swap the staging stores in only when every known table is complete. A failed or cancelled download leaves the current sheet untouched. This also fixes the legacy bug where tables were dropped before the server was contacted.
4. **Continue download** resumes the staged tables using the stored tokens and `rowsStored`, without calling `InitPullTables` again.

**Upload**
1. Show *"This Physical Count Contains N Items. Upload?"*.
2. For each line with `state = 1` in `localId` order, call `POST /uploads/line`, one at a time, with `transCount` = 1, 2, 3….
3. On `ok`, set the line to `state = 2`. **Stop on the first error** and show the message. Lines already confirmed stay `2`.
4. Cancel is checked between lines.

**Restore uploaded:** sets `state 2 → 1` on the device only (the legacy SQL, moved client-side).

### 4.2 Scan lookup (D1, D2, same order as legacy)
The scan input fires on **Enter**. The value is `trim()`-ed.
1. **Exact barcode:** `barcodes.get(value)` gives a lineId. The line is counted.
2. **Reference prefix:** lines where `referenceUpper` starts with `value.toUpperCase()`. This is a case-insensitive ASCII match, like SQLite `LIKE`.
   - **Exactly one** match: counted automatically.
   - **More than one:** the Pick item modal opens, pre-filled with the scan. The chosen line is counted +1.
   - One small deviation: `%` and `_` are treated as literal characters. Legacy `LIKE` treated them as wildcards by accident.
3. **QR** (value contains `|`): `stkId|DD/MM/YY|Batch`, handled **exactly as legacy did**.
   - Build `exp1` = `MM.YY` when the day part is `00`, otherwise `DD.MM.YY`.
   - Match `stkId`, `expiry` and `batch` as exact strings.
   - This works because `expiry` is the same `exp` value the service sent the Android app (§3.6).
   - A malformed QR code shows "Invalid QR" instead of a generic error.
4. **Not found:** clear the fields, show **"Item Not Found"**, and play the error tone. The barcode is **not stored**, as in legacy.

### 4.3 Count rules (same formulas as legacy)
| Action | Formula |
|---|---|
| Scan | `total = stored counted + 1`, Last Scanned = 1 |
| Update Last Scan Qty | `total = Total field + (Last Scanned − 1)`, then the last-scan controls lock |
| Cancel Last Scan | `total = Total field − Last Scanned`, then the controls lock |
| Update Total Scanned | `total = Total field` |
Each change sets `state = 1`.

**D5 fix:** the legacy 6-character length check is removed. Instead:
- Values are parsed as numbers and must be finite.
- Values must be at least 0 (S19) and have no more than the allowed decimals. The upper bound is configurable, defaulting to the `numeric(18,3)` range (a hint from §1).
- Values are displayed with the configured decimals (`12`, not `12.0`).

An invalid entry is rejected with a message that names the actual problem. It never blocks the next scan.

### 4.4 Sound (D6)
Web Audio API, no files:
- **Good scan:** one short high beep (about 1.8 kHz, 80 ms).
- **Not found:** the two-tone alert (low then high), keeping the legacy distinction.

Browsers only allow audio after a user gesture, so the first tap on the Scan page unlocks it. A small speaker icon shows whether sound is on.

### 4.5 Handheld / scanner
- The scanner stays in keyboard-wedge mode with an **Enter suffix**. This is a device setting, so no SDK is needed; see LEGACY_ANALYSIS §6.
- The scan field uses `inputmode="none"` so the Android soft keyboard doesn't cover the screen. The wedge still types into it.
- After every scan and every dialog, focus returns to the scan field and its text is selected, as in legacy `Reinit()`.
- D7: the backend runs no SQL (C3). The browser does IndexedDB key and index reads. The SQL fragments from the service are parsed as data only (§3.5).

---

## 5. Legacy defects: fixed or kept

| Legacy issue | In the rebuild |
|---|---|
| 10000+ locks the screen | Fixed (D5) |
| No good-scan sound | Fixed (D6) |
| Service sends SQL, which the device executed; string-built local SQL | Fixed on our side: the SQL text is parsed as data and never executed (§3.5). The service itself is unchanged (C1) |
| Re-download silently drops unsent counts; tables dropped before contacting the server | Fixed: D8 warning before `InitPullTables`, plus a staged download that swaps only on success |
| Download could loop forever on "no results" | Fixed: stop when a page adds no rows before `rowsCount` is reached (§3.2) |
| One network call per line on upload; stops on the first error | **Kept** (C2): one `InsertDetail` per line, stop on the first error |
| `usercounted` sent as `1.0E7` at ten million or more | Not a defect: the service splices the value into T-SQL, where `1.0E7` is a valid literal (§6, S6). The adapter still sends plain decimals (§3.6) |
| Prefix auto-count on a single partial match | **Kept** (D2) |
| Unknown barcodes not recorded | **Kept** (no new tables) |
| Uploaded lines hidden from both lists | Kept |

---

## 6. Service questions: confirmed and still unknown

**How these were answered**
1. Read the VB source `ERPDataCollectorWebService/ERPDataCollectorWebService/Service1.asmx.vb` (the working copy is identical). **No decompiling was needed**, because the source is present, and the compiled `bin/ERPDataCollectorWebService.dll` contains every distinctive SQL literal quoted below.
2. Ran the working copy under IIS Express 10 (CLR 2.0 / .NET 3.5) against the local database, and saved the WSDL to `docs/service-samples/Service1.wsdl`.
3. Called `InitPullTables` and `pullRecords` on test counts, and `InsertDetail` only on test count 9 / location V2. Raw XML is in `docs/service-samples/`.

Line numbers below refer to `Service1.asmx.vb`.

| # | Question | What the code shows (method, lines) and what the tests showed | Status |
|---|---|---|---|
| **S1** | Exact contract | WSDL: namespace `http://tempuri.org/`, document/literal, SOAPAction `http://tempuri.org/<Method>`. **All parameters are `s:string`, `minOccurs=0`.** Orders: `InitPullTables(ApplicationName, SelectedLocation, MachineName, Extras, DeviceInfo)` → `InitPullTablesResult: TableInfos{ mTableInfo: ArrayOfTableInfo{ TableInfo[] } }`. `pullRecords(TableName, PIndex, PSize, StartFromRow)` → `pullRecordsResult: Records{ mRecords: ArrayOfRecord{ Record[]{ valuesquery } } }`. `InsertDetail(transCount, SelectedLocation, uInvID, id, Pcd_RecId, usercounted, uUserToUpdate)` → `InsertDetailResult: string`. Classes: `TableInfos`/`TableInfo` (1182–1187), `Records`/`Record` (1119–1124) | **confirmed** |
| **S2** | **Does `InsertDetail` replace, add, or insert a new row? Which table and column?** | `InsertDetail` (354–403): `" Update tbl_PhysicalCountDetail set Pcd_QtyCounted" & uUserToUpdate & " = " & usercounted & " , Pcd_Type" & uUserToUpdate & " = 10, Pcd_DateCount=getdate() where Pcd_RecId='" & Pcd_RecId & "' and Pcd_loc = '" & SelectedLocation & "'"` (386–390). **It replaces the value in `tbl_PhysicalCountDetail.Pcd_QtyCounted<N>`, where N = `uUserToUpdate`.** It also sets `Pcd_Type<N> = 10` and `Pcd_DateCount = getdate()`. It never adds, and never inserts rows. **5-then-7 test** on count 9 / V2, `Pcd_RecId` 47842, slot 4: before, `Pcd_QtyCounted4` = NULL, `Pcd_Type4` = NULL, `Pcd_DateCount` = 2022-12-31. After sending 5: `5.000`. After sending 7: **`7.000` (not 12)**, `Pcd_Type4 = 10`, `Pcd_DateCount` = the time of the call. No other slot changed | **confirmed: replace** |
| **S3** | Is resending the same line safe? | Follows from S2: the same total produces the same value. The only side effect is that `Pcd_DateCount` moves to the time of the resend | **confirmed: safe** |
| **S4** | Return values of `InsertDetail` | `"ok"` after the UPDATE runs (394). **Even if it matched 0 rows**: `ExecuteQuery` (1252–1272) doesn't check the affected-row count. Header refusals only when `transCount = "1"` (359–383): `"This Physical Count Was Cancelled"` (`Pch_Status='C'`), `"This Physical Count Was Already Updated To Stock"` (`Pch_Updated='Y'`), `"This Physical Count Does Not Exist"`. On an exception: `UpdateSQL & ":" & ex.Message` (398). No SOAP faults for SQL errors | **confirmed** |
| **S5** | Meaning of `transCount` and `id`; the source of `_id` | `transCount` only switches on the header check when it is `"1"` (359). **`id` is never used.** `_id` is `INTEGER PRIMARY KEY` in `CreateTable` (867) and is **not** in `InsertInto`, so the device's SQLite assigned it | **confirmed** |
| **S6** | Accepted `usercounted` formats | It is concatenated unquoted into T-SQL (387), so any T-SQL numeric literal works (`12`, `12.0`, `3.5`, `1.0E7`). A comma decimal separator or empty value → SQL error text. Test calls sent `5.0` and `7.0` → stored `5.000` / `7.000` | **confirmed** |
| **S7** | **How `InitPullTables` picks the rows for a count** | `InitPullTables` (984–1009) → `InitERPPhysicalCountTables(ApplicationName, Extras, SelectedLocation, MachineName)` (414–604). **Header:** `tbl_PhysicalCountHeader WHERE Pch_Updated = 'N' AND Pch_RecId = <Extras> AND Pch_Loc = '<loc>' AND Pch_Status <> 'C' AND Pch_Updated <> 'Y' AND (Pch_MachUser1 = '<machine>' OR … Pch_MachUser6 = '<machine>')` (456–490). The slot is `UserToUpdate` = the first `Pch_MachUserN` equal to the machine name (466–472). **If no header row matches, details and barcodes are not built** (504, 592). **Details:** `tbl_PhysicalCountDetail INNER JOIN tbl_PhysicalCountHeader ON Pcd_HRecId=Pch_RecId AND Pcd_loc=Pch_Loc INNER JOIN STK04_stkfil (or pos_stkfil if loc_Type3='S') ON Pcd_stkid=stk_recid INNER JOIN stk04_itemtype ON stk_itmtype=IT_Code INNER JOIN stk04_supplier ON stk_supplier=Sup_Code LEFT JOIN Stk04_COLOR … LEFT JOIN Stk04_Brand … WHERE Pch_RecId = <Extras> AND Pcd_loc = '<loc>'` (511–565). **There is no warehouse filter**, and lines whose item has no item-type or supplier row are dropped by the inner joins. `RowNumber` is ordered by `Pcd_RecId`. **Barcodes:** `tbl_PhysicalCountDetBarcode WHERE PcBarc_DRecId IN (SELECT pcd_recid FROM tbl_PhysicalCountDetail WHERE Pcd_HRecId = <Extras> AND pcd_loc = '<loc>') AND PcBarc_LOC = '<loc>'` (577–585). **Tests:** count 9/V2 with machine UN3 → 1 / 102 / 0 rows. Count 10/CV with machine UN → 1 / 11131 / 9. Count 999999 → only `phyHeader`, `RowsCount 0`. Count 9 with an unassigned machine `ZZ9` → only `phyHeader`, `RowsCount 0`. The local DB has **no** count number + location with two warehouse headers, so the missing warehouse filter causes no duplicates here | **confirmed** |
| **S8** | Side effects of `InitPullTables`; how long resume works | It **writes to the ERP database**. `ClearErpDataCollectorTables` (610–630) drops, and then `SELECT … INTO` creates, six tables per location + machine: `_ERPDATACOLLECTOR_tbl_PhysicalCount{Header,Detail,DetBarcode}_<loc><machine>` plus `…xyz` copies (452–589, 945–980). They **persist until the next `InitPullTables` for the same location + machine** (or `ClearPullTables`), so resume works indefinitely until then. **Two devices using the same location + machine name overwrite each other's staging.** Nothing is written to the count tables, and the device isn't recorded anywhere | **confirmed** |
| **S9** | Which tables are returned | For `ERPDATACOLLECTOR`, always `phyHeader`, `phyDetails`, `phyBarcodes` in that order, or `phyHeader` only when the header didn't match (495, 571, 589). `ERPSCAN` returns other tables, but it isn't used here | **confirmed** |
| **S10** | Exact `InsertInto` / `CreateTable` text | Built by `CommonInitTablesProc` (964, 973) and `GetInsertValuesSqlQuery` (859–941). Exact strings are in §3.5.1. The column names are exactly the legacy ones. The table name matches `OriginalTableName` | **confirmed** |
| **S11** | Literal syntax of `valuesquery` | `GetInsertValuesSqlQuery` (899–914): numbers `'''' + isnull(cast([c] as nvarchar(18)),'') + ''','`; text `'''' + replace(isnull([c],''),'''','') + ''','`. So every value is quoted, apostrophes are removed from text, and NULL becomes `''`. The staging column `valuesquery` is `nvarchar(4000)`. Samples show datetimes as `'Dec 31 2022 12:00AM'` | **confirmed** |
| **S12** | XML shape, no-results signal, errors | One `valuesquery` per `Record`. No rows → `<pullRecordsResult />` (no `mRecords`). All exceptions are swallowed (`pullRecords` 1114, `InitPullTables` 1005, `InitERPPhysicalCountTables` 600), so SQL errors look like "no results" or partial results, never faults | **confirmed** |
| **S13** | Paging | `pullRecords` (1072–1117): with `StartFromRow` set, `WHERE RowNumber BETWEEN <StartFromRow> AND <StartFromRow + PSize − 1>`, which is 1-based and inclusive. **`PIndex` is ignored.** There is no maximum `PSize`, and **no `ORDER BY`**. `RowsCount` = `count(*)` of the staging table (966, 1214). Tests: pages 1–50, 51–100 and 101–102 of count 9 were correct, and 103+ returned no results | **confirmed** |
| **S14** | Initial `usercounted` / `updated` | `usercounted = CASE WHEN Pcd_QtyCounted<N> IS NULL THEN 0 ELSE Pcd_QtyCounted<N> END` (527–544), which **starts at this machine's current server value**. `updated` is always `'0'` (545) | **confirmed** |
| **S15** | Header contents; `InvID`, `UserToUpdate`, `SP_DecNo` | `InvID` = `Extras` as text (478). `UserToUpdate` = `'1'`–`'6'` (466–472). `SP_*` = values from the **last row** of `SELECT * FROM stk04_SysParam` (`GetSysParam` 231–261, NULL `SP_DecNo` → `"0"`). What `SP_DecNo` *means* (a decimal-place count?) is not stated in the code; it is only passed through. Local value: `3` | `InvID`/`UserToUpdate`: **confirmed**. `SP_DecNo` meaning: **still unknown** (default: `0` = integers, otherwise up to `min(SP_DecNo,3)` decimals) |
| **S16** | `DeviceInfo` / `ApplicationName` | `DeviceInfo` is ignored (`If CheckDevice(DeviceInfo)` is commented out, 991–993). `ApplicationName` is matched case-insensitively (`Select Case ApplicationName.ToUpper`, 989) but used **verbatim** in staging-table names | **confirmed** |
| **S17** | Machine name rules | It must equal one of `Pch_MachUser1..6` (varchar(5)). The comparison uses the column collation `SQL_Latin1_General_CP1256_CI_AS`, which is **case-insensitive and ignores trailing spaces**. No pre-registration beyond that. It is also part of the staging-table names | **confirmed** (the adapter limits it to 5 alphanumerics, §3.7) |
| **S18** | Host(s) and timeouts | One URL per deployment; the service has no per-location logic. Real host(s) for each site, and how long `InitPullTables` takes on large counts (e.g. 39k lines) in production, are not in the code. The count 10 call (11,131 lines) finished within the test run locally | **still unknown** (default: config map, 30 s, configurable per method) |
| **S19** | Negative / large values | `InsertDetail` writes whatever number it gets, including negatives. A value over 18 characters when cast (≥ 10¹⁴ with 3 decimals) would make the **next** `InitPullTables` fail inside `cast(… as nvarchar(18))`, and that error is swallowed | **confirmed** (the adapter blocks negatives and caps at 99,999,999,999,999.999, §3.7) |
| **S20** | *(new)* Injection surface of the service | **Every parameter of all three methods is concatenated into SQL without escaping**: `Extras`, `SelectedLocation`, `MachineName` (456–590), `TableName` (1084), and `uInvID`, `SelectedLocation`, `Pcd_RecId`, `usercounted`, `uUserToUpdate` (363–390). Since the service can't change (C1), the adapter's strict validation (§3.7) is the only guard, and X1 (login) matters more | **confirmed** |
| **S21** | *(new)* Does `InsertDetail` stop writes to other counts? | Not beyond `transCount = "1"`. The UPDATE filters on `Pcd_RecId` + `Pcd_loc` only (389–390), and `Pcd_RecId` is unique per location. The local DB has 17 rows with `Pcd_RecId` 47842, one per location. If a run starts at `transCount > 1`, the cancelled/posted check is skipped | **confirmed** (the browser always starts each run at 1 and sends only IDs from its sheet) |

**Changes made to the local database by these tests** (local `SalesVolumeRebate` only):
- **Test row:** `tbl_PhysicalCountDetail` `Pcd_RecId=47842`, `Pcd_Loc='V2'` now has `Pcd_QtyCounted4 = 7.000`, `Pcd_Type4 = 10`, and `Pcd_DateCount` = the test time. Before, these were NULL / NULL / 2022-12-31. It has not been reverted.
- **Staging tables:** the service created 10 of them: `_ERPDATACOLLECTOR_…_CVUN` (×6), `…Header_V2UN3` (×2) and `…Header_V2ZZ9` (×2).

---

## 7. Decision still needed from you

| # | Question | Suggested default |
|---|---|---|
| X1 | Should the API require login? Legacy had none, and the backend template already has JWT auth. **Every service parameter is spliced into SQL (S20)**, so an open adapter would be an injection path into the ERP, and validation (§3.7) would be the only barrier. | Require the existing JWT login. The Login page is already in the frontend template. |
