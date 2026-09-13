/* ============================================================
   THE LEDGER — financial literacy simulation
   ============================================================ */

let LAPTOP_PRICE = 1200; // set by applyScenario() before the game starts
const MONTHS = 24;
let SPARE_CASH = 70; // baseline monthly discretionary cash, set by applyScenario() — zeroed out during a job-loss shock, see spareCashForMonth()

const PATH_META = {
  save: { name: 'Save First', color: '#2F6F4E' },
  loan: { name: 'Personal Loan', color: '#3C5A82' },
  card: { name: 'Credit Card', color: '#A63D40' }
};

// Fixed event script so all three paths can be compared fairly (same life
// happens to you regardless of which path you picked)
const EVENTS = {
  4:  { label: 'Car repair', amount: -180 },
  9:  { label: 'Work bonus', amount: 220 },
  14: { label: 'Vet bill', amount: -140 },
  19: { label: 'Birthday gift from family', amount: 100 },
};

// Optional shock scenario: two months with zero spare income, income only —
// the point isn't a one-off cash hit like EVENTS above, it's a sustained
// stretch where nothing is coming in while the bills (if any) keep coming.
const JOB_LOSS_AFFECTED_MONTHS = [16, 17];
let JOB_LOSS_ENABLED = false;

function spareCashForMonth(month){
  if(JOB_LOSS_ENABLED && JOB_LOSS_AFFECTED_MONTHS.includes(month)) return 0;
  return SPARE_CASH;
}

function jobLossRowIfNeeded(){
  if(JOB_LOSS_ENABLED && JOB_LOSS_AFFECTED_MONTHS.includes(state.month)){
    const isFirst = state.month === JOB_LOSS_AFFECTED_MONTHS[0];
    addRow({
      month: state.month,
      label: isFirst ? '⚠ Laid off — no income starting this month' : '⚠ Still no income this month',
      amount: null, balance: state.cash, isShock: true
    });
  }
}

let state = null;

function fmt(n){
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});
  return (neg?'-£':'£') + v;
}

function initState(path){
  // Loan and card both disburse/charge the full price on day one; only
  // saving starts from zero and builds toward it.
  const startingDebt = path === 'save' ? 0 : LAPTOP_PRICE;
  return {
    path,
    month: 0,
    cash: STARTING_CASH_BUFFER,
    savings: 0,
    debt: startingDebt,
    laptopOwned: path !== 'save',
    laptopBoughtMonth: path === 'save' ? null : 0,
    totalInterestPaid: 0,
    totalInterestEarned: 0,
    totalLateFees: 0,
    totalOverdraftFees: 0,
    backupCardDebt: 0,
    cardMonthlyChoice: 'min', // 'min' or 'fixed70'
    history: [], // {month, cash, savings, debt, netWorth}
    creditScoreExact: STARTING_SCORE,
    creditHistory: [], // {month, score}
    scoreFactors: {
      paymentOnTimeMonths: 0,
      paymentTotalMonths: 0,
      utilizationSum: 0,
      utilizationCount: 0,
      missedPayments: 0,
      missedStreak: 0,
      hasDelinquencyMark: false,
      hardInquiryApplied: false,
      debtClearedBonusGiven: false,
      backupCardOpened: false,
    },
    _missedThisMonth: false,
    ledgerRows: [],
    finished: false,
  };
}

// --- Loan math (rates set by applyScenario() before the game starts) ---
let LOAN_APR = 0.09;
let LOAN_MONTHLY_RATE = LOAN_APR/12;
let LOAN_PAYMENT = LAPTOP_PRICE * LOAN_MONTHLY_RATE / (1 - Math.pow(1+LOAN_MONTHLY_RATE, -MONTHS));

// --- Card math ---
let CARD_APR = 0.24;
let CARD_MONTHLY_RATE = CARD_APR/12;

// --- Savings math ---
const SAVE_AER = 0.03;
const SAVE_MONTHLY_RATE = SAVE_AER/12;

// --- Scenario / difficulty options ---
// Spare cash is a fixed % of the laptop's price, calibrated so the Personal
// Loan's fixed monthly payment is comfortably covered even at the toughest
// rate tier (14% APR) — otherwise a path that's supposed to be a
// straightforward 24-month payoff can quietly become unaffordable and
// spiral into overdrafts before the player ever makes a choice about it.
// Deriving every tier's spare cash from the same ratio, instead of tuning
// each tier's number by hand, is also what keeps the price-tier comparison
// fair: each tier carries the same relative budget slack, not an
// inconsistent one (the old hand-picked figures gave Budget 5.6% of price,
// Standard 5.0%, and Premium only 4.25% — which is exactly why only the
// Premium loan was underwater).
const SPARE_CASH_RATIO = 0.06;
function spareCashFor(price){ return Math.round(price * SPARE_CASH_RATIO / 5) * 5; }

const PRICE_OPTIONS = [
  { id:'budget',   label:'Budget laptop',   price:800,  spareCash:spareCashFor(800),  blurb:'A basic machine that gets the job done.' },
  { id:'standard', label:'Standard laptop', price:1200, spareCash:spareCashFor(1200), blurb:'A solid mid-range choice for work or school.' },
  { id:'premium',  label:'Premium laptop',  price:2000, spareCash:spareCashFor(2000), blurb:`Top-of-the-line — more to finance, more to save for. (A bit more monthly budget comes with it too — £${spareCashFor(2000)}/mo instead of £${spareCashFor(1200)}.)` },
];
const RATE_OPTIONS = [
  { id:'favorable', label:'Favorable rates', loanAPR:0.06, cardAPR:0.18, blurb:'Good credit, a friendly bank, a low-rate card.' },
  { id:'standard',  label:'Standard rates',  loanAPR:0.09, cardAPR:0.24, blurb:'Typical market rates for both.' },
  { id:'tough',     label:'Tough rates',     loanAPR:0.14, cardAPR:0.29, blurb:'Thin credit file, or just a bad year for rates.' },
];
const SHOCK_OPTIONS = [
  { id:'off', label:'Steady income',  blurb:'The standard 24-month story — spare cash arrives every month.' },
  { id:'on',  label:'Job loss shock', blurb:'You lose your job for 2 months partway through — zero income, same obligations.' },
];

let scenarioChoice = { price:'standard', rate:'standard', shock:'off' };

function applyScenario(){
  const price = PRICE_OPTIONS.find(o => o.id === scenarioChoice.price);
  const rate = RATE_OPTIONS.find(o => o.id === scenarioChoice.rate);
  LAPTOP_PRICE = price.price;
  SPARE_CASH = price.spareCash;
  LOAN_APR = rate.loanAPR;
  CARD_APR = rate.cardAPR;
  LOAN_MONTHLY_RATE = LOAN_APR / 12;
  CARD_MONTHLY_RATE = CARD_APR / 12;
  LOAN_PAYMENT = LAPTOP_PRICE * LOAN_MONTHLY_RATE / (1 - Math.pow(1+LOAN_MONTHLY_RATE, -MONTHS));
  JOB_LOSS_ENABLED = scenarioChoice.shock === 'on';

  // Both scale with laptop price so the "shape" of the card story stays
  // comparable across tiers: a £2,000 laptop gets a bigger limit (so
  // starting utilization is ~the same 40% across tiers) and a bigger
  // "pay more than the minimum" amount (so it stays proportionally
  // aggressive, not a shrinking rounding error against a larger balance).
  CARD_LIMIT = Math.round(LAPTOP_PRICE * 2.5 / 100) * 100;
  FIXED_CARD_PAYMENT = Math.round(70 * LAPTOP_PRICE / 1200 / 5) * 5;
}

// --- Cash-flow realism ---
// A small existing current-account cushion, separate from laptop savings —
// most people aren't at exactly £0. This is what a missed payment actually
// erodes: once it's gone, a payment that costs more than that month's spare
// cash genuinely cannot be made.
const STARTING_CASH_BUFFER = 150;
const LATE_FEE = 35;      // flat late fee charged to the balance on a missed/partial payment
const OVERDRAFT_FEE = 35; // flat bank fee for overdrafting to cover a payment in full

// --- Credit score modeling ---
// A simplified FICO-style model: payment history, utilization, new-credit/inquiry
// impact, and length-of-history dampening. Not a real scoring formula — built to
// teach the *direction and relative size* of each factor's effect.
const STARTING_SCORE = 700;         // all three paths start identically
let CARD_LIMIT = 3000;              // assumed credit limit on the card, set by applyScenario() — scales with laptop price so starting utilization is comparable across tiers
let FIXED_CARD_PAYMENT = 70;        // the "pay more than the minimum" amount, set by applyScenario() — scales with laptop price so it stays proportionally aggressive
const NEW_ACCOUNT_MONTHS = 6;       // "thin file" window: upward moves are dampened early on

function clampScore(v){ return Math.max(300, Math.min(850, v)); }
function displayScore(s){ return Math.round(clampScore(s.creditScoreExact)); }

function scoreBand(score){
  if(score >= 800) return {label:'Exceptional', color:'var(--score-exceptional)'};
  if(score >= 740) return {label:'Very Good',   color:'var(--score-verygood)'};
  if(score >= 670) return {label:'Good',        color:'var(--score-good)'};
  if(score >= 580) return {label:'Fair',        color:'var(--score-fair)'};
  return {label:'Poor', color:'var(--score-poor)'};
}

// Utilization is the single biggest lever on a revolving account: near-zero is
// rewarded, maxed-out is punished hard — this is the standard shape (not linear).
function utilizationDelta(util){
  if(util <= 0.10) return 3;
  if(util <= 0.30) return 1;
  if(util <= 0.50) return -1;
  if(util <= 0.75) return -3;
  return -6;
}

function applyScoreChange(s, delta, reason, notable){
  if(!delta) return;
  const before = displayScore(s);
  s.creditScoreExact = clampScore(s.creditScoreExact + delta);
  const after = displayScore(s);
  const actual = after - before;
  if(notable && actual !== 0){
    addRow({month:s.month, label:`Credit score — ${reason}`, amount:actual, balance:after, isScore:true});
  }
}

// Missed payments are modeled as the heaviest, fastest-moving factor —
// consistent with real scoring, where payment history outweighs utilization.
// The first miss hurts most; a longer streak keeps hurting but with
// diminishing marginal damage, which mirrors how bureaus treat 30/60/90-day
// delinquencies.
function missedPaymentPenalty(streak){
  if(streak <= 1) return -65;
  if(streak === 2) return -35;
  return -20;
}

// Loan and card both open a new account in month 1 — that's a hard inquiry
// and it dings the score a little, on purpose, regardless of how responsible
// you are afterwards.
function applyHardInquiryIfNeeded(s, f){
  if(s.month === 1 && !f.hardInquiryApplied){
    f.hardInquiryApplied = true;
    applyScoreChange(s, -8, 'hard inquiry, new account opened', true);
  }
}

// Shared by the missed-payment and on-time branches below — whichever one
// runs this month, a freshly-cleared balance still earns the same one-time
// bonus the moment it happens.
function applyDebtClearedBonusIfNeeded(s, f){
  if((s.path==='loan' || s.path==='card') && s.debt <= 0.01 && !f.debtClearedBonusGiven){
    f.debtClearedBonusGiven = true;
    applyScoreChange(s, 15, 'account paid in full', true);
  }
}

function applyMissedPaymentPenalty(s, f){
  f.paymentTotalMonths++;
  const penalty = missedPaymentPenalty(f.missedStreak);
  const ordinal = ordinalOf(f.missedStreak);
  applyScoreChange(s, penalty, `payment missed (${ordinal} in a row)`, true);
}

function applyOnTimeLoanPayment(s, f, dampen){
  f.paymentTotalMonths++;
  f.paymentOnTimeMonths++;
  let delta = 2 * dampen;
  if(f.hasDelinquencyMark) delta *= 0.5; // a past miss keeps weighing on the file
  applyScoreChange(s, delta, 'on-time installment payment', false);
}

// Utilization is the other big lever on a revolving account: how much of
// the card's limit the balance eats up, month over month. This is what
// actually differs between "pay the minimum" and "pay more than the
// minimum" — right up until cash can't cover the payment at all.
function applyOnTimeCardPayment(s, f, dampen){
  f.paymentTotalMonths++;
  f.paymentOnTimeMonths++;
  const util = Math.max(0, s.debt) / CARD_LIMIT;
  f.utilizationSum += util;
  f.utilizationCount++;
  let delta = utilizationDelta(util) * dampen;
  if(f.hasDelinquencyMark && delta > 0) delta *= 0.5; // a past miss keeps weighing on the file
  applyScoreChange(s, delta, util > 0.5 ? 'high utilization' : 'utilization in check', false);
}

function updateCreditScoreForMonth(s){
  const f = s.scoreFactors;

  if(s.path === 'save'){
    // No new account opened, nothing revolving to misuse — score drifts up
    // very slightly, reflecting a stable, low-utilization overall profile.
    applyScoreChange(s, 0.4, 'stable profile, no new debt', false);
    return;
  }

  applyHardInquiryIfNeeded(s, f);

  // New accounts have a short, thin credit history — upward movement is capped
  // for the first several months even with perfect behavior.
  const dampen = s.month <= NEW_ACCOUNT_MONTHS ? 0.5 : 1;

  if(s._missedThisMonth){
    // The miss dominates this month — no utilization/on-time credit on top of it.
    applyMissedPaymentPenalty(s, f);
    applyDebtClearedBonusIfNeeded(s, f);
    return;
  }

  if(s.path === 'loan') applyOnTimeLoanPayment(s, f, dampen);
  if(s.path === 'card') applyOnTimeCardPayment(s, f, dampen);

  applyDebtClearedBonusIfNeeded(s, f);
}

function rowClassNames(row){
  const classes = [];
  if(row.isEvent) classes.push('event');
  if(row.isMissed) classes.push('missed');
  if(row.isShock) classes.push('shock');
  return classes;
}

function rowAmountClass(row){
  if(row.amount > 0) return 'amt-pos';
  if(row.amount < 0) return 'amt-neg';
  return '';
}

function formatRowAmount(row){
  if(row.amount === null || row.amount === undefined) return '';
  if(row.isScore) return `${row.amount>0?'+':''}${row.amount} pts`;
  return fmt(row.amount);
}

function formatRowBalance(row){
  if(row.isScore) return `${row.balance} pts`;
  if(row.balance === null || row.balance === undefined) return '';
  return fmt(row.balance);
}

// Only one badge shows at a time — missed takes priority over a job-loss
// shock, which takes priority over a plain life event.
function rowBadge(row){
  if(row.isMissed) return ' <span class="stamp-badge missed-badge">missed</span>';
  if(row.isShock) return ' <span class="stamp-badge shock-badge">job loss</span>';
  if(row.isEvent) return ' <span class="stamp-badge">event</span>';
  return '';
}

function addRow(row){
  state.ledgerRows.push(row);
  const tbody = document.getElementById('ledger-body');
  const tr = document.createElement('tr');
  tr.classList.add(...rowClassNames(row));
  tr.innerHTML = `<td>${row.month}</td><td>${row.label}${rowBadge(row)}</td>
    <td style="text-align:right;" class="${rowAmountClass(row)}">${formatRowAmount(row)}</td>
    <td style="text-align:right;">${formatRowBalance(row)}</td>`;
  tbody.appendChild(tr);
  const scroller = document.querySelector('.ledger-scroll');
  scroller.scrollTop = scroller.scrollHeight;
}

function netWorth(s){
  return s.savings + s.cash - s.debt - (s.backupCardDebt||0);
}

function recordHistory(){
  state.history.push({
    month: state.month,
    cash: state.cash,
    savings: state.savings,
    debt: state.debt,
    netWorth: netWorth(state)
  });
  state.creditHistory.push({ month: state.month, score: displayScore(state) });
}

function updateStatusBar(){
  document.getElementById('stat-month').textContent = `${state.month} / ${MONTHS}`;
  document.getElementById('stat-cash').textContent = fmt(state.cash + state.savings);
  const debtLabel = document.getElementById('stat-debt-label');
  const debtVal = document.getElementById('stat-debt');
  if(state.path === 'save'){
    debtLabel.textContent = state.laptopOwned ? 'Laptop status' : 'Saved so far';
    debtVal.textContent = state.laptopOwned ? 'Owned ✓' : fmt(state.savings);
    debtVal.className = 'val';
  } else {
    debtLabel.textContent = 'Balance owed';
    const totalDebt = state.debt + (state.backupCardDebt||0);
    const backupNote = state.backupCardDebt > 0.5 ? ` <span style="font-size:11px;font-weight:400;">(${fmt(state.backupCardDebt)} backup card)</span>` : '';
    debtVal.innerHTML = fmt(totalDebt) + backupNote;
    debtVal.className = 'val ' + (totalDebt > 0 ? 'neg' : 'pos');
  }
  const nw = netWorth(state);
  const netEl = document.getElementById('stat-net');
  netEl.textContent = fmt(nw);
  netEl.className = 'val ' + (nw >= 0 ? 'pos':'neg');

  const score = displayScore(state);
  const band = scoreBand(score);
  const flag = state.scoreFactors.hasDelinquencyMark ? ' <span class="stamp-badge missed-badge">late mark</span>' : '';
  document.getElementById('stat-score').innerHTML =
    `${score} <span class="score-pill" id="stat-score-pill" style="background:${band.color};">${band.label}</span>${flag}`;
}

/* ---------- month simulation per path ---------- */

function simulateMonthSave(){
  state.month++;
  jobLossRowIfNeeded();
  let note = [];
  // interest on existing savings
  const interest = state.savings * SAVE_MONTHLY_RATE;
  state.savings += interest;
  state.totalInterestEarned += interest;
  if(interest > 0.004){
    addRow({month:state.month, label:'Interest earned', amount: interest, balance: state.savings});
  }
  // deposit
  const deposit = spareCashForMonth(state.month);
  if(deposit > 0){
    if(!state.laptopOwned){
      state.savings += deposit;
      addRow({month:state.month, label:'Monthly deposit to savings', amount: deposit, balance: state.savings});
    } else {
      state.cash += deposit;
      addRow({month:state.month, label:'Spare cash (laptop already owned)', amount: deposit, balance: state.cash});
    }
  }
  // event
  const ev = EVENTS[state.month];
  if(ev){
    if(ev.amount < 0){
      // negative event: pull from cash first, then savings if needed
      let need = -ev.amount;
      if(state.cash >= need){
        state.cash -= need;
      } else {
        const fromCash = state.cash;
        state.cash = 0;
        state.savings -= (need - fromCash);
      }
      addRow({month:state.month, label:ev.label, amount: ev.amount, balance: state.savings+state.cash, isEvent:true});
    } else {
      state.cash += ev.amount;
      addRow({month:state.month, label:ev.label, amount: ev.amount, balance: state.savings+state.cash, isEvent:true});
    }
  }
  // check if laptop can now be bought
  if(!state.laptopOwned && state.savings >= LAPTOP_PRICE){
    state.savings -= LAPTOP_PRICE;
    state.laptopOwned = true;
    state.laptopBoughtMonth = state.month;
    addRow({month:state.month, label:'★ Bought the laptop, in full', amount: -LAPTOP_PRICE, balance: state.savings});
  }
  updateCreditScoreForMonth(state);
  recordHistory();
}

/* ---------- loan & card: begin month (accrue interest, compute what's due) ---------- */

function beginMonthLoan(){
  state.month++;
  state._missedThisMonth = false;
  jobLossRowIfNeeded();
  const payoffAmount = state.debt * (1 + LOAN_MONTHLY_RATE);
  const due = state.debt > 0.01 ? Math.min(LOAN_PAYMENT, payoffAmount) : 0;
  const available = state.cash + spareCashForMonth(state.month);
  return { due, available };
}

function beginMonthCard(choiceOverride){
  state.month++;
  state._missedThisMonth = false;
  jobLossRowIfNeeded();
  const interest = state.debt * CARD_MONTHLY_RATE;
  state.totalInterestPaid += interest;
  state.debt += interest;
  addRow({month:state.month, label:'Interest charged', amount: interest, balance: state.debt});

  const choice = choiceOverride || state.cardMonthlyChoice;
  let due = choice === 'min' ? Math.max(25, state.debt * 0.03) : FIXED_CARD_PAYMENT;
  due = Math.min(due, state.debt);
  const available = state.cash + spareCashForMonth(state.month);
  return { due, available, choice };
}

/* ---------- resolve the payment: full, partial, overdraft, or backup card ---------- */
// This is shared by both loan and card months — the shortfall-handling choice
// works the same way regardless of which kind of debt it is.

// Applies `amount` toward the debt: for a loan, splits it into the interest
// already accrued this month (tracked, not reducing the balance further)
// and whatever's left going to principal; for a card, the whole amount just
// comes off the balance directly. Shared by the 'full', 'overdraft', and
// 'card' resolutions below, which all pay the full `due` amount and only
// differ in where the cash for it comes from.
function applyPrincipalPayment(s, amount, interestPortion){
  if(s.path === 'loan'){
    const principal = Math.min(amount - interestPortion, s.debt);
    s.debt -= principal;
    s.totalInterestPaid += interestPortion;
  } else {
    s.debt -= amount;
  }
}

// The one-time -8 score hit for opening a backup card only ever applies the
// first time it happens, whether that's triggered by an overdraft shortfall,
// a monthly payment shortfall, or a life event with no cash cushion to cover
// it — so all three call the same guarded mutation instead of repeating it.
function openBackupCardIfNeeded(s, reason){
  if(s.scoreFactors.backupCardOpened) return;
  s.scoreFactors.backupCardOpened = true;
  applyScoreChange(s, -8, reason, true);
}

function resolvePaymentFull(s, due, available, label, interestPortion){
  applyPrincipalPayment(s, due, interestPortion);
  s.cash = available - due;
  addRow({month:s.month, label, amount:-due, balance:s.debt});
  if(s.scoreFactors.missedStreak > 0) s.scoreFactors.missedStreak = 0;
}

// The player chooses how much of the available cash to put toward it —
// anywhere from £0 up to everything on hand. Anything less than what's due
// still reports as a missed payment (same score consequence whether you pay
// £0 or £1 short), but the amount changes two real things: how much the
// balance actually drops, and how much cash cushion survives into next month.
function resolvePaymentPartial(s, due, available, partialAmount, interestPortion){
  const partial = Math.max(0, Math.min(available, partialAmount === undefined ? available : partialAmount));
  if(s.path === 'loan'){
    s.debt = s.debt + interestPortion - partial; // accrue interest, subtract whatever was paid
    s.totalInterestPaid += interestPortion;
  } else {
    s.debt -= partial;
  }
  s.cash = available - partial;
  addRow({month:s.month, label:`Partial payment — paid ${fmt(partial)} of ${fmt(due)} due`, amount:-partial, balance:s.debt, isMissed:true});
  s.debt += LATE_FEE;
  s.totalLateFees += LATE_FEE;
  addRow({month:s.month, label:'Late fee — below the amount due', amount:LATE_FEE, balance:s.debt, isMissed:true});
  s.scoreFactors.missedStreak++;
  s.scoreFactors.missedPayments++;
  s.scoreFactors.hasDelinquencyMark = true;
  s._missedThisMonth = true;
}

// Paid in full and on time — the bank covers the gap. Overdrafts aren't
// reported to credit bureaus, so there's no score hit, just a fee. If cash
// can't absorb the payment plus that fee, this floors cash at £0 and moves
// the remainder onto revolving debt instead — the same shortfall-handling
// applyEventsAndScoring() already uses for EVENTS — rather than letting cash
// spiral arbitrarily negative and re-trigger a fresh overdraft fee every
// subsequent month with no way to recover.
function resolvePaymentOverdraft(s, due, available, label, interestPortion){
  applyPrincipalPayment(s, due, interestPortion);
  const cashAfter = available - due - OVERDRAFT_FEE;
  s.totalOverdraftFees += OVERDRAFT_FEE;
  addRow({month:s.month, label:`${label} (paid in full)`, amount:-due, balance:s.debt});
  addRow({month:s.month, label:'Overdraft fee', amount:OVERDRAFT_FEE, balance:Math.max(0, cashAfter)});
  if(cashAfter < 0){
    const shortfall = -cashAfter;
    s.cash = 0;
    if(s.path === 'card'){
      s.debt += shortfall;
      addRow({month:s.month, label:'Overdraft shortfall — no cash cushion, charged to card', amount:-shortfall, balance:s.debt});
    } else {
      openBackupCardIfNeeded(s, 'backup card opened to cover an overdraft shortfall');
      s.backupCardDebt = (s.backupCardDebt||0) + shortfall;
      addRow({month:s.month, label:'Overdraft shortfall — no cash cushion, charged to backup card', amount:-shortfall, balance:s.backupCardDebt});
    }
  } else {
    s.cash = cashAfter;
  }
  if(s.scoreFactors.missedStreak > 0) s.scoreFactors.missedStreak = 0;
}

// Paid in full and on time — just funded by a backup credit card instead of
// cash. The original account looks clean; the cost moves to a new,
// higher-rate balance that keeps compounding for the rest of the game.
function resolvePaymentViaBackupCard(s, due, available, label, interestPortion){
  applyPrincipalPayment(s, due, interestPortion);
  s.backupCardDebt = (s.backupCardDebt||0) + due;
  s.cash = available;
  openBackupCardIfNeeded(s, 'backup card opened to cover a payment');
  addRow({month:s.month, label:`${label} — covered by a backup credit card`, amount:-due, balance:s.debt});
  if(s.scoreFactors.missedStreak > 0) s.scoreFactors.missedStreak = 0;
}

function resolveDebtPayment(resolution, due, available, partialAmount){
  const s = state;
  const cardPaymentLabel = s.cardMonthlyChoice === 'min' ? 'Minimum payment' : `Fixed payment (${fmt(FIXED_CARD_PAYMENT)})`;
  const label = s.path === 'loan' ? 'Loan payment' : cardPaymentLabel;
  let interestPortion = 0;
  if(s.path === 'loan' && due > 0){
    interestPortion = s.debt * LOAN_MONTHLY_RATE;
  }

  if(due <= 0.01){
    s.cash = available;
    return;
  }

  if(resolution === 'full') resolvePaymentFull(s, due, available, label, interestPortion);
  else if(resolution === 'partial') resolvePaymentPartial(s, due, available, partialAmount, interestPortion);
  else if(resolution === 'overdraft') resolvePaymentOverdraft(s, due, available, label, interestPortion);
  else if(resolution === 'card') resolvePaymentViaBackupCard(s, due, available, label, interestPortion);
}

/* ---------- finish the month: events, backup-card interest, scoring, bookkeeping ---------- */

function applyEventsAndScoring(){
  const ev = EVENTS[state.month];
  if(ev){
    if(ev.amount < 0 && state.cash < -ev.amount){
      // not enough cash cushion -> the shortfall goes onto revolving debt —
      // the card itself if that's the path, otherwise a backup card
      const shortfall = -ev.amount - state.cash;
      state.cash = 0;
      if(state.path === 'card'){
        state.debt += shortfall;
        addRow({month:state.month, label: ev.label + ' — no cash cushion, charged to card', amount: ev.amount, balance: state.debt, isEvent:true});
      } else {
        openBackupCardIfNeeded(state, 'backup card opened to cover an expense');
        state.backupCardDebt = (state.backupCardDebt||0) + shortfall;
        addRow({month:state.month, label: ev.label + ' — no cash cushion, charged to backup card', amount: ev.amount, balance: state.backupCardDebt, isEvent:true});
      }
    } else {
      state.cash += ev.amount;
      addRow({month:state.month, label:ev.label, amount: ev.amount, balance: state.cash, isEvent:true});
    }
  }
  if(state.backupCardDebt > 0){
    state.backupCardDebt *= (1 + CARD_MONTHLY_RATE);
  }
  updateCreditScoreForMonth(state);
  recordHistory();
}

// Runs one full debt-path month with no player interaction — used both for
// the two background comparison paths at game end, and for fast-forward,
// where a shortfall (if any) is auto-resolved rather than prompted.
function simulateMonthAuto(path, cardChoice, autoResolution){
  if(path === 'save'){ simulateMonthSave(); return; }
  const begin = path === 'loan' ? beginMonthLoan() : beginMonthCard(cardChoice);
  if(begin.due <= 0.01 || begin.available >= begin.due){
    resolveDebtPayment('full', begin.due, begin.available);
  } else {
    resolveDebtPayment(autoResolution || 'overdraft', begin.due, begin.available);
  }
  applyEventsAndScoring();
}

/* ---------- background "silent" simulations for comparison ---------- */

function runFullSim(path, cardChoice){
  const s = initState(path);
  const oldState = state;
  state = s;
  // suppress DOM writes by stubbing addRow temporarily
  const realAddRow = addRow;
  window.__suppress = true;
  addRow = (row)=>{ s.ledgerRows.push(row); };
  for(let m=0;m<MONTHS;m++){
    simulateMonthAuto(path, cardChoice, 'overdraft');
  }
  addRow = realAddRow;
  state = oldState;
  return s;
}

/* ---------- scenario / difficulty selection ---------- */

function optionDetail(opt){
  if(opt.price !== undefined) return `£${opt.price.toLocaleString()} · £${opt.spareCash}/mo budget`;
  if(opt.loanAPR !== undefined) return `Loan ${(opt.loanAPR*100).toFixed(1)}% · Card ${(opt.cardAPR*100).toFixed(1)}%`;
  return '';
}

function paintOptionSlider(container, options, idx){
  const opt = options[idx];
  const detail = optionDetail(opt);
  container.querySelector('.chip-label').textContent = opt.label;
  const detailEl = container.querySelector('.chip-detail');
  detailEl.textContent = detail;
  detailEl.style.display = detail ? '' : 'none';
  container.querySelector('.chip-blurb').textContent = opt.blurb;
  container.querySelector('.option-range').setAttribute('aria-valuetext', opt.label);
  container.querySelectorAll('.option-tick').forEach((t, ti) => t.classList.toggle('active', ti === idx));
}

function renderOptionSlider(containerId, options, groupKey, groupLabel){
  const container = document.getElementById(containerId);
  const idx = Math.max(0, options.findIndex(o => o.id === scenarioChoice[groupKey]));

  container.innerHTML = `
    <input type="range" class="option-range" min="0" max="${options.length-1}" step="1" value="${idx}" aria-label="${groupLabel}">
    <div class="option-ticks">${options.map(o => `<span class="option-tick">${o.label}</span>`).join('')}</div>
    <div class="option-readout">
      <div class="chip-label"></div>
      <div class="chip-detail"></div>
      <div class="chip-blurb"></div>
    </div>`;

  const range = container.querySelector('.option-range');
  range.addEventListener('input', () => {
    const i = Number.parseInt(range.value, 10);
    scenarioChoice[groupKey] = options[i].id;
    paintOptionSlider(container, options, i);
  });
  paintOptionSlider(container, options, idx);
}

function renderScenarioScreen(){
  renderOptionSlider('chips-price', PRICE_OPTIONS, 'price', 'Laptop price');
  renderOptionSlider('chips-rate', RATE_OPTIONS, 'rate', 'Interest-rate environment');
  renderOptionSlider('chips-shock', SHOCK_OPTIONS, 'shock', 'Income stability');
}
renderScenarioScreen();

// Weighted toward the easier/middle end of each dimension, so a run of
// "Random" clicks doesn't keep landing on the harshest possible setup. The
// hardest single options (Premium, Tough, shock on) stay reachable — a
// quarter-to-a-third of rolls on their own dimension — they're just no
// longer as likely to all show up in the same run as an easy pick would be.
const PRICE_WEIGHTS = { budget: 0.35, standard: 0.40, premium: 0.25 };
const RATE_WEIGHTS  = { favorable: 0.35, standard: 0.40, tough: 0.25 };
const SHOCK_WEIGHTS = { off: 0.70, on: 0.30 };

function weightedPick(options, weights){
  const total = options.reduce((sum, o) => sum + (weights[o.id] ?? 1), 0);
  let r = Math.random() * total;
  for (const o of options) {
    r -= (weights[o.id] ?? 1);
    if (r <= 0) return o.id;
  }
  return options[options.length - 1].id; // float-rounding fallback
}

function rollScenarioCandidate(){
  let candidate, attempts = 0;
  do {
    candidate = {
      price: weightedPick(PRICE_OPTIONS, PRICE_WEIGHTS),
      rate: weightedPick(RATE_OPTIONS, RATE_WEIGHTS),
      shock: weightedPick(SHOCK_OPTIONS, SHOCK_WEIGHTS),
    };
    attempts++;
    // The three per-dimension weights already make this corner rarer on
    // their own (~1.9% vs. a uniform 5.6%) — this adds a further 70% chance
    // to reroll away from it specifically, since it's the one combination
    // most likely to read as "unlucky" rather than "an interesting run."
    const isHardestCorner = candidate.price === 'premium' && candidate.rate === 'tough' && candidate.shock === 'on';
    if (isHardestCorner && Math.random() < 0.7 && attempts < 25) continue;
    break;
  } while (true);
  return candidate;
}

function randomizeScenario(){
  // Re-roll until the result actually differs from the current selection,
  // so clicking Random always visibly does something.
  const before = { ...scenarioChoice };
  let candidate, guard = 0;
  do {
    candidate = rollScenarioCandidate();
    guard++;
  } while (
    guard < 25 &&
    candidate.price === before.price &&
    candidate.rate === before.rate &&
    candidate.shock === before.shock
  );
  animateScenarioShuffle(candidate);
}

// Cycles through a few quick, purely-visual random picks before settling on
// the already-decided final candidate — the weighting/corner-avoidance logic
// has already run by this point, this is just motion, not another roll.
// Each leg glides the slider thumbs smoothly to their next stop rather than
// snapping, and legs slow down toward the end (like a wheel of fortune) so
// it reads as "settling" rather than just flickering at a constant rate.
const SHUFFLE_FRAMES = 9;
const SHUFFLE_BASE_DELAY = 45;
const SHUFFLE_DELAY_GROWTH = 9;

// Eases a slider's thumb from its current position to targetIdx over
// `duration` ms, repainting the readout as it crosses each step so the
// motion reads as one continuous glide instead of a series of jump cuts.
function tweenSliderTo(range, container, options, targetIdx, duration){
  return new Promise(resolve => {
    const fromVal = Number.parseFloat(range.value);
    if(fromVal === targetIdx){
      paintOptionSlider(container, options, targetIdx);
      resolve();
      return;
    }
    const start = performance.now();
    let lastPainted = -1;
    function step(now){
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 2);
      const val = fromVal + (targetIdx - fromVal) * eased;
      range.value = val;
      const roundedIdx = Math.round(val);
      if(roundedIdx !== lastPainted){
        paintOptionSlider(container, options, roundedIdx);
        lastPainted = roundedIdx;
      }
      if(t < 1){
        requestAnimationFrame(step);
      } else {
        range.value = targetIdx;
        paintOptionSlider(container, options, targetIdx);
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

function animateScenarioShuffle(finalCandidate){
  if(isReduceMotionActive()){
    // Skip straight to the result — no frames, no disabled buttons, nothing
    // to sit through. This is the whole point of the setting.
    scenarioChoice = finalCandidate;
    renderScenarioScreen();
    return;
  }

  const btn = document.getElementById('btn-scenario-random');
  const continueBtn = document.getElementById('btn-scenario-continue');
  btn.disabled = true;
  continueBtn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '🎲 Rolling…';

  const groups = [
    { containerId:'chips-price', options: PRICE_OPTIONS, key:'price' },
    { containerId:'chips-rate',  options: RATE_OPTIONS,  key:'rate'  },
    { containerId:'chips-shock', options: SHOCK_OPTIONS, key:'shock' },
  ].map(g => {
    const container = document.getElementById(g.containerId);
    container.classList.add('shuffling');
    const range = container.querySelector('.option-range');
    // step="1" makes the browser snap .value to the nearest integer even
    // when we assign a fractional number — relax it so the thumb can glide
    // through in-between positions, then restore it once settled.
    range.step = 'any';
    return { ...g, container, range };
  });

  let frame = 0;
  function nextFrame(){
    if(frame < SHUFFLE_FRAMES){
      const isLast = frame === SHUFFLE_FRAMES - 1;
      const duration = SHUFFLE_BASE_DELAY + frame * SHUFFLE_DELAY_GROWTH;
      const targets = isLast ? finalCandidate : {
        price: randomPickUniform(PRICE_OPTIONS),
        rate: randomPickUniform(RATE_OPTIONS),
        shock: randomPickUniform(SHOCK_OPTIONS),
      };
      scenarioChoice = targets;
      Promise.all(groups.map(g =>
        tweenSliderTo(g.range, g.container, g.options, g.options.findIndex(o => o.id === targets[g.key]), duration)
      )).then(() => { frame++; nextFrame(); });
    } else {
      groups.forEach(g => {
        g.range.step = '1';
        g.container.classList.remove('shuffling');
        g.container.classList.add('settle');
      });
      setTimeout(() => groups.forEach(g => g.container.classList.remove('settle')), 200);
      btn.textContent = originalLabel;
      btn.disabled = false;
      continueBtn.disabled = false;
    }
  }
  nextFrame();
}

function randomPickUniform(options){
  return options[Math.floor(Math.random() * options.length)].id;
}

/* ---------- reduced motion: respect the OS setting, allow a manual override ---------- */

let reduceMotionActive = false;
let motionPreferenceSetByUser = false; // once the player touches the toggle, stop following OS changes

function isReduceMotionActive(){ return reduceMotionActive; }

function prefersReducedMotionFromOS(){
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setReduceMotionUI(active){
  reduceMotionActive = active;
  const btn = document.getElementById('btn-reduce-motion');
  btn.setAttribute('aria-pressed', String(active));
  document.getElementById('reduce-motion-state').textContent = active ? 'On' : 'Off';
}

function initReduceMotionToggle(){
  setReduceMotionUI(prefersReducedMotionFromOS());
  document.getElementById('btn-reduce-motion').addEventListener('click', () => {
    motionPreferenceSetByUser = true;
    setReduceMotionUI(!reduceMotionActive);
  });
  // If the OS-level setting changes mid-session (and the player hasn't
  // manually overridden it), follow along rather than leaving it stale.
  if(typeof window.matchMedia === 'function'){
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e) => { if(!motionPreferenceSetByUser) setReduceMotionUI(e.matches); };
    if(mq.addEventListener) mq.addEventListener('change', onChange);
    else if(mq.addListener) mq.addListener(onChange); // older Safari
  }
}
initReduceMotionToggle();

document.getElementById('btn-scenario-random').addEventListener('click', randomizeScenario);

function applyScenarioTextToPickScreen(){
  const price = PRICE_OPTIONS.find(o => o.id === scenarioChoice.price);
  const rate = RATE_OPTIONS.find(o => o.id === scenarioChoice.rate);
  const shockOn = scenarioChoice.shock === 'on';

  document.getElementById('scenario-headline').textContent = `You need a ${fmt(LAPTOP_PRICE)} laptop.`;
  document.getElementById('scenario-recap').textContent =
    `— ${price.label} · ${rate.label}${shockOn ? ' · job-loss shock' : ''}`;
  document.getElementById('scenario-shock-note').style.display = shockOn ? 'block' : 'none';
  document.getElementById('spare-cash-mention').textContent = `${fmt(SPARE_CASH)}/month of spare cash`;
  document.getElementById('card-limit-mention').textContent = fmt(CARD_LIMIT);

  document.getElementById('save-blurb').textContent =
    `Set the ${fmt(SPARE_CASH)}/month aside in a savings account. Buy the laptop once you've saved ${fmt(LAPTOP_PRICE)}. You wait — but you earn interest, and you owe no one.`;
  document.getElementById('save-terms').innerHTML =
    `Savings AER: 3.0%<br>Deposit: ${fmt(SPARE_CASH)}/mo<br>Laptop arrives: when funded`;
  document.getElementById('loan-blurb').textContent =
    `Borrow ${fmt(LAPTOP_PRICE)} from the bank today, get the laptop immediately, repay in fixed monthly installments over 2 years.`;
  document.getElementById('loan-terms').innerHTML =
    `APR: ${(LOAN_APR*100).toFixed(1)}%<br>Term: 24 months<br>Laptop arrives: today`;
  document.getElementById('card-blurb').textContent =
    `Charge ${fmt(LAPTOP_PRICE)} to your credit card, get the laptop immediately. Pay it down however fast (or slow) you like each month.`;
  document.getElementById('card-terms').innerHTML =
    `APR: ${(CARD_APR*100).toFixed(1)}%<br>Term: open-ended<br>Laptop arrives: today`;
}

document.getElementById('btn-scenario-continue').addEventListener('click', () => {
  applyScenario();
  applyScenarioTextToPickScreen();
  document.getElementById('screen-scenario').classList.add('hidden');
  document.getElementById('screen-pick').classList.remove('hidden');
  document.getElementById('scenario-headline').focus();
});

document.getElementById('scenario-change-link').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('screen-pick').classList.add('hidden');
  document.getElementById('screen-scenario').classList.remove('hidden');
  document.getElementById('scenario-setup-headline').focus();
});

/* ---------- UI flow ---------- */

document.querySelectorAll('.path-card').forEach(el=>{
  el.addEventListener('click', ()=>{
    const path = el.dataset.path;
    startGame(path);
  });
});

function startGame(path){
  state = initState(path);
  uiLocked = false;
  document.getElementById('screen-pick').classList.add('hidden');
  document.getElementById('screen-summary').classList.add('hidden');
  document.getElementById('screen-ledger').classList.remove('hidden');
  document.getElementById('ledger-body').innerHTML = '';
  document.getElementById('ledger-scenario-recap').textContent = `Playing: ${getScenarioRecapData().recapText}`;
  document.getElementById('path-badge').textContent = PATH_META[path].name;
  document.getElementById('ledger-title').textContent =
    path==='save' ? 'Savings Passbook' : path==='loan' ? 'Loan Statement' : 'Credit Card Statement';
  document.getElementById('prompt-area').innerHTML = '';
  if(path === 'loan' || path === 'card'){
    addRow({month:0, label: path==='loan' ? 'Loan disbursed — laptop purchased today' : 'Charged to card — laptop purchased today', amount: LAPTOP_PRICE, balance: state.debt});
  } else {
    addRow({month:0, label:'Starting balance', amount:null, balance:0});
  }
  recordHistory();
  updateStatusBar();
  document.getElementById('ledger-title').focus();
}

let uiLocked = false;

function showPromptIfNeeded(){
  const area = document.getElementById('prompt-area');
  area.innerHTML = '';
  if(state.path === 'card' && [6,12,18].includes(state.month+1)){
    const nextMonth = state.month+1;
    uiLocked = true;
    area.innerHTML = `
      <div class="prompt">
        <div class="eyebrow">Decision — Month ${nextMonth}</div>
        <p>Your card balance is <b>${fmt(state.debt)}</b>. How do you pay it this month?</p>
        <div class="btn-row">
          <button class="btn ghost" id="choice-min">Pay the minimum only</button>
          <button class="btn" id="choice-fixed">Pay a fixed ${fmt(FIXED_CARD_PAYMENT)}</button>
        </div>
      </div>`;
    document.getElementById('choice-min').onclick = ()=>{ state.cardMonthlyChoice='min'; uiLocked=false; advanceMonth(false); };
    document.getElementById('choice-fixed').onclick = ()=>{ state.cardMonthlyChoice='fixed70'; uiLocked=false; advanceMonth(false); };
    area.focus();
    return true;
  }
  return false;
}

function ordinalOf(n){
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th';
}

// Preview what a missed/partial payment would do to the score, without
// mutating any state. The immediate result (ladder[0]) is deliberately
// independent of the amount paid — that's the point being shown to the
// player. The rest of the ladder forecasts what continuing to miss, one
// month after another, would do — showing the penalty shrink per step
// (real scoring: 30/60/90-day-late tiers) without ever hitting zero.
const SCORE_LADDER_STEPS = 3;

// Forecasts the OTHER branch: what N consecutive on-time payments, starting
// the month right after this one, would do to the score. Uses the same
// formulas as the real monthly scoring (loan: flat on-time credit; card:
// utilization-based, using current utilization as a stand-in since future
// paydown isn't known yet) — including the same delinquency-mark dampening
// that a real recovery would face, since this preview only fires when a
// miss (this one) is already on the books.
function previewRecoveryLadder(startScore, startMonth){
  const ladder = [];
  let runningExact = startScore;
  let prevScore = startScore;
  const util = state.path === 'card' ? Math.max(0, state.debt) / CARD_LIMIT : null;
  for(let i = 1; i <= SCORE_LADDER_STEPS; i++){
    const futureMonth = startMonth + i;
    const dampen = futureMonth <= NEW_ACCOUNT_MONTHS ? 0.5 : 1;
    let delta = state.path === 'loan' ? 2 * dampen : utilizationDelta(util) * dampen;
    if(delta > 0) delta *= 0.5; // a delinquency mark on file dampens recovery, same as live scoring
    runningExact = clampScore(runningExact + delta);
    const score = Math.round(runningExact);
    ladder.push({ n: i, score, band: scoreBand(score), stepGain: score - prevScore });
    prevScore = score;
  }
  return ladder;
}

function previewMissedPenalty(){
  const before = displayScore(state);
  const startStreak = state.scoreFactors.missedStreak + 1;
  const ladder = [];
  let runningExact = state.creditScoreExact;
  let prevScore = before;
  for(let i = 0; i < SCORE_LADDER_STEPS; i++){
    const streak = startStreak + i;
    const penalty = missedPaymentPenalty(streak);
    runningExact = clampScore(runningExact + penalty);
    const score = Math.round(runningExact);
    ladder.push({ streak, ordinal: ordinalOf(streak), score, band: scoreBand(score), stepPenalty: score - prevScore });
    prevScore = score;
  }
  const first = ladder[0];
  const recovery = previewRecoveryLadder(first.score, state.month);
  return { before, ladder, recovery, after: first.score, band: first.band, ordinal: first.ordinal, penalty: first.stepPenalty };
}

function promptShortfall(due, available){
  uiLocked = true;
  renderShortfallChoice(due, available);
}

function renderShortfallChoice(due, available){
  const shortBy = due - available;
  const preview = previewMissedPenalty();
  const backupNote = state.scoreFactors.backupCardOpened ? 'no additional score impact' : '-8 pts one-time, new account';
  const area = document.getElementById('prompt-area');
  area.innerHTML = `
    <div class="prompt">
      <div class="eyebrow">Decision — Month ${state.month} — Payment shortfall</div>
      <p>This month's payment is <b>${fmt(due)}</b>, but you only have <b>${fmt(available)}</b> on hand — short by <b>${fmt(shortBy)}</b>. How do you handle it?</p>
      <div class="btn-row">
        <button class="btn ghost choice-block" id="choice-partial-open">
          <span class="choice-title">Pay part of it — choose how much</span>
          <span class="choice-note bad">drops score to ~${preview.after} (${preview.band.label})</span>
        </button>
        <button class="btn ghost choice-block" id="choice-overdraft">
          <span class="choice-title">Overdraft to pay in full</span>
          <span class="choice-note">+${fmt(OVERDRAFT_FEE)} bank fee · no score impact</span>
        </button>
        <button class="btn choice-block" id="choice-backup">
          <span class="choice-title">Charge the rest to a backup card</span>
          <span class="choice-note">${backupNote}</span>
        </button>
      </div>
    </div>`;
  document.getElementById('choice-partial-open').onclick = ()=>{ renderPartialSlider(due, available); };
  document.getElementById('choice-overdraft').onclick = ()=>{ uiLocked=false; resolveDebtPayment('overdraft', due, available); wrapUpMonth(); };
  document.getElementById('choice-backup').onclick = ()=>{ uiLocked=false; resolveDebtPayment('card', due, available); wrapUpMonth(); };
  area.focus();
}

function renderPartialSlider(due, available){
  const area = document.getElementById('prompt-area');
  const initial = Math.round(available / 2);
  const preview = previewMissedPenalty();
  area.innerHTML = `
    <div class="prompt">
      <div class="eyebrow">Decision — Month ${state.month} — How much do you pay?</div>
      <p>You have <b>${fmt(available)}</b> on hand. This still counts as your <b>${preview.ordinal}</b> missed payment in a row — the score consequence below is fixed no matter what you choose on the slider. What actually moves with the slider is your balance and your cash cushion.</p>
      <div class="score-consequence">
        <span>Score after confirming, regardless of amount paid:</span>
        <span class="score-consequence-val">${preview.before} → ${preview.after} <span class="score-pill" style="background:${preview.band.color};">${preview.band.label}</span></span>
      </div>
      <div class="ladder-wrap">
        <div class="eyebrow">If it keeps happening, one miss per month:</div>
        <div class="ladder-row">
          <div class="ladder-step now">
            <span class="ladder-score">${preview.before}</span>
            <span class="ladder-label">now</span>
          </div>
          ${preview.ladder.map(step => `
          <span class="ladder-arrow">→</span>
          <div class="ladder-step">
            <span class="ladder-score">${step.score}</span>
            <span class="ladder-label">${step.ordinal}</span>
            <span class="ladder-delta">${step.stepPenalty} pts</span>
          </div>`).join('')}
        </div>
        <div class="ladder-note">Each additional miss hurts less than the last — but it never stops hurting.</div>
      </div>
      <div class="ladder-wrap recovery">
        <div class="eyebrow">Or, if you pay on time for the next ${SCORE_LADDER_STEPS} months instead:</div>
        <div class="ladder-row">
          <div class="ladder-step now">
            <span class="ladder-score">${preview.after}</span>
            <span class="ladder-label">after this</span>
          </div>
          ${preview.recovery.map(step => `
          <span class="ladder-arrow recovery-arrow">→</span>
          <div class="ladder-step recovery-step">
            <span class="ladder-score">${step.score}</span>
            <span class="ladder-label">+${step.n} mo. on time</span>
            <span class="ladder-delta positive">${step.stepGain>0?'+':''}${step.stepGain} pts</span>
          </div>`).join('')}
        </div>
        <div class="ladder-note">Recovery is slower than the drop — a missed payment keeps dragging on the score even while you're doing everything right afterward.</div>
      </div>
      <div style="margin:16px 0 10px;">
        <input type="range" id="partial-slider" min="0" max="${available.toFixed(2)}" step="1" value="${initial}" aria-label="How much to pay toward this shortfall" aria-valuetext="${fmt(initial)}">
        <div style="display:flex;justify-content:space-between;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6b6350;margin-top:4px;">
          <span>£0 — keep all your cash</span>
          <span>${fmt(available)} — keep none</span>
        </div>
      </div>
      <div class="slider-readout">
        <div><div class="eyebrow">You'll pay</div><div class="num" id="partial-pay-amt">${fmt(initial)}</div></div>
        <div><div class="eyebrow">Balance drops by</div><div class="num" id="partial-debt-drop">${fmt(initial)}</div></div>
        <div><div class="eyebrow">Cash you keep</div><div class="num" id="partial-cash-left">${fmt(available-initial)}</div></div>
      </div>
      <div class="btn-row">
        <button class="btn ghost" id="preset-0">Pay £0</button>
        <button class="btn ghost" id="preset-half">Pay half</button>
        <button class="btn ghost" id="preset-all">Pay all ${fmt(available)}</button>
        <button class="btn" id="confirm-partial">Confirm</button>
        <button class="btn ghost" id="back-to-choices">← Back</button>
      </div>
    </div>`;

  const slider = document.getElementById('partial-slider');
  const payEl = document.getElementById('partial-pay-amt');
  const debtEl = document.getElementById('partial-debt-drop');
  const cashEl = document.getElementById('partial-cash-left');
  function refresh(){
    const v = Number.parseFloat(slider.value);
    payEl.textContent = fmt(v);
    debtEl.textContent = fmt(v);
    cashEl.textContent = fmt(available - v);
    slider.setAttribute('aria-valuetext', fmt(v));
  }
  slider.oninput = refresh;
  document.getElementById('preset-0').onclick = ()=>{ slider.value = 0; refresh(); };
  document.getElementById('preset-half').onclick = ()=>{ slider.value = (available/2).toFixed(2); refresh(); };
  document.getElementById('preset-all').onclick = ()=>{ slider.value = available.toFixed(2); refresh(); };
  document.getElementById('back-to-choices').onclick = ()=>{ renderShortfallChoice(due, available); };
  document.getElementById('confirm-partial').onclick = ()=>{
    const amt = Number.parseFloat(slider.value);
    uiLocked = false;
    resolveDebtPayment('partial', due, available, amt);
    wrapUpMonth();
  };
  area.focus();
}

function wrapUpMonth(){
  applyEventsAndScoring();
  updateStatusBar();
  document.getElementById('prompt-area').innerHTML = '';
  if(state.month >= MONTHS){
    finishGame();
  }
}

function advanceMonth(auto){
  if(state.month >= MONTHS){ return; }

  if(state.path === 'save'){
    simulateMonthSave();
    updateStatusBar();
    document.getElementById('prompt-area').innerHTML = '';
    if(state.month >= MONTHS){ finishGame(); }
    return;
  }

  const begin = state.path === 'loan' ? beginMonthLoan() : beginMonthCard();

  if(begin.due <= 0.01 || begin.available >= begin.due){
    resolveDebtPayment('full', begin.due, begin.available);
    wrapUpMonth();
  } else if(auto){
    // fast-forward / background sim: auto-resolve via overdraft so the game
    // never silently corrupts a month waiting on input that won't come
    resolveDebtPayment('overdraft', begin.due, begin.available);
    wrapUpMonth();
  } else {
    promptShortfall(begin.due, begin.available);
  }
}

document.getElementById('btn-next').addEventListener('click', ()=>{
  if(uiLocked) return;
  if(showPromptIfNeeded()) return;
  advanceMonth(false);
});

document.getElementById('btn-fastforward').addEventListener('click', ()=>{
  if(uiLocked) return;
  while(state.month < MONTHS){
    advanceMonth(true);
  }
});

document.getElementById('btn-restart').addEventListener('click', ()=>{
  document.getElementById('screen-summary').classList.add('hidden');
  document.getElementById('screen-pick').classList.remove('hidden');
  document.getElementById('scenario-headline').focus();
});

document.getElementById('btn-change-scenario').addEventListener('click', ()=>{
  document.getElementById('screen-summary').classList.add('hidden');
  document.getElementById('screen-scenario').classList.remove('hidden');
  document.getElementById('scenario-setup-headline').focus();
});

// Structured per-path summary — the single source of truth both the
// plain-text export and the JSON export pull from, so they can't drift out
// of sync with each other (or with what renderCompare shows on screen).
// Projects how much longer a remaining Credit Card balance would take to
// clear — and how much more interest it would rack up — if the same
// monthly payment strategy just kept going past month 24, using the exact
// interest-then-payment formula the live sim uses each month (see
// beginMonthCard), applied in isolation with no further life events or
// shortfalls assumed. The month cap is a safety net against an infinite
// loop (a minimum payment that doesn't cover the month's interest would
// never converge), not something today's rate range is expected to hit.
const CARD_PAYOFF_PROJECTION_CAP_MONTHS = 600;
function projectCardPayoff(startDebt, choice){
  let debt = startDebt;
  let months = 0;
  let extraInterest = 0;
  while(debt > 0.01 && months < CARD_PAYOFF_PROJECTION_CAP_MONTHS){
    const interest = debt * CARD_MONTHLY_RATE;
    debt += interest;
    extraInterest += interest;
    const due = Math.min(choice === 'min' ? Math.max(25, debt * 0.03) : FIXED_CARD_PAYMENT, debt);
    debt -= due;
    months++;
  }
  return { months, extraInterest: Math.round(extraInterest * 100) / 100, capped: debt > 0.01 };
}

function buildPathSummary(p, results){
  const s = results[p];
  const nw = netWorth(s);
  const totalPaid = p === 'save'
    ? results.scenario.laptopPrice - s.totalInterestEarned
    : results.scenario.laptopPrice + s.totalInterestPaid + s.totalLateFees + (s.totalOverdraftFees||0);
  const cardStrategy = p === 'card' ? s.cardMonthlyChoice : undefined;
  const cardPayoff = (p === 'card' && s.debt > 0.5) ? projectCardPayoff(s.debt, cardStrategy) : null;
  return {
    pathId: p,
    pathName: PATH_META[p].name,
    isChosenPath: p === results.chosenPath,
    totalPaid: Math.round(totalPaid * 100) / 100,
    interestPaid: p === 'save' ? 0 : Math.round(s.totalInterestPaid * 100) / 100,
    interestEarned: p === 'save' ? Math.round(s.totalInterestEarned * 100) / 100 : 0,
    lateFees: Math.round((s.totalLateFees||0) * 100) / 100,
    overdraftFees: Math.round((s.totalOverdraftFees||0) * 100) / 100,
    debtRemaining: Math.round(s.debt * 100) / 100,
    backupCardDebt: Math.round((s.backupCardDebt||0) * 100) / 100,
    cashPlusSavings: Math.round((s.cash + s.savings) * 100) / 100,
    netWorth: Math.round(nw * 100) / 100,
    creditScore: displayScore(s),
    creditScoreChange: displayScore(s) - STARTING_SCORE,
    missedOrPartialPayments: s.scoreFactors.missedPayments,
    laptopOwned: s.laptopOwned,
    laptopBoughtMonth: p === 'save' ? s.laptopBoughtMonth : undefined,
    stillShortBy: p === 'save' && !s.laptopOwned ? Math.round(Math.max(0, LAPTOP_PRICE - s.savings) * 100) / 100 : 0,
    cardStrategy,
    payoffMonths: cardPayoff ? cardPayoff.months : undefined,
    payoffExtraInterest: cardPayoff ? cardPayoff.extraInterest : undefined,
    payoffCapped: cardPayoff ? cardPayoff.capped : undefined,
  };
}

// A plain-text export built from the SAME results object the on-screen
// comparison renders from (see finishGame/lastGameResults) — this is the
// concrete case a future "download" or "screenshot" feature would follow:
// pull structured data out of results.scenario and results[path], don't
// re-derive it from scenarioChoice or scrape it back out of the DOM.
function buildResultsSummaryText(results){
  const lines = [];
  lines.push('THE LEDGER — Results Summary');
  lines.push(`Scenario: ${results.scenario.recapText}`);
  lines.push(`Path played: ${PATH_META[results.chosenPath].name}`);
  lines.push('');
  ['save','loan','card'].forEach(p => {
    const summary = buildPathSummary(p, results);
    lines.push(`${summary.pathName}${summary.isChosenPath ? ' (your path)' : ''}:`);
    lines.push(`  Total paid: ${fmt(summary.totalPaid)}`);
    lines.push(`  Net worth, month 24: ${fmt(summary.netWorth)}`);
    lines.push(`  Credit score, month 24: ${summary.creditScore}`);
    lines.push('');
  });
  return lines.join('\n');
}

// A structured export meant for re-import — a future "load a past run" or
// "compare two runs" feature can read scenario + paths directly without
// re-deriving anything or parsing the plain-text report above.
function buildResultsJSON(results){
  return {
    format: 'the-ledger-results',
    version: 1,
    generatedAt: new Date().toISOString(),
    scenario: results.scenario,
    chosenPath: results.chosenPath,
    paths: {
      save: buildPathSummary('save', results),
      loan: buildPathSummary('loan', results),
      card: buildPathSummary('card', results),
    },
  };
}

function triggerJsonDownload(dataObject, filename){
  const json = JSON.stringify(dataObject, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return json;
}

document.getElementById('btn-copy-results').addEventListener('click', ()=>{
  if(!lastGameResults) return;
  const text = buildResultsSummaryText(lastGameResults);
  const btn = document.getElementById('btn-copy-results');
  const originalLabel = btn.textContent;
  const showCopied = () => { btn.textContent = '✓ Copied'; setTimeout(()=>{ btn.textContent = originalLabel; }, 1500); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(showCopied).catch(()=>{ btn.textContent = originalLabel; });
  } else {
    showCopied(); // clipboard API unavailable — text is still built correctly, just not auto-copied
  }
});

document.getElementById('btn-download-json').addEventListener('click', ()=>{
  if(!lastGameResults) return;
  const btn = document.getElementById('btn-download-json');
  const originalLabel = btn.textContent;
  const stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
  const filename = `the-ledger-${lastGameResults.scenario.priceId}-${lastGameResults.scenario.rateId}-${stamp}.json`;
  try {
    triggerJsonDownload(buildResultsJSON(lastGameResults), filename);
    btn.textContent = '✓ Downloaded';
  } catch(e) {
    btn.textContent = '✗ Download failed';
  }
  setTimeout(()=>{ btn.textContent = originalLabel; }, 1500);
});

/* ---------- Load a run: import a previously-exported JSON file ---------- */

const SUPPORTED_RESULTS_VERSIONS = [1];
let loadedRun = null; // the currently-loaded previous run, shown alongside a new one

// Checks the file is actually one of ours before trying to render anything
// from it. Returns {ok:true, data} or {ok:false, error}.
function validateLoadedRunData(data){
  if(!data || typeof data !== 'object'){
    return { ok:false, error:'That file doesn\'t look like a results export (not a JSON object).' };
  }
  if(data.format !== 'the-ledger-results'){
    return { ok:false, error:'That JSON file isn\'t a Ledger results export (missing or wrong "format" field).' };
  }
  if(typeof data.version !== 'number' || !SUPPORTED_RESULTS_VERSIONS.includes(data.version)){
    return { ok:false, error:`This file is format version ${data.version ?? '(none)'} — this build only reads version ${SUPPORTED_RESULTS_VERSIONS.join(', ')}.` };
  }
  if(!data.scenario || !data.paths || !data.paths.save || !data.paths.loan || !data.paths.card){
    return { ok:false, error:'That export is missing scenario or path data — it may be corrupted or incomplete.' };
  }
  if(!data.chosenPath || !['save','loan','card'].includes(data.chosenPath)){
    return { ok:false, error:'That export doesn\'t say which path was played — it may be corrupted.' };
  }
  return { ok:true, data };
}

function setLoadStatus(suffix, message, kind){
  const el = document.getElementById('load-status-' + suffix);
  el.textContent = message;
  el.className = 'load-status' + (kind ? ' ' + kind : '');
  // Errors need to interrupt (role="alert"); success/neutral messages use
  // <output>'s implicit polite "status" announcement, so no role override.
  if(kind === 'err') el.setAttribute('role', 'alert');
  else el.removeAttribute('role');
}

function handleLoadedFile(file, suffix){
  if(!file){ return; }
  if(file.type && file.type !== 'application/json' && !file.name.endsWith('.json')){
    setLoadStatus(suffix, '✗ Please choose a .json file.', 'err');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch(e){
      setLoadStatus(suffix, '✗ Couldn\'t parse that file as JSON.', 'err');
      return;
    }
    const result = validateLoadedRunData(parsed);
    if(!result.ok){
      setLoadStatus(suffix, '✗ ' + result.error, 'err');
      return;
    }
    loadedRun = result.data;
    setLoadStatus(suffix, `✓ Loaded: ${loadedRun.scenario.recapText}`, 'ok');
    renderLoadedRunEverywhere();
  };
  reader.onerror = () => setLoadStatus(suffix, '✗ Couldn\'t read that file.', 'err');
  reader.readAsText(file);
}

function renderLoadedRunEverywhere(){
  ['scenario','summary'].forEach(suffix => renderLoadedRunInto(suffix));
}

function renderLoadedRunInto(suffix){
  const container = document.getElementById('loaded-run-' + suffix);
  if(!loadedRun){
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  const chosenName = PATH_META[loadedRun.chosenPath].name;
  container.innerHTML = `
    <div class="eyebrow">Loaded Run <button type="button" class="loaded-run-clear" id="loaded-run-clear-${suffix}">clear</button></div>
    <h3>${loadedRun.scenario.recapText} — played ${chosenName}</h3>
    <div class="compare" id="loaded-compare-cols-${suffix}"></div>
  `;
  renderCompareColumnsFromSummaries(`loaded-compare-cols-${suffix}`, loadedRun.paths, loadedRun.chosenPath, 4);
  document.getElementById(`loaded-run-clear-${suffix}`).addEventListener('click', () => {
    loadedRun = null;
    renderLoadedRunEverywhere();
    setLoadStatus('scenario', '', '');
    setLoadStatus('summary', '', '');
  });
}

// Shared wiring for a drop zone + hidden file input pair. The "choose a
// file" button gives keyboard and touch-only users a way in — drag-and-drop
// alone would leave them stuck.
function wireLoadZone(suffix){
  const zone = document.getElementById('dropzone-' + suffix);
  const input = document.getElementById('file-input-' + suffix);

  document.getElementById('choose-file-btn-' + suffix).addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    if(input.files && input.files[0]) handleLoadedFile(input.files[0], suffix);
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if(file) handleLoadedFile(file, suffix);
  });
}

wireLoadZone('scenario');
wireLoadZone('summary');

// Pure, DOM-independent snapshot of "what conditions produced this run" —
// deliberately structured data rather than a rendered string, so any future
// export/download/screenshot feature can consume the fields it needs
// directly instead of re-deriving them from scenarioChoice or scraping text
// out of the page.
function getScenarioRecapData(){
  const price = PRICE_OPTIONS.find(o => o.id === scenarioChoice.price);
  const rate = RATE_OPTIONS.find(o => o.id === scenarioChoice.rate);
  const shockOn = scenarioChoice.shock === 'on';
  const recapText =
    `${price.label} (${fmt(LAPTOP_PRICE)}) · ${rate.label} (${(LOAN_APR*100).toFixed(1)}%/${(CARD_APR*100).toFixed(1)}% APR) · ${shockOn ? 'job-loss shock ON' : 'steady income'}`;
  return {
    priceId: scenarioChoice.price, priceLabel: price.label, laptopPrice: LAPTOP_PRICE, spareCash: SPARE_CASH,
    rateId: scenarioChoice.rate, rateLabel: rate.label, loanAPR: LOAN_APR, cardAPR: CARD_APR,
    cardLimit: CARD_LIMIT, fixedCardPayment: FIXED_CARD_PAYMENT,
    jobLossEnabled: shockOn,
    recapText,
  };
}

function renderSummaryScenarioRecap(scenario){
  document.getElementById('summary-scenario-recap').textContent = `This run: ${scenario.recapText}`;
}

let lastGameResults = null; // holds the most recently finished run's full results + scenario, for export/copy

function finishGame(){
  document.getElementById('screen-ledger').classList.add('hidden');
  document.getElementById('screen-summary').classList.remove('hidden');
  document.getElementById('summary-headline').focus();

  const results = {
    save: runFullSim('save'),
    loan: runFullSim('loan'),
    card: runFullSim('card', state.path==='card' ? state.cardMonthlyChoice : 'min')
  };
  // replace the chosen path's silent sim with the actual played-through state for accuracy
  results[state.path] = state;
  results.chosenPath = state.path;
  results.scenario = getScenarioRecapData(); // travels with the comparison data, not just shown once in the DOM

  lastGameResults = results;

  renderSummaryScenarioRecap(results.scenario);
  drawChart(results);
  drawScoreChart(results);
  renderCompare(results);
  renderFactorBreakdown(results);
  renderLesson(results);
}

function renderCompare(results){
  const summaries = {
    save: buildPathSummary('save', results),
    loan: buildPathSummary('loan', results),
    card: buildPathSummary('card', results),
  };
  renderCostCompare(summaries, results);
  renderCompareColumnsFromSummaries('compare-cols', summaries, results.chosenPath, 3);
}

// A same-scale bar per path, so "the credit card costs more" reads as a
// visibly longer bar rather than something you have to find in a table —
// plus a plain-language delta so the size of the gap is stated, not just
// implied by comparing bar lengths.
function costDeltaPhrase(otherName, otherPaid, cardPaid){
  const diff = cardPaid - otherPaid;
  if(Math.abs(diff) < 0.01) return `The Credit Card cost about the same as ${otherName}.`;
  return diff > 0
    ? `The Credit Card cost <b>${fmt(diff)} more</b> than ${otherName}.`
    : `The Credit Card cost <b>${fmt(-diff)} less</b> than ${otherName}.`;
}

// Splits each path's raw simulation state into the same three buckets —
// paid down, interest, still owed — so the three paths can stack on one
// shared scale. Save has no "interest" cost (interest earned is folded out
// of "paid" rather than stacked on top of it, since it's not extra spend —
// it's what let the saver contribute less of their own money) and its
// "still owed" bucket is really "still short of the laptop's price".
// Every path's three buckets always sum to exactly LAPTOP_PRICE for save,
// and to LAPTOP_PRICE + interest (+ fees) for loan/card — so save's bar is
// always exactly as tall as the laptop's sticker price, and anything a
// loan/card bar rises above that shared reference line is the extra cost
// of financing rather than paying cash up front.
function costBreakdown(p, s){
  if(p === 'save'){
    const totalSaved = s.laptopOwned ? LAPTOP_PRICE : s.savings;
    const interest = Math.max(0, s.totalInterestEarned);
    const paid = Math.max(0, totalSaved - interest);
    const outstanding = s.laptopOwned ? 0 : Math.max(0, LAPTOP_PRICE - s.savings);
    return { paid, interest, outstanding,
      paidLabel: 'Saved (your money)', interestLabel: 'Interest earned', outstandingLabel: 'Still short by' };
  }
  const outstanding = Math.max(0, s.debt);
  const fees = (s.totalLateFees||0) + (s.totalOverdraftFees||0);
  const interest = Math.max(0, s.totalInterestPaid) + fees;
  const paid = Math.max(0, LAPTOP_PRICE - outstanding);
  return { paid, interest, outstanding,
    paidLabel: 'Paid off', interestLabel: fees > 0.005 ? 'Interest & fees' : 'Interest', outstandingLabel: 'Still outstanding' };
}

const VBAR_CHART_HEIGHT = 200;

function renderCostCompare(summaries, results){
  const box = document.getElementById('cost-compare');
  const paths = ['save','loan','card'];
  const breakdown = {}; paths.forEach(p => { breakdown[p] = costBreakdown(p, results[p]); });
  const total = {}; paths.forEach(p => { const b = breakdown[p]; total[p] = b.paid + b.interest + b.outstanding; });

  const maxTotal = Math.max(...paths.map(p => total[p]), LAPTOP_PRICE);
  const scale = VBAR_CHART_HEIGHT / maxTotal;
  const priceLineBottom = Math.round(LAPTOP_PRICE * scale);

  const totalsRow = paths.map(p => `<div class="vbar-cell">${fmt(total[p])}</div>`).join('');

  const stacksRow = paths.map(p => {
    const b = breakdown[p];
    const paidPx = Math.max(1, Math.round(b.paid * scale));
    const interestPx = Math.round(b.interest * scale);
    const outstandingPx = Math.round(b.outstanding * scale);
    return `<div class="vbar-cell"><div class="vbar-stack">
      ${b.outstanding > 0.005 ? `<div class="vbar-seg outstanding" style="height:${outstandingPx}px" title="${b.outstandingLabel}: ${fmt(b.outstanding)}"></div>` : ''}
      ${b.interest > 0.005 ? `<div class="vbar-seg interest" style="height:${interestPx}px" title="${b.interestLabel}: ${fmt(b.interest)}"></div>` : ''}
      <div class="vbar-seg paid" style="height:${paidPx}px" title="${b.paidLabel}: ${fmt(b.paid)}"></div>
    </div></div>`;
  }).join('');

  const namesRow = paths.map(p => `<div class="vbar-cell">${PATH_META[p].name}</div>`).join('');

  const breakdownsRow = paths.map(p => {
    const b = breakdown[p];
    return `<div class="vbar-cell">${b.paidLabel}: ${fmt(b.paid)}<br>${b.interestLabel}: ${fmt(b.interest)}${b.outstanding > 0.005 ? `<br><span style="color:var(--stamp);font-weight:700;">${b.outstandingLabel}: ${fmt(b.outstanding)}</span>` : ''}</div>`;
  }).join('');

  const callout = `<p style="font-size:13px;color:#4b4636;margin:14px 0 0;line-height:1.6;">
    ${costDeltaPhrase('Save First', summaries.save.totalPaid, summaries.card.totalPaid)}<br>
    ${costDeltaPhrase('the Personal Loan', summaries.loan.totalPaid, summaries.card.totalPaid)}
  </p>`;

  box.innerHTML = `
    <div class="vbar-chart">
      <div class="vbar-row totals">${totalsRow}</div>
      <div class="vbar-row stacks" style="height:${VBAR_CHART_HEIGHT}px;">
        <div class="vbar-price-line" style="bottom:${priceLineBottom}px;"><span class="vbar-price-label">Laptop price — ${fmt(LAPTOP_PRICE)}</span></div>
        ${stacksRow}
      </div>
      <div class="vbar-row names">${namesRow}</div>
      <div class="vbar-row breakdowns">${breakdownsRow}</div>
      <div class="vbar-legend">
        <span><span class="swatch" style="background:var(--ink);"></span>Amount paid / saved</span>
        <span><span class="swatch" style="background:var(--amber);"></span>Interest</span>
        <span><span class="swatch" style="background:var(--stamp);"></span>Still outstanding / short</span>
      </div>
    </div>
    ${callout}`;
}

// Renders three comparison columns from already-summarized path data — the
// same shape buildPathSummary() produces for a live run AND the same shape
// a loaded JSON export's `paths` object already has. This is what lets a
// previously-downloaded run render here with zero adaptation.
function renderCompareColumnsFromSummaries(containerId, summaries, chosenPathId, headingLevel){
  const container = document.getElementById(containerId);
  const hTag = 'h' + (headingLevel || 3);
  container.innerHTML = '';
  ['save','loan','card'].forEach(p=>{
    const isChosenPath = p === chosenPathId;
    const col = document.createElement('div');
    col.className = 'col ' + p + (isChosenPath ? ' chosen':'');
    col.innerHTML = buildCompareColumnHtml(summaries[p], p, isChosenPath, hTag);
    container.appendChild(col);
  });
}

function lateFeesRowHtml(sum, isDebtPath){
  if(!isDebtPath || sum.lateFees <= 0) return '';
  return `<div class="row"><span>Late fees charged</span><span class="v">${fmt(sum.lateFees)}</span></div>`;
}

function overdraftFeesRowHtml(sum, isDebtPath){
  if(!isDebtPath || sum.overdraftFees <= 0) return '';
  return `<div class="row"><span>Overdraft fees charged</span><span class="v">${fmt(sum.overdraftFees)}</span></div>`;
}

function backupCardRowHtml(sum, isDebtPath){
  if(!isDebtPath || sum.backupCardDebt <= 0.5) return '';
  return `<div class="row"><span>— of which, backup card</span><span class="v">${fmt(sum.backupCardDebt)}</span></div>`;
}

function missedRowHtml(sum, isDebtPath){
  if(!isDebtPath) return '';
  const missedColor = sum.missedOrPartialPayments > 0 ? '#A63D40' : 'inherit';
  return `<div class="row"><span>Payments missed/partial</span><span class="v" style="color:${missedColor};">${sum.missedOrPartialPayments}</span></div>`;
}

// Save First never has a real debt remaining balance, so it doesn't get its
// own "Not yet" row here — see secondStatRowHtml, which shows this instead
// of the debt row for that path.
function laptopBoughtRowHtml(sum){
  if(sum.laptopOwned){
    return `<div class="row"><span>Laptop bought</span><span class="v">Month ${sum.laptopBoughtMonth}</span></div>`;
  }
  return `<div class="row"><span style="color:var(--stamp);font-weight:700;">Laptop bought</span><span class="v" style="color:var(--stamp);font-weight:800;font-size:15px;">Not yet — ${fmt(sum.stillShortBy)} short</span></div>`;
}

// For Save First, "Debt remaining" is always a meaningless £0.00 — that slot
// in the table instead shows the one thing unique to this path: which month
// the laptop actually got bought, or (same red/bold treatment as an
// outstanding balance elsewhere) how much you're still short if it never did
// within the 24 months.
function secondStatRowHtml(sum, p, totalDebt){
  if(p === 'save') return laptopBoughtRowHtml(sum);
  const debtStandsOut = totalDebt > 0.5;
  const labelStyle = debtStandsOut ? ' style="color:var(--stamp);font-weight:700;"' : '';
  const valueStyle = debtStandsOut ? ' style="color:var(--stamp);font-weight:800;font-size:15px;"' : '';
  return `<div class="row"><span${labelStyle}>Debt remaining, mo. 24</span><span class="v"${valueStyle}>${fmt(totalDebt)}</span></div>`;
}

function payoffNoteHtml(sum, p){
  if(p !== 'card' || !sum.payoffMonths) return '';
  if(sum.payoffCapped){
    return `<div class="ladder-note">At this payment rate, the balance would take decades to clear — the payments barely outpace the interest.</div>`;
  }
  const monthWord = sum.payoffMonths === 1 ? 'month' : 'months';
  return `<div class="ladder-note">At this payment rate, clearing the rest would take about <b style="color:var(--stamp);">${sum.payoffMonths} more ${monthWord}</b> — roughly <b style="color:var(--stamp);">${fmt(sum.payoffExtraInterest)}</b> more in interest.</div>`;
}

function interestRowHtml(sum, p){
  const label = p === 'save' ? 'Interest earned' : 'Interest paid';
  const value = p === 'save' ? sum.interestEarned : sum.interestPaid;
  return `<div class="row"><span>${label}</span><span class="v">${fmt(value)}</span></div>`;
}

function scoreRowHtml(sum, band, scoreChange){
  const changeColor = scoreChange >= 0 ? '#2F6F4E' : '#A63D40';
  const changeSign = scoreChange >= 0 ? '+' : '';
  return `<div class="row" style="border-bottom:none;font-weight:600;">
        <span>Credit score, mo. 24</span>
        <span class="v">${sum.creditScore} <span class="score-pill" style="background:${band.color};">${band.label}</span>
        <span style="font-weight:400;color:${changeColor};">${changeSign}${scoreChange}</span></span>
      </div>`;
}

// One column's worth of rows — pulled out of the forEach above (and split
// into the small row-builders above) so the many "only show this row if
// it's relevant to this path" conditionals each carry their own cognitive
// complexity budget instead of stacking onto one giant function.
function buildCompareColumnHtml(sum, p, isChosenPath, hTag){
  const band = scoreBand(sum.creditScore);
  const scoreChange = sum.creditScoreChange;
  const totalDebt = sum.debtRemaining + (sum.backupCardDebt||0);
  const isDebtPath = p !== 'save';

  return `
      <${hTag} class="col-heading">${sum.pathName}${isChosenPath?' · played this run':''}</${hTag}>
      <div class="row"><span>What your laptop really cost you</span><span class="v">${fmt(sum.totalPaid)}</span></div>
      ${interestRowHtml(sum, p)}
      ${lateFeesRowHtml(sum, isDebtPath)}
      ${overdraftFeesRowHtml(sum, isDebtPath)}
      ${secondStatRowHtml(sum, p, totalDebt)}
      ${backupCardRowHtml(sum, isDebtPath)}
      ${payoffNoteHtml(sum, p)}
      <div class="row"><span>Cash + savings, mo. 24</span><span class="v">${fmt(sum.cashPlusSavings)}</span></div>
      <div class="row"><span>Net worth, mo. 24</span><span class="v">${fmt(sum.netWorth)}</span></div>
      ${missedRowHtml(sum, isDebtPath)}
      ${scoreRowHtml(sum, band, scoreChange)}
    `;
}

function bar(labelText, pct, color, note){
  const p = Math.max(0, Math.min(100, pct));
  return `<div class="factor-row">
    <div class="label">${labelText}</div>
    <div class="factor-track"><div class="factor-fill" style="width:${p}%;background:${color};"></div></div>
    <div class="pct">${note !== undefined ? note : Math.round(p)+'%'}</div>
  </div>`;
}

function onTimeTierColor(onTimePct){
  if(onTimePct >= 95) return 'var(--score-verygood)';
  if(onTimePct >= 80) return 'var(--score-fair)';
  return 'var(--score-poor)';
}

function utilizationTierColor(avgUtil){
  if(avgUtil <= 30) return 'var(--score-verygood)';
  if(avgUtil <= 50) return 'var(--score-fair)';
  return 'var(--score-poor)';
}

function renderSaveFactorBreakdown(s){
  const change = displayScore(s) - STARTING_SCORE;
  const sign = change >= 0 ? '+' : '';
  let html = `<p style="font-size:13px;color:#4b4636;margin:6px 0 10px;">You never opened a new credit account, so there's no inquiry, no utilization, and nothing to miss a payment on. Your score barely moved — it's not a reward for saving, just the absence of any new risk.</p>`;
  html += bar('Net movement', 50, 'var(--score-good)', `${sign}${change} pts`);
  return html;
}

function missedPaymentsWarningHtml(f){
  if(f.missedPayments <= 0) return '';
  const plural = f.missedPayments > 1 ? 's' : '';
  return `<div style="background:#f6dcdc;border:1.5px solid var(--stamp);padding:10px 12px;margin-bottom:12px;font-size:13px;color:#5a1f1f;">
        <b>⚠ ${f.missedPayments} payment${plural} missed.</b> This is the single heaviest factor in the model — worth more, per event, than months of utilization or on-time payments combined. Missed payments also leave a mark that keeps dampening how fast the score can recover afterward.
      </div>`;
}

function utilizationOrInstallmentNoteHtml(f){
  if(state.path === 'card'){
    const avgUtil = f.utilizationCount ? (f.utilizationSum/f.utilizationCount*100) : 0;
    return bar('Avg. credit utilization', avgUtil, utilizationTierColor(avgUtil));
  }
  return `<p style="font-size:12.5px;color:#4b4636;margin:6px 0;">Installment loans (like this one) don't carry a utilization ratio the way revolving credit cards do — the balance is expected to go down on a fixed schedule.</p>`;
}

function renderDebtFactorBreakdown(f){
  const onTimePct = f.paymentTotalMonths ? (f.paymentOnTimeMonths/f.paymentTotalMonths*100) : 100;
  let html = missedPaymentsWarningHtml(f);
  html += bar('Payment history (on-time months)', onTimePct, onTimeTierColor(onTimePct));
  html += utilizationOrInstallmentNoteHtml(f);
  html += bar('New credit / inquiry impact', 100, 'var(--ink)', '-8 pts, month 1');
  if(f.debtClearedBonusGiven){
    html += bar('Paid off in full', 100, 'var(--score-verygood)', '+15 pts');
  }
  return html;
}

function renderFactorBreakdown(results){
  const box = document.getElementById('factor-box');
  const s = results[state.path];
  const f = s.scoreFactors;

  let html = `<div class="eyebrow" style="margin-bottom:4px;">Why your score moved — ${PATH_META[state.path].name}</div>`;
  html += state.path === 'save' ? renderSaveFactorBreakdown(s) : renderDebtFactorBreakdown(f);
  box.innerHTML = html;
}

function saveLessonIntroHtml(save){
  return `You waited, but you paid the least. Saving cost you <b>time</b> — the laptop only arrived once you'd fully funded it — and in exchange you <b>earned</b> ${fmt(save.totalInterestEarned)} in interest instead of paying it. That's the trade-off of saving: patience now, in exchange for money kept later.`;
}

function loanLessonIntroHtml(loan, save){
  let html = `A personal loan got you the laptop immediately, but you paid <b>${fmt(loan.totalInterestPaid)}</b> in interest for that convenience — the price of borrowing at a fixed, predictable rate. Compare that to saving first: you paid ${fmt(loan.totalInterestPaid + save.totalInterestEarned)} more, total, than the saver did, just to have the laptop 24 months sooner.`;
  if(loan.scoreFactors.missedPayments > 0){
    const plural = loan.scoreFactors.missedPayments > 1 ? 's' : '';
    html += ` Along the way, you missed ${loan.scoreFactors.missedPayments} installment${plural} — the fixed payment is the same every month whether or not your cash flow can absorb it, and when it can't, the loan doesn't bend.`;
  }
  return html;
}

function cardLessonIntroHtml(card){
  const chosenLabel = state.cardMonthlyChoice === 'min' ? 'minimum payments' : 'a disciplined fixed payment';
  let html = `You used ${chosenLabel} on the card. Credit cards carry a much higher rate (${(CARD_APR*100).toFixed(1)}% APR here, vs ${(LOAN_APR*100).toFixed(1)}% for the loan) — and minimum payments are designed to stretch debt out for years while interest compounds on top of interest. You paid <b>${fmt(card.totalInterestPaid)}</b> in interest`;
  html += card.debt > 0
    ? `, and still owe <b>${fmt(card.debt)}</b> at month 24 — the debt outlived the laptop's warranty.`
    : `.`;
  if(state.cardMonthlyChoice === 'min'){
    html += ` Notice also what happened when an unplanned expense hit: with no savings cushion, it went straight onto the card, growing the balance further. That's the credit-card trap — it doesn't just cost more, it makes emergencies more expensive too.`;
  } else if(card.scoreFactors.missedPayments > 0){
    html += ` Notice the trade-off: paying more than the minimum shrinks the balance faster, but it also leaves a thinner cash cushion — and when an expense hit a stretched budget, a payment got skipped entirely. Minimum payments are "safer" for your cash flow precisely because they demand so little of it; that ease is exactly what makes them a trap over the long run.`;
  }
  return html;
}

function lessonIntroHtml(results){
  if(state.path === 'save') return saveLessonIntroHtml(results.save);
  if(state.path === 'loan') return loanLessonIntroHtml(results.loan, results.save);
  return cardLessonIntroHtml(results.card);
}

function missedPaymentNoteHtml(s){
  if(s.scoreFactors.missedPayments <= 0) return '';
  const worstPenalty = missedPaymentPenalty(1);
  return ` A missed or partial payment alone cost as much as ${Math.abs(worstPenalty)} points in a single month — more than the entire card path's utilization swing typically does across the whole two years.`;
}

function overdraftNoteHtml(s){
  if(s.totalOverdraftFees <= 0) return '';
  const times = Math.round(s.totalOverdraftFees/OVERDRAFT_FEE);
  const plural = s.totalOverdraftFees > OVERDRAFT_FEE ? 's' : '';
  return ` You used overdraft ${times} time${plural} to keep a payment on time — it protected your score (overdrafts aren't reported to credit bureaus), but cost ${fmt(s.totalOverdraftFees)} in bank fees and left cash tighter for the months after.`;
}

function backupCardDebtNoteHtml(s){
  if(s.backupCardDebt <= 0.5) return '';
  return ` You also ended the game carrying <b>${fmt(s.backupCardDebt)}</b> on a backup card that was never modeled as being paid down — a reminder that "cover it with a different card" doesn't make a cost disappear, it just moves it somewhere higher-interest and easier to lose track of.`;
}

function saveScoreClosingHtml(scoreChange){
  const sign = scoreChange >= 0 ? '+' : '';
  return ` Your credit score barely moved (${sign}${scoreChange} pts) — saving doesn't build credit history, it just avoids putting any at risk.`;
}

function loanScoreClosingHtml(scoreNow, scoreChange){
  const sign = scoreChange >= 0 ? '+' : '';
  return ` Your credit score ended at <b>${scoreNow}</b> (${sign}${scoreChange} from where you started) — a small inquiry dip up front, recovered and then some through 24 straight on-time payments and paying the loan off in full.`;
}

function cardScoreClosingHtml(scoreNow, scoreChange){
  const sign = scoreChange >= 0 ? '+' : '';
  const strategyNote = state.cardMonthlyChoice === 'min'
    ? 'Minimum payments kept utilization high for most of the two years, which is the single biggest drag here.'
    : 'Paying more than the minimum brought utilization down faster, which is what let the score recover.';
  return ` Your credit score ended at <b>${scoreNow}</b> (${sign}${scoreChange}) — driven mostly by how high your balance sat relative to your £${CARD_LIMIT.toLocaleString()} limit each month. ${strategyNote}`;
}

function scoreClosingHtml(scoreNow, scoreChange){
  if(state.path === 'save') return saveScoreClosingHtml(scoreChange);
  if(state.path === 'loan') return loanScoreClosingHtml(scoreNow, scoreChange);
  return cardScoreClosingHtml(scoreNow, scoreChange);
}

function renderLesson(results){
  const box = document.getElementById('lesson-box');
  const s = results[state.path];
  const best = Object.entries(results).sort((a,b)=> netWorth(b[1]) - netWorth(a[1]))[0][0];

  let html = lessonIntroHtml(results);
  html += missedPaymentNoteHtml(s);
  html += overdraftNoteHtml(s);
  html += backupCardDebtNoteHtml(s);

  const scoreNow = displayScore(s);
  const scoreChange = scoreNow - STARTING_SCORE;
  html += scoreClosingHtml(scoreNow, scoreChange);

  html += `<br><br>Across all three paths this run, <b>${PATH_META[best].name}</b> left you with the highest net worth at month 24: ${fmt(netWorth(results[best]))}.`;
  box.innerHTML = html;
}

/* ---------- chart ---------- */
function drawChart(results){
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const saveBoughtNote = results.save.laptopOwned
    ? ` Save First fully saved the cash price and bought the laptop in month ${results.save.laptopBoughtMonth}.`
    : ` Save First had not fully saved the laptop's cash price by month ${MONTHS}.`;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Net worth over ${MONTHS} months. Final net worth — ` +
    ['save','loan','card'].map(p => {
      const hist = results[p].history;
      return `${PATH_META[p].name}: ${fmt(hist[hist.length-1].netWorth)}`;
    }).join(', ') + '.' + saveBoughtNote + ' See the comparison table below for full figures.');

  const allVals = [];
  ['save','loan','card'].forEach(p=> results[p].history.forEach(pt=>allVals.push(pt.netWorth)));
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(...allVals, LAPTOP_PRICE);
  const pad = {l:60,r:20,t:16,b:26};
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  function x(m){ return pad.l + (m/MONTHS)*plotW; }
  function y(v){ return pad.t + plotH - ((v-minV)/(maxV-minV))*plotH; }

  // zero line
  ctx.strokeStyle = '#c9bfa1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, y(0));
  ctx.lineTo(w-pad.r, y(0));
  ctx.stroke();
  ctx.fillStyle = '#6b6350';
  ctx.font = '11px IBM Plex Mono, monospace';
  ctx.fillText('£0', 6, y(0)+4);
  ctx.fillText(fmt(maxV), 6, y(maxV)+4);
  ctx.fillText(fmt(minV), 6, y(minV)+4);

  ['save','loan','card'].forEach(p=>{
    ctx.strokeStyle = PATH_META[p].color;
    ctx.lineWidth = p===state.path ? 3 : 2;
    ctx.globalAlpha = p===state.path ? 1 : 0.55;
    ctx.beginPath();
    results[p].history.forEach((pt,i)=>{
      const px = x(pt.month), py = y(pt.netWorth);
      if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    });
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // Mark the exact month the laptop was actually bought while saving — the
  // save line bends here (a lump sum leaves savings for the purchase), so
  // calling out the month directly beats making someone trace pixels to
  // guess it. Only drawn once the cash price was actually fully saved up.
  const boughtMonth = results.save.laptopBoughtMonth;
  const boughtPoint = boughtMonth != null ? results.save.history.find(pt => pt.month === boughtMonth) : null;
  if(results.save.laptopOwned && boughtPoint){
    const bx = x(boughtMonth), by = y(boughtPoint.netWorth);
    ctx.globalAlpha = state.path === 'save' ? 1 : 0.55;

    ctx.strokeStyle = '#c9bfa1';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.beginPath();
    ctx.moveTo(bx, pad.t);
    ctx.lineTo(bx, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = PATH_META.save.color;
    ctx.beginPath();
    ctx.arc(bx, by, 4, 0, Math.PI*2);
    ctx.fill();

    ctx.font = 'bold 11px IBM Plex Mono, monospace';
    const label = `Saved & bought · mo. ${boughtMonth}`;
    const labelW = ctx.measureText(label).width;
    // Keep the label inside the plot area — flip it to the left of the
    // guide line if it would otherwise run off the right edge.
    const labelX = Math.min(bx + 6, w - pad.r - labelW);
    ctx.fillText(label, labelX, pad.t + 10);
    ctx.globalAlpha = 1;
  }

  // x axis labels
  ctx.fillStyle = '#6b6350';
  for(let m=0;m<=MONTHS;m+=6){
    ctx.fillText('mo '+m, x(m)-10, h-6);
  }
}

function drawScoreChart(results){
  const canvas = document.getElementById('chart-score');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Credit score over ${MONTHS} months, starting at ${STARTING_SCORE}. Final score — ` +
    ['save','loan','card'].map(p => {
      const hist = results[p].creditHistory;
      return `${PATH_META[p].name}: ${hist[hist.length-1].score}`;
    }).join(', ') + '.');

  const allVals = [];
  ['save','loan','card'].forEach(p=> results[p].creditHistory.forEach(pt=>allVals.push(pt.score)));
  const minV = Math.max(300, Math.min(...allVals) - 15);
  const maxV = Math.min(850, Math.max(...allVals, STARTING_SCORE) + 15);
  const pad = {l:60,r:20,t:16,b:26};
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  function x(m){ return pad.l + (m/MONTHS)*plotW; }
  function y(v){ return pad.t + plotH - ((v-minV)/(maxV-minV))*plotH; }

  // starting-score reference line
  ctx.strokeStyle = '#c9bfa1';
  ctx.lineWidth = 1;
  ctx.setLineDash([4,3]);
  ctx.beginPath();
  ctx.moveTo(pad.l, y(STARTING_SCORE));
  ctx.lineTo(w-pad.r, y(STARTING_SCORE));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#6b6350';
  ctx.font = '11px IBM Plex Mono, monospace';
  ctx.fillText('start '+STARTING_SCORE, 6, y(STARTING_SCORE)+4);
  ctx.fillText(Math.round(maxV), 6, y(maxV)+4);
  ctx.fillText(Math.round(minV), 6, y(minV)+4);

  ['save','loan','card'].forEach(p=>{
    ctx.strokeStyle = PATH_META[p].color;
    ctx.lineWidth = p===state.path ? 3 : 2;
    ctx.globalAlpha = p===state.path ? 1 : 0.55;
    ctx.beginPath();
    results[p].creditHistory.forEach((pt,i)=>{
      const px = x(pt.month), py = y(pt.score);
      if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    });
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#6b6350';
  for(let m=0;m<=MONTHS;m+=6){
    ctx.fillText('mo '+m, x(m)-10, h-6);
  }
}
