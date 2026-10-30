// Pure report calculations (data model "Calculations"). No database access here.

export interface AtiyatEntry {
  type: 'niyyat' | 'wusooli';
  category: string;
  kind: 'naqd' | 'jins';
  amount: number;
  detail?: string | null;
}

export interface VisitInput {
  donors?: { oldMet?: number | null; newDonors?: unknown[] | null } | null;
  atiyat?: {
    entries?: AtiyatEntry[] | null;
    gsb?: { boxesOpened?: number | null; amount?: number | null } | null;
  } | null;
  ijtima?: { held: boolean; participants?: number | null } | null;
  mashwara?: { held: boolean; participants?: number | null } | null;
}

export interface JadwalInput {
  travel?: {
    mode: 'bike' | 'bus';
    meterStart?: number | null;
    meterEnd?: number | null;
    fare?: number | null;
  } | null;
  visits?: VisitInput[] | null;
}

export interface CategoryRule {
  id: string;
  rewardIncluded: boolean;
}

export interface DayTotals {
  villages: number;
  oldDonors: number;
  newDonors: number;
  niyyat: number;
  wusooli: number;
  rewardWusooli: number;
  excludedWusooli: number;
  gsbBoxes: number;
  gsbAmount: number;
  ijtimas: number;
  ijtimaParticipants: number;
  mashwaras: number;
  km: number;
  fare: number;
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Atiyat of one visit: niyyat never counts in wusooli; GSB counts in wusooli and reward. */
export function visitAtiyatTotals(atiyat: VisitInput['atiyat'], categories: CategoryRule[]) {
  const included = new Set(categories.filter((c) => c.rewardIncluded).map((c) => c.id));
  let niyyat = 0;
  let wusooli = 0;
  let rewardWusooli = 0;
  for (const e of atiyat?.entries ?? []) {
    if (e.type === 'niyyat') {
      niyyat += n(e.amount);
    } else {
      wusooli += n(e.amount);
      if (included.has(e.category)) rewardWusooli += n(e.amount);
    }
  }
  const gsbAmount = n(atiyat?.gsb?.amount);
  return {
    niyyat,
    wusooli: wusooli + gsbAmount,
    rewardWusooli: rewardWusooli + gsbAmount,
    gsbBoxes: n(atiyat?.gsb?.boxesOpened),
    gsbAmount,
  };
}

/** Day totals written on submit (data model `DayTotals`). */
export function computeDayTotals(jadwal: JadwalInput, categories: CategoryRule[]): DayTotals {
  const totals: DayTotals = {
    villages: 0,
    oldDonors: 0,
    newDonors: 0,
    niyyat: 0,
    wusooli: 0,
    rewardWusooli: 0,
    excludedWusooli: 0,
    gsbBoxes: 0,
    gsbAmount: 0,
    ijtimas: 0,
    ijtimaParticipants: 0,
    mashwaras: 0,
    km: 0,
    fare: 0,
  };
  for (const visit of jadwal.visits ?? []) {
    totals.villages += 1;
    totals.oldDonors += n(visit.donors?.oldMet);
    totals.newDonors += visit.donors?.newDonors?.length ?? 0;
    const a = visitAtiyatTotals(visit.atiyat, categories);
    totals.niyyat += a.niyyat;
    totals.wusooli += a.wusooli;
    totals.rewardWusooli += a.rewardWusooli;
    totals.gsbBoxes += a.gsbBoxes;
    totals.gsbAmount += a.gsbAmount;
    if (visit.ijtima?.held) {
      totals.ijtimas += 1;
      totals.ijtimaParticipants += n(visit.ijtima.participants);
    }
    if (visit.mashwara?.held) totals.mashwaras += 1;
  }
  totals.excludedWusooli = totals.wusooli - totals.rewardWusooli;

  const travel = jadwal.travel;
  if (travel?.mode === 'bike' && travel.meterStart != null && travel.meterEnd != null) {
    totals.km = Math.max(0, travel.meterEnd - travel.meterStart);
  }
  if (travel?.mode === 'bus') totals.fare = n(travel.fare);
  return totals;
}
