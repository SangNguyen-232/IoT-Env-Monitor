(function () {
  "use strict";

  var MAX_POINTS = 60;
  var DEFAULT_LAT = 12.6951778;
  var DEFAULT_LNG = 108.057041;
  var FAN_MODES = ["AUTO", "SHADOW", "AI", "MANUAL"];
  var STALE_MS = 15000;

  var state = {
    fanState: null,
    fanMode: null,
    lastFanAt: 0,
    lastSensorAt: 0,
    controlPending: false,
    controlRevision: 0,
    modeSelectionDirty: false,
    requestedMode: null,
    modeRequestedAt: 0,
    ai: null,
    aiKey: null,
    aiAt: 0,
    bootId: null,
  };

  // ---------- DOM refs ----------
  var els = {
    temp: document.getElementById("statTemp"),
    humi: document.getElementById("statHumi"),
    soil: document.getElementById("statSoil"),
    time: document.getElementById("statTime"),
    message: document.getElementById("statMessage"),
    fanBadge: document.getElementById("fanBadge"),
    modeBadge: document.getElementById("modeBadge"),
    fanSettingsBadge: document.getElementById("fanSettingsBadge"),
    modeSettingsBadge: document.getElementById("modeSettingsBadge"),
    fanToggleBtn: document.getElementById("fanToggleBtn"),
    modeApplyBtn: document.getElementById("modeApplyBtn"),
    modeSelect: document.getElementById("modeSelect"),
    fanReason: document.getElementById("fanReason"),
    controlStatus: document.getElementById("controlStatus"),
  };

  // ---------- Sensor display formatting (numeric samples stay unchanged) ----------
  function validDisplayValue(value, min, max) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  }

  function formatTemperature(value) {
    if (!validDisplayValue(value, -40, 80)) return "--\u00B0C";
    var rounded = Math.round(Math.abs(value) * 10) / 10;
    if (value < 0 && rounded !== 0) rounded = -rounded;
    return rounded.toFixed(1) + "\u00B0C";
  }

  function formatHumidity(value) {
    if (!validDisplayValue(value, 0, 100)) return "--%";
    var rounded = Math.round(value * 10) / 10;
    return (rounded === 0 ? "00" : String(rounded)) + "%";
  }

  function formatSoil(value) {
    if (!validDisplayValue(value, 0, 100)) return "--%";
    var rounded = Math.round(value);
    return (rounded < 10 ? "0" : "") + rounded + "%";
  }

  // ---------- Risk color helpers (mirrors risk_policy.h thresholds) ----------
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
    if (typeof Chart === "undefined") {
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
        spanGaps: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (context) {
                if (context.datasetIndex === 0) return "Temperature: " + formatTemperature(context.raw);
                if (context.datasetIndex === 1) return "Humidity: " + formatHumidity(context.raw);
                return "Soil Moisture: " + formatSoil(context.raw);
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: "#828ba3", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
          y: { min: -40, max: 100, ticks: { color: "#828ba3", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
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

    var yTicks = [-40, -20, 0, 20, 40, 60, 80, 100];
    fallbackCtx.textAlign = "right";
    fallbackCtx.textBaseline = "middle";
    yTicks.forEach(function (g) {
      var y = padTop + plotH - ((g + 40) / 140) * plotH;
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
      var pts = [];

      function drawSegment() {
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

      values.forEach(function (value, index) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          drawSegment();
          pts = [];
          return;
        }
        pts.push({
          x: xAt(index),
          y: padTop + plotH - ((Math.max(-40, Math.min(100, value)) + 40) / 140) * plotH,
        });
      });
      drawSegment();
    }

    drawSeries(fallbackData.temp, "#f5a524");
    drawSeries(fallbackData.humi, "#4aa3ff");
    drawSeries(fallbackData.soil, "#2ecc71");
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
  var mapInstance = null;
  function initMap() {
    if (typeof L === "undefined") {
      console.warn("Không tải được Leaflet (Chế độ offline)");
      return;
    }

    mapInstance = L.map("map", { zoomControl: true, attributionControl: true }).setView([DEFAULT_LAT, DEFAULT_LNG], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapInstance);
    L.marker([DEFAULT_LAT, DEFAULT_LNG]).addTo(mapInstance);
  }

  // ---------- Badges ----------
  function setFanBadge(on) {
    state.fanState = on ? "ON" : "OFF";
    els.fanBadge.textContent = state.fanState;
    els.fanBadge.className = "badge badge-fan " + (on ? "on" : "off");
    els.fanSettingsBadge.textContent = state.fanState;
    els.fanSettingsBadge.className = els.fanBadge.className;
  }

  function setModeBadge(mode) {
    state.fanMode = mode;
    els.modeBadge.textContent = mode;
    els.modeBadge.className = "badge badge-mode " + mode.toLowerCase();
    els.modeSettingsBadge.textContent = mode;
    els.modeSettingsBadge.className = els.modeBadge.className;
    if (state.requestedMode === mode) state.requestedMode = null;
    if (!state.modeSelectionDirty && !state.requestedMode) els.modeSelect.value = mode;
    syncControls();
  }

  function syncControls() {
    var fresh = state.lastFanAt && Date.now() - state.lastFanAt < STALE_MS;
    els.fanToggleBtn.disabled = state.controlPending || !fresh || state.fanMode !== "MANUAL";
    els.fanToggleBtn.title = state.fanMode === "MANUAL" ? "Đổi lệnh quạt ON/OFF" : "Chọn và áp dụng MANUAL trước";
    els.modeApplyBtn.disabled = state.controlPending || !fresh;
    els.modeSelect.disabled = state.controlPending;
  }

  function reasonLabel(reason) {
    var labels = {
      control_unavailable: "Chưa có trạng thái điều khiển",
      manual_on: "Lệnh bật thủ công", manual_off: "Lệnh tắt thủ công", manual_timeout: "Hết thời hạn bật thủ công",
      config_required: "Cần lưu cấu hình ngưỡng", sensor_invalid: "Dữ liệu cảm biến lỗi hoặc quá hạn",
      mode_changed: "Đã đổi chế độ; tắt quạt và chờ chu kỳ điều khiển",
      ai_on: "AI đề xuất bật", ai_off: "AI đề xuất tắt", ai_hold: "AI đề xuất giữ trạng thái",
      rule_on: "Luật ngưỡng yêu cầu bật", rule_off: "Luật ngưỡng yêu cầu tắt",
      min_on_time: "Giữ ON đủ thời gian tối thiểu", min_off_time: "Giữ OFF đủ thời gian tối thiểu",
      ai_fallback_low_score: "Dùng luật dự phòng: softmax chưa đạt 0,8",
      ai_fallback_profile_mismatch: "Dùng luật dự phòng: ngưỡng hoặc điều kiện BẬT đã lưu chưa khớp profile của mô hình"
    };
    if (labels[reason]) return labels[reason];
    if (typeof reason === "string" && reason.indexOf("ai_fallback_") === 0) {
      return "Dùng luật dự phòng: " + aiStatusLabel(reason.slice(12));
    }
    return typeof reason === "string" ? reason : "Chưa có lý do điều khiển";
  }

  function applyFanSnapshot(data) {
    if ((data.fan_state !== "ON" && data.fan_state !== "OFF") || FAN_MODES.indexOf(data.fan_mode) === -1) return;
    state.lastFanAt = Date.now();
    setFanBadge(data.fan_state === "ON");
    setModeBadge(data.fan_mode);
    if (typeof data.fan_reason === "string") els.fanReason.textContent = "Bộ điều khiển: " + reasonLabel(data.fan_reason) + ".";
    syncControls();
  }

  function aiStatusLabel(status) {
    return ({ loading: "Đang tải mô hình", ready: "Có kết quả", sensor_invalid: "Cảm biến không hợp lệ",
      out_of_domain: "Ngoài miền mô hình", inference_error: "Lỗi suy luận", model_error: "Lỗi mô hình",
      stale: "Kết quả quá hạn", offline: "Chưa có kết nối", unavailable: "Chưa có dữ liệu AI" })[status] || "Trạng thái chưa xác định";
  }

  function aiClassLabel(value) {
    return ({ OFF: "OFF · Tắt", HOLD: "HOLD · Giữ", ON: "ON · Bật" })[value] || "—";
  }

  function renderAI() {
    var ai = state.ai;
    var status = ai ? ai.status : "loading";
    if (ai && (!state.aiAt || Date.now() - state.aiAt >= STALE_MS)) status = "stale";
    var ready = status === "ready";
    var statusEl = document.getElementById("aiStatus");
    statusEl.textContent = aiStatusLabel(status);
    statusEl.className = "ai-status" + (ready ? " ready" : " pending");
    document.getElementById("aiProposal").textContent = ready ? aiClassLabel(ai.predicted_class) : "—";
    document.getElementById("aiTeacher").textContent = ai && status !== "stale" ? aiClassLabel(ai.rule_class) : "—";
    var count = ai && Number.isInteger(ai.evaluated_samples) && ai.evaluated_samples >= 0 ? ai.evaluated_samples : 0;
    document.getElementById("aiAgreement").textContent = ai && count > 0 && validDisplayValue(ai.agreement_pct, 0, 100)
      ? ai.agreement_pct.toFixed(1) + "% · " + count + " mẫu" : "Chưa có mẫu đối chiếu";
    var probs = ready && Array.isArray(ai.probabilities) && ai.probabilities.length === 3 && ai.probabilities.every(function (p) {
      return validDisplayValue(p, 0, 1);
    }) ? ai.probabilities : null;
    document.getElementById("aiProbabilities").textContent = "Softmax OFF / HOLD / ON: " + (probs
      ? probs.map(function (p) { return (p * 100).toFixed(1) + "%"; }).join(" / ") + " · chưa hiệu chuẩn độ tin cậy" : "—");
    document.getElementById("aiModel").textContent = "Mô hình: " + (ai && typeof ai.model_version === "string" ? ai.model_version : "—");
    var latency = ready && validDisplayValue(ai.inference_ms, 0, 60000) ? " · suy luận " + ai.inference_ms.toFixed(1) + " ms" : "";
    document.getElementById("aiSample").textContent = ai
      ? "Phiên " + (state.bootId || "—") + " · mẫu AI " + (Number.isInteger(ai.sample_seq) ? ai.sample_seq : "—") + latency + (status === "stale" ? " · cần dữ liệu mới" : "")
      : "Chưa nhận kết quả suy luận.";
  }

  function applyAI(data) {
    if (!data.ai || typeof data.ai !== "object" || Array.isArray(data.ai)) return;
    var ai = data.ai;
    var bootId = typeof data.boot_id === "string" ? data.boot_id : state.bootId;
    if (ai.status === "ready" && (!data.boot_id || !Number.isInteger(data.sample_seq) ||
        !Number.isInteger(data.sampled_uptime_ms) || ai.sample_seq !== data.sample_seq ||
        ai.sampled_uptime_ms !== data.sampled_uptime_ms)) {
      // Do not associate an older inference with a different sensor snapshot.
      ai = Object.assign({}, ai, { status: "stale", predicted_class: null, rule_class: null, probabilities: null });
    }
    var key = String(bootId) + ":" + ai.sample_seq + ":" + ai.sampled_uptime_ms + ":" + ai.status;
    if (key !== state.aiKey) {
      state.aiKey = key;
      state.aiAt = Date.now();
    }
    state.bootId = bootId;
    state.ai = ai;
    renderAI();
  }

  function checkFreshness() {
    if (state.requestedMode && Date.now() - state.modeRequestedAt >= STALE_MS) {
      els.controlStatus.textContent = "Chưa xác nhận thiết bị áp dụng " + state.requestedMode + ". Kiểm tra trạng thái rồi thử lại.";
      state.requestedMode = null;
    }
    if (state.lastFanAt && Date.now() - state.lastFanAt >= STALE_MS) {
      els.fanBadge.textContent = "—";
      els.modeBadge.textContent = "—";
      els.fanSettingsBadge.textContent = "—";
      els.modeSettingsBadge.textContent = "—";
      els.fanReason.textContent = "Trạng thái điều khiển quá hạn; đang chờ kết nối thiết bị.";
    }
    if (state.lastSensorAt && Date.now() - state.lastSensorAt >= STALE_MS) {
      els.temp.textContent = "--°C";
      els.humi.textContent = "--%";
      els.soil.textContent = "--%";
      els.temp.className = "stat-value";
      els.humi.className = "stat-value";
      els.message.textContent = "Dữ liệu quá hạn";
      els.message.className = "stat-sub unknown";
    }
    syncControls();
    renderAI();
  }

  // ---------- WebSocket ----------
  var activeWs = null;

  function connectWS() {
    var url = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws";
    var ws = new WebSocket(url);
    activeWs = ws;

    ws.onmessage = function (evt) {
      var data;
      try {
        data = JSON.parse(evt.data);
      } catch (e) {
        return;
      }

      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      var hasSensorSnapshot = ["temperature", "humidity", "soil_moisture"].some(function (key) {
        return Object.prototype.hasOwnProperty.call(data, key);
      });
      if (hasSensorSnapshot) {
        state.lastSensorAt = Date.now();
        function sampleValue(value, min, max) {
          return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
            ? value : null;
        }
        var temperature = sampleValue(data.temperature, -40, 80);
        var humidity = sampleValue(data.humidity, 0, 100);
        var soil = sampleValue(data.soil_moisture, 0, 100);

        els.temp.textContent = formatTemperature(temperature);
        els.temp.className = "stat-value" + (temperature === null ? "" : " " + tempColorClass(temperature));
        els.humi.textContent = formatHumidity(humidity);
        els.humi.className = "stat-value" + (humidity === null ? "" : " " + humiColorClass(humidity));
        els.soil.textContent = formatSoil(soil);
        els.soil.className = "stat-value val-soil";

        var nowTs = Date.now();
        if (nowTs - lastChartPushTime >= chartIntervalMs) {
          lastChartPushTime = nowTs;
          pushChartPoint(temperature, humidity, soil);
        }
      }

      applyFanSnapshot(data);
      applyAI(data);

      if (hasSensorSnapshot || Object.prototype.hasOwnProperty.call(data, "lcd_state")) {
        var lcdLabelMap = { 1: "Normal", 2: "Warning", 3: "Critical" };
        var validAirSnapshot = !hasSensorSnapshot || (temperature !== null && humidity !== null);
        var lcdState = validAirSnapshot && (data.lcd_state === 1 || data.lcd_state === 2 || data.lcd_state === 3)
          ? data.lcd_state : null;
        els.message.textContent = lcdLabelMap[lcdState] || "--";
        var lcdCls = "stat-sub";
        if (lcdState === 3) lcdCls += " critical";
        else if (lcdState === 2) lcdCls += " warning";
        else if (lcdState === 1) lcdCls += " normal";
        else lcdCls += " unknown";
        els.message.className = lcdCls;
      }

      if (data.page === "setting_saved" && data.status === "OK") {
        if (wifiSettingsMsg) wifiSettingsMsg.textContent = "Cấu hình thành công";
      }
    };

    ws.onopen = function () {
      fetch("/api/ws-token")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.token && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ page: "auth", token: d.token }));
          }
        })
        .catch(function () {});
    };

    ws.onclose = function () {
      setTimeout(connectWS, 2000);
    };
    ws.onerror = function () {
      ws.close();
    };
  }

  // ---------- Status poll (AP mode overlay and relay state reconciliation) ----------
  function pollStatus() {
    var revision = state.controlRevision;
    fetch("/api/status", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (s) {
        if (revision !== state.controlRevision) return;
        applyFanSnapshot(s);
        var apOverlay = document.getElementById("apModeOverlay");
        if (apOverlay) {
          apOverlay.style.display = s.is_ap_mode ? "flex" : "none";
        }
      })
      .catch(function () {});
  }

  function pollAIStatus() {
    var revision = state.controlRevision;
    fetch("/api/ai-status", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (revision !== state.controlRevision) return;
        applyFanSnapshot(data);
        applyAI(data);
      })
      .catch(function () {
        if (!state.ai) {
          state.ai = { status: "unavailable" };
          state.aiAt = Date.now();
        }
        renderAI();
      });
  }

  // ---------- Toggle buttons ----------
  function requestControl(url, allowedValues, onSuccess) {
    state.controlPending = true;
    state.controlRevision += 1;
    syncControls();
    els.controlStatus.textContent = "";

    fetch(url)
      .then(function (r) {
        return r.text().then(function (body) {
          if (!r.ok) throw new Error(r.status === 400 || r.status === 409
            ? "Thiết bị từ chối yêu cầu. AI/SHADOW cần cấu hình ngưỡng dự phòng hợp lệ; lệnh quạt cần MANUAL."
            : "Không xác nhận được lệnh (HTTP " + r.status + ").");
          return body;
        });
      })
      .then(function (txt) {
        var value = txt.trim().toUpperCase();
        if (allowedValues.indexOf(value) === -1) {
          throw new Error("Invalid control response");
        }
        onSuccess(value);
      })
      .catch(function (err) {
        console.warn("Không xác nhận được lệnh điều khiển: ", err);
        els.controlStatus.textContent = err.message || "Không xác nhận được lệnh. Kiểm tra kết nối và trạng thái thiết bị.";
      })
      .then(function () {
        state.controlPending = false;
        syncControls();
      });
  }

  els.fanToggleBtn.addEventListener("click", function () {
    if (state.fanMode !== "MANUAL") return;
    var nextState = state.fanState === "ON" ? "OFF" : "ON";
    requestControl("/toggle-fan?state=" + nextState, ["ON", "OFF"], function () {
      els.controlStatus.textContent = "Đã gửi yêu cầu quạt " + nextState + "; đang chờ trạng thái thiết bị.";
      // The response acknowledges the requested state; telemetry reports GPIO state.
      pollStatus();
    });
  });

  els.modeSelect.addEventListener("change", function () { state.modeSelectionDirty = true; });
  els.modeApplyBtn.addEventListener("click", function () {
    var nextMode = els.modeSelect.value;
    if (FAN_MODES.indexOf(nextMode) === -1) return;
    requestControl("/set-mode?mode=" + encodeURIComponent(nextMode), FAN_MODES, function (mode) {
      state.modeSelectionDirty = false;
      state.requestedMode = mode;
      state.modeRequestedAt = Date.now();
      els.controlStatus.textContent = "Đã gửi yêu cầu " + mode + "; đang chờ trạng thái thiết bị.";
      pollStatus();
      pollAIStatus();
    });
  });

  // ---------- Fan AUTO configuration ----------
  var fanConfigForm = document.getElementById("fanConfigForm");
  var fanConfigFields = document.getElementById("fanConfigFields");
  var fanConfigStatus = document.getElementById("fanConfigStatus");
  var fanActivationLogic = document.getElementById("fanActivationLogic");
  var fanLogicDescription = document.getElementById("fanLogicDescription");
  var fanConfigInputs = {
    temperature_on: document.getElementById("fanTemperatureOn"),
    temperature_off: document.getElementById("fanTemperatureOff"),
    humidity_on: document.getElementById("fanHumidityOn"),
    humidity_off: document.getElementById("fanHumidityOff"),
  };

  function setFanConfigStatus(message, type) {
    fanConfigStatus.textContent = message;
    fanConfigStatus.className = "settings-msg" + (type ? " " + type : "");
  }

  function updateFanLogicDescription() {
    fanLogicDescription.textContent = fanActivationLogic.value === "all"
      ? "BẬT khi nhiệt độ ≥ ngưỡng BẬT VÀ độ ẩm ≥ ngưỡng BẬT. TẮT khi nhiệt độ ≤ ngưỡng TẮT HOẶC độ ẩm ≤ ngưỡng TẮT. Giữ trạng thái hiện tại trong vùng còn lại."
      : "BẬT khi nhiệt độ ≥ ngưỡng BẬT HOẶC độ ẩm ≥ ngưỡng BẬT. TẮT khi nhiệt độ ≤ ngưỡng TẮT VÀ độ ẩm ≤ ngưỡng TẮT. Giữ trạng thái hiện tại trong vùng còn lại.";
  }

  function validateFanConfig(config) {
    var valid = Object.keys(fanConfigInputs).every(function (key) {
      return typeof config[key] === "number" && Number.isFinite(config[key]);
    });
    if (!valid) throw new Error("Nhập đầy đủ bốn ngưỡng bằng số hợp lệ.");
    if (config.temperature_on < -40 || config.temperature_on > 80 ||
        config.temperature_off < -40 || config.temperature_off > 80) {
      throw new Error("Ngưỡng nhiệt độ phải nằm trong khoảng -40 đến 80°C.");
    }
    if (config.humidity_on < 0 || config.humidity_on > 100 ||
        config.humidity_off < 0 || config.humidity_off > 100) {
      throw new Error("Ngưỡng độ ẩm phải nằm trong khoảng 0 đến 100%.");
    }
    if (config.temperature_off >= config.temperature_on || config.humidity_off >= config.humidity_on) {
      throw new Error("Mỗi ngưỡng TẮT phải thấp hơn ngưỡng BẬT tương ứng.");
    }
    if (config.activation_logic !== "any" && config.activation_logic !== "all") {
      throw new Error("Chọn điều kiện BẬT HOẶC hoặc VÀ.");
    }
  }

  function showFanConfig(config) {
    if (!config || typeof config.configured !== "boolean") throw new Error("Invalid configuration response");
    if (config.configured) validateFanConfig(config);
    Object.keys(fanConfigInputs).forEach(function (key) {
      fanConfigInputs[key].value = config.configured ? String(config[key]) : "";
    });
    fanActivationLogic.value = config.activation_logic === "all" ? "all" : "any";
    updateFanLogicDescription();
    setFanConfigStatus(config.configured
      ? "Đang dùng cấu hình FAN đã lưu trên thiết bị."
      : "Chưa cấu hình: AUTO giữ FAN OFF; chưa thể bật AI/SHADOW. Nhập và lưu các ngưỡng dự phòng.");
  }

  function loadFanConfig() {
    fanConfigFields.disabled = true;
    fetch("/api/fan-config")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(showFanConfig)
      .catch(function (err) {
        console.warn("Không tải được cấu hình FAN: ", err);
        setFanConfigStatus("Không tải được cấu hình đã lưu. Bạn có thể nhập đầy đủ các ngưỡng để lưu lại.", "error");
      })
      .then(function () { fanConfigFields.disabled = false; });
  }

  fanActivationLogic.addEventListener("change", updateFanLogicDescription);
  fanConfigForm.addEventListener("input", function () {
    setFanConfigStatus("Chưa lưu thay đổi. Bấm Lưu cấu hình FAN để áp dụng.");
  });
  fanConfigForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var config = { activation_logic: fanActivationLogic.value };
    Object.keys(fanConfigInputs).forEach(function (key) {
      var raw = fanConfigInputs[key].value.trim();
      config[key] = raw === "" ? NaN : Number(raw);
    });
    try {
      validateFanConfig(config);
    } catch (err) {
      setFanConfigStatus(err.message, "error");
      return;
    }

    fanConfigFields.disabled = true;
    setFanConfigStatus("Đang lưu cấu hình FAN...");
    fetch("/api/fan-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (saved) {
        if (!saved || saved.configured !== true) throw new Error("Configuration was not saved");
        showFanConfig(saved);
        setFanConfigStatus("Đã lưu ngưỡng cho AUTO / SHADOW và dự phòng cho AI. Cấu hình được giữ sau khi khởi động lại.", "success");
        pollStatus();
      })
      .catch(function (err) {
        console.warn("Không xác nhận được việc lưu cấu hình FAN: ", err);
        setFanConfigStatus("Không xác nhận được việc lưu cấu hình. Kiểm tra kết nối rồi thử lưu lại.", "error");
      })
      .then(function () { fanConfigFields.disabled = false; });
  });

  // ---------- WiFi list management ----------
  function switchWifiNetwork(ssid, btn) {
    if (btn) btn.disabled = true;
    fetch("/api/wifi-switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssid: ssid })
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (btn) btn.disabled = false;
        wifiSettingsMsg.textContent = data.ok
          ? "Đang chuyển sang \"" + ssid + "\"..."
          : "Thiết bị chưa xác nhận chuyển mạng. Vui lòng thử lại.";
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        if (wifiSettingsMsg) wifiSettingsMsg.textContent = "Lỗi kết nối.";
      });
  }

  function loadAndRenderWifiList() {
    var container = document.getElementById("wifiListSection");
    if (!container) return;
    container.textContent = "Đang tải mạng WiFi đã lưu...";
    var refreshButton = document.getElementById("wifiRefreshBtn");
    refreshButton.disabled = true;
    fetch("/api/wifi-list")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (list) {
        if (!Array.isArray(list) || list.length === 0) {
          container.textContent = "Chưa có mạng đã lưu.";
          return;
        }
        container.textContent = "";
        var heading = document.createElement("h3");
        heading.textContent = "Mạng WiFi đã lưu";
        container.appendChild(heading);
        list.forEach(function (item) {
          if (!item || typeof item.ssid !== "string") return;
          var row = document.createElement("div");
          row.className = "wifi-network-row";
          var name = document.createElement("span");
          name.textContent = item.ssid;
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn-toggle";
          btn.textContent = "Chuyển";
          btn.setAttribute("aria-label", "Chuyển sang " + item.ssid);
          btn.addEventListener("click", function () {
            switchWifiNetwork(item.ssid, btn);
          });
          row.appendChild(name);
          row.appendChild(btn);
          container.appendChild(row);
        });
      })
      .catch(function () {
        container.textContent = "Không tải được danh sách. Bấm Làm mới danh sách để thử lại.";
      })
      .then(function () { refreshButton.disabled = false; });
  }

  // ---------- Settings views (navigation never reconstructs unsaved forms) ----------
  var settingsNavBtn = document.getElementById("settingsNavBtn");
  var settingsSubnav = document.getElementById("settingsSubnav");
  var wifiSettingsForm = document.getElementById("wifiSettingsForm");
  var wifiSettingsMsg = document.getElementById("wifiSettingsMsg");
  var wifiSettingsLoaded = false;
  var serverUrlDirty = false;
  var fanSettingsLoaded = false;
  var viewRoutes = { dashboard: "#dashboard", wifi: "#settings/wifi", fan: "#settings/fan", tinyml: "#settings/tinyml" };
  var viewTitles = { dashboard: "Dashboard", wifi: "Settings · Cấu hình WiFi", fan: "Settings · Cấu hình FAN", tinyml: "Settings · TinyML" };

  function loadWifiSettings() {
    if (wifiSettingsLoaded) return;
    wifiSettingsLoaded = true;
    loadAndRenderWifiList();
    var serverUrlInput = document.getElementById("serverUrl");
    fetch("/api/server-url")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!serverUrlDirty && data && typeof data.url === "string") serverUrlInput.value = data.url;
      })
      .catch(function () {
        if (!serverUrlDirty) wifiSettingsMsg.textContent = "Chưa tải được URL backend đã lưu. Bạn vẫn có thể nhập URL mới.";
      });
  }

  function showView(view, focusTitle) {
    if (!Object.prototype.hasOwnProperty.call(viewRoutes, view)) view = "dashboard";
    Object.keys(viewRoutes).forEach(function (name) {
      document.getElementById(name + "View").hidden = name !== view;
    });
    document.querySelectorAll(".nav a[data-view]").forEach(function (link) {
      var selected = link.getAttribute("data-view") === view;
      link.classList.toggle("active", selected);
      if (selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    settingsNavBtn.classList.toggle("active", view !== "dashboard");
    if (view !== "dashboard") {
      settingsSubnav.hidden = false;
      settingsNavBtn.setAttribute("aria-expanded", "true");
    }
    var title = document.getElementById("pageTitle");
    title.textContent = viewTitles[view];
    if (focusTitle) title.focus({ preventScroll: true });
    if (view === "wifi") loadWifiSettings();
    if (view === "fan" && !fanSettingsLoaded) {
      fanSettingsLoaded = true;
      loadFanConfig();
    }
    if (view === "dashboard") {
      window.requestAnimationFrame(function () {
        if (chart) chart.resize();
        if (fallbackChart) resizeFallbackCanvas();
        if (mapInstance) mapInstance.invalidateSize(false);
      });
    }
  }

  function showLocationView(focusTitle) {
    var hash = window.location.hash;
    var view = Object.keys(viewRoutes).find(function (name) { return viewRoutes[name] === hash; }) || "dashboard";
    showView(view, focusTitle);
  }

  document.querySelectorAll("a[data-view]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      var view = link.getAttribute("data-view");
      // Replacing only the fragment preserves an auth query/path and leaves
      // browser Back available for returning to Admin rather than settings tabs.
      window.history.replaceState(window.history.state, "", viewRoutes[view]);
      showView(view, true);
    });
  });
  settingsNavBtn.addEventListener("click", function () {
    settingsSubnav.hidden = !settingsSubnav.hidden;
    settingsNavBtn.setAttribute("aria-expanded", String(!settingsSubnav.hidden));
  });
  document.getElementById("backAdminBtn").addEventListener("click", function (event) {
    event.preventDefault();
    if (document.referrer) window.location.href = document.referrer;
    else window.history.back();
  });
  document.getElementById("serverUrl").addEventListener("input", function () { serverUrlDirty = true; });
  document.getElementById("wifiRefreshBtn").addEventListener("click", loadAndRenderWifiList);
  window.addEventListener("hashchange", function () { showLocationView(true); });
  window.addEventListener("popstate", function () { showLocationView(true); });

  if (wifiSettingsForm) {
    wifiSettingsForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var ssid = document.getElementById("wifiSsid").value.trim();
      var pass = document.getElementById("wifiPass").value;
      var serverEl = document.getElementById("serverUrl");
      var server = serverEl ? serverEl.value.trim() : "";

      if (!ssid && !server) {
        wifiSettingsMsg.textContent = "Vui lòng nhập SSID WiFi hoặc URL backend.";
        return;
      }

      var payload = {
        page: "setting",
        value: {
          ssid: ssid,
          password: pass,
          server: server
        }
      };

      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify(payload));
        wifiSettingsMsg.textContent = ssid
          ? "Đã gửi cấu hình. Thiết bị sẽ khởi động lại..."
          : "Đang lưu cấu hình...";
      } else {
        wifiSettingsMsg.textContent = "Chưa kết nối WebSocket, vui lòng thử lại.";
      }
    });
  }

  // ---------- Boot ----------
  function boot() {
    initChart();
    initChartIntervalControl();
    initMap();
    connectWS();
    pollStatus();
    pollAIStatus();
    showLocationView(false);
    setInterval(pollStatus, 5000);
    setInterval(pollAIStatus, 5000);
    setInterval(checkFreshness, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
