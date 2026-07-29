import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from io import BytesIO
from typing import List, Optional
from urllib.parse import quote

import openpyxl
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openpyxl.styles import Font
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")

# 管理密码：删除记录时校验，部署前建议通过环境变量覆盖
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "1234")

# 每个气球的固定单价，用于和出资记录里的气球钱对账
BALLOON_UNIT_PRICE = float(os.environ.get("BALLOON_UNIT_PRICE", "50"))

app = FastAPI(title="鞭子气球随礼登记 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS contributions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                relation TEXT,
                firecracker_amount REAL NOT NULL DEFAULT 0,
                balloon_amount REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS balloons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name1 TEXT NOT NULL,
                name2 TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


@app.on_event("startup")
def on_startup():
    init_db()


def clamp_amount(v: float) -> float:
    return v if v and v > 0 else 0.0


# ---------- 出资记录 ----------


class ContributionIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    relation: Optional[str] = ""
    firecracker_amount: float = 0
    balloon_amount: float = 0


class ContributionOut(BaseModel):
    id: int
    name: str
    relation: Optional[str] = ""
    firecracker_amount: float
    balloon_amount: float
    created_at: str


@app.get("/api/contributions", response_model=List[ContributionOut])
def list_contributions():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM contributions ORDER BY id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/contributions", response_model=ContributionOut)
def create_contribution(item: ContributionIn):
    name = item.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="姓名不能为空")

    created_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO contributions
                (name, relation, firecracker_amount, balloon_amount, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                name,
                (item.relation or "").strip(),
                clamp_amount(item.firecracker_amount),
                clamp_amount(item.balloon_amount),
                created_at,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM contributions WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return dict(row)


@app.put("/api/contributions/{item_id}", response_model=ContributionOut)
def update_contribution(
    item_id: int, item: ContributionIn, x_admin_password: Optional[str] = Header(None)
):
    if x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="管理密码错误")
    name = item.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="姓名不能为空")

    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM contributions WHERE id = ?", (item_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="记录不存在")
        conn.execute(
            """
            UPDATE contributions
            SET name = ?, relation = ?, firecracker_amount = ?, balloon_amount = ?
            WHERE id = ?
            """,
            (
                name,
                (item.relation or "").strip(),
                clamp_amount(item.firecracker_amount),
                clamp_amount(item.balloon_amount),
                item_id,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM contributions WHERE id = ?", (item_id,)
        ).fetchone()
    return dict(row)


@app.delete("/api/contributions/{item_id}")
def delete_contribution(item_id: int, x_admin_password: Optional[str] = Header(None)):
    if x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="管理密码错误")
    with get_conn() as conn:
        conn.execute("DELETE FROM contributions WHERE id = ?", (item_id,))
        conn.commit()
    return {"ok": True}


# ---------- 气球署名记录 ----------


class BalloonIn(BaseModel):
    name1: str = Field(..., min_length=1, max_length=50)
    name2: Optional[str] = ""


class BalloonOut(BaseModel):
    id: int
    name1: str
    name2: Optional[str] = ""
    created_at: str


@app.get("/api/balloons", response_model=List[BalloonOut])
def list_balloons():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM balloons ORDER BY id ASC").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/balloons", response_model=BalloonOut)
def create_balloon(item: BalloonIn):
    name1 = item.name1.strip()
    if not name1:
        raise HTTPException(status_code=422, detail="至少填写一个名字")

    created_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO balloons (name1, name2, created_at) VALUES (?, ?, ?)",
            (name1, (item.name2 or "").strip(), created_at),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM balloons WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return dict(row)


@app.put("/api/balloons/{item_id}", response_model=BalloonOut)
def update_balloon(
    item_id: int, item: BalloonIn, x_admin_password: Optional[str] = Header(None)
):
    if x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="管理密码错误")
    name1 = item.name1.strip()
    if not name1:
        raise HTTPException(status_code=422, detail="至少填写一个名字")

    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM balloons WHERE id = ?", (item_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="记录不存在")
        conn.execute(
            "UPDATE balloons SET name1 = ?, name2 = ? WHERE id = ?",
            (name1, (item.name2 or "").strip(), item_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM balloons WHERE id = ?", (item_id,)
        ).fetchone()
    return dict(row)


@app.delete("/api/balloons/{item_id}")
def delete_balloon(item_id: int, x_admin_password: Optional[str] = Header(None)):
    if x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="管理密码错误")
    with get_conn() as conn:
        conn.execute("DELETE FROM balloons WHERE id = ?", (item_id,))
        conn.commit()
    return {"ok": True}


# ---------- 统计 / 对账 ----------


class ContributionStats(BaseModel):
    count: int
    total_firecracker: float
    total_balloon: float
    total_all: float


class BalloonStats(BaseModel):
    count: int
    unit_price: float
    total_amount: float


class Stats(BaseModel):
    contribution: ContributionStats
    balloon: BalloonStats


@app.get("/api/stats", response_model=Stats)
def stats():
    with get_conn() as conn:
        contrib_rows = conn.execute(
            "SELECT firecracker_amount, balloon_amount FROM contributions"
        ).fetchall()
        balloon_count = conn.execute("SELECT COUNT(*) AS c FROM balloons").fetchone()[
            "c"
        ]

    total_fc = sum(r["firecracker_amount"] for r in contrib_rows)
    total_bl = sum(r["balloon_amount"] for r in contrib_rows)

    return Stats(
        contribution=ContributionStats(
            count=len(contrib_rows),
            total_firecracker=total_fc,
            total_balloon=total_bl,
            total_all=total_fc + total_bl,
        ),
        balloon=BalloonStats(
            count=balloon_count,
            unit_price=BALLOON_UNIT_PRICE,
            total_amount=balloon_count * BALLOON_UNIT_PRICE,
        ),
    )


class AdminVerify(BaseModel):
    password: str


@app.post("/api/admin/verify")
def admin_verify(payload: AdminVerify):
    return {"ok": payload.password == ADMIN_PASSWORD}


# ---------- 导出 ----------


def download_headers(filename: str) -> dict:
    return {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}


def fetch_export_data():
    with get_conn() as conn:
        contributions = conn.execute(
            "SELECT * FROM contributions ORDER BY id ASC"
        ).fetchall()
        balloons = conn.execute("SELECT * FROM balloons ORDER BY id ASC").fetchall()
    return contributions, balloons


@app.get("/api/export/excel")
def export_excel():
    contributions, balloons = fetch_export_data()

    wb = openpyxl.Workbook()
    ws1 = wb.active
    ws1.title = "出资记录"
    ws1.append(["人员", "关系", "鞭子", "气球", "总计", "登记时间"])
    total_fc = total_bl = 0.0
    for r in contributions:
        total = r["firecracker_amount"] + r["balloon_amount"]
        total_fc += r["firecracker_amount"]
        total_bl += r["balloon_amount"]
        ws1.append(
            [
                r["name"],
                r["relation"] or "",
                r["firecracker_amount"],
                r["balloon_amount"],
                total,
                r["created_at"],
            ]
        )
    ws1.append(["合计", "", total_fc, total_bl, total_fc + total_bl, ""])

    ws2 = wb.create_sheet("气球署名")
    ws2.append(["序号", "姓名1", "姓名2", "登记时间"])
    for i, r in enumerate(balloons, start=1):
        ws2.append([i, r["name1"], r["name2"] or "", r["created_at"]])
    ws2.append([])
    ws2.append(["气球数量", len(balloons)])
    ws2.append(["气球单价", BALLOON_UNIT_PRICE])
    ws2.append(["气球总金额", len(balloons) * BALLOON_UNIT_PRICE])

    for ws in (ws1, ws2):
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for col in ws.columns:
            length = max((len(str(c.value)) for c in col if c.value is not None), default=0)
            ws.column_dimensions[col[0].column_letter].width = max(10, length + 2)

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"随礼登记_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=download_headers(filename),
    )


@app.get("/api/export/pdf")
def export_pdf():
    contributions, balloons = fetch_export_data()

    styles = getSampleStyleSheet()
    style_h = ParagraphStyle(
        "h", parent=styles["Heading1"], fontName="STSong-Light", fontSize=16
    )
    style_n = ParagraphStyle(
        "n", parent=styles["Normal"], fontName="STSong-Light", fontSize=10
    )
    cell_style = TableStyle(
        [
            ("FONTNAME", (0, 0), (-1, -1), "STSong-Light"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f5e6c8")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
    )

    elements = [Paragraph("鞭子气球随礼登记", style_h), Spacer(1, 12)]

    elements.append(Paragraph("出资记录", style_n))
    elements.append(Spacer(1, 4))
    data1 = [["人员", "关系", "鞭子", "气球", "总计"]]
    total_fc = total_bl = 0.0
    for r in contributions:
        total = r["firecracker_amount"] + r["balloon_amount"]
        total_fc += r["firecracker_amount"]
        total_bl += r["balloon_amount"]
        data1.append(
            [
                r["name"],
                r["relation"] or "",
                f"{r['firecracker_amount']:.0f}",
                f"{r['balloon_amount']:.0f}",
                f"{total:.0f}",
            ]
        )
    data1.append(["合计", "", f"{total_fc:.0f}", f"{total_bl:.0f}", f"{total_fc + total_bl:.0f}"])
    t1 = Table(data1, hAlign="LEFT")
    t1.setStyle(cell_style)
    elements += [t1, Spacer(1, 18)]

    elements.append(Paragraph("气球署名", style_n))
    elements.append(Spacer(1, 4))
    data2 = [["序号", "姓名1", "姓名2"]]
    for i, r in enumerate(balloons, start=1):
        data2.append([str(i), r["name1"], r["name2"] or ""])
    t2 = Table(data2, hAlign="LEFT")
    t2.setStyle(cell_style)
    elements += [t2, Spacer(1, 10)]

    summary = (
        f"气球数量 {len(balloons)} 个 × 单价 ¥{BALLOON_UNIT_PRICE:.0f}"
        f" = ¥{len(balloons) * BALLOON_UNIT_PRICE:.0f}"
    )
    elements.append(Paragraph(summary, style_n))

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, title="随礼登记")
    doc.build(elements)
    buf.seek(0)
    filename = f"随礼登记_{datetime.now().strftime('%Y%m%d_%H%M')}.pdf"
    return StreamingResponse(buf, media_type="application/pdf", headers=download_headers(filename))
