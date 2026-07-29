import { useEffect, useState } from "react";
import {
  createContribution,
  deleteContribution,
  fetchContributions,
  updateContribution,
} from "./api";

const EMPTY_FORM = { name: "", relation: "", firecracker_amount: "", balloon_amount: "" };

function money(v) {
  return `¥${Number(v || 0).toFixed(2)}`;
}

export default function ContributionSection({ isAdmin, adminPassword, onChanged }) {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_FORM);

  async function load() {
    setItems(await fetchContributions());
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  function updateField(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await createContribution({
        ...form,
        firecracker_amount: Number(form.firecracker_amount) || 0,
        balloon_amount: Number(form.balloon_amount) || 0,
      });
      setForm(EMPTY_FORM);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(item) {
    setEditingId(item.id);
    setEditDraft({
      name: item.name,
      relation: item.relation || "",
      firecracker_amount: String(item.firecracker_amount || ""),
      balloon_amount: String(item.balloon_amount || ""),
    });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id) {
    setError("");
    try {
      await updateContribution(
        id,
        {
          ...editDraft,
          firecracker_amount: Number(editDraft.firecracker_amount) || 0,
          balloon_amount: Number(editDraft.balloon_amount) || 0,
        },
        adminPassword
      );
      setEditingId(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("确定删除这条出资记录吗？")) return;
    try {
      await deleteContribution(id, adminPassword);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="card">
      <h2>出资登记</h2>
      {error && <div className="error-text">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="row2">
          <div>
            <label>人员</label>
            <input
              type="text"
              required
              placeholder="姓名"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
            />
          </div>
          <div>
            <label>与堂哥关系</label>
            <input
              type="text"
              placeholder="如：同学 / 同事 / 亲戚"
              value={form.relation}
              onChange={(e) => updateField("relation", e.target.value)}
            />
          </div>
        </div>
        <div className="row2">
          <div>
            <label>鞭子（元）</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={form.firecracker_amount}
              onChange={(e) => updateField("firecracker_amount", e.target.value)}
            />
          </div>
          <div>
            <label>气球（元）</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={form.balloon_amount}
              onChange={(e) => updateField("balloon_amount", e.target.value)}
            />
          </div>
        </div>
        <button type="submit" disabled={submitting}>
          {submitting ? "提交中..." : "提交登记"}
        </button>
      </form>

      {items.length === 0 ? (
        <div className="empty">还没有人登记</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>人员</th>
                <th>关系</th>
                <th>鞭子</th>
                <th>气球</th>
                <th>总计</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((r) =>
                editingId === r.id ? (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="text"
                        value={editDraft.name}
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, name: e.target.value }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={editDraft.relation}
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, relation: e.target.value }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={editDraft.firecracker_amount}
                        onChange={(e) =>
                          setEditDraft((d) => ({
                            ...d,
                            firecracker_amount: e.target.value,
                          }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={editDraft.balloon_amount}
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, balloon_amount: e.target.value }))
                        }
                      />
                    </td>
                    <td>-</td>
                    <td className="row-actions">
                      <button className="btn-small" onClick={() => saveEdit(r.id)}>
                        保存
                      </button>
                      <button className="btn-small" onClick={cancelEdit}>
                        取消
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.relation && <span className="tag">{r.relation}</span>}</td>
                    <td>{r.firecracker_amount ? money(r.firecracker_amount) : "-"}</td>
                    <td>{r.balloon_amount ? money(r.balloon_amount) : "-"}</td>
                    <td>{money(r.firecracker_amount + r.balloon_amount)}</td>
                    {isAdmin && (
                      <td className="row-actions">
                        <button className="btn-small" onClick={() => startEdit(r)}>
                          编辑
                        </button>
                        <button
                          className="btn-small del-btn"
                          onClick={() => handleDelete(r.id)}
                        >
                          删除
                        </button>
                      </td>
                    )}
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
