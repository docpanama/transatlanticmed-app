/* Role1 / FoxTwo — front-end logic.
 *
 * The browser talks ONLY to the proxy (see config.js). It never sees an
 * API key and never fetches scenario content — GET /api/scenarios returns
 * metadata only (id, title). All model / AAR work
 * happens server-side on the proxy.
 *
 * Proxy API contract:
 *   GET  {proxy}/health
 *   GET  {proxy}/api/scenarios?tool=role1|foxtwo
 *   POST {proxy}/api/session  {tool, scenario_id, certification_level, experience}
 *   POST {proxy}/api/chat     {session_id, message}          -> {reply, aar_pending}
 *   POST {proxy}/api/aar      {session_id}                   -> {learner_id, download_url}
 * download_url is a path on the AAR service (e.g. /download/XXXX.docx);
 * prefix it with https://fox-two-aar.onrender.com
 */
(function () {
  "use strict";

  var AAR_BASE_URL = "https://fox-two-aar.onrender.com";

  // The proxy URL comes ONLY from config.js. If config.js failed to load,
  // fail visibly instead of guessing a URL.
  var PROXY_URL = (window.APP_CONFIG && window.APP_CONFIG.proxyUrl) || "";
  PROXY_URL = PROXY_URL.replace(/\/+$/, ""); // strip trailing slash(es)

  // ---- State ----
  var state = {
    tool: null,            // "role1" | "foxtwo"
    scenarios: [],
    selectedScenarioId: null, // null = clinical decision support, no scenario
    sessionId: null,
    sessionEnded: false,
    aarPending: false,
    aarDone: false
  };

  // ---- DOM helpers ----
  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }
  function setStatus(text, kind) {
    var el = $("status");
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }
  function showError(el, message) {
    el.textContent = message;
    show(el);
  }
  function clearError(el) {
    el.textContent = "";
    hide(el);
  }

  // ---- Error handling: plain language, never a stack trace ----
  // Returns a user-facing message for a failed fetch / HTTP response.
  function errorMessage(err, context) {
    // Network failure: proxy down, wrong URL, offline, CORS blocked.
    if (err && (err.name === "TypeError" || err.message === "Failed to fetch")) {
      return "The service could not be reached. Check your connection, and that " +
        "the service address in config.js is correct. Nothing was sent.";
    }
    var msg = (err && err.message) || "";
    if (/api key|not configured|no api key/i.test(msg)) {
      return "The service is not set up yet — no API key is configured on the server. " +
        "Please try again later or contact the owner.";
    }
    if (/session (expired|not found|invalid)/i.test(msg) || err && err.status === 401 || err && err.status === 410) {
      return "Your session has expired. Please start a new session.";
    }
    if (err && err.status === 429) {
      return "The service is busy right now. Please wait a moment and try again.";
    }
    if (err && err.status) {
      return "The service returned an error (" + err.status + "). Please try again. " +
        "If it keeps happening, contact the owner.";
    }
    return "Something went wrong" + (context ? " (" + context + ")" : "") +
      ". Please try again.";
  }

  async function apiFetch(path, options) {
    if (!PROXY_URL) {
      throw new Error("No proxy address is configured (config.js).");
    }
    var res;
    try {
      res = await fetch(PROXY_URL + path, options);
    } catch (e) {
      // Network-level failure (proxy down / unreachable).
      var netErr = new Error("Failed to fetch");
      netErr.name = "TypeError";
      throw netErr;
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }
    if (!res.ok) {
      var err = new Error(
        (data && (data.error || data.message)) || ("HTTP " + res.status)
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function apiGet(path) {
    return apiFetch(path, { method: "GET" });
  }
  function apiPost(path, body) {
    return apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  // ---- Views ----
  function showView(name) {
    ["picker", "start", "chat"].forEach(function (v) {
      var el = $("view-" + v);
      if (v === name) show(el); else hide(el);
    });
    window.scrollTo(0, 0);
  }

  function toolName(tool) {
    return tool === "foxtwo" ? "FoxTwo" : "Role1";
  }
  function simName(tool) {
    return tool === "foxtwo" ? "CCT_EDGE" : "PFC_EDGE";
  }

  // ---- Health check (on load) ----
  async function checkHealth() {
    if (!PROXY_URL) {
      setStatus("No service address is configured. The owner needs to set " +
        "proxyUrl in config.js to the deployed proxy address.", "error");
      return false;
    }
    try {
      var data = await apiGet("/health");
      if (data && data.status === "ok") {
        setStatus("Connected to the service.", "ok");
        return true;
      }
      setStatus("The service answered, but not as expected. Scenarios may not load.", "warn");
      return true;
    } catch (e) {
      setStatus("Service not reachable at " + PROXY_URL +
        ". You can still read the guides below; starting a session needs the service.", "error");
      return false;
    }
  }

  // ---- Tool picker ----
  document.querySelectorAll("[data-tool]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.tool = btn.getAttribute("data-tool");
      state.selectedScenarioId = null;
      state.sessionId = null;
      state.sessionEnded = false;
      state.aarPending = false;
      state.aarDone = false;
      $("start-heading").textContent = "Start a " + toolName(state.tool) + " session";
      $("start-lede").textContent = toolName(state.tool) +
        (state.tool === "foxtwo"
          ? " — critical care en route. Its simulation engine is CCT_EDGE."
          : " — prolonged field care. Its simulation engine is PFC_EDGE.");
      showView("start");
      loadScenarios();
    });
  });

  $("back-to-picker").addEventListener("click", function () {
    state.tool = null;
    showView("picker");
  });

  // ---- Scenario picker ----
  async function loadScenarios() {
    var list = $("scenario-list");
    var loading = $("scenario-loading");
    list.innerHTML = "";
    clearError($("scenario-error"));
    show(loading);
    loading.textContent = "Loading scenarios\u2026";
    try {
      var scenarios = await apiGet("/api/scenarios?tool=" + encodeURIComponent(state.tool));
      state.scenarios = Array.isArray(scenarios) ? scenarios : [];
      hide(loading);
      renderScenarios();
    } catch (e) {
      hide(loading);
      showError($("scenario-error"),
        errorMessage(e) + " You can still start a clinical decision support session " +
        "without a scenario once the service is back — or try again now.");
      // Still offer the no-scenario option so the form is usable if the
      // proxy comes back; the start call itself will surface the real error.
      renderScenarios();
    }
  }

  function renderScenarios() {
    var list = $("scenario-list");
    list.innerHTML = "";

    // No-scenario option: clinical decision support mode (no sim).
    // Choosing it starts a session immediately — no certification or
    // experience questions; the questioner needs support now.
    list.appendChild(scenarioItem(null, "Clinical decision support — no scenario"));

    state.scenarios.forEach(function (sc) {
      list.appendChild(scenarioItem(sc.id, sc.title));
    });
    updateScenarioSelection();
  }

  // Scenario names are the difficulty only (Easy / Hard / Peds) — no
  // description is shown, so nothing gives away the diagnosis or
  // complications before the learner has examined the patient.
  function scenarioItem(id, title) {
    var li = document.createElement("li");
    li.dataset.scenarioId = id === null ? "" : String(id);
    var titleEl = document.createElement("span");
    titleEl.className = "sc-title";
    titleEl.textContent = title;
    li.appendChild(titleEl);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary small";
    btn.textContent = id === null ? "Start now" : "Select";
    btn.addEventListener("click", function () {
      if (id === null) {
        // Clinical decision support: straight into the tool, no form.
        startSession("", "");
        return;
      }
      state.selectedScenarioId = id;
      updateScenarioSelection();
    });
    li.appendChild(btn);
    return li;
  }

  function updateScenarioSelection() {
    var isCdt = state.selectedScenarioId === null;
    document.querySelectorAll("#scenario-list li").forEach(function (li) {
      var isSelected = li.dataset.scenarioId === (isCdt ? "" : String(state.selectedScenarioId));
      li.classList.toggle("selected", isSelected);
      var btn = li.querySelector("button");
      if (!btn) return;
      // The no-scenario card always offers "Start now"; scenario cards
      // show Selected / Select.
      if (li.dataset.scenarioId === "") btn.textContent = "Start now";
      else btn.textContent = isSelected ? "Selected" : "Select";
    });
    // "About you" (certification + experience) is collected for scenarios
    // only — it is hidden for clinical decision support, and the Start
    // button becomes a direct start.
    var aboutYou = $("about-you");
    if (aboutYou) aboutYou.classList.toggle("hidden", isCdt);
    $("start-btn").textContent = isCdt ? "Start now" : "Start session";
  }

  // ---- Start form ----
  var certSelect = $("cert-level");
  certSelect.addEventListener("change", function () {
    if (certSelect.value === "Other") show($("cert-other-wrap"));
    else hide($("cert-other-wrap"));
  });

  // Start a session. cert/experience are required for scenarios (the AAR
  // needs them) and empty for clinical decision support — the proxy
  // accepts empty values and CDT mode has no AAR.
  async function startSession(cert, experience) {
    clearError($("start-error"));
    var btn = $("start-btn");
    btn.disabled = true;
    btn.textContent = "Starting\u2026";
    try {
      // scenario_id null = clinical decision support mode, no simulation.
      // The proxy treats a null scenario_id as CDT mode.
      var data = await apiPost("/api/session", {
        tool: state.tool,
        scenario_id: state.selectedScenarioId,
        certification_level: cert,
        experience: experience
      });
      if (!data || !data.session_id) {
        throw new Error("The service did not return a session. Please try again.");
      }
      state.sessionId = data.session_id;
      state.sessionEnded = false;
      state.aarPending = false;
      state.aarDone = false;
      openChat(data);
    } catch (e) {
      showError($("start-error"), errorMessage(e, "starting the session"));
    } finally {
      btn.disabled = false;
      updateScenarioSelection();
    }
  }

  $("start-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    clearError($("start-error"));

    // Clinical decision support: no questions, straight in.
    if (state.selectedScenarioId === null) {
      startSession("", "");
      return;
    }

    var cert = certSelect.value;
    if (cert === "Other") {
      cert = $("cert-other").value.trim();
      if (!cert) {
        showError($("start-error"), "Please type your certification level.");
        return;
      }
    }
    var experience = $("experience").value;
    if (!cert) {
      showError($("start-error"), "Please choose your certification level.");
      return;
    }
    if (!experience) {
      showError($("start-error"), "Please choose your experience level.");
      return;
    }
    startSession(cert, experience);
  });

  // ---- Chat ----
  function openChat(sessionData) {
    $("chat-title").textContent = toolName(state.tool) + " session";
    var scenario = state.scenarios.find(function (s) { return String(s.id) === String(state.selectedScenarioId); });
    $("session-meta").textContent = state.selectedScenarioId === null
      ? "Clinical decision support — no scenario"
      : "Scenario: " + (scenario ? scenario.title : state.selectedScenarioId);
    $("chat-guide-link").href = state.tool === "foxtwo"
      ? "docs/foxtwo-how-to-use.html" : "docs/role1-how-to-use.html";
    $("messages").innerHTML = "";
    hide($("aar-panel"));
    hide($("aar-complete"));
    clearError($("chat-error"));
    setChatEnabled(true);
    showView("chat");

    // Vignette + greeting come from the proxy. The vignette is plain text
    // the proxy is allowed to send; scenario JSON itself never reaches us.
    if (sessionData.vignette) addMessage("model", sessionData.vignette, "Scenario");
    if (sessionData.greeting) addMessage("model", sessionData.greeting, toolName(state.tool));
    if (!sessionData.vignette && !sessionData.greeting) {
      addMessage("system", "Session started. Describe the situation or ask your question.");
    }
  }

  // All message text is added via textContent (never innerHTML), so model
  // output is rendered as plain text. CSS white-space: pre-wrap preserves
  // its line breaks.
  function addMessage(role, text, who) {
    var li = document.createElement("li");
    li.className = "message " + role;
    var whoEl = document.createElement("span");
    whoEl.className = "who";
    whoEl.textContent = who || (role === "user" ? "You" : toolName(state.tool));
    li.appendChild(whoEl);
    var body = document.createElement("span");
    body.textContent = text;
    li.appendChild(body);
    $("messages").appendChild(li);
    li.scrollIntoView({ block: "nearest" });
    return li;
  }

  function setChatEnabled(enabled) {
    $("chat-input").disabled = !enabled;
    $("send-btn").disabled = !enabled;
    $("end-scenario-btn").disabled = !enabled;
  }

  $("chat-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (state.sessionEnded || state.aarDone || !state.sessionId) return;
    var input = $("chat-input");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    clearError($("chat-error"));
    addMessage("user", text, "You");
    show($("typing"));
    $("send-btn").disabled = true;
    try {
      var data = await apiPost("/api/chat", {
        session_id: state.sessionId,
        message: text
      });
      hide($("typing"));
      if (data && typeof data.reply === "string" && data.reply) {
        addMessage("model", data.reply, toolName(state.tool));
      } else {
        addMessage("system", "No reply was returned. Please try sending your message again.");
      }
      // AAR flow: the proxy signals the scenario is ready to close.
      if (data && data.aar_pending === true) {
        showAarPanel(data.reply || "");
      }
    } catch (e) {
      hide($("typing"));
      var msg = errorMessage(e, "sending your message");
      showError($("chat-error"), msg);
      if (/session has expired/i.test(msg)) {
        state.sessionEnded = true;
        setChatEnabled(false);
      }
    } finally {
      if (!state.sessionEnded && !state.aarDone) $("send-btn").disabled = false;
    }
  });

  // ---- AAR flow ----
  // The approval message is the proxy/model reply, shown exactly as returned.
  function showAarPanel(approvalMessage) {
    state.aarPending = true;
    $("aar-approval-message").textContent = approvalMessage;
    show($("aar-panel"));
    $("aar-panel").scrollIntoView({ block: "nearest" });
  }

  $("aar-approve-btn").addEventListener("click", async function () {
    var btn = $("aar-approve-btn");
    btn.disabled = true;
    btn.textContent = "Generating AAR\u2026";
    clearError($("chat-error"));
    try {
      var data = await apiPost("/api/aar", { session_id: state.sessionId });
      if (!data || !data.learner_id || !data.download_url) {
        throw new Error("The service did not return an after-action report. Please try again.");
      }
      state.aarDone = true;
      state.aarPending = false;
      hide($("aar-panel"));
      $("aar-learner-id").textContent = data.learner_id;
      // download_url is a path on the AAR service; prefix with its base URL.
      var link = $("aar-download-link");
      link.href = data.download_url.startsWith("http")
        ? data.download_url
        : AAR_BASE_URL + data.download_url;
      show($("aar-complete"));
      addMessage("system", "Scenario complete.");
      setChatEnabled(false);
      $("aar-complete").scrollIntoView({ block: "nearest" });
    } catch (e) {
      showError($("chat-error"), errorMessage(e, "generating the after-action report"));
      btn.disabled = false;
      btn.textContent = "Approve & download AAR";
    }
  });

  // ---- End scenario / New session ----
  $("end-scenario-btn").addEventListener("click", function () {
    if (state.sessionEnded) return;
    state.sessionEnded = true;
    setChatEnabled(false);
    hide($("aar-panel"));
    addMessage("system", "Scenario ended. Start a new session to begin again, " +
      "or use “New session” to choose a different tool or scenario.");
  });

  $("new-session-btn").addEventListener("click", function () {
    state.sessionId = null;
    state.selectedScenarioId = null;
    state.sessionEnded = false;
    state.aarPending = false;
    state.aarDone = false;
    $("messages").innerHTML = "";
    $("chat-input").value = "";
    hide($("aar-panel"));
    hide($("aar-complete"));
    clearError($("chat-error"));
    showView("picker");
    checkHealth();
  });

  // ---- Init ----
  if (!PROXY_URL) {
    setStatus("No service address is configured. The owner needs to set " +
      "proxyUrl in config.js to the deployed proxy address.", "error");
  } else {
    checkHealth();
  }

  // ---- Deep link: ?tool=role1 or ?tool=foxtwo pre-selects the tool. ----
  try {
    var deepTool = new URLSearchParams(window.location.search).get("tool");
    if (deepTool === "role1" || deepTool === "foxtwo") {
      var deepBtn = document.querySelector('[data-tool="' + deepTool + '"]');
      if (deepBtn) deepBtn.click();
    }
  } catch (e) { /* ignore malformed URLs */ }
})();
