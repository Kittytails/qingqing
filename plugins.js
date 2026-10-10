/* Direct Link 插件文件：所有插件都写在这里，和 直链.html 放同一目录。
 *
 * 加一个插件 = 在下面追加一段 DL.register({...})。写法：
 *
 *   DL.register({
 *     id: 'my-plugin',              // 唯一，不要改（开关状态按它记）
 *     name: '插件名',                // 显示在「插件」页
 *     desc: '一句话说明',
 *     default: false,               // 第一次是否默认开启
 *
 *     // 上传前：返回新的 File 就替换原文件；不返回或原样返回就不改。可以是 async。
 *     // 想在结果行显示一句提示：out._saveNote = '文字'
 *     async beforeUpload(file, DL) { return file; },
 *
 *     // 上传成功后（不等它跑完）。info: { name, url, size, isImage, deduped, owner, repo, branch, path }
 *     afterUpload(info, DL) { },
 *
 *     // 可选：页面加载完插件后、以及在「设置」里开关时调用。on 为 true/false
 *     onToggle(on, DL) { },
 *   });
 *
 * DL 上能用的：DL.toast(文字, 类型)、DL.isImage(file)。
 * 插件和页面同源，能读到 Token，只启用自己写的或信得过的脚本。 */

/* ---------- 小工具 ---------- */
function dlLoadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
        img.src = url;
    });
}
function dlCanvasBlob(canvas, type, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}
function dlFreeCanvas(canvas) { canvas.width = canvas.height = 0; }   // iOS Safari 不会主动回收画布，批量处理时要手动释放

/* =====================================================================
 * 插件 1：去除照片里的位置 / 拍摄信息（EXIF、XMP 等）
 *  - JPEG：直接删掉元数据段，不重新压缩，画质不变；颜色配置（ICC）保留
 *  - 照片带"旋转"标记时，删掉标记会让图片横过来，所以这种图会先转正再重新编码
 *  - PNG：删掉文字块和 EXIF 块
 * ===================================================================== */
DL.register({
    id: 'exif-strip',
    name: '去除位置信息（EXIF）',
    desc: '上传前删掉照片里的 GPS 位置、拍摄设备、时间等信息，JPEG 不重新压缩，画质不变。',
    default: false,

    async beforeUpload(file, DL) {
        if (!DL.isImage(file) || file.size < 12) return file;
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return stripJpeg(file, bytes, DL);
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return stripPng(file, bytes);
        return file;   // GIF / WebP / HEIC 等：不处理
    }
});

function exifU16(b, o, le) { return le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]); }
function exifU32(b, o, le) {
    return le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
              : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
// 读 EXIF 里的旋转标记（1 = 正常）。seg 是 APP1 段数据（不含 FF E1 和长度）
function exifOrientation(b, start, end) {
    try {
        const t = start + 6;                         // 跳过 "Exif\0\0"
        const le = b[t] === 0x49;                    // 'II' = 小端，'MM' = 大端
        const ifd = t + exifU32(b, t + 4, le);
        const n = exifU16(b, ifd, le);
        for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (e + 12 > end) break;
            if (exifU16(b, e, le) === 0x0112) return exifU16(b, e + 8, le) || 1;
        }
    } catch (_) {}
    return 1;
}
function isHeader(b, o, str) {
    for (let i = 0; i < str.length; i++) if (b[o + i] !== str.charCodeAt(i)) return false;
    return true;
}

async function stripJpeg(file, b, DL) {
    const parts = [b.subarray(0, 2)];
    let i = 2, removed = 0, orient = 1;
    while (i < b.length) {
        let j = i;
        if (b[j] !== 0xFF) return file;              // 结构不对：不动它
        while (b[j] === 0xFF) j++;                   // 跳过填充字节
        const m = b[j], segStart = j - 1;
        i = j + 1;
        if (m === 0xD9) { parts.push(b.subarray(segStart, i)); break; }                 // EOI
        if (m === 0xDA) { parts.push(b.subarray(segStart)); break; }                    // SOS：后面是图像数据，原样保留
        if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { parts.push(b.subarray(segStart, i)); continue; }   // 没有长度的标记
        const len = exifU16(b, i, false), segEnd = i + len;
        if (len < 2 || segEnd > b.length) return file;
        const data = i + 2;
        let drop = false;
        if (m === 0xE1) {                            // APP1：EXIF / XMP
            drop = true;
            if (isHeader(b, data, 'Exif\0\0')) orient = exifOrientation(b, data, segEnd);
        } else if (m === 0xED || m === 0xFE) {       // APP13（Photoshop / IPTC）、注释
            drop = true;
        } else if (m === 0xE2 && !isHeader(b, data, 'ICC_PROFILE')) {   // APP2：除颜色配置外都删（如 MPF）
            drop = true;
        }
        if (drop) removed += segEnd - segStart; else parts.push(b.subarray(segStart, segEnd));
        i = segEnd;
    }
    if (!removed) return file;                       // 本来就没有元数据

    if (orient > 1) {
        // 有旋转标记：先让浏览器按标记转正再重新编码，这样不会横过来；重新编码出来的文件本身就不带任何元数据
        try {
            const img = await dlLoadImage(file);
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            const blob = await dlCanvasBlob(c, 'image/jpeg', 0.95);
            dlFreeCanvas(c);
            if (!blob || blob.type !== 'image/jpeg') throw new Error('编码失败');
            const out = new File([blob], file.name, { type: 'image/jpeg', lastModified: file.lastModified });
            out._saveNote = '已去除位置信息';
            return out;
        } catch (e) {
            DL.toast('去除位置信息失败，这张图按原图上传', 'info');
            return file;
        }
    }
    const out = new File(parts, file.name, { type: file.type || 'image/jpeg', lastModified: file.lastModified });
    out._saveNote = '已去除位置信息';
    return out;
}

const PNG_DROP = { tEXt: 1, zTXt: 1, iTXt: 1, eXIf: 1, tIME: 1 };
function stripPng(file, b) {
    const parts = [b.subarray(0, 8)];
    let i = 8, removed = 0;
    while (i + 12 <= b.length) {
        const len = exifU32(b, i, false), end = i + 12 + len;
        if (end > b.length) return file;
        const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
        if (PNG_DROP[type]) removed += end - i; else parts.push(b.subarray(i, end));
        i = end;
        if (type === 'IEND') break;
    }
    if (!removed) return file;
    const out = new File(parts, file.name, { type: file.type || 'image/png', lastModified: file.lastModified });
    out._saveNote = '已去除元数据';
    return out;
}

/* =====================================================================
 * 插件 2：给图片加文字水印（右下角）
 *  - 只处理 JPEG / PNG / WebP；GIF、SVG、动图 WebP 保持原样
 *  - 水印文字、大小、透明度在下面 WATERMARK 里改
 * ===================================================================== */
const WATERMARK = {
    text: '© Direct Link',   // 水印文字
    scale: 0.035,            // 字号 = 图片短边 × 这个比例
    opacity: 0.6,            // 文字不透明度 0~1
    margin: 0.02,            // 距右下角的边距 = 图片短边 × 这个比例
    quality: 0.92            // JPEG / WebP 重新编码的质量
};

DL.register({
    id: 'watermark',
    name: '图片水印',
    desc: '上传前在图片右下角加一行文字水印。文字和大小在 plugins.js 顶部的 WATERMARK 里改。GIF、SVG、动图不处理。',
    default: false,

    async beforeUpload(file, DL) {
        if (!DL.isImage(file) || !/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
        if (file.type === 'image/webp' && await isAnimatedWebp(file)) return file;

        const img = await dlLoadImage(file);
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return file;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, w, h);

        const short = Math.min(w, h);
        const fs = Math.max(14, Math.round(short * WATERMARK.scale));
        const pad = Math.round(short * WATERMARK.margin);
        g.font = '600 ' + fs + 'px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif';
        g.textAlign = 'right';
        g.textBaseline = 'bottom';
        g.lineJoin = 'round';
        g.lineWidth = Math.max(2, fs / 8);
        g.strokeStyle = 'rgba(0,0,0,' + (WATERMARK.opacity * 0.5) + ')';   // 描一圈深色边，浅色背景上也看得清
        g.fillStyle = 'rgba(255,255,255,' + WATERMARK.opacity + ')';
        g.strokeText(WATERMARK.text, w - pad, h - pad);
        g.fillText(WATERMARK.text, w - pad, h - pad);

        const blob = await dlCanvasBlob(c, file.type, WATERMARK.quality);
        dlFreeCanvas(c);
        if (!blob || blob.type !== file.type) return file;
        const out = new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
        out._saveNote = file._saveNote ? file._saveNote + ' · 已加水印' : '已加水印';   // 前一个插件写过提示就接在后面
        return out;
    }
});

async function isAnimatedWebp(file) {
    try {
        const b = new Uint8Array(await file.slice(0, 32).arrayBuffer());
        // RIFF....WEBPVP8X：第 21 个字节的第 2 位是"含动画"标记
        return isHeader(b, 0, 'RIFF') && isHeader(b, 8, 'WEBP') && isHeader(b, 12, 'VP8X') && (b[20] & 0x02) !== 0;
    } catch (_) { return false; }
}
