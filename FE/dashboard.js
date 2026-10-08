(function () {
  "use strict";

  var MAX_POINTS = 60;
  var DEFAULT_LAT = 12.6951778;
  var DEFAULT_LNG = 108.057041;

  var state = {
    pumpState: "OFF",
    pumpMode: "AUTO",
    lat: DEFAULT_LAT,
    lng: DEFAULT_LNG,
  };

  // ---------- DOM refs ----------
  var els = {
    temp: document.getElementById("statTemp"),
    humi: document.getElementById("statHumi"),
    soil: document.getElementById("statSoil"),
    time: document.getElementById("statTime"),
    message: document.getElementById("statMessage"),
    coreiotDot: document.getElementById("coreiotDot"),
    pumpBadge: document.getElementById("pumpBadge"),
    modeBadge: document.getElementById("modeBadge"),
    pumpToggleBtn: document.getElementById("pumpToggleBtn"),
    modeToggleBtn: document.getElementById("modeToggleBtn"),
  };

  // ---------- Risk color helpers (mirrors risk_label.h thresholds) ----------
  function tempColorClass(t) {
    if (t < 10.0 || t > 30.0) return "val-critical";
    if (t < 15.0 || t > 25.0) return "val-warning";
    return "val-normal";
  }
  function humiColorClass(h) {
    if (h < 50.0 || h > 80.0) return "val-critical";
    if (h < 60.0 || h > 70.0) return "val-warning";
    return "val-normal";
  }
  function soilColorClass(s) {
    if (s < 25.0 || s > 45.0) return "val-critical";
    if (s < 30.0 || s > 40.0) return "val-warning";
    return "val-normal";
  }

  // ---------- Clock (client-side, always available even without NTP) ----------
  function tickClock() {
    var now = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    els.time.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ---------- Sensor chart ----------
  var chart = null;
  var fallbackChart = false;
  var fallbackData = { labels: [], temp: [], humi: [], soil: [] };
  var fallbackCanvas = null, fallbackCtx = null;

  var chartIntervalMs = 5000;
  var lastChartPushTime = 0;

  function initChartIntervalControl() {
    var tag = document.querySelector(".chart-card .refresh-tag");
    if (!tag) return;

    var select = document.createElement("select");
    select.id = "chartIntervalSelect";
    select.style.marginLeft = "4px";
    select.style.background = "var(--card-soft)";
    select.style.color = "var(--text-muted)";
    select.style.border = "1px solid var(--border)";
    select.style.borderRadius = "6px";
    select.style.fontSize = "12px";
    select.style.padding = "1px 4px";

    [["5000", "5s"], ["15000", "15s"]].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      select.appendChild(o);
    });
    select.value = String(chartIntervalMs);

    select.addEventListener("change", function () {
      chartIntervalMs = parseInt(select.value, 10) || 5000;
    });

    tag.textContent = "Refresh:";
    tag.appendChild(select);
  }

  function nowLabel() {
    var now = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
  }

  function initChart() {
    if (typeof Chart === 'undefined') {
      console.warn("Không tải được Chart.js (Chế độ offline) -> dùng canvas thuần");
      initFallbackChart();
      return;
    }

    var ctx = document.getElementById("sensorChart").getContext("2d");
    chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "Temperature (°C)", data: [], borderColor: "#f5a524", backgroundColor: "transparent", tension: 0.35, pointRadius: 3, borderWidth: 2 },
          { label: "Humidity (%)", data: [], borderColor: "#4aa3ff", backgroundColor: "transparent", tension: 0.35, pointRadius: 3, borderWidth: 2 },
          { label: "Soil Moisture (%)", data: [], borderColor: "#2ecc71", backgroundColor: "transparent", tension: 0.35, pointRadius: 3, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#828ba3", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
          y: { min: 0, max: 100, ticks: { color: "#828ba3", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
        },
      },
    });
  }

  // ---------- Fallback ----------
  function initFallbackChart() {
    fallbackChart = true;
    fallbackCanvas = document.getElementById("sensorChart");
    fallbackCtx = fallbackCanvas.getContext("2d");
    resizeFallbackCanvas();
    window.addEventListener("resize", resizeFallbackCanvas);
  }

  function resizeFallbackCanvas() {
    if (!fallbackCanvas) return;
    var rect = fallbackCanvas.parentElement.getBoundingClientRect();
    fallbackCanvas.width = rect.width;
    fallbackCanvas.height = rect.height;
    drawFallbackChart();
  }

  function drawFallbackChart() {
    if (!fallbackCtx) return;
    var w = fallbackCanvas.width, h = fallbackCanvas.height;
    if (!w || !h) return;
    var n = fallbackData.labels.length;
    var padLeft = 34, padRight = 10, padTop = 10, padBottom = 20;
    var plotW = w - padLeft - padRight;
    var plotH = h - padTop - padBottom;

    fallbackCtx.clearRect(0, 0, w, h);
    fallbackCtx.font = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    var yTicks = [0, 25, 50, 75, 100];
    fallbackCtx.textAlign = "right";
    fallbackCtx.textBaseline = "middle";
    yTicks.forEach(function (g) {
      var y = padTop + plotH - (g / 100) * plotH;
      fallbackCtx.strokeStyle = "rgba(255,255,255,0.05)"; 
      fallbackCtx.lineWidth = 1;
      fallbackCtx.beginPath();
      fallbackCtx.moveTo(padLeft, y);
      fallbackCtx.lineTo(padLeft + plotW, y);
      fallbackCtx.stroke();

      fallbackCtx.fillStyle = "#828ba3"; 
      fallbackCtx.fillText(String(g), padLeft - 6, y);
    });

    function xAt(i) {
      return padLeft + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    }

    if (n > 0) {
      fallbackCtx.textAlign = "center";
      fallbackCtx.textBaseline = "top";
      fallbackCtx.fillStyle = "#828ba3";
      var maxLabels = 6; 
      var step = Math.max(1, Math.ceil(n / maxLabels));
      for (var i = 0; i < n; i += step) {
        fallbackCtx.fillText(fallbackData.labels[i], xAt(i), padTop + plotH + 6);
      }
      if ((n - 1) % step !== 0) {
        fallbackCtx.fillText(fallbackData.labels[n - 1], xAt(n - 1), padTop + plotH + 6); 
      }
    }

    function drawSeries(values, color) {
      if (values.length === 0) return;
      var pts = values.map(function (v, i) {
        return {
          x: xAt(i),
          y: padTop + plotH - (Math.max(0, Math.min(100, v)) / 100) * plotH,
        };
      });

      if (pts.length >= 2) {
        fallbackCtx.strokeStyle = color;
        fallbackCtx.lineWidth = 2;
        fallbackCtx.lineJoin = "round";
        fallbackCtx.lineCap = "round";
        fallbackCtx.beginPath();
        fallbackCtx.moveTo(pts[0].x, pts[0].y);

        if (pts.length === 2) {
          fallbackCtx.lineTo(pts[1].x, pts[1].y);
        } else {
          for (var i = 0; i < pts.length - 1; i++) {
            var p0 = pts[i - 1] || pts[i];
            var p1 = pts[i];
            var p2 = pts[i + 1];
            var p3 = pts[i + 2] || p2;

            var cp1x = p1.x + (p2.x - p0.x) / 6;
            var cp1y = p1.y + (p2.y - p0.y) / 6;
            var cp2x = p2.x - (p3.x - p1.x) / 6;
            var cp2y = p2.y - (p3.y - p1.y) / 6;

            fallbackCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
          }
        }

        fallbackCtx.stroke();
      }

      fallbackCtx.fillStyle = color;
      pts.forEach(function (p) {
        fallbackCtx.beginPath();
        fallbackCtx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        fallbackCtx.fill();
      });
    }

    drawSeries(fallbackData.temp, "#f5a524"); // var(--c-temp)
    drawSeries(fallbackData.humi, "#4aa3ff"); // var(--c-humi)
    drawSeries(fallbackData.soil, "#2ecc71"); // var(--c-soil)
  }

  function pushChartPoint(temp, humi, soil) {
    if (fallbackChart) {
      fallbackData.labels.push(nowLabel());
      fallbackData.temp.push(temp);
      fallbackData.humi.push(humi);
      fallbackData.soil.push(soil);
      if (fallbackData.labels.length > MAX_POINTS) {
        fallbackData.labels.shift();
        fallbackData.temp.shift();
        fallbackData.humi.shift();
        fallbackData.soil.shift();
      }
      drawFallbackChart();
      return;
    }
    if (!chart) return;
    var labels = chart.data.labels;
    var d = chart.data.datasets;
    labels.push(nowLabel());
    d[0].data.push(temp);
    d[1].data.push(humi);
    d[2].data.push(soil);
    if (labels.length > MAX_POINTS) {
      labels.shift();
      d[0].data.shift();
      d[1].data.shift();
      d[2].data.shift();
    }
    chart.update();
  }

  // ---------- Map ----------
  var map = null;
  var marker = null;

  function initMap() {
    if (typeof L === 'undefined') {
      console.warn("Không tải được Leaflet (Chế độ offline)");
      return;
    }

    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([state.lat, state.lng], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    marker = L.marker([state.lat, state.lng]).addTo(map);
  }

  function updateMap(lat, lng) {
    state.lat = lat;
    state.lng = lng;
    if (marker) marker.setLatLng([lat, lng]);
  }

  // ---------- Badges ----------
  function setPumpBadge(on) {
    state.pumpState = on ? "ON" : "OFF";
    els.pumpBadge.textContent = state.pumpState;
    els.pumpBadge.className = "badge-pump " + (on ? "on" : "off");
  }

  function setModeBadge(mode) {
    state.pumpMode = mode;
    els.modeBadge.textContent = mode;
    els.modeBadge.className = "badge-mode " + (mode === "MANUAL" ? "manual" : "auto");
  }

  function setScoreMessage(score, message) {
    els.message.textContent = message || "--";
    var cls = "stat-sub";
    if (message === "Critical!") cls += " critical";
    else if (message === "Warning!") cls += " warning";
    else cls += " normal";
    els.message.className = cls;
  }

  // ---------- WebSocket ----------
  var activeWs = null;

  function connectWS() {
    var url = "ws://" + window.location.host + "/ws";
    var ws = new WebSocket(url);
    activeWs = ws;

    ws.onmessage = function (evt) {
      var data;
      try {
        data = JSON.parse(evt.data);
      } catch (e) {
        return;
      }

      var haveTemp = typeof data.temperature === "number";
      var haveHumi = typeof data.humidity === "number";
      var haveSoil = typeof data.soil_moisture === "number";

      if (haveTemp) {
        els.temp.textContent = data.temperature.toFixed(1) + "\u00B0C";
        els.temp.className = "stat-value " + tempColorClass(data.temperature);
      }

      if (haveHumi) {
        els.humi.textContent = (data.humidity >= 99.95)
          ? "100%"
          : data.humidity.toFixed(1) + "%";
        els.humi.className = "stat-value " + humiColorClass(data.humidity);
      }

      if (haveSoil) {
        var soilVal = Math.round(data.soil_moisture);
        var soilStr = (soilVal < 10 ? "0" + soilVal : "" + soilVal);
        els.soil.textContent = soilStr + "%";
        els.soil.className = "stat-value " + soilColorClass(data.soil_moisture);
      }

      if (haveTemp || haveHumi || haveSoil) {
        var nowTs = Date.now();
        if (nowTs - lastChartPushTime >= chartIntervalMs) {
          lastChartPushTime = nowTs;
          pushChartPoint(
            haveTemp ? data.temperature : (chart && chart.data.datasets[0].data.slice(-1)[0] || 0),
            haveHumi ? data.humidity : (chart && chart.data.datasets[1].data.slice(-1)[0] || 0),
            haveSoil ? data.soil_moisture : (chart && chart.data.datasets[2].data.slice(-1)[0] || 0)
          );
        }
      }

      if (typeof data.pump_state === "string") {
        setPumpBadge(data.pump_state.toUpperCase() === "ON");
      }
      if (typeof data.pump_mode === "string") {
        setModeBadge(data.pump_mode.toUpperCase());
      } else if (typeof data.pump_controller === "string" &&
                 (data.pump_controller === "MANUAL" || data.pump_controller === "AUTO")) {
        setModeBadge(data.pump_controller);
      }

      if (typeof data.lcd_state === "number") {
        var lcdLabelMap = { 1: "Normal", 2: "Warning", 3: "Critical" };
        var lcdLabel = lcdLabelMap[data.lcd_state] || "--";
        els.message.textContent = lcdLabel;
        var lcdCls = "stat-sub";
        if (data.lcd_state === 3) lcdCls += " critical";
        else if (data.lcd_state === 2) lcdCls += " warning";
        else lcdCls += " normal";
        els.message.className = lcdCls;
      } else if (typeof data.ml_score === "number" || typeof data.ml_message === "string") {
        setScoreMessage(data.ml_score, data.ml_message);
      }

      if (typeof data.lat === "number" && typeof data.long === "number") {
        updateMap(data.lat, data.long);
      }

      if (data.page === "setting_saved" && data.status === "OK") {
        if (wifiSettingsMsg) wifiSettingsMsg.textContent = "Cấu hình thành công";
      }
    };

    ws.onclose = function () {
      setTimeout(connectWS, 2000);
    };
    ws.onerror = function () {
      ws.close();
    };
  }

  // ---------- Status pill (CoreIoT / MQTT) ----------
  function pollStatus() {
    fetch("/api/status")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        els.coreiotDot.className = "dot " + (s.mqtt_connected ? "online" : "offline");

        var apOverlay = document.getElementById("apModeOverlay");
        if (apOverlay) {
          if (s.is_ap_mode) {
            apOverlay.style.display = "flex";
          } else {
            apOverlay.style.display = "none";
          }
        }
      })
      .catch(function () {
        els.coreiotDot.className = "dot offline";
      });
  }

  // ---------- Toggle buttons ----------
  els.pumpToggleBtn.addEventListener("click", function () {
    var nextState = state.pumpState === "ON" ? "OFF" : "ON";

    fetch("/toggle-pump?state=" + nextState)
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var resState = txt.trim().toUpperCase();
        var finalState = (resState === "ON" || resState === "OFF") ? resState : nextState;

        setPumpBadge(finalState === "ON");
        setModeBadge("MANUAL"); 
      })
      .catch(function (err) {
        console.warn("Lỗi kết nối HTTP, tự động cập nhật trạng thái trên giao diện: ", err);
        setPumpBadge(nextState === "ON");
        setModeBadge("MANUAL");
      });
  });

  els.modeToggleBtn.addEventListener("click", function () {
    var nextMode = state.pumpMode === "MANUAL" ? "AUTO" : "MANUAL";

    fetch("/set-mode?mode=" + nextMode)
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var resMode = txt.trim().toUpperCase();
        var finalMode = (resMode === "MANUAL" || resMode === "AUTO") ? resMode : nextMode;

        setModeBadge(finalMode);
      })
      .catch(function (err) {
        console.warn("Lỗi kết nối HTTP khi thay đổi chế độ: ", err);
        setModeBadge(nextMode); 
      });
  });

  // ---------- WiFi list management ----------
  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function switchWifiNetwork(ssid, pass, btn) {
    if (btn) btn.disabled = true;
    fetch('/api/wifi-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: ssid, pass: pass })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) btn.disabled = false;
        if (data.ok && wifiSettingsMsg) {
          wifiSettingsMsg.textContent = 'Đang chuyển sang "' + ssid + '"...';
        }
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        if (wifiSettingsMsg) wifiSettingsMsg.textContent = 'Lỗi kết nối.';
      });
  }

  function loadAndRenderWifiList() {
    var container = document.getElementById('wifiListSection');
    if (!container) return;
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">Đang tải...</div>';
    fetch('/api/wifi-list')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list) || list.length === 0) {
          container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding-bottom:10px;">Chưa có mạng đã lưu.</div>';
          return;
        }
        var html = '<div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;">Mạng WiFi đã lưu</div>';
        list.forEach(function (item) {
          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">'
            + '<span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;">' + escapeAttr(item.ssid) + '</span>'
            + '<button class="btn-toggle" style="padding:4px 12px;font-size:12px;flex-shrink:0;"'
            + ' data-ssid="' + escapeAttr(item.ssid) + '">Chuyển</button>'
            + '</div>';
        });
        container.innerHTML = html;
        container.querySelectorAll('button[data-ssid]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            switchWifiNetwork(btn.getAttribute('data-ssid'), '', btn);
          });
        });
      })
      .catch(function () {
        container.innerHTML = '<div style="font-size:12px;color:var(--red);">Không tải được danh sách.</div>';
      });
  }

  // ---------- Settings modal (WiFi config) ----------
  var settingsNavBtn = document.getElementById("settingsNavBtn");
  var settingsModal = document.getElementById("settingsModal");
  var settingsCloseBtn = document.getElementById("settingsCloseBtn");
  var wifiSettingsForm = document.getElementById("wifiSettingsForm");
  var wifiSettingsMsg = document.getElementById("wifiSettingsMsg");

  function openSettingsModal(e) {
    if (e) e.preventDefault();
    if (!settingsModal) return;
    var modalBox = settingsModal.querySelector('.modal-box');
    if (modalBox && !document.getElementById('wifiListSection')) {
      var section = document.createElement('div');
      section.id = 'wifiListSection';
      section.style.marginBottom = '14px';
      var form = modalBox.querySelector('#wifiSettingsForm');
      modalBox.insertBefore(section, form || null);
    }
    settingsModal.style.display = "flex";
    loadAndRenderWifiList();
    var serverUrlInput = document.getElementById("serverUrl");
    if (serverUrlInput) {
      fetch("/api/server-url")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.url) serverUrlInput.value = data.url;
        })
        .catch(function () {});
    }
  }

  function closeSettingsModal() {
    if (settingsModal) settingsModal.style.display = "none";
  }

  if (settingsNavBtn) settingsNavBtn.addEventListener("click", openSettingsModal);
  if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettingsModal);

  if (wifiSettingsForm) {
    wifiSettingsForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var ssid = document.getElementById("wifiSsid").value;
      var pass = document.getElementById("wifiPass").value;
      var serverEl = document.getElementById("serverUrl");
      var server = serverEl ? serverEl.value : "";

      var payload = {
        page: "setting",
        value: {
          ssid: ssid,
          password: pass,
          token: "",
          server: server,
          port: ""
        }
      };

      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify(payload));
        wifiSettingsMsg.textContent = "Đã gửi cấu hình. Thiết bị sẽ khởi động lại...";
      } else {
        wifiSettingsMsg.textContent = "Chưa kết nối WebSocket, vui lòng thử lại.";
      }
    });
  }

  var serverUrlForm = document.getElementById("serverUrlForm");
  if (serverUrlForm) {
    serverUrlForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var serverEl = document.getElementById("serverUrl");
      var url = serverEl ? serverEl.value.trim() : "";
      if (!url) {
        if (wifiSettingsMsg) wifiSettingsMsg.textContent = "Nhập URL backend.";
        return;
      }
      fetch("/api/server-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (wifiSettingsMsg) {
            wifiSettingsMsg.textContent = data.ok ? "Đã lưu URL server." : "Lưu URL thất bại.";
          }
        })
        .catch(function () {
          if (wifiSettingsMsg) wifiSettingsMsg.textContent = "Lỗi kết nối.";
        });
    });
  }

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", function () {
    initChart();
    initChartIntervalControl();
    initMap();
    connectWS();
    pollStatus();
    setInterval(pollStatus, 5000);

    // Session timeout: Maximum 5 minutes, then redirect to the Admin Dashboard
    var params = new URLSearchParams(window.location.search);
    var sessionStartStr = params.get("session_start") || "";
    var sessionStart = 0;
    if (sessionStartStr && sessionStartStr.indexOf(":") !== -1) {
        var parts = sessionStartStr.split(":");
        var d = new Date();
        d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10), 0);
        sessionStart = d.getTime();
    }
    if (sessionStart > 0) {
        var elapsed = Date.now() - sessionStart;
      var remaining = 5 * 60 * 1000 - elapsed;
      if (remaining <= 0) {
          if (document.referrer) { window.location.href = document.referrer; } else { window.history.back(); }
      } else {
          setTimeout(function () {
              if (document.referrer) { window.location.href = document.referrer; } else { window.history.back(); }
          }, remaining);
      }
    }
  });
})();