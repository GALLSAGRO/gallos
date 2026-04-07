const token = localStorage.getItem('token');
if (!token) window.location.href = '/login';

let user = JSON.parse(localStorage.getItem('user') || '{}');
let currentRoom = null;
let currentFight = null;
let currentEvent = null;
let selectedGallo = null;
let socket = null;

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await refreshMe();
    await loadRooms();

    const modal = document.getElementById('modalRetiro');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === this) cerrarRetiro();
      });
    }
  } catch (err) {
    console.error(err);
    showNotificacion('Error al cargar la aplicación');
  }
});

async function api(url, opts = {}) {
  opts.headers = {
    ...(opts.headers || {}),
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const r = await fetch(url, opts);
  let data = null;

  try {
    data = await r.json();
  } catch {
    data = { ok: false, error: 'Respuesta inválida del servidor' };
  }

  if (!r.ok) {
    return {
      ok: false,
      error: data?.error || `Error ${r.status}`
    };
  }

  if (Array.isArray(data)) return data;

  if (data && typeof data === 'object' && data.ok === undefined) {
    data.ok = true;
  }

  return data;
}

async function refreshMe() {
  const data = await api('/api/me');
  if (!data?.ok) {
    console.error(data?.error || 'No se pudo cargar el usuario');
    return;
  }

  user = data;
  localStorage.setItem('user', JSON.stringify(user));

  const navUser = document.getElementById('navUser');
  const navPuntos = document.getElementById('navPuntos');
  const saldoMini = document.getElementById('saldoMini');
  const adminLink = document.getElementById('adminLink');

  if (navUser) navUser.textContent = user.username || 'Usuario';
  if (navPuntos) navPuntos.textContent = `${Number(user.puntos || 0)} pts`;
  if (saldoMini) saldoMini.textContent = `${Number(user.puntos || 0)} pts`;
  if (adminLink) adminLink.style.display = user.is_admin ? 'inline-block' : 'none';
}

/* ── Salas ─────────────────────────────────────────────────────────────── */
async function loadRooms() {
  const rooms = await api('/api/rooms');
  const list = document.getElementById('roomList');
  if (!list) return;

  if (!Array.isArray(rooms) || !rooms.length) {
    list.innerHTML = `<p class="no-data">No hay salas disponibles en este momento</p>`;
    return;
  }

  list.innerHTML = rooms.map(r => `
    <div class="room-card" onclick="enterRoom('${escapeAttr(r.slug)}', \`${String(r.facebook_live_url || '').replace(/`/g, '\\`')}\`)">
      <h3>${escapeHtml(r.nombre || r.slug || 'Sala')}</h3>
      <p>${r.activos ? 'En vivo' : 'Cerrado'}</p>
    </div>
  `).join('');
}

async function enterRoom(slug, liveUrl) {
  currentRoom = slug;

  const roomSelector = document.getElementById('roomSelector');
  const roomView = document.getElementById('roomView');
  const chatMessages = document.getElementById('chatMessages');
  const historialList = document.getElementById('historialList');
  const betsActivas = document.getElementById('betsActivas');
  const betsHistorial = document.getElementById('betsHistorial');
  const chatRoomName = document.getElementById('chatRoomName');
  const frame = document.getElementById('liveFrame');

  if (roomSelector) roomSelector.style.display = 'none';
  if (roomView) roomView.style.display = 'block';
  if (chatMessages) chatMessages.innerHTML = '';
  if (historialList) historialList.innerHTML = '<p class="no-data">Cargando historial...</p>';
  if (betsActivas) betsActivas.innerHTML = '<p class="no-data">Cargando apuestas...</p>';
  if (betsHistorial) betsHistorial.innerHTML = '';
  if (chatRoomName) chatRoomName.textContent = slug;
  if (frame) frame.src = liveUrl || 'about:blank';

  connectSocket(slug);
  await loadRoomState();
  await loadMyBets();
}

function backToRooms() {
  if (socket) {
    socket.emit('leave-room', { roomSlug: currentRoom });
    socket.disconnect();
    socket = null;
  }

  currentRoom = null;
  currentFight = null;
  currentEvent = null;
  selectedGallo = null;

  const roomSelector = document.getElementById('roomSelector');
  const roomView = document.getElementById('roomView');
  const frame = document.getElementById('liveFrame');
  const historialList = document.getElementById('historialList');
  const chatMessages = document.getElementById('chatMessages');
  const betsActivas = document.getElementById('betsActivas');
  const betsHistorial = document.getElementById('betsHistorial');
  const chatRoomName = document.getElementById('chatRoomName');

  if (roomSelector) roomSelector.style.display = 'block';
  if (roomView) roomView.style.display = 'none';
  if (frame) frame.src = 'about:blank';
  if (historialList) historialList.innerHTML = '';
  if (chatMessages) chatMessages.innerHTML = '';
  if (betsActivas) betsActivas.innerHTML = '';
  if (betsHistorial) betsHistorial.innerHTML = '';
  if (chatRoomName) chatRoomName.textContent = '';

  renderNoFight();
}

/* ── Socket ────────────────────────────────────────────────────────────── */
function connectSocket(roomSlug) {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io({ auth: { token } });

  socket.on('connect', () => {
    socket.emit('join-room', roomSlug);
  });

  socket.on('room-state', ({ room, activeEvent, current, matches, scores, historial, pool }) => {
    const frame = document.getElementById('liveFrame');

    currentEvent = activeEvent || null;

    if (room?.facebook_live_url && frame) {
      frame.src = room.facebook_live_url;
    }

    if (current) {
      renderFight(current);
      renderPool(pool || [], current);
    } else {
      renderNoFight();
      renderPool([], null);
    }

    if (historial) {
      renderHistorial(historial);
    }
  });

  socket.on('event:match_result', async () => {
    await loadRoomState();
    await loadMyBets();
  });

  socket.on('bet-placed', ({ pool, me }) => {
    renderPool(pool || [], currentFight);

    if (me?.puntos != null) {
      user.puntos = me.puntos;
      localStorage.setItem('user', JSON.stringify(user));

      const navPuntos = document.getElementById('navPuntos');
      const saldoMini = document.getElementById('saldoMini');
      if (navPuntos) navPuntos.textContent = `${me.puntos} pts`;
      if (saldoMini) saldoMini.textContent = `${me.puntos} pts`;
    }

    loadMyBets();
  });

  socket.on('chat-message', ({ username, message, system }) => {
    appendChatMsg({ username, message, system });
  });

  socket.on('balance-update', ({ puntos }) => {
    user.puntos = puntos;
    localStorage.setItem('user', JSON.stringify(user));

    const navPuntos = document.getElementById('navPuntos');
    const saldoMini = document.getElementById('saldoMini');
    if (navPuntos) navPuntos.textContent = `${puntos} pts`;
    if (saldoMini) saldoMini.textContent = `${puntos} pts`;

    loadMyBets();
  });

  socket.on('room-closed', ({ message }) => {
    renderNoFight();
    if (message) showNotificacion(message);
  });
}

async function loadRoomState() {
  if (!currentRoom) return;

  const data = await api(`/api/rooms/${encodeURIComponent(currentRoom)}`);
  if (!data?.ok && data?.error) {
    console.error(data.error);
    return;
  }

  currentEvent = data.activeEvent || null;

  const frame = document.getElementById('liveFrame');
  if (data?.room?.facebook_live_url && frame) {
    frame.src = data.room.facebook_live_url;
  }

  if (data?.current) {
    renderFight(data.current);
    renderPool(data.pool || [], data.current);
  } else {
    renderNoFight();
    renderPool([], null);
  }

  renderHistorial(data.historial || []);
}

/* ── Render pelea ──────────────────────────────────────────────────────── */
function renderNoFight() {
  currentFight = null;
  selectedGallo = null;

  const fightTitleStage = document.getElementById('fightTitleStage');
  const noFight = document.getElementById('noFight');
  const fightCard = document.getElementById('fightCard');
  const betForm = document.getElementById('betForm');
  const betClosed = document.getElementById('betClosed');
  const resultBanner = document.getElementById('resultBanner');
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');
  const btnASelect = document.getElementById('btnASelect');
  const btnBSelect = document.getElementById('btnBSelect');
  const poolA = document.getElementById('poolA');
  const poolB = document.getElementById('poolB');
  const betAmount = document.getElementById('betAmount');
  const estadoBadge = document.getElementById('estadoBadge');

  if (fightTitleStage) fightTitleStage.textContent = 'Sin pelea activa';
  if (noFight) noFight.style.display = 'block';
  if (fightCard) fightCard.style.display = 'none';
  if (betForm) betForm.style.display = 'none';
  if (betClosed) {
    betClosed.style.display = 'block';
    betClosed.textContent = 'Las apuestas aparecerán aquí cuando la pelea esté abierta.';
  }
  if (resultBanner) resultBanner.style.display = 'none';

  if (btnA) btnA.textContent = 'Equipo Rojo';
  if (btnB) btnB.textContent = 'Equipo Verde';
  if (btnASelect) {
    btnASelect.textContent = 'Rojo';
    btnASelect.classList.remove('selected');
  }
  if (btnBSelect) {
    btnBSelect.textContent = 'Verde';
    btnBSelect.classList.remove('selected');
  }

  if (poolA) poolA.textContent = '0 pts · 50%';
  if (poolB) poolB.textContent = '0 pts · 50%';
  if (betAmount) betAmount.value = '';

  if (estadoBadge) {
    estadoBadge.textContent = 'Sin estado';
    estadoBadge.className = 'estado-badge';
  }
}

function renderFight(fight) {
  currentFight = fight;
  selectedGallo = null;

  const rojo = fight.nombre_equipo_rojo || 'Equipo Rojo';
  const verde = fight.nombre_equipo_verde || 'Equipo Verde';

  const fightTitleStage = document.getElementById('fightTitleStage');
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');
  const btnASelect = document.getElementById('btnASelect');
  const btnBSelect = document.getElementById('btnBSelect');
  const noFight = document.getElementById('noFight');
  const fightCard = document.getElementById('fightCard');
  const resultBanner = document.getElementById('resultBanner');
  const betForm = document.getElementById('betForm');
  const betClosed = document.getElementById('betClosed');
  const betAmount = document.getElementById('betAmount');

  if (fightTitleStage) fightTitleStage.textContent = `${rojo} vs ${verde}`;
  if (btnA) btnA.textContent = rojo;
  if (btnB) btnB.textContent = verde;
  if (btnASelect) btnASelect.textContent = rojo;
  if (btnBSelect) btnBSelect.textContent = verde;

  if (noFight) noFight.style.display = 'none';
  if (fightCard) fightCard.style.display = 'block';
  if (resultBanner) resultBanner.style.display = 'none';

  updateEstadoBadge(fight.estado || 'sin_estado');

  const open = ['lista', 'apostando'].includes(fight.estado);
  if (betForm) betForm.style.display = open ? 'block' : 'none';
  if (betClosed) {
    betClosed.style.display = open ? 'none' : 'block';

    if (!open) {
      betClosed.textContent =
        fight.estado === 'en_vivo'
          ? 'La pelea está en vivo. Las apuestas están cerradas.'
          : fight.estado === 'terminada'
            ? 'La pelea ha finalizado.'
            : 'Las apuestas no están abiertas en este momento.';
    }
  }

  if (btnASelect) btnASelect.classList.remove('selected');
  if (btnBSelect) btnBSelect.classList.remove('selected');
  if (betAmount) betAmount.value = '';
}

function updateEstadoBadge(estado) {
  const badge = document.getElementById('estadoBadge');
  if (!badge) return;

  const labels = {
    pendiente: 'Pendiente',
    lista: 'Lista',
    apostando: 'Apostando',
    en_vivo: 'En vivo',
    terminada: 'Terminada',
    finalizada: 'Finalizada',
    sin_estado: 'Sin estado'
  };

  badge.textContent = labels[estado] || estado;
  badge.className = 'estado-badge estado-' + String(estado).replaceAll('_', '-');
}

function renderPool(poolData, fight = null) {
  const poolA = document.getElementById('poolA');
  const poolB = document.getElementById('poolB');
  if (!poolA || !poolB) return;

  let totalRojo = 0;
  let totalVerde = 0;

  (poolData || []).forEach(p => {
    const lado = String(p.gallo || p.lado || p.side || '').toUpperCase();

    if (lado === 'R' || lado === 'ROJO') {
      totalRojo += Number(p.total || p.puntos || p.puntos_total || 0);
    } else if (lado === 'V' || lado === 'VERDE') {
      totalVerde += Number(p.total || p.puntos || p.puntos_total || 0);
    }
  });

  if (!totalRojo && !totalVerde && fight) {
    totalRojo = Number(fight.puntos_rojo || 0);
    totalVerde = Number(fight.puntos_verde || 0);
  }

  const total = totalRojo + totalVerde;
  const pctRojo = total > 0 ? Math.round((totalRojo / total) * 100) : 50;
  const pctVerde = total > 0 ? 100 - pctRojo : 50;

  poolA.textContent = `${totalRojo} pts · ${pctRojo}%`;
  poolB.textContent = `${totalVerde} pts · ${pctVerde}%`;
}

/* ── Historial ─────────────────────────────────────────────────────────── */
function renderHistorial(peleas) {
  const el = document.getElementById('historialList');
  if (!el) return;

  if (!peleas.length) {
    el.innerHTML = '<p class="no-data">Sin peleas registradas en esta sala</p>';
    return;
  }

  el.innerHTML = `
    <table class="bets-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Rojo</th>
          <th>Verde</th>
          <th>Resultado</th>
        </tr>
      </thead>
      <tbody>
        ${peleas.map((p, i) => {
          const rojo = p.nombre_equipo_rojo || 'Equipo Rojo';
          const verde = p.nombre_equipo_verde || 'Equipo Verde';

          const resultado = p.resultado === 'rojo'
            ? `<span class="gallo-rojo">${escapeHtml(rojo)}</span>`
            : p.resultado === 'verde'
              ? `<span class="gallo-verde">${escapeHtml(verde)}</span>`
              : p.resultado === 'tablas'
                ? 'Tablas'
                : '-';

          return `
            <tr>
              <td>${p.numero_pelea || (peleas.length - i)}</td>
              <td class="gallo-rojo">${escapeHtml(rojo)}</td>
              <td class="gallo-verde">${escapeHtml(verde)}</td>
              <td>${resultado}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

/* ── Apuestas ──────────────────────────────────────────────────────────── */
function selectGallo(g) {
  selectedGallo = g;

  const btnASelect = document.getElementById('btnASelect');
  const btnBSelect = document.getElementById('btnBSelect');

  if (btnASelect) btnASelect.classList.toggle('selected', g === 'R');
  if (btnBSelect) btnBSelect.classList.toggle('selected', g === 'V');
}

function setQuickAmount(amount) {
  const betAmount = document.getElementById('betAmount');
  if (betAmount) betAmount.value = amount;
}

async function placeBet() {
  if (!currentFight) return showBetMsg('No hay pelea activa', 'error');
  if (!currentEvent) return showBetMsg('No hay evento activo', 'error');
  if (!selectedGallo) return showBetMsg('Selecciona rojo o verde', 'error');

  const puntos = parseInt(document.getElementById('betAmount')?.value, 10);
  if (!puntos || puntos <= 0) return showBetMsg('Ingresa un monto válido', 'error');

  const roomState = await api(`/api/rooms/${encodeURIComponent(currentRoom)}`);
  if (!roomState?.room?.id || !roomState?.activeEvent?.id || !roomState?.current?.id) {
    return showBetMsg('No se pudo obtener el estado actual de la sala', 'error');
  }

  const res = await api('/api/bets', {
    method: 'POST',
    body: JSON.stringify({
      room_id: roomState.room.id,
      event_id: roomState.activeEvent.id,
      event_match_id: roomState.current.id,
      gallo: selectedGallo,
      puntos
    })
  });

  if (!res.ok) {
    return showBetMsg(res.error || 'No se pudo registrar la apuesta', 'error');
  }

  const unmatchedMsg = res.unmatched > 0
    ? ` (${res.unmatched} pts en espera de contrincante)`
    : '';

  showBetMsg('Apuesta registrada' + unmatchedMsg, 'success');
  document.getElementById('betAmount').value = '';

  await refreshMe();
  await loadMyBets();
  await loadRoomState();
}

async function loadMyBets() {
  const bets = await api('/api/bets/my');
  if (!Array.isArray(bets)) {
    renderBetsTable('betsActivas', [], 'Sin apuestas activas');
    renderBetsTable('betsHistorial', [], 'Sin historial de apuestas');
    return;
  }

  const activas = bets.filter(b => ['pendiente', 'matcheada', 'matched'].includes(String(b.estado || '').toLowerCase()));
  const hist = bets.filter(b =>
    ['cerrada', 'terminada', 'pagada', 'settled'].includes(String(b.estado || '').toLowerCase()) ||
    b.resultado
  );

  renderBetsTable('betsActivas', activas, 'Sin apuestas activas');
  renderBetsTable('betsHistorial', hist, 'Sin historial de apuestas');
}

function renderBetsTable(elId, bets, emptyMsg) {
  const el = document.getElementById(elId);
  if (!el) return;

  if (!bets.length) {
    el.innerHTML = `<p class="no-data">${emptyMsg}</p>`;
    return;
  }

  el.innerHTML = `
    <table class="bets-table">
      <thead>
        <tr>
          <th>Pelea</th>
          <th>Lado</th>
          <th>Pts</th>
          <th>Estado</th>
        </tr>
      </thead>
      <tbody>
        ${bets.map(b => {
          const rojo = b.nombre_equipo_rojo || 'Equipo Rojo';
          const verde = b.nombre_equipo_verde || 'Equipo Verde';

          const lado = String(b.gallo || '').toUpperCase();
          const ladoName = lado === 'R' ? rojo : lado === 'V' ? verde : '-';
          const ladoClass = lado === 'R' ? 'gallo-rojo' : lado === 'V' ? 'gallo-verde' : '';

          const resultado = b.resultado || null;
          const ganoBadge = resultado
            ? (
                (resultado === 'rojo' && lado === 'R') || (resultado === 'verde' && lado === 'V')
                  ? '<span style="color:var(--verde);font-weight:700">Ganaste</span>'
                  : resultado === 'tablas'
                    ? '<span style="color:var(--oro);font-weight:700">Tablas</span>'
                    : '<span style="color:var(--rojo);font-weight:700">Perdiste</span>'
              )
            : '';

          return `
            <tr>
              <td style="font-size:.8rem">${escapeHtml(rojo)} vs ${escapeHtml(verde)}</td>
              <td class="${ladoClass}">${escapeHtml(ladoName)}</td>
              <td>${Number(b.puntos_total || 0)}</td>
              <td style="font-size:.8rem">${escapeHtml(b.estado || '-')} ${ganoBadge}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function switchBetsTab(tab, btn) {
  document.querySelectorAll('.bets-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const betsActivas = document.getElementById('betsActivas');
  const betsHistorial = document.getElementById('betsHistorial');

  if (betsActivas) betsActivas.style.display = tab === 'activas' ? 'block' : 'none';
  if (betsHistorial) betsHistorial.style.display = tab === 'historial' ? 'block' : 'none';
}

/* ── Chat ──────────────────────────────────────────────────────────────── */
function appendChatMsg({ username, message, system }) {
  const box = document.getElementById('chatMessages');
  if (!box) return;

  const div = document.createElement('div');
  div.className = 'chat-msg' + (system ? ' system' : '');

  if (system) {
    div.innerHTML = `<span class="chat-text">${escapeHtml(message)}</span>`;
  } else {
    div.innerHTML = `
      <span class="chat-user">${escapeHtml(username || 'Usuario')}:</span>
      <span class="chat-text">${escapeHtml(message || '')}</span>
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

/* ── Retiros ───────────────────────────────────────────────────────────── */
function abrirRetiro() {
  const retiroMsg = document.getElementById('retiroMsg');
  const retiroAmount = document.getElementById('retiroAmount');
  const retiroDestino = document.getElementById('retiroDestino');
  const modalRetiro = document.getElementById('modalRetiro');

  if (retiroMsg) retiroMsg.textContent = '';
  if (retiroAmount) retiroAmount.value = '';
  if (retiroDestino) retiroDestino.value = '';
  if (modalRetiro) modalRetiro.classList.add('open');

  loadMisRetiros();
}

function cerrarRetiro() {
  const modalRetiro = document.getElementById('modalRetiro');
  if (modalRetiro) modalRetiro.classList.remove('open');
}

async function solicitarRetiro() {
  const amount = parseInt(document.getElementById('retiroAmount')?.value, 10);
  const destination = document.getElementById('retiroDestino')?.value.trim();
  const el = document.getElementById('retiroMsg');

  if (!amount || amount <= 0) {
    if (el) {
      el.textContent = 'Ingresa un monto válido';
      el.className = 'bet-msg error';
    }
    return;
  }

  if (!destination) {
    if (el) {
      el.textContent = 'Ingresa el destino';
      el.className = 'bet-msg error';
    }
    return;
  }

  const res = await api('/api/withdrawals', {
    method: 'POST',
    body: JSON.stringify({ amount, destination })
  });

  if (!res.ok) {
    if (el) {
      el.textContent = res.error || 'No se pudo enviar la solicitud';
      el.className = 'bet-msg error';
    }
    return;
  }

  if (el) {
    el.textContent = 'Solicitud enviada. El administrador la procesará pronto.';
    el.className = 'bet-msg success';
  }

  document.getElementById('retiroAmount').value = '';
  document.getElementById('retiroDestino').value = '';

  await refreshMe();
  await loadMisRetiros();
}

async function loadMisRetiros() {
  const list = await api('/api/withdrawals/my');
  const el = document.getElementById('misRetirosList');
  if (!el) return;

  if (!Array.isArray(list) || !list.length) {
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
          const fechaRaw = w.created_at || w.updated_at;
          const fecha = fechaRaw
            ? new Date(fechaRaw).toLocaleDateString('es-MX', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
              })
            : '-';

          const estadoColor = {
            pending: '#f39c18',
            approved: '#27ae60',
            rejected: '#c0392b',
            paid: '#2980b9'
          }[w.status] || '#888';

          return `
            <tr>
              <td><strong>${Number(w.amount || 0)}</strong></td>
              <td style="max-width:120px;word-break:break-all;font-size:.8rem">${escapeHtml(w.destination || '-')}</td>
              <td><span style="color:${estadoColor};font-weight:600">${escapeHtml(w.status || '-')}</span></td>
              <td style="font-size:.8rem;color:var(--muted)">${fecha}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */
function showBetMsg(msg, type) {
  const el = document.getElementById('betMsg');
  if (!el) return;

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
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return String(str ?? '').replace(/'/g, "\\'");
}