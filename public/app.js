const token = localStorage.getItem('token');
if (!token) window.location.href = '/login.html';

let user = JSON.parse(localStorage.getItem('user') || '{}');
let currentRoom  = null;
let currentFight = null;
let selectedGallo = null;
let socket = null;

document.addEventListener('DOMContentLoaded', async () => {
  await refreshMe();
  await loadRooms();
});

async function api(url, opts = {}) {
  opts.headers = {
    ...(opts.headers || {}),
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  const r = await fetch(url, opts);
  return r.json();
}

async function refreshMe() {
  const data = await api('/api/me');
  user = data;
  localStorage.setItem('user', JSON.stringify(user));
  document.getElementById('navUser').textContent    = user.username;
  document.getElementById('navPuntos').textContent  = user.puntos + ' pts';
  if (user.is_admin) document.getElementById('adminLink').style.display = 'inline-block';
}

// ── Salas ─────────────────────────────────────────────────────────────────────
async function loadRooms() {
  const rooms = await api('/api/rooms');
  const list  = document.getElementById('roomList');
  list.innerHTML = rooms.map(r => `
    <div class="room-card" onclick="enterRoom('${r.slug}', \`${r.facebook_live_url}\`)">
      <h3>${r.nombre}</h3>
      <p>${r.activo ? 'En vivo' : 'Cerrado'}</p>
    </div>
  `).join('');
}

async function enterRoom(slug, liveUrl) {
  currentRoom = slug;
  document.getElementById('roomSelector').style.display = 'none';
  document.getElementById('roomView').style.display     = 'block';
  document.getElementById('liveFrame').src = liveUrl;
  connectSocket(slug);
  await loadMyBets();
}

function backToRooms() {
  if (socket) socket.disconnect();
  currentRoom = null; currentFight = null; selectedGallo = null;
  document.getElementById('roomSelector').style.display = 'block';
  document.getElementById('roomView').style.display     = 'none';
  document.getElementById('liveFrame').src = '';
}

// ── Socket ────────────────────────────────────────────────────────────────────
function connectSocket(roomSlug) {
  socket = io({ auth: { token } });
  socket.emit('join-room', { roomSlug });

  socket.on('room-state', ({ fight, pool: poolData }) => {
    renderFight(fight);
    renderPool(poolData);
  });

  socket.on('fight-created', (fight) => {
    renderFight(fight);
    renderPool([]);
  });

  socket.on('fight-updated', ({ fightId, estado }) => {
    if (currentFight && currentFight.id == fightId) {
      currentFight.estado = estado;
      updateEstadoBadge(estado);
      document.getElementById('betForm').style.display = 'none';
    }
  });

  socket.on('bet-placed', ({ pool: poolData }) => renderPool(poolData));

  socket.on('fight-result', ({ fight }) => {
    currentFight = fight;
    updateEstadoBadge('terminada');
    document.getElementById('betForm').style.display   = 'none';
    const banner = document.getElementById('resultBanner');
    const winnerName = fight.ganador === 'A'
      ? document.getElementById('btnA').textContent
      : document.getElementById('btnB').textContent;
    banner.textContent    = 'Ganador: ' + winnerName;
    banner.className      = 'result-banner ' + (fight.ganador === 'A' ? 'banner-rojo' : 'banner-verde');
    banner.style.display  = 'block';
    refreshMe();
    loadMyBets();
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderFight(fight) {
  currentFight = fight;
  document.getElementById('noFight').style.display   = 'none';
  document.getElementById('fightCard').style.display = 'block';
  document.getElementById('resultBanner').style.display = 'none';

  document.getElementById('fightTitle').textContent = fight.gallo_a + ' vs ' + fight.gallo_b;
  document.getElementById('btnA').textContent = fight.gallo_a;
  document.getElementById('btnB').textContent = fight.gallo_b;

  updateEstadoBadge(fight.estado);
  document.getElementById('betForm').style.display = fight.estado === 'apostando' ? 'block' : 'none';
}

function updateEstadoBadge(estado) {
  const badge = document.getElementById('estadoBadge');
  const labels = { apostando: 'Apostando', en_vivo: 'En Vivo', terminada: 'Terminada' };
  badge.textContent = labels[estado] || estado;
  badge.className   = 'estado-badge estado-' + estado;
}

function renderPool(poolData) {
  if (!currentFight) return;
  let totalA = 0, totalB = 0;
  poolData.forEach(p => { if (p.gallo === 'A') totalA = p.total; else totalB = p.total; });
  document.getElementById('poolA').textContent = currentFight.gallo_a + ': ' + totalA + ' pts';
  document.getElementById('poolB').textContent = currentFight.gallo_b + ': ' + totalB + ' pts';
}

// ── Apuestas ──────────────────────────────────────────────────────────────────
function selectGallo(g) {
  selectedGallo = g;
  document.getElementById('btnA').classList.toggle('selected', g === 'A');
  document.getElementById('btnB').classList.toggle('selected', g === 'B');
}

async function placeBet() {
  if (!selectedGallo) return showBetMsg('Selecciona un gallo', 'error');
  const puntos = parseInt(document.getElementById('betAmount').value);
  if (!puntos || puntos <= 0) return showBetMsg('Ingresa un monto valido', 'error');

  const res = await api('/api/bets', {
    method: 'POST',
    body: JSON.stringify({
      room_id:  currentFight.room_id,
      pelea_id: currentFight.id,
      gallo:    selectedGallo,
      puntos
    })
  });

  if (!res.ok) return showBetMsg(res.error, 'error');
  const unmatchedMsg = res.unmatched > 0 ? ` (${res.unmatched} pts en espera de contrincante)` : '';
  showBetMsg('Apuesta registrada' + unmatchedMsg, 'success');
  document.getElementById('betAmount').value = '';
  refreshMe();
  loadMyBets();
}

async function loadMyBets() {
  const bets = await api('/api/bets/my');
  const el   = document.getElementById('myBetsList');
  if (!bets.length) { el.innerHTML = '<p class="no-data">Sin apuestas registradas</p>'; return; }

  el.innerHTML = `
    <table class="bets-table">
      <thead>
        <tr>
          <th>Sala</th><th>Pelea</th><th>Gallo</th><th>Pts</th><th>Matched</th><th>Estado</th>
        </tr>
      </thead>
      <tbody>
        ${bets.map(b => {
          const galloName  = b.gallo === 'A' ? b.gallo_a : b.gallo_b;
          const galloClass = b.gallo === 'A' ? 'gallo-rojo' : 'gallo-verde';
          return `
            <tr>
              <td>${b.sala}</td>
              <td>${b.gallo_a} vs ${b.gallo_b}</td>
              <td class="${galloClass}">${galloName}</td>
              <td>${b.puntos_total}</td>
              <td>${b.puntos_matched}</td>
              <td>${b.estado}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function showBetMsg(msg, type) {
  const el = document.getElementById('betMsg');
  el.textContent = msg;
  el.className   = 'bet-msg ' + type;
  setTimeout(() => { el.textContent = ''; }, 4000);
}

function logout() {
  localStorage.clear();
  window.location.href = '/login.html';
}