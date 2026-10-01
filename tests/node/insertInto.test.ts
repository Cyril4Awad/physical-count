import { describe, expect, it } from 'vitest';
import { ServiceDataError } from '../../src/parse/errors';
import { parseInsertInto } from '../../src/parse/insertInto';
import { COLUMNS, PHY_TABLES } from '../../src/storage/schema';

const EXACT: Record<string, string> = {
	phyHeader:
		'Insert Into phyHeader(RowNumber,Pch_Recid,Warehouse,Pch_DateCount,Pch_MachUser1,Pch_MachUser2,Pch_MachUser3,Pch_MachUser4,Pch_MachUser5,Pch_MachUser6,Pch_Status,Pch_Updated,Pch_NbrItems,UserToUpdate,SP_DecNo,SP_Fashion,SP_Expiry,updated,InvID) Values',
	phyDetails:
		'Insert Into phyDetails(RowNumber,Pcd_RecId,Pcd_Loc,Pcd_stkId,Refernce,stk_Desc,Pcd_Grid,Pcd_DetGrid,Pcd_Color,Color_Desc,exp,Pcd_Batch,Pcd_DateCount,Pcd_Qty,Pcd_QtyCounted1,Pcd_Type1,Pcd_QtyCounted2,Pcd_Type2,Pcd_QtyCounted3,Pcd_Type3,Pcd_QtyCounted4,Pcd_Type4,Pcd_QtyCounted5,Pcd_Type5,Pcd_QtyCounted6,Pcd_Type6,usercounted,updated) Values',
	phyBarcodes: 'Insert Into phyBarcodes(RowNumber,PcBarc_RecId,PcBarc_DRecId,PcBarc_Barcode,updated) Values',
};

describe('parseInsertInto', () => {
	it.each(PHY_TABLES)('reads the exact %s text the service sends', (table) => {
		expect(parseInsertInto(EXACT[table], table)).toEqual(COLUMNS[table]);
	});

	it('accepts other case and spacing', () => {
		expect(parseInsertInto('  insert   into phyBarcodes ( RowNumber , PcBarc_RecId ,PcBarc_DRecId,PcBarc_Barcode,updated )  VALUES ', 'phyBarcodes')).toEqual(COLUMNS.phyBarcodes);
	});

	it.each([
		['another table name', EXACT.phyHeader, 'phyDetails'],
		['no Values keyword', 'Insert Into phyBarcodes(RowNumber,updated)', 'phyBarcodes'],
		['text after Values', 'Insert Into phyBarcodes(RowNumber) Values (1); DELETE FROM x', 'phyBarcodes'],
		['a quoted column', 'Insert Into phyBarcodes(RowNumber,[updated]) Values', 'phyBarcodes'],
		['an empty column', 'Insert Into phyBarcodes(RowNumber,,updated) Values', 'phyBarcodes'],
		['a column with a space', 'Insert Into phyBarcodes(RowNumber,up dated) Values', 'phyBarcodes'],
		['not an insert at all', 'CREATE TABLE phyBarcodes(RowNumber INTEGER)', 'phyBarcodes'],
	])('rejects %s', (_label, text, table) => {
		expect(() => parseInsertInto(text, table)).toThrow(ServiceDataError);
	});
});
