const API = '/api/admin';

// Buyer-submitted fields (fullName, phone, raffle titles, receipt paths, etc.)
// are rendered via innerHTML below. Escape them so a malicious order can't
// inject a script tag that runs in the admin's session.
function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function showErr(el, msg){ el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }

async function api(path, opts={}){
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts
  });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function apiForm(path, formData){
  const res = await fetch(API + path, { method:'POST', credentials:'same-origin', body: formData });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ===== Auth =====
async function checkAuth(){
  try{
    const me = await api('/me');
    document.getElementById('whoAmI').textContent = `Logged in as ${me.username}`;
    document.getElementById('loginWrap').style.display = 'none';
    document.getElementById('dashWrap').style.display = 'block';
    const emailLabel = document.getElementById('currentEmailLabel');
    if (emailLabel){
      emailLabel.textContent = me.email
        ? `Currently: ${me.email}`
        : 'Not set - you won\'t be able to use "Forgot password?" until you add one.';
    }
    const tgLabel = document.getElementById('telegramStatusLabel');
    const tgInput = document.getElementById('newTelegramUsername');
    if (tgLabel){
      tgLabel.textContent = me.telegramUsername
        ? (me.telegramLinked ? `Linked: @${me.telegramUsername}` : `@${me.telegramUsername} saved, but not linked yet - see below.`)
        : 'Not set - you won\'t be notified when a new order needs approval.';
    }
    if (tgInput && !tgInput.value) tgInput.value = me.telegramUsername || '';
    initDashboard();
  }catch(e){
    document.getElementById('loginWrap').style.display = 'block';
    document.getElementById('dashWrap').style.display = 'none';
  }
}

document.getElementById('loginBtn').addEventListener('click', async ()=>{
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginErr');
  showErr(errEl, '');
  try{
    await api('/login', { method:'POST', body: JSON.stringify({ username, password }) });
    checkAuth();
  }catch(e){ showErr(errEl, e.message); }
});

document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  await api('/logout', { method:'POST' });
  checkAuth();
});

// ===== Tabs =====
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.panel).classList.add('active');
  });
});

function initDashboard(){
  loadSummary();
  loadOrders();
  loadRaffles();
  loadBanks();
  loadTelegramUsers();
  loadAnnouncements();
}

// ===== Summary =====
async function loadSummary(){
  try{
    const s = await api('/summary');
    document.getElementById('statCards').innerHTML = `
      <div class="stat-card"><div class="num">${s.raffleCount}</div><div class="lbl">Raffles</div></div>
      <div class="stat-card"><div class="num">${s.pendingOrders}</div><div class="lbl">Pending Review</div></div>
      <div class="stat-card"><div class="num">${s.confirmedOrders}</div><div class="lbl">Confirmed Orders</div></div>
      <div class="stat-card"><div class="num">${s.revenue.toLocaleString()}</div><div class="lbl">Revenue (Birr)</div></div>
      <div class="stat-card"><div class="num">${s.telegramRegisteredCount}</div><div class="lbl">Registered (Shared Phone)</div></div>
    `;
  }catch(e){ console.error(e); }
}

// ===== Telegram Users (shared phone with the bot) =====
async function loadTelegramUsers(){
  try{
    const data = await api('/telegram-users');
    const badge = document.getElementById('telegramTotalBadge');
    if (badge) badge.textContent = `(${data.total} total)`;
    renderTelegramUsers(data.users);
  }catch(e){ console.error(e); }
}

function renderTelegramUsers(users){
  const body = document.getElementById('telegramUsersBody');
  const empty = document.getElementById('telegramUsersEmpty');
  if (!body) return;
  if (!users.length){ body.innerHTML=''; if (empty) empty.style.display='block'; return; }
  if (empty) empty.style.display = 'none';
  body.innerHTML = users.map(u => `
    <tr>
      <td>${u.username ? '@'+esc(u.username) : '<span style="color:var(--text-secondary);">—</span>'}</td>
      <td>${esc(u.fullName) || '<span style="color:var(--text-secondary);">—</span>'}</td>
      <td>${esc(u.phone)}</td>
      <td>${esc(u.telegramId)}</td>
      <td>${new Date(u.updatedAt).toLocaleString()}</td>
      <td>
        <span class="badge ${u.banned ? 'banned' : 'active-status'}" ${u.banned && u.bannedReason ? `title="${esc(u.bannedReason)}"` : ''}>
          ${u.banned ? 'Banned' : 'Active'}
        </span>
      </td>
      <td>
        ${u.banned
          ? `<button class="btn-red" data-unban="${esc(u.telegramId)}">Unban</button>`
          : `<button class="btn-red" data-ban="${esc(u.telegramId)}">Ban</button>`}
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-ban]').forEach(btn => btn.addEventListener('click', async () => {
    const telegramId = btn.dataset.ban;
    const reason = prompt('Reason for banning this user (optional):') || '';
    if (!confirm('Ban this user? They will no longer be able to place new orders with their linked phone number.')) return;
    try {
      await api(`/telegram-users/${encodeURIComponent(telegramId)}/ban`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      loadTelegramUsers();
    } catch (e) { alert(e.message); }
  }));

  body.querySelectorAll('[data-unban]').forEach(btn => btn.addEventListener('click', async () => {
    const telegramId = btn.dataset.unban;
    if (!confirm('Unban this user and allow them to place orders again?')) return;
    try {
      await api(`/telegram-users/${encodeURIComponent(telegramId)}/unban`, { method: 'POST' });
      loadTelegramUsers();
    } catch (e) { alert(e.message); }
  }));
}

// ===== Announcements (site-wide, shown under the bell icon) =====
async function loadAnnouncements(){
  try{
    const data = await api('/announcements');
    renderAnnouncements(data.announcements);
  }catch(e){ console.error(e); }
}

const ANN_TYPE_LABEL = { winner: '🏆 Winner', warning: '⚠️ Warning', update: '📢 Update' };

function renderAnnouncements(list){
  const body = document.getElementById('announcementsList');
  const empty = document.getElementById('announcementsEmpty');
  if (!body) return;
  if (!list.length){ body.innerHTML=''; if (empty) empty.style.display='block'; return; }
  if (empty) empty.style.display = 'none';
  body.innerHTML = list.map(a => `
    <div class="card" style="padding:14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--accent-gold);margin-bottom:4px;">${ANN_TYPE_LABEL[a.type] || ANN_TYPE_LABEL.update}</div>
          <div style="font-weight:700;font-size:14px;">${esc(a.title)}</div>
          ${a.winner ? `
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
            ${esc(a.winner.name)}${a.winner.phone ? ' · ' + esc(a.winner.phone) : ''}<br>
            ${a.winner.lottery ? esc(a.winner.lottery) + ' — ' : ''}Ticket #${esc(a.winner.ticket)}${a.winner.prize ? ' — ' + esc(a.winner.prize) : ''}
          </div>` : ''}
          ${a.message ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:4px;white-space:pre-wrap;">${esc(a.message)}</div>` : ''}
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:6px;">${new Date(a.createdAt).toLocaleString()}</div>
        </div>
        <button class="btn-red" data-delann="${esc(a.id)}" style="flex:none;">Delete</button>
      </div>
    </div>
  `).join('');

  body.querySelectorAll('[data-delann]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this announcement? It will disappear from the bell icon for all visitors.')) return;
    try {
      await api(`/announcements/${btn.dataset.delann}`, { method: 'DELETE' });
      loadAnnouncements();
    } catch (e) { alert(e.message); }
  }));
}

document.getElementById('annType').addEventListener('change', (e) => {
  const isWinner = e.target.value === 'winner';
  document.getElementById('annWinnerFields').style.display = isWinner ? 'block' : 'none';
  document.getElementById('annMessageField').style.display = isWinner ? 'none' : 'block';
  document.getElementById('annWinnerNoteField').style.display = isWinner ? 'block' : 'none';
});

document.getElementById('postAnnBtn').addEventListener('click', async () => {
  const title = document.getElementById('annTitle').value.trim();
  const type = document.getElementById('annType').value;
  const notifyTelegram = document.getElementById('annNotifyTelegram').checked;
  const errEl = document.getElementById('annErr');
  showErr(errEl, '');

  if (!title){ showErr(errEl, 'Title is required'); return; }

  let body;
  if (type === 'winner'){
    const winner = {
      name: document.getElementById('annWinnerName').value.trim(),
      phone: document.getElementById('annWinnerPhone').value.trim(),
      lottery: document.getElementById('annWinnerLottery').value.trim(),
      ticket: document.getElementById('annWinnerTicket').value.trim(),
      prize: document.getElementById('annWinnerPrize').value.trim()
    };
    if (!winner.name){ showErr(errEl, 'Winner name is required'); return; }
    if (!winner.ticket){ showErr(errEl, 'Winning ticket number is required'); return; }
    body = { title, type, notifyTelegram, winner, message: document.getElementById('annWinnerNote').value.trim() };
  } else {
    const message = document.getElementById('annMessage').value.trim();
    if (!message){ showErr(errEl, 'Message is required'); return; }
    body = { title, type, notifyTelegram, message };
  }

  try {
    await api('/announcements', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('annTitle').value = '';
    document.getElementById('annMessage').value = '';
    document.getElementById('annWinnerNote').value = '';
    document.getElementById('annWinnerName').value = '';
    document.getElementById('annWinnerPhone').value = '';
    document.getElementById('annWinnerLottery').value = '';
    document.getElementById('annWinnerTicket').value = '';
    document.getElementById('annWinnerPrize').value = '';
    document.getElementById('annNotifyTelegram').checked = false;
    loadAnnouncements();
  } catch (e) { showErr(errEl, e.message); }
});

// ===== Orders =====
async function loadOrders(){
  const status = document.getElementById('orderStatusFilter').value;
  try{
    const data = await api(`/orders${status ? '?status='+status : ''}`);
    renderOrders(data.orders);
  }catch(e){ console.error(e); }
}

function renderOrders(orders){
  const body = document.getElementById('ordersBody');
  const empty = document.getElementById('ordersEmpty');
  if (!orders.length){ body.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display = 'none';
  body.innerHTML = orders.map(o=> `
    <tr>
      <td>#${esc(o.id)}<br><span style="color:var(--text-tertiary);font-size:11px;">${new Date(o.createdAt).toLocaleString()}</span></td>
      <td>${esc(o.raffleTitle)}</td>
      <td>${esc(o.fullName)}<br><span style="color:var(--text-tertiary);font-size:11px;">${esc(o.phone)}</span></td>
      <td>${o.ticketNumbers.map(n=>'#'+n).join(', ')}</td>
      <td>${o.total.toLocaleString()} Birr</td>
      <td>${o.receiptPath ? `<span class="receipt-link" data-receipt-id="${esc(o.id)}">View</span>` : '—'}${o.senderAccount ? `<br><span style="color:var(--text-tertiary);font-size:11px;">From: ${esc(o.senderAccount)}</span>` : ''}</td>
      <td><span class="badge ${esc(o.status)}">${esc(o.status.replace('_',' '))}</span></td>
      <td>
        <div class="row-actions">
          ${o.status === 'pending' ? `<button class="btn-green" data-approve="${o.id}">Approve</button><button class="btn-red" data-reject="${o.id}">Reject</button>` : ''}
          ${o.status === 'awaiting_payment' ? `<button class="btn-red" data-reject="${o.id}">Cancel</button>` : ''}
          ${o.status === 'confirmed' && o.adminTaken ? `<button class="btn-red" data-release="${o.id}">Release</button>` : ''}
          ${o.status === 'confirmed' && !o.adminTaken ? `<button class="btn-red" data-unconfirm="${o.id}">Unconfirm</button>` : ''}
          ${(['rejected','expired','released'].includes(o.status) || o.raffleStatus === 'ended') ? `<button class="btn-red" data-delete="${o.id}">Delete</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-receipt-id]').forEach(el=>{
    el.addEventListener('click', ()=>{
      // Absolute path, not the api()/API-prefixed helper - this route lives
      // under /api/orders/... (routes/public.js), not /api/admin/....
      // Same-origin <img> requests send cookies automatically, so the
      // existing admin session is what authenticates this.
      document.getElementById('lightboxImg').src = `/api/orders/${encodeURIComponent(el.dataset.receiptId)}/receipt`;
      document.getElementById('lightboxBackdrop').classList.add('show');
    });
  });
  body.querySelectorAll('[data-approve]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      btn.disabled = true;
      try{ await api(`/orders/${btn.dataset.approve}/approve`, { method:'POST' }); loadOrders(); loadSummary(); loadRaffles(); }
      catch(e){ alert(e.message); btn.disabled = false; }
    });
  });
  body.querySelectorAll('[data-reject]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      btn.disabled = true;
      try{ await api(`/orders/${btn.dataset.reject}/reject`, { method:'POST' }); loadOrders(); loadSummary(); loadRaffles(); }
      catch(e){ alert(e.message); btn.disabled = false; }
    });
  });
  body.querySelectorAll('[data-release]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if (!confirm('Release these tickets back to available? Anyone will be able to pick these numbers again.')) return;
      btn.disabled = true;
      try{ await api(`/orders/${btn.dataset.release}/admin-release`, { method:'POST' }); loadOrders(); loadSummary(); loadRaffles(); }
      catch(e){ alert(e.message); btn.disabled = false; }
    });
  });
  body.querySelectorAll('[data-unconfirm]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      // Unlike approve/reject, this reverses something already counted as
      // real revenue and a sold number - worth one extra click of friction
      // so a stray misclick can't chain into a second one.
      if (!confirm('Unconfirm this order? It will go back to Pending and its ticket numbers will be held (not released) until you approve or reject it again.')) return;
      btn.disabled = true;
      try{ await api(`/orders/${btn.dataset.unconfirm}/unconfirm`, { method:'POST' }); loadOrders(); loadSummary(); loadRaffles(); }
      catch(e){ alert(e.message); btn.disabled = false; }
    });
  });
  body.querySelectorAll('[data-delete]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      // Deleting is permanent - there's no reject/unconfirm to undo this
      // with afterward, so this confirm is more emphatic than the others.
      if (!confirm('Permanently delete this order? This cannot be undone - the order record, buyer details and receipt link will be gone for good.')) return;
      btn.disabled = true;
      try{ await api(`/orders/${btn.dataset.delete}`, { method:'DELETE' }); loadOrders(); loadSummary(); loadRaffles(); }
      catch(e){ alert(e.message); btn.disabled = false; }
    });
  });
}
document.getElementById('orderStatusFilter').addEventListener('change', loadOrders);
document.getElementById('refreshOrdersBtn').addEventListener('click', ()=>{ loadOrders(); loadSummary(); });
document.getElementById('lightboxBackdrop').addEventListener('click', ()=> document.getElementById('lightboxBackdrop').classList.remove('show'));

// ===== Raffles =====
// Converts an ISO date string into the "YYYY-MM-DDTHH:mm" format required
// by <input type="datetime-local">, using local time.
function toLocalInputValue(isoString){
  const d = new Date(isoString);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadRaffles(){
  try{
    const data = await api('/raffles');
    const wrap = document.getElementById('rafflesList');
    if (!data.raffles.length){ wrap.innerHTML = '<div class="empty-msg">No raffles yet</div>'; return; }
    wrap.innerHTML = data.raffles.map(r=> `
      <div class="raffle-item">
        <div>
          <div style="font-weight:700;">${r.raffleNumber ? `#${r.raffleNumber} · ` : ''}${esc(r.title)} <span style="color:var(--text-tertiary);font-weight:400;">${esc(r.subtitle||'')}</span></div>
          <div style="font-size:12px;color:var(--text-tertiary);">${r.price.toLocaleString()} Birr · ${r.soldCount}/${r.totalNumbers} sold · ${esc(r.status)}</div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">
            Draw date: <span data-drawlabel="${r.id}">${r.drawAt ? new Date(r.drawAt).toLocaleString() : '—'}</span>
          </div>
        </div>
        <div class="row-actions">
          <input type="datetime-local" data-drawinput="${r.id}" value="${r.drawAt ? toLocalInputValue(r.drawAt) : ''}">
          <button class="btn-outline" data-updatedate="${r.id}">Update Date</button>
          <input type="file" accept="image/*" style="display:none" data-photoinput="${r.id}">
          <button class="btn-outline" data-photobtn="${r.id}">${r.imageUrl ? 'Change Photo' : 'Add Photo'}</button>
          <button class="btn-outline" data-editbtn="${r.id}">Edit</button>
          <button class="btn-outline" data-taketicketsbtn="${r.id}">Take Tickets</button>
          ${r.status==='active' ? `<button class="btn-outline" data-end="${r.id}">End</button>` : `<button class="btn-outline" data-activate="${r.id}">Activate</button>`}
          <button class="btn-green" data-draw="${r.id}">Draw Winner</button>
          <button class="btn-red" data-delete="${r.id}">Delete</button>
        </div>
        <div class="raffle-edit-form" data-taketicketsform="${r.id}" style="display:none;">
          <p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px;">Marks tickets as taken directly with no order/payment - use for reserving numbers yourself, giveaways, or offline sales. ${r.remaining} of ${r.totalNumbers} still available.</p>
          <div class="grid2">
            <div><label>Quantity (random pick)</label><input type="number" min="1" max="${r.remaining}" placeholder="e.g. 100" data-take-qty="${r.id}"></div>
            <div><label>Or specific numbers (comma separated)</label><input type="text" placeholder="e.g. 5, 12, 40" data-take-numbers="${r.id}"></div>
          </div>
          <div><label>Note (optional, e.g. who it's for)</label><input type="text" placeholder="e.g. Reserved for family" data-take-note="${r.id}"></div>
          <div class="row-actions">
            <button class="btn-gold" style="max-width:160px;" data-taketicketsconfirm="${r.id}">Take Tickets</button>
            <button class="btn-outline" data-canceltaketicketsbtn="${r.id}">Cancel</button>
          </div>
        </div>
        <div class="raffle-edit-form" data-editform="${r.id}" style="display:none;">
          <div class="grid2">
            <div><label>Raffle Number</label><input type="number" min="1" step="1" data-edit-rafflenumber="${r.id}" value="${r.raffleNumber||''}"></div>
            <div><label>Title</label><input type="text" data-edit-title="${r.id}" value="${esc(r.title)}"></div>
            <div><label>Subtitle / Color</label><input type="text" data-edit-subtitle="${r.id}" value="${esc(r.subtitle||'')}"></div>
            <div><label>Ticket Price (Birr)</label><input type="number" data-edit-price="${r.id}" value="${r.price}"></div>
            <div><label>Total Numbers</label><input type="number" data-edit-totalnumbers="${r.id}" value="${r.totalNumbers}"></div>
            <div><label>Badge</label><select data-edit-badge="${r.id}">
              <option value="none" ${r.badge==='none'?'selected':''}>None</option>
              <option value="new" ${r.badge==='new'?'selected':''}>New</option>
              <option value="hot" ${r.badge==='hot'?'selected':''}>Hot / Featured</option>
            </select></div>
            <div><label>Rating</label><input type="number" step="0.1" max="5" min="0" data-edit-rating="${r.id}" value="${r.rating}"></div>
          </div>
          <div class="row-actions">
            <button class="btn-gold" style="max-width:160px;" data-savebtn="${r.id}">Save Changes</button>
            <button class="btn-outline" data-canceleditbtn="${r.id}">Cancel</button>
          </div>
        </div>
      </div>
    `).join('');

    wrap.querySelectorAll('[data-editbtn]').forEach(b=> b.addEventListener('click', ()=>{
      const id = b.dataset.editbtn;
      const form = wrap.querySelector(`[data-editform="${id}"]`);
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }));
    wrap.querySelectorAll('[data-canceleditbtn]').forEach(b=> b.addEventListener('click', ()=>{
      wrap.querySelector(`[data-editform="${b.dataset.canceleditbtn}"]`).style.display = 'none';
    }));
    wrap.querySelectorAll('[data-taketicketsbtn]').forEach(b=> b.addEventListener('click', ()=>{
      const id = b.dataset.taketicketsbtn;
      const form = wrap.querySelector(`[data-taketicketsform="${id}"]`);
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }));
    wrap.querySelectorAll('[data-canceltaketicketsbtn]').forEach(b=> b.addEventListener('click', ()=>{
      wrap.querySelector(`[data-taketicketsform="${b.dataset.canceltaketicketsbtn}"]`).style.display = 'none';
    }));
    wrap.querySelectorAll('[data-taketicketsconfirm]').forEach(b=> b.addEventListener('click', async ()=>{
      const id = b.dataset.taketicketsconfirm;
      const qtyRaw = wrap.querySelector(`[data-take-qty="${id}"]`).value.trim();
      const numsRaw = wrap.querySelector(`[data-take-numbers="${id}"]`).value.trim();
      const note = wrap.querySelector(`[data-take-note="${id}"]`).value.trim();
      if (!qtyRaw && !numsRaw){ alert('Enter a quantity or specific numbers'); return; }
      const body = { note: note || undefined };
      if (numsRaw) {
        body.numbers = numsRaw.split(',').map(s=> s.trim()).filter(Boolean);
      } else {
        body.quantity = qtyRaw;
      }
      b.disabled = true;
      try{
        const res = await api(`/raffles/${id}/admin-take`, { method:'POST', body: JSON.stringify(body) });
        alert(`Took ${res.order.ticketNumbers.length} ticket(s): ${res.order.ticketNumbers.join(', ')}`);
        loadRaffles(); loadSummary(); loadOrders();
      }catch(e){ alert(e.message); }
      finally{ b.disabled = false; }
    }));
    wrap.querySelectorAll('[data-savebtn]').forEach(b=> b.addEventListener('click', async ()=>{
      const id = b.dataset.savebtn;
      const raffleNumber = wrap.querySelector(`[data-edit-rafflenumber="${id}"]`).value;
      const title = wrap.querySelector(`[data-edit-title="${id}"]`).value.trim();
      const subtitle = wrap.querySelector(`[data-edit-subtitle="${id}"]`).value.trim();
      const price = wrap.querySelector(`[data-edit-price="${id}"]`).value;
      const totalNumbers = wrap.querySelector(`[data-edit-totalnumbers="${id}"]`).value;
      const badge = wrap.querySelector(`[data-edit-badge="${id}"]`).value;
      const rating = wrap.querySelector(`[data-edit-rating="${id}"]`).value;
      if (!raffleNumber || !title || !price || !totalNumbers){ alert('Raffle number, title, price, and total numbers are required'); return; }
      b.disabled = true;
      try{
        await api(`/raffles/${id}`, { method:'PUT', body: JSON.stringify({ raffleNumber, title, subtitle, price, totalNumbers, badge, rating }) });
        loadRaffles(); loadSummary();
      }catch(e){ alert(e.message); }
      finally{ b.disabled = false; }
    }));

    wrap.querySelectorAll('[data-end]').forEach(b=> b.addEventListener('click', async ()=>{
      await api(`/raffles/${b.dataset.end}`, { method:'PUT', body: JSON.stringify({ status:'ended' }) }); loadRaffles();
    }));
    wrap.querySelectorAll('[data-activate]').forEach(b=> b.addEventListener('click', async ()=>{
      await api(`/raffles/${b.dataset.activate}`, { method:'PUT', body: JSON.stringify({ status:'active' }) }); loadRaffles();
    }));
    wrap.querySelectorAll('[data-delete]').forEach(b=> b.addEventListener('click', async ()=>{
      if (!confirm('Delete this raffle and all its data, including every order/ticket placed on it?')) return;
      b.disabled = true;
      try{
        const res = await api(`/raffles/${b.dataset.delete}`, { method:'DELETE' });
        if (res.removedOrders) alert(`Raffle deleted. ${res.removedOrders} order(s)/ticket(s) tied to it were also removed.`);
        loadRaffles(); loadSummary(); loadOrders();
      }catch(e){ alert(e.message); b.disabled = false; }
    }));
    wrap.querySelectorAll('[data-draw]').forEach(b=> b.addEventListener('click', async ()=>{
      try{
        const res = await api(`/raffles/${b.dataset.draw}/draw`, { method:'POST' });
        alert(`Winner: ticket #${res.winner.number} — ${res.winner.fullName} (${res.winner.phone})`);
        loadRaffles();
      }catch(e){ alert(e.message); }
    }));
    wrap.querySelectorAll('[data-updatedate]').forEach(b=> b.addEventListener('click', async ()=>{
      const id = b.dataset.updatedate;
      const input = wrap.querySelector(`[data-drawinput="${id}"]`);
      if (!input.value){ alert('Pick a date first'); return; }
      const drawAt = new Date(input.value).toISOString();
      b.disabled = true;
      try{
        await api(`/raffles/${id}`, { method:'PUT', body: JSON.stringify({ drawAt }) });
        wrap.querySelector(`[data-drawlabel="${id}"]`).textContent = new Date(drawAt).toLocaleString();
      }catch(e){ alert(e.message); }
      finally{ b.disabled = false; }
    }));
    wrap.querySelectorAll('[data-photobtn]').forEach(b=> b.addEventListener('click', ()=>{
      wrap.querySelector(`[data-photoinput="${b.dataset.photobtn}"]`).click();
    }));
    wrap.querySelectorAll('[data-photoinput]').forEach(inp=> inp.addEventListener('change', async ()=>{
      if (!inp.files || !inp.files[0]) return;
      const id = inp.dataset.photoinput;
      const fd = new FormData();
      fd.append('photo', inp.files[0]);
      try{
        const uploaded = await apiForm('/raffles/photo', fd);
        await api(`/raffles/${id}`, { method:'PUT', body: JSON.stringify({ imageUrl: uploaded.imageUrl }) });
        loadRaffles();
      }catch(e){ alert(e.message); }
      finally{ inp.value = ''; }
    }));
  }catch(e){ console.error(e); }
}

document.getElementById('newImageFile').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  const wrap = document.getElementById('newImagePreviewWrap');
  if (!file){ wrap.style.display = 'none'; return; }
  document.getElementById('newImagePreview').src = URL.createObjectURL(file);
  wrap.style.display = 'block';
});

document.getElementById('createRaffleBtn').addEventListener('click', async ()=>{
  const body = {
    raffleNumber: document.getElementById('newRaffleNumber').value,
    title: document.getElementById('newTitle').value.trim(),
    subtitle: document.getElementById('newSubtitle').value.trim(),
    price: document.getElementById('newPrice').value,
    totalNumbers: document.getElementById('newTotalNumbers').value,
    imageUrl: document.getElementById('newImageUrl').value.trim(),
    drawAt: document.getElementById('newDrawAt').value ? new Date(document.getElementById('newDrawAt').value).toISOString() : undefined,
    badge: document.getElementById('newBadge').value,
    rating: document.getElementById('newRating').value
  };
  if (!body.raffleNumber || !body.title || !body.price || !body.totalNumbers){ alert('Raffle number, title, price, and total numbers are required'); return; }
  const fileInput = document.getElementById('newImageFile');
  try{
    // Photo is entirely optional. If the admin picked a file, upload it and
    // let it override anything typed into the URL field; otherwise the URL
    // field (also optional) is used as-is, and if both are empty the raffle
    // is just created with no photo.
    if (fileInput.files && fileInput.files[0]){
      const fd = new FormData();
      fd.append('photo', fileInput.files[0]);
      const uploaded = await apiForm('/raffles/photo', fd);
      body.imageUrl = uploaded.imageUrl;
    }
    await api('/raffles', { method:'POST', body: JSON.stringify(body) });
    ['newRaffleNumber','newTitle','newSubtitle','newPrice','newTotalNumbers','newImageUrl','newDrawAt'].forEach(id=> document.getElementById(id).value='');
    fileInput.value = '';
    document.getElementById('newImagePreviewWrap').style.display = 'none';
    loadRaffles(); loadSummary();
  }catch(e){ alert(e.message); }
});

// ===== Banks =====
async function loadBanks(){
  try{
    const data = await api('/banks');
    const wrap = document.getElementById('banksList');
    if (!data.banks.length){ wrap.innerHTML = '<div class="empty-msg">No bank accounts yet</div>'; return; }
    wrap.innerHTML = data.banks.map(b=> `
      <div class="raffle-item">
        <div><div style="font-weight:700;">${esc(b.name)}</div><div style="font-size:12px;color:var(--text-tertiary);">${esc(b.holder)} · ${esc(b.account)}</div></div>
        <button class="btn-red" data-delbank="${esc(b.id)}">Remove</button>
      </div>
    `).join('');
    wrap.querySelectorAll('[data-delbank]').forEach(btn=> btn.addEventListener('click', async ()=>{
      await api(`/banks/${btn.dataset.delbank}`, { method:'DELETE' }); loadBanks();
    }));
  }catch(e){ console.error(e); }
}
document.getElementById('addBankBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('newBankName').value.trim();
  const holder = document.getElementById('newBankHolder').value.trim();
  const account = document.getElementById('newBankAccount').value.trim();
  if (!name || !account){ alert('Bank name and account number are required'); return; }
  try{
    await api('/banks', { method:'POST', body: JSON.stringify({ name, holder, account }) });
    ['newBankName','newBankHolder','newBankAccount'].forEach(id=> document.getElementById(id).value='');
    loadBanks();
  }catch(e){ alert(e.message); }
});

// ===== Settings =====
document.getElementById('changeUsernameBtn').addEventListener('click', async ()=>{
  const currentPassword = document.getElementById('curPassForUsername').value;
  const newUsername = document.getElementById('newUsername').value.trim();
  try{
    const res = await api('/change-username', { method:'POST', body: JSON.stringify({ currentPassword, newUsername }) });
    alert('Username updated');
    document.getElementById('curPassForUsername').value=''; document.getElementById('newUsername').value='';
    document.getElementById('whoAmI').textContent = `Logged in as ${res.username}`;
  }catch(e){ alert(e.message); }
});

document.getElementById('changePassBtn').addEventListener('click', async ()=>{
  const currentPassword = document.getElementById('curPass').value;
  const newPassword = document.getElementById('newPass').value;
  try{
    await api('/change-password', { method:'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    alert('Password updated');
    document.getElementById('curPass').value=''; document.getElementById('newPass').value='';
  }catch(e){ alert(e.message); }
});

document.getElementById('changeEmailBtn').addEventListener('click', async ()=>{
  const currentPassword = document.getElementById('curPassForEmail').value;
  const email = document.getElementById('newEmail').value.trim();
  try{
    const res = await api('/account/email', { method:'POST', body: JSON.stringify({ currentPassword, email }) });
    alert(res.email ? 'Recovery email saved' : 'Recovery email removed');
    document.getElementById('curPassForEmail').value=''; document.getElementById('newEmail').value='';
    document.getElementById('currentEmailLabel').textContent = res.email
      ? `Currently: ${res.email}`
      : 'Not set - you won\'t be able to use "Forgot password?" until you add one.';
  }catch(e){ alert(e.message); }
});

document.getElementById('saveTelegramBtn').addEventListener('click', async ()=>{
  const currentPassword = document.getElementById('curPassForTelegram').value;
  const telegramUsername = document.getElementById('newTelegramUsername').value.trim();
  try{
    const res = await api('/account/telegram', { method:'POST', body: JSON.stringify({ currentPassword, telegramUsername }) });
    alert(res.telegramUsername ? 'Telegram username saved - now message the bot, then click "Link Telegram"' : 'Telegram username removed');
    document.getElementById('curPassForTelegram').value='';
    document.getElementById('telegramStatusLabel').textContent = res.telegramUsername
      ? (res.telegramLinked ? `Linked: @${res.telegramUsername}` : `@${res.telegramUsername} saved, but not linked yet - see below.`)
      : 'Not set - you won\'t be notified when a new order needs approval.';
  }catch(e){ alert(e.message); }
});

document.getElementById('linkTelegramBtn').addEventListener('click', async ()=>{
  try{
    const res = await api('/telegram/link-account', { method:'POST', body: JSON.stringify({}) });
    if (res.telegramLinked){
      alert('Telegram linked - you\'ll now get a message when a new order needs approval.');
      checkAuth();
    }
  }catch(e){ alert(e.message); }
});

// ===== Forgot password (from the login screen, no session yet) =====
document.getElementById('forgotPasswordLink').addEventListener('click', (e)=>{
  e.preventDefault();
  const wrap = document.getElementById('forgotWrap');
  const showing = wrap.style.display !== 'none';
  wrap.style.display = showing ? 'none' : 'block';
  if (!showing) document.getElementById('forgotUsername').value = document.getElementById('loginUser').value.trim();
});

document.getElementById('forgotSubmitBtn').addEventListener('click', async ()=>{
  const username = document.getElementById('forgotUsername').value.trim();
  const errEl = document.getElementById('forgotErr');
  const msgEl = document.getElementById('forgotMsg');
  showErr(errEl, '');
  msgEl.style.display = 'none';
  if (!username){ showErr(errEl, 'Enter your username'); return; }
  const btn = document.getElementById('forgotSubmitBtn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try{
    const res = await api('/forgot-password', { method:'POST', body: JSON.stringify({ username }) });
    msgEl.textContent = res.message;
    msgEl.style.display = 'block';
  }catch(e){
    showErr(errEl, e.message);
  }finally{
    btn.disabled = false; btn.textContent = 'Send Reset Link';
  }
});

// ===== Password visibility toggles =====
document.querySelectorAll('.pw-toggle').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const input = document.getElementById(btn.dataset.for);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.classList.toggle('showing', !showing);
    btn.title = showing ? 'Show password' : 'Hide password';
    btn.setAttribute('aria-label', btn.title);
  });
});

checkAuth();
