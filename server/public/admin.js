(function () {
  const listEl = document.getElementById("template-list");
  const statusEl = document.getElementById("status");
  const uploadBtn = document.getElementById("upload-btn");
  const fileInput = document.getElementById("file-input");
  const uploadNameInput = document.getElementById("upload-name");

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  async function apiFetch(path, opts) {
    const res = await fetch("/admin/api" + path, opts);
    return res;
  }

  async function loadTemplates() {
    setStatus("Loading...");
    try {
      const res = await apiFetch("/templates");
      if (!res.ok) {
        setStatus("Failed to load templates.");
        return;
      }
      const templates = await res.json();
      setStatus("");
      renderList(templates);
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  }

  function renderList(templates) {
    listEl.innerHTML = "";
    templates.forEach((name, idx) => {
      const row = document.createElement("div");
      row.className = "template-row";
      row.dataset.name = name;

      const nameSpan = document.createElement("span");
      nameSpan.className = "template-name";
      nameSpan.textContent = name;

      const upBtn = document.createElement("button");
      upBtn.textContent = "Up";
      upBtn.disabled = idx === 0;
      upBtn.addEventListener("click", () => move(templates, idx, -1));

      const downBtn = document.createElement("button");
      downBtn.textContent = "Down";
      downBtn.disabled = idx === templates.length - 1;
      downBtn.addEventListener("click", () => move(templates, idx, 1));

      const renameBtn = document.createElement("button");
      renameBtn.textContent = "Rename";
      renameBtn.addEventListener("click", () => startRename(row, name, nameSpan, renameBtn));

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => doDelete(name));

      row.appendChild(nameSpan);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      row.appendChild(renameBtn);
      row.appendChild(deleteBtn);
      listEl.appendChild(row);
    });
  }

  async function move(templates, idx, dir) {
    const newOrder = templates.slice();
    const tmp = newOrder[idx + dir];
    newOrder[idx + dir] = newOrder[idx];
    newOrder[idx] = tmp;

    setStatus("Saving order...");
    try {
      const res = await apiFetch("/templates/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: newOrder }),
      });
      if (!res.ok) {
        setStatus("Failed to reorder.");
        return;
      }
      setStatus("");
      renderList(newOrder);
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  }

  function startRename(row, oldName, nameSpan, renameBtn) {
    const input = document.createElement("input");
    input.className = "rename-input";
    input.value = oldName;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    renameBtn.textContent = "Save";
    renameBtn.replaceWith(renameBtn.cloneNode(true));
    const saveBtn = row.querySelector("button:nth-of-type(3)");
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => commitRename(row, oldName, input, saveBtn));

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commitRename(row, oldName, input, saveBtn);
      if (e.key === "Escape") loadTemplates();
    });
  }

  async function commitRename(row, oldName, input, saveBtn) {
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      loadTemplates();
      return;
    }

    setStatus("Renaming...");
    try {
      const res = await apiFetch("/templates/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldName, newName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus("Error: " + (body.error || res.status));
        return;
      }
      setStatus("Renamed.");
      loadTemplates();
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  }

  async function doDelete(name) {
    if (!confirm(`Delete "${name}"?`)) return;

    setStatus("Deleting...");
    try {
      const res = await apiFetch(
        "/templates/" + encodeURIComponent(name),
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus("Error: " + (body.error || res.status));
        return;
      }
      setStatus("Deleted.");
      loadTemplates();
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  }

  uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) {
      setStatus("Select a .docx file first.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    const customName = uploadNameInput.value.trim();
    if (customName) {
      formData.append("name", customName);
    }

    setStatus("Uploading...");
    try {
      const res = await apiFetch("/templates/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus("Error: " + (body.error || res.status));
        return;
      }
      fileInput.value = "";
      uploadNameInput.value = "";
      setStatus("Uploaded.");
      loadTemplates();
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  });

  loadTemplates();
})();
