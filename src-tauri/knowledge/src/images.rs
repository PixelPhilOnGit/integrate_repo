//! 从资料里抽图片：PDF 内嵌图 / Word·PPT 的 media / 单独上传的图片。
//!
//! # 为什么在上传时就抽（而不是生成时）
//!
//! * 上传后来源行就能显示「N 张图」，生成前就知道素材情况；
//! * 生成命令保持「只读资料、只写卡片」的性质，不在长任务里做额外落盘；
//! * 文件名由来源存储名确定，**删除来源时可以精确清理**；
//! * 生成时只读索引里的图片清单，不用重新解析一遍 PDF/Office。
//!
//! 抽出来的图片落在 `_files/<来源存储名去扩展名>-img-<n>.<ext>`（见
//! [`image_rel`]），卡片里引用这个路径，阅读器按路径读字节。
//!
//! # 依赖（零新增 crate）
//!
//! `lopdf`（pdf-extract 已经在用它）、`flate2`、`png` 都已在
//! `src-tauri/Cargo.lock` 的依赖树里。`png` 只用来把 PDF 里 **FlateDecode
//! 的裸像素**编码成 PNG；DCTDecode 的 JPEG 原字节直接落盘，不解码。
//!
//! # PDF 的支持边界（做不了的如实跳过，不假装成功）
//!
//! 支持：`DCTDecode`（JPEG 直出）、`FlateDecode` + 8-bit DeviceRGB/DeviceGray
//! 且无 predictor / Decode 变换。
//!
//! 跳过并计数：JPX/JBIG2/CCITT/LZW、多级过滤器、非 8 bit、CMYK/Indexed/
//! Separation/ICCBased 的 Flate、加密 PDF、inline image、嵌套 Form XObject。
//!
//! ⚠️ 这些跳过**不影响上传**：来源照常入库，`ImageSet.note` 里写一句人话，
//! 提示词里也会告诉模型「这些图不可引用」。

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use crate::error::KbError;

pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// 每份资料最多抽这么多张（防止一份几百页的 PDF 把库撑爆）。
pub const MAX_IMAGES_PER_SOURCE: usize = 50;
/// 单张原始字节上限。
pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
/// 单份资料的图片总输出上限。
pub const MAX_TOTAL_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// 单张像素上限（宽 × 高）。
pub const MAX_IMAGE_PIXELS: u64 = 25_000_000;
/// Flate 解压后的读取上限（防解压炸弹）。
const MAX_DECODED_BYTES: usize = 96 * 1024 * 1024;

/// 一张抽出来的图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedImage {
    /// 落盘扩展名（`jpg` / `png` / …，小写、不带点）
    pub ext: String,
    pub bytes: Vec<u8>,
    /// 给人看的原始名字（PDF 用「第 N 页」，docx 用 zip 里的文件名）
    pub original_name: String,
    pub page: Option<u32>,
}

/// 一次抽取的结果（成功抽到的 + 统计 + 人话说明）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImageSet {
    pub images: Vec<ExtractedImage>,
    /// 发现的总数（含跳过的）
    pub found: usize,
    /// 跳过的数量
    pub skipped: usize,
    /// 空串 = 没有需要说明的；否则是给用户看的一句话
    pub note: String,
}

/// 抽图片。`ext` 是小写、不带点的后缀。
///
/// ⚠️ 调用方**不要**把这里的 `Err` 当成上传失败：图片抽不出来不影响资料入库，
/// 把错误转成 `note` 就好（见命令层）。
pub fn extract_images(path: &Path, ext: &str) -> Result<ImageSet, KbError> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => extract_direct(path, &ext),
        "pdf" => extract_pdf(path),
        "docx" => extract_office_media(path, "word/media/"),
        "pptx" => extract_office_media(path, "ppt/media/"),
        _ => Ok(ImageSet::default()),
    }
}

/// 图片在 vault 里的相对路径（确定性的；也是卡片里的 target）。
pub fn image_rel(source_stem: &str, index: usize, ext: &str) -> String {
    format!("_files/{source_stem}-img-{index}.{ext}")
}

/// 来源存储名 → 图片名前缀（去掉扩展名）。
///
/// `1729123456789_报告.pdf` → `1729123456789_报告`。
pub fn source_stem(stored_name: &str) -> String {
    Path::new(stored_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| stored_name.to_string())
}

fn normalize_ext(ext: &str) -> String {
    match ext.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => "jpg".to_string(),
        other => other.to_string(),
    }
}

fn extract_direct(path: &Path, ext: &str) -> Result<ImageSet, KbError> {
    let bytes = std::fs::read(path).map_err(|e| KbError::io(path.display().to_string(), e))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Ok(ImageSet {
            images: Vec::new(),
            found: 1,
            skipped: 1,
            note: format!(
                "图片太大了（{:.1} MB，上限 16 MB），没有保存",
                bytes.len() as f64 / 1024.0 / 1024.0
            ),
        });
    }
    let original_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".to_string());
    Ok(ImageSet {
        images: vec![ExtractedImage {
            ext: normalize_ext(ext),
            bytes,
            original_name,
            page: None,
        }],
        found: 1,
        skipped: 0,
        note: String::new(),
    })
}

// ---------------------------------------------------------------- PDF

fn extract_pdf(path: &Path) -> Result<ImageSet, KbError> {
    let bytes = std::fs::read(path).map_err(|e| KbError::io(path.display().to_string(), e))?;
    let doc = lopdf::Document::load_mem(&bytes).map_err(|e| KbError::Extract {
        rel: path.display().to_string(),
        reason: format!("PDF 打不开：{e}"),
    })?;

    if doc.is_encrypted() {
        return Ok(ImageSet {
            images: Vec::new(),
            found: 0,
            skipped: 0,
            note: "PDF 是加密的，图片没有提取".to_string(),
        });
    }

    let mut out = ImageSet::default();
    let mut seen: BTreeSet<lopdf::ObjectId> = BTreeSet::new();
    let mut reasons: BTreeSet<String> = BTreeSet::new();
    let mut total_bytes = 0usize;

    for (page_no, page_id) in doc.get_pages() {
        let page_images = match doc.get_page_images(page_id) {
            Ok(images) => images,
            Err(_) => continue,
        };
        for img in page_images {
            // 同一个 XObject 可能被多页引用 —— 只算一次。
            if !seen.insert(img.id) {
                continue;
            }
            out.found += 1;

            let width = img.width.max(0) as u64;
            let height = img.height.max(0) as u64;
            if width == 0 || height == 0 || width * height > MAX_IMAGE_PIXELS {
                out.skipped += 1;
                reasons.insert("尺寸太大".to_string());
                continue;
            }
            if out.images.len() >= MAX_IMAGES_PER_SOURCE {
                out.skipped += 1;
                reasons.insert("超过每份 50 张的上限".to_string());
                continue;
            }

            let filters = img.filters.clone().unwrap_or_default();
            let filter = match filters.as_slice() {
                [] => "None",
                [one] => one.as_str(),
                _ => {
                    out.skipped += 1;
                    reasons.insert("多级过滤器".to_string());
                    continue;
                }
            };

            let extracted: Option<(String, Vec<u8>)> = match filter {
                "DCTDecode" => {
                    // 直接就是 JPEG 字节；校验一下魔数，避免把坏数据当图片。
                    if img.content.starts_with(&[0xFF, 0xD8]) {
                        Some(("jpg".to_string(), img.content.to_vec()))
                    } else {
                        None
                    }
                }
                "FlateDecode" => flate_to_png(&img),
                "JPXDecode" => {
                    reasons.insert("JPX（扫描件）".to_string());
                    None
                }
                "JBIG2Decode" => {
                    reasons.insert("JBIG2（扫描件）".to_string());
                    None
                }
                "CCITTFaxDecode" => {
                    reasons.insert("CCITT（扫描件）".to_string());
                    None
                }
                "LZWDecode" => {
                    reasons.insert("LZW".to_string());
                    None
                }
                other => {
                    reasons.insert(format!("{other}"));
                    None
                }
            };

            let Some((ext, data)) = extracted else {
                out.skipped += 1;
                continue;
            };
            if data.len() > MAX_IMAGE_BYTES || total_bytes + data.len() > MAX_TOTAL_IMAGE_BYTES {
                out.skipped += 1;
                reasons.insert("图片太大".to_string());
                continue;
            }
            total_bytes += data.len();
            out.images.push(ExtractedImage {
                ext,
                bytes: data,
                original_name: format!(
                    "第{page_no}页-image{}-{}.{}",
                    img.id.0, img.id.1,
                    normalize_ext(&filter.to_ascii_lowercase())
                ),
                page: Some(page_no),
            });
        }
    }

    if out.skipped > 0 {
        out.note = format!(
            "共找到 {} 张图，提取 {} 张；跳过 {} 张（{}）",
            out.found,
            out.images.len(),
            out.skipped,
            reasons.into_iter().collect::<Vec<_>>().join("、")
        );
    }
    Ok(out)
}

/// FlateDecode 的裸像素 → PNG。不满足条件就返回 None（计为跳过）。
fn flate_to_png(img: &lopdf::xobject::PdfImage<'_>) -> Option<(String, Vec<u8>)> {
    if img.bits_per_component.unwrap_or(8) != 8 {
        return None;
    }
    let channels = match img.color_space.as_deref() {
        Some("DeviceRGB") => 3usize,
        Some("DeviceGray") => 1usize,
        _ => return None,
    };
    // predictor / 颜色变换：不猜，直接跳过（见模块头的边界）。
    match img.origin_dict.get(b"DecodeParms") {
        Ok(lopdf::Object::Dictionary(parms)) => {
            if parms
                .get(b"Predictor")
                .ok()
                .and_then(|p| p.as_i64().ok())
                .unwrap_or(1)
                > 1
            {
                return None;
            }
        }
        Ok(lopdf::Object::Array(a)) if !a.is_empty() => return None,
        _ => {}
    }
    if img.origin_dict.get(b"Decode").is_ok() {
        return None;
    }

    let width = img.width.max(0) as u32;
    let height = img.height.max(0) as u32;
    let expected = width as usize * height as usize * channels;

    // ⚠️ 有界解压：解压炸弹在这里就停下。
    let mut raw = Vec::new();
    let decoder = flate2::read::ZlibDecoder::new(img.content);
    decoder
        .take((MAX_DECODED_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .ok()?;
    if raw.len() < expected || raw.len() > MAX_DECODED_BYTES {
        return None;
    }
    raw.truncate(expected);

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(if channels == 3 {
            png::ColorType::Rgb
        } else {
            png::ColorType::Grayscale
        });
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&raw).ok()?;
        writer.finish().ok()?;
    }
    Some(("png".to_string(), png_bytes))
}

// ---------------------------------------------------------------- Office

fn extract_office_media(path: &Path, prefix: &str) -> Result<ImageSet, KbError> {
    let file = File::open(path).map_err(|e| KbError::io(path.display().to_string(), e))?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| KbError::Extract {
        rel: path.display().to_string(),
        reason: format!("解不开 zip 容器：{e}"),
    })?;

    let mut names: Vec<String> = zip
        .file_names()
        .filter_map(|name| name.ok())
        .filter(|name| name.starts_with(prefix))
        .map(|name| name.to_string())
        .collect();
    names.sort();

    let mut out = ImageSet::default();
    let mut total_bytes = 0usize;
    let mut reasons: BTreeSet<String> = BTreeSet::new();

    for name in names {
        out.found += 1;
        let file_name = name.rsplit('/').next().unwrap_or(&name).to_string();
        let ext = file_name
            .rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            out.skipped += 1;
            reasons.insert(format!("{ext} 格式"));
            continue;
        }
        if out.images.len() >= MAX_IMAGES_PER_SOURCE {
            out.skipped += 1;
            reasons.insert("超过每份 50 张的上限".to_string());
            continue;
        }
        let mut entry = match zip.by_name(&name) {
            Ok(entry) => entry,
            Err(_) => {
                out.skipped += 1;
                reasons.insert("读不出来".to_string());
                continue;
            }
        };
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_err() {
            out.skipped += 1;
            reasons.insert("读不出来".to_string());
            continue;
        }
        if bytes.len() > MAX_IMAGE_BYTES || total_bytes + bytes.len() > MAX_TOTAL_IMAGE_BYTES {
            out.skipped += 1;
            reasons.insert("图片太大".to_string());
            continue;
        }
        total_bytes += bytes.len();
        out.images.push(ExtractedImage {
            ext: normalize_ext(&ext),
            bytes,
            original_name: file_name,
            page: None,
        });
    }

    if out.skipped > 0 {
        out.note = format!(
            "共找到 {} 张图，提取 {} 张；跳过 {} 张（{}）",
            out.found,
            out.images.len(),
            out.skipped,
            reasons.into_iter().collect::<Vec<_>>().join("、")
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "devtoolkit-kb-img-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 一张 1×1 的 PNG（用 png crate 现造，不签入二进制）。
    fn png_1x1() -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, 1, 1);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[255, 0, 0]).unwrap();
            w.finish().unwrap();
        }
        out
    }

    #[test]
    fn 单独图片_原字节直出() {
        let dir = tmp_dir("direct");
        let path = dir.join("图.png");
        std::fs::write(&path, png_1x1()).unwrap();

        let set = extract_images(&path, "png").unwrap();
        assert_eq!(set.found, 1);
        assert_eq!(set.images.len(), 1);
        assert_eq!(set.images[0].ext, "png");
        assert_eq!(set.images[0].original_name, "图.png");
        assert!(set.note.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 命名_确定且可复现() {
        assert_eq!(
            image_rel("1729123456789_报告", 1, "jpg"),
            "_files/1729123456789_报告-img-1.jpg"
        );
        assert_eq!(source_stem("1729_报告.pdf"), "1729_报告");
        assert_eq!(source_stem("noext"), "noext");
    }

    #[test]
    fn docx_抽_media_并把_emf_计入跳过() {
        let dir = tmp_dir("docx");
        let path = dir.join("a.docx");
        {
            let file = File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("word/document.xml", opts).unwrap();
            zip.write_all(b"<w:document/>").unwrap();
            zip.start_file("word/media/image1.png", opts).unwrap();
            zip.write_all(&png_1x1()).unwrap();
            zip.start_file("word/media/image2.emf", opts).unwrap();
            zip.write_all(b"not-an-image").unwrap();
            zip.finish().unwrap();
        }

        let set = extract_images(&path, "docx").unwrap();
        assert_eq!(set.found, 2);
        assert_eq!(set.images.len(), 1);
        assert_eq!(set.images[0].original_name, "image1.png");
        assert_eq!(set.skipped, 1);
        assert!(set.note.contains("emf"), "note: {}", set.note);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pptx_抽_media() {
        let dir = tmp_dir("pptx");
        let path = dir.join("a.pptx");
        {
            let file = File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("ppt/media/image1.png", opts).unwrap();
            zip.write_all(&png_1x1()).unwrap();
            zip.finish().unwrap();
        }
        let set = extract_images(&path, "pptx").unwrap();
        assert_eq!(set.images.len(), 1);
        assert_eq!(set.images[0].ext, "png");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ------------------------------------------------------------ PDF 夹具

    /// 现造一个带一张图片 XObject 的最小 PDF（xref 偏移按字节算）。
    fn pdf_with_image(opts: &str, data: &[u8]) -> Vec<u8> {
        let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
        let mut offsets: Vec<usize> = Vec::new();

        let objects: [&[u8]; 3] = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 4 0 R >> >> >>",
        ];
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }

        offsets.push(out.len());
        out.extend_from_slice(
            format!(
                "4 0 obj\n<< /Type /XObject /Subtype /Image {opts} /Length {} >>\nstream\n",
                data.len()
            )
            .as_bytes(),
        );
        out.extend_from_slice(data);
        out.extend_from_slice(b"\nendstream\nendobj\n");

        let xref_at = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", offsets.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for offset in &offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
                offsets.len() + 1
            )
            .as_bytes(),
        );
        out
    }

    fn extract_pdf_bytes(dir: &Path, bytes: &[u8]) -> ImageSet {
        let path = dir.join("a.pdf");
        std::fs::write(&path, bytes).unwrap();
        extract_images(&path, "pdf").unwrap()
    }

    #[test]
    fn pdf_DCTDecode_按原字节落成_jpg() {
        let dir = tmp_dir("pdf-dct");
        // 只要前两个字节是 JPEG 的 SOI，我们的检查就认（不在这里解码）。
        let jpeg = [0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0xFF, 0xD9];
        let pdf = pdf_with_image(
            "/Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
            &jpeg,
        );
        let set = extract_pdf_bytes(&dir, &pdf);
        assert_eq!(set.images.len(), 1, "{set:?}");
        assert_eq!(set.images[0].ext, "jpg");
        assert_eq!(set.images[0].bytes, jpeg);
        assert_eq!(set.images[0].page, Some(1));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pdf_FlateDecode_裸像素转成可解码的_png() {
        use std::io::Write as _;
        let dir = tmp_dir("pdf-flate");
        // 2×2 RGB：红 / 绿 / 蓝 / 黄
        let raw: [u8; 12] = [
            255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0,
        ];
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let compressed = encoder.finish().unwrap();

        let pdf = pdf_with_image(
            "/Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
            &compressed,
        );
        let set = extract_pdf_bytes(&dir, &pdf);
        assert_eq!(set.images.len(), 1, "{set:?}");
        assert_eq!(set.images[0].ext, "png");

        // 输出必须是真 PNG 且像素一致（不是把裸像素硬塞进去）。
        let decoder = png::Decoder::new(std::io::Cursor::new(&set.images[0].bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (2, 2));
        assert_eq!(&buf[..info.buffer_size()], &raw);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pdf_JPX_跳过并如实说明() {
        let dir = tmp_dir("pdf-jpx");
        let pdf = pdf_with_image(
            "/Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode",
            &[1, 2, 3, 4],
        );
        let set = extract_pdf_bytes(&dir, &pdf);
        assert!(set.images.is_empty());
        assert_eq!(set.found, 1);
        assert_eq!(set.skipped, 1);
        assert!(set.note.contains("JPX"), "note: {}", set.note);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 坏_pdf_返回错误_由命令层转成说明() {
        let dir = tmp_dir("pdf-bad");
        let path = dir.join("bad.pdf");
        std::fs::write(&path, b"not a pdf at all").unwrap();
        assert!(extract_images(&path, "pdf").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 不认识的类型返回空集_不报错() {
        let set = extract_images(Path::new("/nope/x.md"), "md").unwrap();
        assert!(set.images.is_empty());
        assert_eq!(set.found, 0);
    }
}
