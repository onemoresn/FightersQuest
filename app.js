const STORAGE_KEY = 'fighterQuestState_v1';

console.log('app.js loading');

// Recovery tick interval (ms) used by the recovery ticker and missed-recovery catch-up.
// User-request: fire 1 increment every 0.03 seconds => interval 30ms
const RECOVER_INTERVAL_MS = 30;
// Throttle persistence from the regen loop to avoid excessive writes at high tick rates
const RECOVER_SAVE_THROTTLE_MS = 1000;

const defaultState = {
  // Start user at level 1 and reset most values to zero as requested
  level: 1,
  job: 'None',
  title: '',
  hp: {cur: 0, max: 0},
  mp: {cur: 0, max: 0},
  stamina: { cur: 0, max: 100 },
  xp: {cur: 0, toNext: 100},
  stats: {str:0, agi:0, per:0, vit:0, int:0},
  available: 0,
  // inventory holds items the player owns
  inventory: [],
  // learned skills / magic
  skills: [],
  // equipped items (by slot)
  equipment: {},
  // track which guides the user has seen per screen
  seenGuides: {},
  taskBase: {
    dailyJumpingJacks: 25,
    weeklyPushups: 25,
    weeklySquats: 25,
    weeklySitups: 25
  },
  tasks: {
    daily: {completed:false},
    weeklyPush: {completed:false},
    weeklySquat: {completed:false},
    weeklySit: {completed:false}
  },
  
  // which challenge categories are unlocked
  unlockedCategories: {
    'Fighting Skills': false
  },
  // progression upgrade flags
  upgrades: {
    weeklyPushups50: false,
    dailyJumpingJacks50: false
  }
}

// Start with defaults; we'll load persisted state asynchronously at init
let state = Object.assign({}, defaultState);

// Storage adapter: choose best available storage depending on environment
const storageAdapter = (function(){
  // Capacitor Storage plugin
  const hasCapacitor = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Storage;
  // Cordova/other native could be supported here as needed
  const hasLocalStorage = (function(){ try{ return typeof localStorage !== 'undefined' && localStorage !== null; }catch(e){ return false; }})();

  // Try to request persistent storage on supporting browsers
  if(typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist){
    try{ navigator.storage.persist(); }catch(e){}
  }

  if(hasCapacitor){
    const cap = window.Capacitor.Plugins.Storage;
    return {
      async getItem(key){
        try{ const res = await cap.get({key}); return (res && res.value) ? res.value : null; }catch(e){ console.warn('Capacitor Storage get failed', e); return null; }
      },
      async setItem(key, val){
        try{ await cap.set({key, value: String(val)}); }catch(e){ console.warn('Capacitor Storage set failed', e); }
      },
      async removeItem(key){
        try{ await cap.remove({key}); }catch(e){ console.warn('Capacitor Storage remove failed', e); }
      }
    };
  }

  if(hasLocalStorage){
    return {
      async getItem(key){ try{ return localStorage.getItem(key); }catch(e){ console.warn('localStorage getItem failed', e); return null; } },
      async setItem(key, val){ try{ localStorage.setItem(key, String(val)); }catch(e){ console.warn('localStorage setItem failed', e); } },
      async removeItem(key){ try{ localStorage.removeItem(key); }catch(e){ console.warn('localStorage removeItem failed', e); } }
    };
  }

  // Fallback in-memory (non-persistent)
  const mem = {};
  return {
    async getItem(key){ return mem.hasOwnProperty(key) ? mem[key] : null; },
    async setItem(key, val){ mem[key] = String(val); },
    async removeItem(key){ delete mem[key]; }
  };
})();

// Initialize state from storage (async). Called during DOMContentLoaded.
async function initState(){
  try{
    const raw = await storageAdapter.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      // ensure avatar field exists if migrated stores include it
      if(parsed && parsed.avatar && typeof parsed.avatar === 'string'){
        // leave as-is
      }
      // migrate older numeric stamina into {cur,max}
      if(parsed.hasOwnProperty('stamina')){
        if(typeof parsed.stamina === 'number'){
          parsed.stamina = { cur: Math.max(0, Math.min(100, Number(parsed.stamina || 0))), max: 100 };
        } else if(parsed.stamina && typeof parsed.stamina.cur === 'number' && !parsed.stamina.max){
          parsed.stamina.max = 100;
        }
      }
      state = Object.assign({}, defaultState, parsed);
    } else {
      state = Object.assign({}, defaultState);
    }
  }catch(e){
    console.warn('initState load failed, using defaults', e);
    state = Object.assign({}, defaultState);
  }
  // ensure computed fields
  if(!state.xp || !state.xp.toNext) state.xp = { cur: (state.xp && state.xp.cur) || 0, toNext: xpToLevelUp(state.level) };
  ensureHPMPForState();
  // ensure newer task keys exist even when loading older saves
  try{ ensureTasksShape(); }catch(e){ console.warn('ensureTasksShape failed', e); }
  // ensure challenge completion date map exists for daily challenges
  try{ if(!state.challengeCompletionDate || typeof state.challengeCompletionDate !== 'object') state.challengeCompletionDate = {}; }catch(e){}
  // ensure challenge completion week map exists for weekly challenges
  try{ if(!state.challengeCompletionWeek || typeof state.challengeCompletionWeek !== 'object') state.challengeCompletionWeek = {}; }catch(e){}
  // ensure upgrades flags exist
  try{ state.upgrades = state.upgrades || { weeklyPushups50:false, dailyJumpingJacks50:false }; }catch(e){}
}

// ensure challenges mapping exists
if(!state.challenges) state.challenges = {};

// Ensure HP/MP maxima and current values are initialized so bars display full on first load
function ensureHPMPForState(){
  if(!state.hp || !state.hp.max || state.hp.max <= 0){
    state.hp = state.hp || {cur:0,max:0};
    state.hp.max = computeHPMax(state.level || 1);
    state.hp.cur = state.hp.max;
  }
  if(!state.mp || !state.mp.max || state.mp.max <= 0){
    state.mp = state.mp || {cur:0,max:0};
    state.mp.max = computeMPMax(state.level || 1);
    state.mp.cur = state.mp.max;
  }
  // Ensure stamina is a cur/max resource like HP/MP (default max 100)
  if(!state.stamina || typeof state.stamina !== 'object'){
    const raw = Number(state.stamina || 0);
    state.stamina = { cur: Math.max(0, Math.min(100, raw)), max: 100 };
  }
  if(typeof state.stamina.max !== 'number') state.stamina.max = 100;
  if(typeof state.stamina.cur !== 'number') state.stamina.cur = Math.max(0, Math.min(state.stamina.max, Number(state.stamina) || 0));
  // Ensure a title is present based on current level
  try{ if(!state.title || typeof state.title !== 'string' || state.title.trim() === '') state.title = computeTitleForLevel(state.level); }catch(e){ console.warn('computeTitleForLevel init failed', e); }
}

// HP/MP scaling helpers: Level 1 => HP 100, MP 50
function computeHPMax(level){
  const lv = Math.max(1, Number(level) || 1);
  // Base HP 100 at level 1, +10 HP per additional level
  return 100 + (lv - 1) * 10;
}

function computeMPMax(level){
  const lv = Math.max(1, Number(level) || 1);
  // Base MP 50 at level 1, +5 MP per additional level
  return 50 + (lv - 1) * 5;
}

// Apply stat growth and related recalculations for a given level
function applyStatsForLevel(level){
  const lv = Math.max(1, Number(level) || 1);
  // small stat growth example (kept from previous logic)
  state.stats.str = 30 + Math.floor(lv * 1.0);
  state.stats.agi = 15 + Math.floor(lv * 0.65);
  state.stats.per = 12 + Math.floor(lv * 0.8);
  state.stats.vit = 14 + Math.floor(lv * 0.8);
  state.stats.int = 12 + Math.floor(lv * 0.75);
  // available points behavior retained from previous demo logic
  state.available = Math.max(0, 20 - Math.floor(lv / 2));
  // recompute HP/MP maxima for level and ensure current values do not exceed new maxima
  state.hp.max = computeHPMax(lv);
  state.mp.max = computeMPMax(lv);
  state.hp.cur = Math.min(state.hp.cur || state.hp.max, state.hp.max);
  state.mp.cur = Math.min(state.mp.cur || state.mp.max, state.mp.max);
}

// Get effective stats including equipment bonuses
function getEffectiveStats(){
  const base = Object.assign({}, state.stats || {});
  const equip = state.equipment || {};
  const eff = Object.assign({}, base);
  try{
    Object.keys(equip).forEach(slot=>{
      const item = equip[slot];
      if(!item) return;
      // item.bonuses expected to be an object like { str: 2, vit: 1 }
      const bonuses = item.bonuses || item.stats || {};
      Object.keys(bonuses).forEach(k=>{
        const val = Number(bonuses[k] || 0);
        eff[k] = (eff[k] || 0) + val;
      });
    });
  }catch(e){ console.warn('getEffectiveStats failed to accumulate equipment bonuses', e); }
  return eff;
}

function getEffectiveStat(key){
  const eff = getEffectiveStats();
  if(!eff) return (state.stats && state.stats[key]) || 0;
  return typeof eff[key] === 'number' ? eff[key] : ((state.stats && state.stats[key]) || 0);
}

function showRecoveryPopup(type, amount, targetEl){
  try{
    const div = document.createElement('div');
    div.className = 'recovery-popup ' + (type === 'hp' ? 'hp' : type === 'mp' ? 'mp' : 'stam');
    // For stamina, amount may be positive (recovery) or negative (spent)
    let label = '';
    if(type === 'hp') label = `+${amount} HP`;
    else if(type === 'mp') label = `+${amount} MP`;
    else {
      if(Number(amount) >= 0) label = `+${amount} STA`;
      else label = `-${Math.abs(amount)} STA`;
    }
    div.textContent = label;
    document.body.appendChild(div);
    // position near targetEl (clamped to viewport so popup isn't cut off)
    const padding = 8; // px from edge of viewport
    if(targetEl){
      const r = targetEl.getBoundingClientRect();
      // desired center x above the element
      let leftPx = r.left + r.width / 2;
      let topPx = r.top - 10;
      // measure popup size (offsetWidth will be available after append)
      const bw = div.offsetWidth || 120;
      const bh = div.offsetHeight || 28;
      // ensure horizontally within viewport
      if(leftPx - bw/2 < padding) leftPx = bw/2 + padding;
      if(leftPx + bw/2 > window.innerWidth - padding) leftPx = window.innerWidth - bw/2 - padding;
      // if there's no room above the element, position below it instead
      if(topPx < padding) topPx = r.bottom + 10;
      // clamp vertical as well
      if(topPx + bh > window.innerHeight - padding) topPx = Math.max(padding, window.innerHeight - bh - padding);
      div.style.left = leftPx + 'px';
      div.style.top = topPx + 'px';
    } else {
      div.style.left = '50%';
      div.style.top = '20%';
    }
    requestAnimationFrame(()=> div.classList.add('show'));
    setTimeout(()=>{ try{ document.body.removeChild(div); }catch(e){} }, 1000);
  }catch(e){console.warn('showRecoveryPopup failed', e)}
}

// Show a brief congratulatory popup when the player levels up
function showLevelUpPopup(level){
  try{
    const div = document.createElement('div');
    div.className = 'ability-popup';
    div.textContent = `Level Up! You reached Level ${level}`;
    document.body.appendChild(div);
    requestAnimationFrame(()=>div.classList.add('show'));
    setTimeout(()=>{ try{ div.classList.remove('show'); setTimeout(()=>div.remove(),400); }catch(e){} }, 2200);
  }catch(e){ console.warn('showLevelUpPopup failed', e); }
}

// show a brief unlock popup for new categories
function showUnlockPopup(category){
  try{
    const div = document.createElement('div');
    div.className = 'ability-popup';
    div.textContent = `Congratulations — you've unlocked the "${category}" category!`;
    document.body.appendChild(div);
    requestAnimationFrame(()=>div.classList.add('show'));
    setTimeout(()=>{ try{ div.classList.remove('show'); setTimeout(()=>div.remove(),400); }catch(e){} }, 2400);
  }catch(e){console.warn('showUnlockPopup failed', e)}
}

// generic notice popup using the same animation style as ability popup
function showNoticePopup(message){
  try{
    const div = document.createElement('div');
    div.className = 'ability-popup';
    div.textContent = message;
    document.body.appendChild(div);
    requestAnimationFrame(()=>div.classList.add('show'));
    setTimeout(()=>{ try{ div.classList.remove('show'); setTimeout(()=>div.remove(),400); }catch(e){} }, 2000);
  }catch(e){ console.warn('showNoticePopup failed', e); }
}

function processRecoverySinceLastCheck(){
  const now = Date.now();
  const last = state.recoveryLast || now;
  const delta = Math.max(0, now - last);
  if(delta < RECOVER_INTERVAL_MS){
    // nothing to catch up
    state.recoveryLast = last;
    return;
  }
  const ticks = Math.floor(delta / RECOVER_INTERVAL_MS);
  if(ticks > 0){
    applyRecoveryTick(ticks);
    state.recoveryLast = last + ticks * RECOVER_INTERVAL_MS;
  }
}

function startRecoveryTicker(){
  // run periodic recovery while the page is visible
  setInterval(()=>{
    if(document.hidden) return;
    try{ applyRecoveryTick(1); }catch(e){ console.warn('applyRecoveryTick error', e); }
  }, RECOVER_INTERVAL_MS);
}

// Apply recovery for HP/MP/Stamina. `ticks` is number of intervals to apply.
function applyRecoveryTick(ticks){
  if(!ticks || ticks <= 0) return;
  // Ensure state shapes
  state.hp = state.hp || { cur: 0, max: computeHPMax(state.level || 1) };
  state.mp = state.mp || { cur: 0, max: computeMPMax(state.level || 1) };
  state.stamina = state.stamina || { cur: 0, max: 100 };
  const prev = { hp: state.hp.cur, mp: state.mp.cur, stam: state.stamina.cur };

  // Use fractional buffers so very small intervals (e.g. 30ms) accumulate correctly
  state._regenBuffer = state._regenBuffer || { hp: 0, mp: 0, stam: 0 };
  // Original design used percentages applied every 10000ms (10s):
  // HP: 0.5% of max per 10s, MP: 1% per 10s, Stamina: 2% per 10s.
  const scaleFactor = (ticks * RECOVER_INTERVAL_MS) / 10000; // fraction of the original 10s window
  // Recover 1 whole unit per second for each resource (use fractional buffer for sub-second ticks)
  const seconds = (ticks * RECOVER_INTERVAL_MS) / 1000; // seconds covered by these ticks
  // Each resource gains 1 unit every 0.5s -> 2 units per second
  const hpFraction = 2 * seconds;   // HP: +2 per second (fractional accumulation)
  const mpFraction = 2 * seconds;   // MP: +2 per second
  const stamFraction = 2 * seconds; // Stamina: +2 per second
  state._regenBuffer.hp += hpFraction;
  state._regenBuffer.mp += mpFraction;
  state._regenBuffer.stam += stamFraction;
  // Apply only whole units to avoid fractional health values; keep remainder in buffer
  const addHp = Math.floor(state._regenBuffer.hp);
  const addMp = Math.floor(state._regenBuffer.mp);
  const addStam = Math.floor(state._regenBuffer.stam);
  if(addHp > 0){ state.hp.cur = Math.min(state.hp.max || 0, (state.hp.cur || 0) + addHp); state._regenBuffer.hp -= addHp; }
  if(addMp > 0){ state.mp.cur = Math.min(state.mp.max || 0, (state.mp.cur || 0) + addMp); state._regenBuffer.mp -= addMp; }
  if(addStam > 0){ state.stamina.cur = Math.min(state.stamina.max || 0, (state.stamina.cur || 0) + addStam); state._regenBuffer.stam -= addStam; }

  // Only show small recovery popups if there was actual recovery
  try{
    if(Math.round(state.hp.cur) > Math.round(prev.hp)) showRecoveryPopup('hp', Math.round(state.hp.cur - prev.hp), document.getElementById('hp-text'));
    if(Math.round(state.mp.cur) > Math.round(prev.mp)) showRecoveryPopup('mp', Math.round(state.mp.cur - prev.mp), document.getElementById('mp-text'));
    if(Math.round(state.stamina.cur) > Math.round(prev.stam)) showRecoveryPopup('stam', Math.round(state.stamina.cur - prev.stam), document.getElementById('stam-text'));
  }catch(e){/* ignore popup errors */}

  // persist and refresh UI
  try{
    const nowSave = Date.now();
    const didWholeChange = (addHp > 0) || (addMp > 0) || (addStam > 0);
    state._regenSaveLast = state._regenSaveLast || 0;
    if(didWholeChange || (nowSave - state._regenSaveLast >= RECOVER_SAVE_THROTTLE_MS)){
      try{ saveState(); state._regenSaveLast = nowSave; }catch(e){ console.warn('saveState failed during applyRecoveryTick', e); }
    }
  }catch(e){ console.warn('saveState throttle logic failed', e); }
  try{ render(); }catch(e){}
}

// --- Stat popup on level-up ---
function showStatPopup(deltas){
  try{
    const entries = Object.keys(deltas).filter(k=>deltas[k] > 0);
    if(entries.length === 0) return;
    const div = document.createElement('div');
    div.className = 'stat-popup';
    // build content like "+2 STR  +1 VIT"
    entries.forEach((k,i)=>{
      const span = document.createElement('span');
      span.className = 'item';
      span.innerHTML = `<span class="val">+${deltas[k]}</span><span class="key">${k.toUpperCase()}</span>`;
      div.appendChild(span);
    });
    document.body.appendChild(div);
    // position near level-number
    const el = document.getElementById('level-number');
    if(el){
      const r = el.getBoundingClientRect();
      div.style.left = (r.left + r.width/2) + 'px';
      div.style.top = (r.top - 12) + 'px';
    }else{
      // fallback center
      div.style.left = '50%';
      div.style.top = '12%';
    }
    // animate
    requestAnimationFrame(()=>div.classList.add('show'));
    setTimeout(()=>{ try{ document.body.removeChild(div); }catch(e){} }, 1400);
  }catch(e){console.warn('stat popup failed', e)}
}

ensureHPMPForState();

// Ensure tasks/unlockedTasks objects have all expected keys from defaults
function ensureTasksShape(){
  try{
    state.tasks = state.tasks || {};
    const defaults = defaultState.tasks || {};
    Object.keys(defaults).forEach(k=>{
      const defVal = defaults[k];
      if(typeof state.tasks[k] !== 'object' || state.tasks[k] === null){
        state.tasks[k] = (typeof defVal === 'object' && defVal !== null) ? Object.assign({}, defVal) : { completed: false };
      } else {
        if(!('completed' in state.tasks[k])) state.tasks[k].completed = !!(defVal && defVal.completed);
      }
    });
  }catch(e){ console.warn('ensureTasksShape internal error', e); }
}

// Helpers for daily challenge expiration
function todayKey(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function expireDailyChallenges(){
  try{
    const now = Date.now();
    const last = state._lastDailyExpiryCheck || 0;
    if(now - last < 10000) return; // throttle to every 10s max
    state._lastDailyExpiryCheck = now;
    const today = todayKey();
    let changed = false;
    state.challenges = state.challenges || {};
    state.challengeCompletionDate = state.challengeCompletionDate || {};
    DAILY_CHALLENGE_IDS.forEach((id)=>{
      if(state.challenges[id]){
        const doneDay = state.challengeCompletionDate[id];
        // If no timestamp or day changed, expire
        if(!doneDay || doneDay !== today){
          state.challenges[id] = false;
          delete state.challengeCompletionDate[id];
          changed = true;
        }
      }
    });
    if(changed){ try{ saveState(); }catch(e){ console.warn('saveState failed in expireDailyChallenges', e); } }
  }catch(e){ console.warn('expireDailyChallenges error', e); }
}

function weekKey(){
  // Return a stable key for the current week by using the Monday date (YYYY-MM-DD)
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday=0..Sunday=6
  const monday = new Date(d);
  monday.setHours(0,0,0,0);
  monday.setDate(monday.getDate() - day);
  const y = monday.getFullYear();
  const m = String(monday.getMonth()+1).padStart(2,'0');
  const da = String(monday.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

function expireWeeklyChallenges(){
  try{
    const now = Date.now();
    const last = state._lastWeeklyExpiryCheck || 0;
    if(now - last < 10000) return; // throttle every 10s
    state._lastWeeklyExpiryCheck = now;
    const wk = weekKey();
    let changed = false;
    state.challenges = state.challenges || {};
    state.challengeCompletionWeek = state.challengeCompletionWeek || {};
    WEEKLY_CHALLENGE_IDS.forEach((id)=>{
      if(state.challenges[id]){
        const doneWeek = state.challengeCompletionWeek[id];
        if(!doneWeek || doneWeek !== wk){
          state.challenges[id] = false;
          delete state.challengeCompletionWeek[id];
          changed = true;
        }
      }
    });
    if(changed){ try{ saveState(); }catch(e){ console.warn('saveState failed in expireWeeklyChallenges', e); } }
  }catch(e){ console.warn('expireWeeklyChallenges error', e); }
}

// Apply progression-based upgrades when conditions are met
function checkProgressionUpgrades(context){
  try{
    state.upgrades = state.upgrades || { weeklyPushups50:false, dailyJumpingJacks50:false };
    // Upgrade weekly push-ups base to 50 when: level >= 10 AND 50 push-ups (daily) completed today
    if(!state.upgrades.weeklyPushups50){
      const hasLv = (state.level || 1) >= 10;
      const didC1 = !!(state.challenges && state.challenges['c1']);
      const today = todayKey();
      const doneToday = state.challengeCompletionDate && state.challengeCompletionDate['c1'] === today;
      if(hasLv && didC1 && doneToday){
        state.taskBase = state.taskBase || {};
        state.taskBase.weeklyPushups = 50;
        state.upgrades.weeklyPushups50 = true;
        try{ saveState(); }catch(e){}
        try{ showNoticePopup('Weekly Push-ups increased to 50'); }catch(e){}
      }
    }
    // Upgrade daily jumping jacks base to 50 when: level >= 10 AND 1 mile run completed
    if(!state.upgrades.dailyJumpingJacks50){
      const hasLv = (state.level || 1) >= 10;
      const didMile = !!(state.challenges && state.challenges['c34']); // 1 mile run
      if(hasLv && didMile){
        state.taskBase = state.taskBase || {};
        state.taskBase.dailyJumpingJacks = 50;
        state.upgrades.dailyJumpingJacks50 = true;
        try{ saveState(); }catch(e){}
        try{ showNoticePopup('Daily Jumping Jacks increased to 50'); }catch(e){}
      }
    }
  }catch(e){ console.warn('checkProgressionUpgrades error', e); }
}

function tieredRequirement(base, level){
  // Tiered scaling: every 5 levels increases requirement by 10%
  const tiers = Math.floor((level - 1) / 5);
  const multiplier = 1 + 0.10 * tiers;
  return Math.max(1, Math.ceil(base * multiplier));
}

// Map numeric level into a human-friendly Title category
function computeTitleForLevel(level){
  const lv = Math.max(1, Number(level) || 1);
  if(lv <= 10) return 'Rookie';
  if(lv <= 20) return 'Novice';
  if(lv <= 30) return 'Skilled';
  if(lv <= 40) return 'Experienced';
  if(lv <= 60) return 'Veteran';
  if(lv <= 80) return 'Expert';
  if(lv <= 120) return 'Elite';
  if(lv <= 200) return 'Champion';
  if(lv <= 350) return 'Master';
  if(lv <= 599) return 'Grandmaster';
  if(lv <= 799) return 'Mythic';
  if(lv <= 949) return 'Ascendant';
  if(lv <= 998) return 'Exalted';
  return 'Legendary'; // 999+
}

// Compute a rank index (0-based) matching the title bands used in computeTitleForLevel
function computeRankIndex(level){
  const lv = Math.max(1, Number(level) || 1);
  if(lv <= 10) return 0; // Rookie
  if(lv <= 20) return 1; // Novice
  if(lv <= 30) return 2; // Skilled
  if(lv <= 40) return 3; // Experienced
  if(lv <= 60) return 4; // Veteran
  if(lv <= 80) return 5; // Expert
  if(lv <= 120) return 6; // Elite
  if(lv <= 200) return 7; // Champion
  if(lv <= 350) return 8; // Master
  if(lv <= 599) return 9; // Grandmaster
  if(lv <= 799) return 10; // Mythic
  if(lv <= 949) return 11; // Ascendant
  if(lv <= 998) return 12; // Exalted
  return 13; // Legendary
}

// Weekly bonus: increase weekly activities by 72 per rank index
function computeWeeklyBonus(level){
  const idx = computeRankIndex(level);
  return idx * 72;
}

// Determine daily task amount and activity by level ranges
function computeDailyTaskForLevel(level){
  const lv = Math.max(1, Number(level) || 1);
  // Default values (fallback)
  let amount = state.taskBase && state.taskBase.dailyJumpingJacks ? state.taskBase.dailyJumpingJacks : 25;
  let activity = 'jumping jacks';

  if(lv >= 1 && lv <= 10){
    // respect upgraded base if applied
    amount = (state.taskBase && typeof state.taskBase.dailyJumpingJacks === 'number') ? state.taskBase.dailyJumpingJacks : 25;
    activity = 'jumping jacks';
  } else if(lv >= 21 && lv <= 30){
    amount = 50; activity = 'jumping jacks';
  } else if(lv >= 61 && lv <= 599){
    amount = 25; activity = 'High knees';
  } else if(lv >= 600){
    amount = 25; activity = 'Burpees';
  } else {
    // for levels not explicitly covered, fall back to tiered requirement but keep 'jumping jacks'
    amount = tieredRequirement(state.taskBase && state.taskBase.dailyJumpingJacks ? state.taskBase.dailyJumpingJacks : 25, lv);
    activity = 'jumping jacks';
  }
  return { amount, activity };
}

// XP required to reach the next level. Uses a base value and scales with level,
// applying modest growth and extra tier scaling every 5 levels.
function xpToLevelUp(level){
  const lv = Math.max(1, Number(level) || 1);
  const base = 100; // XP needed at level 1
  // linear growth per level plus small exponential-ish factor
  const linear = base + (lv - 1) * 50;
  // tier bonus every 5 levels
  const tiers = Math.floor((lv - 1) / 5);
  const tierMultiplier = 1 + tiers * 0.10;
  return Math.max(10, Math.ceil(linear * tierMultiplier));
}

// --- Challenges & Quests data ---
// Daily-resettable challenges (must be completed within the same day)
const DAILY_CHALLENGE_IDS = new Set(['c1','c4']); // 50 push-ups, 50 sit-ups
// Weekly-resettable challenges (must be completed within the same week)
const WEEKLY_CHALLENGE_IDS = new Set(['c2','c3']); // 100 and 150 push-ups
const CHALLENGES = [
  // Strength
  {id:'c1', label:'50 push-ups (Complete Today)', type:'pushups', amount:50, xp:60, category: 'Strength'},
  {id:'c2', label:'100 push-ups (Complete This Week)', type:'pushups', amount:100, xp:120, category: 'Strength'},
  {id:'c3', label:'150 push-ups (Complete This Week)', type:'pushups', amount:150, xp:200, category: 'Strength'},
  {id:'c4', label:'50 sit-ups (Complete Today)', type:'situps', amount:50, xp:50, category: 'Strength'},
  {id:'c5', label:'100 sit-ups', type:'situps', amount:100, xp:110, category: 'Strength'},
  // Cardio (samples)
  {id:'c6', label:'2 km Run', type:'run', amount:2, xp:80, category: 'Cardio'},
  {id:'c7', label:'200 Jumping Jacks', type:'jumpingjacks', amount:200, xp:60, category: 'Cardio'},
  {id:'c8', label:'30-minute Cycling', type:'cycling', amount:30, xp:100, category: 'Cardio'},
  // New Cardio challenge
  {id:'c34', label:'1 mile Run', type:'run_mile', amount:1, xp:90, category: 'Cardio'},
  // Flexibility (samples)
  {id:'c9', label:'15 min Yoga Stretch', type:'yoga', amount:15, xp:50, category: 'Flexibility'},
  {id:'c10', label:'Hold Plank 2 min', type:'plank', amount:2, xp:70, category: 'Flexibility'},
  // Fighting Skills (replaced with user-requested drill list)
  {id:'c11', label:'Switch between Orthodox and Southpaw - 20x', type:'stance_switch', amount:20, xp:40, category: 'Fighting Skills'},
  {id:'c12', label:'Left Jab - 20x', type:'jab_left', amount:20, xp:40, category: 'Fighting Skills'},
  {id:'c13', label:'Right Jab - 20x', type:'jab_right', amount:20, xp:40, category: 'Fighting Skills'},
  {id:'c14', label:'Left Hook - 20x', type:'hook_left', amount:20, xp:45, category: 'Fighting Skills'},
  {id:'c15', label:'Right Hook - 20x', type:'hook_right', amount:20, xp:45, category: 'Fighting Skills'},
  {id:'c16', label:'Left Uppercut - 20x', type:'upper_left', amount:20, xp:50, category: 'Fighting Skills'},
  {id:'c17', label:'Right Uppercut - 20x', type:'upper_right', amount:20, xp:50, category: 'Fighting Skills'},

  {id:'c18', label:'Switch between Orthodox and Southpaw - 50x', type:'stance_switch', amount:50, xp:100, category: 'Fighting Skills'},
  {id:'c19', label:'Left Jab - 50x', type:'jab_left', amount:50, xp:100, category: 'Fighting Skills'},
  {id:'c20', label:'Right Jab - 50x', type:'jab_right', amount:50, xp:100, category: 'Fighting Skills'},
  {id:'c21', label:'Left Hook - 50x', type:'hook_left', amount:50, xp:110, category: 'Fighting Skills'},
  {id:'c22', label:'Right Hook - 50x', type:'hook_right', amount:50, xp:110, category: 'Fighting Skills'},
  {id:'c23', label:'Left Uppercut - 50x', type:'upper_left', amount:50, xp:120, category: 'Fighting Skills'},
  {id:'c24', label:'Right Uppercut - 50x', type:'upper_right', amount:50, xp:120, category: 'Fighting Skills'},

  {id:'c25', label:'Switch between Orthodox and Southpaw - 100x', type:'stance_switch', amount:100, xp:200, category: 'Fighting Skills'},
  {id:'c26', label:'Left Jab - 100x', type:'jab_left', amount:100, xp:200, category: 'Fighting Skills'},
  {id:'c27', label:'Right Jab - 100x', type:'jab_right', amount:100, xp:200, category: 'Fighting Skills'},
  {id:'c28', label:'Left Hook - 100x', type:'hook_left', amount:100, xp:220, category: 'Fighting Skills'},
  {id:'c29', label:'Right Hook - 100x', type:'hook_right', amount:100, xp:220, category: 'Fighting Skills'},
  {id:'c30', label:'Left Uppercut - 100x', type:'upper_left', amount:100, xp:240, category: 'Fighting Skills'},
  {id:'c31', label:'Right Uppercut - 100x', type:'upper_right', amount:100, xp:240, category: 'Fighting Skills'}
];

// Append daily variants for 100 and 150 push-ups
CHALLENGES.push(
  {id:'c32', label:'100 push-ups (Complete Today)', type:'pushups', amount:100, xp:120, category: 'Strength'},
  {id:'c33', label:'150 push-ups (Complete Today)', type:'pushups', amount:150, xp:200, category: 'Strength'}
);
// add to daily reset set
DAILY_CHALLENGE_IDS.add('c32');
DAILY_CHALLENGE_IDS.add('c33');

// Pagination for challenge lists
const CHALLENGES_PER_PAGE = 5;
let challengesPage = 0; // current page index for the active challenges tab

// UI state: currently selected challenges tab
let challengesTab = 'Strength';

// Skill / Magic pool
const SKILL_POOL = [
  { id: 's_fireball', name: 'Fireball', type: 'magic', desc: 'Deal moderate fire damage to an enemy.', rarity: 'common', icon: '🔥' },
  { id: 's_heal', name: 'Minor Heal', type: 'magic', desc: 'Restore a small amount of HP.', rarity: 'common', icon: '✨' },
  { id: 's_barrier', name: 'Stone Barrier', type: 'skill', desc: 'Temporarily reduce incoming damage.', rarity: 'rare', icon: '🪨' },
  { id: 's_berserk', name: 'Berserk', type: 'skill', desc: 'Increase STR for a few turns.', rarity: 'rare', icon: '💥' },
  { id: 's_megaheal', name: 'Greater Heal', type: 'magic', desc: 'Restore significant HP.', rarity: 'epic', icon: '💫' },
  { id: 's_lightning', name: 'Chain Lightning', type: 'magic', desc: 'Strike multiple enemies with lightning.', rarity: 'epic', icon: '⚡' }
];

// chance to learn on task vs challenge (challenge is higher)
function rollLearnSkill(context){
  try{
    const chance = (context === 'challenge') ? 0.30 : 0.08; // challenge 30%, task 8%
    if(Math.random() > chance) return null;
    // pick by weighted rarity: epic rarer
    const roll = Math.random();
    let pool = SKILL_POOL.filter(s=>true);
    if(roll < 0.05) pool = pool.filter(s=>s.rarity === 'epic');
    else if(roll < 0.25) pool = pool.filter(s=>s.rarity !== 'common');
    // fallback to whole pool if filter empties
    if(!pool || pool.length === 0) pool = SKILL_POOL;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if(!pick) return null;
    // don't add duplicates
    state.skills = state.skills || [];
    if(state.skills.find(s=>s.id === pick.id)) return null;
    learnSkill(pick);
    return pick;
  }catch(e){ console.warn('rollLearnSkill failed', e); return null; }
}

function learnSkill(skill){
  if(!skill || !skill.id) return;
  state.skills = state.skills || [];
  state.skills.push(Object.assign({}, skill));
  try{ saveState(); }catch(e){ console.warn('saveState failed after learnSkill', e); }
  try{ showSkillPopup(skill); }catch(e){}
  try{ renderSkillsPanel(); }catch(e){}
}

function showSkillPopup(skill){
  try{
    const div = document.createElement('div');
    div.className = 'xp-popup';
    div.textContent = `Learned: ${skill.name}`;
    document.body.appendChild(div);
    requestAnimationFrame(()=>div.classList.add('show'));
    setTimeout(()=>{ try{ document.body.removeChild(div); }catch(e){} }, 1800);
  }catch(e){console.warn('showSkillPopup failed', e)}
}

// Generate a list of quests/enemies programmatically so we can scale up to N entries
function generateQuests(count){
  const templates = [
    {baseName:'Wild Wolf', tag:'wolf'},
    {baseName:'Bandit Scout', tag:'bandit'},
    {baseName:'Orc Brute', tag:'orc'},
    {baseName:'Goblin', tag:'goblin'},
    {baseName:'Skeleton', tag:'skeleton'},
    {baseName:'Dire Bear', tag:'bear'},
    {baseName:'Stone Golem', tag:'golem'},
    {baseName:'Dark Mage', tag:'mage'},
    {baseName:'Rogue Assassin', tag:'assassin'},
    {baseName:'Slime', tag:'slime'}
  ];
  const out = [];
  for(let i=0;i<count;i++){
    const id = 'q' + (i+1);
    // pick a template rotating through templates to get variety
    const t = templates[i % templates.length];
    // create a numeric suffix for higher indices to vary names
    const suffix = Math.floor(i / templates.length) > 0 ? ' ' + (Math.floor(i / templates.length) + 1) : '';
    const name = t.baseName + suffix;
    // scale level roughly by index so enemies grow in level across the list
    const level = Math.max(1, Math.round(1 + i * 0.25 + (i % 3)));
    const reward = Math.max(5, Math.round(level * 10 + (i % 7)));
    const stamina = Math.max(3, Math.round(level * 1.2));
    out.push({ id, name, level, reward, stamina, type: t.tag || t.baseName.toLowerCase() });
  }
  return out;
}

// Default QUESTS: generate 100 enemies (can be adjusted)
const QUESTS = generateQuests(100);

// Generate dungeons: each dungeon contains multiple monsters
function generateDungeons(count, perDungeon){
  const names = ['Forsaken Ruins','Shadow Keep','Mossy Cavern','Blight Hollow','Crimson Vault','Frostfell Lair','Sundered Mines','Obsidian Deep','Sunken Temple','Iron Bastion','Gloomfen','Thunder Reach','Ember Maw','Silent Halls','Whispering Tunnels','Grim Passage','Twisted Grove','Ancient Sepulcher','Stormwatch','Verdant Hollow'];
  const templates = ['Wolf','Bandit','Orc','Goblin','Skeleton','Bear','Golem','Mage','Assassin','Slime','Spider','Wraith','Elemental','Cultist','Berserker','Drake','Troll','Ghoul','Imp','Knight'];
  const out = [];
  for(let i=0;i<count;i++){
    const id = 'd' + (i+1);
    const name = names[i % names.length] || ('Dungeon ' + (i+1));
    const difficulty = Math.max(1, 1 + Math.floor(i * 0.6)); // difficulty increases across dungeons
    const monsters = [];
    for(let m=0;m<perDungeon;m++){
      const mid = id + '-m' + (m+1);
      const t = templates[(i + m) % templates.length];
      const type = String(t).toLowerCase();
      const level = Math.max(1, Math.round(difficulty + (m % 5) - 1 + Math.floor(Math.random()*3)));
      const reward = Math.max(5, Math.round(level * 8 + (m % 7)));
      monsters.push({ id: mid, name: `${t} ${m+1}`, level, reward, stamina: Math.max(10, Math.round(level * 1.2)), type });
    }
    out.push({ id, name, difficulty, monsters });
  }
  return out;
}

// create 20 dungeons with 20 monsters each, and append high-level endgame dungeons up to level 999
const baseDungeons = generateDungeons(20, 20);

// generate endgame dungeons that scale monster levels up to `maxLevel`
function generateEndgameDungeons(count, perDungeon, maxLevel){
  const names = ['Abyssal Depths','Eternal Spire','Void Citadel','Celestial Rift','Oblivion Gate','Titanforge','Nexus of Sorrow','Shattered Throne','Eclipse Bastion','Crown of Ash'];
  const out = [];
  const minStart = 100; // starting monster level for endgame series
  for(let i=0;i<count;i++){
    const id = 'eg' + (i+1);
    const name = names[i % names.length] + (i>0? ' ' + (i+1): '');
    // linearly scale base level from minStart to maxLevel across count
    const baseLevel = Math.round(minStart + ((i)/(Math.max(1,count-1))) * (maxLevel - minStart));
    const monsters = [];
    for(let m=0;m<perDungeon;m++){
      const mid = id + '-m' + (m+1);
      // add small per-monster variance but cap at maxLevel
      let level = Math.min(maxLevel, Math.max(1, baseLevel + Math.floor((m - perDungeon/2) + (Math.random()*8 - 4)) ));
      // ensure monotonic increase somewhat by adding dungeon difficulty influence
      const reward = Math.max(50, Math.round(level * 12));
      const type = 'abyssal';
      monsters.push({ id: mid, name: `Abyssal ${m+1}`, level, reward, stamina: Math.max(20, Math.round(level * 1.2)), type });
    }
    out.push({ id, name, difficulty: baseLevel, monsters });
  }
  return out;
}

const endgame = generateEndgameDungeons(10, 20, 999);
const DUNGEONS = baseDungeons.concat(endgame);

// Pagination constants for dungeons (reuse QUESTS_PER_PAGE behavior)
const DUNGEONS_PER_PAGE = 5;
let dungeonsPage = 0;

function getDungeonsTotalPages(){ return Math.max(1, Math.ceil((DUNGEONS && DUNGEONS.length) ? DUNGEONS.length / DUNGEONS_PER_PAGE : 1)); }

function changeDungeonsPage(delta){
  const total = getDungeonsTotalPages();
  dungeonsPage = Math.max(0, Math.min(total - 1, dungeonsPage + delta));
  renderQuests();
}

// Pagination for quest list
const QUESTS_PER_PAGE = 5;
let questsPage = 0; // zero-based

function getQuestsTotalPages(){
  return Math.max(1, Math.ceil((QUESTS && QUESTS.length) ? QUESTS.length / QUESTS_PER_PAGE : 1));
}

function changeQuestsPage(delta){
  // Previously used for QUESTS; now change dungeon page instead
  changeDungeonsPage(delta);
}

// Returns a portrait/icon for a quest so the same symbol is used across screens
function getPortraitForQuest(q){
  if(!q) return '👾';
  // prefer explicit type field
  const t = (q.type || q.tag || q.name || '').toString().toLowerCase();
  if(/wolf/.test(t)) return '🐺';
  if(/bandit|scout/.test(t)) return '🪓';
  if(/orc/.test(t)) return '👹';
  if(/goblin/.test(t)) return '👺';
  if(/skeleton|ghoul/.test(t)) return '💀';
  if(/bear/.test(t)) return '🐻';
  if(/golem|stone|iron/.test(t)) return '🪨';
  if(/mage|dark|elemental/.test(t)) return '🪄';
  if(/assassin|rogue/.test(t)) return '🗡️';
  if(/slime|slime/.test(t)) return '🟢';
  if(/drake|dragon|wyrm/.test(t)) return '🐉';
  if(/imp|wraith/.test(t)) return '👻';
  return '👾';
}
function showScreen(id){
  // hide all screens (use both class and inline style to be robust)
  document.querySelectorAll('.screen').forEach(s=>{ s.classList.add('hidden'); s.style.display = 'none'; });
  const el = document.getElementById(id);
  if(el){ el.classList.remove('hidden'); el.style.display = 'block'; }
  // nav active states
  document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.remove('active'));
  const btn = document.querySelector(`.bottom-nav button[data-screen="${id}"]`);
  if(btn) btn.classList.add('active');
  // small visible breadcrumb to confirm screen change (helps debug when content invisible)
  const bread = document.getElementById('screen-breadcrumb');
  if(bread) bread.textContent = id.replace('screen-','').toUpperCase();
  // show contextual guide for this screen if the user hasn't dismissed it
  try{ showGuide(id); }catch(e){ console.warn('showGuide failed', e); }
}

// Create and show a small dismissible guide box for a given screen id
function showGuide(screenId){
  if(!screenId) return;
  state.seenGuides = state.seenGuides || {};
  if(state.seenGuides[screenId]) return; // already dismissed

  const texts = {
    'screen-stats': 'Status: shows your current level, HP/MP, Stamina, and core stats. Complete activities to earn XP and increase stats.',
    'screen-tasks': 'Tasks: complete Daily and Weekly tasks to earn XP. Use "Reset Day" and "Reset Week" to reset task progress.',
    'screen-challenges': 'Challenges: larger challenges grant more XP. Tap a challenge to complete it and gain its reward.',
    'screen-quests': 'Quests: fight opponents to earn XP. Battles consume MP and Stamina and may cause HP loss; manage resources wisely.'
  };

  const container = document.getElementById(screenId);
  if(!container) return;
  // place guide inside the first .status-card in the screen for visual context
  const target = container.querySelector('.status-card') || container;
  // avoid creating duplicate guides for the same screen
  try{
    if(target.querySelector && target.querySelector('.user-guide')) return;
  }catch(e){}
  const box = document.createElement('div');
  box.className = 'user-guide';
  box.setAttribute('data-screen', screenId);
  const title = document.createElement('div');
  title.className = 'user-guide-title';
  title.textContent = 'Guide';
  const body = document.createElement('div');
  body.className = 'user-guide-body';
  body.textContent = texts[screenId] || 'This screen contains helpful information.';
  const actions = document.createElement('div');
  actions.className = 'user-guide-actions';
  const btnClose = document.createElement('button');
  btnClose.className = 'user-guide-close';
  btnClose.textContent = 'Got it';
  btnClose.addEventListener('click', ()=>{
    try{
      state.seenGuides[screenId] = true;
      saveState();
    }catch(e){console.warn('saveState failed on guide close', e)}
    try{ box.classList.add('hide'); setTimeout(()=>box.remove(),260); }catch(e){}
  });
  actions.appendChild(btnClose);
  box.appendChild(title);
  box.appendChild(body);
  box.appendChild(actions);
  target.appendChild(box);
  // small show animation
  requestAnimationFrame(()=>box.classList.add('show'));
}

function renderChallenges(){
  const wrap = document.getElementById('challenges-list');
  if(!wrap) return;
  try{
    // expire daily challenges if the day changed
    try{ expireDailyChallenges(); }catch(e){ console.warn('expireDailyChallenges failed', e); }
    // expire weekly challenges if the week changed
    try{ expireWeeklyChallenges(); }catch(e){ console.warn('expireWeeklyChallenges failed', e); }
    // Tabbed challenges view
    wrap.innerHTML = '';
    const tabs = document.createElement('div'); tabs.className = 'challenge-tabs';
    // Build categories list; hide 'Fighting Skills' until unlocked or player reaches level 5
    const cats = ['Strength'];
    if(state.level >= 10 || (state.unlockedCategories && state.unlockedCategories['Fighting Skills'])){
      cats.push('Fighting Skills');
    }
    cats.push('Cardio','Flexibility');
    // mapping for icons and classes per category
    const catMeta = {
      'Strength': { icon: '🏋️', cls: 'tab-strength' },
      'Fighting Skills': { icon: '🥊', cls: 'tab-fighting' },
      'Cardio': { icon: '🏃', cls: 'tab-cardio' },
      'Flexibility': { icon: '🧘', cls: 'tab-flexibility' }
    };
    cats.forEach(cat=>{
      const tb = document.createElement('button'); tb.type='button'; tb.className = 'tab-button';
      const meta = catMeta[cat] || {};
      if(meta.cls) tb.classList.add(meta.cls);
      const iconHtml = meta.icon ? `<span class="tab-icon">${meta.icon}</span>` : '';
      tb.innerHTML = `${iconHtml}<span class="tab-label">${cat}</span>`;
      if(challengesTab === cat) tb.classList.add('active');
      tb.addEventListener('click', ()=>{ challengesTab = cat; challengesPage = 0; renderChallenges(); });
      tabs.appendChild(tb);
    });
    // Ensure the selected tab exists in the current cats list
    if(!cats.includes(challengesTab)) challengesTab = 'Strength';
    wrap.appendChild(tabs);
    // content area for selected tab
    const content = document.createElement('div'); content.className = 'challenge-tab-content';
    // Build list for the active tab. For 'Fighting Skills', hide items already completed by the user.
    let list = CHALLENGES.filter(c=> (c.category || 'Uncategorized') === challengesTab);
    if(challengesTab === 'Fighting Skills'){
      list = list.filter(ch => !(state.challenges && state.challenges[ch.id]));
    }
    if(list.length === 0){ const p = document.createElement('div'); p.className = 'req-item'; p.textContent = 'No challenges in this category.'; content.appendChild(p); }
    else {
      // paginate the list
      const totalPages = Math.max(1, Math.ceil(list.length / CHALLENGES_PER_PAGE));
      if(challengesPage < 0) challengesPage = 0;
      if(challengesPage > totalPages - 1) challengesPage = totalPages - 1;
      const start = challengesPage * CHALLENGES_PER_PAGE;
      const end = Math.min(list.length, start + CHALLENGES_PER_PAGE);
      const pageItems = list.slice(start, end);
      const listWrap = document.createElement('div'); listWrap.className = 'challenge-list';
      pageItems.forEach(ch=>{
        const done = !!(state.challenges && state.challenges[ch.id]);
        const div = document.createElement('div'); div.className = 'challenge';
        const btn = document.createElement('button'); btn.className = 'task-btn'; btn.type='button'; btn.dataset.id = ch.id; btn.dataset.xp = ch.xp;
        btn.innerHTML = `<span class="task-main">${ch.label} — ${ch.amount}</span><span class="task-check">✓</span>`;
        if(done) btn.classList.add('completed'); btn.disabled = !!done;
        btn.addEventListener('click', ()=>{
          state.challenges = state.challenges || {}; state.challenges[ch.id] = true;
          // store completion date for daily-resettable challenges
          if(DAILY_CHALLENGE_IDS.has(ch.id)){
            state.challengeCompletionDate = state.challengeCompletionDate || {};
            state.challengeCompletionDate[ch.id] = todayKey();
          }
          // store completion week for weekly-resettable challenges
          if(WEEKLY_CHALLENGE_IDS.has(ch.id)){
            state.challengeCompletionWeek = state.challengeCompletionWeek || {};
            state.challengeCompletionWeek[ch.id] = weekKey();
          }
          try{ showXPPopup(ch.xp); }catch(e){}
          try{ grantXP(ch.xp); }catch(e){}
          try{ saveState(); }catch(e){}
          try{ rollLearnSkill('challenge'); }catch(e){}
          try{ checkProgressionUpgrades('challenge'); }catch(e){ console.warn('checkProgressionUpgrades after challenge failed', e); }
          try{ renderChallenges(); }catch(e){}
        });
        div.appendChild(btn); listWrap.appendChild(div);
      });
      content.appendChild(listWrap);
      // pager
      const pager = document.createElement('div'); pager.className = 'challenge-pager';
      const prev = document.createElement('button'); prev.type='button'; prev.textContent='Prev';
      const next = document.createElement('button'); next.type='button'; next.textContent='Next';
      const indicator = document.createElement('span'); indicator.className = 'page-indicator'; indicator.textContent = `${challengesPage + 1} / ${totalPages}`;
      prev.disabled = (challengesPage <= 0);
      next.disabled = (challengesPage >= totalPages - 1);
      prev.addEventListener('click', ()=>{ if(challengesPage > 0) { challengesPage--; renderChallenges(); } });
      next.addEventListener('click', ()=>{ if(challengesPage < totalPages - 1) { challengesPage++; renderChallenges(); } });
      pager.appendChild(prev); pager.appendChild(indicator); pager.appendChild(next);
      content.appendChild(pager);
    }
    wrap.appendChild(content);
  }catch(e){
    console.warn('renderChallenges failed', e);
    try{
      // fallback grouped static HTML
      const cats = ['Strength'];
      if(state.level >= 10 || (state.unlockedCategories && state.unlockedCategories['Fighting Skills'])) cats.push('Fighting Skills');
      cats.push('Cardio','Flexibility');
      wrap.innerHTML = cats.map(cat=>{
        let items = CHALLENGES.filter(c=> (c.category||'Uncategorized') === cat);
        // For fallback rendering, also hide completed Fighting Skills challenges
        if(cat === 'Fighting Skills') items = items.filter(ch => !(state.challenges && state.challenges[ch.id]));
        const html = items.map(ch=>`<div class="challenge"><button class="task-btn" data-id="${ch.id}" data-xp="${ch.xp}"><span class="task-main">${ch.label} — ${ch.amount}</span><span class="task-check">✓</span></button></div>`).join('');
        return `<div class="req-header">${cat}</div>${html}`;
      }).join('');
    }catch(e2){ console.warn('renderChallenges fallback also failed', e2); }
  }
}

function renderQuests(){
  const wrap = document.getElementById('quests-list'); if(!wrap) return;
  wrap.innerHTML = '';
  const total = getDungeonsTotalPages();
  // clamp page
  if(dungeonsPage < 0) dungeonsPage = 0;
  if(dungeonsPage > total - 1) dungeonsPage = total - 1;
  const start = dungeonsPage * DUNGEONS_PER_PAGE;
  const end = Math.min(DUNGEONS.length, start + DUNGEONS_PER_PAGE);
  const slice = DUNGEONS.slice(start, end);
  slice.forEach(d=>{
    const div = document.createElement('div'); div.className = 'dungeon-card';
    div.innerHTML = `
      <div class="dungeon-left">
        <div class="dungeon-title">${d.name}</div>
        <div class="dungeon-meta">Difficulty: ${d.difficulty} — Monsters: ${d.monsters.length}</div>
      </div>
      <div class="dungeon-actions"><button class="enter-dungeon" data-id="${d.id}">Enter</button></div>
    `;
    const btn = div.querySelector('button.enter-dungeon'); if(btn) btn.addEventListener('click', ()=>startDungeon(d));
    // add legendary badge for very high-level dungeons (max monster level > 700)
    try{
      const maxLv = Math.max.apply(null, d.monsters.map(m=>m.level || 0));
      if(maxLv > 700){
        const left = div.querySelector('.dungeon-left');
        if(left){
          const badge = document.createElement('span'); badge.className = 'dungeon-badge legendary'; badge.textContent = 'LEGENDARY';
          left.appendChild(badge);
        }
      }
    }catch(e){/* ignore */}
    wrap.appendChild(div);
  });
  // update pager display
  try{
    const pageEl = document.getElementById('quests-page');
    const prev = document.getElementById('quests-prev');
    const next = document.getElementById('quests-next');
    if(pageEl) pageEl.textContent = `${dungeonsPage + 1} / ${total}`;
    if(prev) prev.disabled = (dungeonsPage <= 0);
    if(next) next.disabled = (dungeonsPage >= total - 1);
  }catch(e){/* ignore */}
}

// --- Turn-based battle system (multi-turn UI) ---
let battleState = null; // holds current battle session
let currentDungeon = null;

function startBattle(quest){
  // initialize battle state with copies (enemy current = max)
  const enemyHPMax = Math.max(24, quest.level * 30);
  const enemyMPMax = Math.max(8, Math.floor(quest.level * 3));
  battleState = {
    questRef: quest,
    enemy: {
      id: quest.id,
      name: quest.name,
      level: quest.level || 1,
      hp: { cur: enemyHPMax, max: enemyHPMax },
      mp: { cur: enemyMPMax, max: enemyMPMax },
      stam: { cur: 100, max: 100 },
      vit: Math.max(1, Math.floor((quest.level || 1) * 1.0)),
      str: Math.max(1, Math.floor((quest.level || 1) * 1.2))
    },
    player: {
      hp: { cur: state.hp.cur || 0, max: state.hp.max || 0 },
      mp: { cur: state.mp.cur || 0, max: state.mp.max || 0 },
      stam: { cur: (state.stamina && state.stamina.cur) || 0, max: (state.stamina && state.stamina.max) || 100 }
    },
    playerDefending: false,
    log: []
  };
  // set the portrait in the battle UI to match the quest card
  try{
    const ePortrait = document.getElementById('battle-enemy-portrait');
    if(ePortrait) ePortrait.innerHTML = getPortraitForQuest(quest);
  }catch(e){console.warn('Could not set battle portrait', e)}
  // switch screens
  renderBattle();
  showScreen('screen-battle');
}

function appendBattleLog(text){
  if(!battleState) return;
  battleState.log.push(text);
  const el = document.getElementById('battle-area-log');
  if(el) el.textContent = battleState.log.join('\n');
}

function renderBattle(){
  if(!battleState) return;
  // player
  const pLv = document.getElementById('battle-player-level');
  if(pLv) pLv.textContent = state.level;
  // player portrait: use saved avatar if available, otherwise leave emoji
  try{
    const pPortrait = document.getElementById('battle-player-portrait');
    if(pPortrait){
      if(state.avatar && typeof state.avatar === 'string' && state.avatar.length > 20){
        pPortrait.innerHTML = `<img src="${state.avatar}" class="card-portrait-img" alt="Player avatar"/>`;
      } else {
        pPortrait.innerHTML = '🙂';
      }
    }
  }catch(e){console.warn('set player portrait failed', e)}
  const pHpFill = document.getElementById('battle-player-hp');
  const pHpText = document.getElementById('battle-player-hp-text');
  const pHpPct = (battleState.player.hp.max>0)? Math.max(0,Math.min(100,(battleState.player.hp.cur/battleState.player.hp.max)*100)):0;
  if(pHpFill) pHpFill.style.width = pHpPct + '%';
  if(pHpText) pHpText.textContent = `${Math.max(0,Math.round(battleState.player.hp.cur))} / ${battleState.player.hp.max}`;
  // enemy
  const eName = document.getElementById('battle-enemy-name'); if(eName) eName.textContent = battleState.enemy.name;
  const eLv = document.getElementById('battle-enemy-level'); if(eLv) eLv.textContent = battleState.enemy.level;
  const eHpFill = document.getElementById('battle-enemy-hp');
  const eHpText = document.getElementById('battle-enemy-hp-text');
  const eHpPct = (battleState.enemy.hp.max>0)? Math.max(0,Math.min(100,(battleState.enemy.hp.cur/battleState.enemy.hp.max)*100)):0;
  if(eHpFill) eHpFill.style.width = eHpPct + '%';
  if(eHpText) eHpText.textContent = `${Math.max(0,Math.round(battleState.enemy.hp.cur))} / ${battleState.enemy.hp.max}`;
  // update log area
  const el = document.getElementById('battle-area-log'); if(el) el.textContent = battleState.log.join('\n');
}

function startDungeon(dungeon){
  if(!dungeon) return;
  currentDungeon = dungeon;
  renderDungeon();
  showScreen('screen-dungeon');
}

function renderDungeon(){
  if(!currentDungeon) return;
  const info = document.getElementById('dungeon-info');
  const wrap = document.getElementById('dungeon-monsters');
  if(info) info.textContent = `${currentDungeon.name} — Difficulty ${currentDungeon.difficulty}`;
  if(!wrap) return;
  wrap.innerHTML = '';
  currentDungeon.monsters.forEach(mon=>{
    const row = document.createElement('div'); row.className = 'opponent-card';
    row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center';
    const left = document.createElement('div');
    const icon = getPortraitForQuest(mon);
    left.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><div style=\"font-size:28px\">${icon}</div><div><div style=\"font-weight:800;color:#ffd86b\">${mon.name}</div><div style=\"font-size:12px;color:#a8e6ff\">Lv. ${mon.level} — Reward ${mon.reward}</div></div></div>`;
    const btnWrap = document.createElement('div'); const fbtn = document.createElement('button'); fbtn.className='fight-btn'; fbtn.textContent='Fight';
    fbtn.addEventListener('click', ()=>{ startBattle({ id: mon.id, name: mon.name, level: mon.level, reward: mon.reward, stamina: mon.stamina }); });
    btnWrap.appendChild(fbtn);
    row.appendChild(left); row.appendChild(btnWrap);
    wrap.appendChild(row);
  });
}

async function playerAttack(){
  if(!battleState) return;
  // include temporary battle buffs (e.g., Berserk)
  let buffStr = 0;
  if(battleState.playerBuffs && Array.isArray(battleState.playerBuffs)){
    battleState.playerBuffs.forEach(b=>{ if(b && b.key === 'str') buffStr += Number(b.val || 0); });
  }
  const base = Math.max(1, Math.round(((getEffectiveStat('str') || 0) + buffStr) * 1.1 + state.level * 1.5));
  // variance scales with enemy level (approx previous power/15 where power ~ level*10)
  const variance = Math.floor(Math.random() * Math.max(1, Math.floor((battleState.enemy.level || 1) * 0.7)));
  let dmg = base + variance - Math.floor(battleState.enemy.vit * 0.5);
  if(dmg < 1) dmg = 1;
  battleState.enemy.hp.cur = Math.max(0, battleState.enemy.hp.cur - dmg);
  appendBattleLog(`You attack for ${dmg} damage.`);
  renderBattle();
  if(battleState.enemy.hp.cur <= 0){
    await endBattle(true);
    return;
  }
  // small mp cost
  const mpCost = Math.min(battleState.player.mp.cur, Math.ceil((battleState.enemy.level || 1)));
  battleState.player.mp.cur = Math.max(0, battleState.player.mp.cur - mpCost);
  appendBattleLog(`You used ${mpCost} MP.`);
  // enemy turn
  await enemyTurn();
}

async function playerDefend(){
  if(!battleState) return;
  battleState.playerDefending = true;
  appendBattleLog('You brace for the next attack (Defend).');
  renderBattle();
  await enemyTurn();
}

async function enemyTurn(){
  if(!battleState) return;
  // enemy attacks
  // base damage roughly maps to (level*10 - str*0.8)/6 from previous model
  const base = Math.max(1, Math.ceil(((battleState.enemy.level || 1) * 10 - Math.floor((getEffectiveStat('str')||0) * 0.8)) / 6));
  const variance = Math.floor(Math.random() * Math.max(1, Math.floor(((battleState.enemy.level || 1) * 10) / 12)));
  let dmg = base + variance;
  if(battleState.playerDefending) dmg = Math.max(0, Math.floor(dmg * 0.5));
  // temporary barrier reduces damage
  if(battleState.playerBarrier && battleState.playerBarrier > 0){ dmg = Math.max(0, Math.floor(dmg * 0.5)); battleState.playerBarrier = Math.max(0, battleState.playerBarrier - 1); appendBattleLog('Your barrier absorbed some damage.'); }
  // mitigate by player's vit
  dmg = Math.max(0, dmg - Math.floor((getEffectiveStat('vit') || 0) / 6));
  battleState.player.hp.cur = Math.max(0, battleState.player.hp.cur - dmg);
  appendBattleLog(`${battleState.enemy.name} hits you for ${dmg} damage.`);
  // enemy may drain some player stamina
  const stamDrain = Math.min(battleState.player.stam.cur, Math.ceil((battleState.enemy.level || 1) / 2));
  battleState.player.stam.cur = Math.max(0, battleState.player.stam.cur - stamDrain);
  if(stamDrain > 0) appendBattleLog(`You lost ${stamDrain} STA.`);
  battleState.playerDefending = false;
  renderBattle();
  if(battleState.player.hp.cur <= 0){
    await endBattle(false);
  }
  // tick down temporary player buffs
  if(battleState.playerBuffs && Array.isArray(battleState.playerBuffs)){
    for(let i = battleState.playerBuffs.length - 1; i >= 0; i--){
      const b = battleState.playerBuffs[i];
      if(!b) continue;
      b.turns = (b.turns || 0) - 1;
      if(b.turns <= 0){ battleState.playerBuffs.splice(i,1); appendBattleLog(`Your ${b.key.toUpperCase()} buff has expired.`); }
    }
  }
}

async function endBattle(playerWon){
  if(!battleState) return;
  if(playerWon){
    // award Ability Points (battles no longer give XP)
    const abilityGain = (battleState.questRef && typeof battleState.questRef.reward === 'number') ? battleState.questRef.reward : Math.ceil((battleState.enemy.level || 1) * 2);
    appendBattleLog(`Victory! You defeated ${battleState.enemy.name} and earned ${abilityGain} Ability Points.`);
    try{ showBattleParticles(true); }catch(e){}
    // apply rewards and transfer player current hp/mp/stam to main state
    state.hp.cur = Math.max(0, Math.min(state.hp.max, Math.round(battleState.player.hp.cur)));
    state.mp.cur = Math.max(0, Math.min(state.mp.max, Math.round(battleState.player.mp.cur)));
    if(state.stamina && typeof state.stamina.cur === 'number'){
      state.stamina.cur = Math.max(0, Math.min(state.stamina.max, Math.round(battleState.player.stam.cur + Math.ceil((battleState.enemy.level || 1) / 2))));
    }
    // cost to fight
    const mpCost = Math.ceil(((battleState.enemy.level || 1) * 10) / 8);
    state.mp.cur = Math.max(0, state.mp.cur - mpCost);
    // grant Ability Points instead of XP
    state.available = (state.available || 0) + abilityGain;
    try{ showAbilityPopup(abilityGain); }catch(e){}
  }else{
    appendBattleLog(`Defeat... ${battleState.enemy.name} bested you.`);
    try{ showBattleParticles(false); }catch(e){}
    // transfer reduced stats back to player state and apply stamina penalty
    state.hp.cur = Math.max(0, Math.round(battleState.player.hp.cur));
    state.mp.cur = Math.max(0, Math.round(battleState.player.mp.cur));
    if(state.stamina && typeof state.stamina.cur === 'number'){
      state.stamina.cur = Math.max(0, state.stamina.cur - Math.ceil(((battleState.enemy.level || 1) * 10) / 12));
    }
  }
  await saveState();
  render();
  // small delay before returning to Quests
  setTimeout(()=>{ showScreen('screen-quests'); renderQuests(); battleState = null; }, 900);
}

function fightOpponent(opponent){
  const log = document.getElementById('battle-log');
  log.textContent = '';
  // simple power model: playerPower = level*10 + sum(stats)
  const eff = getEffectiveStats();
  const statsSum = (eff.str||0) + (eff.agi||0) + (eff.per||0) + (eff.vit||0) + (eff.int||0);
  const playerPower = (state.level || 1) * 10 + statsSum;
  const opponentPower = (typeof opponent.power === 'number') ? opponent.power : ((typeof opponent.level === 'number') ? opponent.level * 10 : 10);
  log.textContent += `You engage ${opponent.name} (Lv. ${opponent.level || '?'} — power ${opponentPower})\n`;
  const roll = Math.floor(Math.random() * 40) - 10; // -10..29
  const effective = playerPower + roll;
  log.textContent += `Your effective power: ${effective} (base ${playerPower}, roll ${roll})\n`;
  // Player stamina is a positive resource; higher stamina provides a small bonus to VIT
  const playerStamina = (state.stamina && typeof state.stamina.cur === 'number') ? state.stamina.cur : 0;
  const effectiveVIT = Math.max(0, (eff.vit || 0) + Math.floor(playerStamina / 5));
  // Base enemy attack count scales with opponent power
  const enemyAttacksBase = Math.max(1, Math.floor(opponentPower / 25));
  // Enemy's ability to attack is reduced by its own fatigue and player's effective VIT
  const enemyAttackReduction = Math.floor(effectiveVIT / 10) + Math.floor((opponent.stamina || 0) / 10);
  let enemyAttacks = Math.max(0, enemyAttacksBase - enemyAttackReduction);

  if(effective >= opponentPower){
    // Player wins — but opponent may still get a few attacks in depending on fatigue/VIT
    // award Ability Points (battles no longer grant XP)
    const abilityGain = (typeof opponent.reward === 'number') ? opponent.reward : Math.ceil((opponent.level || 1) * 2);
    log.textContent += `Victory! You defeated ${opponent.name} and earned ${abilityGain} Ability Points.`;
    showAbilityPopup(abilityGain);
    state.available = (state.available || 0) + abilityGain;
    try{ showBattleParticles(true); }catch(e){}
    // small MP cost for fighting
    const mpCost = Math.ceil(opponentPower / 8);
    state.mp.cur = Math.max(0, (state.mp.cur || 0) - mpCost);
    // stamina cost for fighting (spend stamina resource)
    const stamCost = Math.ceil(opponentPower / 12);
    if(state.stamina && typeof state.stamina.cur === 'number'){
      state.stamina.cur = Math.max(0, state.stamina.cur - stamCost);
      try{ showRecoveryPopup('stam', -stamCost, document.getElementById('stam-text')); }catch(e){}
    }
    // enemy may land `enemyAttacks` strikes before falling
    let totalDamage = 0;
    for(let i=0;i<enemyAttacks;i++){
      const baseDamage = Math.max(1, Math.ceil((opponentPower - Math.floor((state.stats.str||0) * 1.2)) / 6));
      const variance = Math.floor(Math.random() * Math.max(1, Math.floor(opponentPower / 20)));
      const dmg = baseDamage + variance;
      totalDamage += dmg;
    }
    if(totalDamage > 0){
      state.hp.cur = Math.max(0, (state.hp.cur || 0) - totalDamage);
      log.textContent += `\nThe ${opponent.name} landed ${enemyAttacks} strike(s) for ${totalDamage} total damage.`;
    }
    log.textContent += `\nUsed ${mpCost} MP.`;
    // small post-fight stamina regain on victory (quick boost)
    if(state.stamina && typeof state.stamina.cur === 'number'){
      state.stamina.cur = Math.min(state.stamina.max, state.stamina.cur + Math.ceil(opponentPower / 20));
    }
    saveState();
    render();
  }else{
    // Player fails to overpower opponent — opponent will attack more aggressively
    // Give opponent its full attack potential (at least enemyAttacksBase), but reduce by player's VIT/fatigue
    const extra = Math.max(0, enemyAttacksBase - enemyAttacks);
    // ensure at least one attack
    enemyAttacks = Math.max(1, enemyAttacks);
    let totalDamage = 0;
    for(let i=0;i<enemyAttacks;i++){
      const baseDamage = Math.max(1, Math.ceil((opponentPower - Math.floor((state.stats.str||0) * 1.0)) / 5));
      const variance = Math.floor(Math.random() * Math.max(1, Math.floor(opponentPower / 15)));
      const dmg = baseDamage + variance;
      totalDamage += dmg;
    }
    state.hp.cur = Math.max(0, (state.hp.cur || 0) - totalDamage);
    // small MP cost
    const mpLoss = Math.min(state.mp.cur || 0, Math.ceil(opponentPower / 6));
    state.mp.cur = Math.max(0, (state.mp.cur || 0) - mpLoss);
    log.textContent += `Defeat. ${opponent.name} was too strong. It landed ${enemyAttacks} strike(s) for ${totalDamage} damage and you lost ${mpLoss} MP.`;
    // on defeat, reduce stamina further (exhaustion)
    if(state.stamina && typeof state.stamina.cur === 'number'){
      const loss = Math.ceil(opponentPower / 12);
      state.stamina.cur = Math.max(0, state.stamina.cur - loss);
      try{ showRecoveryPopup('stam', -loss, document.getElementById('stam-text')); }catch(e){}
    }
    saveState();
    render();
    try{ showBattleParticles(false); }catch(e){}
  }
}

function render(){
  document.getElementById('level-number').textContent = state.level;
  const jobEl = document.getElementById('job');
  if(jobEl) jobEl.textContent = state.job;
  document.getElementById('title').textContent = state.title;

  // HP/MP bars
  // handle zero max to avoid division by zero
  const hpPct = (state.hp.max > 0) ? Math.max(0, Math.min(100, (state.hp.cur / state.hp.max) * 100)) : 0;
  document.getElementById('hp-fill').style.width = hpPct + '%';
  document.getElementById('hp-text').textContent = `${state.hp.cur} / ${state.hp.max}`;
  const mpPct = (state.mp.max > 0) ? Math.max(0, Math.min(100, (state.mp.cur / state.mp.max) * 100)) : 0;
  document.getElementById('mp-fill').style.width = mpPct + '%';
  document.getElementById('mp-text').textContent = `${state.mp.cur} / ${state.mp.max}`;
  // Stamina bar (cur / max)
  const stamSafe = (state.stamina && typeof state.stamina.cur === 'number') ? Math.max(0, Math.min(state.stamina.max, state.stamina.cur)) : 0;
  const stamMax = (state.stamina && typeof state.stamina.max === 'number') ? state.stamina.max : 100;
  const stamPct = stamMax > 0 ? Math.max(0, Math.min(100, (stamSafe / stamMax) * 100)) : 0;
  const stamFill = document.getElementById('stam-fill');
  if(stamFill) stamFill.style.width = stamPct + '%';
  const stamText = document.getElementById('stam-text');
  if(stamText) stamText.textContent = `${Math.round(stamSafe)} / ${stamMax}`;

  // Stats
  document.getElementById('str').textContent = state.stats.str;
  document.getElementById('agi').textContent = state.stats.agi;
  document.getElementById('per').textContent = state.stats.per;
  document.getElementById('vit').textContent = state.stats.vit;
  document.getElementById('int').textContent = state.stats.int;
  document.getElementById('available').textContent = state.available;
  // XP bar (ensure toNext > 0)
  const xpToNextSafe = (state.xp && state.xp.toNext > 0) ? state.xp.toNext : xpToLevelUp(state.level);
  const xpPct = Math.max(0, Math.min(100, (state.xp.cur / xpToNextSafe) * 100));
  document.getElementById('xp-fill').style.width = xpPct + '%';
  document.getElementById('xp-text').textContent = `${state.xp.cur} / ${xpToNextSafe}`;

  // Requirements (daily task may change based on level ranges)
  try{
    const daily = computeDailyTaskForLevel(state.level);
    const dailyReqEl = document.getElementById('daily-req');
    const dailyActEl = document.getElementById('daily-activity');
    if(dailyReqEl) dailyReqEl.textContent = daily.amount;
    if(dailyActEl) dailyActEl.textContent = daily.activity;
  }catch(e){
    // fallback to previous tiered behavior
    try{ document.getElementById('daily-req').textContent = tieredRequirement(state.taskBase.dailyJumpingJacks, state.level); }catch(e2){}
  }
  try{
    const bonus = computeWeeklyBonus(state.level);
    const wp = (state.taskBase && typeof state.taskBase.weeklyPushups === 'number') ? state.taskBase.weeklyPushups + bonus : 0 + bonus;
    const wsq = (state.taskBase && typeof state.taskBase.weeklySquats === 'number') ? state.taskBase.weeklySquats + bonus : 0 + bonus;
    const wsi = (state.taskBase && typeof state.taskBase.weeklySitups === 'number') ? state.taskBase.weeklySitups + bonus : 0 + bonus;
    document.getElementById('weekly-push').textContent = tieredRequirement(wp, state.level);
    document.getElementById('weekly-squat').textContent = tieredRequirement(wsq, state.level);
    document.getElementById('weekly-sit').textContent = tieredRequirement(wsi, state.level);
  }catch(e){
    // fallback
    try{ document.getElementById('weekly-push').textContent = tieredRequirement(state.taskBase.weeklyPushups, state.level); }catch(e2){}
    try{ document.getElementById('weekly-squat').textContent = tieredRequirement(state.taskBase.weeklySquats, state.level); }catch(e2){}
    try{ document.getElementById('weekly-sit').textContent = tieredRequirement(state.taskBase.weeklySitups, state.level); }catch(e2){}
  }
  // Task buttons reflect saved state (add/remove completed class)
  const btnDaily = document.getElementById('daily-complete');
  if(btnDaily){
    const done = !!state.tasks.daily.completed;
    btnDaily.classList.toggle('completed', done);
    btnDaily.setAttribute('aria-pressed', done ? 'true' : 'false');
  }
  const btnWp = document.getElementById('weekly-push-complete');
  if(btnWp){
    const done = !!state.tasks.weeklyPush.completed;
    btnWp.classList.toggle('completed', done);
    btnWp.setAttribute('aria-pressed', done ? 'true' : 'false');
  }
  const btnWsq = document.getElementById('weekly-squat-complete');
  if(btnWsq){
    const done = !!state.tasks.weeklySquat.completed;
    btnWsq.classList.toggle('completed', done);
    btnWsq.setAttribute('aria-pressed', done ? 'true' : 'false');
  }
  const btnWsi = document.getElementById('weekly-sit-complete');
  if(btnWsi){
    const done = !!state.tasks.weeklySit.completed;
    btnWsi.classList.toggle('completed', done);
    btnWsi.setAttribute('aria-pressed', done ? 'true' : 'false');
  }

  // Render unlockable Tasks (Daily at level 5, Weekly at level 8)
  // unlockable tasks removed

  // Render equipment panel
  try{ renderEquipmentPanel(); }catch(e){ console.warn('renderEquipmentPanel failed', e); }
  try{ renderSkillsPanel(); }catch(e){ console.warn('renderSkillsPanel failed', e); }
}

// unlockable Daily/Weekly tasks removed; no rendering needed

function renderSkillsPanel(){
  const grid = document.getElementById('skills-grid');
  if(!grid) return;
  grid.innerHTML = '';
  state.skills = state.skills || [];
  if(state.skills.length === 0){
    const p = document.createElement('div'); p.className = 'skill-item'; p.textContent = 'No skills learned yet.'; grid.appendChild(p); return;
  }
  // Render as tiles with icon, name and optional rarity class
  state.skills.forEach(s=>{
    const tile = document.createElement('div'); tile.className = 'skill-tile';
    if(s.rarity) tile.classList.add('rarity-' + s.rarity);
    const icon = document.createElement('div'); icon.className = 'skill-icon'; icon.textContent = s.icon || '★';
    const name = document.createElement('div'); name.className = 'skill-name'; name.textContent = s.name;
    const desc = document.createElement('div'); desc.className = 'skill-desc'; desc.textContent = s.desc || '';
    tile.appendChild(icon);
    const info = document.createElement('div'); info.className = 'skill-info'; info.appendChild(name); info.appendChild(desc);
    tile.appendChild(info);
    // clicking a tile opens the skill modal for quick use/view
    tile.addEventListener('click', ()=>{ try{ showSkillModal({ inBattle: false }); }catch(e){ console.warn('open skill modal failed', e); } });
    grid.appendChild(tile);
  });
}

// Render the equipment panel UI in the Stats screen
function renderEquipmentPanel(){
  const grid = document.getElementById('eq-grid');
  if(!grid) return;
  grid.innerHTML = '';
  state.equipment = state.equipment || {};
  const slots = ['head','chest','legs','weapon','shield'];
  slots.forEach(slot=>{
    const wrapper = document.createElement('div'); wrapper.className = 'eq-slot';
    const slotName = document.createElement('div'); slotName.className = 'slot-name'; slotName.textContent = slot.toUpperCase();
    wrapper.appendChild(slotName);
    const item = state.equipment[slot];
    if(item){
      // show icon + name with rarity coloring
      const top = document.createElement('div'); top.className = 'slot-top';
      const left = document.createElement('div'); left.className = 'slot-left';
      const icon = document.createElement('div'); icon.className = 'eq-icon ' + (item.rarity ? ('rarity-' + item.rarity) : 'rarity-common');
      icon.textContent = item.type === 'armor' ? '🛡' : (item.type === 'consumable' ? '⚗' : (item.type === 'weapon' ? '⚔' : '◆'));
      const itemName = document.createElement('div'); itemName.className = 'slot-item'; itemName.textContent = item.name || 'Item';
      left.appendChild(icon); left.appendChild(itemName);
      top.appendChild(left);
      wrapper.appendChild(top);
      if(item.bonus){
        const bwrap = document.createElement('div'); bwrap.className = 'slot-bonus';
        const parts = [];
        Object.keys(item.bonus).forEach(k=>{ parts.push(`${k.toUpperCase()} +${item.bonus[k]}`); });
        bwrap.textContent = parts.join('  ');
        wrapper.appendChild(bwrap);
      }
      const actions = document.createElement('div'); actions.className = 'slot-actions';
      const uneq = document.createElement('button'); uneq.type='button'; uneq.textContent = 'Unequip'; uneq.addEventListener('click', ()=>{ unequipSlot(slot); });
      actions.appendChild(uneq);
      wrapper.appendChild(actions);
    } else {
      const empty = document.createElement('div'); empty.className = 'slot-item'; empty.textContent = 'Empty'; empty.style.color = '#9fbccc';
      wrapper.appendChild(empty);
    }
    grid.appendChild(wrapper);
  });
}

function unequipSlot(slot){
  state.equipment = state.equipment || {};
  const it = state.equipment[slot];
  if(!it) return;
  // move item back to inventory
  try{ addItemToInventory(Object.assign({}, it, { qty: 1 })); }catch(e){ console.warn('addItemToInventory failed on unequip', e); }
  delete state.equipment[slot];
  try{ saveState(); }catch(e){ console.warn('saveState failed on unequip', e); }
  render();
}

function changeLevel(delta){
  state.level = Math.max(1, state.level + delta);
  // Apply centralized stat growth and HP/MP recomputation, show stat deltas
  const oldStats = Object.assign({}, state.stats);
  applyStatsForLevel(state.level);
  const deltas = {};
  ['str','agi','per','vit','int'].forEach(k=>{ deltas[k] = (state.stats[k] || 0) - (oldStats[k] || 0); });
  try{ showStatPopup(deltas); }catch(e){}
  render();
}

async function saveState(){
  try{
    await storageAdapter.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){
    console.warn('Could not save state', e);
  }
}

// Async loader - returns merged state or defaults
async function loadState(){
  try{
    const raw = await storageAdapter.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(!parsed.xp) parsed.xp = {cur:0,toNext:100};
      // migrate old numeric stamina value to {cur,max}
      if(parsed.hasOwnProperty('stamina')){
        if(typeof parsed.stamina === 'number'){
          parsed.stamina = { cur: Math.max(0, Math.min(100, Number(parsed.stamina || 0))), max: 100 };
        } else if(parsed.stamina && typeof parsed.stamina.cur === 'number' && !parsed.stamina.max){
          parsed.stamina.max = 100;
        }
      }
      return Object.assign({}, defaultState, parsed);
    }
  }catch(e){ console.warn('Could not load state', e); }
  return Object.assign({}, defaultState);
}

function grantXP(amount){
  state.xp.cur += amount;
  // ensure toNext exists
  if(!state.xp.toNext) state.xp.toNext = xpToLevelUp(state.level);
  // level up loop
  while(state.xp.cur >= state.xp.toNext){
    state.xp.cur -= state.xp.toNext;
    state.level += 1;
    // recalc xp needed
    state.xp.toNext = xpToLevelUp(state.level);
    // capture old stats, apply growth, compute deltas and show popup
    const oldStats = Object.assign({}, state.stats);
    applyStatsForLevel(state.level);
    // update title/category based on new level
    try{ state.title = computeTitleForLevel(state.level); }catch(e){console.warn('computeTitleForLevel failed', e)}
    const deltas = {};
    ['str','agi','per','vit','int'].forEach(k=>{ deltas[k] = (state.stats[k] || 0) - (oldStats[k] || 0); });
    try{ showStatPopup(deltas); }catch(e){}
    try{ showLevelUpParticles(); }catch(e){}
    try{ showLevelUpPopup(state.level); }catch(e){}
    // Unlock Fighting Skills at level 5 and congratulate the player
    try{
      state.unlockedCategories = state.unlockedCategories || {};
      if(state.level >= 10 && !state.unlockedCategories['Fighting Skills']){
        state.unlockedCategories['Fighting Skills'] = true;
        try{ saveState(); }catch(e){ console.warn('saveState failed when unlocking category', e); }
        try{ showUnlockPopup('Fighting Skills'); }catch(e){ console.warn('showUnlockPopup failed', e); }
      }
    }catch(e){ console.warn('Unlock check failed', e); }
    // Unlockable tasks removed; no task unlocks
  }
  saveState();
  try{ checkProgressionUpgrades('xp'); }catch(e){ console.warn('checkProgressionUpgrades after XP failed', e); }
  render();
}

// show a small animated XP popup near bottom center
function showXPPopup(amount){
  try{
    const div = document.createElement('div');
    div.className = 'xp-popup';
    div.textContent = `+${amount} XP`;
    document.body.appendChild(div);
    // trigger animation
    // small delay to ensure appended
    requestAnimationFrame(()=>{
      div.classList.add('show');
    });
    // remove after animation ends (~1.2s)
    setTimeout(()=>{
      try{ document.body.removeChild(div); }catch(e){}
    }, 1400);
  }catch(e){console.warn('XP popup failed', e)}
}

// show a small animated Ability Points popup near bottom center
function showAbilityPopup(amount){
  try{
    const div = document.createElement('div');
    div.className = 'ability-popup';
    div.textContent = `+${amount} AP`;
    document.body.appendChild(div);
    requestAnimationFrame(()=>{ div.classList.add('show'); });
    setTimeout(()=>{ try{ document.body.removeChild(div); }catch(e){} }, 1400);
  }catch(e){console.warn('Ability popup failed', e)}
}

// Add item to inventory (merge by name/type) and persist
function addItemToInventory(item){
  if(!item || !item.name) return;
  state.inventory = state.inventory || [];
  // try to find same item by id or name
  const found = state.inventory.find(i=>i.name === item.name && i.rarity === item.rarity && i.type === item.type);
  if(found){ found.qty = (found.qty || 1) + (item.qty || 1); }
  else { state.inventory.push(Object.assign({}, item, { qty: item.qty || 1 })); }
  try{ saveState(); }catch(e){ console.warn('saveState failed after adding item', e); }
  try{ showItemPopup(item); }catch(e){ console.warn('showItemPopup failed', e); }
}

function showItemPopup(item){
  try{
    const div = document.createElement('div');
    div.className = 'xp-popup';
    div.textContent = `+1 ${item.name}`;
    document.body.appendChild(div);
    requestAnimationFrame(()=>div.classList.add('show'));
    setTimeout(()=>{ try{ document.body.removeChild(div); }catch(e){} }, 1400);
  }catch(e){console.warn('item popup failed', e)}
}

// Loot generation: returns an item or null
function generateLoot(source){
  const roll = Math.random();
  // Example probabilities: common potion 40%, stamina potion 25%, armor 10%, nothing otherwise
  if(roll < 0.40) return { name: 'Minor Health Potion', type: 'consumable', rarity: 'common', effect: { hp: 40 }, qty: 1 };
  if(roll < 0.65) return { name: 'Stamina Potion', type: 'consumable', rarity: 'common', effect: { stam: 40 }, qty: 1 };
  if(roll < 0.75) return { name: 'Greater Health Potion', type: 'consumable', rarity: 'rare', effect: { hp: 120 }, qty: 1 };
  if(roll < 0.85) return { name: 'Leather Armor (Chest)', type: 'armor', rarity: 'common', slot: 'chest', bonus: { vit: 2 } };
  if(roll < 0.92) return { name: 'Iron Greaves (Legs)', type: 'armor', rarity: 'rare', slot: 'legs', bonus: { vit: 4 } };
  if(roll < 0.97) return { name: 'Dragonplate Helm', type: 'armor', rarity: 'epic', slot: 'head', bonus: { vit: 8 } };
  return null; // nothing
}

// Roll for loot after task/challenge completion
function rollLoot(context){
  try{
    // increase drop chance for challenges
    const base = (context === 'challenge') ? 0.6 : 0.35;
    if(Math.random() > base) return null;
    const item = generateLoot(context);
    if(item){ addItemToInventory(item); }
    return item;
  }catch(e){ console.warn('rollLoot error', e); return null; }
}

// Show inventory modal. Options: { inBattle: bool, onlyConsumables: bool }
function showInventoryModal(opts){
  opts = opts || {};
  const inBattle = !!opts.inBattle;
  const onlyConsumables = !!opts.onlyConsumables;
  // build modal
  const overlay = document.createElement('div'); overlay.className = 'inv-overlay';
  const box = document.createElement('div'); box.className = 'inv-modal';
  const title = document.createElement('h3'); title.textContent = inBattle ? 'Use Item (Battle)' : 'Inventory';
  box.appendChild(title);

  // controls: sorter + list
  const controls = document.createElement('div'); controls.className = 'inv-controls';
  const sortLabel = document.createElement('label'); sortLabel.textContent = 'Sort: ';
  const sortSel = document.createElement('select'); sortSel.className = 'inv-sort';
  ['name','rarity'].forEach(v=>{ const o = document.createElement('option'); o.value = v; o.textContent = v.charAt(0).toUpperCase() + v.slice(1); sortSel.appendChild(o); });
  controls.appendChild(sortLabel); controls.appendChild(sortSel);
  box.appendChild(controls);

  const list = document.createElement('div'); list.className = 'inv-list';
  state.inventory = state.inventory || [];
  if(state.inventory.length === 0){
    const p = document.createElement('div'); p.className = 'inv-empty'; p.textContent = 'No items yet.'; list.appendChild(p);
  } else {
    // create a view copy for sorting and stable indices
    const items = state.inventory.map((it,i)=> Object.assign({}, it, { _idx: i }));
    function rarityValue(r){ return r === 'epic' ? 3 : r === 'rare' ? 2 : 1; }
    function renderList(){
      list.innerHTML = '';
      const sortBy = sortSel.value;
      if(sortBy === 'name') items.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
      else items.sort((a,b)=> rarityValue(b.rarity) - rarityValue(a.rarity));
      items.forEach(it=>{
        if(onlyConsumables && it.type !== 'consumable') return;
        const idx = it._idx;
        const row = document.createElement('div'); row.className = 'inv-item ' + (it.rarity || 'common');
        const left = document.createElement('div'); left.className = 'inv-left';
        const icon = document.createElement('div'); icon.className = 'inv-icon'; icon.textContent = (it.icon || (it.type === 'consumable' ? '🍷' : it.type === 'armor' ? '🛡️' : '🔧'));
        left.appendChild(icon);
        left.innerHTML += `<div class="inv-name">${it.name}</div><div class="inv-meta">${it.rarity || ''} ${it.type || ''}</div>`;
        const right = document.createElement('div'); right.className = 'inv-right';
        const qty = document.createElement('div'); qty.className = 'inv-qty'; qty.textContent = `x${it.qty||1}`;
        right.appendChild(qty);
        if(it.type === 'consumable'){
          const useBtn = document.createElement('button'); useBtn.type='button'; useBtn.textContent = inBattle ? 'Use in Battle' : 'Use';
          useBtn.addEventListener('click', ()=>{ useItemByIndex(idx, inBattle); overlay.remove(); });
          right.appendChild(useBtn);
        }
        if(it.type === 'armor'){
          const equipBtn = document.createElement('button'); equipBtn.type='button'; equipBtn.textContent = (state.equipment && state.equipment[it.slot] && state.equipment[it.slot].name === it.name) ? 'Unequip' : 'Equip';
          equipBtn.addEventListener('click', ()=>{ toggleEquip(idx); render(); saveState(); overlay.remove(); });
          right.appendChild(equipBtn);
        }
        const drop = document.createElement('button'); drop.type='button'; drop.textContent = 'Drop';
        drop.addEventListener('click', ()=>{ if(confirm('Drop this item?')){ removeOneFromInventory(idx); render(); saveState(); overlay.remove(); } });
        right.appendChild(drop);
        row.appendChild(left); row.appendChild(right); list.appendChild(row);
      });
    }
    sortSel.addEventListener('change', renderList);
    renderList();
  }
  box.appendChild(list);
  const footer = document.createElement('div'); footer.className = 'inv-footer';
  const close = document.createElement('button'); close.type='button'; close.textContent = 'Close'; close.addEventListener('click', ()=>{ overlay.remove(); });
  footer.appendChild(close);
  box.appendChild(footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function removeOneFromInventory(idx){
  const it = state.inventory[idx]; if(!it) return;
  if(it.qty && it.qty > 1) it.qty = it.qty - 1;
  else state.inventory.splice(idx,1);
}

function useItemByIndex(idx, inBattle){
  const it = state.inventory[idx]; if(!it) return;
  if(it.type !== 'consumable') return;
  // Apply effects
  const eff = it.effect || {};
  if(inBattle && battleState){
    if(eff.hp){ battleState.player.hp.cur = Math.min(battleState.player.hp.max, (battleState.player.hp.cur||0) + eff.hp); appendBattleLog(`You used ${it.name} and recovered ${eff.hp} HP.`); }
    if(eff.stam || eff.stam === 0){ battleState.player.stam.cur = Math.min(battleState.player.stam.max, (battleState.player.stam.cur||0) + (eff.stam||0)); appendBattleLog(`You used ${it.name} and recovered ${eff.stam||0} STA.`); }
    if(eff.mp){ battleState.player.mp.cur = Math.min(battleState.player.mp.max, (battleState.player.mp.cur||0) + eff.mp); appendBattleLog(`You used ${it.name} and recovered ${eff.mp} MP.`); }
    renderBattle();
  } else {
    if(eff.hp){ state.hp.cur = Math.min(state.hp.max, (state.hp.cur||0) + eff.hp); }
    if(eff.stam || eff.stam === 0){ state.stamina.cur = Math.min(state.stamina.max, (state.stamina.cur||0) + (eff.stam||0)); }
    if(eff.mp){ state.mp.cur = Math.min(state.mp.max, (state.mp.cur||0) + eff.mp); }
    render();
  }
  // consume one
  removeOneFromInventory(idx);
  saveState();
}

// Show skills modal; options: { inBattle: bool }
function showSkillModal(opts){
  opts = opts || {};
  const inBattle = !!opts.inBattle;
  const overlay = document.createElement('div'); overlay.className = 'skill-overlay';
  const box = document.createElement('div'); box.className = 'skill-modal';
  const title = document.createElement('h3'); title.textContent = inBattle ? 'Use Skill (Battle)' : 'Skills'; box.appendChild(title);
  const list = document.createElement('div'); list.className = 'skill-list';
  state.skills = state.skills || [];
  if(state.skills.length === 0){ const p = document.createElement('div'); p.className = 'skill-empty'; p.textContent = 'No skills learned yet.'; list.appendChild(p); }
  else {
    state.skills.forEach((sk, i)=>{
      const row = document.createElement('div'); row.className = 'skill-item';
      const left = document.createElement('div'); left.className = 'skill-left'; left.textContent = sk.icon || '✨';
      const body = document.createElement('div'); body.className = 'skill-body'; body.innerHTML = `<div class="skill-name">${sk.name}</div><div class="skill-desc">${sk.desc||''}</div>`;
      const right = document.createElement('div'); right.className = 'skill-right';
      const mpCost = sk.mpCost || (sk.rarity === 'epic' ? 18 : sk.rarity === 'rare' ? 10 : 6);
      const useBtn = document.createElement('button'); useBtn.type='button'; useBtn.textContent = `Use (${mpCost} MP)`;
      useBtn.addEventListener('click', async ()=>{
        try{
          if(inBattle && !battleState){ alert('No battle active.'); return; }
          // check MP
          const availableMP = inBattle ? (battleState.player.mp.cur||0) : (state.mp.cur||0);
          if(availableMP < mpCost){ if(inBattle) appendBattleLog('Not enough MP to use that skill.'); else alert('Not enough MP'); return; }
          // apply skill effects (simple mapping)
          switch(sk.id){
            case 's_fireball':{
              const dmg = Math.max(1, Math.round((state.level||1) * 4 + Math.random()*12));
              if(inBattle){ battleState.enemy.hp.cur = Math.max(0, battleState.enemy.hp.cur - dmg); appendBattleLog(`You cast ${sk.name} for ${dmg} damage.`); renderBattle(); if(battleState.enemy.hp.cur<=0){ await endBattle(true); } }
              else { state.hp.cur = Math.max(0, Math.min(state.hp.max, state.hp.cur)); }
              break;
            }
            case 's_lightning':{
              const dmg = Math.max(1, Math.round((state.level||1) * 6 + Math.random()*18));
              if(inBattle){ battleState.enemy.hp.cur = Math.max(0, battleState.enemy.hp.cur - dmg); appendBattleLog(`You cast ${sk.name} for ${dmg} lightning damage.`); renderBattle(); if(battleState.enemy.hp.cur<=0){ await endBattle(true); } }
              break;
            }
            case 's_heal':{
              const heal = 60 + Math.round((state.level||1) * 4);
              if(inBattle){ battleState.player.hp.cur = Math.min(battleState.player.hp.max, (battleState.player.hp.cur||0) + heal); appendBattleLog(`You cast ${sk.name} and restored ${heal} HP.`); renderBattle(); }
              else { state.hp.cur = Math.min(state.hp.max, (state.hp.cur||0) + heal); }
              break;
            }
            case 's_megaheal':{
              const heal = 160 + Math.round((state.level||1) * 10);
              if(inBattle){ battleState.player.hp.cur = Math.min(battleState.player.hp.max, (battleState.player.hp.cur||0) + heal); appendBattleLog(`You cast ${sk.name} and restored ${heal} HP.`); renderBattle(); }
              else { state.hp.cur = Math.min(state.hp.max, (state.hp.cur||0) + heal); }
              break;
            }
            case 's_barrier':{
              if(inBattle){ battleState.playerBarrier = (battleState.playerBarrier || 0) + 1; appendBattleLog(`You cast ${sk.name}; damage will be reduced next turn.`); renderBattle(); }
              break;
            }
            case 's_berserk':{
              if(inBattle){ battleState.playerBuffs = battleState.playerBuffs || []; battleState.playerBuffs.push({ key: 'str', val: 5, turns: 3 }); appendBattleLog(`You cast ${sk.name}; STR increased for 3 turns.`); renderBattle(); }
              break;
            }
            default:{
              if(inBattle) appendBattleLog(`You used ${sk.name}.`);
            }
          }
          // deduct MP
          if(inBattle){ battleState.player.mp.cur = Math.max(0, battleState.player.mp.cur - mpCost); renderBattle(); }
          else { state.mp.cur = Math.max(0, state.mp.cur - mpCost); render(); }
          saveState();
          overlay.remove();
        }catch(err){ console.warn('useSkill failed', err); }
      });
      right.appendChild(useBtn);
      row.appendChild(left); row.appendChild(body); row.appendChild(right); list.appendChild(row);
    });
  }
  box.appendChild(list);
  const footer = document.createElement('div'); footer.className = 'skill-footer';
  const close = document.createElement('button'); close.type='button'; close.textContent = 'Close'; close.addEventListener('click', ()=>{ overlay.remove(); });
  footer.appendChild(close); box.appendChild(footer);
  overlay.appendChild(box); document.body.appendChild(overlay);
}

function toggleEquip(idx){
  const it = state.inventory[idx]; if(!it || it.type !== 'armor') return;
  state.equipment = state.equipment || {};
  const slot = it.slot || 'chest';
  // if same item already equipped, unequip -> move back to inventory
  const equipped = state.equipment[slot];
  if(equipped && equipped.name === it.name){
    // unequip: move back to inventory
    addItemToInventory(Object.assign({}, equipped, { qty: 1 }));
    delete state.equipment[slot];
    return;
  }
  // equip: place item into slot and remove one from inventory
  state.equipment[slot] = Object.assign({}, it);
  removeOneFromInventory(idx);
}

// Particle effects: show level-up or battle particles
function ensureParticleWrap(){
  let wrap = document.querySelector('.particle-wrap');
  if(!wrap){
    wrap = document.createElement('div');
    wrap.className = 'particle-wrap';
    document.body.appendChild(wrap);
  }
  return wrap;
}

function spawnParticles(type = 'levelup', count = 18){
  const wrap = ensureParticleWrap();
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2 - 40; // slightly above center
  const colors = {
    levelup: ['#ffd86b','#ff9a4d','#ffdf9a','#fff2d1'],
    victory: ['#7ef39a','#3bd37a','#9ef7c1'],
    defeat: ['#ff7b7b','#d93939','#ffb7b7']
  };
  for(let i=0;i<count;i++){
    const p = document.createElement('div');
    p.className = 'particle ' + (type==='victory'? 'victory' : type==='defeat'? 'defeat' : 'levelup');
    const size = 6 + Math.round(Math.random()*10);
    p.style.width = size + 'px'; p.style.height = size + 'px';
    const xOffset = (Math.random()-0.5) * 260; // spread horizontally
    const startX = centerX + xOffset;
    const startY = centerY + (Math.random()-0.5) * 60;
    p.style.left = startX + 'px';
    p.style.top = startY + 'px';
    // random direction translateX variable for smoother paths
    const tx = (Math.random()-0.5) * 120 + 'px';
    p.style.setProperty('--tx', tx);
    const dur = 900 + Math.round(Math.random()*600);
    p.style.setProperty('--dur', dur + 'ms');
    // random colorization where appropriate
    const colArr = colors[type] || colors.levelup;
    const col = colArr[Math.floor(Math.random()*colArr.length)];
    p.style.background = col;
    wrap.appendChild(p);
    // choose rise or fall based on type
    if(type === 'defeat'){
      p.classList.add('animate-fall');
    }else{
      p.classList.add('animate-rise');
    }
    // remove after animation
    setTimeout(()=>{ try{ wrap.removeChild(p); }catch(e){} }, dur + 300);
  }
}

function showLevelUpParticles(){ spawnParticles('levelup', 24); }
function showBattleParticles(win){ if(win) spawnParticles('victory', 18); else spawnParticles('defeat', 14); }

function toggleTask(key, completed, xpReward){
  // ensure task key exists for older saves
  state.tasks = state.tasks || {};
  if(!state.tasks[key]) state.tasks[key] = { completed: false };
  if(completed && !state.tasks[key].completed){
    state.tasks[key].completed = true;
    // show animated XP popup when marking completed, then grant XP
    showXPPopup(xpReward);
    grantXP(xpReward);
    try{ rollLoot('task'); }catch(e){console.warn('rollLoot failed', e)}
    try{ rollLearnSkill('task'); }catch(e){console.warn('rollLearnSkill failed', e)}
  }else if(!completed && state.tasks[key].completed){
    state.tasks[key].completed = false;
  }
  saveState();
  render();
}

// Compute XP for a personal workout based on minutes
function computeWorkoutXP(minutes){
  const mins = Math.max(0, Math.floor(Number(minutes) || 0));
  // Simple scaling: 2 XP per minute, minimum 5 XP, cap 200 XP
  const xp = Math.min(200, Math.max(5, Math.round(mins * 2)));
  return xp;
}

// Log a personal workout from the Tasks screen (accepts hours + minutes)
async function submitPersonalWorkout(){
  try{
    const nameEl = document.getElementById('personal-workout-name');
    const hoursEl = document.getElementById('personal-workout-hours');
    const minEl = document.getElementById('personal-workout-minutes');
    const feedback = document.getElementById('personal-workout-feedback');
    if(!minEl || !nameEl || !hoursEl || !feedback) return;
    const hours = Math.max(0, Number(hoursEl.value || 0));
    const minutesRaw = Math.max(0, Number(minEl.value || 0));
    const totalMinutes = Math.max(0, Math.floor(hours * 60 + minutesRaw));
    if(totalMinutes <= 0){ feedback.textContent = 'Please enter hours and/or minutes (total > 0).'; return; }
    const label = (nameEl.value && nameEl.value.trim().length > 0) ? nameEl.value.trim() : `${hours}h ${minutesRaw}m workout`;
    const xp = computeWorkoutXP(totalMinutes);
    // record history
    state.tasks = state.tasks || {};
    state.tasks.personalHistory = state.tasks.personalHistory || [];
    const rec = { id: 'p' + Date.now(), label, hours, minutes: minutesRaw, totalMinutes, xp, ts: Date.now() };
    state.tasks.personalHistory.unshift(rec);
    // grant rewards
    try{ showXPPopup(xp); }catch(e){}
    try{ grantXP(xp); }catch(e){}
    try{ rollLearnSkill('task'); }catch(e){}
    try{ rollLoot('task'); }catch(e){}
    feedback.textContent = `Logged: ${label} — ${hours}h ${minutesRaw}m — +${xp} XP`;
    // clear inputs
    hoursEl.value = '';
    minEl.value = '';
    nameEl.value = '';
    await saveState();
    renderPersonalHistory();
    render();
  }catch(e){ console.warn('submitPersonalWorkout failed', e); }
}

// Render the personal workout history in the Tasks screen
function renderPersonalHistory(){
  try{
    const container = document.getElementById('personal-workout-history');
    if(!container) return;
    const list = (state.tasks && state.tasks.personalHistory) ? state.tasks.personalHistory : [];
    if(!list || list.length === 0){
      container.innerHTML = '<div style="color:#97d9ef;font-size:13px">No workouts logged yet.</div>';
      return;
    }
    const rows = list.map(e=>{
      const d = new Date(e.ts);
      const time = d.toLocaleString();
      const label = e.label || 'Personal Workout';
      const h = (typeof e.hours === 'number') ? e.hours : Math.floor((e.totalMinutes||0)/60);
      const m = (typeof e.minutes === 'number') ? e.minutes : ((e.totalMinutes||0) % 60);
      return `
        <div class="pw-row" style="display:flex;justify-content:space-between;align-items:center;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,0.03)">
          <div style="flex:1">
            <div style="font-size:13px;color:#dff6ff">${escapeHtml(label)}</div>
            <div style="font-size:12px;color:#9fe8ff">${h}h ${m}m — +${e.xp} XP — ${time}</div>
          </div>
          <div style="margin-left:8px">
            <button data-id="${e.id}" class="pw-delete" style="background:#ff6b6b;border:none;padding:6px 8px;border-radius:6px;color:#072022;cursor:pointer">Delete</button>
          </div>
        </div>
      `;
    }).join('\n');
    container.innerHTML = rows;
    // wire delete buttons
    Array.from(container.querySelectorAll('.pw-delete')).forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-id');
        state.tasks.personalHistory = (state.tasks.personalHistory || []).filter(x=>String(x.id) !== String(id));
        saveState();
        renderPersonalHistory();
      });
    });
  }catch(e){ console.warn('renderPersonalHistory failed', e); }
}

function escapeHtml(str){
  if(!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function resetDaily(){
  state.tasks.daily.completed = false;
  saveState(); render();
}

function resetWeek(){
  state.tasks.weeklyPush.completed = false;
  state.tasks.weeklySquat.completed = false;
  state.tasks.weeklySit.completed = false;
  saveState(); render();
}

function resetAll(){
  // Clear saved storage and reset state to defaults (level 1 and zeros)
  try{
    localStorage.removeItem(STORAGE_KEY);
  }catch(e){
    console.warn('Could not clear storage', e);
  }
  // reset in-memory state to defaults, then apply base HP/MP/XP for level 1
  state = Object.assign({}, defaultState);
  state.level = 1;
  // XP reset to 0 and base requirement for level 1
  state.xp = { cur: 0, toNext: xpToLevelUp(1) };
  // ensure hp/mp are set to the computed base maxima and current equals max
  state.hp = { cur: computeHPMax(1), max: computeHPMax(1) };
  state.mp = { cur: computeMPMax(1), max: computeMPMax(1) };
  // reset stamina and recovery timestamp
  state.stamina = { cur: 100, max: 100 };
  state.recoveryLast = Date.now();
  // reset other progress trackers
  state.tasks = state.tasks || {};
  state.challenges = {};
  saveState();
  render();
}

window.addEventListener('DOMContentLoaded', async ()=>{
  // load persisted state before wiring UI so render/events use loaded values
  try{ await initState(); }catch(e){ console.warn('initState failed', e); }
  // Ensure daily challenges are expired appropriately on load
  try{ expireDailyChallenges(); }catch(e){ console.warn('expireDailyChallenges on load failed', e); }
  // Ensure weekly challenges are expired appropriately on load
  try{ expireWeeklyChallenges(); }catch(e){ console.warn('expireWeeklyChallenges on load failed', e); }
  // Apply any progression upgrades if conditions already satisfied
  try{ checkProgressionUpgrades('load'); }catch(e){ console.warn('checkProgressionUpgrades on load failed', e); }
  // runtime JS badge removed to keep UI clean
  document.getElementById('increase-level').addEventListener('click', ()=>changeLevel(1));
  document.getElementById('decrease-level').addEventListener('click', ()=>changeLevel(-1));
  // wire task buttons (toggle on click)
  const dailyBtn = document.getElementById('daily-complete');
  if(dailyBtn) dailyBtn.addEventListener('click', ()=>{
    toggleTask('daily', !state.tasks.daily.completed, Number(dailyBtn.dataset.xp || 20));
  });
  const wp = document.getElementById('weekly-push-complete');
  if(wp) wp.addEventListener('click', ()=>{
    toggleTask('weeklyPush', !state.tasks.weeklyPush.completed, Number(wp.dataset.xp || 40));
  });
  const wsq = document.getElementById('weekly-squat-complete');
  if(wsq) wsq.addEventListener('click', ()=>{
    toggleTask('weeklySquat', !state.tasks.weeklySquat.completed, Number(wsq.dataset.xp || 40));
  });
  const wsi = document.getElementById('weekly-sit-complete');
  if(wsi) wsi.addEventListener('click', ()=>{
    toggleTask('weeklySit', !state.tasks.weeklySit.completed, Number(wsi.dataset.xp || 40));
  });
  document.getElementById('reset-daily').addEventListener('click', resetDaily);
  document.getElementById('reset-week').addEventListener('click', resetWeek);
  document.getElementById('reset-all').addEventListener('click', resetAll);
  // initialize xp.toNext
  if(!state.xp || !state.xp.toNext) state.xp.toNext = xpToLevelUp(state.level);
  render();
  // wire bottom nav
  document.querySelectorAll('.bottom-nav button').forEach(b=>{
    b.addEventListener('click', ()=>{
      const s = b.getAttribute('data-screen');
      showScreen(s);
      if(s === 'screen-challenges') renderChallenges();
      if(s === 'screen-quests') renderQuests();
    });
  });
  // back buttons
  document.getElementById('back-from-challenges').addEventListener('click', ()=>showScreen('screen-stats'));
  document.getElementById('back-from-quests').addEventListener('click', ()=>showScreen('screen-stats'));
  // battle back
  const backBattle = document.getElementById('back-from-battle');
  if(backBattle) backBattle.addEventListener('click', ()=>{ showScreen('screen-quests'); renderQuests(); });
  const backDungeon = document.getElementById('back-from-dungeon');
  if(backDungeon) backDungeon.addEventListener('click', ()=>{ showScreen('screen-quests'); renderQuests(); currentDungeon = null; });
  // tasks back
  const backTasks = document.getElementById('back-from-tasks');
  if(backTasks) backTasks.addEventListener('click', ()=>showScreen('screen-stats'));
  // wire battle action buttons
  const atk = document.getElementById('battle-attack');
  if(atk) atk.addEventListener('click', ()=>{ try{ playerAttack(); }catch(e){console.warn(e)} });
  const defb = document.getElementById('battle-defend');
  if(defb) defb.addEventListener('click', ()=>{ try{ playerDefend(); }catch(e){console.warn(e)} });
  // wire quests pager buttons
  const prevQ = document.getElementById('quests-prev');
  if(prevQ) prevQ.addEventListener('click', ()=>changeQuestsPage(-1));
  const nextQ = document.getElementById('quests-next');
  if(nextQ) nextQ.addEventListener('click', ()=>changeQuestsPage(1));
  // avatar upload wiring
  const avatarInput = document.getElementById('player-avatar-input');
  const avatarImg = document.getElementById('player-avatar-img');
  if(avatarImg){
    // click avatar image to open file picker
    avatarImg.addEventListener('click', ()=>{ if(avatarInput) avatarInput.click(); });
  }
  if(avatarInput){
    avatarInput.addEventListener('change', async (ev)=>{
      const f = avatarInput.files && avatarInput.files[0];
      if(!f) return;
      try{
        const reader = new FileReader();
        reader.onload = async function(e){
          const data = e.target.result;
          // save data url into state
          state.avatar = data;
          try{ await saveState(); }catch(e){console.warn('save avatar failed', e)}
          // update UI
          if(avatarImg) avatarImg.src = data;
        };
        reader.readAsDataURL(f);
      }catch(e){console.warn('avatar read failed', e)}
    });
  }
  // Delegate clicks inside challenges list to handle static fallback or dynamically created buttons
  try{
    const challengesWrap = document.getElementById('challenges-list');
    if(challengesWrap){
      challengesWrap.addEventListener('click', (ev)=>{
        const btn = ev.target.closest && ev.target.closest('button.task-btn');
        if(!btn) return;
        const cid = btn.dataset.id || btn.getAttribute('data-id');
        if(!cid) return;
        // ignore if already completed
        if(state.challenges && state.challenges[cid]) return;
        const ch = (Array.isArray(CHALLENGES) && CHALLENGES.find(c=>c.id === cid));
        if(!ch) return;
        state.challenges[cid] = true;
        if(DAILY_CHALLENGE_IDS.has(cid)){
          state.challengeCompletionDate = state.challengeCompletionDate || {};
          state.challengeCompletionDate[cid] = todayKey();
        }
        if(WEEKLY_CHALLENGE_IDS.has(cid)){
          state.challengeCompletionWeek = state.challengeCompletionWeek || {};
          state.challengeCompletionWeek[cid] = weekKey();
        }
        showXPPopup(ch.xp);
        grantXP(ch.xp);
        try{ saveState(); }catch(e){ console.warn('saveState failed on challenge click', e); }
        try{ rollLearnSkill('challenge'); }catch(e){ console.warn('rollLearnSkill failed on delegated challenge', e); }
        try{ checkProgressionUpgrades('challenge'); }catch(e){ console.warn('checkProgressionUpgrades after challenge failed', e); }
        try{ renderChallenges(); }catch(e){ console.warn('renderChallenges failed', e); }
      });
    }
  }catch(e){ console.warn('challenge delegation failed', e); }
  // show default screen
  showScreen('screen-stats');
  // render challenges & quests so content exists even if the user navigates quickly
  renderChallenges();
  renderQuests();
  // set avatar preview from state if present
  try{
    const aImg = document.getElementById('player-avatar-img');
    if(aImg){
      if(state.avatar && typeof state.avatar === 'string' && state.avatar.length > 20){
        aImg.src = state.avatar;
      } else {
        // fallback avatar (small emoji as data URL using SVG) - we can use a simple inline SVG data URI
        aImg.src = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="#082023" width="100%" height="100%" rx="8"/><text x="50%" y="54%" font-size="36" text-anchor="middle" fill="#dff6ff" font-family="Arial">🙂</text></svg>');
      }
    }
  }catch(e){console.warn('set avatar preview failed', e)}
  // wire Ability Points allocator: clicking the available value opens allocator
  try{
    const availEl = document.getElementById('available');
    if(availEl){
      availEl.style.cursor = 'pointer';
      availEl.title = 'Click to allocate Ability Points';
      availEl.addEventListener('click', ()=>{
        try{ showAllocateModal(); }catch(e){console.warn('open alloc failed', e)}
      });
    }
  }catch(e){console.warn('wire alloc failed', e)}
  // wire Inventory button
  try{
    const invBtn = document.getElementById('open-inventory');
    if(invBtn){ invBtn.addEventListener('click', ()=>{ showInventoryModal({ inBattle: false }); }); }
  }catch(e){ console.warn('wire inventory failed', e); }
  // wire Battle Use Item button
  try{
    const battleUse = document.getElementById('battle-use-item');
    if(battleUse){ battleUse.addEventListener('click', ()=>{ showInventoryModal({ inBattle: true, onlyConsumables: true }); }); }
  }catch(e){ console.warn('wire battle use failed', e); }
  // wire Battle Use Skill button
  try{
    const battleSkill = document.getElementById('battle-use-skill');
    if(battleSkill){ battleSkill.addEventListener('click', ()=>{ showSkillModal({ inBattle: true }); }); }
  }catch(e){ console.warn('wire battle skill failed', e); }
  // wire personal workout submit
  try{
    const pbtn = document.getElementById('personal-workout-submit');
    if(pbtn){ pbtn.addEventListener('click', ()=>{ try{ submitPersonalWorkout(); }catch(e){ console.warn('submit personal failed', e); } }); }
  }catch(e){ console.warn('wire personal workout failed', e); }
  // render existing history into the Tasks screen
  try{ renderPersonalHistory(); }catch(e){}
  // process any missed recovery since last session and start ticker
  try{ processRecoverySinceLastCheck(); }catch(e){}
  try{ startRecoveryTicker(); }catch(e){}
});

// Show allocation modal to distribute ability points across stats
function showAllocateModal(){
  const available = Math.max(0, Number(state.available || 0));
  // build modal DOM
  const overlay = document.createElement('div'); overlay.className = 'alloc-overlay';
  const box = document.createElement('div'); box.className = 'alloc-modal';
  const title = document.createElement('h3'); title.textContent = `Allocate Ability Points (${available} available)`;
  box.appendChild(title);

  // local working copy of stats
  const working = Object.assign({}, state.stats);
  const allocated = {spent:0};
  const statKeys = ['str','vit','agi','per','int'];
  const rows = {};

  statKeys.forEach(k=>{
    const row = document.createElement('div'); row.className = 'alloc-row';
    const name = document.createElement('div'); name.className = 'stat-name'; name.textContent = k.toUpperCase();
    const controls = document.createElement('div'); controls.className = 'alloc-controls';
    const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−';
    const val = document.createElement('div'); val.className = 'stat-val'; val.textContent = String(working[k] || 0);
    const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+';
    controls.appendChild(minus); controls.appendChild(val); controls.appendChild(plus);
    row.appendChild(name); row.appendChild(controls);
    box.appendChild(row);
    rows[k] = {valEl: val};

    minus.addEventListener('click', ()=>{
      if((working[k]||0) <= (state.stats[k]||0)) return; // can't go below original
      working[k] = Math.max(state.stats[k]||0, (working[k]||0) - 1);
      allocated.spent = computeSpent();
      rows[k].valEl.textContent = String(working[k]);
      title.textContent = `Allocate Ability Points (${available - allocated.spent} available)`;
    });
    plus.addEventListener('click', ()=>{
      if(allocated.spent >= available) return; // no more points
      working[k] = (working[k]||0) + 1;
      allocated.spent = computeSpent();
      rows[k].valEl.textContent = String(working[k]);
      title.textContent = `Allocate Ability Points (${available - allocated.spent} available)`;
    });
  });

  function computeSpent(){
    let s = 0; statKeys.forEach(k=>{ s += Math.max(0, (working[k]||0) - (state.stats[k]||0)); }); return s;
  }

  // footer actions
  const footer = document.createElement('div'); footer.className = 'alloc-footer';
  const btnCancel = document.createElement('button'); btnCancel.type = 'button'; btnCancel.className = 'cancel'; btnCancel.textContent = 'Cancel';
  const btnConfirm = document.createElement('button'); btnConfirm.type = 'button'; btnConfirm.className = 'confirm'; btnConfirm.textContent = 'Confirm';
  footer.appendChild(btnCancel); footer.appendChild(btnConfirm);
  box.appendChild(footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function close(){ try{ document.body.removeChild(overlay); }catch(e){} }
  btnCancel.addEventListener('click', ()=>{ close(); });
  btnConfirm.addEventListener('click', async ()=>{
    const spent = computeSpent();
    if(spent <= 0){ close(); return; }
    // apply working stats and deduct available
    statKeys.forEach(k=>{ state.stats[k] = working[k] || 0; });
    state.available = Math.max(0, (state.available || 0) - spent);
    try{ await saveState(); }catch(e){ console.warn('save alloc failed', e); }
    close(); render();
  });
  // allow clicking overlay to cancel
  overlay.addEventListener('click', (ev)=>{ if(ev.target === overlay) close(); });
}
