/** research-smoke.mjs — fetch each source, print coverage + magnitude sanity. */
import { fetchFred, fetchDebtToPenny, fetchTermPremium, fetchShillerEarnings } from './research-fetch.mjs';

function tail(s) { return s.at(-1); }

const walcl = await fetchFred('WALCL');
console.log(`WALCL      : ${walcl.length} obs, latest ${tail(walcl).date} = $${(tail(walcl).value/1e6).toFixed(2)}T (raw millions)`);

const debt = await fetchDebtToPenny();
console.log(`DebtToPenny: ${debt.length} obs, latest ${tail(debt).date} = $${(tail(debt).value/1e12).toFixed(2)}T  [expect ~$36-39T]`);

const tp = await fetchTermPremium();
console.log(`TermPremium: ${tp.series.length} obs via ${tp.source}, latest ${tail(tp.series).date} = ${tail(tp.series).value.toFixed(2)}pp  [expect ~-1..+3]`);

const eps = await fetchShillerEarnings();
console.log(`ShillerEPS : ${eps.length} obs, latest ${tail(eps).date} = $${tail(eps).value.toFixed(2)}  [expect ~$150-250]`);
