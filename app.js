(async () => {
  "use strict";

  const LEGACY_STORAGE_KEY = "questboard.family.v1";
  const CACHE_STORAGE_KEY = "questboard.shared-cache.v1";
  const DEFAULT_TIMEZONE = "Europe/London";
  const SYNC_INTERVAL_MS = 4_000;
  const ROUTES = new Set(["quests", "leaderboard", "parent"]);
  const FREQUENCY_ORDER = ["daily", "weekly", "monthly"];
  const FREQUENCIES = {
    daily: {
      label: "Daily quests",
      singular: "daily",
      icon: "☀️"
    },
    weekly: {
      label: "Weekly quests",
      singular: "weekly",
      icon: "📅"
    },
    monthly: {
      label: "Monthly quests",
      singular: "monthly",
      icon: "🌙"
    }
  };

  const ui = {
    route: ROUTES.has(location.hash.slice(1)) ? location.hash.slice(1) : "quests",
    leaderboardScope: "week",
    questFrequency: "daily",
    parentSection: "players",
    adminUserId: null,
    editingTaskId: null,
    editingRewardId: null,
    lastPeriodSignature: "",
    lastCountdownSignature: "",
    pendingRoute: null
  };

  let serverRevision = 0;
  let serverReachable = false;
  let hasUnsyncedChanges = false;
  let saveFailureNotified = false;
  let localMutationVersion = 0;
  let pendingSaves = 0;
  let savePromise = null;
  let lastSyncedState = null;
  let currentSessionUser = null;
  let elements = null;

  let state = await loadState();
  ensureValidSelection();
  ui.adminUserId = state.users.find((user) => user.role === "player")?.id || state.users[0]?.id || null;

  elements = {
    activeUserSelect: document.querySelector("#activeUserSelect"),
    activeUserAvatar: document.querySelector("#activeUserAvatar"),
    nav: document.querySelector(".primary-nav"),
    main: document.querySelector("#appMain"),
    questsView: document.querySelector("#questsView"),
    leaderboardView: document.querySelector("#leaderboardView"),
    parentView: document.querySelector("#parentView"),
    timezoneFooter: document.querySelector("#timezoneFooter"),
    syncFooter: document.querySelector("#syncFooter"),
    userDialog: document.querySelector("#userDialog"),
    userForm: document.querySelector("#userForm"),
    userDialogTitle: document.querySelector("#userDialogTitle"),
    userIdField: document.querySelector("#userIdField"),
    userNameField: document.querySelector("#userNameField"),
    userAvatarField: document.querySelector("#userAvatarField"),
    userColourField: document.querySelector("#userColourField"),
    userPinField: document.querySelector("#userPinField"),
    userAdminField: document.querySelector("#userAdminField"),
    userPinLabel: document.querySelector("#userPinLabel"),
    userPinHint: document.querySelector("#userPinHint"),
    switchDialog: document.querySelector("#switchDialog"),
    switchForm: document.querySelector("#switchForm"),
    switchDialogTitle: document.querySelector("#switchDialogTitle"),
    switchUserSelect: document.querySelector("#switchUserSelect"),
    switchProfileSummary: document.querySelector("#switchProfileSummary"),
    switchPinField: document.querySelector("#switchPinField"),
    switchError: document.querySelector("#switchError"),
    switchCancelButton: document.querySelector("#switchCancelButton"),
    switchCloseButton: document.querySelector("#switchCloseButton"),
    lockSessionButton: document.querySelector("#lockSessionButton"),
    toastRegion: document.querySelector("#toastRegion"),
    confettiLayer: document.querySelector("#confettiLayer")
  };

  bindEvents();
  renderAll();
  setSyncStatus(serverReachable ? "Shared data connected" : "Using offline cache", !serverReachable);
  ui.lastPeriodSignature = currentPeriodSignature();
  ui.lastCountdownSignature = currentCountdownSignature();
  if (!currentSessionUser) requestAnimationFrame(() => openSwitchDialog());

  window.setInterval(() => {
    const periodSignature = currentPeriodSignature();
    const countdownSignature = currentCountdownSignature();
    if (periodSignature !== ui.lastPeriodSignature) {
      ui.lastPeriodSignature = periodSignature;
      ui.lastCountdownSignature = countdownSignature;
      renderAll();
      showToast("New quest period", "Your task availability and scores have refreshed.", "↻");
    } else if (countdownSignature !== ui.lastCountdownSignature) {
      ui.lastCountdownSignature = countdownSignature;
      renderAll();
    }
  }, 30_000);

  window.setInterval(() => {
    void syncFromServer();
  }, SYNC_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      renderAll();
      void syncFromServer({ force: true });
    }
  });

  function bindEvents() {
    elements.nav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-route]");
      if (!button) return;
      if (button.dataset.route === "parent" && !isAdminSession()) {
        ui.pendingRoute = "parent";
        showToast("Admin PIN required", "Switch to the admin profile to open the parent area.", "🔒");
        openSwitchDialog(state.users.find((user) => user.role === "admin")?.id || null);
        return;
      }
      setRoute(button.dataset.route);
    });

    window.addEventListener("hashchange", () => {
      const route = location.hash.slice(1);
      if (!ROUTES.has(route)) return;
      if (route === "parent" && !isAdminSession()) {
        ui.pendingRoute = "parent";
        history.replaceState(null, "", "#quests");
        ui.route = "quests";
        renderRoute();
        openSwitchDialog(state.users.find((user) => user.role === "admin")?.id || null);
        return;
      }
      ui.route = route;
      renderRoute();
    });

    elements.activeUserSelect.addEventListener("change", () => {
      const userId = elements.activeUserSelect.value;
      renderProfileControl();
      if (!state.users.some((user) => user.id === userId)) return;
      if (currentSessionUser?.id === userId) return;
      openSwitchDialog(userId);
    });

    elements.lockSessionButton.addEventListener("click", () => {
      void lockSession();
    });

    elements.questsView.addEventListener("click", (event) => {
      const frequencyButton = event.target.closest("[data-quest-frequency]");
      if (frequencyButton) {
        ui.questFrequency = frequencyButton.dataset.questFrequency;
        renderQuests();
        return;
      }

      const completeButton = event.target.closest("[data-complete-task]");
      if (!completeButton) return;
      completeTask(completeButton.dataset.completeTask, completeButton);
    });

    elements.leaderboardView.addEventListener("click", (event) => {
      const scopeButton = event.target.closest("[data-leaderboard-scope]");
      if (!scopeButton) return;
      ui.leaderboardScope = scopeButton.dataset.leaderboardScope;
      renderLeaderboard();
    });

    elements.parentView.addEventListener("click", handleParentClick);
    elements.parentView.addEventListener("change", handleParentChange);
    elements.parentView.addEventListener("submit", handleParentSubmit);

    elements.userForm.addEventListener("submit", handleUserSubmit);
    elements.userDialog.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => elements.userDialog.close());
    });

    elements.switchForm.addEventListener("submit", handleSwitchSubmit);
    elements.switchUserSelect.addEventListener("change", renderSwitchProfileSummary);
    elements.switchDialog.querySelectorAll("[data-close-switch]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!currentSessionUser) return;
        elements.switchDialog.close();
        renderProfileControl();
      });
    });
  }

  function isAdminSession() {
    return currentSessionUser?.role === "admin";
  }

  function openSwitchDialog(userId = null) {
    const target = state.users.find((user) => user.id === userId)
      || state.users.find((user) => user.role === "player")
      || state.users[0];
    if (!target) return;
    elements.switchUserSelect.innerHTML = state.users
      .map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}${user.role === "admin" ? " · Admin" : ""}</option>`)
      .join("");
    elements.switchUserSelect.value = target.id;
    elements.switchPinField.value = "";
    elements.switchError.hidden = true;
    elements.switchError.textContent = "";
    elements.switchCancelButton.hidden = !currentSessionUser;
    elements.switchCloseButton.hidden = !currentSessionUser;
    renderSwitchProfileSummary();
    if (!elements.switchDialog.open) elements.switchDialog.showModal();
    requestAnimationFrame(() => elements.switchPinField.focus());
  }

  function renderSwitchProfileSummary() {
    const user = state.users.find((candidate) => candidate.id === elements.switchUserSelect.value);
    if (!user) return;
    elements.switchDialogTitle.textContent = `Unlock ${user.name}`;
    elements.switchProfileSummary.innerHTML = `
      <span class="switch-profile-avatar" style="--player-colour: ${safeColour(user.colour)}" aria-hidden="true">${escapeHtml(user.avatar)}</span>
      <div><strong>${escapeHtml(user.name)}</strong><span>${user.role === "admin" ? "Administrator" : "Player account"}</span></div>`;
  }

  async function handleSwitchSubmit(event) {
    event.preventDefault();
    const userId = elements.switchUserSelect.value;
    const pin = elements.switchPinField.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      elements.switchError.textContent = "Enter a PIN containing 4 to 8 digits.";
      elements.switchError.hidden = false;
      return;
    }

    const submitButton = elements.switchForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    elements.switchError.hidden = true;
    try {
      const response = await fetch("/api/auth/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, pin })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Server returned ${response.status}`);
      applyServerPayload(payload);
      elements.switchDialog.close();
      showToast("Profile unlocked", `Playing as ${currentSessionUser?.name || "selected player"}.`, currentSessionUser?.avatar || "✓");
      if (ui.pendingRoute === "parent" && isAdminSession()) {
        ui.pendingRoute = null;
        setRoute("parent");
      } else {
        ui.pendingRoute = null;
      }
    } catch (error) {
      elements.switchError.textContent = error instanceof Error ? error.message : "The profile could not be unlocked.";
      elements.switchError.hidden = false;
      elements.switchPinField.select();
    } finally {
      submitButton.disabled = false;
    }
  }

  async function lockSession() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The local profile is still locked even if the server is temporarily unavailable.
    }
    currentSessionUser = null;
    state.selectedUserId = null;
    ui.route = "quests";
    ui.pendingRoute = null;
    if (location.hash !== "#quests") history.replaceState(null, "", "#quests");
    renderAll();
    openSwitchDialog();
  }

  function applyServerPayload(payload) {
    if (Object.prototype.hasOwnProperty.call(payload, "currentUser")) {
      currentSessionUser = payload.currentUser || null;
    }
    const selectedUserId = currentSessionUser?.id || null;
    state = normaliseState({ ...(payload.state || payload), selectedUserId });
    serverRevision = Number(payload.revision) || serverRevision;
    serverReachable = true;
    saveFailureNotified = false;
    hasUnsyncedChanges = false;
    lastSyncedState = sharedStateSnapshot(state);
    ensureValidSelection();
    if (!state.users.some((user) => user.id === ui.adminUserId)) {
      ui.adminUserId = state.users.find((user) => user.role === "player")?.id || state.users[0]?.id || null;
    }
    writeLocalCache(state);
    renderAll();
    setSyncStatus("Shared data connected");
  }

  function setRoute(route) {
    if (!ROUTES.has(route)) return;
    ui.route = route;
    if (location.hash !== `#${route}`) {
      history.pushState(null, "", `#${route}`);
    }
    renderRoute();
    elements.main.focus({ preventScroll: true });
  }

  function renderAll() {
    ensureValidSelection();
    renderProfileControl();
    renderQuests();
    renderLeaderboard();
    renderParent();
    renderRoute();
    elements.timezoneFooter.textContent = `Resets use ${state.timezone} time`;
  }

  function renderRoute() {
    if (ui.route === "parent" && !isAdminSession()) {
      ui.route = "quests";
      if (location.hash === "#parent") history.replaceState(null, "", "#quests");
    }
    const viewByRoute = {
      quests: elements.questsView,
      leaderboard: elements.leaderboardView,
      parent: elements.parentView
    };

    Object.entries(viewByRoute).forEach(([route, view]) => {
      view.hidden = route !== ui.route;
    });

    elements.nav.querySelectorAll("[data-route]").forEach((button) => {
      const isActive = button.dataset.route === ui.route;
      button.classList.toggle("is-active", isActive);
      if (isActive) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function renderProfileControl() {
    const selectedUser = getSelectedUser();
    const placeholder = `<option value=""${selectedUser ? "" : " selected"}>Choose profile</option>`;
    elements.activeUserSelect.innerHTML = placeholder + state.users
      .map((user) => `<option value="${escapeHtml(user.id)}"${user.id === state.selectedUserId ? " selected" : ""}>${escapeHtml(user.name)}${user.role === "admin" ? " · Admin" : ""}</option>`)
      .join("");
    elements.activeUserAvatar.textContent = selectedUser?.avatar || "🔒";
    elements.activeUserAvatar.style.background = selectedUser
      ? `${safeColour(selectedUser.colour)}1f`
      : "var(--brand-soft)";
    elements.lockSessionButton.hidden = !currentSessionUser;
  }

  function renderQuests() {
    const user = getSelectedUser();
    if (!user) {
      elements.questsView.innerHTML = `
        <div class="locked-state">
          <span class="locked-state-icon" aria-hidden="true">🔒</span>
          <h1 id="questsHeading">Choose a protected profile</h1>
          <p>Enter a profile PIN to view and complete that user’s quests.</p>
          <button type="button" class="button primary" data-open-switch>Choose profile</button>
        </div>`;
      elements.questsView.querySelector("[data-open-switch]")?.addEventListener("click", () => openSwitchDialog());
      return;
    }

    const activeTasks = state.tasks.filter((task) => task.userId === user.id && task.active !== false);
    const completedCount = activeTasks.filter((task) => isTaskComplete(task)).length;
    const allTimeXp = scoreForUser(user.id, "all");
    const streak = streakForUser(user.id);
    const streakStatus = dailyStreakStatusForUser(user.id);
    const rewardsSection = renderRewardsForUser(user, allTimeXp);
    const level = Math.floor(allTimeXp / 100) + 1;
    const levelProgress = allTimeXp % 100;
    const xpToNextLevel = 100 - levelProgress;
    const greeting = localGreeting();
    const dateLabel = formatDate(new Date(), {
      weekday: "long",
      day: "numeric",
      month: "long"
    });

    if (!FREQUENCY_ORDER.includes(ui.questFrequency)) ui.questFrequency = "daily";

    const frequencyCounts = Object.fromEntries(FREQUENCY_ORDER.map((frequency) => {
      const tasks = activeTasks.filter((task) => task.frequency === frequency);
      return [frequency, {
        total: tasks.length,
        completed: tasks.filter((task) => isTaskComplete(task)).length
      }];
    }));

    const questTabs = FREQUENCY_ORDER.map((frequency) => {
      const meta = FREQUENCIES[frequency];
      const counts = frequencyCounts[frequency];
      const title = `${meta.singular.charAt(0).toUpperCase()}${meta.singular.slice(1)}`;
      const active = ui.questFrequency === frequency;
      return `<button type="button" role="tab" data-quest-frequency="${frequency}" class="${active ? "is-active" : ""}" aria-selected="${active}">${meta.icon}${title} (${counts.completed}/${counts.total})</button>`;
    }).join("");

    const selectedMeta = FREQUENCIES[ui.questFrequency];
    const selectedTasks = activeTasks
      .filter((task) => task.frequency === ui.questFrequency)
      .sort((a, b) => a.title.localeCompare(b.title));
    const selectedDone = frequencyCounts[ui.questFrequency].completed;
    const taskRows = selectedTasks.length
      ? selectedTasks.map((task) => renderTaskRow(task)).join("")
      : `<div class="empty-state"><strong>No ${selectedMeta.singular} quests</strong>A parent can add one in the parent area.</div>`;

    const taskGroup = `
      <article class="task-group" role="tabpanel">
        <header class="task-group-header">
          <div class="frequency-title">
            <span class="frequency-icon" aria-hidden="true">${selectedMeta.icon}</span>
            <div>
              <h3>${selectedMeta.label}</h3>
              <p>${resetCountdownLabel(ui.questFrequency)}</p>
            </div>
          </div>
          <span class="group-count">${selectedDone}/${selectedTasks.length} done</span>
        </header>
        <div class="task-list">${taskRows}</div>
      </article>`;

    elements.questsView.innerHTML = `
      <article class="hero-card" style="--profile-colour: ${safeColour(user.colour)}">
        <div class="hero-main">
          <div class="hero-player">
            <div class="hero-avatar" aria-hidden="true">${escapeHtml(user.avatar)}</div>
            <div>
              <p class="eyebrow">${escapeHtml(dateLabel)}</p>
              <h1 id="questsHeading">${greeting}, ${escapeHtml(user.name)}!</h1>
              <p>${completedCount === activeTasks.length && activeTasks.length > 0 ? "Every current quest is complete — brilliant work." : "Pick a quest, earn XP and climb the family leaderboard."}</p>
            </div>
          </div>

          <div class="score-strip" aria-label="Current XP totals and streak">
            <div class="score-tile"><span>Today</span><strong>${formatNumber(scoreForUser(user.id, "day"))} XP</strong></div>
            <div class="score-tile"><span>This week</span><strong>${formatNumber(scoreForUser(user.id, "week"))} XP</strong></div>
            <div class="score-tile"><span>This month</span><strong>${formatNumber(scoreForUser(user.id, "month"))} XP</strong></div>
            <div class="score-tile streak-tile streak-${streakStatus.state}">
              <span>Daily streak</span>
              <strong><span class="streak-flame" aria-hidden="true">🔥</span> ${formatNumber(streak)} day${streak === 1 ? "" : "s"}</strong>
              <small class="streak-status">${escapeHtml(streakStatus.message)}</small>
            </div>
          </div>
        </div>

        <aside class="hero-progress" aria-label="Level progress">
          <div class="level-line"><span>Level ${level}</span><span>${formatNumber(allTimeXp)} total XP</span></div>
          <div class="progress-track"><div class="progress-fill" style="--progress: ${levelProgress}%"></div></div>
          <p>${xpToNextLevel} XP until Level ${level + 1}. Every completed chore moves you forward.</p>
        </aside>
      </article>

      ${rewardsSection}

      <div class="section-heading">
        <div>
          <h2>Available quests</h2>
          <p>Completed quests automatically unlock again at their next reset.</p>
        </div>
        <span class="completion-summary">${completedCount} of ${activeTasks.length} complete</span>
      </div>

      <div class="segmented-control quest-tabs" role="tablist" aria-label="Quest frequency">
        ${questTabs}
      </div>

      <div class="task-groups">${taskGroup}</div>
    `;
  }

  function renderTaskRow(task) {
    const complete = isTaskComplete(task);
    const description = task.description?.trim() || `Complete this ${FREQUENCIES[task.frequency].singular} quest`;
    return `
      <div class="task-item${complete ? " is-complete" : ""}">
        <div class="task-copy">
          <span class="task-check" aria-hidden="true">✓</span>
          <div>
            <h4>${escapeHtml(task.title)}</h4>
            <p>${escapeHtml(description)}</p>
          </div>
        </div>
        <div class="task-action">
          <span class="xp-badge">+${formatNumber(task.xp)} XP</span>
          <button
            type="button"
            class="complete-button"
            data-complete-task="${escapeHtml(task.id)}"
            ${complete ? "disabled" : ""}
            aria-label="${complete ? "Completed" : `Complete ${escapeHtml(task.title)} for ${task.xp} XP`}">
            ${complete ? "Done ✓" : "Complete"}
          </button>
        </div>
      </div>
    `;
  }

  function renderRewardsForUser(user, lifetimeXp) {
    const rewards = state.rewards
      .filter((reward) => reward.active !== false)
      .sort((a, b) => a.threshold - b.threshold || a.title.localeCompare(b.title));
    const unlocked = rewards.filter((reward) => lifetimeXp >= reward.threshold).length;
    const cards = rewards.length
      ? rewards.map((reward) => {
          const isUnlocked = lifetimeXp >= reward.threshold;
          const remaining = Math.max(0, reward.threshold - lifetimeXp);
          return `
            <article class="reward-card ${isUnlocked ? "is-unlocked" : "is-locked"}">
              <div class="reward-icon" aria-hidden="true">${escapeHtml(reward.icon)}</div>
              <div class="reward-copy">
                <span class="reward-state">${isUnlocked ? "Unlocked" : `${formatNumber(remaining)} XP to go`}</span>
                <h3>${escapeHtml(reward.title)}</h3>
                ${reward.description ? `<p>${escapeHtml(reward.description)}</p>` : ""}
              </div>
              <strong class="reward-threshold">${formatNumber(reward.threshold)} XP</strong>
            </article>`;
        }).join("")
      : `<div class="empty-state reward-empty"><strong>No rewards yet</strong>The admin can add XP rewards in the Parent area.</div>`;

    return `
      <section class="rewards-section" aria-labelledby="rewardsHeading">
        <div class="section-heading">
          <div>
            <h2 id="rewardsHeading">Rewards</h2>
            <p>Lifetime XP unlocks rewards for ${escapeHtml(user.name)}.</p>
          </div>
          <span class="completion-summary">${unlocked} of ${rewards.length} unlocked</span>
        </div>
        <div class="reward-grid">${cards}</div>
      </section>`;
  }

  function streakForUser(userId, date = new Date()) {
    return window.QuestboardProgressFeatures.calculateStreak({
      userId,
      tasks: state.tasks,
      completions: state.completions,
      timezone: state.timezone,
      now: date,
      resetMonthly: state.streakResetMonthly === true
    });
  }

  function dailyStreakStatusForUser(userId, date = new Date()) {
    const dailyTasks = state.tasks.filter((task) => (
      task.userId === userId &&
      task.frequency === "daily" &&
      task.active !== false
    ));
    const completed = dailyTasks.filter((task) => isTaskComplete(task, date)).length;
    return window.QuestboardProgressFeatures.dailyStreakStatus({
      completed,
      total: dailyTasks.length
    });
  }

  function renderLeaderboard() {
    const scope = ui.leaderboardScope;
    const ranking = state.users
      .filter((user) => user.role !== "admin" || state.tasks.some((task) => task.userId === user.id) || state.completions.some((completion) => completion.userId === user.id))
      .map((user) => ({
        user,
        score: scoreForUser(user.id, scope),
        streak: streakForUser(user.id),
        streakStatus: dailyStreakStatusForUser(user.id)
      }))
      .sort((a, b) => b.score - a.score || a.user.name.localeCompare(b.user.name));
    const maxScore = Math.max(1, ...ranking.map((entry) => entry.score));
    const totalXp = ranking.reduce((sum, entry) => sum + entry.score, 0);
    const completed = completionsForScope(scope).length;
    const currentIndex = ranking.findIndex((entry) => entry.user.id === state.selectedUserId);
    const current = ranking[currentIndex];
    const leader = ranking[0];
    const gap = current && leader ? Math.max(0, leader.score - current.score) : 0;
    const scopeTitle = scope === "day" ? "today" : scope === "week" ? "this week" : "this month";

    const rows = ranking.map((entry, index) => {
      const rank = index + 1;
      const medal = ["🥇", "🥈", "🥉"][index];
      const share = entry.score > 0 ? Math.max(4, Math.round((entry.score / maxScore) * 100)) : 0;
      return `
        <div class="ranking-row${entry.user.id === state.selectedUserId ? " is-current" : ""}" style="--player-colour: ${safeColour(entry.user.colour)}">
          <div class="rank-number${medal ? " is-podium" : ""}" aria-label="Rank ${rank}">${medal || rank}</div>
          <div class="ranking-player">
            <div class="player-avatar" aria-hidden="true">${escapeHtml(entry.user.avatar)}</div>
            <div class="ranking-copy">
              <strong>${escapeHtml(entry.user.name)}${entry.user.id === state.selectedUserId ? " (you)" : ""}</strong>
              <div class="rank-bar" aria-hidden="true"><span style="--bar-width: ${share}%"></span></div>
              <span>${entry.score === 0 ? "Ready for a first quest" : `${formatNumber(entry.score)} XP earned ${scopeTitle}`}</span>
              <span class="streak-pill streak-${entry.streakStatus.state}" title="${escapeHtml(entry.streakStatus.message)}"><span class="streak-flame" aria-hidden="true">🔥</span> ${formatNumber(entry.streak)} day${entry.streak === 1 ? "" : "s"} streak</span>
            </div>
          </div>
          <div class="rank-score"><strong>${formatNumber(entry.score)}</strong><span>XP</span></div>
        </div>
      `;
    }).join("");

    elements.leaderboardView.innerHTML = `
      <div class="page-heading">
        <div>
          <p class="eyebrow">Friendly competition</p>
          <h1 id="leaderboardHeading">Family leaderboard</h1>
          <p>Compare XP over the same day, week or month.</p>
        </div>
        <div class="segmented-control" aria-label="Leaderboard period">
          ${renderScopeButton("day", "Today")}
          ${renderScopeButton("week", "This week")}
          ${renderScopeButton("month", "This month")}
        </div>
      </div>

      <div class="leaderboard-layout">
        <section class="card" aria-labelledby="rankingTitle">
          <header class="card-header">
            <div>
              <h2 id="rankingTitle">Standings</h2>
              <p>${formatNumber(totalXp)} family XP earned ${scopeTitle}</p>
            </div>
          </header>
          <div class="ranking-list">
            ${rows || `<div class="empty-state"><strong>No players yet</strong>Add players in the parent area.</div>`}
          </div>
        </section>

        <aside class="card challenge-card">
          <p class="eyebrow">Family challenge</p>
          <h2>${completed} quest${completed === 1 ? "" : "s"} completed</h2>
          <p>${gap > 0 ? `${escapeHtml(current?.user.name || "Your player")} is ${formatNumber(gap)} XP behind the lead. One more quest could change the table.` : currentIndex === 0 && current ? `${escapeHtml(current.user.name)} is currently leading. Keep the streak going.` : "Complete a quest to set the first score."}</p>
          <div class="challenge-stat">
            <strong>${formatNumber(totalXp)} XP</strong>
            <span>Combined family score ${scopeTitle}</span>
          </div>
        </aside>
      </div>
    `;
  }

  function renderScopeButton(scope, label) {
    const active = ui.leaderboardScope === scope;
    return `<button type="button" data-leaderboard-scope="${scope}" class="${active ? "is-active" : ""}" aria-pressed="${active}">${label}</button>`;
  }

  function renderParentTab(section, label) {
    const active = ui.parentSection === section;
    return `<button type="button" role="tab" data-parent-section="${section}" class="${active ? "is-active" : ""}" aria-selected="${active}">${label}</button>`;
  }

  function renderParent() {
    if (!isAdminSession()) {
      elements.parentView.innerHTML = `
        <div class="locked-state">
          <span class="locked-state-icon" aria-hidden="true">🔒</span>
          <h1 id="parentHeading">Admin access required</h1>
          <p>Switch to the admin profile and enter its PIN to manage users, PINs and quests.</p>
          <button type="button" class="button primary" data-unlock-admin>Unlock parent area</button>
        </div>`;
      elements.parentView.querySelector("[data-unlock-admin]")?.addEventListener("click", () => openSwitchDialog(state.users.find((user) => user.role === "admin")?.id || null));
      return;
    }
    const questOwners = state.users;
    if (!questOwners.some((user) => user.id === ui.adminUserId)) {
      ui.adminUserId = questOwners[0]?.id || null;
    }
    if (ui.editingTaskId && !state.tasks.some((task) => task.id === ui.editingTaskId)) {
      ui.editingTaskId = null;
    }
    if (ui.editingRewardId && !state.rewards.some((reward) => reward.id === ui.editingRewardId)) {
      ui.editingRewardId = null;
    }

    const adminUser = questOwners.find((user) => user.id === ui.adminUserId);
    const editingTask = state.tasks.find((task) => task.id === ui.editingTaskId) || null;
    const editingReward = state.rewards.find((reward) => reward.id === ui.editingRewardId) || null;
    const userRows = state.users.map((user) => `
      <div class="player-admin-row">
        <div class="player-avatar" style="--player-colour: ${safeColour(user.colour)}" aria-hidden="true">${escapeHtml(user.avatar)}</div>
        <div class="admin-copy">
          <strong>${escapeHtml(user.name)}${user.role === "admin" ? ` <span class="role-badge">Admin</span>` : ""}</strong>
          <span>${state.tasks.filter((task) => task.userId === user.id && task.active !== false).length} active quests · ${formatNumber(scoreForUser(user.id, "all"))} lifetime XP · 🔥 ${formatNumber(streakForUser(user.id))} day streak</span>
        </div>
        <div class="row-actions">
          <button type="button" class="icon-button" data-edit-user="${escapeHtml(user.id)}" aria-label="Edit ${escapeHtml(user.name)} and PIN">✎</button>
          <button type="button" class="icon-button" data-delete-user="${escapeHtml(user.id)}" aria-label="Delete ${escapeHtml(user.name)}">×</button>
        </div>
      </div>
    `).join("");

    const ownerOptions = questOwners.map((user) => `<option value="${escapeHtml(user.id)}"${user.id === ui.adminUserId ? " selected" : ""}>${escapeHtml(user.name)}</option>`).join("");
    const tasks = state.tasks
      .filter((task) => task.userId === ui.adminUserId)
      .sort((a, b) => {
        const frequencyDifference = FREQUENCY_ORDER.indexOf(a.frequency) - FREQUENCY_ORDER.indexOf(b.frequency);
        return frequencyDifference || Number(b.active !== false) - Number(a.active !== false) || a.title.localeCompare(b.title);
      });

    const taskRows = tasks.length ? tasks.map((task) => `
      <div class="admin-task-row">
        <div class="admin-copy">
          <strong>${escapeHtml(task.title)}</strong>
          <span>
            <span class="status-pill${task.active === false ? " inactive" : ""}">${task.active === false ? "Paused" : FREQUENCIES[task.frequency].singular}</span>
            ${formatNumber(task.xp)} XP${task.description ? ` · ${escapeHtml(task.description)}` : ""}
          </span>
        </div>
        <div class="row-actions">
          <button type="button" class="text-button" data-edit-task="${escapeHtml(task.id)}">Edit</button>
          <button type="button" class="text-button" data-toggle-task="${escapeHtml(task.id)}">${task.active === false ? "Resume" : "Pause"}</button>
          <button type="button" class="text-button danger" data-delete-task="${escapeHtml(task.id)}">Delete</button>
        </div>
      </div>
    `).join("") : `<div class="empty-state"><strong>No quests for ${escapeHtml(adminUser?.name || "this player")}</strong>Create the first one using the form above.</div>`;

    const rewardRows = state.rewards.length ? [...state.rewards]
      .sort((a, b) => a.threshold - b.threshold || a.title.localeCompare(b.title))
      .map((reward) => `
        <div class="admin-task-row">
          <div class="admin-copy">
            <strong>${escapeHtml(reward.icon)} ${escapeHtml(reward.title)}</strong>
            <span><span class="status-pill${reward.active === false ? " inactive" : ""}">${reward.active === false ? "Paused" : "Active"}</span> Unlocks at ${formatNumber(reward.threshold)} lifetime XP${reward.description ? ` · ${escapeHtml(reward.description)}` : ""}</span>
          </div>
          <div class="row-actions">
            <button type="button" class="text-button" data-edit-reward="${escapeHtml(reward.id)}">Edit</button>
            <button type="button" class="text-button" data-toggle-reward="${escapeHtml(reward.id)}">${reward.active === false ? "Resume" : "Pause"}</button>
            <button type="button" class="text-button danger" data-delete-reward="${escapeHtml(reward.id)}">Delete</button>
          </div>
        </div>`).join("")
      : `<div class="empty-state"><strong>No rewards yet</strong>Create a reward and choose the lifetime XP needed to unlock it.</div>`;

    const recentCompletions = [...state.completions]
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
      .slice(0, 10);
    const activityRows = recentCompletions.length ? recentCompletions.map((completion) => {
      const user = state.users.find((candidate) => candidate.id === completion.userId);
      return `
        <div class="activity-row">
          <div class="admin-copy">
            <strong>${escapeHtml(user?.avatar || "⭐")} ${escapeHtml(user?.name || "Deleted player")} earned +${formatNumber(completion.xp)} XP</strong>
            <span>${escapeHtml(completion.taskTitle || "Completed quest")} · ${escapeHtml(formatCompletionDate(completion.completedAt))}</span>
          </div>
          <button type="button" class="text-button danger" data-undo-completion="${escapeHtml(completion.id)}">Undo</button>
        </div>
      `;
    }).join("") : `<div class="empty-state"><strong>No activity yet</strong>Completed quests will appear here.</div>`;

    elements.parentView.innerHTML = `
      <div class="page-heading">
        <div>
          <p class="eyebrow">Grown-ups only</p>
          <h1 id="parentHeading">Parent area</h1>
          <p>Create players, assign quests, change account PINs and correct recent activity. This area is protected by the admin PIN.</p>
        </div>
      </div>

      <div class="segmented-control parent-tabs" role="tablist" aria-label="Parent area sections">
        ${renderParentTab("players", "Players")}
        ${renderParentTab("settings", "App Settings")}
        ${renderParentTab("quests", "Quest Editor")}
        ${renderParentTab("rewards", "Reward Editor")}
        ${renderParentTab("activity", "Recent XP Activity")}
      </div>

      <div class="parent-grid parent-tab-content">
        <div>
          <section class="card" data-parent-panel="players"${ui.parentSection === "players" ? "" : " hidden"}>
            <header class="card-header">
              <div>
                <h2>Players</h2>
                <p>Each profile has its own PIN, task list and XP history.</p>
              </div>
              <button type="button" class="button primary small" data-add-user>+ Add</button>
            </header>
            <div class="panel-body player-admin-list">${userRows}</div>
          </section>

          <section class="card settings-card" data-parent-panel="settings"${ui.parentSection === "settings" ? "" : " hidden"}>
            <header class="card-header">
              <div>
                <h2>App settings</h2>
                <p>Household time and shared server data.</p>
              </div>
            </header>
            <div class="panel-body settings-stack">
              <form class="settings-block" data-timezone-form>
                <h3>Household timezone</h3>
                <p>All daily, weekly and monthly boundaries use this IANA timezone.</p>
                <label class="field">
                  <span>Timezone</span>
                  <input name="timezone" value="${escapeHtml(state.timezone)}" required autocomplete="off" aria-describedby="timezoneHint">
                </label>
                <div class="form-actions"><button type="submit" class="button secondary small">Save timezone</button></div>
              </form>


              <form class="settings-block" data-streak-settings-form>
                <h3>Streak reset</h3>
                <p>Choose whether daily quest streaks continue forever or restart at the beginning of each month.</p>
                <label class="toggle-field">
                  <input name="streakResetMonthly" type="checkbox"${state.streakResetMonthly === true ? " checked" : ""}>
                  <span>
                    <strong>Reset streaks every month</strong>
                    <small>At midnight on the first day of each month, each streak starts again from zero.</small>
                  </span>
                </label>
                <div class="form-actions"><button type="submit" class="button secondary small">Save streak setting</button></div>
              </form>
              <div class="settings-block">
                <h3>Backup and restore</h3>
                <p>Export the shared household data or replace it from a JSON backup.</p>
                <div class="settings-actions">
                  <button type="button" class="button secondary small" data-export-data>Export data</button>
                  <label class="button secondary small file-button">Import data<input type="file" data-import-data accept="application/json,.json"></label>
                </div>
              </div>

              <div class="settings-block">
                <h3>Data controls</h3>
                <p>Clear only XP activity or restore the original sample family.</p>
                <div class="settings-actions">
                  <button type="button" class="button danger small" data-clear-history>Clear XP history</button>
                  <button type="button" class="button secondary small" data-reset-demo>Reset sample data</button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div>
          <section class="card" id="taskEditorCard" data-parent-panel="quests"${ui.parentSection === "quests" ? "" : " hidden"}>
            <header class="card-header">
              <div>
                <h2>Quest editor</h2>
                <p>Add daily, weekly or monthly chores for one player.</p>
              </div>
              <div class="task-admin-filter">
                <label for="adminUserFilter">Editing for</label>
                <select id="adminUserFilter" data-admin-user-filter>${ownerOptions}</select>
              </div>
            </header>

            <form class="form-section" data-task-form>
              <input type="hidden" name="taskId" value="${escapeHtml(editingTask?.id || "")}">
              <h3>${editingTask ? "Edit quest" : `New quest for ${escapeHtml(adminUser?.name || "player")}`}</h3>
              <p>${editingTask ? "Changes affect future completions; historic XP remains unchanged." : "Choose a clear action and an XP reward that matches the effort."}</p>

              <label class="field">
                <span>Quest title</span>
                <input name="title" maxlength="60" value="${escapeHtml(editingTask?.title || "")}" placeholder="e.g. Make the bed" required autocomplete="off">
              </label>

              <label class="field">
                <span>Description (optional)</span>
                <textarea name="description" maxlength="160" placeholder="A short reminder or definition of done">${escapeHtml(editingTask?.description || "")}</textarea>
              </label>

              <div class="field-grid three-columns">
                <label class="field">
                  <span>Reset cycle</span>
                  <select name="frequency" required>
                    ${FREQUENCY_ORDER.map((frequency) => `<option value="${frequency}"${(editingTask?.frequency || "daily") === frequency ? " selected" : ""}>${FREQUENCIES[frequency].label}</option>`).join("")}
                  </select>
                </label>
                <label class="field">
                  <span>XP reward</span>
                  <input name="xp" type="number" min="1" max="500" step="1" value="${editingTask?.xp ?? 10}" required>
                </label>
                <label class="field">
                  <span>Status</span>
                  <select name="active">
                    <option value="true"${editingTask?.active !== false ? " selected" : ""}>Active</option>
                    <option value="false"${editingTask?.active === false ? " selected" : ""}>Paused</option>
                  </select>
                </label>
              </div>

              <div class="form-actions">
                ${editingTask ? `<button type="button" class="button secondary" data-cancel-task-edit>Cancel</button>` : ""}
                <button type="submit" class="button primary">${editingTask ? "Save changes" : "Add quest"}</button>
              </div>
            </form>

            <div class="admin-task-list">${taskRows}</div>
          </section>

          <section class="card settings-card" id="rewardEditorCard" data-parent-panel="rewards"${ui.parentSection === "rewards" ? "" : " hidden"}>
            <header class="card-header">
              <div>
                <h2>Reward editor</h2>
                <p>Create shared rewards that each child unlocks with lifetime XP.</p>
              </div>
            </header>
            <form class="form-section" data-reward-form>
              <input type="hidden" name="rewardId" value="${escapeHtml(editingReward?.id || "")}">
              <h3>${editingReward ? "Edit reward" : "New reward"}</h3>
              <p>Rewards unlock independently for every child when their lifetime XP reaches the threshold.</p>
              <div class="field-grid two-columns compact-icon-grid">
                <label class="field">
                  <span>Reward icon</span>
                  <input name="icon" maxlength="8" value="${escapeHtml(editingReward?.icon || "🎁")}" required autocomplete="off" placeholder="🎁">
                </label>
                <label class="field">
                  <span>Lifetime XP threshold</span>
                  <input name="threshold" type="number" min="1" max="1000000" step="1" value="${editingReward?.threshold ?? 100}" required>
                </label>
              </div>
              <label class="field">
                <span>Reward title</span>
                <input name="title" maxlength="60" value="${escapeHtml(editingReward?.title || "")}" placeholder="e.g. Choose Friday's dessert" required autocomplete="off">
              </label>
              <label class="field">
                <span>Description (optional)</span>
                <textarea name="description" maxlength="160" placeholder="Explain what the child can claim">${escapeHtml(editingReward?.description || "")}</textarea>
              </label>
              <label class="field">
                <span>Status</span>
                <select name="active">
                  <option value="true"${editingReward?.active !== false ? " selected" : ""}>Active</option>
                  <option value="false"${editingReward?.active === false ? " selected" : ""}>Paused</option>
                </select>
              </label>
              <div class="form-actions">
                ${editingReward ? `<button type="button" class="button secondary" data-cancel-reward-edit>Cancel</button>` : ""}
                <button type="submit" class="button primary">${editingReward ? "Save changes" : "Add reward"}</button>
              </div>
            </form>
            <div class="admin-task-list reward-admin-list">${rewardRows}</div>
          </section>

          <section class="card settings-card" data-parent-panel="activity"${ui.parentSection === "activity" ? "" : " hidden"}>
            <header class="card-header">
              <div>
                <h2>Recent XP activity</h2>
                <p>Undo an accidental completion without changing the quest.</p>
              </div>
            </header>
            <div class="panel-body activity-list">${activityRows}</div>
          </section>
        </div>
      </div>
    `;
  }

  function handleParentClick(event) {
    const parentTab = event.target.closest("[data-parent-section]");
    if (parentTab) {
      ui.parentSection = parentTab.dataset.parentSection;
      renderParent();
      return;
    }

    const addUserButton = event.target.closest("[data-add-user]");
    if (addUserButton) {
      openUserDialog();
      return;
    }

    const editUserButton = event.target.closest("[data-edit-user]");
    if (editUserButton) {
      openUserDialog(editUserButton.dataset.editUser);
      return;
    }

    const deleteUserButton = event.target.closest("[data-delete-user]");
    if (deleteUserButton) {
      deleteUser(deleteUserButton.dataset.deleteUser);
      return;
    }

    const editTaskButton = event.target.closest("[data-edit-task]");
    if (editTaskButton) {
      const task = state.tasks.find((candidate) => candidate.id === editTaskButton.dataset.editTask);
      if (!task) return;
      ui.adminUserId = task.userId;
      ui.editingTaskId = task.id;
      renderParent();
      requestAnimationFrame(() => document.querySelector("#taskEditorCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }

    const cancelTaskButton = event.target.closest("[data-cancel-task-edit]");
    if (cancelTaskButton) {
      ui.editingTaskId = null;
      renderParent();
      return;
    }

    const toggleTaskButton = event.target.closest("[data-toggle-task]");
    if (toggleTaskButton) {
      const task = state.tasks.find((candidate) => candidate.id === toggleTaskButton.dataset.toggleTask);
      if (!task) return;
      task.active = task.active === false;
      saveState();
      renderAll();
      showToast(task.active ? "Quest resumed" : "Quest paused", task.title, task.active ? "▶" : "Ⅱ");
      return;
    }

    const deleteTaskButton = event.target.closest("[data-delete-task]");
    if (deleteTaskButton) {
      deleteTask(deleteTaskButton.dataset.deleteTask);
      return;
    }

    const editRewardButton = event.target.closest("[data-edit-reward]");
    if (editRewardButton) {
      ui.editingRewardId = editRewardButton.dataset.editReward;
      renderParent();
      requestAnimationFrame(() => document.querySelector("#rewardEditorCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }

    if (event.target.closest("[data-cancel-reward-edit]")) {
      ui.editingRewardId = null;
      renderParent();
      return;
    }

    const toggleRewardButton = event.target.closest("[data-toggle-reward]");
    if (toggleRewardButton) {
      const reward = state.rewards.find((candidate) => candidate.id === toggleRewardButton.dataset.toggleReward);
      if (!reward) return;
      reward.active = reward.active === false;
      reward.updatedAt = new Date().toISOString();
      saveState();
      renderAll();
      showToast(reward.active ? "Reward resumed" : "Reward paused", reward.title, reward.active ? "▶" : "Ⅱ");
      return;
    }

    const deleteRewardButton = event.target.closest("[data-delete-reward]");
    if (deleteRewardButton) {
      deleteReward(deleteRewardButton.dataset.deleteReward);
      return;
    }

    const undoButton = event.target.closest("[data-undo-completion]");
    if (undoButton) {
      undoCompletion(undoButton.dataset.undoCompletion);
      return;
    }

    if (event.target.closest("[data-export-data]")) {
      exportData();
      return;
    }

    if (event.target.closest("[data-clear-history]")) {
      clearHistory();
      return;
    }

    if (event.target.closest("[data-reset-demo]")) {
      resetDemo();
    }
  }

  function handleParentChange(event) {
    if (event.target.matches("[data-admin-user-filter]")) {
      ui.adminUserId = event.target.value;
      ui.editingTaskId = null;
      renderParent();
      return;
    }

    if (event.target.matches("[data-import-data]")) {
      const file = event.target.files?.[0];
      if (file) importData(file);
    }
  }

  function handleParentSubmit(event) {
    if (event.target.matches("[data-task-form]")) {
      event.preventDefault();
      saveTask(new FormData(event.target));
      return;
    }

    if (event.target.matches("[data-reward-form]")) {
      event.preventDefault();
      saveReward(new FormData(event.target));
      return;
    }

    if (event.target.matches("[data-timezone-form]")) {
      event.preventDefault();
      const formData = new FormData(event.target);
      saveTimezone(String(formData.get("timezone") || "").trim());
      return;
    }

    if (event.target.matches("[data-streak-settings-form]")) {
      event.preventDefault();
      state.streakResetMonthly = new FormData(event.target).get("streakResetMonthly") === "on";
      saveState();
      renderAll();
      showToast("Streak setting saved", state.streakResetMonthly ? "Streaks now restart each month." : "Streaks now accumulate continuously.", "🔥");
    }
  }

  function openUserDialog(userId = null) {
    if (!isAdminSession()) return;
    const user = state.users.find((candidate) => candidate.id === userId);
    elements.userDialogTitle.textContent = user ? "Edit player" : "Add a player";
    elements.userIdField.value = user?.id || "";
    elements.userNameField.value = user?.name || "";
    elements.userAvatarField.value = user?.avatar || "⭐";
    elements.userColourField.value = safeColour(user?.colour || "#6d5dfc");
    elements.userPinField.value = "";
    elements.userAdminField.checked = user?.role === "admin";
    elements.userPinField.required = !user;
    elements.userPinLabel.textContent = user ? "New account PIN (optional)" : "Account PIN";
    elements.userPinHint.textContent = user
      ? "Leave blank to keep the current PIN. Only an admin can change it."
      : "Choose 4 to 8 digits. Only an admin can change it later.";
    elements.userDialog.showModal();
    requestAnimationFrame(() => elements.userNameField.focus());
  }

  async function handleUserSubmit(event) {
    event.preventDefault();
    if (!isAdminSession()) return;
    const userId = elements.userIdField.value;
    const name = elements.userNameField.value.trim();
    const avatar = elements.userAvatarField.value.trim() || "⭐";
    const colour = safeColour(elements.userColourField.value);
    const pin = elements.userPinField.value.trim();
    const isAdmin = elements.userAdminField.checked;
    if (!name) return;
    if ((!userId && !pin) || (pin && !/^\d{4,8}$/.test(pin))) {
      showToast("Check the PIN", "Use 4 to 8 digits.", "!");
      elements.userPinField.focus();
      return;
    }

    const existingUser = state.users.find((candidate) => candidate.id === userId);
    if (existingUser?.role === "admin" && !isAdmin && state.users.filter((candidate) => candidate.role === "admin").length === 1) {
      showToast("Keep one administrator", "Promote another account before removing this account's admin role.", "🔒");
      return;
    }

    let savedUserId = userId;
    if (userId) {
      const user = state.users.find((candidate) => candidate.id === userId);
      if (!user) return;
      user.name = name;
      user.avatar = avatar;
      user.colour = colour;
      user.role = isAdmin ? "admin" : "player";
    } else {
      const user = {
        id: makeId("user"),
        name,
        avatar,
        colour,
        role: isAdmin ? "admin" : "player",
        createdAt: new Date().toISOString()
      };
      state.users.push(user);
      savedUserId = user.id;
      ui.adminUserId = user.id;
    }

    renderAll();
    await saveState();
    if (hasUnsyncedChanges) {
      showToast("Server connection required", "The profile was not saved yet, so its PIN was not changed.", "!");
      return;
    }
    if (pin) {
      const pinSaved = await updateUserPin(savedUserId, pin);
      if (!pinSaved) return;
    }

    elements.userDialog.close();
    showToast(userId ? "Player updated" : "Player added", userId ? `${name}'s profile and PIN settings were saved.` : `${name} is ready for their first quest.`, avatar);
  }

  function deleteUser(userId) {
    const user = state.users.find((candidate) => candidate.id === userId);
    if (!user) return;
    if (user.role === "admin" && state.users.filter((candidate) => candidate.role === "admin").length === 1) {
      showToast("Keep one administrator", "Promote another account before deleting the final administrator.", "🔒");
      return;
    }
    if (state.users.length === 1) {
      showToast("Keep one player", "Add another player before deleting this one.", "!");
      return;
    }
    const taskCount = state.tasks.filter((task) => task.userId === userId).length;
    const completionCount = state.completions.filter((completion) => completion.userId === userId).length;
    const confirmed = window.confirm(`Delete ${user.name}? This also removes ${taskCount} quest${taskCount === 1 ? "" : "s"} and ${completionCount} XP record${completionCount === 1 ? "" : "s"}.`);
    if (!confirmed) return;

    state.users = state.users.filter((candidate) => candidate.id !== userId);
    state.tasks = state.tasks.filter((task) => task.userId !== userId);
    state.completions = state.completions.filter((completion) => completion.userId !== userId);
    if (state.selectedUserId === userId) state.selectedUserId = currentSessionUser?.id || null;
    if (ui.adminUserId === userId) ui.adminUserId = state.users[0]?.id || null;
    ui.editingTaskId = null;
    saveState();
    renderAll();
    showToast("Player deleted", `${user.name}'s profile and data were removed.`, "×");
  }

  async function updateUserPin(userId, pin) {
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/pin`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Server returned ${response.status}`);
      applyServerPayload(payload);
      showToast("PIN updated", "The new PIN is active on every device.", "🔒");
      return true;
    } catch (error) {
      showToast("PIN not changed", error instanceof Error ? error.message : "The server rejected the PIN change.", "!");
      return false;
    }
  }

  function saveTask(formData) {
    const taskId = String(formData.get("taskId") || "");
    const title = String(formData.get("title") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const frequency = String(formData.get("frequency") || "daily");
    const xp = Number.parseInt(String(formData.get("xp") || "0"), 10);
    const active = String(formData.get("active")) !== "false";

    if (!title || !FREQUENCY_ORDER.includes(frequency) || !Number.isInteger(xp) || xp < 1 || xp > 500 || !ui.adminUserId) {
      showToast("Check the quest", "Add a title and choose an XP value from 1 to 500.", "!");
      return;
    }

    if (taskId) {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      task.title = title;
      task.description = description;
      task.frequency = frequency;
      task.xp = xp;
      task.active = active;
      task.updatedAt = new Date().toISOString();
      showToast("Quest updated", `${title} now awards ${xp} XP.`, "✎");
    } else {
      state.tasks.push({
        id: makeId("task"),
        userId: ui.adminUserId,
        title,
        description,
        frequency,
        xp,
        active,
        createdAt: new Date().toISOString()
      });
      showToast("Quest added", `${title} is now available.`, "+");
    }

    ui.editingTaskId = null;
    saveState();
    renderAll();
  }

  function deleteTask(taskId) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const confirmed = window.confirm(`Delete “${task.title}”? Historic XP already earned from it will be kept.`);
    if (!confirmed) return;
    state.tasks = state.tasks.filter((candidate) => candidate.id !== taskId);
    if (ui.editingTaskId === taskId) ui.editingTaskId = null;
    saveState();
    renderAll();
    showToast("Quest deleted", "Historic XP was left unchanged.", "×");
  }

  function saveReward(formData) {
    const rewardId = String(formData.get("rewardId") || "");
    const title = String(formData.get("title") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const icon = String(formData.get("icon") || "🎁").trim() || "🎁";
    const threshold = Number.parseInt(String(formData.get("threshold") || "0"), 10);
    const active = String(formData.get("active")) !== "false";

    if (!title || !Number.isInteger(threshold) || threshold < 1 || threshold > 1_000_000) {
      showToast("Check the reward", "Add a title and choose a lifetime XP threshold from 1 to 1,000,000.", "!");
      return;
    }

    if (rewardId) {
      const reward = state.rewards.find((candidate) => candidate.id === rewardId);
      if (!reward) return;
      reward.title = title;
      reward.description = description;
      reward.icon = icon;
      reward.threshold = threshold;
      reward.active = active;
      reward.updatedAt = new Date().toISOString();
      showToast("Reward updated", `${title} unlocks at ${formatNumber(threshold)} XP.`, icon);
    } else {
      state.rewards.push({
        id: makeId("reward"),
        title,
        description,
        icon,
        threshold,
        active,
        createdAt: new Date().toISOString()
      });
      showToast("Reward added", `${title} is now on every child's reward path.`, icon);
    }

    ui.editingRewardId = null;
    saveState();
    renderAll();
  }

  function deleteReward(rewardId) {
    const reward = state.rewards.find((candidate) => candidate.id === rewardId);
    if (!reward) return;
    if (!window.confirm(`Delete “${reward.title}”? It will disappear from every player's reward list.`)) return;
    state.rewards = state.rewards.filter((candidate) => candidate.id !== rewardId);
    if (ui.editingRewardId === rewardId) ui.editingRewardId = null;
    saveState();
    renderAll();
    showToast("Reward deleted", reward.title, "×");
  }

  async function completeTask(taskId, sourceButton) {
    const task = state.tasks.find((candidate) => candidate.id === taskId && candidate.active !== false);
    if (!task || task.userId !== state.selectedUserId || isTaskComplete(task) || !currentSessionUser) return;

    sourceButton.disabled = true;
    try {
      const response = await fetch("/api/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        currentSessionUser = null;
        state.selectedUserId = null;
        renderAll();
        openSwitchDialog();
      }
      if (!response.ok) throw new Error(payload.error || `Server returned ${response.status}`);
      applyServerPayload(payload);
      showToast(`+${task.xp} XP earned`, task.title, "★");
      launchConfetti();
    } catch (error) {
      sourceButton.disabled = false;
      showToast("Quest not saved", error instanceof Error ? error.message : "The server could not record this quest.", "!");
    }
  }

  function undoCompletion(completionId) {
    const completion = state.completions.find((candidate) => candidate.id === completionId);
    if (!completion) return;
    state.completions = state.completions.filter((candidate) => candidate.id !== completionId);
    saveState();
    renderAll();
    showToast("Completion undone", `${completion.xp} XP was removed from ${completion.taskTitle || "the quest"}.`, "↶");
  }

  function saveTimezone(timezone) {
    if (!isValidTimezone(timezone)) {
      showToast("Timezone not recognised", "Use an IANA name such as Europe/London.", "!");
      return;
    }
    if (timezone === state.timezone) {
      showToast("Timezone unchanged", `Resets already use ${timezone}.`, "✓");
      return;
    }
    state.timezone = timezone;
    state.completions = state.completions.map((completion) => reindexCompletion(completion, timezone));
    saveState();
    ui.lastPeriodSignature = currentPeriodSignature();
    renderAll();
    showToast("Timezone saved", `Reset boundaries now use ${timezone}.`, "◷");
  }

  function exportData() {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      app: "Questboard",
      data: state
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `questboard-backup-${periodKeys(new Date(), state.timezone).dayKey}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Backup exported", "Your players, quests, rewards and XP history were saved.", "↓");
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const candidate = parsed?.data || parsed;
      const imported = normaliseState(candidate);
      if (!imported.users.length) throw new Error("The backup contains no players.");
      const confirmed = window.confirm("Replace the shared household data with this backup on every device?");
      if (!confirmed) return;
      state = imported;
      ensureValidSelection();
      ui.adminUserId = state.selectedUserId;
      ui.editingTaskId = null;
      ui.editingRewardId = null;
      saveState();
      renderAll();
      showToast("Backup imported", "The family data has been restored.", "↑");
    } catch (error) {
      showToast("Import failed", error instanceof Error ? error.message : "The selected file is not a valid Questboard backup.", "!");
    }
  }

  function clearHistory() {
    if (!state.completions.length) {
      showToast("History already empty", "There are no XP records to clear.", "✓");
      return;
    }
    const confirmed = window.confirm("Clear all XP and completion history? Players and quests will remain.");
    if (!confirmed) return;
    state.completions = [];
    saveState();
    renderAll();
    showToast("XP history cleared", "Every active quest is available again.", "↻");
  }

  function resetDemo() {
    const confirmed = window.confirm("Restore the original sample players, quests, rewards and XP activity?");
    if (!confirmed) return;
    state = createSeedState();
    ensureValidSelection();
    ui.adminUserId = state.selectedUserId;
    ui.editingTaskId = null;
    ui.editingRewardId = null;
    saveState();
    renderAll();
    showToast("Sample data restored", "The shared app is back to its starting state.", "↻");
  }

  function isTaskComplete(task, date = new Date()) {
    const keys = periodKeys(date, state.timezone);
    const periodKey = keys[periodPropertyForFrequency(task.frequency)];
    return state.completions.some((completion) => (
      completion.taskId === task.id &&
      completion.frequency === task.frequency &&
      completion.periodKey === periodKey
    ));
  }

  function scoreForUser(userId, scope) {
    if (scope === "all") {
      return state.completions
        .filter((completion) => completion.userId === userId)
        .reduce((sum, completion) => sum + validXp(completion.xp), 0);
    }
    const property = scopeProperty(scope);
    const currentKey = periodKeys(new Date(), state.timezone)[property];
    return state.completions
      .filter((completion) => completion.userId === userId && completion[property] === currentKey)
      .reduce((sum, completion) => sum + validXp(completion.xp), 0);
  }

  function completionsForScope(scope) {
    const property = scopeProperty(scope);
    const currentKey = periodKeys(new Date(), state.timezone)[property];
    return state.completions.filter((completion) => completion[property] === currentKey);
  }

  function scopeProperty(scope) {
    return scope === "day" ? "dayKey" : scope === "week" ? "weekKey" : "monthKey";
  }

  function periodPropertyForFrequency(frequency) {
    return frequency === "daily" ? "dayKey" : frequency === "weekly" ? "weekKey" : "monthKey";
  }

  function createCompletion(task, date, timezone) {
    const keys = periodKeys(date, timezone);
    return {
      id: makeId("completion"),
      taskId: task.id,
      userId: task.userId,
      taskTitle: task.title,
      xp: validXp(task.xp),
      frequency: task.frequency,
      completedAt: date.toISOString(),
      dayKey: keys.dayKey,
      weekKey: keys.weekKey,
      monthKey: keys.monthKey,
      periodKey: keys[periodPropertyForFrequency(task.frequency)]
    };
  }

  function reindexCompletion(completion, timezone) {
    const date = new Date(completion.completedAt);
    if (Number.isNaN(date.getTime())) return completion;
    const keys = periodKeys(date, timezone);
    const frequency = FREQUENCY_ORDER.includes(completion.frequency) ? completion.frequency : "daily";
    return {
      ...completion,
      frequency,
      dayKey: keys.dayKey,
      weekKey: keys.weekKey,
      monthKey: keys.monthKey,
      periodKey: keys[periodPropertyForFrequency(frequency)]
    };
  }

  function periodKeys(date, timezone) {
    const { year, month, day } = civilDateParts(date, timezone);
    const dayKey = `${year}-${pad2(month)}-${pad2(day)}`;
    const monthKey = `${year}-${pad2(month)}`;
    const weekKey = isoWeekKey(year, month, day);
    return { dayKey, weekKey, monthKey };
  }

  function civilDateParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour)
    };
  }

  function isoWeekKey(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekday);
    const isoYear = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
    return `${isoYear}-W${pad2(week)}`;
  }

  function localGreeting() {
    const hour = civilDateParts(new Date(), state.timezone).hour;
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  function resetCountdownLabel(frequency, date = new Date()) {
    return window.QuestboardResetCountdown.formatResetCountdown(frequency, date, state.timezone);
  }

  function currentCountdownSignature(date = new Date()) {
    return FREQUENCY_ORDER.map((frequency) => resetCountdownLabel(frequency, date)).join("|");
  }

  function currentPeriodSignature() {
    const keys = periodKeys(new Date(), state.timezone);
    return `${state.timezone}|${keys.dayKey}|${keys.weekKey}|${keys.monthKey}`;
  }

  function formatDate(date, options) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: state.timezone,
      ...options
    }).format(date);
  }

  function formatCompletionDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown time";
    return formatDate(date, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  async function loadState() {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const payload = await response.json();
      currentSessionUser = payload.currentUser || null;
      serverRevision = Number(payload.revision) || 0;
      serverReachable = true;
      const loaded = normaliseState({
        ...(payload.state || payload),
        selectedUserId: currentSessionUser?.id || null
      });
      lastSyncedState = sharedStateSnapshot(loaded);
      writeLocalCache(loaded);
      return loaded;
    } catch (error) {
      console.warn("Questboard server is unavailable; loading a local cache.", error);
      serverReachable = false;
      currentSessionUser = null;
      const cached = readLocalState(CACHE_STORAGE_KEY) || readLocalState(LEGACY_STORAGE_KEY);
      const fallback = cached || createSeedState();
      fallback.selectedUserId = null;
      lastSyncedState = sharedStateSnapshot(fallback);
      return fallback;
    }
  }

  function sharedStateSnapshot(source = state) {
    return {
      version: 4,
      timezone: source.timezone,
      streakResetMonthly: source.streakResetMonthly === true,
      users: source.users,
      tasks: source.tasks,
      rewards: source.rewards,
      completions: source.completions
    };
  }

  function readLocalState(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return normaliseState({ ...JSON.parse(raw), selectedUserId: null });
    } catch {
      return null;
    }
  }

  function writeLocalCache(source = state) {
    try {
      localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(sharedStateSnapshot(source)));
    } catch {
      // The server remains the source of truth if the browser cache is unavailable.
    }
  }

  function saveState() {
    if (!isAdminSession()) {
      showToast("Admin access required", "Only the admin profile can change shared settings.", "🔒");
      return Promise.resolve();
    }
    localMutationVersion += 1;
    hasUnsyncedChanges = true;
    writeLocalCache(state);
    setSyncStatus("Saving shared data…");
    return queueServerSave();
  }

  function queueServerSave() {
    if (savePromise) return savePromise;
    pendingSaves = 1;
    savePromise = flushStateToServer().finally(() => {
      pendingSaves = 0;
      savePromise = null;
    });
    return savePromise;
  }

  async function flushStateToServer() {
    while (hasUnsyncedChanges) {
      const mutationVersion = localMutationVersion;
      const snapshot = sharedStateSnapshot();
      let candidate = snapshot;
      let attempts = 0;

      try {
        while (attempts < 3) {
          attempts += 1;
          const response = await fetch("/api/state", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseRevision: serverRevision,
              state: candidate
            })
          });
          const payload = await response.json().catch(() => ({}));

          if (response.status === 409 && payload.state) {
            const remoteState = sharedStateSnapshot(normaliseState(payload.state));
            candidate = mergeSharedStates(lastSyncedState || remoteState, remoteState, candidate);
            serverRevision = Number(payload.revision) || serverRevision;
            lastSyncedState = remoteState;
            continue;
          }

          if (response.status === 401 || response.status === 403) {
            currentSessionUser = null;
            state.selectedUserId = null;
            renderAll();
            openSwitchDialog();
          }
          if (!response.ok) throw new Error(payload.error || `Server returned ${response.status}`);

          const savedState = sharedStateSnapshot(normaliseState(payload.state || candidate));
          const selectedUserId = state.selectedUserId;
          serverRevision = Number(payload.revision) || serverRevision;
          lastSyncedState = savedState;
          serverReachable = true;
          saveFailureNotified = false;

          if (mutationVersion === localMutationVersion) {
            state = normaliseState({ ...savedState, selectedUserId });
            hasUnsyncedChanges = false;
          } else {
            const liveState = sharedStateSnapshot(state);
            const mergedLiveState = mergeSharedStates(snapshot, savedState, liveState);
            state = normaliseState({ ...mergedLiveState, selectedUserId });
            hasUnsyncedChanges = true;
          }

          ensureValidSelection();
          writeLocalCache(state);
          renderAll();
          setSyncStatus(hasUnsyncedChanges ? "Saving shared data…" : "Shared data saved");
          break;
        }

        if (attempts >= 3 && hasUnsyncedChanges && mutationVersion === localMutationVersion) {
          throw new Error("Shared data changed too frequently to save safely.");
        }
      } catch (error) {
        serverReachable = false;
        hasUnsyncedChanges = true;
        setSyncStatus("Offline — changes cached", true);
        console.error("Could not save Questboard data.", error);
        if (!saveFailureNotified) {
          saveFailureNotified = true;
          showToast("Server save failed", "The change is cached on this device and will retry automatically.", "!");
        }
        return;
      }
    }
  }

  function mergeSharedStates(base, remote, local) {
    return {
      version: 4,
      timezone: valuesEqual(local.timezone, base.timezone) ? remote.timezone : local.timezone,
      streakResetMonthly: valuesEqual(local.streakResetMonthly, base.streakResetMonthly) ? remote.streakResetMonthly : local.streakResetMonthly,
      users: mergeCollection(base.users, remote.users, local.users),
      tasks: mergeCollection(base.tasks, remote.tasks, local.tasks),
      rewards: mergeCollection(base.rewards, remote.rewards, local.rewards),
      completions: mergeCollection(base.completions, remote.completions, local.completions)
    };
  }

  function mergeCollection(baseItems = [], remoteItems = [], localItems = []) {
    const baseMap = new Map(baseItems.map((item) => [item.id, item]));
    const remoteMap = new Map(remoteItems.map((item) => [item.id, item]));
    const localMap = new Map(localItems.map((item) => [item.id, item]));
    const orderedIds = [...new Set([
      ...localItems.map((item) => item.id),
      ...remoteItems.map((item) => item.id),
      ...baseItems.map((item) => item.id)
    ])];

    return orderedIds.flatMap((id) => {
      const baseItem = baseMap.get(id);
      const remoteItem = remoteMap.get(id);
      const localItem = localMap.get(id);
      const localChanged = !valuesEqual(localItem, baseItem);
      const chosen = localChanged ? localItem : remoteItem;
      return chosen ? [chosen] : [];
    });
  }

  function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  async function syncFromServer({ force = false } = {}) {
    if (document.hidden && !force) return;
    if (pendingSaves > 0) return;
    if (hasUnsyncedChanges) {
      try {
        await queueServerSave();
      } catch {
        // The sync status already explains that the cached change will retry.
      }
      return;
    }

    try {
      const response = await fetch(`/api/state?since=${encodeURIComponent(serverRevision)}`, { cache: "no-store" });
      if (response.status === 204) {
        serverReachable = true;
        setSyncStatus("Shared data connected");
        return;
      }
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const payload = await response.json();
      const previousUserId = currentSessionUser?.id || null;
      const previousRevision = serverRevision;
      const nextRevision = Number(payload.revision) || 0;
      applyServerPayload(payload);
      if (nextRevision !== previousRevision) {
        ui.editingTaskId = null;
        ui.editingRewardId = null;
      }
      if (previousUserId && !currentSessionUser && !elements.switchDialog.open) openSwitchDialog();
      setSyncStatus(nextRevision === previousRevision ? "Shared data connected" : "Updated from another device");
    } catch (error) {
      serverReachable = false;
      setSyncStatus("Server unavailable", true);
      console.warn("Could not refresh shared Questboard data.", error);
    }
  }

  function setSyncStatus(label, isError = false) {
    if (!elements?.syncFooter) return;
    elements.syncFooter.textContent = label;
    elements.syncFooter.classList.toggle("is-error", isError);
  }

  function normaliseState(candidate) {
    if (!candidate || typeof candidate !== "object") throw new Error("The backup has no Questboard data.");
    const timezone = typeof candidate.timezone === "string" && isValidTimezone(candidate.timezone)
      ? candidate.timezone
      : DEFAULT_TIMEZONE;
    const streakResetMonthly = candidate.streakResetMonthly === true;
    let users = Array.isArray(candidate.users)
      ? candidate.users
          .filter((user) => user && typeof user.id === "string" && typeof user.name === "string")
          .map((user) => ({
            id: user.id,
            name: user.name.trim().slice(0, 24) || "Player",
            avatar: String(user.avatar || "⭐").slice(0, 8),
            colour: safeColour(user.colour),
            role: user.role === "admin" || user.id === "user-parent" ? "admin" : "player",
            createdAt: user.createdAt || new Date().toISOString()
          }))
      : [];
    if (users.length && !users.some((user) => user.role === "admin")) {
      users = [
        { id: users.some((user) => user.id === "user-parent") ? makeId("user-admin") : "user-parent", name: "Parent", avatar: "🛡️", colour: "#5038c8", role: "admin", createdAt: new Date().toISOString() },
        ...users.map((user) => ({ ...user, role: "player" }))
      ];
    }

    const userIds = new Set(users.map((user) => user.id));
    const tasks = Array.isArray(candidate.tasks)
      ? candidate.tasks
          .filter((task) => task && typeof task.id === "string" && userIds.has(task.userId) && typeof task.title === "string")
          .map((task) => ({
            id: task.id,
            userId: task.userId,
            title: task.title.trim().slice(0, 60) || "Untitled quest",
            description: String(task.description || "").trim().slice(0, 160),
            frequency: FREQUENCY_ORDER.includes(task.frequency) ? task.frequency : "daily",
            xp: Math.min(500, Math.max(1, validXp(task.xp) || 10)),
            active: task.active !== false,
            createdAt: task.createdAt || new Date().toISOString(),
            updatedAt: task.updatedAt || undefined
          }))
      : [];
    const rewards = Array.isArray(candidate.rewards)
      ? candidate.rewards
          .filter((reward) => reward && typeof reward.id === "string" && typeof reward.title === "string")
          .slice(0, 1000)
          .map((reward) => ({
            id: reward.id,
            title: reward.title.trim().slice(0, 60) || "Untitled reward",
            description: String(reward.description || "").trim().slice(0, 160),
            icon: String(reward.icon || "🎁").trim().slice(0, 8) || "🎁",
            threshold: Math.min(1_000_000, Math.max(1, Math.round(Number(reward.threshold) || 100))),
            active: reward.active !== false,
            createdAt: reward.createdAt || new Date().toISOString(),
            updatedAt: reward.updatedAt || undefined
          }))
      : [];

    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const completions = Array.isArray(candidate.completions)
      ? candidate.completions
          .filter((completion) => completion && typeof completion.id === "string" && userIds.has(completion.userId) && completion.completedAt)
          .map((completion) => {
            const task = taskMap.get(completion.taskId);
            const completedAt = new Date(completion.completedAt);
            if (Number.isNaN(completedAt.getTime())) return null;
            const base = {
              id: completion.id,
              taskId: typeof completion.taskId === "string" ? completion.taskId : "deleted-task",
              userId: completion.userId,
              taskTitle: String(completion.taskTitle || task?.title || "Completed quest").slice(0, 60),
              xp: validXp(completion.xp),
              frequency: FREQUENCY_ORDER.includes(completion.frequency) ? completion.frequency : task?.frequency || "daily",
              completedAt: completedAt.toISOString()
            };
            return reindexCompletion(base, timezone);
          })
          .filter(Boolean)
      : [];

    const preferredUserId = typeof candidate.selectedUserId === "string" ? candidate.selectedUserId : null;

    return {
      version: 4,
      timezone,
      streakResetMonthly,
      selectedUserId: userIds.has(preferredUserId) ? preferredUserId : null,
      users,
      tasks,
      rewards,
      completions
    };
  }

  function createSeedState() {
    const createdAt = new Date().toISOString();
    const users = [
      { id: "user-parent", name: "Parent", avatar: "🛡️", colour: "#5038c8", role: "admin", createdAt },
      { id: "user-mia", name: "Mia", avatar: "🦊", colour: "#6d5dfc", role: "player", createdAt },
      { id: "user-leo", name: "Leo", avatar: "🐯", colour: "#f28b42", role: "player", createdAt },
      { id: "user-ava", name: "Ava", avatar: "🐼", colour: "#2f9d77", role: "player", createdAt }
    ];
    const tasks = [
      { id: "task-mia-bed", userId: "user-mia", title: "Make the bed", description: "Duvet straight and pillows in place", frequency: "daily", xp: 10, active: true, createdAt },
      { id: "task-mia-teeth", userId: "user-mia", title: "Evening teeth", description: "Brush for two minutes before bed", frequency: "daily", xp: 10, active: true, createdAt },
      { id: "task-mia-laundry", userId: "user-mia", title: "Put laundry away", description: "Fold it and place it in the right drawers", frequency: "weekly", xp: 35, active: true, createdAt },
      { id: "task-mia-room", userId: "user-mia", title: "Bedroom reset", description: "Clear surfaces and tidy the floor", frequency: "monthly", xp: 80, active: true, createdAt },
      { id: "task-leo-cat", userId: "user-leo", title: "Feed the cat", description: "Fresh food and clean water", frequency: "daily", xp: 15, active: true, createdAt },
      { id: "task-leo-bag", userId: "user-leo", title: "Pack school bag", description: "Books, homework and water bottle", frequency: "daily", xp: 10, active: true, createdAt },
      { id: "task-leo-recycling", userId: "user-leo", title: "Help with recycling", description: "Sort paper, cans and plastic", frequency: "weekly", xp: 40, active: true, createdAt },
      { id: "task-leo-bike", userId: "user-leo", title: "Clean the bike", description: "Wipe the frame and check the tyres", frequency: "monthly", xp: 75, active: true, createdAt },
      { id: "task-ava-plate", userId: "user-ava", title: "Clear breakfast plate", description: "Take dishes to the kitchen", frequency: "daily", xp: 10, active: true, createdAt },
      { id: "task-ava-read", userId: "user-ava", title: "Read for 20 minutes", description: "Choose any book and settle somewhere quiet", frequency: "daily", xp: 20, active: true, createdAt },
      { id: "task-ava-plants", userId: "user-ava", title: "Water the plants", description: "Check the soil before watering", frequency: "weekly", xp: 30, active: true, createdAt },
      { id: "task-ava-toys", userId: "user-ava", title: "Sort the toy shelf", description: "Return everything to its labelled box", frequency: "monthly", xp: 70, active: true, createdAt }
    ];

    const rewards = [
      { id: "reward-dessert", title: "Choose Friday's dessert", description: "Pick the family dessert for Friday evening.", icon: "🍨", threshold: 100, active: true, createdAt },
      { id: "reward-movie", title: "Choose movie night", description: "Choose the film for the next family movie night.", icon: "🎬", threshold: 250, active: true, createdAt },
      { id: "reward-adventure", title: "Plan a family adventure", description: "Choose a weekend activity for the family.", icon: "🗺️", threshold: 500, active: true, createdAt }
    ];

    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const now = new Date();
    const completions = [
      createCompletionForSeed(taskMap.get("task-mia-bed"), shiftedDate(now, -90), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-mia-laundry"), shiftedDate(now, -70), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-leo-cat"), shiftedDate(now, -130), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-leo-bag"), shiftedDate(now, -110), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-ava-plate"), shiftedDate(now, -150), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-ava-read"), shiftedDate(now, -100), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-ava-plants"), shiftedDate(now, -75), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-mia-teeth"), shiftedDate(now, -(24 * 60 + 40)), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-leo-cat"), shiftedDate(now, -(24 * 60 + 80)), DEFAULT_TIMEZONE),
      createCompletionForSeed(taskMap.get("task-ava-plate"), shiftedDate(now, -(24 * 60 + 100)), DEFAULT_TIMEZONE)
    ].filter(Boolean);

    return {
      version: 4,
      timezone: DEFAULT_TIMEZONE,
      streakResetMonthly: false,
      selectedUserId: null,
      users,
      tasks,
      rewards,
      completions
    };
  }

  function createCompletionForSeed(task, date, timezone) {
    if (!task) return null;
    const keys = periodKeys(date, timezone);
    return {
      id: makeId("completion"),
      taskId: task.id,
      userId: task.userId,
      taskTitle: task.title,
      xp: task.xp,
      frequency: task.frequency,
      completedAt: date.toISOString(),
      dayKey: keys.dayKey,
      weekKey: keys.weekKey,
      monthKey: keys.monthKey,
      periodKey: keys[periodPropertyForFrequency(task.frequency)]
    };
  }

  function shiftedDate(date, minutesAgo) {
    return new Date(date.getTime() + minutesAgo * 60_000);
  }

  function ensureValidSelection() {
    if (!state.users.length) state = createSeedState();
    const sessionUser = currentSessionUser && state.users.find((user) => user.id === currentSessionUser.id);
    if (!sessionUser) {
      currentSessionUser = null;
      state.selectedUserId = null;
      return;
    }
    currentSessionUser = sessionUser;
    state.selectedUserId = sessionUser.id;
  }

  function getSelectedUser() {
    return state.users.find((user) => user.id === state.selectedUserId) || null;
  }

  function launchConfetti() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const count = 34;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.setProperty("--hue", String(Math.floor(Math.random() * 360)));
      piece.style.setProperty("--duration", `${1.7 + Math.random() * 1.3}s`);
      piece.style.setProperty("--rotation", `${Math.floor(Math.random() * 360)}deg`);
      piece.style.setProperty("--drift", `${-80 + Math.random() * 160}px`);
      piece.style.animationDelay = `${Math.random() * 0.22}s`;
      fragment.append(piece);
    }
    elements.confettiLayer.append(fragment);
    window.setTimeout(() => elements.confettiLayer.replaceChildren(), 3_300);
  }

  function showToast(title, detail, icon = "✓") {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<strong aria-hidden="true">${escapeHtml(icon)}</strong><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4_000);
  }

  function isValidTimezone(timezone) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format();
      return true;
    } catch {
      return false;
    }
  }

  function safeColour(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#6d5dfc";
  }

  function validXp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
  }

  function makeId(prefix) {
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("en-GB").format(value || 0);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})().catch((error) => {
  console.error("Questboard failed to start.", error);
  document.body.innerHTML = `<main style="max-width:42rem;margin:4rem auto;padding:1.5rem;font-family:system-ui"><h1>Questboard could not start</h1><p>Refresh the page or check that the server is running.</p></main>`;
});
