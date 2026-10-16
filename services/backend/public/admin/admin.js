(function () {
  "use strict";
 
  // ─── Auth state (Loaded from /api/me during application startup) ───────
  var currentUser = null;   // { username, role }
 
  var STALE_DIFF_MS = 10 * 1000;
  var COUNTDOWN_SECONDS = 5;
 
  var countdownStart = {};
  var currentDevices = [];
  var selectedDeviceIds = [];
  var latestTimestampUp = null;
 
  var deviceWsMap = {};
 
  // ─── Load user information and redirect if the user is not logged in ───────────────
  function loadCurrentUser(cb) {
    fetch('/api/me')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.loggedIn) {
          window.location.href = '/login';
          return;
        }
        currentUser = { username: data.username, role: data.role };
        renderUserBar();
        cb();
      })
      .catch(function () {
        window.location.href = '/login';
      });
  }
 
  // ─── Render the user bar and logout button in the header ────────────
  function renderUserBar() {
    var headerRight = document.querySelector('.header-right');
    if (!headerRight) return;
 
    var existing = document.getElementById('userBar');
    if (existing) existing.remove();
 
    var bar = document.createElement('div');
    bar.id = 'userBar';
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;';
 
    var roleColor = currentUser.role === 'admin' ? '#b06af7' : '#4aa3ff';
    var rolePill = document.createElement('span');
    rolePill.style.cssText =
      'font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;' +
      'background:' + (currentUser.role === 'admin' ? 'rgba(176,106,247,0.15)' : 'rgba(74,163,255,0.15)') + ';' +
      'color:' + roleColor + ';';
    rolePill.textContent = (currentUser.role === 'admin' ? '⚙ Admin' : '👤 User') + ' · ' + currentUser.username;
 
    var btnLogout = document.createElement('button');
    btnLogout.className = 'btn-refresh';
    btnLogout.style.cssText = 'color:#ef4444;border-color:rgba(239,68,68,0.3);';
    btnLogout.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;">' +
        '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
        '<polyline points="16 17 21 12 16 7"/>' +
        '<line x1="21" y1="12" x2="9" y2="12"/>' +
      '</svg> Đăng xuất';
    btnLogout.addEventListener('click', doLogout);
 
    bar.appendChild(rolePill);
    if (isAdmin()) {
      var btnCreateUser = document.createElement('button');
      btnCreateUser.className = 'btn-refresh';
      btnCreateUser.textContent = '➕ Tạo User';
      btnCreateUser.addEventListener('click', openCreateUserModal);
      bar.appendChild(btnCreateUser);
 
      var btnAssign = document.createElement('button');
      btnAssign.className = 'btn-refresh';
      btnAssign.textContent = '👥 Phân quyền';
      btnAssign.addEventListener('click', openAssignModal);
      bar.appendChild(btnAssign);
    }
    bar.appendChild(btnLogout);
    headerRight.insertBefore(bar, headerRight.firstChild);
  }
 
  function doLogout() {
    fetch('/logout', { method: 'POST' })
      .then(function () { window.location.href = '/login'; })
      .catch(function () { window.location.href = '/login'; });
  }
 
  // ─── Check Admin Privileges ──────────────────────────────────
  function isAdmin() {
    return currentUser && currentUser.role === 'admin';
  }
 
  function canUseLanSockets() {
    return window.location.protocol === "http:";
  }
 
  function getCardKey(device) {
    if (!device) return "";
    return device.card_key || (device.device_id + (device.lan_ip ? ("_" + device.lan_ip) : ""));
  }

  function lanHost(device) {
    return device && device.lan_ip ? device.lan_ip : "";
  }
 
  function connectDeviceWS(device) {
    if (!canUseLanSockets()) return;
    var host = lanHost(device);
    var cardKey = getCardKey(device);
    if (!host) return;
    if (deviceWsMap[cardKey]) {
      var s = deviceWsMap[cardKey].readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
    }
    var ws = new WebSocket("ws://" + host + "/ws");
    deviceWsMap[cardKey] = ws;
 
    ws.onmessage = function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      var card = document.querySelector(".device-card[data-card-key='" + String(cardKey).replace(/['\\]/g, "") + "']");
      if (!card) return;
 
      if (typeof data.temperature === "number") {
        var elT = card.querySelector(".js-val-temp");
        if (elT) {
          elT.textContent = data.temperature.toFixed(2) + "\u00B0C";
          elT.className = "sensor-value js-val-temp " + tempColorClass(data.temperature);
        }
      }
      if (typeof data.humidity === "number") {
        var elH = card.querySelector(".js-val-humi");
        if (elH) {
          elH.textContent = (data.humidity >= 99.95 ? "100" : data.humidity.toFixed(2)) + "%";
          elH.className = "sensor-value js-val-humi " + humiColorClass(data.humidity);
        }
      }
      if (typeof data.soil_moisture === "number") {
        var elS = card.querySelector(".js-val-soil");
        if (elS) {
          var sv = Math.round(data.soil_moisture);
          elS.textContent = (sv < 10 ? "0" + sv : "" + sv) + "%";
          elS.className = "sensor-value js-val-soil " + soilColorClass(data.soil_moisture);
        }
      }
 
      };
 
    ws.onclose = function () {
      delete deviceWsMap[cardKey];
      setTimeout(function () {
        var next = currentDevices.find(function (d) { return getCardKey(d) === cardKey; });
        if (next) connectDeviceWS(next);
      }, 3000);
    };
    ws.onerror = function () { ws.close(); };
  }
 
  function syncDeviceWsSessions() {
    currentDevices.forEach(function (d) { connectDeviceWS(d); });
    Object.keys(deviceWsMap).forEach(function (id) {
      if (!currentDevices.some(function (d) { return getCardKey(d) === id; })) {
        try { deviceWsMap[id].close(); } catch (e) {}
        delete deviceWsMap[id];
      }
    });
  }
 
  function detailUrl(device) {
    var host = lanHost(device);
    return host ? ("http://" + host + "/") : "";
  }
 
  function fmtValue(v) {
    return (v !== null && v !== undefined && v !== "") ? v : "—";
  }
 
  function fmtTemp(v) { var n = parseFloat(v); return isNaN(n) ? "—" : n.toFixed(2) + "\u00B0C"; }
  function fmtHumi(v) { var n = parseFloat(v); return isNaN(n) ? "—" : (n >= 99.95 ? "100" : n.toFixed(2)) + "%"; }
  function fmtSoil(v) { var n = parseFloat(v); if (isNaN(n)) return "—"; var s = Math.round(n); return (s < 10 ? "0" + s : "" + s) + "%"; }
 
  function displayName(deviceId) {
    return deviceId || "Unknown";
  }
 
  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
 
  function fmtTimestamp(tsStr) {
    if (!tsStr) return "—";
    var d = new Date(tsStr);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear() +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
 
  function formatOfflineTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var parts = [];
    if (h > 0) parts.push(h + "h");
    if (m > 0) parts.push(m + "m");
    if (s > 0) parts.push(s + "s");
    return parts.length === 0 ? "0s" : parts.join("");
  }
 
  function getTimestampMs(device) {
    if (!device) return null;
    if (typeof device.age_seconds === "number" && device._fetchedAt) {
      return device._fetchedAt - device.age_seconds * 1000;
    }
    var raw = device.received_at || device.timestamp_up;
    if (!raw) return null;
    var ts = new Date(raw).getTime();
    return isNaN(ts) ? null : ts;
  }
 
  function updateStaleState(device) {
    var id = getCardKey(device);
    if (!device.received_at && !device.timestamp_up) {
      delete countdownStart[id];
      return;
    }
    var ts = getTimestampMs(device);
    if (ts === null) {
      delete countdownStart[id];
      return;
    }
    var age = Date.now() - ts;
    if (age >= STALE_DIFF_MS) {
      if (!countdownStart[id]) countdownStart[id] = ts + STALE_DIFF_MS;
    } else {
      delete countdownStart[id];
    }
  }
 
  function getCountdownState(deviceId) {
    var start = countdownStart[deviceId];
    if (!start) return null;
    var elapsed = Math.floor((Date.now() - start) / 1000);
    var remaining = COUNTDOWN_SECONDS - elapsed;
    if (remaining > 0) {
      return { isOnline: true, text: remaining + "s", label: "Đếm ngược: " };
    } else {
      var offlineElapsed = elapsed - COUNTDOWN_SECONDS;
      var roundedOfflineSeconds = Math.floor(offlineElapsed / 30) * 30;
      return { isOnline: false, text: formatOfflineTime(roundedOfflineSeconds), label: "Đã Offline: " };
    }
  }
 
  function isDeviceOnline(device) {
    var timestampMs = getTimestampMs(device);
    if (timestampMs === null) return false;
 
    var state = getCountdownState(getCardKey(device));
    if (state !== null) return state.isOnline;
 
    var age = Date.now() - timestampMs;
    return age >= 0 && age < STALE_DIFF_MS;
  }
 
  // ─── Action Bar: Hide the Delete button for User ──────────────────────
  function renderActionBar() {
    var actionBar = document.getElementById("customActionBar");
 
    if (!actionBar) {
      actionBar = document.createElement("div");
      actionBar.id = "customActionBar";
      actionBar.className = "action-bar";
      var grid = document.getElementById("deviceGrid");
      if (grid && grid.parentNode) grid.parentNode.insertBefore(actionBar, grid);
    }
 
    if (currentDevices.length === 0) {
      actionBar.style.display = "none";
      return;
    }
 
    // Users are not allowed to select or delete multiple devices
    if (!isAdmin()) {
      actionBar.style.display = "none";
      return;
    }
 
    actionBar.style.display = "flex";
    var isAllSelected = currentDevices.length > 0 && selectedDeviceIds.length === currentDevices.length;
 
    actionBar.innerHTML =
      '<div class="action-bar-left">' +
        '<button class="btn-action btn-select-all" id="btnSelectAll">' +
          (isAllSelected ? "🗹 Bỏ chọn tất cả" : "☐ Chọn tất cả") +
        '</button>' +
      '</div>' +
      '<div class="action-bar-right" style="display: ' + (selectedDeviceIds.length > 0 ? 'flex' : 'none') + ';">' +
        '<span class="selected-count">Đã chọn <strong>' + selectedDeviceIds.length + '</strong> thiết bị</span>' +
        '<button class="btn-action btn-delete-bulk" id="btnDeleteBulk">🗑️ Xóa đã chọn</button>' +
      '</div>';
 
    document.getElementById("btnSelectAll").addEventListener("click", function () {
      if (isAllSelected) {
        selectedDeviceIds = [];
      } else {
        selectedDeviceIds = currentDevices.map(function (d) { return getCardKey(d); });
      }
      renderGrid(currentDevices);
      renderActionBar();
    });
 
    if (selectedDeviceIds.length > 0) {
      document.getElementById("btnDeleteBulk").addEventListener("click", function () {
        if (!confirm("Xóa toàn bộ dữ liệu của " + selectedDeviceIds.length + " thiết bị đã chọn?")) return;
 
        var deletePromises = selectedDeviceIds.map(function (id) {
          var dev = currentDevices.find(function (d) { return getCardKey(d) === id; });
          var targetId = dev ? dev.device_id : id;
          var url = "/admin/api/devices/" + encodeURIComponent(targetId);
          if (dev && dev.lan_ip) {
            url += "?lan_ip=" + encodeURIComponent(dev.lan_ip);
          }
          return fetch(url, { method: "DELETE" })
            .then(function (r) {
              if (!r.ok) throw new Error("Thất bại tại ID: " + id);
              return key;
            });
        });
 
        Promise.all(deletePromises)
          .then(function (deletedKeys) {
            currentDevices = currentDevices.filter(function (d) {
              return !deletedKeys.includes(getCardKey(d));
            });
            deletedKeys.forEach(function (k) { delete countdownStart[k]; });
            selectedDeviceIds = [];
            renderGrid(currentDevices);
            updateSummary(currentDevices);
            renderActionBar();
          })
          .catch(function (err) {
            alert("Có lỗi xảy ra trong quá trình xóa: " + err.message);
            fetchDevices();
          });
      });
    }
  }
 
  function tempColorClass(t) {
    var v = parseFloat(t);
    if (isNaN(v)) return "val-temp";
    if (v < 10.0 || v > 30.0) return "val-critical";
    if (v < 15.0 || v > 25.0) return "val-warning";
    return "val-normal";
  }
  function humiColorClass(h) {
    var v = parseFloat(h);
    if (isNaN(v)) return "val-humi";
    if (v < 50.0 || v > 80.0) return "val-critical";
    if (v < 60.0 || v > 70.0) return "val-warning";
    return "val-normal";
  }
  function soilColorClass(s) {
    var v = parseFloat(s);
    if (isNaN(v)) return "val-soil";
    if (v < 25.0 || v > 45.0) return "val-critical";
    if (v < 30.0 || v > 40.0) return "val-warning";
    return "val-normal";
  }
 
  // ─── Render device cards: only administrators can select devices for deletion ──────
  function renderCard(device) {
    var cardKey = getCardKey(device);
    var state = getCountdownState(cardKey);
    var cardOnline = isDeviceOnline(device);
    var cardStatusClass = cardOnline ? "online" : "offline";
    var cardStatusLabel = cardOnline ? "Online" : "Offline";
 
    var isStable = (state === null);
    var displayStyle = isStable ? "none" : "";
    var countdownDisplay = isStable ? "" : state.text;
    var countdownPrefix  = isStable ? "" : state.label;
 
    var url = detailUrl(device);
    var isSelected = selectedDeviceIds.includes(cardKey);
 
    var card = document.createElement("div");
    card.className = "device-card" + (isSelected && isAdmin() ? " selected" : "");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("data-card-key", cardKey);
    card.setAttribute("data-device-id", device.device_id);
    card.title = isAdmin() ? ("Chọn/Bỏ chọn " + (device.lan_ip ? (device.device_id + " (" + device.lan_ip + ")") : device.device_id)) : device.device_id;
 
    // Display the checkbox indicator only for administrators
    var checkboxHtml = isAdmin()
      ? '<div class="select-checkbox-indicator">' + (isSelected ? '✓' : '') + '</div>'
      : '';
 
    card.innerHTML =
      checkboxHtml +
      '<div class="device-card-header">' +
        '<div>' +
          '<div class="device-name">' + escapeHtml(displayName(device.device_id)) + '</div>' +
          (device.lan_ip ? '<div class="device-ip" style="font-size:11px;color:var(--text-muted);">' + escapeHtml(device.lan_ip) + '</div>' : '') +
        '</div>' +
        '<span class="status-pill ' + cardStatusClass + ' js-status-pill">' +
          '<span class="status-dot"></span><span class="js-status-label">' + cardStatusLabel + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="sensor-row">' +
        '<div class="sensor-item">' +
          '<span class="sensor-label">Nhiệt độ</span>' +
          '<span class="sensor-value js-val-temp ' + tempColorClass(device.temperature) + '">' + escapeHtml(fmtTemp(device.temperature)) + '</span>' +
        '</div>' +
        '<div class="sensor-item">' +
          '<span class="sensor-label">Độ ẩm KK</span>' +
          '<span class="sensor-value js-val-humi ' + humiColorClass(device.humidity) + '">' + escapeHtml(fmtHumi(device.humidity)) + '</span>' +
        '</div>' +
        '<div class="sensor-item">' +
          '<span class="sensor-label">Độ ẩm đất</span>' +
          '<span class="sensor-value js-val-soil ' + soilColorClass(device.soil_moisture) + '">' + escapeHtml(fmtSoil(device.soil_moisture)) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-footer">' +
        '<span class="last-seen js-last-seen" style="display: ' + displayStyle + ';">' +
          '<span class="js-countdown-label">' + countdownPrefix + '</span>' +
          '<span class="js-countdown">' + countdownDisplay + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="card-arrow" title="Xem chi tiết thiết bị này">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
             'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M5 12h14M13 6l6 6-6 6"/>' +
        '</svg>' +
      '</div>';
 
    // Handle card selection: only administrators can select cards
    card.addEventListener("click", function () {
      if (!isAdmin()) return;
      if (isSelected) {
        selectedDeviceIds = selectedDeviceIds.filter(function (id) { return id !== cardKey; });
      } else {
        selectedDeviceIds.push(cardKey);
      }
      renderGrid(currentDevices);
      renderActionBar();
    });
 
    var arrowBtn = card.querySelector(".card-arrow");
    if (arrowBtn) {
      arrowBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!url) {
          alert("Chưa có IP LAN của thiết bị. Mở dashboard ESP32 trực tiếp trên mạng local (HTTP).");
          return;
        }
        openDeviceLoginModal(device.device_id, url, device.lan_ip);
      });
    }
 
    card.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.click();
      }
    });
 
    return card;
  }
 
  function renderGrid(devices) {
    var grid = document.getElementById("deviceGrid");
    grid.innerHTML = "";
 
    if (!devices || devices.length === 0) {
      grid.innerHTML =
        '<div class="state-box">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
               'stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="2" y="3" width="20" height="14" rx="2"/>' +
            '<path d="M8 21h8M12 17v4"/>' +
          '</svg>' +
          '<span>Chưa có thiết bị nào gửi dữ liệu.</span>' +
        '</div>';
      return;
    }
 
    devices.forEach(function (device) {
      grid.appendChild(renderCard(device));
    });
  }
 
  function updateSummary(devices) {
    var total = devices.length;
    var online = devices.filter(isDeviceOnline).length;
    var offline = total - online;
    document.getElementById("sumTotal").textContent = total;
    document.getElementById("sumOnline").textContent = online;
    document.getElementById("sumOffline").textContent = offline;
  }
 
  function tickCountdowns() {
    var cards = document.querySelectorAll(".device-card[data-card-key]");
    cards.forEach(function (card) {
      var cardKey = card.getAttribute("data-card-key");
      var state = getCountdownState(cardKey);
 
      var lastSeenEl  = card.querySelector(".js-last-seen");
      var countdownEl = card.querySelector(".js-countdown");
      var labelPrefixEl = card.querySelector(".js-countdown-label");
      var pillEl = card.querySelector(".js-status-pill");
      var labelEl = card.querySelector(".js-status-label");
 
      if (lastSeenEl && countdownEl && labelPrefixEl) {
        if (state === null) {
          lastSeenEl.style.display = "none";
        } else {
          lastSeenEl.style.display = "";
          countdownEl.textContent  = state.text;
          labelPrefixEl.textContent = state.label;
        }
      }
 
      if (pillEl && labelEl) {
        var device = currentDevices.find(function (item) {
          return getCardKey(item) === cardKey;
        });
        var cardOnline = device ? isDeviceOnline(device) : false;
        pillEl.className = "status-pill " + (cardOnline ? "online" : "offline") + " js-status-pill";
        labelEl.textContent = cardOnline ? "Online" : "Offline";
      }
    });
 
    updateSummary(currentDevices);
  }
 
  function refreshLastRefreshText() {
    var el = document.getElementById("lastRefresh");
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    if (latestTimestampUp) {
      var d = new Date(latestTimestampUp);
      el.textContent =
        "Cập nhật lúc " +
        pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear() +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    } else {
      el.textContent = "Chưa có dữ liệu";
    }
  }
 
  function fetchDevices() {
    fetch("/admin/api/devices")
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          window.location.href = '/login';
          return;
        }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        currentDevices = data || [];
        var fetchedAt = Date.now();
        currentDevices.forEach(function (d) { d._fetchedAt = fetchedAt; });
 
        var currentKeys = currentDevices.map(function (d) { return getCardKey(d); });
        selectedDeviceIds = selectedDeviceIds.filter(function (id) { return currentKeys.includes(id); });
 
        currentDevices.forEach(function (device) { updateStaleState(device); });
 
        var newest = null;
        currentDevices.forEach(function (device) {
          var t = getTimestampMs(device);
          if (t !== null && (!newest || t > newest)) newest = t;
        });
        latestTimestampUp = newest;
 
        renderGrid(currentDevices);
        updateSummary(currentDevices);
        renderActionBar();
        refreshLastRefreshText();
        syncDeviceWsSessions();
      })
      .catch(function (err) {
        document.getElementById("deviceGrid").innerHTML =
          '<div class="state-box">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
                 'stroke-linecap="round" stroke-linejoin="round">' +
              '<circle cx="12" cy="12" r="10"/>' +
              '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>' +
            '</svg>' +
            '<span>Lỗi kết nối: ' + err.message + '</span>' +
          '</div>';
        document.getElementById("lastRefresh").textContent = "Lỗi kết nối";
      });
  }
 
  // ─── Boot ──────────────────────────────────────────────────
  document.getElementById("btnRefresh").addEventListener("click", fetchDevices);
 
  function tickClock() {
    var now = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    document.getElementById("sumTime").textContent =
      pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
  }
 
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(tickCountdowns, 1000);
 
  // Load user information first, then fetch the devices
  loadCurrentUser(function () {
    fetchDevices();
    setInterval(fetchDevices, 5000);
    pollAccessRequests();
    setInterval(pollAccessRequests, 3000);
  });
 
  // ─── Device Login Modal (User) ─────────────
  var loginTargetUrl = "";
  var loginTargetId  = "";
 
  var loginModal         = document.getElementById("deviceLoginModal");
  var loginModalClose    = document.getElementById("loginModalClose");
  var loginDeviceIdEl    = document.getElementById("loginDeviceId");
  var loginSection       = document.getElementById("loginSection");
  var loginPasswordInput = document.getElementById("loginPasswordInput");
  var loginSubmitBtn     = document.getElementById("loginSubmitBtn");
  var loginMsg           = document.getElementById("loginMsg");
  var setPasswordSection = document.getElementById("setPasswordSection");
  var newPasswordInput   = document.getElementById("newPasswordInput");
  var setPasswordBtn     = document.getElementById("setPasswordBtn");
  var setPasswordMsg     = document.getElementById("setPasswordMsg");
 
  // ─── Admin Device Management Modal ──────────
  var adminModal             = document.getElementById("adminDeviceModal");
  var adminModalClose        = document.getElementById("adminModalClose");
  var adminModalDeviceIdEl   = document.getElementById("adminModalDeviceId");
  var adminEnterDashboardBtn = document.getElementById("adminEnterDashboardBtn");
  var adminNewPasswordInput  = document.getElementById("adminNewPasswordInput");
  var adminSavePasswordBtn   = document.getElementById("adminSavePasswordBtn");
  var adminPwdMsg            = document.getElementById("adminPwdMsg");
  var adminPwdSectionTitle   = document.getElementById("adminPwdSectionTitle");
  var adminDeletePwdSection  = document.getElementById("adminDeletePwdSection");
  var adminDeletePasswordBtn = document.getElementById("adminDeletePasswordBtn");
 
  var adminTargetUrl = "";
  var adminTargetId  = "";
  var loginTargetLanIp = "";
 
  // Open appropriate modal based on role
  function openDeviceLoginModal(deviceId, url, lanIp) {
    if (isAdmin()) {
      openAdminDeviceModal(deviceId, url, lanIp);
    } else {
      openUserDeviceModal(deviceId, url, lanIp);
    }
  }
 
  // ─── Admin modal ─────────────────────────────
  function openAdminDeviceModal(deviceId, url, lanIp) {
    loginTargetLanIp = lanIp || "";
    adminTargetId  = deviceId;
    adminTargetUrl = url;
 
    adminModalDeviceIdEl.textContent  = "Thiết bị: " + deviceId;
    adminNewPasswordInput.value       = "";
    adminPwdMsg.textContent           = "";
    adminPwdMsg.className             = "login-msg";
    adminDeletePwdSection.style.display = "none";
    adminPwdSectionTitle.textContent  = "Đặt mật khẩu thiết bị";
 
    adminModal.style.display = "flex";
 
    // Check if this device already has a password
    fetch("/admin/api/devices/" + encodeURIComponent(deviceId) + "/has-password")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.hasPassword) {
          adminPwdSectionTitle.textContent    = "Đổi mật khẩu thiết bị";
          adminDeletePwdSection.style.display = "";
        } else {
          adminPwdSectionTitle.textContent    = "Đặt mật khẩu thiết bị";
          adminDeletePwdSection.style.display = "none";
        }
      })
      .catch(function () {});
 
    setTimeout(function () { adminNewPasswordInput.focus(); }, 80);
  }
 
  function closeAdminDeviceModal() {
    adminModal.style.display = "none";
  }
 
  adminModalClose.addEventListener("click", closeAdminDeviceModal);
 
  adminModal.addEventListener("click", function (e) {
    if (e.target === adminModal) closeAdminDeviceModal();
  });
 
  // Admin: Enter Dashboard directly (no password required)
  adminEnterDashboardBtn.addEventListener("click", function () {
    closeAdminDeviceModal();
    window.location.href = adminTargetUrl;
  });
 
  // Admin: Save password
  adminNewPasswordInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") adminSavePasswordBtn.click();
  });
 
  adminSavePasswordBtn.addEventListener("click", function () {
    var pass = adminNewPasswordInput.value.trim();
    if (!pass) {
      adminPwdMsg.textContent = "Vui lòng nhập mật khẩu.";
      adminPwdMsg.className   = "login-msg error";
      return;
    }
 
    adminSavePasswordBtn.disabled = true;
    adminPwdMsg.textContent       = "Đang lưu...";
    adminPwdMsg.className         = "login-msg";
 
    fetch("/admin/api/devices/" + encodeURIComponent(adminTargetId) + "/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass, lan_ip: loginTargetLanIp })
    })
      .then(function (r) {
        adminSavePasswordBtn.disabled = false;
        if (r.ok) {
          adminPwdMsg.textContent             = "✓ Đã lưu mật khẩu thành công.";
          adminPwdMsg.className               = "login-msg success";
          adminNewPasswordInput.value         = "";
          adminPwdSectionTitle.textContent    = "Đổi mật khẩu thiết bị";
          adminDeletePwdSection.style.display = "";
        } else {
          adminPwdMsg.textContent = "Lưu thất bại, vui lòng thử lại.";
          adminPwdMsg.className   = "login-msg error";
        }
      })
      .catch(function () {
        adminSavePasswordBtn.disabled = false;
        adminPwdMsg.textContent       = "Lỗi kết nối, thử lại.";
        adminPwdMsg.className         = "login-msg error";
      });
  });
 
  // Admin: Delete password
  adminDeletePasswordBtn.addEventListener("click", function () {
    if (!confirm("Xóa mật khẩu của thiết bị \"" + adminTargetId + "\"?\nSau khi xóa, User có thể vào dashboard mà không cần mật khẩu.")) return;
 
    adminDeletePasswordBtn.disabled = true;
    adminPwdMsg.textContent         = "Đang xóa...";
    adminPwdMsg.className           = "login-msg";
 
    fetch("/admin/api/devices/" + encodeURIComponent(adminTargetId) + "/password", {
      method: "DELETE"
    })
      .then(function (r) {
        adminDeletePasswordBtn.disabled = false;
        if (r.ok) {
          adminPwdMsg.textContent             = "✓ Đã xóa mật khẩu.";
          adminPwdMsg.className               = "login-msg success";
          adminPwdSectionTitle.textContent    = "Đặt mật khẩu thiết bị";
          adminDeletePwdSection.style.display = "none";
          adminNewPasswordInput.value         = "";
        } else {
          adminPwdMsg.textContent = "Xóa thất bại, vui lòng thử lại.";
          adminPwdMsg.className   = "login-msg error";
        }
      })
      .catch(function () {
        adminDeletePasswordBtn.disabled = false;
        adminPwdMsg.textContent         = "Lỗi kết nối, thử lại.";
        adminPwdMsg.className           = "login-msg error";
      });
  });
 
  // ─── User modal (unchanged logic) ────────────
  function openUserDeviceModal(deviceId, url, lanIp) {
    loginTargetLanIp = lanIp || "";
    loginTargetId  = deviceId;
    loginTargetUrl = url;
 
    loginDeviceIdEl.textContent    = "Thiết bị: " + deviceId;
    loginPasswordInput.value       = "";
    newPasswordInput.value         = "";
    loginMsg.textContent           = "";
    loginMsg.className             = "login-msg";
    setPasswordMsg.textContent     = "";
    setPasswordMsg.className       = "login-msg";
 
    stopAccessPoll();
    loginSubmitBtn.disabled          = false;
    loginSection.style.display       = "";
    setPasswordSection.style.display = "none";
 
    loginModal.style.display = "flex";
    setTimeout(function () { loginPasswordInput.focus(); }, 80);
  }
 
  function closeDeviceLoginModal() {
    stopAccessPoll();
    loginModal.style.display = "none";
  }
 
  loginModalClose.addEventListener("click", closeDeviceLoginModal);
 
  loginModal.addEventListener("click", function (e) {
    if (e.target === loginModal) closeDeviceLoginModal();
  });
 
  loginPasswordInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") loginSubmitBtn.click();
  });
 
  loginSubmitBtn.addEventListener("click", function () {
    var pass = loginPasswordInput.value.trim();
 
    loginSubmitBtn.disabled = true;
    loginMsg.textContent    = "Đang xác thực...";
    loginMsg.className      = "login-msg";
 
    fetch("/admin/api/devices/" + encodeURIComponent(loginTargetId) + "/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass, lan_ip: loginTargetLanIp })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        loginSubmitBtn.disabled = false;
 
        // Device has no password → gửi yêu cầu, chờ Admin duyệt
        if (data.reason === "no_password") {
          startAccessRequest();
          return;
        }
 
        if (data.ok && data.ticket) {
          loginMsg.textContent = "Thành công! Đang chuyển hướng...";
          loginMsg.className   = "login-msg success";
          var targetUrl = data.lanIp
            ? "http://" + data.lanIp + "/?ticket=" + encodeURIComponent(data.ticket)
            : loginTargetUrl + "?ticket=" + encodeURIComponent(data.ticket);
          setTimeout(function () { window.location.href = targetUrl; }, 500);
        } else {
          loginMsg.textContent = pass ? "Mật khẩu không đúng." : "Vui lòng nhập mật khẩu.";
          loginMsg.className   = "login-msg error";
          loginPasswordInput.select();
        }
      })
      .catch(function () {
        loginSubmitBtn.disabled = false;
        loginMsg.textContent    = "Lỗi kết nối, thử lại.";
        loginMsg.className      = "login-msg error";
      });
  });
 
  newPasswordInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") setPasswordBtn.click();
  });
 
  setPasswordBtn.addEventListener("click", function () {
    if (!isAdmin()) return;
    var pass = newPasswordInput.value.trim();
    if (!pass) {
      setPasswordMsg.textContent = "Vui lòng nhập mật khẩu.";
      setPasswordMsg.className   = "login-msg error";
      return;
    }
 
    setPasswordBtn.disabled    = true;
    setPasswordMsg.textContent = "Đang lưu...";
    setPasswordMsg.className   = "login-msg";
 
    fetch("/admin/api/devices/" + encodeURIComponent(loginTargetId) + "/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass })
    })
      .then(function (r) {
        setPasswordBtn.disabled = false;
        if (r.ok) {
          setPasswordMsg.textContent = "Đã lưu! Đang chuyển hướng...";
          setPasswordMsg.className   = "login-msg success";
          setTimeout(function () { window.location.href = loginTargetUrl; }, 500);
        } else {
          setPasswordMsg.textContent = "Lưu thất bại, thử lại.";
          setPasswordMsg.className   = "login-msg error";
        }
      })
      .catch(function () {
        setPasswordBtn.disabled    = false;
        setPasswordMsg.textContent = "Lỗi kết nối, thử lại.";
        setPasswordMsg.className   = "login-msg error";
      });
  });
 
  // ─── Access request: phía User (chờ duyệt) ──────────
  var accessPollTimer = null;
 
  function stopAccessPoll() {
    if (accessPollTimer) { clearInterval(accessPollTimer); accessPollTimer = null; }
  }
 
  function startAccessRequest() {
    loginSubmitBtn.disabled = true;
    loginMsg.textContent    = "Thiết bị chưa có mật khẩu. Đang gửi yêu cầu đến Admin...";
    loginMsg.className      = "login-msg";
 
    fetch("/admin/api/devices/" + encodeURIComponent(loginTargetId) + "/access-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lan_ip: loginTargetLanIp })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          loginSubmitBtn.disabled = false;
          loginMsg.textContent    = res.data.error || "Gửi yêu cầu thất bại.";
          loginMsg.className      = "login-msg error";
          return;
        }
        loginMsg.textContent = "Đã gửi yêu cầu. Đang chờ Admin chấp nhận...";
        var reqId = res.data.id;
        stopAccessPoll();
        accessPollTimer = setInterval(function () {
          fetch("/admin/api/access-requests/" + encodeURIComponent(reqId) + "/status")
            .then(function (r) { return r.json(); })
            .then(function (s) {
              if (s.status === "pending") return;
              stopAccessPoll();
              loginSubmitBtn.disabled = false;
              if (s.status === "approved") {
                loginMsg.textContent = "Admin đã chấp nhận! Đang chuyển hướng...";
                loginMsg.className   = "login-msg success";
                if (!s.ticket || !s.lanIp) {
                  loginMsg.textContent = "Không nhận được quyền truy cập thiết bị. Vui lòng thử lại.";
                  return;
                }
                var approvedUrl = "http://" + s.lanIp + "/?ticket=" + encodeURIComponent(s.ticket);
                setTimeout(function () { window.location.href = approvedUrl; }, 500);
              } else if (s.status === "denied") {
                loginMsg.textContent = "Admin đã từ chối yêu cầu truy cập.";
                loginMsg.className   = "login-msg error";
              } else {
                loginMsg.textContent = "Yêu cầu đã hết hạn. Vui lòng thử lại.";
                loginMsg.className   = "login-msg error";
              }
            })
            .catch(function () {});
        }, 2000);
      })
      .catch(function () {
        loginSubmitBtn.disabled = false;
        loginMsg.textContent    = "Lỗi kết nối, thử lại.";
        loginMsg.className      = "login-msg error";
      });
  }
 
  // ─── Access request: phía Admin (duyệt) ──────────
  function renderAccessRequests(list) {
    var bar = document.getElementById("accessRequestBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "accessRequestBar";
      var title = document.querySelector(".section-title");
      if (title && title.parentNode) title.parentNode.insertBefore(bar, title);
    }
    bar.innerHTML = "";
    (list || []).forEach(function (r) {
      var row = document.createElement("div");
      row.className = "action-bar";
      row.innerHTML =
        '<span class="selected-count">🔔 <strong>' + escapeHtml(r.username) +
        '</strong> xin truy cập thiết bị <strong>' + escapeHtml(r.deviceId) + '</strong></span>' +
        '<div class="action-bar-right">' +
          '<button class="btn-action" data-act="approve">✓ Chấp nhận</button>' +
          '<button class="btn-action btn-delete-bulk" data-act="deny">✕ Từ chối</button>' +
        '</div>';
      row.querySelector('[data-act="approve"]').addEventListener("click", function () {
        decideAccessRequest(r.id, true);
      });
      row.querySelector('[data-act="deny"]').addEventListener("click", function () {
        decideAccessRequest(r.id, false);
      });
      bar.appendChild(row);
    });
  }
 
  function pollAccessRequests() {
    if (!isAdmin()) return;
    fetch("/admin/api/access-requests")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(renderAccessRequests)
      .catch(function () {});
  }
 
  function decideAccessRequest(id, approve) {
    fetch("/admin/api/access-requests/" + encodeURIComponent(id) + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: approve })
    })
      .then(pollAccessRequests)
      .catch(pollAccessRequests);
  }
 
  // ─── Assign devices to users (Admin) ──────────
  var assignModal      = document.getElementById("assignModal");
  var assignModalClose = document.getElementById("assignModalClose");
  var assignUserSelect = document.getElementById("assignUserSelect");
  var assignDeviceList = document.getElementById("assignDeviceList");
  var assignSaveBtn    = document.getElementById("assignSaveBtn");
  var assignMsg        = document.getElementById("assignMsg");
 
  function setAssignMsg(text, cls) {
    assignMsg.textContent = text;
    assignMsg.className = "login-msg" + (cls ? " " + cls : "");
  }
 
  function openAssignModal() {
    if (!isAdmin()) return;
    setAssignMsg("", "");
    assignDeviceList.innerHTML = "";
    assignUserSelect.innerHTML = "";
    assignModal.style.display = "flex";
 
    fetch("/admin/api/users")
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (users) {
        var normal = users.filter(function (u) { return u.role === "user"; });
        if (normal.length === 0) {
          assignSaveBtn.disabled = true;
          assignDeviceList.innerHTML = '<div class="assign-empty">Chưa có tài khoản User nào.</div>';
          return;
        }
        assignSaveBtn.disabled = false;
        normal.forEach(function (u) {
          var o = document.createElement("option");
          o.value = u.id;
          o.textContent = u.username;
          assignUserSelect.appendChild(o);
        });
        loadAssignedDevices();
      })
      .catch(function () { setAssignMsg("Không tải được danh sách tài khoản.", "error"); });
  }
 
  function loadAssignedDevices() {
    var uid = assignUserSelect.value;
    if (!uid) return;
    setAssignMsg("", "");
    fetch("/admin/api/users/" + encodeURIComponent(uid) + "/devices")
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (assigned) {
        if (assignUserSelect.value !== uid) return;

        // Gom LAN IP theo MAC: từ card đang có + từ quyền đã cấp
        var map = {};
        function addIp(id, ip) {
          if (!map[id]) map[id] = [];
          if (ip && map[id].indexOf(ip) === -1) map[id].push(ip);
        }
        currentDevices.forEach(function (d) { addIp(d.device_id, d.lan_ip); });
        assigned.forEach(function (a) { addIp(a.device_id, a.lan_ip); });

        // lan_ip rỗng (quyền cũ) = tất cả IP của MAC đó
        var checked = {};
        assigned.forEach(function (a) {
          if (a.lan_ip) checked[a.device_id + "|" + a.lan_ip] = true;
          else map[a.device_id].forEach(function (ip) { checked[a.device_id + "|" + ip] = true; });
        });

        assignDeviceList.innerHTML = "";
        var macs = Object.keys(map);
        if (macs.length === 0) {
          assignDeviceList.innerHTML = '<div class="assign-empty">Chưa có thiết bị nào.</div>';
          return;
        }

        macs.forEach(function (mac) {
          var group = document.createElement("div");

          var head = document.createElement("div");
          head.className = "assign-mac-head";
          var arrow = document.createElement("span");
          arrow.textContent = "▸";
          var name = document.createElement("span");
          name.textContent = mac;
          name.style.flex = "1";
          var count = document.createElement("span");
          count.className = "assign-mac-count";
          head.appendChild(arrow);
          head.appendChild(name);
          head.appendChild(count);

          var ipBox = document.createElement("div");
          ipBox.className = "assign-ip-list";
          ipBox.style.display = "none";

          function updateCount() {
            var all = ipBox.querySelectorAll("input[type=checkbox]");
            var on = ipBox.querySelectorAll("input[type=checkbox]:checked");
            count.textContent = on.length + "/" + all.length;
          }

          if (map[mac].length === 0) {
            ipBox.innerHTML = '<div class="assign-empty">Chưa có LAN IP.</div>';
          }
          map[mac].forEach(function (ip) {
            var row = document.createElement("label");
            row.className = "assign-device-item";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = ip;
            cb.setAttribute("data-device-id", mac);
            cb.checked = !!checked[mac + "|" + ip];
            cb.addEventListener("change", updateCount);
            var span = document.createElement("span");
            span.textContent = ip;
            row.appendChild(cb);
            row.appendChild(span);
            ipBox.appendChild(row);
          });

          head.addEventListener("click", function () {
            var open = ipBox.style.display === "none";
            ipBox.style.display = open ? "" : "none";
            arrow.textContent = open ? "▾" : "▸";
          });

          updateCount();
          group.appendChild(head);
          group.appendChild(ipBox);
          assignDeviceList.appendChild(group);
        });
      })
      .catch(function () { setAssignMsg("Không tải được danh sách thiết bị.", "error"); });
  }
 
  assignUserSelect.addEventListener("change", loadAssignedDevices);
  assignModalClose.addEventListener("click", function () { assignModal.style.display = "none"; });
  assignModal.addEventListener("click", function (e) {
    if (e.target === assignModal) assignModal.style.display = "none";
  });
 
  assignSaveBtn.addEventListener("click", function () {
    var uid = assignUserSelect.value;
    if (!uid) return;
    var devices = [];
    assignDeviceList.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      if (cb.checked) devices.push({ device_id: cb.getAttribute("data-device-id"), lan_ip: cb.value });
    });
    assignSaveBtn.disabled = true;
    setAssignMsg("Đang lưu...", "");
    fetch("/admin/api/users/" + encodeURIComponent(uid) + "/devices", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devices: devices })
    })
      .then(function (r) {
        assignSaveBtn.disabled = false;
        if (r.ok) setAssignMsg("✓ Đã lưu phân quyền.", "success");
        else setAssignMsg("Lưu thất bại, vui lòng thử lại.", "error");
      })
      .catch(function () {
        assignSaveBtn.disabled = false;
        setAssignMsg("Lỗi kết nối, thử lại.", "error");
      });
  });
 
  // ─── Create User (Admin) ──────────
  var createUserModal       = document.getElementById("createUserModal");
  var createUserModalClose  = document.getElementById("createUserModalClose");
  var createUserNameInput   = document.getElementById("createUserName");
  var createUserPassInput   = document.getElementById("createUserPassword");
  var createUserSubmitBtn   = document.getElementById("createUserSubmitBtn");
  var createUserMsg         = document.getElementById("createUserMsg");
 
  function setCreateUserMsg(text, cls) {
    createUserMsg.textContent = text;
    createUserMsg.className = "login-msg" + (cls ? " " + cls : "");
  }
 
  function openCreateUserModal() {
    if (!isAdmin()) return;
    createUserNameInput.value = "";
    createUserPassInput.value = "";
    setCreateUserMsg("", "");
    createUserModal.style.display = "flex";
    setTimeout(function () { createUserNameInput.focus(); }, 80);
  }
 
  function closeCreateUserModal() {
    createUserModal.style.display = "none";
  }
 
  createUserModalClose.addEventListener("click", closeCreateUserModal);
  createUserModal.addEventListener("click", function (e) {
    if (e.target === createUserModal) closeCreateUserModal();
  });
  createUserPassInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") createUserSubmitBtn.click();
  });
 
  createUserSubmitBtn.addEventListener("click", function () {
    if (!isAdmin()) return;
    var username = createUserNameInput.value.trim();
    var password = createUserPassInput.value;
    if (!username || !password) {
      setCreateUserMsg("Vui lòng nhập tên đăng nhập và mật khẩu.", "error");
      return;
    }
    if (password.length < 6) {
      setCreateUserMsg("Mật khẩu phải có ít nhất 6 ký tự.", "error");
      return;
    }
 
    createUserSubmitBtn.disabled = true;
    setCreateUserMsg("Đang tạo...", "");
 
    fetch("/admin/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password, role: "user" })
    })
      .then(function (r) {
        createUserSubmitBtn.disabled = false;
        if (r.ok) {
          setCreateUserMsg("✓ Đã tạo tài khoản \"" + username + "\".", "success");
          createUserNameInput.value = "";
          createUserPassInput.value = "";
          createUserNameInput.focus();
          return;
        }
        return r.json().then(function (data) {
          setCreateUserMsg(data.error || "Tạo tài khoản thất bại.", "error");
        }).catch(function () {
          setCreateUserMsg("Tạo tài khoản thất bại.", "error");
        });
      })
      .catch(function () {
        createUserSubmitBtn.disabled = false;
        setCreateUserMsg("Lỗi kết nối, thử lại.", "error");
      });
  });
 
})();
