import ExcelJS from 'exceljs';
import type { AuthUser } from '../../lib/auth.js';
import { maskMobile } from '../../lib/mobile.js';
import { karachiDate } from '../../lib/time.js';
import type { VillageBrowseQuery } from './schemas.js';
import { browseVillages } from './villages.js';

const ISSUE_TEXT: Record<string, string> = {
  ZIMMEDAR_NOT_FOUND: 'Zimmedar nahi mila',
  NOT_IMPORTED_EMPLOYEE: 'Zimmedar HR import mein nahi',
  SUPERVISOR_CODE: 'Supervisor ke naam par',
  DISTRICT_MISMATCH: 'District ka farq',
  SIMILAR_NAME: 'Milta julta gaon',
};

/** A Google Maps link to a point (no API key needed). */
export const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

/**
 * GET /dash/villages/export.xlsx (CTO 17 Nov 2026): the Gaon list with the filters on screen, with
 * Suba / Division / District and the Gaon's information. The local zimmedar's mobile shows masked
 * (0300•••4567) like the screen; the full number is behind it as a link (tel:), so it shows only
 * when the cell is clicked.
 */
export async function villagesExport(caller: AuthUser, q: VillageBrowseQuery) {
  const data = await browseVillages(caller, q, { all: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Gaon', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.addRow([`Gaon list · ${data.total} gaon · ${karachiDate()}`]).font = { bold: true, size: 13 };
  const head = ws.addRow([
    'Suba',
    'Division',
    'District',
    'Gaon',
    'Manzoori',
    'Ushar zimmedar',
    'Ajeer code',
    'Gaon zimmedar',
    'Gaon zimmedar mobile',
    'Fasalein',
    'Location (lat, lng)',
    'Google Maps',
    'Donors',
    `Visit (${data.month})`,
    'Data ka masla',
  ]);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEBFB' } };
  const link = { color: { argb: 'FF3B3FB6' }, underline: true } as const;

  for (const v of data.villages) {
    const mobile = v.localZimmedar?.mobile ?? null;
    const row = ws.addRow([
      v.suba?.name ?? '',
      v.division?.name ?? '',
      v.district?.name ?? '',
      v.name,
      v.status === 'approved' ? 'Manzoor' : 'Manzoori baqi',
      v.zimmedar ? v.zimmedar.name : v.orphaned ? 'Ghair fa’al zimmedar' : 'Koi zimmedar nahi',
      v.zimmedar?.ajeerCode ?? '',
      v.localZimmedar?.name ?? '',
      mobile ? { text: maskMobile(mobile)!, hyperlink: `tel:+92${mobile.slice(1)}` } : '',
      v.crops
        .map((c) =>
          c.id === 'other' && v.cropsOther ? `${c.labelUr} (${v.cropsOther})` : c.labelUr,
        )
        .join('، '),
      v.location ? `${v.location.lat}, ${v.location.lng}` : '',
      v.location
        ? { text: 'Naqsha kholein', hyperlink: mapsLink(v.location.lat, v.location.lng) }
        : '',
      v.donors,
      v.visited ? 'Haan' : 'Nahi',
      v.issues.map((i) => ISSUE_TEXT[i.kind] ?? i.kind).join(', '),
    ]);
    if (mobile) row.getCell(9).font = link;
    if (v.location) row.getCell(12).font = link;
  }
  const widths = [16, 16, 16, 26, 14, 22, 12, 22, 20, 26, 22, 16, 9, 12, 26];
  ws.columns.forEach((c, i) => {
    c.width = widths[i] ?? 14;
  });
  const file = Buffer.from(await wb.xlsx.writeBuffer());
  const unit = q.district ?? q.division ?? q.suba ?? 'all';
  return { file, name: `UsherDesk-Gaon-${unit}-${karachiDate()}.xlsx` };
}
