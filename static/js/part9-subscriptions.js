let subscriptionsCache = [];
      let subscriptionEditingId = null;

      async function refreshSubscriptions() {
        try {
          const res = await fetch("/api/subscriptions");
          subscriptionsCache = await res.json();
        } catch (e) {
          showToast("Abonnements konnten nicht geladen werden.", "warn");
          subscriptionsCache = [];
        }
        renderSubscriptionList();
      }

      function formatSubscriptionInterval(minutes) {
        if (minutes % 1440 === 0) return `Every ${minutes / 1440} day(s)`;
        if (minutes % 60 === 0) return `Every ${minutes / 60} hour(s)`;
        return `Every ${minutes} min.`;
      }

      function formatSubscriptionLastCheck(sub) {
        if (!sub.last_checked_at) return t('subscriptions.last_checked_never', 'Noch nie geprüft');
        const lang = currentLang === 'de' ? 'de-DE' : 'en-US';
        const date = new Date(sub.last_checked_at).toLocaleString(lang, {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        if (sub.last_check_status === "error") {
          return `⚠️ Error during last check (${date})`;
        }
        return `${t('subscriptions.last_checked', 'Zuletzt geprüft:')} ${date} · ${sub.last_check_new_count} ${t('subscriptions.new_count', 'neu')}`;
      }

      function renderSubscriptionList() {
        const container = document.getElementById("subscription-list");
        if (!container) return;
        if (subscriptionsCache.length === 0) {
          container.innerHTML = `<div style="color:var(--ink-dim); font-size:0.85rem;">${t('subscriptions.no_subs_yet', 'Noch keine Abonnements angelegt.')}</div>`;
          return;
        }
        container.innerHTML = subscriptionsCache
          .map((sub) => {
            const statusColor =
              sub.last_check_status === "error" ? "var(--danger)" : "var(--ink-dim)";
            const activeBadge = sub.enabled
              ? `<span class="status-badge" style="background:var(--ok-dim); color:var(--ok);">${t('subscriptions.active', 'Aktiv')}</span>`
              : `<span class="status-badge" style="background:var(--surface-sunken); border:1px solid var(--line); color:var(--ink-dim);">${t('subscriptions.paused', 'Pausiert')}</span>`;

            return `
                <div class="card" style="padding:0.7rem 0.9rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                    <div style="min-width:0;">
                        <div style="font-weight:600; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                            ${escapeHtml(sub.name)}
                            ${activeBadge}
                        </div>
                        <div style="font-size:0.72rem; color:var(--ink-dim); margin-top:0.3rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:420px;" title="${escapeHtml(sub.url)}">
                            ${escapeHtml(sub.url)}
                        </div>
                        <div style="font-size:0.72rem; margin-top:0.3rem; color:${statusColor};">
                            ${formatSubscriptionInterval(sub.check_interval_minutes)} · ${formatSubscriptionLastCheck(sub)}
                            ${sub.total_downloaded > 0 ? ` · ${sub.total_downloaded} ${t('subscriptions.total_downloaded', 'insgesamt geladen')}` : ""}
                        </div>
                        ${sub.last_check_status === "error" && sub.last_check_error ? `<div style="font-size:0.7rem; color:var(--danger); margin-top:0.25rem;">${escapeHtml(sub.last_check_error)}</div>` : ""}
                    </div>
                    <div style="display:flex; gap:0.4rem; flex-shrink:0;">
                        <button onclick="checkSubscriptionNow('${sub.id}')" class="btn btn-secondary" style="padding:0.3rem 0.7rem;">${t('subscriptions.check_now', 'Jetzt prüfen')}</button>
                        <button onclick="openSubscriptionEditor('${sub.id}')" class="btn btn-secondary" style="padding:0.3rem 0.7rem;">${t('common.edit', 'Bearbeiten')}</button>
                        <button onclick="deleteSubscription('${sub.id}')" class="btn btn-danger" style="padding:0.3rem 0.7rem;">${t('common.delete', 'Löschen')}</button>
                    </div>
                </div>`;
          })
          .join("");
      }

      function onSubscriptionTypeChange() {
        const type = document.getElementById("sub-edit-type").value;
        const qualitySelect = document.getElementById("sub-edit-quality");
        const qualityLabel = document.getElementById("sub-edit-quality-label");
        const containerSelect = document.getElementById("sub-edit-container");

        if (type === "audio") {
          qualityLabel.textContent = t('subscriptions.quality_label', 'Audioqualität:');
          qualitySelect.innerHTML = MediaOptions.audio.bitrates.map((q) => `<option value="${q.val}">${getOptionLabel(q.val, q.label)}</option>`).join("");
          containerSelect.innerHTML = MediaOptions.audio.formats.map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join("");
        } else {
          qualityLabel.textContent = t('subscriptions.quality_label', 'Qualität:');
          qualitySelect.innerHTML = MediaOptions.video.resolutions.map((q) => `<option value="${q.val}">${getOptionLabel(q.val, q.label)}</option>`).join("");
          containerSelect.innerHTML = MediaOptions.video.downloadContainers.map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join("");
        }
      }

      function minutesToIntervalParts(totalMinutes) {
        if (totalMinutes % 1440 === 0 && totalMinutes >= 1440) {
          return { value: totalMinutes / 1440, unit: "1440" };
        }
        if (totalMinutes % 60 === 0 && totalMinutes >= 60) {
          return { value: totalMinutes / 60, unit: "60" };
        }
        return { value: totalMinutes, unit: "1" };
      }

      function openSubscriptionEditor(subId) {
        subscriptionEditingId = subId;
        const sub = subId ? subscriptionsCache.find((s) => s.id === subId) : null;

        document.getElementById("subscription-editor-title").textContent = sub
          ? t('subscriptions.modal_edit_title', 'Abonnement bearbeiten')
          : t('subscriptions.modal_new_title', 'Neues Abonnement');
        document.getElementById("sub-edit-name").value = sub ? sub.name : "";
        document.getElementById("sub-edit-url").value = sub ? sub.url : "";
        document.getElementById("sub-edit-type").value = sub ? sub.download_type : "video";
        onSubscriptionTypeChange();
        document.getElementById("sub-edit-quality").value = sub ? sub.quality : "best";
        document.getElementById("sub-edit-container").value = sub ? sub.container : "mp4";

        const intervalParts = minutesToIntervalParts(
          sub ? sub.check_interval_minutes : 360,
        );
        document.getElementById("sub-edit-interval-value").value =
          intervalParts.value;
        document.getElementById("sub-edit-interval-unit").value =
          intervalParts.unit;

        document.getElementById("sub-edit-max-items").value = sub
          ? sub.max_items_per_check
          : 25;
        document.getElementById("sub-edit-backfill").value = sub
          ? sub.backfill_count ?? 0
          : 0;
        // Backfill ist nur beim ERSTEN Check einer neuen Subscription relevant - bei
        // bestehenden Abonnements (schon mind. einmal geprüft) ausblenden, da ein späteres
        // Ändern hier ohnehin nichts mehr bewirken würde.
        const backfillRow = document.getElementById("sub-edit-backfill-row");
        if (backfillRow) {
          backfillRow.style.display = sub && sub.last_checked_at ? "none" : "";
        }
        document.getElementById("sub-edit-enabled").checked = sub ? sub.enabled : true;

        openModal("subscription-editor-modal");
      }

      async function saveSubscriptionFromEditor() {
        const name = document.getElementById("sub-edit-name").value.trim();
        const url = document.getElementById("sub-edit-url").value.trim();
        if (!name) return showToast("Bitte einen Namen angeben.", "warn");
        if (!url) return showToast("Bitte eine URL angeben.", "warn");

        const intervalValue = parseInt(
          document.getElementById("sub-edit-interval-value").value,
          10,
        );
        const intervalUnit = parseInt(
          document.getElementById("sub-edit-interval-unit").value,
          10,
        );
        if (!intervalValue || intervalValue < 1) {
          return showToast("Bitte ein gültiges Prüfintervall angeben.", "warn");
        }
        const checkIntervalMinutes = intervalValue * intervalUnit;
        if (checkIntervalMinutes < 5) {
          return showToast(
            "Prüfintervall muss mindestens 5 Minuten betragen.",
            "warn",
          );
        }

        const payload = {
          name,
          url,
          download_type: document.getElementById("sub-edit-type").value,
          quality: document.getElementById("sub-edit-quality").value,
          container: document.getElementById("sub-edit-container").value,
          check_interval_minutes: checkIntervalMinutes,
          max_items_per_check: parseInt(
            document.getElementById("sub-edit-max-items").value,
            10,
          ) || 25,
          backfill_count: parseInt(
            document.getElementById("sub-edit-backfill").value,
            10,
          ) || 0,
          enabled: document.getElementById("sub-edit-enabled").checked,
        };

        try {
          const res = await fetch(
            subscriptionEditingId
              ? `/api/subscriptions/${subscriptionEditingId}`
              : "/api/subscriptions",
            {
              method: subscriptionEditingId ? "PUT" : "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || "Speichern fehlgeschlagen.", "warn");
            return;
          }
          showToast("Abonnement gespeichert.", "success");
          closeModal("subscription-editor-modal");
          refreshSubscriptions();
        } catch (e) {
          showToast("Fehler beim Speichern des Abonnements.", "warn");
        }
      }

      async function deleteSubscription(subId) {
        if (!confirm("Dieses Abonnement wirklich löschen? Bereits heruntergeladene Videos bleiben erhalten.")) return;
        try {
          const res = await fetch(`/api/subscriptions/${subId}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            showToast("Löschen fehlgeschlagen.", "warn");
            return;
          }
          showToast("Abonnement gelöscht.", "success");
          refreshSubscriptions();
        } catch (e) {
          showToast("Fehler beim Löschen.", "warn");
        }
      }

      async function checkSubscriptionNow(subId) {
        showToast("Prüfe auf neue Videos...", "info");
        try {
          const res = await fetch(`/api/subscriptions/${subId}/check-now`, {
            method: "POST",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showToast(data.detail || "Prüfung fehlgeschlagen.", "warn");
            return;
          }
          if (data.status === "error") {
            showToast(`Fehler bei der Prüfung: ${data.detail}`, "warn", 7000);
          } else if (data.status === "skipped") {
            showToast("Eine Prüfung läuft bereits.", "info");
          } else if (data.seeded !== undefined) {
            showToast(
              `Erster Check: ${data.seeded} bestehende Video(s) als bekannt markiert (kein Download). Ab jetzt werden nur neue Uploads geladen.`,
              "info",
              8000,
            );
          } else {
            showToast(
              data.queued > 0
                ? `${data.queued} neue(s) Video(s) werden heruntergeladen.`
                : "Keine neuen Videos gefunden.",
              "success",
            );
          }
          refreshSubscriptions();
        } catch (e) {
          showToast("Fehler bei der Prüfung.", "warn");
        }
      }

      async function checkAllSubscriptionsNow() {
        if (subscriptionsCache.length === 0) {
          return showToast("Keine Abonnements vorhanden.", "warn");
        }
        const enabledSubs = subscriptionsCache.filter((s) => s.enabled);
        if (enabledSubs.length === 0) {
          return showToast("Keine aktiven Abonnements vorhanden.", "warn");
        }

        showToast(
          `Prüfe ${enabledSubs.length} Abonnement(s)...`,
          "info",
          3000,
        );

        let totalQueued = 0;
        let totalErrors = 0;

        // Sequentiell statt parallel: verhindert, dass beim gleichzeitigen Prüfen mehrerer
        // aktiver Kanäle (die jeweils selbst mehrere neue Videos queuen können) erneut eine
        // Flut an WebSocket-Updates die UI einfrieren lässt.
        for (const sub of enabledSubs) {
          try {
            const res = await fetch(`/api/subscriptions/${sub.id}/check-now`, {
              method: "POST",
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.status === "ok") {
              totalQueued += data.queued || 0;
            } else if (!res.ok || data.status === "error") {
              totalErrors++;
            }
          } catch (e) {
            totalErrors++;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }

        refreshSubscriptions();

        if (totalErrors > 0) {
          showToast(
            `Prüfung abgeschlossen: ${totalQueued} neue(s) Video(s), ${totalErrors} Fehler.`,
            "warn",
            6000,
          );
        } else {
          showToast(
            totalQueued > 0
              ? `Prüfung abgeschlossen: ${totalQueued} neue(s) Video(s) werden heruntergeladen.`
              : "Prüfung abgeschlossen: keine neuen Videos gefunden.",
            "success",
          );
        }
      }
