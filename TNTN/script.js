let isOnline = true, map;
let counts = { red: 0, yellow: 0, green: 0 };
let simLat = 21.0285, simLng = 105.8542; // chỉ dùng làm tâm bản đồ mặc định (Hà Nội), KHÔNG dùng làm vị trí SOS

function switchTab(viewId, btn) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.setAttribute('aria-selected', 'false'));
    document.getElementById(viewId).classList.add('active');
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Xử lý nạp bản đồ khi click sang Tab Bản đồ
    if (viewId === 'map-view') {
        if (!map) {
            initMap();
        }
        // HÀM QUAN TRỌNG: Buộc Leaflet tính toán lại kích thước sau khi hiển thị Tab
        setTimeout(() => {
            map.invalidateSize();
        }, 300);
    }
}

function toggleNetwork() {
    isOnline = document.getElementById("network-checkbox").checked;
    const st = document.getElementById("network-status"), icon = document.getElementById("wifi-icon");
    if (isOnline) {
        st.innerText = "Đang Online"; st.style.color = "#4CAF50"; icon.className = "fa-solid fa-wifi"; icon.style.color = "#4CAF50";
    } else {
        st.innerText = "Offline"; st.style.color = "#e53935"; icon.className = "fa-solid fa-wifi-slash"; icon.style.color = "#e53935";
    }
    const w = document.getElementById("auth-offline"); if (w) w.hidden = isOnline;
    if (isOnline) syncPending();
}

function initMap() {
    map = L.map('map').setView([simLat, simLng], 10);

    // DÙNG BẢN ĐỒ NỀN TỐI CHUYÊN NGHIỆP CỦA ESRI (100% MIỄN PHÍ, KHÔNG CẦN KEY, KHÔNG LỖI CSS)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
        maxZoom: 16
    }).addTo(map);
    sosList.forEach(addMarker);
    if (sosList.length) map.fitBounds(sosList.map(r => [r.lat, r.lng]), { padding: [60, 60], maxZoom: 12 });
}

// ===== LƯU TRỮ & HIỂN THỊ SOS =====
const SOS_KEY = 'relieflink_sos', PENDING_KEY = 'relieflink_pending';
const COLORS = { red: '#e53935', yellow: '#FDD835', green: '#4CAF50' };
const loadJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
let sosList = loadJSON(SOS_KEY), pendingList = loadJSON(PENDING_KEY);
const markerById = {};

function addMarker(rec) {
    if (!map) return; // bản đồ chưa mở: initMap() sẽ vẽ lại toàn bộ từ sosList
    const c = COLORS[rec.status];
    const icon = L.divIcon({ className: 'custom-pin', iconSize: [20, 20],
        html: `<div style="background-color:${c};width:20px;height:20px;border-radius:50%;border:2px solid white;box-shadow:0 0 10px ${c};"></div>` });
    const popup = document.createElement('div'), strong = document.createElement('strong');
    strong.textContent = (rec.name ? rec.name + ' · ' : '') + rec.phone;
    popup.append(strong, document.createElement('br'), document.createTextNode(rec.desc));
    if (rec.accuracy != null) {
        const ac = document.createElement('div');
        ac.style.cssText = 'margin-top:5px;font-size:11px;color:#667085';
        ac.textContent = 'Vị trí GPS · sai số ≈ ' + rec.accuracy + ' m';
        popup.append(ac);
        L.circle([rec.lat, rec.lng], { radius: rec.accuracy, color: c, weight: 1, fillColor: c, fillOpacity: 0.12, interactive: false }).addTo(map);
    }
    if (rec.images && rec.images.length) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap';
        rec.images.forEach(src => { const im = document.createElement('img'); im.src = src; im.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px'; row.append(im); });
        popup.append(row);
    }
    markerById[rec.id] = L.marker([rec.lat, rec.lng], { icon }).addTo(map).bindPopup(popup, { maxWidth: 260 });
}

function addFeedItem(rec) {
    const empty = document.getElementById('empty-feed');
    if (empty) empty.remove();
    const c = COLORS[rec.status];
    const item = document.createElement('div'), ph = document.createElement('strong'), ds = document.createElement('i');
    item.className = 'feed-item'; item.style.borderLeftColor = c;
    ph.style.color = c; ph.textContent = (rec.name ? rec.name + ' · ' : '') + rec.phone; ds.textContent = rec.desc;
    item.append(ph, document.createElement('br'), ds);
    if (rec.accuracy != null || (rec.images && rec.images.length)) {
        const meta = document.createElement('div');
        meta.style.cssText = 'margin-top:4px;color:#98a2b0';
        const parts = [];
        if (rec.accuracy != null) parts.push('GPS ±' + rec.accuracy + ' m');
        if (rec.images && rec.images.length) parts.push(rec.images.length + ' ảnh');
        meta.textContent = '📍 ' + parts.join(' · ');
        item.append(meta);
    }
    document.getElementById('sos-feed').prepend(item);
}

function showSOS(rec) {
    counts[rec.status]++;
    document.getElementById('stat-' + rec.status).innerText = counts[rec.status];
    updateBadge();
    if (!document.getElementById('noti-panel').hidden) renderNoti();
    addFeedItem(rec);
    addMarker(rec);
}

// ===== ĐÁNH GIÁ MỨC ĐỘ NGUY HIỂM (rule-based, mô phỏng AI) =====
const LEVELS = {
    red:    { name: 'NHÃN ĐỎ - KHẨN CẤP TÍNH MẠNG', icon: 'fa-triangle-exclamation', short: 'Đỏ - Khẩn cấp', desc: 'Nguy hiểm đến tính mạng: ngập sâu, mắc kẹt, sạt lở, có người bị thương hoặc nhóm dễ tổn thương. Được ưu tiên điều lực lượng cứu hộ ngay.' },
    yellow: { name: 'NHÃN VÀNG - CẦN NHU YẾU PHẨM', icon: 'fa-box-open', short: 'Vàng - Cần vật tư', desc: 'Tạm an toàn về vị trí nhưng thiếu lương thực, nước sạch, thuốc men hoặc bị chia cắt. Cần tiếp tế sớm.' },
    green:  { name: 'NHÃN XANH - AN TOÀN / ĐÃ ỨNG CỨU', icon: 'fa-shield-heart', short: 'Xanh - An toàn', desc: 'Đã có lực lượng tiếp cận hoặc đã nhận đủ hỗ trợ. Hệ thống chỉ ghi nhận để theo dõi.' }
};
const RULES = {
    red: [
        ['ngap mai|trut noc|len tan tran|ngap sau|tren mai|mai nha|ngap nuoc', 'Nhắc đến ngập sâu / mắc kẹt trên mái nhà'],
        ['mac ket|sat lo|sat nui|vui lap|lu ong|lu quet|mat noc|chim ghe|duoi nuoc', 'Có dấu hiệu mắc kẹt, sạt lở, lũ quét hoặc chìm phương tiện'],
        ['bi thuong|thuong vong|chet|cap cuu|benh nang|chay mau|ngat|bat tinh', 'Có người bị thương hoặc cần cấp cứu'],
        ['mang thai|chuyen da|so sinh|em be|tre nho|tre em|nguoi gia|ba chau|cu gia|con nho', 'Có nhóm dễ bị tổn thương (trẻ em, người già, thai phụ)'],
        ['cuu voi|cuu toi|nguy hiem|urgent_|khan cap', 'Có từ ngữ kêu cứu khẩn cấp']
    ],
    yellow: [
        ['het com|het meo|het luong|hungry_|can kiet|thieu luong|luong thuc', 'Thiếu hoặc hết lương thực'],
        ['het nuoc|khong co nuoc|nuoc sach|nuoc ngot|khat', 'Thiếu nước sạch'],
        ['mat dien|co lap|chia cat|het thuoc|thieu thuoc|thuoc men', 'Mất điện / bị chia cắt / thiếu thuốc men']
    ],
    green: [['da duoc cuu|da co doi|da nhan|da duoc ho tro|an toan|da on', 'Cho biết đã được ứng cứu hoặc đã an toàn']]
};
const noAccent = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const hit = (text, pat) => new RegExp('\\b(' + pat + ')\\b').test(text);

function assessSOS(desc) {
    const t = noAccent(desc.toLowerCase().replace(/đói/g, 'hungry_').replace(/gấp/g, 'urgent_'));
    const found = { red: [], yellow: [], green: [] };
    Object.keys(RULES).forEach(k => RULES[k].forEach(([pat, why]) => { if (hit(t, pat)) found[k].push(why); }));
    let status, reasons;
    if (found.red.length) { status = 'red'; reasons = found.red; }
    else if (found.green.length && !found.yellow.length) { status = 'green'; reasons = found.green; }
    else if (found.yellow.length) { status = 'yellow'; reasons = found.yellow; }
    else { status = 'yellow'; reasons = ['Chưa đủ thông tin để xác định mức độ - tạm xếp mức ưu tiên cao để lực lượng liên hệ xác minh']; }
    return { status, reasons };
}

function toast(msg, isError) {
    document.querySelectorAll('.toast').forEach(n => n.remove());
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.setAttribute('role', 'status'); el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
}

// Đồng bộ các gói tin SOS lưu khi mất mạng
function syncPending() {
    if (!pendingList.length) return;
    const n = pendingList.length;
    pendingList.forEach(rec => { sosList.push(rec); showSOS(rec); });
    pendingList = []; saveJSON(PENDING_KEY, pendingList); saveJSON(SOS_KEY, sosList); updateBadge();
    toast('Đã có mạng: tự động đồng bộ ' + n + ' gói tin SOS lên hệ thống.');
}

/* ===== AUTH: ĐĂNG NHẬP / ĐĂNG KÝ (demo phía client) ===== */
const USERS_KEY = 'relieflink_users', SESSION_KEY = 'relieflink_session';
const ROLES = {
    citizen: { label: 'Người dân', verify: false, orgLabel: '' },
    rescuer: { label: 'Lực lượng cứu hộ', verify: true, orgLabel: 'Đơn vị / Đội cứu hộ' },
    donor:   { label: 'Nhà hảo tâm', verify: true, orgLabel: 'Tổ chức / Doanh nghiệp (nếu có)' },
    admin:   { label: 'Ban Chỉ đạo PCTT', verify: true, orgLabel: 'Cơ quan / Ban Chỉ huy PCTT' }
};
let authMode = 'login', authRole = 'citizen', lastFocus = null;

const $ = id => document.getElementById(id);
const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const normPhone = s => s.replace(/[\s.\-()]/g, '').replace(/^\+84/, '0');
async function hashPw(pw) {
    try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('relieflink:' + pw));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return btoa(unescape(encodeURIComponent(pw))); }
}

function openAuth(mode) {
    lastFocus = document.activeElement;
    $('auth-overlay').hidden = false;
    document.body.style.overflow = 'hidden';
    switchAuth(mode);
}
function closeAuth() {
    $('auth-overlay').hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function switchAuth(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    $('login-form').hidden = !isLogin;
    $('register-form').hidden = isLogin;
    $('auth-success').hidden = true;
    document.querySelector('.auth-switch').hidden = false;
    $('auth-tab-login').classList.toggle('active', isLogin);
    $('auth-tab-register').classList.toggle('active', !isLogin);
    $('auth-tab-login').setAttribute('aria-selected', isLogin);
    $('auth-tab-register').setAttribute('aria-selected', !isLogin);
    $('auth-offline').hidden = isOnline;
    document.querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
    $('login-error').hidden = true;
    setTimeout(() => $(isLogin ? 'login-id' : 'reg-name').focus(), 30);
}
function togglePw(id, btn) {
    const inp = $(id), show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.innerHTML = '<i class="fa-solid ' + (show ? 'fa-eye-slash' : 'fa-eye') + '"></i>';
    btn.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
}
function selectRole(role) {
    authRole = role;
    document.querySelectorAll('.role-card').forEach(c => c.classList.toggle('selected', c.dataset.role === role));
    const r = ROLES[role];
    $('reg-org-field').hidden = role === 'citizen';
    $('reg-org-label').textContent = r.orgLabel || 'Đơn vị / Tổ chức';
    $('reg-org').placeholder = role === 'donor' ? 'Có thể để trống nếu là cá nhân' : 'Nhập tên đơn vị';
    $('reg-verify').hidden = !r.verify;
}
function setInvalid(inputId, bad) {
    const f = $(inputId).closest('.field');
    f.classList.toggle('invalid', bad);
    return bad;
}

async function handleLogin(e) {
    e.preventDefault();
    const id = $('login-id').value.trim(), pw = $('login-pw').value;
    let bad = setInvalid('login-id', !id);
    bad = setInvalid('login-pw', !pw) || bad;
    const err = $('login-error');
    err.hidden = true;
    if (bad) return false;
    if (!isOnline) { err.hidden = false; err.querySelector('span').textContent = 'Cần kết nối mạng để đăng nhập. Bạn vẫn có thể gửi SOS khi đang offline.'; return false; }
    const key = id.includes('@') ? id.toLowerCase() : normPhone(id);
    const user = store.get(USERS_KEY, []).find(u => u.phone === key || (u.email && u.email === key));
    if (!user || user.pwHash !== await hashPw(pw)) {
        err.hidden = false;
        err.querySelector('span').textContent = 'Thông tin đăng nhập không đúng. Vui lòng kiểm tra lại hoặc đăng ký tài khoản mới.';
        return false;
    }
    startSession(user, $('login-remember').checked);
    showSuccess('Đăng nhập thành công', 'Xin chào ' + user.name + '. ' + (user.status === 'pending' ? 'Tài khoản đang chờ xác minh danh tính - bạn có thể xem bản đồ tổng quan trong lúc chờ.' : 'Chúc bạn một ngày làm việc hiệu quả.'));
    return false;
}

async function handleRegister(e) {
    e.preventDefault();
    const name = $('reg-name').value.trim(), phone = normPhone($('reg-phone').value.trim());
    const email = $('reg-email').value.trim().toLowerCase(), org = $('reg-org').value.trim();
    const pw = $('reg-pw').value, pw2 = $('reg-pw2').value;
    let bad = false;
    bad = setInvalid('reg-name', !name) || bad;
    bad = setInvalid('reg-phone', !/^0\d{9}$/.test(phone)) || bad;
    bad = setInvalid('reg-email', !!email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || bad;
    bad = setInvalid('reg-org', (authRole === 'rescuer' || authRole === 'admin') && !org) || bad;
    bad = setInvalid('reg-pw', pw.length < 8) || bad;
    bad = setInvalid('reg-pw2', pw !== pw2 || !pw2) || bad;
    bad = setInvalid('reg-agree', !$('reg-agree').checked) || bad;
    if (bad) return false;
    if (!isOnline) { $('auth-offline').hidden = false; return false; }
    const users = store.get(USERS_KEY, []);
    if (users.some(u => u.phone === phone || (email && u.email === email))) {
        $('reg-phone').closest('.field').classList.add('invalid');
        $('reg-phone').closest('.field').querySelector('.field-error').textContent = 'Số điện thoại hoặc email này đã được đăng ký.';
        return false;
    }
    const user = { name, phone, email, org, role: authRole, status: ROLES[authRole].verify ? 'pending' : 'active', pwHash: await hashPw(pw) };
    users.push(user);
    store.set(USERS_KEY, users);
    startSession(user, true);
    showSuccess('Đăng ký thành công', ROLES[authRole].verify
        ? 'Hồ sơ của bạn đã được gửi để Ban Chỉ huy PCTT xác minh. Sau khi được duyệt, bạn sẽ xem được thông tin chi tiết để tiếp cận nạn nhân.'
        : 'Tài khoản đã sẵn sàng. Bạn vẫn có thể gửi SOS bất cứ lúc nào, kể cả khi mất mạng.');
    return false;
}

function showSuccess(title, msg) {
    $('login-form').hidden = true; $('register-form').hidden = true;
    document.querySelector('.auth-switch').hidden = true;
    $('auth-offline').hidden = true;
    $('success-title').textContent = title; $('success-msg').textContent = msg;
    $('auth-success').hidden = false;
}
function startSession(user, remember) {
    const s = { name: user.name, phone: user.phone, role: user.role, status: user.status };
    if (remember) store.set(SESSION_KEY, s);
    renderUser(s);
}
function renderUser(s) {
    const box = $('nav-actions');
    box.replaceChildren();
    if (!s) {
        const a = document.createElement('button'), b = document.createElement('button');
        a.className = 'btn btn-signin'; a.textContent = 'Đăng nhập'; a.onclick = () => openAuth('login');
        b.className = 'btn btn-signup'; b.textContent = 'Đăng ký'; b.onclick = () => openAuth('register');
        box.append(a, b);
        return;
    }
    const chip = document.createElement('div'), av = document.createElement('div'), meta = document.createElement('div');
    const nm = document.createElement('b'), rl = document.createElement('span'), out = document.createElement('button');
    chip.className = 'user-chip'; av.className = 'user-avatar'; meta.className = 'user-meta';
    av.textContent = (s.name.trim().split(/\s+/).pop() || '?').charAt(0).toUpperCase();
    nm.textContent = s.name;
    rl.textContent = ROLES[s.role].label + (s.status === 'pending' ? ' · Chờ xác minh' : '');
    if (s.status === 'pending') rl.className = 'pending';
    out.className = 'btn-logout'; out.title = 'Đăng xuất'; out.setAttribute('aria-label', 'Đăng xuất');
    out.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i>'; out.onclick = logout;
    meta.append(nm, rl); chip.append(av, meta, out); box.append(chip);
}
function logout() { store.del(SESSION_KEY); renderUser(null); }
function forgotPw() {
    const err = $('login-error');
    err.hidden = false;
    err.querySelector('span').textContent = 'Tính năng khôi phục mật khẩu qua SMS OTP sẽ có trong phiên bản tiếp theo.';
}
function vneidLogin() {
    const target = authMode === 'login' ? $('login-error') : null;
    if (target) { target.hidden = false; target.querySelector('span').textContent = 'Đăng nhập VNeID (OAuth 2.0 / OpenID Connect) sẽ khả dụng sau khi được Cục C06 - Bộ Công an cấp phép kết nối.'; }
    else { switchAuth('login'); $('login-error').hidden = false; $('login-error').querySelector('span').textContent = 'Đăng ký bằng VNeID sẽ khả dụng sau khi được Cục C06 - Bộ Công an cấp phép kết nối.'; }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('auth-overlay').hidden) closeAuth(); });
renderUser(store.get(SESSION_KEY, null));

// Khôi phục dữ liệu đã lưu khi mở lại trang
sosList.forEach(rec => { counts[rec.status]++; addFeedItem(rec); });
['red', 'yellow', 'green'].forEach(k => document.getElementById('stat-' + k).innerText = counts[k]);

// ===== THÔNG BÁO (CHUÔNG) =====
const READ_KEY = 'relieflink_read';
let readCount = 0;
try { readCount = Math.min(parseInt(localStorage.getItem(READ_KEY)) || 0, sosList.length); } catch (e) { /* trình duyệt chặn lưu trữ */ }
const fmtTime = ts => { const d = new Date(ts), z = n => String(n).padStart(2, '0'); return z(d.getHours()) + ':' + z(d.getMinutes()) + ' ' + z(d.getDate()) + '/' + z(d.getMonth() + 1); };

function updateBadge() {
    const n = Math.max(0, sosList.length - readCount), b = document.getElementById('noti-count');
    b.style.display = n ? 'block' : 'none';
    b.textContent = n > 99 ? '99+' : n;
}
function renderNoti() {
    const list = document.getElementById('noti-list');
    list.replaceChildren();
    const unread = Math.max(0, sosList.length - readCount);
    document.getElementById('noti-sub').textContent = unread ? unread + ' chưa đọc' : 'Đã đọc hết';
    if (pendingList.length) {
        const it = document.createElement('div'); it.className = 'noti-item unread'; it.style.cursor = 'default';
        it.innerHTML = '<div class="noti-dot" style="background:#5b7399"><i class="fa-solid fa-cloud-arrow-up"></i></div><div class="noti-body"><div class="noti-title"></div><div class="noti-text" style="white-space:normal"></div></div>';
        it.querySelector('.noti-title').textContent = 'Đang chờ đồng bộ (' + pendingList.length + ')';
        it.querySelector('.noti-text').textContent = 'Gói tin đã lưu ngoại tuyến, sẽ tự gửi khi có mạng.';
        list.append(it);
    }
    if (!sosList.length && !pendingList.length) {
        const e = document.createElement('div'); e.className = 'noti-empty';
        e.innerHTML = '<i class="fa-regular fa-bell-slash"></i><span>Chưa có thông báo nào</span>';
        list.append(e); return;
    }
    sosList.slice().reverse().slice(0, 30).forEach((rec, i) => {
        const isNew = (sosList.length - 1 - i) >= readCount;
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'noti-item' + (isNew ? ' unread' : '');
        btn.onclick = () => openNotiItem(rec.id);
        const dot = document.createElement('div'); dot.className = 'noti-dot'; dot.style.background = COLORS[rec.status];
        dot.innerHTML = '<i class="fa-solid ' + LEVELS[rec.status].icon + '"></i>';
        const body = document.createElement('div'); body.className = 'noti-body';
        const title = document.createElement('div'); title.className = 'noti-title';
        const tl = document.createElement('span');
        if (isNew) { const d = document.createElement('span'); d.className = 'noti-new'; tl.append(d); }
        tl.append(document.createTextNode('Tín hiệu SOS · ' + LEVELS[rec.status].short));
        const tm = document.createElement('time'); tm.textContent = fmtTime(rec.id);
        title.append(tl, tm);
        const tx = document.createElement('div'); tx.className = 'noti-text'; tx.textContent = (rec.name ? rec.name + ' · ' : '') + rec.phone + ' - ' + rec.desc;
        body.append(title, tx); btn.append(dot, body); list.append(btn);
    });
}
function toggleNoti(e) {
    e.stopPropagation();
    const panel = document.getElementById('noti-panel');
    if (panel.hidden) {
        renderNoti();
        panel.hidden = false;
        document.getElementById('noti-btn').setAttribute('aria-expanded', 'true');
        if (window.innerWidth <= 700) panel.style.top = (document.getElementById('noti-btn').getBoundingClientRect().bottom + 8) + 'px';
    } else closeNoti();
}
function closeNoti() {
    const panel = document.getElementById('noti-panel');
    if (panel.hidden) return;
    panel.hidden = true;
    document.getElementById('noti-btn').setAttribute('aria-expanded', 'false');
    readCount = sosList.length;
    try { localStorage.setItem(READ_KEY, readCount); } catch (e) {}
    updateBadge();
}
function openNotiItem(id) {
    closeNoti();
    switchTab('map-view', document.getElementById('map-tab'));
    setTimeout(() => {
        const m = markerById[id], rec = sosList.find(r => r.id === id);
        if (m && rec && map) { map.setView([rec.lat, rec.lng], 13); m.openPopup(); }
    }, 400);
}
document.addEventListener('click', e => { if (!e.target.closest('.noti-wrap')) closeNoti(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNoti(); });
updateBadge();

/* ===== FORM SOS: 3 BƯỚC BẮT BUỘC → MỞ ẢNH / GIỌNG NÓI ===== */
const MAX_ACCURACY_M = 1000;   // sai số lớn hơn mức này (vd: định vị theo IP) thì KHÔNG chấp nhận
const GOOD_ACCURACY_M = 30;    // đạt mức này thì chốt vị trí ngay
const GEO_REFINE_MS = 15000;   // tối đa thời gian tinh chỉnh sau khi có tín hiệu đầu tiên
const GEO_STALE_MS = 5 * 60 * 1000; // vị trí cũ hơn 5 phút phải lấy lại
const MAX_PHOTOS = 3;
const el = id => document.getElementById(id);
const cleanPhone = v => v.replace(/[\s.\-()]/g, '').replace(/^\+84/, '0');
const nameOk = () => el('full-name').value.trim().length >= 2;
const phoneOk = () => /^0\d{9}$/.test(cleanPhone(el('phone-number').value.trim()));
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
let geo = null, geoWatch = null, geoTimer = null, photos = [];

function refreshSteps() {
    const ok = { name: nameOk(), phone: phoneOk(), desc: el('sos-text').value.trim().length > 0, geo: !!geo };
    [['name', ok.name], ['phone', ok.phone], ['desc', ok.desc], ['geo', ok.geo]].forEach(([k, v]) => {
        const li = el('step-' + k);
        li.classList.toggle('done', v);
        li.querySelector('i').className = v ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle';
    });
    const ready = ok.name && ok.phone && ok.desc && ok.geo;
    el('btn-photo').disabled = !ready;
    el('btn-voice').disabled = !ready;
    el('btn-submit').disabled = !ready;
    el('lock-hint').hidden = ready;
    if (!ready && listening) stopVoice();
}
el('full-name').addEventListener('input', () => { if (nameOk()) el('grp-name').classList.remove('invalid'); refreshSteps(); });
el('full-name').addEventListener('blur', () => { const v = el('full-name').value.trim(); el('grp-name').classList.toggle('invalid', !!v && !nameOk()); });
el('phone-number').addEventListener('input', () => { if (phoneOk()) el('grp-phone').classList.remove('invalid'); refreshSteps(); });
el('phone-number').addEventListener('blur', () => { const v = el('phone-number').value.trim(); el('grp-phone').classList.toggle('invalid', !!v && !phoneOk()); });
el('sos-text').addEventListener('input', refreshSteps);

/* ---------- ĐỊNH VỊ THẬT (GPS / Geolocation API) ---------- */
function setGeoBtn(state) {
    const b = el('btn-gps'), ic = b.querySelector('i'), tx = b.querySelector('span');
    b.classList.toggle('done', state === 'done');
    b.disabled = state === 'loading';
    if (state === 'loading') { ic.className = 'fa-solid fa-spinner fa-spin'; tx.textContent = 'Đang lấy vị trí chính xác...'; }
    else if (state === 'done') { ic.className = 'fa-solid fa-circle-check'; tx.textContent = 'Đã gửi định vị · bấm để cập nhật lại'; }
    else { ic.className = 'fa-solid fa-location-crosshairs'; tx.textContent = 'Gửi định vị'; }
}
function showGeoInfo(html, isNode) { const g = el('geo-info'); g.hidden = false; g.replaceChildren(); if (isNode) g.append(html); else g.textContent = html; }
function showGeoAlert(title, text) { el('geo-alert-title').textContent = title; el('geo-alert-text').textContent = text; el('geo-alert').hidden = false; }
function stopGeoWatch() {
    if (geoWatch !== null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    if (geoTimer) { clearTimeout(geoTimer); geoTimer = null; }
}
function geoErrorMessage(err) {
    if (err.code === 1) {
        return isMobile
            ? ['Chưa truy cập được vị trí', 'Hãy bật Vị trí (GPS) trên điện thoại: vuốt thanh thông báo xuống và bật "Vị trí", hoặc vào Cài đặt › Vị trí. Sau đó cho phép trình duyệt dùng vị trí khi được hỏi (Cài đặt › Quyền của trình duyệt › Vị trí › Cho phép).']
            : ['Bạn đã chặn quyền vị trí', 'Bấm biểu tượng ổ khóa cạnh thanh địa chỉ › Vị trí › Cho phép, rồi bấm Thử lại.'];
    }
    if (err.code === 2) {
        return isMobile
            ? ['Vị trí của điện thoại đang tắt hoặc không có tín hiệu', 'Hãy bật Vị trí (GPS) ở thanh thông báo hoặc Cài đặt, ra nơi thoáng rồi bấm Thử lại.']
            : ['Không xác định được vị trí', 'Hãy kiểm tra dịch vụ vị trí của hệ điều hành đã bật chưa và máy có kết nối Wi-Fi/mạng, rồi bấm Thử lại.'];
    }
    return ['Quá thời gian chờ định vị', 'Chưa nhận được tín hiệu GPS. Hãy ra nơi thoáng, bật Vị trí chế độ độ chính xác cao rồi bấm Thử lại.'];
}
function getLocation() {
    el('geo-alert').hidden = true;
    if (!('geolocation' in navigator)) { showGeoAlert('Thiết bị không hỗ trợ định vị', 'Hãy mở trang bằng Chrome hoặc Safari bản mới.'); return; }
    if (!window.isSecureContext) { showGeoAlert('Trang chưa chạy ở chế độ bảo mật', 'Trình duyệt chỉ cho phép định vị khi trang chạy trên HTTPS hoặc localhost.'); return; }
    stopGeoWatch(); geo = null; refreshSteps(); setGeoBtn('loading');
    el('geo-info').hidden = true;
    let best = null, finished = false;

    const finish = () => {
        if (finished) return; finished = true; stopGeoWatch();
        if (best && best.accuracy <= MAX_ACCURACY_M) {
            geo = best; setGeoBtn('done');
            const q = best.accuracy <= GOOD_ACCURACY_M ? 'rất chính xác' : best.accuracy <= 100 ? 'chính xác' : 'tương đối';
            const box = document.createElement('span');
            box.append(document.createTextNode('Vĩ độ '), Object.assign(document.createElement('b'), { textContent: best.lat.toFixed(6) }),
                document.createTextNode(' · Kinh độ '), Object.assign(document.createElement('b'), { textContent: best.lng.toFixed(6) }),
                document.createTextNode(' · sai số ≈ ' + Math.round(best.accuracy) + ' m (' + q + ')'));
            showGeoInfo(box, true);
        } else {
            setGeoBtn('idle'); el('geo-info').hidden = true;
            showGeoAlert('Vị trí chưa đủ chính xác', 'Thiết bị chỉ xác định được vị trí với sai số khoảng ' + Math.round(best.accuracy) + ' m. Hãy bật GPS / chế độ độ chính xác cao, ra nơi thoáng rồi bấm Thử lại.');
        }
        refreshSteps();
    };

    geoWatch = navigator.geolocation.watchPosition(pos => {
        const c = pos.coords;
        if (!best || c.accuracy < best.accuracy) best = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, ts: Date.now() };
        showGeoInfo('Đang tinh chỉnh vị trí... sai số hiện tại ≈ ' + Math.round(best.accuracy) + ' m');
        if (!geoTimer) geoTimer = setTimeout(finish, GEO_REFINE_MS); // đếm giờ sau khi đã có tín hiệu đầu tiên (không tính lúc chờ người dùng bấm Cho phép)
        if (best.accuracy <= GOOD_ACCURACY_M) finish();
    }, err => {
        if (finished) return;
        if (best) { finish(); return; }
        finished = true; stopGeoWatch(); setGeoBtn('idle'); el('geo-info').hidden = true;
        const [t, m] = geoErrorMessage(err);
        showGeoAlert(t, m);
        if (isMobile && err.code !== 3) toast('Vui lòng bật vị trí (GPS) trên điện thoại rồi bấm lại.', true);
        refreshSteps();
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

/* ---------- HÌNH ẢNH (nén trước khi lưu) ---------- */
function pickPhoto() {
    if (photos.length >= MAX_PHOTOS) { toast('Tối đa ' + MAX_PHOTOS + ' ảnh cho mỗi yêu cầu.', true); return; }
    el('photo-input').click();
}
function compressImage(file, maxSide = 800, quality = 0.65) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file), img = new Image();
        img.onload = () => {
            const k = Math.min(1, maxSide / Math.max(img.width, img.height));
            const cv = document.createElement('canvas');
            cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            URL.revokeObjectURL(url); resolve(cv.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
        img.src = url;
    });
}
el('photo-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files).slice(0, MAX_PHOTOS - photos.length);
    for (const f of files) {
        try { photos.push(await compressImage(f)); } catch (err) { toast('Không đọc được một ảnh, vui lòng chọn ảnh khác.', true); }
    }
    e.target.value = ''; renderThumbs();
});
function renderThumbs() {
    const box = el('thumbs'); box.replaceChildren();
    photos.forEach((src, i) => {
        const t = document.createElement('div'), im = document.createElement('img'), x = document.createElement('button');
        t.className = 'thumb'; im.src = src; im.alt = 'Ảnh đính kèm ' + (i + 1);
        x.type = 'button'; x.setAttribute('aria-label', 'Xóa ảnh ' + (i + 1)); x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        x.onclick = () => { photos.splice(i, 1); renderThumbs(); };
        t.append(im, x); box.append(t);
    });
    el('photo-label').textContent = photos.length ? 'Hình ảnh (' + photos.length + '/' + MAX_PHOTOS + ')' : 'Hình ảnh';
    el('btn-photo').classList.toggle('active', photos.length > 0);
}

/* ---------- GIỌNG NÓI → CHỮ, GHI NỐI VÀO Ô MÔ TẢ ---------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null, listening = false;
function setVoiceUI(on) {
    el('btn-voice').classList.toggle('listening', on);
    el('voice-label').textContent = on ? 'Đang nghe - bấm để dừng' : 'Giọng nói';
    el('voice-live').hidden = !on;
}
function toggleVoice() {
    if (listening) { stopVoice(); return; }
    if (!SpeechRec) { toast('Trình duyệt này chưa hỗ trợ nhận diện giọng nói. Hãy dùng Chrome hoặc Safari bản mới.', true); return; }
    listening = true; setVoiceUI(true); startRecognizer();
}
function startRecognizer() {
    const ta = el('sos-text');
    let base = ta.value.trim();
    const r = new SpeechRec();
    r.lang = 'vi-VN'; r.continuous = true; r.interimResults = true;
    r.onresult = e => {
        let interim = '', fin = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) fin += t; else interim += t;
        }
        if (fin) base = (base + ' ' + fin.trim()).trim();
        ta.value = (base + ' ' + interim).trim().slice(0, 500);
        refreshSteps();
    };
    r.onerror = e => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        listening = false;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Chưa được cấp quyền micro. Hãy cho phép micro trong cài đặt trình duyệt.', true);
        else if (e.error === 'network') toast('Nhận diện giọng nói cần kết nối mạng.', true);
        else if (e.error === 'audio-capture') toast('Không tìm thấy micro trên thiết bị.', true);
        else toast('Không nhận diện được giọng nói, vui lòng thử lại.', true);
    };
    r.onend = () => {
        if (listening) { try { startRecognizer(); } catch (err) { listening = false; setVoiceUI(false); } }
        else setVoiceUI(false);
    };
    recognizer = r;
    try { r.start(); } catch (err) { listening = false; setVoiceUI(false); }
}
function stopVoice() {
    listening = false;
    if (recognizer) { try { recognizer.stop(); } catch (e) {} }
    setVoiceUI(false);
}

/* ---------- GỬI SOS: dùng đúng tọa độ GPS đã lấy ---------- */
function submitSOS() {
    const desc = el('sos-text').value.trim();
    if (!nameOk()) { el('grp-name').classList.add('invalid'); el('full-name').focus(); toast('Vui lòng nhập họ và tên.', true); return; }
    if (!phoneOk()) { el('grp-phone').classList.add('invalid'); el('phone-number').focus(); toast('Vui lòng nhập số điện thoại hợp lệ.', true); return; }
    if (!desc) { el('sos-text').focus(); toast('Vui lòng mô tả tình trạng.', true); return; }
    if (!geo) { toast('Vui lòng bấm "Gửi định vị" để gửi vị trí của bạn.', true); return; }
    if (Date.now() - geo.ts > GEO_STALE_MS) {
        geo = null; setGeoBtn('idle'); el('geo-info').hidden = true; refreshSteps();
        toast('Vị trí đã cũ, vui lòng bấm "Gửi định vị" lại để cập nhật.', true); return;
    }
    stopVoice();
    const a = assessSOS(desc);
    const rec = {
        id: Date.now(), name: el('full-name').value.trim().replace(/\s+/g, ' '), phone: cleanPhone(el('phone-number').value.trim()), desc, status: a.status,
        lat: geo.lat, lng: geo.lng, accuracy: Math.round(geo.accuracy), images: photos.slice()
    };
    if (isOnline) {
        sosList.push(rec); saveJSON(SOS_KEY, sosList);
        showSOS(rec);
        toast('Đã gửi SOS · AI đánh giá: ' + LEVELS[rec.status].name);
    } else {
        pendingList.push(rec); saveJSON(PENDING_KEY, pendingList);
        toast('Đang offline: đã lưu gói tin (' + LEVELS[rec.status].short + '), sẽ tự đồng bộ khi có mạng.');
    }
    el('full-name').value = ''; el('phone-number').value = ''; el('sos-text').value = '';
    geo = null; photos = []; renderThumbs(); setGeoBtn('idle'); el('geo-info').hidden = true; el('geo-alert').hidden = true;
    refreshSteps();
}
refreshSteps();
