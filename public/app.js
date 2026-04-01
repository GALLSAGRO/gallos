const token = localStorage.getItem('token');
if (!token) window.location.href = '/login';

let user = JSON.parse(localStorage.getItem('user') || '{}');
let currentRoom = null;
let currentFight = null;
let selectedGallo = null;
let socket = null;

document.addEventListener('DOMContentLoaded', async () => {
  await refreshMe();
  await loadRooms();

  const modal = document.getElementById('modalRetiro');
  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === this) cerrarRetiro();
    });
  }
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

  document.getElementById('navUser').textContent = user.username;
  document.getElementById('navPuntos').textContent = user.puntos + ' pts';
  document.getElementById('saldoMini').textContent = user.puntos + ' pts';

  if (user.is_admin) {
    document.getElementById('adminLink').style.display = 'inline-block';
  }
}

// ── Salas ─────────────────────────────────────────────────────────────────────
async function loadRooms() {
  const rooms = await api('/api/rooms');
  const list = document.getElementById('roomList');

  if (!rooms.length) {
    list.innerHTML = `<p class="no-data">No hay salas disponibles en este momento</p>`;
    return;
  }

  list.innerHTML = rooms.map(r => `
    <div class="room-card" onclick="enterRoom('${escapeAttr(r.slug)}', \`${(r.facebook_live_url || '').replace(/`/g, '\\`')}\`)">
      <h3>${escapeHtml(r.nombre)}</h3>
      <p>${r.activo ? 'En vivo' : 'Cerrado'}</p>
    </div>
  `).join('');
}

async function enterRoom(slug, liveUrl) {
  currentRoom = slug;

  document.getElementById('roomSelector').style.display = 'none';
  document.getElementById('roomView').style.display = 'block';

  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('historialList').innerHTML = '<p class="no-data">Cargando historial...</p>';
  document.getElementById('betsActivas').innerHTML = '<p class="no-data">Cargando apuestas...</p>';
  document.getElementById('betsHistorial').innerHTML = '';
  document.getElementById('chatRoomName').textContent = slug;

  const frame = document.getElementById('liveFrame');
  frame.src = liveUrl || 'about:blank';

  connectSocket(slug);
  await loadMyBets();
}

function backToRooms() {
  if (socket) socket.disconnect();

  currentRoom = null;
  currentFight = null;
  selectedGallo = null;

  document.getElementById('roomSelector').style.display = 'block';
  document.getElementById('roomView').style.display = 'none';
  document.getElementById('liveFrame').src = 'about:blank';
  document.getElementById('historialList').innerHTML = '';
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('betsActivas').innerHTML = '';
  document.getElementById('betsHistorial').innerHTML = '';
  document.getElementById('fightTitleStage').textContent = 'Sin pelea activa';
  document.getElementById('noFight').style.display = 'block';
  document.getElementById('fightCard').style.display = 'none';
  document.getElementById('betForm').style.display = 'none';
  document.getElementById('betClosed').style.display = 'block';
  document.getElementById('resultBanner').style.display = 'none';
  document.getElementById('chatRoomName').textContent = '';
  updateEstadoBadge('apostando');
  document.getElementById('estadoBadge').textContent = 'Sin estado';
  document.getElementById('estadoBadge').className = 'estado-badge';
}

// ── Socket ────────────────────────────────────────────────────────────────────
function connectSocket(roomSlug) {
  if (socket) socket.disconnect();

  socket = io({ auth: { token } });
  socket.emit('join-room', { roomSlug });

  socket.on('room-state', ({ fight, pool: poolData }) => {
    if (fight) {
      renderFight(fight);
      renderPool(poolData || []);
    } else {
      renderNoFight();
      renderPool([]);
    }
  });

  socket.on('fight-created', (fight) => {
    renderFight(fight);
    renderPool([]);
    showNotificacion('Nueva pelea disponible');
  });

  socket.on('fight-updated', ({ fightId, estado }) => {
    if (currentFight && currentFight.id == fightId) {
      currentFight.estado = estado;
      updateEstadoBadge(estado);

      const open = estado === 'apostando';
      document.getElementById('betForm').style.display = open ? 'block' : 'none';
      document.getElementById('betClosed').style.display = open ? 'none' : 'block';

      if (estado === 'en_vivo') {
        showNotificacion('Apuestas cerradas');
      }
    }
  });

  socket.on('bet-placed', ({ pool: poolData }) => {
    renderPool(poolData || []);
  });

  socket.on('fight-result', ({ fight }) => {
    currentFight = fight;
    updateEstadoBadge('terminada');

    document.getElementById('betForm').style.display = 'none';
    document.getElementById('betClosed').style.display = 'block';

    const banner = document.getElementById('resultBanner');
    const winnerName = fight.ganador === 'A'
      ? document.getElementById('btnA').textContent
      : document.getElementById('btnB').textContent;

    banner.textContent = 'Ganador: ' + winnerName;
    banner.className = 'result-banner ' + (fight.ganador === 'A' ? 'banner-rojo' : 'banner-verde');
    banner.style.display = 'block';

    refreshMe();
    loadMyBets();
    showNotificacion('Resultado actualizado');
  });

  socket.on('historial', (peleas) => {
    renderHistorial(peleas || []);
  });

  socket.on('chat-message', ({ username, message, system }) => {
    appendChatMsg({ username, message, system });
  });

  socket.on('balance-update', ({ puntos }) => {
    user.puntos = puntos;
    localStorage.setItem('user', JSON.stringify(user));
    document.getElementById('navPuntos').textContent = puntos + ' pts';
    document.getElementById('saldoMini').textContent = puntos + ' pts';
    loadMyBets();
  });
}

// ── Render pelea ──────────────────────────────────────────────────────────────
function renderNoFight() {
  currentFight = null;
  selectedGallo = null;

  document.getElementById('fightTitleStage').textContent = 'Sin pelea activa';
  document.getElementById('noFight').style.display = 'block';
  document.getElementById('fightCard').style.display = 'none';
  document.getElementById('betForm').style.display = 'none';
  document.getElementById('betClosed').style.display = 'block';
  document.getElementById('betClosed').textContent = 'Las apuestas aparecerán aquí cuando la pelea esté en estado de apuesta.';
  document.getElementById('resultBanner').style.display = 'none';
  document.getElementById('btnA').textContent = '—';
  document.getElementById('btnB').textContent = '—';
  document.getElementById('btnASelect').textContent = 'Rojo';
  document.getElementById('btnBSelect').textContent = 'Verde';
  document.getElementById('poolA').textContent = '0 pts';
  document.getElementById('poolB').textContent = '0 pts';
  document.getElementById('btnASelect').classList.remove('selected');
  document.getElementById('btnBSelect').classList.remove('selected');
  document.getElementById('betAmount').value = '';

  document.getElementById('estadoBadge').textContent = 'Sin estado';
  document.getElementById('estadoBadge').className = 'estado-badge';
}

function renderFight(fight) {
  currentFight = fight;
  selectedGallo = null;

  document.getElementById('fightTitleStage').textContent = fight.gallo_a + ' vs ' + fight.gallo_b;
  document.getElementById('btnA').textContent = fight.gallo_a;
  document.getElementById('btnB').textContent = fight.gallo_b;
  document.getElementById('btnASelect').textContent = fight.gallo_a;
  document.getElementById('btnBSelect').textContent = fight.gallo_b;

  document.getElementById('noFight').style.display = 'none';
  document.getElementById('fightCard').style.display = 'block';
  document.getElementById('resultBanner').style.display = 'none';

  updateEstadoBadge(fight.estado);

  const open = fight.estado === 'apostando';
  document.getElementById('betForm').style.display = open ? 'block' : 'none';
  document.getElementById('betClosed').style.display = open ? 'none' : 'block';

  if (!open) {
    document.getElementById('betClosed').textContent = fight.estado === 'en_vivo'
      ? 'La pelea está en vivo. Las apuestas están cerradas.'
      : 'La pelea ha finalizado.';
  }

  document.getElementById('btnASelect').classList.remove('selected');
  document.getElementById('btnBSelect').classList.remove('selected');
  document.getElementById('betAmount').value = '';
}

function updateEstadoBadge(estado) {
  const badge = document.getElementById('estadoBadge');
  const labels = {
    apostando: 'Apostando',
    en_vivo: 'En vivo',
    terminada: 'Terminada'
  };

  badge.textContent = labels[estado] || estado;
  badge.className = 'estado-badge estado-' + estado;
}

function renderPool(poolData) {
  if (!currentFight) return;

  let totalA = 0;
  let totalB = 0;

  poolData.forEach(p => {
    if (p.gallo === 'A') totalA = Number(p.total);
    else totalB = Number(p.total);
  });

  const total = totalA + totalB;
  const pctA = total > 0 ? Math.round((totalA / total) * 100) : 50;
  const pctB = 100 - pctA;

  document.getElementById('poolA').textContent = totalA + ' pts · ' + pctA + '%';
  document.getElementById('poolB').textContent = totalB + ' pts · ' + pctB + '%';
}

// ── Historial ─────────────────────────────────────────────────────────────────
function renderHistorial(peleas) {
  const el = document.getElementById('historialList');

  if (!peleas.length) {
    el.innerHTML = '<p class="no-data">Sin peleas registradas en este evento</p>';
    return;
  }

  el.innerHTML = `
    <table class="bets-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Rojo</th>
          <th>Verde</th>
          <th>Estado</th>
          <th>Ganador</th>
        </tr>
      </thead>
      <tbody>
        ${peleas.map((p, i) => {
          const ganadorName = p.ganador === 'A'
            ? `<span class="gallo-rojo">${escapeHtml(p.gallo_a)}</span>`
            : p.ganador === 'B'
              ? `<span class="gallo-verde">${escapeHtml(p.gallo_b)}</span>`
              : '-';

          const estadoClass = {
            apostando: 'estado-apostando',
            en_vivo: 'estado-en_vivo',
            terminada: 'estado-terminada'
          }[p.estado] || '';

          return `
            <tr>
              <td>${peleas.length - i}</td>
              <td class="gallo-rojo">${escapeHtml(p.gallo_a)}</td>
              <td class="gallo-verde">${escapeHtml(p.gallo_b)}</td>
              <td>
                <span class="estado-badge ${estadoClass}" style="font-size:.74rem;padding:4px 10px">
                  ${escapeHtml(p.estado)}
                </span>
              </td>
              <td>${ganadorName}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ── Apuestas ──────────────────────────────────────────────────────────────────
function selectGallo(g) {
  selectedGallo = g;
  document.getElementById('btnASelect').classList.toggle('selected', g === 'A');
  document.getElementById('btnBSelect').classList.toggle('selected', g === 'B');
}

function setQuickAmount(amount) {
  document.getElementById('betAmount').value = amount;
}

async function placeBet() {
  if (!currentFight) return showBetMsg('No hay pelea activa', 'error');
  if (!selectedGallo) return showBetMsg('Selecciona un gallo', 'error');

  const puntos = parseInt(document.getElementById('betAmount').value);
  if (!puntos || puntos <= 0) return showBetMsg('Ingresa un monto válido', 'error');

  const res = await api('/api/bets', {
    method: 'POST',
    body: JSON.stringify({
      room_id: currentFight.room_id,
      pelea_id: currentFight.id,
      gallo: selectedGallo,
      puntos
    })
  });

  if (!res.ok) return showBetMsg(res.error || 'No se pudo registrar la apuesta', 'error');

  const unmatchedMsg = res.unmatched > 0
    ? ' (' + res.unmatched + ' pts en espera de contrincante)'
    : '';

  showBetMsg('Apuesta registrada' + unmatchedMsg, 'success');
  document.getElementById('betAmount').value = '';
  refreshMe();
  loadMyBets();
}

async function loadMyBets() {
  const bets = await api('/api/bets/my');
  const activas = bets.filter(b => ['pendiente', 'matcheada'].includes(b.estado));
  const hist = bets.filter(b => ['cerrada', 'terminada'].includes(b.estado) || b.ganador);

  renderBetsTable('betsActivas', activas, 'Sin apuestas activas');
  renderBetsTable('betsHistorial', hist, 'Sin historial de apuestas');
}

function renderBetsTable(elId, bets, emptyMsg) {
  const el = document.getElementById(elId);

  if (!bets.length) {
    el.innerHTML = `<p class="no-data">${emptyMsg}</p>`;
    return;
  }

  el.innerHTML = `
    <table class="bets-table">
      <thead>
        <tr>
          <th>Pelea</th>
          <th>Gallo</th>
          <th>Pts</th>
          <th>Estado</th>
        </tr>
      </thead>
      <tbody>
        ${bets.map(b => {
          const galloName = b.gallo === 'A' ? b.gallo_a : b.gallo_b;
          const galloClass = b.gallo === 'A' ? 'gallo-rojo' : 'gallo-verde';
          const ganoBadge = b.ganador
            ? b.ganador === b.gallo
              ? '<span style="color:var(--verde);font-weight:700">Ganaste</span>'
              : '<span style="color:var(--rojo);font-weight:700">Perdiste</span>'
            : '';

          return `
            <tr>
              <td style="font-size:.8rem">${escapeHtml(b.gallo_a)} vs ${escapeHtml(b.gallo_b)}</td>
              <td class="${galloClass}">${escapeHtml(galloName)}</td>
              <td>${b.puntos_total}</td>
              <td style="font-size:.8rem">${escapeHtml(b.estado)} ${ganoBadge}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function switchBetsTab(tab, btn) {
  document.querySelectorAll('.bets-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  document.getElementById('betsActivas').style.display = tab === 'activas' ? 'block' : 'none';
  document.getElementById('betsHistorial').style.display = tab === 'historial' ? 'block' : 'none';
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function appendChatMsg({ username, message, system }) {
  const box = document.getElementById('chatMessages');
  if (!box) return;

  const div = document.createElement('div');
  div.className = 'chat-msg' + (system ? ' system' : '');

  if (system) {
    div.innerHTML = `<span class="chat-text">${escapeHtml(message)}</span>`;
  } else {
    div.innerHTML = `
      <span class="chat-user">${escapeHtml(username)}:</span>
      <span class="chat-text">${escapeHtml(message)}</span>
    `;
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chatInput');
  if (!input) return;

  const msg = input.value.trim();
  if (!msg || !currentRoom || !socket) return;

  socket.emit('chat-message', {
    roomSlug: currentRoom,
    message: msg,
    username: user.username
  });

  input.value = '';
}

// ── Retiros ───────────────────────────────────────────────────────────────────
function abrirRetiro() {
  document.getElementById('retiroMsg').textContent = '';
  document.getElementById('retiroAmount').value = '';
  document.getElementById('retiroDestino').value = '';
  document.getElementById('modalRetiro').classList.add('open');
  loadMisRetiros();
}

function cerrarRetiro() {
  document.getElementById('modalRetiro').classList.remove('open');
}

async function solicitarRetiro() {
  const amount = parseInt(document.getElementById('retiroAmount').value);
  const destination = document.getElementById('retiroDestino').value.trim();
  const el = document.getElementById('retiroMsg');

  if (!amount || amount <= 0) {
    el.textContent = 'Ingresa un monto válido';
    el.className = 'bet-msg error';
    return;
  }

  if (!destination) {
    el.textContent = 'Ingresa el destino';
    el.className = 'bet-msg error';
    return;
  }

  const res = await api('/api/withdrawals', {
    method: 'POST',
    body: JSON.stringify({ amount, destination })
  });

  if (!res.ok) {
    el.textContent = res.error || 'No se pudo enviar la solicitud';
    el.className = 'bet-msg error';
    return;
  }

  el.textContent = 'Solicitud enviada. El administrador la procesará pronto.';
  el.className = 'bet-msg success';

  document.getElementById('retiroAmount').value = '';
  document.getElementById('retiroDestino').value = '';

  refreshMe();
  loadMisRetiros();
}

async function loadMisRetiros() {
  const list = await api('/api/withdrawals/my');
  const el = document.getElementById('misRetirosList');

  if (!list.length) {
    el.innerHTML = '<p class="no-data">Sin solicitudes anteriores</p>';
    return;
  }

  el.innerHTML = `
    <table class="bets-table">
      <thead>
        <tr>
          <th>Puntos</th>
          <th>Destino</th>
          <th>Estado</th>
          <th>Fecha</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(w => {
          const fecha = new Date(w.created_at).toLocaleDateString('es-MX', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
          });

          const estadoColor = {
            pending: '#f39c18',
            approved: '#27ae60',
            rejected: '#c0392b'
          }[w.status] || '#888';

          return `
            <tr>
              <td><strong>${w.amount}</strong></td>
              <td style="max-width:120px;word-break:break-all;font-size:.8rem">${escapeHtml(w.destination || '-')}</td>
              <td><span style="color:${estadoColor};font-weight:600">${escapeHtml(w.status)}</span></td>
              <td style="font-size:.8rem;color:var(--muted)">${fecha}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showBetMsg(msg, type) {
  const el = document.getElementById('betMsg');
  el.textContent = msg;
  el.className = 'bet-msg ' + type;
  setTimeout(() => {
    el.textContent = '';
    el.className = 'bet-msg';
  }, 4000);
}

function showNotificacion(msg) {
  const el = document.createElement('div');
  el.className = 'notificacion';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function logout() {
  localStorage.clear();
  window.location.href = '/login';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return String(str).replace(/'/g, "\\'");
}