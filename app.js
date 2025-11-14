const STORAGE_KEY = 'fighterQuestState_v1';

console.log('app.js loading');

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

// --- Auto-recovery configuration and helpers (fatigue, HP, MP) ---
const RECOVER_INTERVAL_MS = 300; // 0.3 seconds per recovery tick
const RECOVER_STAMINA_PER_TICK = 1; // restore stamina by 1 per tick
const RECOVER_HP_PER_TICK = 1; // restore HP by 1 per tick
const RECOVER_MP_PER_TICK = 1; // restore MP by 1 per tick

function applyRecoveryTick(ticks){
  if(!ticks || ticks <= 0) return;
  let changed = false;
  // stamina increases (resource restores over time)
  let stamDelta = 0;
  if(state.stamina && typeof state.stamina.cur === 'number' && typeof state.stamina.max === 'number'){
    const prevStam = state.stamina.cur || 0;
    const newStam = Math.min(state.stamina.max, prevStam + ticks * RECOVER_STAMINA_PER_TICK);
    stamDelta = Math.max(0, newStam - prevStam);
    state.stamina.cur = newStam;
    if(stamDelta) changed = true;
  }
  // hp increases
  let hpDelta = 0;
  if(state.hp && typeof state.hp.cur === 'number' && typeof state.hp.max === 'number'){
    const prev = state.hp.cur;
    const newHp = Math.min(state.hp.max, state.hp.cur + ticks * RECOVER_HP_PER_TICK);
    hpDelta = Math.max(0, newHp - prev);
    state.hp.cur = newHp;
    if(hpDelta) changed = true;
  }
  // mp increases
  let mpDelta = 0;
  if(state.mp && typeof state.mp.cur === 'number' && typeof state.mp.max === 'number'){
    const prevm = state.mp.cur;
    const newMp = Math.min(state.mp.max, state.mp.cur + ticks * RECOVER_MP_PER_TICK);
    mpDelta = Math.max(0, newMp - prevm);
    state.mp.cur = newMp;
    if(mpDelta) changed = true;
  }
  if(changed){
    state.recoveryLast = Date.now();
    saveState();
    render();
    // show small popups near the relevant UI elements
    try{
      if(hpDelta > 0){
        const el = document.getElementById('hp-text') || document.getElementById('hp-fill');
        showRecoveryPopup('hp', hpDelta, el);
      }
      if(mpDelta > 0){
        const el = document.getElementById('mp-text') || document.getElementById('mp-fill');
        showRecoveryPopup('mp', mpDelta, el);
      }
        if(stamDelta > 0){
          const el = document.getElementById('stam-text');
          showRecoveryPopup('stam', stamDelta, el);
        }
    }catch(e){console.warn('recovery popup failed', e)}
  }
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
    // position near targetEl
    if(targetEl){
      const r = targetEl.getBoundingClientRect();
      div.style.left = (r.left + r.width/2) + 'px';
      div.style.top = (r.top - 10) + 'px';
    } else {
      div.style.left = '50%';
      div.style.top = '20%';
    }
    requestAnimationFrame(()=> div.classList.add('show'));
    setTimeout(()=>{ try{ document.body.removeChild(div); }catch(e){} }, 1000);
  }catch(e){console.warn('showRecoveryPopup failed', e)}
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
    applyRecoveryTick(1);
  }, RECOVER_INTERVAL_MS);
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

function tieredRequirement(base, level){
  // Tiered scaling: every 5 levels increases requirement by 10%
  const tiers = Math.floor((level - 1) / 5);
  const multiplier = 1 + 0.10 * tiers;
  return Math.max(1, Math.ceil(base * multiplier));
}

// --- Challenges & Quests data ---
const CHALLENGES = [
  {id:'c1', label:'50 push-ups', type:'pushups', amount:50, xp:60},
  {id:'c2', label:'100 push-ups', type:'pushups', amount:100, xp:120},
  {id:'c3', label:'150 push-ups', type:'pushups', amount:150, xp:200},
  {id:'c4', label:'50 sit-ups', type:'situps', amount:50, xp:50},
  {id:'c5', label:'100 sit-ups', type:'situps', amount:100, xp:110}
];

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
    out.push({ id, name, level, reward, stamina });
  }
  return out;
}

// Default QUESTS: generate 100 enemies (can be adjusted)
const QUESTS = generateQuests(100);

// Pagination for quest list
const QUESTS_PER_PAGE = 5;
let questsPage = 0; // zero-based

function getQuestsTotalPages(){
  return Math.max(1, Math.ceil((QUESTS && QUESTS.length) ? QUESTS.length / QUESTS_PER_PAGE : 1));
}

function changeQuestsPage(delta){
  const total = getQuestsTotalPages();
  questsPage = Math.max(0, Math.min(total - 1, questsPage + delta));
  renderQuests();
  // scroll quests area into view for convenience
  const wrap = document.getElementById('quests-list'); if(wrap) wrap.scrollIntoView({behavior:'smooth', block:'start'});
}

// Returns a portrait/icon for a quest so the same symbol is used across screens
function getPortraitForQuest(q){
  if(!q) return '👾';
  if(q.id === 'q1' || /wolf/i.test(q.name)) return '🐺';
  if(q.id === 'q2' || /bandit|scout/i.test(q.name)) return '🪓';
  if(q.id === 'q3' || /orc/i.test(q.name)) return '👹';
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
  const box = document.createElement('div');
  box.className = 'user-guide';
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
  wrap.innerHTML = '';
  CHALLENGES.forEach(ch =>{
    const done = !!state.challenges[ch.id];
    const div = document.createElement('div');
    div.className = 'challenge';
    // create a modern task-like button for challenges
    const btn = document.createElement('button');
    btn.className = 'task-btn';
    btn.type = 'button';
    btn.dataset.id = ch.id;
    btn.dataset.xp = ch.xp;
    btn.innerHTML = `<span class="task-main">${ch.label} — ${ch.amount}</span><span class="task-check">✓</span>`;
    if(done) btn.classList.add('completed');
    btn.disabled = !!done;
    btn.addEventListener('click', ()=>{
      // mark completed and grant XP
      state.challenges[ch.id] = true;
      showXPPopup(ch.xp);
      grantXP(ch.xp);
      saveState();
      renderChallenges();
    });
    div.appendChild(btn);
    wrap.appendChild(div);
  });
}

function renderQuests(){
  const wrap = document.getElementById('quests-list');
  if(!wrap) return;
  wrap.innerHTML = '';
  const total = getQuestsTotalPages();
  // clamp page
  if(questsPage < 0) questsPage = 0;
  if(questsPage > total - 1) questsPage = total - 1;
  const start = questsPage * QUESTS_PER_PAGE;
  const end = Math.min(QUESTS.length, start + QUESTS_PER_PAGE);
  const slice = QUESTS.slice(start, end);
  slice.forEach(q=>{
    // derive some enemy stats for display only (based on level)
    const enemyHPMax = Math.max(24, q.level * 30);
    const enemyHP = enemyHPMax; // current = max (full)
    const enemyMPMax = Math.max(8, Math.floor(q.level * 3));
    const enemyMP = enemyMPMax; // current = max (full)
    const enemyStamMax = 100;
    const enemyStam = enemyStamMax; // show full stamina for enemy
    const enemySTR = Math.max(1, Math.floor(q.level * 1.2));
    const enemyVIT = Math.max(1, Math.floor(q.level * 1.0));

    const div = document.createElement('div');
    div.className = 'opponent';
    div.innerHTML = `
      <div class="opponent-card">
        <div class="opp-left"><div class="opp-portrait" aria-hidden="true">${getPortraitForQuest(q)}</div></div>
        <div class="opp-body">
          <div class="opp-header"><div class="opp-name">${q.name}</div><div class="opp-meta">Lv. ${q.level}</div></div>
          <div class="opp-bars">
            <div class="bar-row small"><div class="bar-label">HP</div><div class="bar-wrap small"><div class="bar-bg"><div class="bar-fill hp" style="width:100%"></div></div><div class="bar-text">${enemyHP} / ${enemyHPMax}</div></div></div>
            <div class="bar-row small"><div class="bar-label">MP</div><div class="bar-wrap small"><div class="bar-bg"><div class="bar-fill mp" style="width:100%"></div></div><div class="bar-text">${enemyMP} / ${enemyMPMax}</div></div></div>
            <div class="bar-row small"><div class="bar-label">STA</div><div class="bar-wrap small"><div class="bar-bg"><div class="bar-fill stam" style="width:100%"></div></div><div class="bar-text">${enemyStam} / ${enemyStamMax}</div></div></div>
          </div>
          <div class="opp-stats">
            <div class="stat-badge"><strong>STR</strong>: ${enemySTR}</div>
            <div class="stat-badge"><strong>VIT</strong>: ${enemyVIT}</div>
            <div class="stat-badge"><strong>SPD</strong>: ${Math.max(1, Math.floor(q.level/2))}</div>
          </div>
        </div>
        <div class="opp-actions"><button data-id="${q.id}" class="fight-btn">Fight</button></div>
      </div>
    `;
    const btn = div.querySelector('button.fight-btn');
    if(btn) btn.addEventListener('click', ()=>startBattle(q));
    wrap.appendChild(div);
  });
  // update pager display
  try{
    const pageEl = document.getElementById('quests-page');
    const prev = document.getElementById('quests-prev');
    const next = document.getElementById('quests-next');
    if(pageEl) pageEl.textContent = `${questsPage + 1} / ${total}`;
    if(prev) prev.disabled = (questsPage <= 0);
    if(next) next.disabled = (questsPage >= total - 1);
  }catch(e){/* ignore */}
}

// --- Turn-based battle system (multi-turn UI) ---
let battleState = null; // holds current battle session

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

async function playerAttack(){
  if(!battleState) return;
  const base = Math.max(1, Math.round((state.stats.str || 0) * 1.1 + state.level * 1.5));
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
  const base = Math.max(1, Math.ceil(((battleState.enemy.level || 1) * 10 - Math.floor((state.stats.str||0) * 0.8)) / 6));
  const variance = Math.floor(Math.random() * Math.max(1, Math.floor(((battleState.enemy.level || 1) * 10) / 12)));
  let dmg = base + variance;
  if(battleState.playerDefending) dmg = Math.max(0, Math.floor(dmg * 0.5));
  // mitigate by player's vit
  dmg = Math.max(0, dmg - Math.floor((state.stats.vit || 0) / 6));
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
  const statsSum = (state.stats.str||0) + (state.stats.agi||0) + (state.stats.per||0) + (state.stats.vit||0) + (state.stats.int||0);
  const playerPower = (state.level || 1) * 10 + statsSum;
  const opponentPower = (typeof opponent.power === 'number') ? opponent.power : ((typeof opponent.level === 'number') ? opponent.level * 10 : 10);
  log.textContent += `You engage ${opponent.name} (Lv. ${opponent.level || '?'} — power ${opponentPower})\n`;
  const roll = Math.floor(Math.random() * 40) - 10; // -10..29
  const effective = playerPower + roll;
  log.textContent += `Your effective power: ${effective} (base ${playerPower}, roll ${roll})\n`;
  // Player stamina is a positive resource; higher stamina provides a small bonus to VIT
  const playerStamina = (state.stamina && typeof state.stamina.cur === 'number') ? state.stamina.cur : 0;
  const effectiveVIT = Math.max(0, (state.stats.vit || 0) + Math.floor(playerStamina / 5));
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

  // Requirements (tiered scaling by 5-level chunks)
  document.getElementById('daily-req').textContent = tieredRequirement(state.taskBase.dailyJumpingJacks, state.level);
  document.getElementById('weekly-push').textContent = tieredRequirement(state.taskBase.weeklyPushups, state.level);
  document.getElementById('weekly-squat').textContent = tieredRequirement(state.taskBase.weeklySquats, state.level);
  document.getElementById('weekly-sit').textContent = tieredRequirement(state.taskBase.weeklySitups, state.level);
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
    const deltas = {};
    ['str','agi','per','vit','int'].forEach(k=>{ deltas[k] = (state.stats[k] || 0) - (oldStats[k] || 0); });
    try{ showStatPopup(deltas); }catch(e){}
    try{ showLevelUpParticles(); }catch(e){}
  }
  saveState();
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
  if(completed && !state.tasks[key].completed){
    state.tasks[key].completed = true;
    // show animated XP popup when marking completed, then grant XP
    showXPPopup(xpReward);
    grantXP(xpReward);
  }else if(!completed && state.tasks[key].completed){
    state.tasks[key].completed = false;
  }
  saveState();
  render();
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
  // create a small badge so we can visually confirm JS ran
  try{
    let badge = document.getElementById('js-badge');
    if(!badge){
      badge = document.createElement('div');
      badge.id = 'js-badge';
      badge.style.position = 'fixed';
      badge.style.left = '12px';
      badge.style.bottom = '14px';
      badge.style.padding = '6px 8px';
      badge.style.background = 'rgba(14,160,255,0.12)';
      badge.style.color = '#bfeaff';
      badge.style.border = '1px solid rgba(14,160,255,0.14)';
      badge.style.borderRadius = '6px';
      badge.style.fontSize = '12px';
      badge.textContent = 'JS loaded';
      badge.style.zIndex = '9999';
      document.body.appendChild(badge);
    }
  }catch(e){console.warn('Badge creation failed', e)}
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
  // process any missed recovery since last session and start ticker
  try{ processRecoverySinceLastCheck(); }catch(e){}
  try{ startRecoveryTicker(); }catch(e){}
});
