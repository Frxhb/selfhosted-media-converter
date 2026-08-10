let subscriptionsCache = [];
      let subscriptionEditingId = null;

      async function refreshSubscriptions() {
        try {
          const res = await fetch("/api/subscriptions");
          subscriptionsCache = await res.json();
        } catch (e) {
          showToast(t("toast.subs_load_failed"), "warn");
          subscriptionsCache = [];
        }
        renderSubscriptionList();
      }

      function formatSubscriptionInterval(minutes) {
        if (minutes % 1440 === 0) return t("subscriptions.interval_days").replace("{n}", minutes / 1440);
        if (minutes % 60 === 0) return t("subscriptions.interval_hours").replace("{n}", minutes / 60);
        return t("subscriptions.interval_minutes").replace("{n}", minutes);
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
          return t("subscriptions.error_last_check").replace("{date}", date);
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
            const linkedPipeline = sub.pipeline_id
              ? pipelinesCache.find((p) => p.id === sub.pipeline_id)
              : null;
            const pipelineBadge = linkedPipeline
              ? `<span class="status-badge" style="background:var(--signal-dim); color:var(--signal);" title="${t('subscriptions.pipeline_label', 'Pipeline nach Download:')}">🔗 ${escapeHtml(linkedPipeline.name)}</span>`
              : "";

            return `
                <div class="card" style="padding:0.7rem 0.9rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                    <div style="min-width:0;">
                        <div style="font-weight:600; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                            ${escapeHtml(sub.name)}
                            ${activeBadge}
                            ${pipelineBadge}
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
        document.getElementById("sub-edit-exclude-shorts").checked = sub
          ? !!sub.exclude_shorts
          : false;

        const pipelineSelect = document.getElementById("sub-edit-pipeline");
        if (pipelineSelect) {
          const noneLabel = t("subscriptions.pipeline_none", "Keine (nur herunterladen)");
          pipelineSelect.innerHTML =
            `<option value="">${noneLabel}</option>` +
            pipelinesCache
              .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
              .join("");
          pipelineSelect.value = sub && sub.pipeline_id ? sub.pipeline_id : "";
        }

        openModal("subscription-editor-modal");
      }

      async function saveSubscriptionFromEditor() {
        const name = document.getElementById("sub-edit-name").value.trim();
        const url = document.getElementById("sub-edit-url").value.trim();
        if (!name) return showToast(t("toast.name_required"), "warn");
        if (!url) return showToast(t("toast.url_required"), "warn");

        const intervalValue = parseInt(
          document.getElementById("sub-edit-interval-value").value,
          10,
        );
        const intervalUnit = parseInt(
          document.getElementById("sub-edit-interval-unit").value,
          10,
        );
        if (!intervalValue || intervalValue < 1) {
          return showToast(t("toast.interval_invalid"), "warn");
        }
        const checkIntervalMinutes = intervalValue * intervalUnit;
        if (checkIntervalMinutes < 5) {
          return showToast(t("toast.interval_min_5"), "warn");
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
          exclude_shorts: document.getElementById("sub-edit-exclude-shorts").checked,
          pipeline_id: document.getElementById("sub-edit-pipeline").value || null,
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
            showToast(err.detail || t("toast.save_failed_generic"), "warn");
            return;
          }
          showToast(t("toast.sub_saved"), "success");
          closeModal("subscription-editor-modal");
          refreshSubscriptions();
        } catch (e) {
          showToast(t("toast.sub_save_failed"), "warn");
        }
      }

      async function deleteSubscription(subId) {
        if (!confirm(t("confirm.delete_subscription"))) return;
        try {
          const res = await fetch(`/api/subscriptions/${subId}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            showToast(t("toast.delete_failed"), "warn");
            return;
          }
          showToast(t("toast.sub_deleted"), "success");
          refreshSubscriptions();
        } catch (e) {
          showToast(t("toast.delete_error"), "warn");
        }
      }

      async function checkSubscriptionNow(subId) {
        showToast(t("toast.checking_new_videos"), "info");
        try {
          const res = await fetch(`/api/subscriptions/${subId}/check-now`, {
            method: "POST",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showToast(data.detail || t("toast.check_failed_generic"), "warn");
            return;
          }
          if (data.status === "error") {
            showToast(t("toast.check_error_detail").replace("{detail}", data.detail), "warn", 7000);
          } else if (data.status === "skipped") {
            showToast(t("toast.check_already_running"), "info");
          } else if (data.seeded !== undefined) {
            showToast(
              t("toast.seed_result").replace("{count}", data.seeded),
              "info",
              8000,
            );
          } else {
            showToast(
              data.queued > 0
                ? t("toast.new_videos_downloading").replace("{count}", data.queued)
                : t("toast.no_new_videos"),
              "success",
            );
          }
          refreshSubscriptions();
        } catch (e) {
          showToast(t("toast.check_error"), "warn");
        }
      }

      async function checkAllSubscriptionsNow() {
        if (subscriptionsCache.length === 0) {
          return showToast(t("toast.no_subs"), "warn");
        }
        const enabledSubs = subscriptionsCache.filter((s) => s.enabled);
        if (enabledSubs.length === 0) {
          return showToast(t("toast.no_active_subs"), "warn");
        }

        showToast(
          t("toast.checking_subs_count").replace("{count}", enabledSubs.length),
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
            t("toast.check_complete").replace("{queued}", totalQueued).replace("{errors}", totalErrors),
            "warn",
            6000,
          );
        } else {
          showToast(
            totalQueued > 0
              ? t("toast.check_complete_success").replace("{count}", totalQueued)
              : t("toast.check_complete_none"),
            "success",
          );
        }
      }
