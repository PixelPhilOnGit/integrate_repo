import { useEffect, useState } from "react";
import { createBalloon, deleteBalloon, fetchBalloons, updateBalloon } from "./api";

const EMPTY_FORM = { name1: "", name2: "" };

export default function BalloonSection({ isAdmin, adminPassword, onChanged }) {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_FORM);

  async function load() {
    setItems(await fetchBalloons());
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name1.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await createBalloon(form);
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
    setEditDraft({ name1: item.name1, name2: item.name2 || "" });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id) {
    setError("");
    try {
      await updateBalloon(id, editDraft, adminPassword);
      setEditingId(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("确定删除这个气球署名吗？")) return;
    try {
      await deleteBalloon(id, adminPassword);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="card">
      <h2>气球署名登记</h2>
      <p className="hint">每个气球固定金额，最多可以写两个名字</p>
      {error && <div className="error-text">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="row2">
          <div>
            <label>姓名 1</label>
            <input
              type="text"
              required
              placeholder="气球上写的名字"
              value={form.name1}
              onChange={(e) => setForm((f) => ({ ...f, name1: e.target.value }))}
            />
          </div>
          <div>
            <label>姓名 2（可选）</label>
            <input
              type="text"
              placeholder="第二个名字（选填）"
              value={form.name2}
              onChange={(e) => setForm((f) => ({ ...f, name2: e.target.value }))}
            />
          </div>
        </div>
        <button type="submit" disabled={submitting}>
          {submitting ? "提交中..." : "添加气球"}
        </button>
      </form>

      {items.length === 0 ? (
        <div className="empty">还没有气球署名</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>序号</th>
                <th>姓名 1</th>
                <th>姓名 2</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((r, idx) =>
                editingId === r.id ? (
                  <tr key={r.id}>
                    <td>{idx + 1}</td>
                    <td>
                      <input
                        type="text"
                        value={editDraft.name1}
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, name1: e.target.value }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={editDraft.name2}
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, name2: e.target.value }))
                        }
                      />
                    </td>
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
                    <td>{idx + 1}</td>
                    <td>{r.name1}</td>
                    <td>{r.name2}</td>
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
