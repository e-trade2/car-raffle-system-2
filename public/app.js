if (window.Telegram && window.Telegram.WebApp) {
  Telegram.WebApp.ready();
  Telegram.WebApp.expand();
}

const API = '/api';

// Raffle titles, subtitles, image URLs and bank details are admin-supplied
// and rendered via innerHTML below. Escaping them means a bad/compromised
// admin entry can't inject a script that runs in every visitor's browser.
function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

// The leading number shown before a raffle's title (e.g. "3 Gech EV Makina
// Equb") is set explicitly by the admin per raffle (raffle.raffleNumber),
// not typed into the title text by hand - keeps it consistent even if the
// title itself gets edited later.
function raffleDisplayTitle(raffle){
  return raffle.raffleNumber ? `${raffle.raffleNumber} ${raffle.title}` : raffle.title;
}

// Used only on the checkout confirmation card (Step 1 of 3, see
// renderCheckoutStep1 below) - shows "<raffleNumber> Gech EV Makina Equb"
// instead of the raffle's real title there. Every other place a raffle's
// title is shown (home cards, detail page, mini cards) still calls
// raffleDisplayTitle() above and keeps showing the actual title untouched.
function checkoutSummaryTitle(raffle){
  return raffle.raffleNumber ? `${raffle.raffleNumber} Gech EV Makina Equb` : 'Gech EV Makina Equb';
}

function copyToClipboard(text){
  if (navigator.clipboard && window.isSecureContext){
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject)=>{
    try{
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    }catch(err){ reject(err); }
  });
}

const TEXT = {
  en: {
    backLabel:"Back", cdLabel:"Time Remaining",
    cdDaysLbl:"Days", cdHoursLbl:"Hrs", cdMinsLbl:"Min", cdSecsLbl:"Sec",
    soldLbl:"sold", filledLbl:"filled", remainLbl:"tickets remaining",
    participantsLbl:"Participants", buyTicket:"Buy Ticket",
    priceLbl:"Ticket Price", pickLabel:"Select your lucky numbers",
    buyLabel:"Quick Pick", selectedNumsLbl:"Selected numbers:", selectBtnLabel:"Buy Ticket",
    navHome:"Home", navTickets:"Tickets", navProfile:"Profile",
    myTicketsTitle:"My Tickets",
    toastSoon:"Coming soon", toastPicked:"numbers selected",
    confirmSelection:"Confirm Selection", selectNumberLbl:"Select Number", doneLbl:"Done",
    orderConfirmTitle:"Confirm your order", orderPaymentTitle:"Payment",
    orderStatusTitle:"Order submitted", orderReviewTitle:"Review Order",
    orderSummaryTitle:"Order Summary",
    bankLbl:"Bank", submitOrderLbl:"Submit Order",
    reviewNoteMsg:"Your tickets will be reviewed and confirmed within 24 hours.",
    fullNameLbl:"Full Name", phoneLbl:"Phone Number",
    fullNamePlaceholder:"Enter your full name",
    fillNamePhoneMsg:"Please fill in your name and phone number",
    fillNameMsg:"Please enter your full name",
    fillPhoneMsg:"Please enter your phone number",
    stepOfLbl:"Step {n} of {total}", ticketsUnitLbl:"tickets",
    ticketsLbl:"Tickets", ticketNumbersLbl:"Ticket Numbers", totalLbl:"Total", itemLbl:"Item",
    continueLbl:"Continue", submitPaymentLbl:"Submit Payment",
    uploadHint:"Tap to upload your payment receipt", uploadSizeHint:"PNG or JPG up to 10MB",
    senderAccountLbl:"Sent from account number (optional)",
    senderAccountPlaceholder:"Account you sent money from",
    waitingApproval:"Your order is awaiting admin approval. We'll notify you once confirmed.",
    orderSentTitle:"Order Sent!", orderSentMsg:"Order #{id} was sent successfully. Payment confirmation may take up to 24 hours.", closeLbl:"Close",
    ticketNo:"Ticket #", banksLbl:"Select bank to view account (optional)",
    notifTitle:"Notifications", latestWinnersLbl:"Latest Winners", myTicketsLblNotif:"My Tickets",
    noWinnersLbl:"No winners announced yet", noTicketsLbl:"No tickets found",
    wonLbl:"won ticket", noTicketsHint:"Place an order and check My Tickets to see your history here.",
    legendSelectedLbl:"Selected", legendTakenLbl:"Taken", legendFreeLbl:"Free",
    announcementsLbl:"Announcements", noAnnouncementsLbl:"No announcements yet",
    lotteryLbl:"Lottery", winningTicketLbl:"Winning Ticket", prizeLbl:"Prize",
    tabAllLbl:"All", tabFeaturedLbl:"Featured", tabNewLbl:"New",
    badgeFeaturedLbl:"Featured",
    ongoingRafflesLbl:"Ongoing raffles", availableLbl:"available",
    newBadgeLbl:"NEW",
  },
  am: {
    backLabel:"ተመለስ", cdLabel:"የቀረው ጊዜ",
    cdDaysLbl:"ቀናት", cdHoursLbl:"ሰዓት", cdMinsLbl:"ደቂቃ", cdSecsLbl:"ሰከንድ",
    soldLbl:"ተሸጠዋል", filledLbl:"ተሞልቷል", remainLbl:"ትኬት ቀርቷል",
    participantsLbl:"ተሳታፊዎች", buyTicket:"ትኬት ይግዙ",
    priceLbl:"የትኬት ዋጋ", pickLabel:"የዕድል ቁጥሮችዎን ይምረጡ",
    buyLabel:"ፈጣን ምርጫ", selectedNumsLbl:"የመረጡት ቁጥሮች፡", selectBtnLabel:"ትኬት ይግዙ",
    navHome:"Home", navTickets:"ትኬቶች", navProfile:"መገለጫ",
    myTicketsTitle:"የኔ ትኬቶች",
    toastSoon:"በቅርቡ ይመጣል", toastPicked:"ቁጥር ተመርጠዋል",
    confirmSelection:"ምርጫ አረጋግጥ", selectNumberLbl:"ቁጥር ምረጥ", doneLbl:"ጨርስ",
    orderConfirmTitle:"ግዢዎን ያጠናቁ", orderPaymentTitle:"ግዢዎን ያጠናቁ",
    orderStatusTitle:"ትዕዛዝ ገብቷል", orderReviewTitle:"ግዢዎን ያጠናቁ",
    orderSummaryTitle:"የትዕዛዝ ማጠቃለያ",
    bankLbl:"ባንክ", submitOrderLbl:"ትዕዛዝ ላክ",
    reviewNoteMsg:"ትኬቶቻችሁ ይጠበቃሉ፣ ክፍያዎም በ24 ሰዓት ውስጥ ይረጋገጣል።",
    fullNameLbl:"ሙሉ ስም", phoneLbl:"ስልክ ቁጥር",
    fullNamePlaceholder:"ሙሉ ስምዎን ያስገቡ",
    fillNamePhoneMsg:"እባክዎ ሙሉ ስምዎን እና ስልክ ቁጥርዎን ያስገቡ",
    fillNameMsg:"እባክዎ ሙሉ ስምዎን ያስገቡ",
    fillPhoneMsg:"እባክዎ ስልክ ቁጥርዎን ያስገቡ",
    stepOfLbl:"ደረጃ {n} ከ {total}", ticketsUnitLbl:"ቲኬቶች",
    ticketsLbl:"ቲኬቶች", ticketNumbersLbl:"የተመረጡ ቁጥሮች", totalLbl:"ጠቅላላ", itemLbl:"ዕጣ",
    continueLbl:"ቀጥል", submitPaymentLbl:"ክፍያ አስገባ",
    uploadHint:"የክፍያ ማረጋገጫ ያስገቡ", uploadSizeHint:"PNG ወይም JPG እስከ 10MB",
    senderAccountLbl:"የላኩበት ሂሳብ ቁጥር (አማራጭ)",
    senderAccountPlaceholder:"ገንዘብ የላኩበት ሂሳብ",
    waitingApproval:"ትዕዛዝዎ በአስተዳዳሪ እየተጠበቀ ነው። ሲረጋገጥ እናሳውቅዎታለን።",
    orderSentTitle:"ግዢው ተልኳል!", orderSentMsg:"ትዕዛዝ #{id} በተሳካ ሁኔታ ተልኳል። የክፍያ ማረጋገጫ እስከ 24 ሰዓት ሊወስድ ይችላል።", closeLbl:"ዝጋ",
    ticketNo:"ትኬት ቁ.", banksLbl:"ክፍያ ለመላክ የባንክ ሂሳብ ይምረጡ",
    notifTitle:"ማሳወቂያዎች", latestWinnersLbl:"የቅርብ ጊዜ አሸናፊዎች", myTicketsLblNotif:"የኔ ትኬቶች",
    noWinnersLbl:"እስካሁን አሸናፊ አልታወጀም", noTicketsLbl:"ምንም ትኬት አልተገኘም",
    wonLbl:"ትኬት አሸንፏል", noTicketsHint:"ትዕዛዝ ካስገቡ በኋላ የትኬት ታሪክዎን እዚህ ለማየት 'የኔ ትኬቶች' ይመልከቱ።",
    legendSelectedLbl:"የተመረጠ", legendTakenLbl:"የተያዘ", legendFreeLbl:"ክፍት",
    announcementsLbl:"ማስታወቂያዎች", noAnnouncementsLbl:"እስካሁን ምንም ማስታወቂያ የለም",
    lotteryLbl:"ሎተሪ", winningTicketLbl:"አሸናፊ ትኬት", prizeLbl:"ሽልማት",
    tabAllLbl:"ሁሉም", tabFeaturedLbl:"ተመራጭ", tabNewLbl:"አዲስ",
    badgeFeaturedLbl:"ተመራጭ",
    ongoingRafflesLbl:"በመካሄድ ላይ ያሉ ዕጣዎች", availableLbl:"ያሉ",
    newBadgeLbl:"አዲስ",
  },
  om: {
    backLabel:"Duubatti", cdLabel:"GUYYA XUMURRA",
    cdDaysLbl:"GYYOOTA", cdHoursLbl:"SA'A", cdMinsLbl:"DAQIIQAA", cdSecsLbl:"SEKONDII",
    soldLbl:"gurgurame", filledLbl:"guutame", remainLbl:"tiketeewwan hafan",
    participantsLbl:"Hirmaattota", buyTicket:"Tikeetii Kutadhu",
    priceLbl:"GATII TIKKEETTII", pickLabel:"Lakkofsa Carraa Kee Fili",
    buyLabel:"Galmee Ariifataa", selectedNumsLbl:"Lakkoofsa filatte:", selectBtnLabel:"Tikeeti Kutadhu",
    navHome:"Home", navTickets:"Tikeetii", navProfile:"Proofaayilii",
    myTicketsTitle:"Tikeetii Koo",
    toastSoon:"Dhiyootti ni dhufa", toastPicked:"lakkoofsi filatame",
    confirmSelection:"Filannoo Mirkaneessi", selectNumberLbl:"Lakkoofsa Filadhu", doneLbl:"Xumuri",
    orderConfirmTitle:"Bitta Xumuri", orderPaymentTitle:"Bitta Xumuri",
    orderStatusTitle:"Ajajni ergameera", orderReviewTitle:"Bittaa Xummri",
    orderSummaryTitle:"Cuunfaa Ajajaa",
    bankLbl:"Baankii", submitOrderLbl:"Ajaja Ergi",
    reviewNoteMsg:"Tikeetiin keessan ni ilaalama, kaffaltiinis sa'aatii 24 keessatti ni mirkanaa'a.",
    fullNameLbl:"Maqaa Guutuu", phoneLbl:"Lakkoofsa Bilbilaa",
    fullNamePlaceholder:"Maqaa keessan guutuu galchaa",
    fillNamePhoneMsg:"Maaloo maqaa keessan guutuu fi lakkoofsa bilbilaa keessan galchaa",
    fillNameMsg:"Maaloo maqaa keessan guutuu galchaa",
    fillPhoneMsg:"Maaloo lakkoofsa bilbilaa keessan galchaa",
    stepOfLbl:"Tarkaanfii {n} keessaa {total}", ticketsUnitLbl:"tiketeewwan",
    ticketsLbl:"Tiketeewwan", ticketNumbersLbl:"Lakkoofsa Kee", totalLbl:"Waliigala", itemLbl:"Loterii",
    continueLbl:"Itti Fufi", submitPaymentLbl:"Kaffaltii Ergi",
    uploadHint:"Suura ragaa fe'uuf tuqi", uploadSizeHint:"PNG ykn JPG hanga 10MB",
    senderAccountLbl:"Lakkoofsa Herrga Kee(Dirqama Miti)",
    senderAccountPlaceholder:"Herrega irraa ergite",
    waitingApproval:"Ajajni keessan mirkaneeffannaa admin eegaa jira. Yeroo mirkanaa'utti isin beeksisna.",
    orderSentTitle:"Ajajni Ergameera!", orderSentMsg:"Ajaja #{id} milkaa'inaan ergameera. Mirkaneessuun kaffaltii sa'aatii 24 fudhachuu danda'a.", closeLbl:"Cufi",
    ticketNo:"Lakk. Tikeetii", banksLbl:"Kaffaltii dabarsuuf herrega baankii fili",
    notifTitle:"Beeksisoota", latestWinnersLbl:"Injifattoota Dhiyoo", myTicketsLblNotif:"Tikeetii Koo",
    noWinnersLbl:"Hanga ammaatti injifataan hin labsamne", noTicketsLbl:"Tikeetiin hin argamne",
    wonLbl:"tikeetii mo'ate", noTicketsHint:"Ajaja erga galchitanii booda seenaa tikeetii keessan asirratti ilaaluuf 'Tikeetii Koo' ilaalaa.",
    legendSelectedLbl:"Filatame", legendTakenLbl:"Gurgurame", legendFreeLbl:"Jira",
    announcementsLbl:"Beeksisoota", noAnnouncementsLbl:"Hanga ammaatti beeksisni hin jiru",
    lotteryLbl:"Lootarii", winningTicketLbl:"Tikeetii Injifate", prizeLbl:"Badhaasa",
    tabAllLbl:"Hundaa", tabFeaturedLbl:"Filatamoo", tabNewLbl:"Haaraa",
    badgeFeaturedLbl:"Addaa",
    ongoingRafflesLbl:"Lotoriwwan Jiran", availableLbl:"jira",
    newBadgeLbl:"HAARAA",
  }
};
const LANG_NAME = { en:"English", am:"አማርኛ", om:"Afaan Oromo" };
const SUPPORTED_LANGS = ['om', 'am', 'en'];

// Direct bot -> mini app language handoff: the bot appends ?lang=om/am/en
// to the web_app URL for the language the person just picked in the bot,
// seconds before tapping "open app". That's a stronger, more immediate
// signal than the /telegram/prefill round trip below (which needs
// INTERNAL_API_KEY + TELEGRAM_BOT_TOKEN configured and only resolves after
// an async fetch), so it wins over whatever's in localStorage - including
// a previous in-app manual pick, since picking a language in the bot right
// before opening is just as much a deliberate choice as tapping it in-app.
const urlLang = new URLSearchParams(window.location.search).get('lang');
if (urlLang && SUPPORTED_LANGS.includes(urlLang)) {
  localStorage.setItem('lang', urlLang);
  localStorage.setItem('langUserSet', '1');
}

let currentLang = localStorage.getItem('lang') || 'en';

function t(key){ return (TEXT[currentLang] && TEXT[currentLang][key]) || TEXT.en[key] || key; }

function applyLang(lang){
  currentLang = lang;
  localStorage.setItem('lang', lang);
  document.getElementById('langLabel').textContent = LANG_NAME[lang];
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('.lang-menu button').forEach(b=>{
    b.classList.toggle('active', b.dataset.lang === lang);
  });
  document.getElementById('navHome').textContent = t('navHome');
  document.getElementById('navTickets').textContent = t('navTickets');
  document.getElementById('navProfile').textContent = t('navProfile');
  document.getElementById('myTicketsTitle').textContent = t('myTicketsTitle');
  document.getElementById('notifModalTitle').textContent = t('notifTitle');
  document.getElementById('notifAnnouncementsTitle').textContent = t('announcementsLbl');
  document.getElementById('notifTicketsTitle').textContent = t('myTicketsLblNotif');
  if (currentRaffle) renderDetail(currentRaffle);
  renderHomeList();
  if (document.getElementById('notifModalBackdrop').classList.contains('show')) renderNotifPanel();
}

document.getElementById('globeBtn').addEventListener('click', ()=>{
  document.getElementById('langMenu').classList.toggle('show');
  document.getElementById('langBtn').classList.toggle('open');
});
document.getElementById('langBtn').addEventListener('click', ()=>{
  document.getElementById('langMenu').classList.toggle('show');
  document.getElementById('langBtn').classList.toggle('open');
});
document.querySelectorAll('.lang-menu button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    applyLang(btn.dataset.lang);
    // A manual in-app pick should stick - without this flag, the next
    // Telegram prefill (see prefillFromTelegram below) would silently
    // switch the language right back to whatever was last chosen in the
    // bot conversation, overriding what the person just picked here.
    localStorage.setItem('langUserSet', '1');
    document.getElementById('langMenu').classList.remove('show');
    document.getElementById('langBtn').classList.remove('open');
  });
});
document.addEventListener('click', (e)=>{
  if (!e.target.closest('.lang-wrap')) {
    document.getElementById('langMenu').classList.remove('show');
    document.getElementById('langBtn').classList.remove('open');
  }
});

// ===================== NOTIFICATIONS =====================
// "Seen" winners/announcements are tracked client-side only (by id) so the
// red dot clears once the buyer has actually opened the panel, without
// needing a server-side read-receipt for something this low-stakes.
function getSeenAnnouncementIds(){
  try{ return JSON.parse(localStorage.getItem('seenAnnouncementIds') || '[]'); }catch(e){ return []; }
}
function markAnnouncementsSeen(ids){
  localStorage.setItem('seenAnnouncementIds', JSON.stringify(ids));
}
function updateNotifDot(){
  const seenAnn = getSeenAnnouncementIds();
  const hasUnseenAnn = (announcements || []).some(a => !seenAnn.includes(a.id));
  document.getElementById('notifDot').style.display = hasUnseenAnn ? 'block' : 'none';
}
const ANN_ICON = { winner: '🏆', warning: '⚠️', update: '📢' };
function renderAnnouncementsSection(){
  const wrap = document.getElementById('notifAnnouncementsList');
  if (!wrap) return;
  if (!announcements || !announcements.length){
    wrap.innerHTML = `<div class="notif-empty-box">${t('noAnnouncementsLbl')}</div>`;
    return;
  }
  wrap.innerHTML = announcements.slice(0, 20).map(a => {
    if (a.type === 'winner' && a.winner){
      return `
      <div class="winner-card">
        <div class="winner-card-head">
          <div class="winner-card-id">👤 ${esc(a.winner.name)}${a.winner.phone ? ` · ${esc(a.winner.phone)}` : ''}</div>
          <div class="winner-card-trophy">🏆</div>
        </div>
        ${a.winner.lottery ? `
        <div class="winner-card-field">
          <div class="winner-card-field-label">${t('lotteryLbl')}</div>
          <div class="winner-card-field-value green">${esc(a.winner.lottery)}</div>
        </div>` : ''}
        <div class="winner-card-field">
          <div class="winner-card-field-label">${t('winningTicketLbl')}</div>
          <div class="winner-card-field-value gold">#${esc(a.winner.ticket)}</div>
        </div>
        ${a.winner.prize ? `
        <div class="winner-card-field">
          <div class="winner-card-field-label">${t('prizeLbl')}</div>
          <div class="winner-card-field-value">${esc(a.winner.prize)}</div>
        </div>` : ''}
        ${a.message ? `<div class="notif-card-msg" style="margin-top:10px;">${esc(a.message)}</div>` : ''}
        <div class="winner-card-time">🕐 ${new Date(a.createdAt).toLocaleString()}</div>
      </div>`;
    }
    return `
    <div class="notif-card" style="align-items:flex-start;">
      <div class="notif-icon notif-${a.type || 'update'}-icon">${ANN_ICON[a.type] || '📢'}</div>
      <div class="notif-card-body">
        <div class="notif-card-title">${esc(a.title)}</div>
        <div class="notif-card-msg">${esc(a.message)}</div>
        <div class="notif-card-sub">${new Date(a.createdAt).toLocaleString()}</div>
      </div>
    </div>`;
  }).join('');
}
function renderTicketsSection(orders){
  const wrap = document.getElementById('notifTicketsList');
  if (!orders || !orders.length){
    wrap.innerHTML = `<div class="notif-empty-box">${t('noTicketsLbl')}<div style="margin-top:6px;font-size:11.5px;">${t('noTicketsHint')}</div></div>`;
    return;
  }
  wrap.innerHTML = orders.slice(0, 6).map(o => `
    <div class="notif-card">
      <div class="notif-icon notif-ticket-icon">🎫</div>
      <div class="notif-card-body">
        <div class="notif-card-title">${esc(o.raffleTitle)}</div>
        <div class="notif-card-sub">${o.quantity} ${o.quantity === 1 ? 'ticket' : 'tickets'} · ${statusLabel(o.status)}</div>
      </div>
    </div>
  `).join('');
}
async function renderNotifPanel(){
  renderAnnouncementsSection();
  const phone = localStorage.getItem('phone') || '';
  const customerId = localStorage.getItem('customerId') || '';
  if (!phone || !customerId){ renderTicketsSection([]); return; }
  try{
    const res = await fetch(`${API}/tickets?phone=${encodeURIComponent(phone)}&customerId=${encodeURIComponent(customerId)}`);
    const data = await res.json();
    renderTicketsSection(res.ok ? (data.orders || []) : []);
  }catch(e){ console.error(e); renderTicketsSection([]); }
}
document.getElementById('notifBtn').addEventListener('click', ()=>{
  renderNotifPanel();
  document.getElementById('notifModalBackdrop').classList.add('show');
  markAnnouncementsSeen((announcements || []).map(a => a.id));
  updateNotifDot();
});
document.getElementById('notifModalClose').addEventListener('click', ()=>{
  document.getElementById('notifModalBackdrop').classList.remove('show');
});
document.getElementById('notifModalBackdrop').addEventListener('click', (e)=>{
  if (e.target.id === 'notifModalBackdrop') document.getElementById('notifModalBackdrop').classList.remove('show');
});

let isLight = false;
document.getElementById('themeBtn').addEventListener('click', ()=>{
  isLight = !isLight;
  document.documentElement.style.setProperty('--bg-base', isLight ? '#f4f6f3' : '#050807');
  document.documentElement.style.setProperty('--text-primary', isLight ? '#0e1a14' : '#f4f6f3');
  document.body.style.color = isLight ? '#0e1a14' : '#f4f6f3';
});

function pad(n){ return String(n).padStart(2,'0'); }
function fmtCountdown(drawAt){
  const diff = Math.max(0, new Date(drawAt) - Date.now());
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return { d:pad(d), h:pad(h), m:pad(m), s:pad(s) };
}

function showView(id){
  document.querySelectorAll('.view').forEach(v=> v.style.display = 'none');
  const el = document.getElementById(id);
  el.style.display = 'block';
  el.classList.remove('view-enter');
  void el.offsetWidth;
  el.classList.add('view-enter');
  window.scrollTo({ top:0, behavior:'auto' });
  document.querySelectorAll('.nav-item').forEach(n=> n.classList.remove('active'));
}
document.getElementById('navHomeItem').addEventListener('click', ()=>{ showView('homeView'); document.getElementById('navHomeItem').classList.add('active'); });
document.getElementById('navTicketsItem').addEventListener('click', ()=>{ showView('ticketsView'); document.getElementById('navTicketsItem').classList.add('active'); loadSavedPhoneIntoTickets(); });
document.getElementById('navProfileItem').addEventListener('click', ()=>{ showView('profileView'); document.getElementById('navProfileItem').classList.add('active'); loadProfile(); });
document.getElementById('navHomeItem').classList.add('active');

let toastTimer;
function showToast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove('show'), 2400);
}

// ===================== HOME =====================
let raffles = [];
let announcements = [];
let currentRaffle = null;

async function loadRaffles(){
  try{
    const res = await fetch(`${API}/raffles`);
    const data = await res.json();
    raffles = data.raffles || [];
    renderHomeList();
    updateNotifDot();
  }catch(e){
    console.error(e);
    showToast('Could not load raffles');
  }
}

async function loadAnnouncements(){
  try{
    const res = await fetch(`${API}/announcements`);
    const data = await res.json();
    announcements = data.announcements || [];
    updateNotifDot();
  }catch(e){ console.error(e); }
}

function carHtml(raffle){
  if (raffle.imageUrl) return `<img src="${esc(raffle.imageUrl)}" alt="${esc(raffle.title)}">`;
  return `<svg class="car-svg" viewBox="0 0 400 190">
    <ellipse cx="200" cy="168" rx="150" ry="10" fill="rgba(0,0,0,0.15)"/>
    <path d="M45 130 C45 95 75 78 120 70 L150 45 C160 38 178 33 200 33 C224 33 246 40 258 52 L282 72 C320 76 348 92 352 122 L352 138 L45 138 Z" fill="#c7cdc3" stroke="#8b948a" stroke-width="2"/>
    <path d="M150 46 C162 40 178 36 200 36 C222 36 240 42 252 52 L262 70 L145 70 Z" fill="#dfe3db" stroke="#8b948a" stroke-width="1.5"/>
    <rect x="153" y="50" width="45" height="18" rx="3" fill="#3b4640"/>
    <rect x="202" y="50" width="50" height="18" rx="3" fill="#3b4640"/>
    <circle cx="110" cy="140" r="26" fill="#1c1f1c"/><circle cx="110" cy="140" r="12" fill="#8d95a3"/>
    <circle cx="290" cy="140" r="26" fill="#1c1f1c"/><circle cx="290" cy="140" r="12" fill="#8d95a3"/>
  </svg>`;
}

function raffleCardHtml(raffle, idx){
  const badge = raffle.badge === 'hot' ? `<div class="badge-hot">🔥 ${t('badgeFeaturedLbl')}</div>`
    : raffle.badge === 'new' ? `<div class="badge-new">${t('newBadgeLbl')}</div>` : '';
  return `
  <div class="hero" style="margin-top:${idx>0?'14px':'0'};">
    <div class="hero-media${raffle.imageUrl ? '' : ' no-photo'}">
      ${badge}
      <div class="badge-rating">★★★★★</div>
      ${carHtml(raffle)}
    </div>
    <div class="hero-body">
      <div class="car-title">${esc(raffle.title)}</div>
      <div class="car-sub">${esc(raffle.subtitle||'')}</div>
      <div class="countdown-label">⏱ <span>${t('cdLabel')}</span></div>
      <div class="countdown" data-raffle="${raffle.id}">
        <div class="cd-box"><div class="cd-num" data-unit="days">--</div><div class="cd-lbl">${t('cdDaysLbl')}</div></div>
        <div class="cd-sep">:</div>
        <div class="cd-box"><div class="cd-num" data-unit="hours">--</div><div class="cd-lbl">${t('cdHoursLbl')}</div></div>
        <div class="cd-sep">:</div>
        <div class="cd-box"><div class="cd-num" data-unit="mins">--</div><div class="cd-lbl">${t('cdMinsLbl')}</div></div>
        <div class="cd-sep">:</div>
        <div class="cd-box"><div class="cd-num" data-unit="secs">--</div><div class="cd-lbl">${t('cdSecsLbl')}</div></div>
      </div>
      <div class="stats-block">
        <div class="stats-top">
          <div class="stats-sold"><b>${raffle.soldCount.toLocaleString()}</b> ${t('soldLbl')}</div>
          <div class="stats-pct">${raffle.percentFilled}% ${t('filledLbl')}</div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${raffle.percentFilled}%"></div></div>
        <div class="stats-remaining">${raffle.remaining.toLocaleString()} ${t('remainLbl')}</div>
        <div class="stats-bottom">
          <div class="participants">
            <div class="p-icon">👥</div>
            <div><div class="p-lbl">${t('participantsLbl')}</div><div class="p-num">${raffle.soldCount.toLocaleString()}</div></div>
          </div>
          <button class="buy-ticket-btn" data-open-detail="${raffle.id}"><span class="step-badge step-4">4</span><span>${t('buyTicket')}</span></button>
        </div>
      </div>
    </div>
  </div>`;
}

let homeTabFilter = 'all';

function miniCardHtml(raffle){
  const badge = raffle.badge === 'hot' ? `<span class="mini-card-badge">🔥 ${t('tabFeaturedLbl')}</span>`
    : raffle.badge === 'new' ? `<span class="mini-card-badge">${t('newBadgeLbl')}</span>` : '';
  const img = raffle.imageUrl ? `<img class="mini-card-img" src="${esc(raffle.imageUrl)}" alt="${esc(raffle.title)}">` : `<div class="mini-card-img"></div>`;
  return `
  <div class="mini-card" data-open-detail="${raffle.id}">
    ${img}
    <div class="mini-card-body">
      <div class="mini-card-title">${esc(raffle.title)}</div>
      <div class="mini-card-sub">${esc(raffle.subtitle||'')}</div>
      <div class="mini-card-meta">${badge}<span>${raffle.percentFilled}% ${t('filledLbl')}</span></div>
    </div>
  </div>`;
}

function renderHomeList(){
  const wrap = document.getElementById('raffleListHome');
  const empty = document.getElementById('homeEmpty');
  const active = raffles.filter(r=> r.status === 'active');
  const tabsEl = document.getElementById('homeTabs');
  const ongoingHead = document.getElementById('ongoingHead');
  const otherWrap = document.getElementById('otherRafflesList');
  const otherEmpty = document.getElementById('otherRafflesEmpty');

  if (active.length === 0){
    wrap.innerHTML = '';
    empty.style.display = 'block';
    tabsEl.style.display = 'none';
    ongoingHead.style.display = 'none';
    otherWrap.innerHTML = '';
    otherEmpty.style.display = 'none';
    return;
  }
  empty.style.display = 'none';

  // First active raffle is the main featured hero; the rest show as a
  // filterable "Ongoing raffles" list below.
  const [main, ...rest] = active;
  wrap.innerHTML = raffleCardHtml(main, 0);
  wrap.querySelectorAll('[data-open-detail]').forEach(btn=>{
    btn.addEventListener('click', ()=> openDetail(btn.dataset.openDetail));
  });

  tabsEl.style.display = 'flex';
  ongoingHead.style.display = 'flex';

  const filtered = rest.filter(r=> homeTabFilter === 'all' || r.badge === homeTabFilter);
  document.getElementById('ongoingCount').textContent = filtered.length;

  if (filtered.length === 0){
    otherWrap.innerHTML = '';
    otherEmpty.style.display = 'block';
  } else {
    otherEmpty.style.display = 'none';
    otherWrap.innerHTML = filtered.map(miniCardHtml).join('');
    otherWrap.querySelectorAll('[data-open-detail]').forEach(el=>{
      el.addEventListener('click', ()=> openDetail(el.dataset.openDetail));
    });
  }
}

document.getElementById('homeTabs').addEventListener('click', (e)=>{
  const tab = e.target.closest('.tab');
  if (!tab) return;
  homeTabFilter = tab.dataset.filter;
  document.querySelectorAll('#homeTabs .tab').forEach(t=> t.classList.toggle('active', t === tab));
  renderHomeList();
});

// ===================== DETAIL =====================
let qty = 1;
let selectedNumbers = [];
const MAX_TICKETS = 20; // max numbers a single order can contain

// Zero-pads a ticket number to match the width of the raffle's largest
// number (e.g. 91 -> "091" when totalNumbers is in the hundreds), so
// numbers line up consistently in the grid and in the selected chips.
function padNum(n){
  const width = currentRaffle ? String(currentRaffle.totalNumbers).length : 2;
  return String(n).padStart(width, '0');
}

async function openDetail(raffleId){
  try{
    const res = await fetch(`${API}/raffles/${raffleId}`);
    if (!res.ok){ showToast('Raffle not found'); return; }
    const data = await res.json();
    currentRaffle = data.raffle;
    qty = 1;
    selectedNumbers = [];
    renderDetail(currentRaffle);
    showView('detailView');
  }catch(e){ console.error(e); showToast('Could not load raffle'); }
}

function renderDetail(raffle){
  const el = document.getElementById('detailView');
  el.innerHTML = `
    <div class="back-row" id="backBtn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>${t('backLabel')}</span>
    </div>
    <div class="hero">
      <div class="hero-media${raffle.imageUrl ? '' : ' no-photo'}">
        ${raffle.badge === 'hot' ? `<div class="badge-hot">🔥 ${t('badgeFeaturedLbl')}</div>` : raffle.badge === 'new' ? `<div class="badge-new">${t('newBadgeLbl')}</div>` : ''}
        <div class="badge-rating">★★★★★ <span class="rating-num">${raffle.rating.toFixed(1)}</span></div>
        ${carHtml(raffle)}
      </div>
      <div class="hero-body">
        <div class="car-title">${esc(raffle.title)}</div>
        <div class="car-sub">${esc(raffle.subtitle||'')}</div>
        <div class="countdown-label">🔥 <span>${t('cdLabel')}</span></div>
        <div class="countdown" data-raffle="${raffle.id}">
          <div class="cd-box"><div class="cd-num" data-unit="days">--</div><div class="cd-lbl">${t('cdDaysLbl')}</div></div>
          <div class="cd-sep">:</div>
          <div class="cd-box"><div class="cd-num" data-unit="hours">--</div><div class="cd-lbl">${t('cdHoursLbl')}</div></div>
          <div class="cd-sep">:</div>
          <div class="cd-box"><div class="cd-num" data-unit="mins">--</div><div class="cd-lbl">${t('cdMinsLbl')}</div></div>
          <div class="cd-sep">:</div>
          <div class="cd-box"><div class="cd-num" data-unit="secs">--</div><div class="cd-lbl">${t('cdSecsLbl')}</div></div>
        </div>
      </div>
    </div>
    <div class="panel buy-panel">
      <div class="price-row">
        <div><div class="price-lbl">${t('priceLbl')}</div><div class="price-val">${raffle.price.toLocaleString()} Birr</div></div>
        <div class="qty">
          <button id="qtyMinus">−</button>
          <div class="qty-val" id="qtyVal">${qty}</div>
          <button class="plus" id="qtyPlus">+</button>
        </div>
      </div>
      <div class="selected-numbers-row" id="selectedNumbersRow" style="display:${selectedNumbers.length?'flex':'none'};">
        <span>${t('selectedNumsLbl')}</span>
        <div class="selected-chips" id="selectedChips"></div>
      </div>
      <button class="btn btn-outline-pink" id="pickNumbersBtn"><span class="step-badge step-5">5</span>🎯 <span>${t('pickLabel')}</span></button>
      <div class="btn-row">
        <button class="btn btn-gold" id="buyNowBtn">⚡ <span>${t('buyLabel')}</span></button>
        <button class="btn btn-green" id="manualSelectBtn"><span>${t('selectBtnLabel')}</span></button>
      </div>
    </div>
  `;
  renderSelectedChips();
  updateManualSelectBtn();
  document.getElementById('backBtn').addEventListener('click', ()=> showView('homeView'));
  document.getElementById('qtyPlus').addEventListener('click', ()=>{
    qty = Math.min(qty+1, MAX_TICKETS);
    document.getElementById('qtyVal').textContent = qty;
    if (selectedNumbers.length) { selectedNumbers = []; renderSelectedChips(); }
    updateManualSelectBtn();
  });
  document.getElementById('qtyMinus').addEventListener('click', ()=>{
    qty = Math.max(qty-1, 1);
    document.getElementById('qtyVal').textContent = qty;
    if (selectedNumbers.length) { selectedNumbers = []; renderSelectedChips(); }
    updateManualSelectBtn();
  });
  document.getElementById('pickNumbersBtn').addEventListener('click', ()=> openNumberPicker());
  document.getElementById('buyNowBtn').addEventListener('click', ()=> startCheckout(selectedNumbers.length ? 'mixed' : 'random'));
  document.getElementById('manualSelectBtn').addEventListener('click', ()=>{
    if (selectedNumbers.length !== qty){
      showToast(`Please select ${qty} number(s) first`);
      openNumberPicker();
      return;
    }
    startCheckout('manual');
  });
  tickAllCountdowns();
}

function updateManualSelectBtn(){
  const btn = document.getElementById('manualSelectBtn');
  if (!btn) return;
  const ready = selectedNumbers.length && selectedNumbers.length === qty;
  btn.classList.toggle('ready', !!ready);
  // The "7" step badge only appears once numbers are actually selected and
  // the button is ready to buy - not while it's still an inactive prompt.
  btn.innerHTML = ready
    ? `<span class="step-badge step-7">7</span><span>${t('selectBtnLabel')}</span>`
    : `<span>${t('selectBtnLabel')}</span>`;
}

function renderSelectedChips(){
  const row = document.getElementById('selectedNumbersRow');
  const chips = document.getElementById('selectedChips');
  updateManualSelectBtn();
  if (!row) return;
  if (selectedNumbers.length){
    row.style.display = 'flex';
    chips.innerHTML = selectedNumbers.map(n=> `<span class="chip-num">${padNum(n)}</span>`).join('');
  } else {
    row.style.display = 'none';
    chips.innerHTML = '';
  }
}

function tickAllCountdowns(){
  document.querySelectorAll('.countdown[data-raffle]').forEach(box=>{
    const id = box.dataset.raffle;
    const raffle = raffles.find(r=>r.id===id) || currentRaffle;
    if (!raffle) return;
    const c = fmtCountdown(raffle.drawAt);
    box.querySelector('[data-unit="days"]').textContent = c.d;
    box.querySelector('[data-unit="hours"]').textContent = c.h;
    box.querySelector('[data-unit="mins"]').textContent = c.m;
    box.querySelector('[data-unit="secs"]').textContent = c.s;
  });
}
setInterval(tickAllCountdowns, 1000);

// ===================== NUMBER PICKER =====================
async function openNumberPicker(){
  if (!currentRaffle) return;
  document.getElementById('numGrid').innerHTML = '';
  document.getElementById('pickNumTitle').textContent = t('pickLabel');
  updateNumberModalConfirmBtn();
  updatePickSub();
  document.getElementById('numberModalBackdrop').classList.add('show');
  await loadAllNumbers();
}

// Confirm button starts as a muted "Select Number" state; once at least one
// number is picked it flips to the green "Done" (step 6) state, matching
// the numbered step badges used throughout the rest of the buy flow.
function updateNumberModalConfirmBtn(){
  const btn = document.getElementById('numberModalConfirm');
  if (!btn) return;
  if (selectedNumbers.length){
    btn.classList.add('ready');
    btn.innerHTML = `<span class="step-badge step-6">6</span><span>${t('doneLbl')}</span>`;
  } else {
    btn.classList.remove('ready');
    btn.innerHTML = `<span>${t('selectNumberLbl')}</span>`;
  }
}

function updatePickSub(){
  document.getElementById('pickNumSub').textContent = `${selectedNumbers.length}/${MAX_TICKETS} selected`;
  const row = document.getElementById('pickTotalRow');
  const lbl = document.getElementById('pickTotalLbl');
  const val = document.getElementById('pickTotalVal');
  if (selectedNumbers.length && currentRaffle){
    const total = currentRaffle.price * selectedNumbers.length;
    row.style.display = 'flex';
    lbl.textContent = `${selectedNumbers.length} × ${currentRaffle.price.toLocaleString()} Birr`;
    val.textContent = `${total.toLocaleString()} Birr`;
  } else {
    row.style.display = 'none';
  }
}

// Fetches every number for this raffle in a single request and renders
// them all at once, so picking a number is just one continuous scroll
// instead of clicking "Load more" repeatedly. Fine for raffles up to a
// few thousand numbers (typical for this app); if a raffle ever had, say,
// tens of thousands of numbers, this would be worth paginating again -
// not a concern at the sizes this app actually uses.
async function loadAllNumbers(){
  const res = await fetch(`${API}/raffles/${currentRaffle.id}/numbers?start=1&end=${currentRaffle.totalNumbers}`);
  const data = await res.json();
  const grid = document.getElementById('numGrid');
  const frag = document.createDocumentFragment();
  data.numbers.forEach(item=>{
    const cell = document.createElement('div');
    cell.className = 'num-cell';
    if (selectedNumbers.includes(item.n)) cell.classList.add('selected');
    else if (item.status !== 'available') cell.classList.add(item.status);
    cell.textContent = padNum(item.n);
    if (item.status === 'available' || selectedNumbers.includes(item.n)){
      cell.addEventListener('click', ()=> toggleNumber(item.n, cell));
    }
    frag.appendChild(cell);
  });
  grid.appendChild(frag);
}

function toggleNumber(n, cell){
  const idx = selectedNumbers.indexOf(n);
  if (idx > -1){
    selectedNumbers.splice(idx, 1);
    cell.classList.remove('selected');
  } else {
    if (selectedNumbers.length >= MAX_TICKETS){
      showToast(`You can select up to ${MAX_TICKETS} number(s) per order.`);
      return;
    }
    selectedNumbers.push(n);
    cell.classList.add('selected');
  }
  updatePickSub();
  updateNumberModalConfirmBtn();
}

document.getElementById('numberModalClose').addEventListener('click', ()=>{
  document.getElementById('numberModalBackdrop').classList.remove('show');
});
document.getElementById('numberModalConfirm').addEventListener('click', ()=>{
  if (selectedNumbers.length < 1){
    showToast(`Please select at least 1 number`);
    return;
  }
  qty = selectedNumbers.length;
  const qtyVal = document.getElementById('qtyVal');
  if (qtyVal) qtyVal.textContent = qty;
  document.getElementById('numberModalBackdrop').classList.remove('show');
  renderSelectedChips();
  showToast(`${selectedNumbers.length} ${t('toastPicked')}`);
});

// ===================== CHECKOUT (3 steps) =====================
let checkoutOrder = null;
let checkoutMode = 'random';
let selectedBankId = null;
let receiptFile = null;
// Data URL (base64) preview of receiptFile, generated once via FileReader
// when the file is first picked. Telegram's in-app WebView on some Android
// builds fails to render blob: URLs (URL.createObjectURL) inside an <img> -
// they show as a broken-image icon instead of the picture - so every place
// that needs to redisplay the receipt (step 2 revisited, review step) reuses
// this cached data: URL rather than minting a fresh blob: URL each time.
let receiptDataUrl = null;
let reviewSenderAccount = '';

// Releases the current checkout order's number reservation on the server,
// if one exists and hasn't been paid yet. Called whenever checkout is
// abandoned before step 3's submit (Back to step 1, or closing the modal)
// - without this, the numbers stay "pending" and unavailable to everyone,
// including the buyer's own retry, for the full RESERVE_MINUTES window.
// Fire-and-forget from the caller's point of view (awaited here, but a
// failure is only logged - an abandoned reservation quietly expiring on
// its own later is an acceptable fallback, not worth blocking the UI on).
async function cancelCheckoutOrder(){
  if (!checkoutOrder || checkoutOrder.status !== 'awaiting_payment') return;
  const orderId = checkoutOrder.id;
  const phone = checkoutOrder.phone;
  checkoutOrder = null;
  try{
    await fetch(`${API}/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone })
    });
  }catch(e){ console.error('cancelCheckoutOrder failed:', e); }
}

function startCheckout(mode){
  checkoutMode = mode;
  if (mode === 'manual' && selectedNumbers.length !== qty){
    showToast(`Please select ${qty} number(s) first`);
    return;
  }
  // 'random' only happens with zero manual picks (see buyNowBtn handler),
  // so there's nothing stale to clear here. A manual pick that's still
  // selected when Quick Pick is hit becomes 'mixed': those numbers are kept
  // and the server fills the remaining slots at random around them.
  selectedBankId = null;
  receiptFile = null;
  receiptDataUrl = null;
  reviewSenderAccount = '';
  checkoutOrder = null;
  renderCheckoutStep1();
  document.getElementById('checkoutModalBackdrop').classList.add('show');
  setStepBars(1);
}

function setStepBars(step){
  const stepsWrap = document.querySelector('.steps');
  const lbl = document.getElementById('checkoutStepLbl');
  stepsWrap.style.display = '';
  lbl.style.display = '';
  // The "Order Sent" confirmation screen isn't a separate numbered step -
  // show it as step 3 of 3, fully complete, instead of hiding the bar.
  const shownStep = Math.min(step, 3);
  [1,2,3].forEach(n=>{
    const bar = document.getElementById('stepBar'+n);
    bar.classList.remove('active','done');
    if (n < shownStep) bar.classList.add('done');
    if (n === shownStep) bar.classList.add('active');
  });
  lbl.textContent = t('stepOfLbl').replace('{n}', shownStep).replace('{total}', 3);
}

function renderCheckoutStep1(){
  document.getElementById('checkoutTitle').textContent = t('orderConfirmTitle');
  const total = currentRaffle.price * qty;
  document.getElementById('checkoutBody').innerHTML = `
    <div class="summary-card">
      <div style="font-weight:700;margin-bottom:4px;">${esc(checkoutSummaryTitle(currentRaffle))}</div>
      <div class="summary-row"><span>${qty} ${t('ticketsUnitLbl')} × ${currentRaffle.price.toLocaleString()} Birr</span></div>
      <div class="summary-total">${total.toLocaleString()} Birr</div>
      ${checkoutMode === 'manual' && selectedNumbers.length ? `<div class="order-id-chip">#${selectedNumbers.join(', #')}</div>` : ''}
      ${checkoutMode === 'mixed' && selectedNumbers.length ? `<div class="order-id-chip">#${selectedNumbers.join(', #')} + ${qty - selectedNumbers.length} random</div>` : ''}
      ${checkoutMode === 'random' ? `<div class="order-id-chip">Random numbers will be assigned</div>` : ''}
    </div>
    <div class="field">
      <label>${t('fullNameLbl')}</label>
      <div class="field-input-wrap">
        <span class="field-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z" stroke="currentColor" stroke-width="2"/><path d="M4 20c0-3.6 3.6-6.5 8-6.5s8 2.9 8 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
        <input type="text" id="checkoutFullName" placeholder="${t('fullNamePlaceholder')}" value="">
      </div>
    </div>
    <div class="field">
      <label>${t('phoneLbl')}</label>
      <div class="field-input-wrap">
        <span class="field-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.5 21 3 13.5 3 4.9c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <input type="tel" id="checkoutPhone" placeholder="e.g. 251912345678" value="${esc(localStorage.getItem('phone')||'')}">
      </div>
    </div>
  `;
  document.getElementById('checkoutFoot').innerHTML = `<button class="btn btn-gold" id="checkoutStep1Next"><span class="step-badge step-8">8</span><span class="btn-label">${t('continueLbl')}</span><svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  document.getElementById('checkoutStep1Next').addEventListener('click', submitStep1);
  document.getElementById('checkoutFullName').addEventListener('input', e=> e.target.classList.remove('input-error'));
  document.getElementById('checkoutPhone').addEventListener('input', e=> e.target.classList.remove('input-error'));
}

async function submitStep1(){
  const nameEl = document.getElementById('checkoutFullName');
  const phoneEl = document.getElementById('checkoutPhone');
  const fullName = nameEl.value.trim();
  const phone = phoneEl.value.trim();
  if (!fullName){
    nameEl.classList.add('input-error');
    nameEl.focus();
    showToast(t('fillNameMsg'));
    return;
  }
  nameEl.classList.remove('input-error');
  if (!phone){
    phoneEl.classList.add('input-error');
    phoneEl.focus();
    showToast(t('fillPhoneMsg'));
    return;
  }
  phoneEl.classList.remove('input-error');
  // If this phone differs from the last saved one, drop the old
  // customerId - it belonged to that previous phone number and would
  // just cause a mismatch on the next ticket lookup. The real value for
  // this phone comes back in the order response below.
  if (localStorage.getItem('phone') !== phone) localStorage.removeItem('customerId');
  localStorage.setItem('fullName', fullName);
  localStorage.setItem('phone', phone);

  const btn = document.getElementById('checkoutStep1Next');
  const btnLabel = btn.querySelector('.btn-label');
  btn.disabled = true; btnLabel.textContent = '...';
  try{
    const res = await fetch(`${API}/orders`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        raffleId: currentRaffle.id, quantity: qty,
        numbers: (checkoutMode === 'manual' || checkoutMode === 'mixed') ? selectedNumbers : undefined,
        mode: checkoutMode, fullName, phone
      })
    });
    const data = await res.json();
    if (!res.ok){ showToast(data.error || 'Could not create order'); btn.disabled=false; btnLabel.textContent = t('continueLbl'); return; }
    checkoutOrder = data.order;
    localStorage.setItem('customerId', checkoutOrder.customerId);
    renderCheckoutStep2(data.banks);
    setStepBars(2);
  }catch(e){
    console.error(e); showToast('Network error, please try again'); btn.disabled=false; btnLabel.textContent = t('continueLbl');
  }
}

function renderCheckoutStep2(banks){
  document.getElementById('checkoutTitle').textContent = t('orderPaymentTitle');
  document.getElementById('checkoutBody').innerHTML = `
    <div style="font-size:12.5px;color:var(--text-secondary);font-weight:600;margin-bottom:8px;">${t('banksLbl')}</div>
    <div id="banksList">
      ${banks.map(b=>`
        <div class="bank-card" data-bank="${b.id}">
          <div class="bank-left"><div class="bank-icon">🏦</div><div><div class="bank-name">${esc(b.name)}</div><div class="bank-holder">${esc(b.holder)}</div></div></div>
          <div class="bank-account-wrap">
            <div class="bank-account">${esc(b.account)}</div>
            <div class="copy-account-btn" data-copy="${esc(b.account)}" title="Copy account number">
              <svg class="icon-copy" width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2"/></svg>
              <svg class="icon-check" width="15" height="15" viewBox="0 0 24 24" fill="none" style="display:none;"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
          </div>
        </div>`).join('')}
    </div>
    <div class="upload-box" id="uploadBox">
      <div class="upload-icon" id="uploadIcon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 15V4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 8l5-5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 16v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div id="uploadHintText" class="upload-hint-text">${t('uploadHint')}</div>
      <div id="uploadSizeHint" class="upload-size-hint">${t('uploadSizeHint')}</div>
      <img id="uploadPreview" class="upload-preview" style="display:none;">
    </div>
    <input type="file" id="receiptInput" accept="image/*" style="display:none;">
    <div class="field" style="margin-top:14px;">
      <label>${t('senderAccountLbl')}</label>
      <div class="field-input-wrap">
        <input type="text" id="senderAccountInput" placeholder="${t('senderAccountPlaceholder')}" value="${esc(reviewSenderAccount)}">
      </div>
    </div>
  `;
  document.getElementById('checkoutFoot').innerHTML = `
    <div class="btn-row">
      <button class="btn btn-outline" id="checkoutStep2Back"><span>${t('backLabel')}</span></button>
      <button class="btn btn-gold" id="checkoutStep2Next"><span class="step-badge step-9">9</span><span class="btn-label">${t('continueLbl')}</span><svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
  `;
  document.getElementById('checkoutStep2Back').addEventListener('click', ()=>{
    cancelCheckoutOrder();
    renderCheckoutStep1();
    setStepBars(1);
  });

  document.querySelectorAll('.bank-card').forEach(card=>{
    if (card.dataset.bank === selectedBankId) card.classList.add('selected');
    card.addEventListener('click', ()=>{
      document.querySelectorAll('.bank-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      selectedBankId = card.dataset.bank;
    });
  });
  document.querySelectorAll('.copy-account-btn').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const text = btn.dataset.copy;
      copyToClipboard(text).then(()=>{
        btn.classList.add('copied');
        btn.querySelector('.icon-copy').style.display = 'none';
        btn.querySelector('.icon-check').style.display = '';
        btn.title = 'Copied!';
        showToast('Account number copied');
        setTimeout(()=>{
          btn.classList.remove('copied');
          btn.querySelector('.icon-copy').style.display = '';
          btn.querySelector('.icon-check').style.display = 'none';
          btn.title = 'Copy account number';
        }, 1500);
      }).catch(()=> showToast('Could not copy'));
    });
  });
  document.getElementById('checkoutStep2Next').addEventListener('click', ()=>{
    try{
      if (!receiptFile){ showToast('Please upload your payment receipt'); return; }
      renderCheckoutReview(banks);
      setStepBars(3);
    }catch(e){
      console.error('checkoutStep2Next failed:', e);
      showToast('Something went wrong, please try again');
    }
  });

  const uploadBox = document.getElementById('uploadBox');
  const receiptInput = document.getElementById('receiptInput');
  if (receiptFile){
    uploadBox.classList.add('has-file');
    document.getElementById('uploadIcon').style.display = 'none';
    document.getElementById('uploadHintText').style.display = 'none';
    document.getElementById('uploadSizeHint').style.display = 'none';
    const img = document.getElementById('uploadPreview');
    img.src = receiptDataUrl; img.style.display = 'block';
  }
  uploadBox.addEventListener('click', ()=> receiptInput.click());
  receiptInput.addEventListener('change', ()=>{
    const file = receiptInput.files[0];
    if (!file) return;
    receiptFile = file;
    uploadBox.classList.add('has-file');
    document.getElementById('uploadIcon').style.display = 'none';
    document.getElementById('uploadHintText').style.display = 'none';
    document.getElementById('uploadSizeHint').style.display = 'none';
    const reader = new FileReader();
    reader.onload = e=>{
      receiptDataUrl = e.target.result;
      const img = document.getElementById('uploadPreview');
      img.src = receiptDataUrl; img.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
}

function renderCheckoutReview(banks){
  document.getElementById('checkoutTitle').textContent = t('orderReviewTitle');
  const bank = banks.find(b=> b.id === selectedBankId);
  const senderAccount = document.getElementById('senderAccountInput') ? document.getElementById('senderAccountInput').value.trim() : reviewSenderAccount;
  reviewSenderAccount = senderAccount;
  const receiptUrl = receiptFile ? receiptDataUrl : '';
  document.getElementById('checkoutBody').innerHTML = `
    <div class="summary-card">
      <div class="summary-title">${t('orderSummaryTitle')}</div>
      <div class="summary-row"><span>${t('itemLbl')}</span><b>${esc(checkoutSummaryTitle(currentRaffle))}</b></div>
      <div class="summary-row"><span>${t('ticketsLbl')}</span><b>${checkoutOrder.quantity} × ${checkoutOrder.unitPrice.toLocaleString()} Birr</b></div>
      <div class="summary-row summary-row-stacked"><span>${t('ticketNumbersLbl')}</span></div>
      <div class="ticket-numbers-wrap">${checkoutOrder.ticketNumbers.map(n=>`<span class="ticket-num-chip">#${n}</span>`).join('')}</div>
      <div class="summary-row"><span>${t('fullNameLbl')}</span><b>${esc(checkoutOrder.fullName)}</b></div>
      <div class="summary-row"><span>${t('phoneLbl')}</span><b>${esc(checkoutOrder.phone)}</b></div>
      <div class="summary-row"><span>${t('bankLbl')}</span><b>${bank ? esc(bank.name) : ''}</b></div>
      ${senderAccount ? `<div class="summary-row"><span>${t('senderAccountLbl')}</span><b>${esc(senderAccount)}</b></div>` : ''}
      <div class="summary-divider"></div>
      <div class="summary-row summary-row-total"><span>${t('totalLbl')}</span><b>${checkoutOrder.total.toLocaleString()} Birr</b></div>
    </div>
    <div style="font-size:12.5px;color:var(--text-secondary);font-weight:600;margin-bottom:8px;">${t('uploadHint')}</div>
    <div class="upload-box has-file" style="cursor:default;">
      <img class="upload-preview" src="${receiptUrl}" style="display:block;">
    </div>
    <div class="review-note"><span>⚠️</span><span>${t('reviewNoteMsg')}</span></div>
  `;
  document.getElementById('checkoutFoot').innerHTML = `
    <div class="btn-row">
      <button class="btn btn-outline" id="checkoutReviewBack"><span>${t('backLabel')}</span></button>
      <button class="btn btn-gold" id="checkoutReviewSubmit"><span class="step-badge step-10">10</span><span class="btn-label">${t('submitOrderLbl')}</span></button>
    </div>
  `;
  document.getElementById('checkoutReviewBack').addEventListener('click', ()=>{
    renderCheckoutStep2(banks);
    setStepBars(2);
  });
  document.getElementById('checkoutReviewSubmit').addEventListener('click', submitPayment);
}

async function submitPayment(){
  const btn = document.getElementById('checkoutReviewSubmit');
  const btnLabel = btn.querySelector('.btn-label');
  btn.disabled = true; btnLabel.textContent = '...';
  try{
    const fd = new FormData();
    fd.append('receipt', receiptFile);
    if (selectedBankId) fd.append('bankId', selectedBankId);
    if (reviewSenderAccount) fd.append('senderAccount', reviewSenderAccount);
    const res = await fetch(`${API}/orders/${checkoutOrder.id}/payment`, { method:'POST', body: fd });
    const data = await res.json();
    if (!res.ok){ showToast(data.error || 'Could not submit payment'); btn.disabled=false; btnLabel.textContent=t('submitOrderLbl'); return; }
    checkoutOrder = data.order;
    renderCheckoutStep4();
    setStepBars(4);
  }catch(e){
    console.error(e); showToast('Network error, please try again'); btn.disabled=false; btnLabel.textContent=t('submitOrderLbl');
  }
}

function renderCheckoutStep4(){
  document.getElementById('checkoutTitle').textContent = t('orderStatusTitle');
  document.getElementById('checkoutBody').innerHTML = `
    <div class="status-card status-card-success">
      <div class="status-icon success status-icon-lg">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="status-title">${t('orderSentTitle')}</div>
      <div style="color:var(--text-secondary);font-size:13.5px;line-height:1.5;">${t('orderSentMsg').replace('{id}', checkoutOrder.id)}</div>
    </div>
  `;
  document.getElementById('checkoutFoot').innerHTML = `<button class="btn btn-success-done" id="checkoutDone"><span>${t('closeLbl')}</span></button>`;
  document.getElementById('checkoutDone').addEventListener('click', ()=>{
    document.getElementById('checkoutModalBackdrop').classList.remove('show');
    selectedNumbers = [];
    qty = 1;
    loadRaffles();
    showView('homeView');
    document.getElementById('navTicketsItem').classList.remove('active');
    document.getElementById('navProfileItem').classList.remove('active');
    document.getElementById('navHomeItem').classList.add('active');
  });
}

document.getElementById('checkoutModalClose').addEventListener('click', ()=>{
  cancelCheckoutOrder();
  document.getElementById('checkoutModalBackdrop').classList.remove('show');
});

// ===================== TICKETS =====================
async function searchTickets(phone, customerId){
  if (!phone){ showToast('Enter a phone number'); return; }
  if (!customerId){ showToast('Enter your Customer ID'); return; }
  try{
    const res = await fetch(`${API}/tickets?phone=${encodeURIComponent(phone)}&customerId=${encodeURIComponent(customerId)}`);
    const data = await res.json();
    if (!res.ok){ showToast(data.error || 'Could not load tickets'); return; }
    renderTickets(data.orders || [], data.counts || {active:0,pending:0,total:0});
  }catch(e){ console.error(e); showToast('Could not load tickets'); }
}

function statusLabel(s){
  return { confirmed:'Confirmed', pending:'Pending Review', awaiting_payment:'Awaiting Payment', rejected:'Rejected', expired:'Expired' }[s] || s;
}

// For an expired/rejected order, the numbers were released back to the
// pool - they no longer belong to this order. Label each number with what
// it's actually doing right now (free / re-bought and taken / re-reserved
// by someone mid-checkout), so a customer never mistakes an old order for
// still owning those numbers.
const liveStatusLabel = { available: 'Free now', taken: 'Taken by another buyer', pending: 'Reserved by another buyer' };

async function fetchLiveNumberStatuses(raffleId, nums){
  try{
    const res = await fetch(`${API}/raffles/${raffleId}/numbers?nums=${nums.join(',')}`);
    const data = await res.json();
    const map = {};
    (data.numbers || []).forEach(item => { map[item.n] = item.status; });
    return map;
  }catch(e){ console.error(e); return {}; }
}

const statusIcon = {
  confirmed: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pending: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  awaiting_payment: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rejected: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  expired: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const statusFooterNote = {
  confirmed: '🏆 Confirmed — good luck in the draw!',
  pending: '⏳ Waiting for admin payment approval',
  awaiting_payment: null, // has its own reserved-until note + Continue Payment button instead
  rejected: null, // has its own released-numbers note
  expired: null,
};
const statusSectionOrder = ['awaiting_payment', 'pending', 'confirmed', 'rejected', 'expired'];
const statusSectionLabel = { awaiting_payment: 'Awaiting Payment', pending: 'Pending Tickets', confirmed: 'Confirmed Tickets', rejected: 'Rejected Tickets', expired: 'Expired Tickets' };

function renderTickets(orders, counts){
  document.getElementById('ticketsActiveNum').textContent = counts.active || 0;
  document.getElementById('ticketsPendingNum').textContent = counts.pending || 0;
  document.getElementById('ticketsTotalNum').textContent = counts.total || 0;
  const list = document.getElementById('ticketsList');
  const empty = document.getElementById('ticketsEmpty');
  if (!orders.length){ list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  const statusFooterNote2 = {
    expired: '🎟 Numbers released — no longer yours',
    rejected: '🎟 Numbers released — no longer yours',
  };
  const cardHtml = o => {
    const released = o.status === 'expired' || o.status === 'rejected';
    const needsPayment = o.status === 'awaiting_payment';
    const note = statusFooterNote[o.status] || statusFooterNote2[o.status];
    return `
    <div class="ticket-card">
      <div class="ticket-top">
        <img class="ticket-thumb" src="${esc(o.raffleImage||'')}" onerror="this.style.visibility='hidden'">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${o.raffleNumber ? esc(o.raffleNumber + ' Gech EV Makina Equb') : esc(o.raffleTitle)}</div>
          <div style="font-family:var(--font-display);font-weight:700;color:var(--accent-gold);font-size:16px;margin-top:2px;">#${o.ticketNumbers.join(', #')}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">${new Date(o.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="ticket-status ${o.status}"><span class="status-dot">${statusIcon[o.status]||''}</span><span class="status-lbl">${statusLabel(o.status)}</span></div>
      </div>
      ${needsPayment ? `<div style="font-size:11.5px;color:var(--accent-gold);margin-top:6px;">Reserved until ${new Date(o.reservedUntil).toLocaleTimeString()} - upload your payment receipt before then or these numbers will be released.</div>` : ''}
      ${released ? `<div class="ticket-nums" id="ticket-nums-${o.id}">${o.ticketNumbers.map(n=>`<span class="chip-num chip-num-released">#${n}</span>`).join('')}</div>` : ''}
      ${note ? `<div style="font-size:11.5px;color:var(--text-tertiary);margin-top:10px;padding-top:10px;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;">
        <span>${note}</span>
        ${o.status === 'expired' ? `<span style="color:var(--accent-red);font-weight:600;cursor:pointer;" data-deleteorder="${esc(o.id)}">Remove</span>` : ''}
      </div>` : ''}
      ${needsPayment ? `<button class="btn btn-gold" style="margin-top:12px;margin-bottom:0;" data-resumepay="${esc(o.id)}">Continue Payment →</button>` : ''}
    </div>
  `;
  };

  const byStatus = {};
  orders.forEach(o => { (byStatus[o.status] = byStatus[o.status] || []).push(o); });

  list.innerHTML = statusSectionOrder
    .filter(s => byStatus[s] && byStatus[s].length)
    .map(s => `
      <div class="ticket-section-hdr">${statusIcon[s]||''} ${statusSectionLabel[s]}</div>
      ${byStatus[s].map(cardHtml).join('')}
    `).join('');

  list.querySelectorAll('[data-resumepay]').forEach(btn=>{
    btn.addEventListener('click', ()=> resumePayment(btn.dataset.resumepay));
  });
  list.querySelectorAll('[data-deleteorder]').forEach(btn=>{
    btn.addEventListener('click', ()=> deleteMyOrder(btn.dataset.deleteorder));
  });

  // Kick off live-status lookups only for released orders, then patch the
  // chips in place once results come back (avoids blocking the initial render).
  orders.filter(o => o.status === 'expired' || o.status === 'rejected').forEach(async o => {
    const statusMap = await fetchLiveNumberStatuses(o.raffleId, o.ticketNumbers);
    const container = document.getElementById(`ticket-nums-${o.id}`);
    if (!container) return;
    container.innerHTML = o.ticketNumbers.map(n => {
      const live = statusMap[n] || 'available';
      const label = liveStatusLabel[live] || 'Free now';
      return `<span class="chip-num chip-num-released chip-live-${live}">#${n} <em>${label}</em></span>`;
    }).join('');
  });
}

// Lets a buyer clear an expired order off their own "My Tickets" list.
// Only expired orders are eligible - enforced server-side too, this is
// just the matching client-side action for it.
async function deleteMyOrder(orderId){
  const phone = localStorage.getItem('phone') || '';
  const customerId = localStorage.getItem('customerId') || '';
  if (!phone || !customerId){ showToast('Enter your phone and customer ID first'); return; }
  if (!confirm('Remove this expired order from your list? This cannot be undone.')) return;
  try{
    const res = await fetch(`${API}/orders/${orderId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, customerId })
    });
    const data = await res.json();
    if (!res.ok){ showToast(data.error || 'Could not remove order'); return; }
    searchTickets(phone, customerId);
  }catch(e){ console.error(e); showToast('Could not remove order'); }
}

// Lets a customer who left mid-checkout (order created + numbers reserved,
// but no receipt uploaded yet) pick up exactly where they stopped, instead
// of having to start over with a fresh set of numbers. Jumps straight to
// the payment step of the checkout modal using the existing order.
async function resumePayment(orderId){
  try{
    const res = await fetch(`${API}/orders/${orderId}`);
    const data = await res.json();
    if (!res.ok){ showToast(data.error || 'Order not found'); return; }
    if (data.order.status !== 'awaiting_payment'){
      showToast('This order can no longer accept payment - it may have expired or already been submitted.');
      searchTickets(data.order.phone, data.order.customerId);
      return;
    }
    const banksRes = await fetch(`${API}/banks`);
    const banksData = await banksRes.json();
    checkoutOrder = data.order;
    checkoutMode = 'manual';
    selectedBankId = null;
    receiptFile = null;
    receiptDataUrl = null;
    renderCheckoutStep2(banksData.banks || []);
    document.getElementById('checkoutModalBackdrop').classList.add('show');
    setStepBars(2);
  }catch(e){ console.error(e); showToast('Could not resume this order'); }
}

document.getElementById('ticketSearchBtn').addEventListener('click', ()=>{
  const phone = document.getElementById('ticketPhoneInput').value.trim();
  const customerId = document.getElementById('ticketCustomerIdInput').value.trim();
  searchTickets(phone, customerId);
});
let lastTicketsFetchAt = 0;
const TICKETS_REFETCH_MS = 60 * 1000; // don't re-hit the lookup endpoint more than once a minute from tab switches

function loadSavedPhoneIntoTickets(){
  const savedPhone = localStorage.getItem('phone');
  const savedId = localStorage.getItem('customerId');
  if (savedPhone && !document.getElementById('ticketPhoneInput').value){
    document.getElementById('ticketPhoneInput').value = savedPhone;
  }
  if (savedId && !document.getElementById('ticketCustomerIdInput').value){
    document.getElementById('ticketCustomerIdInput').value = savedId;
  }
  if (savedPhone && savedId){
    const now = Date.now();
    if (now - lastTicketsFetchAt < TICKETS_REFETCH_MS) return;
    lastTicketsFetchAt = now;
    searchTickets(savedPhone, savedId);
  }
}

// ===================== PROFILE =====================
function loadProfile(){
  const phone = localStorage.getItem('phone') || '';
  const customerId = localStorage.getItem('customerId') || '';
  document.getElementById('profilePhoneVal').textContent = phone || 'Not set';
  document.getElementById('profileCustomerIdVal').textContent = customerId || 'Not set (place an order to get one)';
  document.getElementById('profilePhoneInput').value = phone;
}
document.getElementById('profileSaveBtn').addEventListener('click', ()=>{
  const phone = document.getElementById('profilePhoneInput').value.trim();
  if (!phone){ showToast('Enter a phone number'); return; }
  // Changing the phone here doesn't change your customer id - that id is
  // tied to whichever phone you actually ordered under. If this doesn't
  // match, ticket lookups just won't find anything, same as typing a
  // phone number that never placed an order.
  localStorage.setItem('phone', phone);
  loadProfile();
  showToast('Saved');
});

// ===================== INIT =====================
applyLang(currentLang);
loadRaffles();
loadAnnouncements();
setInterval(loadRaffles, 30000);
setInterval(loadAnnouncements, 30000);

// If opened as a Telegram Mini App, ask the backend (via signed initData -
// see verifyTelegramInitData in server/utils.js) whether this Telegram
// account already shared its phone with the bot. If so, use that to fill
// in the checkout form instead of making the person retype what they just
// gave the bot seconds earlier. Silently does nothing outside Telegram, if
// the bot hasn't collected a phone for this user yet, or if the backend
// isn't configured for it (TELEGRAM_BOT_TOKEN unset) - checkout still
// works fine either way, just without the prefill.
async function prefillFromTelegram(){
  const initData = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData;
  if (!initData) return;
  try{
    const res = await fetch(`${API}/telegram/prefill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.linked && data.phone){
      localStorage.setItem('phone', data.phone);
      if (data.fullName) localStorage.setItem('fullName', data.fullName);
      if (data.customerId) localStorage.setItem('customerId', data.customerId);
      // Carry over the language chosen in the bot conversation, so picking
      // Amharic/Oromo there doesn't land you on an English mini app. Skipped
      // if the person already picked a language by hand inside the app
      // itself (langUserSet) - a deliberate in-app choice should win over
      // whatever was said in the bot days/weeks earlier.
      if (data.language && localStorage.getItem('langUserSet') !== '1' && data.language !== currentLang) {
        applyLang(data.language);
      }
      // Covers the case where the checkout form already rendered (with
      // empty/stale values) before this fetch resolved.
      const phoneEl = document.getElementById('checkoutPhone');
      const nameEl = document.getElementById('checkoutFullName');
      if (phoneEl && !phoneEl.value) phoneEl.value = data.phone;
      if (nameEl && !nameEl.value && data.fullName) nameEl.value = data.fullName;
      // Same idea for "My Tickets": if the person already tapped that tab
      // before this fetch resolved, it rendered empty (no customerId yet).
      // Re-run the load now that we actually have one, so they don't have
      // to manually re-tap the tab to see their own orders show up.
      if (data.customerId) loadSavedPhoneIntoTickets();
    }
  }catch(e){ /* prefill is a convenience, not required - fail quiet */ }
}
prefillFromTelegram();
