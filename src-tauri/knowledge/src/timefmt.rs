//! 时间戳 → ISO-8601 字符串（给 frontmatter 的 `created` 用）。
//!
//! 为什么手写不引 chrono：只差这一个方向（epoch → 字符串）、只有一种格式，
//! 而算法是有名有姓的（Howard Hinnant 的 civil-from-days，公开领域）。
//! 引一个日期库来解决二十行确定性代码，不合本仓的账。
//!
//! 输出恒为 UTC（结尾 `Z`）—— 本地时区显示是前端 Intl 的事。

/// epoch 毫秒 → `2026-10-16T12:30:45Z`。
pub fn iso_from_unix_ms(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // civil_from_days：把「1970-01-01 起的天数」变成公历年月日
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y0 = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y0 + 1 } else { y0 };

    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// 现在（UTC）的 ISO 串。
pub fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    iso_from_unix_ms(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 已知时刻对得上() {
        assert_eq!(iso_from_unix_ms(0), "1970-01-01T00:00:00Z");
        // 1_700_000_000_000 ms（2023-11-14T22:13:20Z，公开的换算基准）
        assert_eq!(iso_from_unix_ms(1_700_000_000_000), "2023-11-14T22:13:20Z");
        // 闰日：2024-02-29T00:00:00Z = 1709164800000
        assert_eq!(iso_from_unix_ms(1_709_164_800_000), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn 现在_形状对() {
        let s = now_iso();
        assert_eq!(s.len(), 20, "YYYY-MM-DDTHH:MM:SSZ 恰好 20 个字符：{s}");
        assert!(s.ends_with('Z'));
    }
}
