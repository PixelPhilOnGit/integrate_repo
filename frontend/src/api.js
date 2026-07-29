const API_BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `请求失败 (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export function fetchStats() {
  return request("/stats");
}

export function verifyAdminPassword(password) {
  return request("/admin/verify", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// ---- 出资记录 ----

export function fetchContributions() {
  return request("/contributions");
}

export function createContribution(data) {
  return request("/contributions", { method: "POST", body: JSON.stringify(data) });
}

export function updateContribution(id, data, password) {
  return request(`/contributions/${id}`, {
    method: "PUT",
    headers: { "X-Admin-Password": password },
    body: JSON.stringify(data),
  });
}

export function deleteContribution(id, password) {
  return request(`/contributions/${id}`, {
    method: "DELETE",
    headers: { "X-Admin-Password": password },
  });
}

// ---- 气球署名记录 ----

export function fetchBalloons() {
  return request("/balloons");
}

export function createBalloon(data) {
  return request("/balloons", { method: "POST", body: JSON.stringify(data) });
}

export function updateBalloon(id, data, password) {
  return request(`/balloons/${id}`, {
    method: "PUT",
    headers: { "X-Admin-Password": password },
    body: JSON.stringify(data),
  });
}

export function deleteBalloon(id, password) {
  return request(`/balloons/${id}`, {
    method: "DELETE",
    headers: { "X-Admin-Password": password },
  });
}

export const EXPORT_EXCEL_URL = `${API_BASE}/export/excel`;
export const EXPORT_PDF_URL = `${API_BASE}/export/pdf`;
