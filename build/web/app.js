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

  // ---- Browser history: Back always goes to the previous view ----
  // Views change in place (no page loads), so without this the browser
  // never records a view change and Back skips the app entirely, leaving
  // the site. Every view change pushes a history entry; Back and forward
  // restore the view from the popped state without pushing again.
  // The tool is stored in the state too, so returning to a chat or
  // training screen keeps the right tool (message labels depend on it).
  var currentView = "picker";

  function goToView(name, opts) {
    opts = opts || {};
    if (name === currentView && !opts.force) return;
    showView(name);
    currentView = name;
    if (!opts.fromHistory) {
      try { history.pushState({ view: name, tool: state.tool || null }, ""); } catch (e) { /* ignore */ }
    }
  }

  window.addEventListener("popstate", function (ev) {
    var st = ev.state || {};
    var view = st.view || "picker";
    // After a page reload the app state is fresh (no session, no loaded
    // scenarios), so a popped chat/training view would be empty — fall
    // back to the hub instead of showing a dead screen.
    if (view === "chat" && !state.sessionId) view = "picker";
    if (view === "start" && (!st.tool || !state.scenarios.length)) view = "picker";
    if (st.tool) state.tool = st.tool;
    goToView(view, { fromHistory: true, force: true });
  });

  // The entry the page loaded on is the hub, so Back from the hub leaves
  // the site as normal. A deep link replaces this entry below and then
  // pushes its training screen on top (see the deep-link block at the
  // end), so Back from a deep-linked training screen lands on the hub.
  try { history.replaceState({ view: "picker", tool: null }, ""); } catch (e) { /* ignore */ }

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

  // ---- Tool picker: two paths per tool ----
  // Red button: clinical decision support NOW — straight into chat, no
  // questions. Train button: scenarios — the start view with the
  // certification/experience form.
  document.querySelectorAll("[data-cdt]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.tool = btn.getAttribute("data-cdt");
      state.selectedScenarioId = null;
      state.sessionId = null;
      state.sessionEnded = false;
      state.aarPending = false;
      state.aarDone = false;
      startSession("", "");
    });
  });

  document.querySelectorAll("[data-train]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.tool = btn.getAttribute("data-train");
      state.selectedScenarioId = null;
      state.sessionId = null;
      state.sessionEnded = false;
      state.aarPending = false;
      state.aarDone = false;
      $("start-heading").textContent = "Train with " + toolName(state.tool);
      $("start-lede").textContent = toolName(state.tool) +
        (state.tool === "foxtwo"
          ? " — critical care en route. Its simulation engine is CCT_EDGE."
          : " — prolonged field care. Its simulation engine is PFC_EDGE.");
      // "STOP, READ THIS FIRST" box: the two guides, renamed and
      // per-tool. They open in a new tab so the student keeps their place.
      $("start-howto-link").href = state.tool === "foxtwo"
        ? "docs/foxtwo-how-to-use.html" : "docs/role1-how-to-use.html";
      $("start-howto-link").textContent = state.tool === "foxtwo"
        ? "How to Use CCT_EDGE Transport Simulator"
        : "How to Use PFC-EDGE Prolonged Care Simulator";
      $("start-student-link").href = state.tool === "foxtwo"
        ? "docs/foxtwo-student-instructions.html" : "docs/role1-student-instructions.html";
      goToView("start");
      loadScenarios();
    });
  });

  $("back-to-picker").addEventListener("click", function () {
    state.tool = null;
    goToView("picker");
  });

  // Header "Guides" link: the Guides section lives inside the picker view,
  // so a plain #guides anchor does nothing when another view is showing
  // (and on a tall screen the jump is invisible anyway). Bring the picker
  // back if needed, then scroll to it and flash it.
  var navGuides = $("nav-guides");
  if (navGuides) {
    navGuides.addEventListener("click", function (ev) {
      ev.preventDefault();
      if ($("view-picker").classList.contains("hidden")) {
        state.tool = null;
        goToView("picker");
      }
      var guides = $("guides");
      requestAnimationFrame(function () {
        guides.scrollIntoView({ behavior: "smooth", block: "start" });
        guides.classList.add("guides-flash");
        setTimeout(function () { guides.classList.remove("guides-flash"); }, 1600);
      });
    });
  }

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
        errorMessage(e) + " The scenario list could not load — try again now.");
      // The form stays usable if the proxy comes back; the start call
      // itself will surface the real error.
      renderScenarios();
    }
  }

  function renderScenarios() {
    var list = $("scenario-list");
    list.innerHTML = "";

    state.scenarios.forEach(function (sc) {
      list.appendChild(scenarioItem(sc.id, sc.title));
    });
    // Training mode: a scenario is always selected (default: the first).
    // Clinical decision support has its own button on the tool picker
    // and is not offered here.
    if (state.selectedScenarioId === null && state.scenarios.length > 0) {
      state.selectedScenarioId = state.scenarios[0].id;
    }
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
    btn.textContent = "Select";
    btn.addEventListener("click", function () {
      state.selectedScenarioId = id;
      updateScenarioSelection();
    });
    li.appendChild(btn);
    return li;
  }

  function updateScenarioSelection() {
    document.querySelectorAll("#scenario-list li").forEach(function (li) {
      var isSelected = li.dataset.scenarioId === String(state.selectedScenarioId);
      li.classList.toggle("selected", isSelected);
      var btn = li.querySelector("button");
      if (btn) btn.textContent = isSelected ? "Selected" : "Select";
    });
    // The start view is training only — "About you" is always collected.
    $("start-btn").textContent = "Start session";
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
      var msg = errorMessage(e, "starting the session");
      showError($("start-error"), msg);
      // The red "use now" button starts from the picker, where the
      // start form (and its error line) is hidden — surface the failure
      // on the status banner as well so it is visible.
      if ($("view-start").classList.contains("hidden")) {
        setStatus(msg, "error");
      }
    } finally {
      btn.disabled = false;
      updateScenarioSelection();
    }
  }

  $("start-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    clearError($("start-error"));

    // Training mode: a scenario must be chosen (the proxy would
    // otherwise read a null scenario as clinical decision support).
    if (!state.selectedScenarioId) {
      showError($("start-error"), "Please choose a scenario.");
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
    goToView("chat");

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
        showAarPanel();
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
  // The full AAR text is already in the chat as the model's reply; the
  // panel is only the approval control, so it shows a short prompt
  // instead of repeating the whole report.
  function showAarPanel() {
    state.aarPending = true;
    $("aar-approval-message").textContent =
      "Your after-action report is ready. Review it in the chat above, " +
      "then approve to generate your downloadable report.";
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
  // Ending a scenario runs the same AAR flow as declaring the exercise
  // complete in chat: the button sends a completion message through the
  // normal chat path, the model presents the AAR, and the approve /
  // download panel follows. No new server endpoint is needed.
  // Clinical decision support has no scenario and no AAR, so there the
  // button just ends the session locally as before.
  $("end-scenario-btn").addEventListener("click", async function () {
    if (state.sessionEnded || !state.sessionId) return;
    // An AAR is already waiting for approval — just stop the chat and
    // leave the panel visible.
    if (state.aarPending) {
      state.sessionEnded = true;
      setChatEnabled(false);
      addMessage("system", "Scenario ended. Your after-action report is ready below.");
      return;
    }
    // No scenario loaded (clinical decision support): no AAR exists.
    if (state.selectedScenarioId === null) {
      state.sessionEnded = true;
      setChatEnabled(false);
      addMessage("system", "Session ended. Start a new session to begin again, " +
        "or use “New session” to choose a different tool or scenario.");
      return;
    }
    var btn = $("end-scenario-btn");
    btn.disabled = true;
    addMessage("system", "You ended the scenario. Requesting the after-action review\u2026");
    show($("typing"));
    clearError($("chat-error"));
    try {
      var data = await apiPost("/api/chat", {
        session_id: state.sessionId,
        message: "I declare the exercise complete. Please present the after-action review."
      });
      hide($("typing"));
      if (data && typeof data.reply === "string" && data.reply) {
        addMessage("model", data.reply, toolName(state.tool));
      }
      if (data && data.aar_pending === true) {
        showAarPanel();
        state.sessionEnded = true;
        setChatEnabled(false);
      } else {
        // The model did not produce an AAR (it may have asked a question
        // instead). Leave the session open so the learner can continue
        // or declare the exercise complete in chat.
        addMessage("system", "The after-action review was not ready yet. You can " +
          "continue the scenario, or declare the exercise complete in chat.");
        btn.disabled = false;
      }
    } catch (e) {
      hide($("typing"));
      showError($("chat-error"), errorMessage(e, "ending the scenario"));
      btn.disabled = false;
    }
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
    goToView("picker");
    checkHealth();
  });

  // ---- Init ----
  if (!PROXY_URL) {
    setStatus("No service address is configured. The owner needs to set " +
      "proxyUrl in config.js to the deployed proxy address.", "error");
  } else {
    checkHealth();
  }

  // ---- Deep link: ?tool=role1 or ?tool=foxtwo opens that tool's
  // training screen (scenario picker). ----
  try {
    var deepTool = new URLSearchParams(window.location.search).get("tool");
    if (deepTool === "role1" || deepTool === "foxtwo") {
      var deepBtn = document.querySelector('[data-train="' + deepTool + '"]');
      if (deepBtn) deepBtn.click();
    }
  } catch (e) { /* ignore malformed URLs */ }
})();
