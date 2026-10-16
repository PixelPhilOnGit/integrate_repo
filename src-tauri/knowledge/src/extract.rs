//! 文档提取：把上传的原件里**能提的文本**提出来（喂给 CLI 生成知识）。
//!
//! # 分工：提取在 Rust 做，理解在 CLI 做
//!
//! 用户的原话是「用宿主机 claude/codex 帮忙读文件」——但「读」有两种读法：
//! 把二进制里**确定性的**文本抽出来（这里，可测、不花钱），和**理解**它
//! （CLI 干）。前面的活放 Rust：pdf/docx/xlsx 的格式解析有成熟的纯 Rust
//! 库，抽出来的文本让 CLI 看到的就是干净文本，不依赖它自己会解 zip。
//!
//! 唯一的例外是**图片**（png/jpg）：没有文本可抽，整张原图直接交给 CLI 看
//!（claude 走 `--add-dir` + Read、codex 走 `-i`）。所以这里对图片返回
//! [`ExtractOutcome::None`]（不是错误）。
//!
//! # 上限是「喂给模型的字符数」
//!
//! 提取结果截到 [`MAX_CHARS`]：超了取**头 + 尾**并标出省略了多少字（中间
//! 省略）——直接头部截断会让结论性内容（文档结尾）永远到不了模型面前。
//! 截断按**字符**不按字节（多字节文字不切半）。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use crate::error::KbError;

/// 提取文本的字符上限（喂完整篇的代价是模型调用费，这里留一个体面的上限）。
pub const MAX_CHARS: usize = 120_000;

/// 提取的结果。
#[derive(Debug, Clone, PartialEq)]
pub enum ExtractOutcome {
    /// 抽到文本了（可能被截断，见 [`MAX_CHARS`]）
    Text(String),
    /// 这类文件没有文本可抽（图片）——调用方应把原件路径直接交给 CLI
    None { reason: String },
}

/// 后缀 → 提取。不认识的类型明确报错（诚实：不是静默给空）。
pub fn extract(path: &Path, ext: &str) -> Result<ExtractOutcome, KbError> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "txt" | "text" | "log" | "json" | "csv" | "yaml" | "yml" | "toml" => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| KbError::io(path.display().to_string(), e))?;
            Ok(ExtractOutcome::Text(clamp(text)))
        }
        "pdf" => {
            let text = pdf_extract::extract_text(path).map_err(|e| KbError::Extract {
                rel: path.display().to_string(),
                reason: format!("PDF 解析失败：{e}"),
            })?;
            Ok(ExtractOutcome::Text(clamp(text)))
        }
        "docx" => Ok(ExtractOutcome::Text(clamp(extract_docx(path)?))),
        "xlsx" | "xls" | "ods" => Ok(ExtractOutcome::Text(clamp(extract_sheet(path)?))),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => Ok(ExtractOutcome::None {
            reason: "图片没有文本可提取（生成时会把原图直接交给 CLI 看）".to_string(),
        }),
        other => Err(KbError::Extract {
            rel: path.display().to_string(),
            reason: format!("还不认识的后缀：{other}"),
        }),
    }
}

/// 超上限取头 + 尾，标注省略（见模块头）。
fn clamp(text: String) -> String {
    let total = text.chars().count();
    if total <= MAX_CHARS {
        return text;
    }
    // 头 60% / 尾 40%：开头是标题和主旨，结尾是结论
    let head_n = MAX_CHARS * 6 / 10;
    let tail_n = MAX_CHARS - head_n;
    let chars: Vec<char> = text.chars().collect();
    let head: String = chars[..head_n].iter().collect();
    let tail: String = chars[total - tail_n..].iter().collect();
    format!(
        "{head}\n\n……（中间省略了 {} 个字）……\n\n{tail}",
        total - MAX_CHARS
    )
}

/// docx：zip 里的 `word/document.xml`，把 `<w:t>` 的文字按段落拼出来。
fn extract_docx(path: &Path) -> Result<String, KbError> {
    use quick_xml::events::Event;

    let file = File::open(path).map_err(|e| KbError::io(path.display().to_string(), e))?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| KbError::Extract {
        rel: path.display().to_string(),
        reason: format!("解不开 zip 容器：{e}"),
    })?;
    let mut doc = zip
        .by_name("word/document.xml")
        .map_err(|_| KbError::Extract {
            rel: path.display().to_string(),
            reason: "docx 里没有 word/document.xml".to_string(),
        })?;
    let mut xml = String::new();
    doc.read_to_string(&mut xml)
        .map_err(|e| KbError::io(path.display().to_string(), e))?;

    let mut reader = quick_xml::Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut out = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                // LocalName 是句柄（借用 e 的），先绑到变量再 as_ref ——
                // 直接临时值上取 as_ref 会被借用检查拒绝（E0716）
                let name = e.local_name();
                if name.as_ref() == "t" {
                    in_text = true;
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    // 段落结束给换行（tab 结束给制表符）——文档的「行」结构要
                    // 留住，不然整篇会粘成一行
                    "p" => out.push('\n'),
                    "t" => in_text = false,
                    "tab" => out.push('\t'),
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_text => {
                // 解一层实体（防御性：0.42 的 str reader 会把 `&amp;` 拆成
                // 独立的 GeneralRef 事件送过来，Text 里多数时候没有实体；
                // 解不开的（畸形实体）按原文放，多一个转义符比丢字强）
                match quick_xml::escape::unescape(t.as_ref()) {
                    Ok(decoded) => out.push_str(&decoded),
                    Err(_) => out.push_str(t.as_ref()),
                }
            }
            // ⚠️ 0.42 把实体拆成了独立事件 —— 不处理这一支，`&amp;` 就是**凭空
            // 丢字**（测试抓到的第一版 bug：正文里凭空少一个 `&`，不报错）
            Ok(Event::GeneralRef(r)) if in_text => {
                if r.is_char_ref() {
                    if let Ok(Some(ch)) = r.resolve_char_ref() {
                        out.push(ch);
                    }
                } else {
                    match r.as_ref() {
                        "amp" => out.push('&'),
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "quot" => out.push('"'),
                        "apos" => out.push('\''),
                        // 未定义的实体（docx 里基本见不到）：按原文留着，
                        // 让人一眼看出这里有个没解析的东西
                        other => {
                            out.push('&');
                            out.push_str(other);
                            out.push(';');
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return Err(KbError::Extract {
                    rel: path.display().to_string(),
                    reason: format!("document.xml 解析失败：{e}"),
                })
            }
        }
    }
    Ok(out)
}

/// xlsx/xls/ods：calamine 按工作表读出每行，制表符分隔、工作表之间加抬头。
fn extract_sheet(path: &Path) -> Result<String, KbError> {
    use calamine::{open_workbook_auto, Reader as _};

    let mut wb = open_workbook_auto(path).map_err(|e| KbError::Extract {
        rel: path.display().to_string(),
        reason: format!("表格解析失败：{e}"),
    })?;
    let names = wb.sheet_names().to_vec();
    let mut out = String::new();
    for name in names {
        let Ok(range) = wb.worksheet_range(&name) else {
            continue;
        };
        out.push_str(&format!("【工作表：{name}】\n"));
        for row in range.rows() {
            let cells: Vec<String> = row.iter().map(|c| c.to_string()).collect();
            // 整行空的行跳过（表格里到处都是）
            if cells.iter().all(|c| c.is_empty()) {
                continue;
            }
            out.push_str(&cells.join("\t"));
            out.push('\n');
        }
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "devtoolkit-kb-ext-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 文本_直读且按字符截断() {
        let d = tmp_dir("txt");
        let p = d.join("a.txt");
        std::fs::write(&p, "你好，世界").unwrap();
        assert_eq!(extract(&p, "txt").unwrap(), ExtractOutcome::Text("你好，世界".into()));

        // 超上限：头 + 省略标记 + 尾；按字符算，多字节不切半
        let long: String = "汉".repeat(MAX_CHARS + 500);
        std::fs::write(&p, &long).unwrap();
        let ExtractOutcome::Text(text) = extract(&p, "txt").unwrap() else {
            panic!("应该是文本");
        };
        assert!(text.contains("中间省略了 500 个字"));
        assert_eq!(text.chars().filter(|c| *c == '汉').count(), MAX_CHARS);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 图片_明确说没有文本可提_不是错误() {
        let got = extract(Path::new("x.png"), "png").unwrap();
        assert!(matches!(got, ExtractOutcome::None { .. }));
    }

    #[test]
    fn 不认识的后缀_诚实报错() {
        let err = extract(Path::new("x.xyz"), "xyz").unwrap_err();
        assert!(err.to_string().contains("还不认识"));
    }

    // ------------------------------------------------------------ docx 夹具

    /// 现造一个最小 docx（zip + 两段 document.xml）——不签入二进制夹具，
    /// 测试自己生成，永远和代码同步。
    fn write_minimal_docx(path: &Path) {
        use std::io::Write as _;
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();

        zip.start_file("[Content_Types].xml", opts).unwrap();
        zip.write_all(
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.as_bytes(),
        )
        .unwrap();

        zip.start_file("word/document.xml", opts).unwrap();
        zip.write_all(
            r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段：测试 &amp; 符号</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r><w:r><w:t>同一段后面</w:t></w:r></w:p></w:body></w:document>"#.as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn docx_提出段落和文字() {
        let d = tmp_dir("docx");
        let p = d.join("a.docx");
        write_minimal_docx(&p);
        let ExtractOutcome::Text(text) = extract(&p, "docx").unwrap() else {
            panic!("应该是文本");
        };
        assert!(text.contains("第一段：测试 & 符号"), "实体要解开：{text}");
        assert!(text.contains("第二段同一段后面"), "同一段的 run 要拼起来：{text}");
        assert!(text.find("第一段").unwrap() < text.find("第二段").unwrap());
        let _ = std::fs::remove_dir_all(&d);
    }

    // ------------------------------------------------------------ xlsx 夹具

    /// 现造一个最小 xlsx（inlineStr 单元格，两行三列）。
    fn write_minimal_xlsx(path: &Path) {
        use std::io::Write as _;
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();

        let parts: [(&str, &str); 5] = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>苹果</t></is></c><c r="B2" t="inlineStr"><is><t>42</t></is></c></row></sheetData></worksheet>"#,
            ),
        ];
        for (name, body) in parts {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn xlsx_提出单元格和表名() {
        let d = tmp_dir("xlsx");
        let p = d.join("a.xlsx");
        write_minimal_xlsx(&p);
        let ExtractOutcome::Text(text) = extract(&p, "xlsx").unwrap() else {
            panic!("应该是文本");
        };
        assert!(text.contains("【工作表：数据】"), "{text}");
        assert!(text.contains("名称\t数量"), "一行用制表符连：{text}");
        assert!(text.contains("苹果\t42"), "{text}");
        let _ = std::fs::remove_dir_all(&d);
    }

    // ------------------------------------------------------------- pdf 夹具

    /// 手写一个最小合法 PDF（含正确的 xref 偏移）——现造，不签入二进制。
    fn minimal_pdf(text: &str) -> Vec<u8> {
        let content = format!("BT /F1 24 Tf 72 720 Td ({text}) Tj ET");
        let objs: Vec<String> = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".into(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".into(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
        ];

        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, body) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
        }
        let xref_at = out.len();
        out.push_str(&format!("xref\n0 {}\n", objs.len() + 1));
        out.push_str("0000000000 65535 f \n");
        for off in &offsets {
            out.push_str(&format!("{off:010} 00000 n \n"));
        }
        out.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objs.len() + 1
        ));
        out.into_bytes()
    }

    #[test]
    fn pdf_提出文本() {
        let d = tmp_dir("pdf");
        let p = d.join("a.pdf");
        std::fs::write(&p, minimal_pdf("Hello Devtoolkit PDF")).unwrap();
        let got = extract(&p, "pdf").unwrap();
        let ExtractOutcome::Text(text) = got else {
            panic!("应该是文本");
        };
        assert!(text.contains("Hello Devtoolkit PDF"), "拿到：{text:?}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
