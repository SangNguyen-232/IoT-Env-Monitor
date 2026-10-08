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

  function lanHost(device) {
    return device && device.lan_ip ? device.lan_ip : "";
  }

  function connectDeviceWS(device) {
    if (!canUseLanSockets()) return;
    var host = lanHost(device);
    var deviceId = device.device_id;
    if (!host) return;
    if (deviceWsMap[deviceId]) {
      var s = deviceWsMap[deviceId].readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
    }
    var ws = new WebSocket("ws://" + host + "/ws");
    deviceWsMap[deviceId] = ws;

    ws.onmessage = function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      var card = document.querySelector(".device-card[data-device-id='" + String(deviceId).replace(/['\\]/g, "") + "']");
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
      delete deviceWsMap[deviceId];
      setTimeout(function () {
        var next = currentDevices.find(function (d) { return d.device_id === deviceId; });
        if (next) connectDeviceWS(next);
      }, 3000);
    };
    ws.onerror = function () { ws.close(); };
  }

  function syncDeviceWsSessions() {
    currentDevices.forEach(function (d) { connectDeviceWS(d); });
    Object.keys(deviceWsMap).forEach(function (id) {
      if (!currentDevices.some(function (d) { return d.device_id === id; })) {
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
    var raw = device.received_at || device.timestamp_up;
    if (!raw) return null;
    var ts = new Date(raw).getTime();
    return isNaN(ts) ? null : ts;
  }

  function updateStaleState(device) {
    var id = device.device_id;
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

    var state = getCountdownState(device.device_id);
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
        selectedDeviceIds = currentDevices.map(function (d) { return d.device_id; });
      }
      renderGrid(currentDevices);
      renderActionBar();
    });

    if (selectedDeviceIds.length > 0) {
      document.getElementById("btnDeleteBulk").addEventListener("click", function () {
        if (!confirm("Xóa toàn bộ dữ liệu của " + selectedDeviceIds.length + " thiết bị đã chọn?")) return;

        var deletePromises = selectedDeviceIds.map(function (id) {
          return fetch("/admin/api/devices/" + encodeURIComponent(id), { method: "DELETE" })
            .then(function (r) {
              if (!r.ok) throw new Error("Thất bại tại ID: " + id);
              return id;
            });
        });

        Promise.all(deletePromises)
          .then(function (deletedIds) {
            currentDevices = currentDevices.filter(function (d) {
              return !deletedIds.includes(d.device_id);
            });
            deletedIds.forEach(function (id) { delete countdownStart[id]; });
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
    var state = getCountdownState(device.device_id);
    var cardOnline = isDeviceOnline(device);
    var cardStatusClass = cardOnline ? "online" : "offline";
    var cardStatusLabel = cardOnline ? "Online" : "Offline";

    var isStable = (state === null);
    var displayStyle = isStable ? "none" : "";
    var countdownDisplay = isStable ? "" : state.text;
    var countdownPrefix  = isStable ? "" : state.label;

    var url = detailUrl(device);
    var isSelected = selectedDeviceIds.includes(device.device_id);

    var card = document.createElement("div");
    card.className = "device-card" + (isSelected && isAdmin() ? " selected" : "");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("data-device-id", device.device_id);
    card.title = isAdmin() ? "Chọn/Bỏ chọn " + device.device_id : device.device_id;

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
          '<span class="sensor-value js-val-temp ' + tempColorClass(device.temperature) + '">' + escapeHtml(fmtValue(device.temperature)) + '</span>' +
        '</div>' +
        '<div class="sensor-item">' +
          '<span class="sensor-label">Độ ẩm KK</span>' +
          '<span class="sensor-value js-val-humi ' + humiColorClass(device.humidity) + '">' + escapeHtml(fmtValue(device.humidity)) + '</span>' +
        '</div>' +
        '<div class="sensor-item">' +
          '<span class="sensor-label">Độ ẩm đất</span>' +
          '<span class="sensor-value js-val-soil ' + soilColorClass(device.soil_moisture) + '">' + escapeHtml(fmtValue(device.soil_moisture)) + '</span>' +
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
        selectedDeviceIds = selectedDeviceIds.filter(function (id) { return id !== device.device_id; });
      } else {
        selectedDeviceIds.push(device.device_id);
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
        openDeviceLoginModal(device.device_id, url);
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
    var cards = document.querySelectorAll(".device-card[data-device-id]");
    cards.forEach(function (card) {
      var id = card.getAttribute("data-device-id");
      var state = getCountdownState(id);

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
          return item.device_id === id;
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

        var currentIds = currentDevices.map(function (d) { return d.device_id; });
        selectedDeviceIds = selectedDeviceIds.filter(function (id) { return currentIds.includes(id); });

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

  // Open appropriate modal based on role
  function openDeviceLoginModal(deviceId, url) {
    if (isAdmin()) {
      openAdminDeviceModal(deviceId, url);
    } else {
      openUserDeviceModal(deviceId, url);
    }
  }

  // ─── Admin modal ─────────────────────────────
  function openAdminDeviceModal(deviceId, url) {
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
      body: JSON.stringify({ password: pass })
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
  function openUserDeviceModal(deviceId, url) {
    loginTargetId  = deviceId;
    loginTargetUrl = url;

    loginDeviceIdEl.textContent    = "Thiết bị: " + deviceId;
    loginPasswordInput.value       = "";
    newPasswordInput.value         = "";
    loginMsg.textContent           = "";
    loginMsg.className             = "login-msg";
    setPasswordMsg.textContent     = "";
    setPasswordMsg.className       = "login-msg";

    loginSection.style.display       = "";
    setPasswordSection.style.display = "none";

    loginModal.style.display = "flex";
    setTimeout(function () { loginPasswordInput.focus(); }, 80);
  }

  function closeDeviceLoginModal() {
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
    if (!pass) {
      loginMsg.textContent = "Vui lòng nhập mật khẩu.";
      loginMsg.className   = "login-msg error";
      return;
    }

    loginSubmitBtn.disabled = true;
    loginMsg.textContent    = "Đang xác thực...";
    loginMsg.className      = "login-msg";

    fetch("/admin/api/devices/" + encodeURIComponent(loginTargetId) + "/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        loginSubmitBtn.disabled = false;

        // Device has no password → User can access directly
        if (data.reason === "no_password") {
          loginMsg.textContent = "Thành công! Đang chuyển hướng...";
          loginMsg.className   = "login-msg success";
          setTimeout(function () {
            var _now = new Date();
            var _pad = function(n) { return n < 10 ? "0" + n : "" + n; };
            window.location.href = loginTargetUrl + "?session_start=" + _pad(_now.getHours()) + ":" + _pad(_now.getMinutes()) + ":" + _pad(_now.getSeconds());
          }, 500);
          return;
        }

        if (data.ok) {
          loginMsg.textContent = "Thành công! Đang chuyển hướng...";
          loginMsg.className   = "login-msg success";
          setTimeout(function () {
            var _now = new Date();
            var _pad = function(n) { return n < 10 ? "0" + n : "" + n; };
            window.location.href = loginTargetUrl + "?session_start=" + _pad(_now.getHours()) + ":" + _pad(_now.getMinutes()) + ":" + _pad(_now.getSeconds());
          }, 500);
        } else {
          loginMsg.textContent = "Mật khẩu không đúng.";
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

})();