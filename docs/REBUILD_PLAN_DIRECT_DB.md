# Rebuild Plan — Physical Count web app

Inputs: `LEGACY_ANALYSIS.md`, the `Physical Count Backend` (.NET 8, Dapper/SqlClient, JWT template), the `Physical Count FrontEnd` (React CRA + PWA service worker), and the **SalesVolumeRebate** SQL Server database. The database was inspected with metadata queries only; no row data was read.
Status: plan only. No code has been written.

---

## 0. Ground rules (decisions already made)

| # | Decision | Where it shows up |
|---|---|---|
| D1 | Keep the exact lookup order: **exact barcode → reference prefix → QR** | §4.2 |
| D2 | Keep the prefix-match behaviour (one prefix hit is counted automatically; several open a picker) | §4.2 |
| D3 | **No new tables.** The API reads and writes only existing ERP tables | §3 |
| D4 | Machine name is typed by hand, as before | Settings page, §3.6 |
| D5 | Fix the "Incorrect Qty" lock at 10000+ | §4.3 |
| D6 | Play a sound on a **good** scan (the legacy app only beeped on errors) | §4.4 |
| D7 | Parameterized queries everywhere | §3, §4.5 |
| D8 | Warn before a re-download would drop counts that have not been uploaded | §4.1 |
| — | The old `Service1.asmx` source is unavailable, so none of its behaviour is assumed | §6 |

**Architecture consequence of D3 + D8.** The legacy app downloaded a sheet, counted **offline on the device**, and uploaded later. D8 only makes sense if that model stays, and D3 means pending counts cannot be parked in a new server table. So:

- **Server:** a stateless JSON API over the existing ERP tables. It is read-only except for one write: storing counted quantities.
- **Browser (handheld):** the downloaded sheet, the running counts and the per-line state (`0` not counted, `1` pending upload, `2` uploaded) live in **IndexedDB** on the device, exactly where the legacy SQLite data lived. This is browser storage, not SQL Server tables, so D3 still holds. The frontend already has a service worker and `useNetwork.js`, so counting keeps working when Wi-Fi drops.

---

## 1. What exists in the database (metadata findings)

### 1.1 The three physical-count tables

**`dbo.tbl_PhysicalCountHeader`**: PK `(Pch_Recid, Pch_Loc, Pch_Whouse)`, and FK `Pch_Loc → STK04_Location.Loc_Code`.

| Column | Type | Null |
|---|---|---|
| Pch_Recid | decimal(18,0) | no |
| Pch_Loc | varchar(2) | no |
| Pch_Whouse | varchar(1) | no |
| Pch_DateCount | datetime | yes |
| Pch_MachUser1 … Pch_MachUser6 | varchar(5) each | yes |
| Pch_Date1 … Pch_Date6 | datetime each | yes |
| Pch_Memo1, Pch_Memo2 | nvarchar(3000) | yes |
| Pch_NbrItems | decimal(18,0) | yes |
| Pch_Status | varchar(1) | yes |
| Pch_Updated | varchar(1) | yes |

**`dbo.tbl_PhysicalCountDetail`**: PK `(Pcd_RecId, Pcd_Loc)`. Unique key `(Pcd_HRecId, Pcd_Loc, Pcd_Whouse, Pcd_stkid, Pcd_Color, Pcd_Grid, Pcd_DetGrid, Pcd_ExpDate, Pcd_Batch)`. FK `(Pcd_HRecId, Pcd_Loc, Pcd_Whouse) → header`.

| Column | Type | Null |
|---|---|---|
| Pcd_RecId | decimal(18,0) | no (not an identity column) |
| Pcd_HRecId | decimal(18,0) | no |
| Pcd_Loc | varchar(2) | no |
| Pcd_Whouse | varchar(1) | no |
| Pcd_stkid | decimal(18,0) | no |
| Pcd_Color / Pcd_Grid / Pcd_DetGrid | varchar(2) / (4) / (5) | yes |
| Pcd_ExpDate | varchar(10) | yes |
| Pcd_Batch | varchar(15) | yes |
| Pcd_DateCount | datetime | yes |
| Pcd_Qty | decimal(18,3) | yes |
| Pcd_QtyCounted1 … Pcd_QtyCounted6 | numeric(18,3) each | yes |
| Pcd_Type1 … Pcd_Type6 | varchar(2) each | yes |
| Pcd_AdjType | varchar(1) | yes |
| Pcd_AdjFolio | numeric(18,0) | yes |

**`dbo.tbl_PhysicalCountDetBarcode`**: PK `(PcBarc_RecId, PcBarc_LOC)`. Unique key `(PcBarc_DRecId, PcBarc_LOC, PcBarc_Barcode)`. It has **no foreign key** to the detail table.

| Column | Type | Null |
|---|---|---|
| PcBarc_RecId | decimal(18,0) | no |
| PcBarc_DRecId | decimal(18,0) | no |
| PcBarc_Barcode | nvarchar(20) | no |
| PcBarc_LOC | varchar(2) | no |

No triggers or check constraints are defined on any of the three tables.

### 1.2 Supporting tables the plan reads

| Table | Columns used | Notes |
|---|---|---|
| `STK04_STKFIL` (stock master) | `STK_RECID` (PK), `STK_REF` varchar(22), `STK_DESC` nvarchar(200), `STK_ACTIVE` | Source of the reference and description the legacy `phyDetails` carried |
| `stk04_SysParam` | `SP_DecNo` smallint, `SP_Fashion` varchar(1), `SP_Expiry` varchar(1) | The same three settings the legacy app read from `phyHeader`. There is no location column, no PK and no index |
| `STK04_Location` | `Loc_Code` varchar(2), `Loc_Desc`, `Loc_Active` | Location picker |

### 1.3 Stored procedures, views and functions that mention the three tables

I searched `sys.sql_modules` for the three table names and for `Pcd_` / `Pch_` / `PcBarc`:

| Object | What it does | Related to InitPullTables / InsertDetail? |
|---|---|---|
| `dvCount_CK, _exp1, _gh, _gk, _jh, _LT, _nz, _par, _ra, _rm, _sa, _SU, _TK, _wg` (14 views) | Join `tbl_PhysicalCountDetail` to the per-user staging table `tbCount_User_<user>` on `Pcd_RecId` + `Pcd_Loc`. They return `Pcd_QtyCounted1..6` and `Pcd_Type1..6` next to the staging `Qty1..6`, `RecordType1..6` and `Empty1..6`, filtered to `RecordType* = 'M'`, `Pcd_Whouse='1'` and a hard-coded location. | **No.** These belong to the desktop ERP's count-review screen, one per desktop user. They do show that the ERP treats **six count slots per line** (`QtyCounted1..6` / `Type1..6`) as the data that matters. |
| `dvGenerate_nz, _par, _rm, _sa, _tk` (5 views) | Join a desktop "generate adjustment" staging table to `stk04_stkqty`. Expiry is matched with `CASE WHEN LEN(Exp)=7 THEN RIGHT('00.'+Exp,10) ELSE Exp END`. | **No.** They are useful evidence about expiry format, though: `MM.YYYY` (7 chars) is stored as `00.MM.YYYY`, and `DD.MM.YYYY` is stored as is. |
| `F_GetMaxDate(@loc)` | `MAX(Pch_DateCount)` per location, among other document dates | No |

**No stored procedure writes to or selects from these tables.** Whatever `InitPullTables` and `InsertDetail` did was written in the ASMX's own C#/SQL, which is not available. See §6.

### 1.4 Legacy field → real column

| Legacy local field | Real source | Match |
|---|---|---|
| `Pcd_RecId` | `tbl_PhysicalCountDetail.Pcd_RecId` | ✅ exact |
| `Pcd_stkId` | `tbl_PhysicalCountDetail.Pcd_stkid` | ✅ exact |
| `Pcd_Batch` | `tbl_PhysicalCountDetail.Pcd_Batch` | ✅ exact |
| `Pcd_Qty` | `tbl_PhysicalCountDetail.Pcd_Qty` | ✅ exact |
| `PcBarc_Barcode` | `tbl_PhysicalCountDetBarcode.PcBarc_Barcode` | ✅ exact |
| `PcBarc_DRecId` | `tbl_PhysicalCountDetBarcode.PcBarc_DRecId` | ✅ exact name. Pointing it at `Pcd_RecId` is inferred from the name, since there is no FK (Q12) |
| `exp` | `tbl_PhysicalCountDetail.Pcd_ExpDate` | ⚠️ probable. The format may differ from what the device held (Q11) |
| `Refernce` | **not in the three tables.** Probably `STK04_STKFIL.STK_REF` via `Pcd_stkid = STK_RECID` | ⚠️ inferred (Q10) |
| `stk_Desc` | **not in the three tables.** Probably `STK04_STKFIL.STK_DESC` | ⚠️ inferred (Q10) |
| `InvID` | **no column with this name.** Probably `Pch_Recid`, the number the user types in | ⚠️ inferred (Q8) |
| `UserToUpdate` | **no match** in any of the three tables | ❌ none (Q8) |
| `usercounted` | **no single match.** It is one of `Pcd_QtyCounted1..6`, and which one is unknown | ❌ undetermined (Q1, Q2) |
| `SP_DecNo / SP_Fashion / SP_Expiry` | `stk04_SysParam` (not the header) | ✅ names match, different table |
| `updated` (0/1/2) | device-only state | n/a (kept in IndexedDB) |
| `RowNumber`, `_id` | device-only | n/a (paging uses `Pcd_RecId` / `PcBarc_RecId`) |

---

## 2. Screen → web page map

The routes live in the existing React app and use the brand design system components. The pages are sized for the handheld (portrait, about 360–480 px wide).

| Legacy screen | Web page (route) | Notes |
|---|---|---|
| `MainActivity` | **Home** `/` | Five tiles: Scan, View Items, Download, Upload, Settings. Scan, View and Upload are disabled until a download is complete (same rule as legacy). Shows the active count number, location, warehouse, and the number of pending and uploaded lines. |
| `MainActivity` "Enter Physical Count Number" dialog | **Download** `/download` step 1 | Numeric input for the count number, then a warehouse picker if more than one warehouse exists (Q7). |
| `Synchronize` (Download) | **Download** `/download` step 2 | Progress bar per phase (lines, then barcodes), Cancel, and resume. The D8 warning appears **before** anything is replaced. |
| `Synchronize` (Upload) | **Upload** `/upload` | "N lines to upload — continue?", then batched progress, Cancel, and a result screen. |
| `BarcodeScan` | **Scan** `/scan` | The scan input keeps focus. Line details, Total, Last Scanned, the three buttons, and sounds (D6). `/scan?line=<Pcd_RecId>` opens a line in view mode (legacy ViewItems → BarcodeScan). |
| `MultiSearchActivity` | **Pick item** modal on `/scan` | Opens when the prefix search matches more than one line. It has a live search box pre-filled with the scan. Picking a line counts +1, as in legacy. |
| `ViewOptions` + `ViewItems` | **Items** `/items?tab=counted\|not-counted` | Two tabs: `state=1` and `state=0`. Tapping a row opens `/scan?line=…`. Uploaded lines (`state=2`) stay hidden, as in legacy. |
| `Settings` | **Settings** `/settings` | Location (picker from `STK04_Location`), Machine name (free text, D4), Download page size, and the **Restore uploaded** button (sets `state 2 → 1` on the device). |
| `ServerSettingsActivity` + `ConfigurationSettingsList` | *(folded into Settings)* | These existed to hold a server URL per location. The web app talks to its own origin, so each "profile" is just the location choice. |
| `ListNotScannedItems` | *(dropped)* | Dead code in legacy. |
| — | **Login** `/login` (existing template page) | Only if the API is protected. See decision X1 in §7. |

---

## 3. API endpoints (JSON only)

Base path: `/api/physical-count`. All IDs that are `decimal(18,0)` in SQL are sent **as strings** in JSON, because they can exceed JavaScript's safe integer range. Quantities are sent as JSON numbers with up to 3 decimals, matching `numeric(18,3)`.
Data access uses Dapper with `@parameters` for every value (D7). The one dynamic part, the counted-slot column name, comes from a fixed server-side whitelist (§3.6).

### 3.1 `GET /api/physical-count/locations`
For the location picker in Settings.

**Reads**
```sql
SELECT Loc_Code, Loc_Desc, Loc_Active
FROM dbo.STK04_Location
ORDER BY Loc_Code;
```
**Writes:** none.
**Response:** `[{ "code": "01", "description": "…", "active": "Y" }]`. It does not filter on `Loc_Active` until its values are confirmed (Q18).

### 3.2 `GET /api/physical-count/system-params`
This replaces the legacy step of copying `SP_*` from `phyHeader` after a download.

**Reads**
```sql
SELECT TOP (1) SP_DecNo, SP_Fashion, SP_Expiry
FROM dbo.stk04_SysParam;
```
**Writes:** none.
**Response:** `{ "decimals": 0, "fashion": "N", "expiry": "N" }`. If the table is empty, the endpoint returns 500 (Q17).

### 3.3 `GET /api/physical-count/counts/{countId}?loc=01&machine=HH01`
This replaces the header part of `InitPullTables`. It shows which warehouse(s) this count number has at this location, plus the sizes needed for the progress bars.

**Reads**
```sql
SELECT h.Pch_Recid, h.Pch_Loc, h.Pch_Whouse, h.Pch_DateCount, h.Pch_NbrItems,
       h.Pch_Status, h.Pch_Updated,
       h.Pch_MachUser1, h.Pch_MachUser2, h.Pch_MachUser3,
       h.Pch_MachUser4, h.Pch_MachUser5, h.Pch_MachUser6,
       (SELECT COUNT(*) FROM dbo.tbl_PhysicalCountDetail d
         WHERE d.Pcd_HRecId = h.Pch_Recid AND d.Pcd_Loc = h.Pch_Loc AND d.Pcd_Whouse = h.Pch_Whouse) AS LineCount,
       (SELECT COUNT(*) FROM dbo.tbl_PhysicalCountDetBarcode b
         JOIN dbo.tbl_PhysicalCountDetail d ON d.Pcd_RecId = b.PcBarc_DRecId AND d.Pcd_Loc = b.PcBarc_LOC
         WHERE d.Pcd_HRecId = h.Pch_Recid AND d.Pcd_Loc = h.Pch_Loc AND d.Pcd_Whouse = h.Pch_Whouse) AS BarcodeCount
FROM dbo.tbl_PhysicalCountHeader h
WHERE h.Pch_Recid = @countId AND h.Pch_Loc = @loc;
```
**Writes:** none. Legacy may have recorded the device at this point, but that is unknown (Q13).
**Response:**
```json
[{ "countId": "1234", "loc": "01", "warehouse": "1", "dateCount": "2026-09-01T00:00:00",
   "status": "…", "updated": "…", "lineCount": 5230, "barcodeCount": 8110,
   "slot": 2, "slotError": null }]
```
- `slot` is the counted-quantity slot resolved for `machine` (§3.6). If there is no slot, `slotError` explains why, and the UI blocks the download. Without a slot the device cannot seed its totals or upload.
- An empty array means the count was not found. This replaces the legacy *"Selected Inventory Not Download Or Does Not Exist!!!"* message.

### 3.4 `GET /api/physical-count/counts/{countId}/lines?loc&warehouse&machine&after=<Pcd_RecId>&pageSize=5000`
This replaces `pullRecords` for `phyDetails`. It uses keyset paging on `Pcd_RecId`. The client stores the last ID it received, so an interrupted download resumes where it stopped. This replaces the legacy `tblPullStatus` / `RowNumber` resume.

**Reads** (`{slotCol}` is a whitelisted column, §3.6)
```sql
SELECT TOP (@pageSize)
       d.Pcd_RecId, d.Pcd_stkid, s.STK_REF, s.STK_DESC,
       d.Pcd_ExpDate, d.Pcd_Batch, d.Pcd_Color, d.Pcd_Grid, d.Pcd_DetGrid,
       d.Pcd_Qty, d.{slotCol} AS Counted
FROM dbo.tbl_PhysicalCountDetail d
LEFT JOIN dbo.STK04_STKFIL s ON s.STK_RECID = d.Pcd_stkid
WHERE d.Pcd_HRecId = @countId AND d.Pcd_Loc = @loc AND d.Pcd_Whouse = @warehouse
  AND d.Pcd_RecId > @after
ORDER BY d.Pcd_RecId;
```
The `LEFT JOIN` keeps a line even when its stock row is missing. Such a line gets an empty reference and the description "(no stock record)".
**Writes:** none.
**Response:** `{ "lines": [{ "id": "…", "stkId": "…", "reference": "…", "description": "…", "expiry": "…", "batch": "…", "color": null, "grid": null, "detGrid": null, "systemQty": 12.000, "counted": 0 }], "next": "<last id or null>" }`.
`counted` is the slot's current value, with NULL returned as 0. It becomes the device's starting total for the line (Q9).

### 3.5 `GET /api/physical-count/counts/{countId}/barcodes?loc&warehouse&after=<PcBarc_RecId>&pageSize=5000`
This replaces `pullRecords` for `phyBarcodes`.

**Reads**
```sql
SELECT TOP (@pageSize) b.PcBarc_RecId, b.PcBarc_DRecId, b.PcBarc_Barcode
FROM dbo.tbl_PhysicalCountDetBarcode b
JOIN dbo.tbl_PhysicalCountDetail d
  ON d.Pcd_RecId = b.PcBarc_DRecId AND d.Pcd_Loc = b.PcBarc_LOC
WHERE d.Pcd_HRecId = @countId AND d.Pcd_Loc = @loc AND d.Pcd_Whouse = @warehouse
  AND b.PcBarc_RecId > @after
ORDER BY b.PcBarc_RecId;
```
**Writes:** none.
**Response:** `{ "barcodes": [{ "id": "…", "lineId": "…", "barcode": "…" }], "next": "…" }`

### 3.6 `POST /api/physical-count/counts/{countId}/upload`
This replaces `InsertDetail`. It sends a **batch** of lines (the legacy app sent one SOAP call per line).

**Request**
```json
{ "loc": "01", "warehouse": "1", "machine": "HH01",
  "lines": [{ "id": "98765", "counted": 12 }, { "id": "98766", "counted": 3.5 }] }
```
**Validation (before any write)**
- Batch size is 1–500 lines.
- `counted` must be a finite number, at least 0 (Q15), with no more than `min(SP_DecNo, 3)` decimals, and at most 999,999,999,999,999.999 to fit `numeric(18,3)`.
- Duplicate IDs in the same batch are rejected.

**Slot resolution** (the safe default for Q2)
```sql
SELECT Pch_MachUser1, Pch_MachUser2, Pch_MachUser3, Pch_MachUser4, Pch_MachUser5, Pch_MachUser6
FROM dbo.tbl_PhysicalCountHeader
WHERE Pch_Recid = @countId AND Pch_Loc = @loc AND Pch_Whouse = @warehouse;
```
- The slot is the index N where `RTRIM(Pch_MachUserN)` equals the typed machine name (case-insensitive).
- If there are no matches or more than one → **HTTP 409, nothing is written**.
- N maps through a fixed dictionary `{1:"Pcd_QtyCounted1", …, 6:"Pcd_QtyCounted6"}`. User input never reaches the SQL text.

**Writes** (one transaction for the whole batch, so either every line is saved or none is)
```sql
UPDATE dbo.tbl_PhysicalCountDetail
SET {slotCol} = @counted                 -- replace, not add (Q1)
WHERE Pcd_RecId = @id AND Pcd_Loc = @loc
  AND Pcd_HRecId = @countId AND Pcd_Whouse = @warehouse;
```
- Each `UPDATE` must affect exactly 1 row. If any affects 0 (the line does not belong to this count), the transaction rolls back and the response names the bad IDs.
- It does **not** write `Pcd_TypeN`, `Pcd_DateCount`, `Pch_DateN`, `Pch_NbrItems`, `Pch_Status` or `Pch_Updated` until confirmed (Q3, Q4, Q22).
- It never INSERTs. The unique key and the non-identity `Pcd_RecId` make "new row per upload" incompatible with how barcodes point at lines (Q1).

**Response:** `{ "saved": ["98765","98766"], "slot": 2 }`. The client marks exactly those lines `state=2`.
**Idempotent:** resending the same batch (a retry, or "Restore uploaded") writes the same totals again.

### 3.7 Endpoint summary

| Method | Path | SQL reads | SQL writes |
|---|---|---|---|
| GET | `/locations` | `STK04_Location` | — |
| GET | `/system-params` | `stk04_SysParam` | — |
| GET | `/counts/{id}` | header + counts of detail and barcode | — |
| GET | `/counts/{id}/lines` | detail ⟕ `STK04_STKFIL` | — |
| GET | `/counts/{id}/barcodes` | barcode ⋈ detail | — |
| POST | `/counts/{id}/upload` | header (slot) | `UPDATE tbl_PhysicalCountDetail SET Pcd_QtyCountedN` |

No other SQL Server writes are needed. Scanning, counting, the item lists and "Restore uploaded" all run on the device.

---

## 4. Page behaviour and device storage

### 4.1 Device storage (IndexedDB, one database per `loc + machine`, as in legacy)

| Store | Key | Fields |
|---|---|---|
| `sheet` | `"current"` | countId, loc, warehouse, slot, lineCount, barcodeCount, `linesAfter`, `barcodesAfter`, `complete` |
| `lines` | `id` | stkId, reference, `referenceUpper` (indexed), description, expiry, batch, systemQty, `counted`, `state` (0/1/2, indexed) |
| `barcodes` | `barcode` | lineId |
| `settings` (localStorage) | — | loc, machine, pageSize, sysParams |

**Download**
1. Load the header (§3.3).
2. **D8 check:** count the lines with `state = 1`. If there are any, show *"N counted lines on this device have not been uploaded. Downloading will discard them."* with **Upload first** (primary), **Download anyway**, and **Cancel**.
3. Download pages into **staging stores**, and swap them in only when both phases finish. A failed or cancelled download leaves the current sheet untouched. This also fixes the legacy bug where tables were dropped before the server was contacted.
4. Resume uses `linesAfter` / `barcodesAfter`.

**Upload**
1. Send the lines with `state = 1` in batches of 200 to §3.6.
2. Mark the saved IDs as `state = 2`.
3. Stop at the first failed batch and show the reason. Lines already sent stay `2`.

**Restore uploaded:** sets `state 2 → 1` on the device only (the legacy SQL, moved client-side).

### 4.2 Scan lookup (D1, D2, same order as legacy)
The scan input fires on **Enter**. The value is `trim()`-ed.
1. **Exact barcode:** `barcodes.get(value)` gives a lineId. The line is counted.
2. **Reference prefix:** lines where `referenceUpper` starts with `value.toUpperCase()`. This is a case-insensitive ASCII match, like SQLite `LIKE`.
   - **Exactly one** match: counted automatically.
   - **More than one:** the Pick item modal opens, pre-filled with the scan. The chosen line is counted +1.
   - One small deviation: `%` and `_` are treated as literal characters. Legacy `LIKE` treated them as wildcards by accident.
3. **QR** (value contains `|`): `stkId|DD/MM/YY[YY]|Batch`. The line is matched on `stkId` + expiry + batch, with both expiry sides normalised to (day or 00, month, year) before comparing (Q11). A malformed QR code shows "Invalid QR" instead of a generic error.
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
- Values must be at least 0, at most the `numeric(18,3)` maximum, and have no more than the allowed decimals.
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
- Parameterized queries (D7) apply on the server. On the device, IndexedDB lookups are key and index reads, so there is no SQL to inject.

---

## 5. Legacy defects: fixed or kept

| Legacy issue | In the rebuild |
|---|---|
| 10000+ locks the screen | Fixed (D5) |
| No good-scan sound | Fixed (D6) |
| String-built SQL; server sent SQL to the device | Fixed: parameterized SQL, JSON only (D7) |
| Re-download silently drops unsent counts; tables dropped before contacting the server | Fixed: warning (D8) plus staged download that swaps only on success |
| Download could loop forever on "no results" | Fixed: keyset paging ends when `next` is null |
| One network call per line | Fixed: batches of 200, one transaction per batch |
| Prefix auto-count on a single partial match | **Kept** (D2) |
| Unknown barcodes not recorded | **Kept** (no new tables) |
| Uploaded lines hidden from both lists | Kept |

---

## 6. Open questions

These are server behaviours that cannot be determined from the schema and objects above. Each one has a default we can build with. **Everything below is to confirm.**

| # | Question | What the schema does and does not tell us | Safe default we build with | Status |
|---|---|---|---|---|
| **Q1** | **What did `InsertDetail` do with the counted quantity: replace, add, or insert a new row?** | The detail table's unique key allows only one row per item/lot/expiry/colour/size, `Pcd_RecId` is not an identity column, and barcodes point at `Pcd_RecId`. So a *new detail row* per upload doesn't fit. It could still have written somewhere else, such as a staging table like `tbCount_User_*`. The device always sent the **absolute total**, and "Restore Uploaded" resent everything. | **Replace**: `SET Pcd_QtyCountedN = @counted`. Resends are then harmless. With "add", a resend would double the count. | **to confirm** |
| **Q2** | **Which of the six `Pcd_QtyCounted1..6` columns receives a device's count?** | There are six count slots per line and six `Pch_MachUser1..6` varchar(5) columns per header. No column is named `usercounted`. The mapping is not in any view or procedure. | Match the typed machine name to `Pch_MachUserN` (trimmed, case-insensitive). No match or several matches → refuse the download and upload with a clear message, and write nothing. | **to confirm** |
| **Q3** | Was `Pcd_TypeN` (varchar(2)) set alongside `Pcd_QtyCountedN`? With what value? | The desktop `dvCount_*` views read it, but its values are unknown. | Don't write it (leave it as is). | **to confirm** |
| **Q4** | Did an upload set `Pcd_DateCount`, `Pch_DateN` or `Pch_DateCount`? | These columns exist, and `F_GetMaxDate` reads `Pch_DateCount`. | Don't write them. | **to confirm** |
| **Q5** | Which `Pch_Status` / `Pch_Updated` values allow a download or an upload (e.g. a count already posted or closed)? | Both are varchar(1), with unknown values and no check constraint. | Show both values on the Download page. Don't block on them. | **to confirm** |
| **Q6** | **How did `InitPullTables` choose which rows belong to a physical count?** | The FK ties a detail row to its header by `(Pcd_HRecId, Pcd_Loc, Pcd_Whouse)`. Any extra filters (active items only, non-zero system qty, colour/size rows) are unknown. It also received `MachineName` and `Extras` (the count number). | `Pcd_HRecId = @countId AND Pcd_Loc = @loc AND Pcd_Whouse = @warehouse`, with no other filter. Barcodes: those whose `PcBarc_DRecId` + `PcBarc_LOC` match those lines. | **to confirm** |
| **Q7** | The user only typed a count number, but the header key includes `Pch_Whouse`. Did the server pick a warehouse, or did it pull all of them? | Several headers can share `(Pch_Recid, Pch_Loc)`. | If more than one warehouse matches, the user picks one on the Download page. One sheet = one warehouse. | **to confirm** |
| **Q8** | What were `phyHeader.InvID` and `phyHeader.UserToUpdate`? | There are no columns with these names. | `InvID` = `Pch_Recid`. `UserToUpdate` is not used, and nothing is written for it. | **to confirm** |
| **Q9** | On download, did `usercounted` start at 0 or at the slot's current server value? | The legacy device required it to be numeric but set nothing itself. | Start at the slot's current value (NULL → 0). Under "replace", starting at 0 would let a re-download plus rescan overwrite a larger total already uploaded. | **to confirm** |
| **Q10** | Where did `Refernce` and `stk_Desc` come from? | They are not in the three tables. `STK04_STKFIL` has `STK_REF` varchar(22) and `STK_DESC`, and the desktop staging table uses `reference varchar(22)`. `STK_SingleRef1` also exists. | `STK_REF` and `STK_DESC`, joined on `Pcd_stkid = STK_RECID`. | **to confirm** |
| **Q11** | In what format was `exp` sent to the device, and how does the QR expiry compare with `Pcd_ExpDate`? | `Pcd_ExpDate` is varchar(10). `dvGenerate_*` treats a 7-character value as `MM.YYYY` → `00.MM.YYYY`. The legacy QR code produced `MM.YY` or `DD.MM.YY`. | Send `Pcd_ExpDate` as stored. For QR matching, normalise both sides to (day or 00, month, 4-digit year). | **to confirm** |
| **Q12** | Is `PcBarc_DRecId` really `Pcd_RecId`, and does this table hold **all** scannable barcodes for the count? Or did the server also merge barcodes from the stock master? | The name suggests it, but there is no FK. | Join on `PcBarc_DRecId = Pcd_RecId AND PcBarc_LOC = Pcd_Loc`, and use only this table. | **to confirm** |
| **Q13** | Did `InitPullTables` record anything about the device (MachineName, DeviceInfo, ApplicationName) or claim a slot? | Nothing in the schema shows where it would go, except possibly `Pch_MachUserN`. | Download is read-only. Slots must already be assigned in the ERP. | **to confirm** |
| **Q14** | What did `InsertDetail`'s `transCount` and `id` (the device's local row id) mean to the server? | No column matches them. | Not sent. | **to confirm** |
| **Q15** | Did the server accept negative counts? | The column is `numeric(18,3)` and signed. The legacy device could produce a negative through Cancel Last Scan. | Reject values below 0 on both the device and the server. | **to confirm** |
| **Q16** | Does `SP_DecNo` mean "number of decimal places"? | It is a smallint. Legacy only checked for `"0"` vs anything else. | 0 → integers only. Otherwise allow up to `min(SP_DecNo, 3)` decimals. | **to confirm** |
| **Q17** | Is `stk04_SysParam` always exactly one row, or is it per company or location? | It has no key, no index and no location column. | `TOP (1)`. Error if empty. | **to confirm** |
| **Q18** | What do the `Loc_Active` values mean? | varchar(1), unknown values. | List every location and show the flag. | **to confirm** |
| **Q19** | Machine names longer than 5 characters | `Pch_MachUserN` is varchar(5). The legacy Settings screen allowed any length. | Limit the machine name field to 5 characters (only matters if Q2's default holds). | **to confirm** |
| **Q20** | Two devices on the same slot: last write wins, or were they summed? | Nothing in the schema shows it. | Last write wins (follows from Q1 = replace). Each device should use its own slot. | **to confirm** |
| **Q21** | Did an upload also update `Pch_NbrItems`, `Pch_Updated`, or run any "count complete" step? | The legacy client never sent a completion call. | No header writes, and no completion step. | **to confirm** |

---

## 7. Decisions still needed from you (not server behaviour)

| # | Question | Suggested default |
|---|---|---|
| X1 | Should the API require login? Legacy had none, and the backend template already has JWT auth. An open endpoint that writes counts to the ERP is a risk. | Require the existing JWT login. The Login page is already in the frontend template. |
| X2 | Which SQL login should the API use? It is configured with `sa`. | A dedicated login with `SELECT` on the five tables read and `UPDATE` on `tbl_PhysicalCountDetail (Pcd_QtyCounted1..6)` only. |
| X3 | The backend's connection string points to the `ATS` database. | Add a separate `ErpConstr` → `SalesVolumeRebate`, and leave the template's `Constr` alone. |
