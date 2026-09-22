import { normalizeFormat } from "./utils.js";

export const CATEGORIES = Object.freeze([
  { id: "images", name: "Images", label: "Изображения" },
  { id: "raw", name: "RAW / Camera", label: "RAW / Камера" },
  { id: "vector", name: "Vector", label: "Вектор" },
  { id: "video", name: "Video", label: "Видео" },
  { id: "audio", name: "Audio", label: "Аудио" },
  { id: "documents", name: "Documents", label: "Документы" },
  { id: "pdf", name: "PDF", label: "PDF" },
  { id: "spreadsheets", name: "Spreadsheets", label: "Таблицы" },
  { id: "presentations", name: "Presentations", label: "Презентации" },
  { id: "ebooks", name: "Ebooks", label: "Электронные книги" },
  { id: "archives", name: "Archives", label: "Архивы" },
  { id: "fonts", name: "Fonts", label: "Шрифты" },
  { id: "subtitles", name: "Subtitles", label: "Субтитры" },
  { id: "three_d", name: "3D", label: "3D" },
  { id: "cad", name: "CAD", label: "CAD" },
  { id: "data", name: "Data", label: "Данные" },
  { id: "markup", name: "Markup", label: "Разметка" },
  { id: "disk", name: "Disk / Image", label: "Образы дисков" },
  { id: "scientific", name: "Scientific / Technical", label: "Научные / технические" },
  { id: "other", name: "Other", label: "Другие" }
]);

const GROUPS = {
  images: "jpg jpeg png webp gif apng bmp tiff tif ico icns avif heic heif jxl tga dds exr hdr ppm pgm pbm pnm xbm xpm qoi jfif pcx wbmp psd psb jp2 j2k jpf jpx ras pict pct pam svgz".split(" "),
  raw: "cr2 cr3 nef nrw arw srf sr2 raf rw2 orf pef dng srw x3f erf dcr kdc mrw mos mef ptx 3fr ari bay cap crw fff iiq rwl raw r3d".split(" "),
  vector: "svg eps ai cdr cgm emf wmf vsd vdx sk sk1 svgz".split(" "),
  video: "mp4 m4v mov mkv webm avi wmv flv f4v f4p mpeg mpg m2v m2ts ts mts 3gp 3g2 ogv vob asf rm rmvb dv mxf mod tod swf".split(" "),
  audio: "mp3 wav flac aac m4a m4b m4r ogg oga opus wma aiff aif au amr ac3 eac3 dts ape wv tta mka caf ra rmi mid midi mp2 mpc spx voc".split(" "),
  documents: "doc docx docm dot dotx odt ott rtf txt text html htm mht mhtml pages pub wpd tex rst abw djvu hwp hwpx lwp md sdw sxw wp wps zabw".split(" "),
  pdf: "pdf ps xps oxps".split(" "),
  spreadsheets: "xls xlsx xlsm xlsb csv tsv ods ots fods numbers sxc dif dbf".split(" "),
  presentations: "ppt pptx pptm pps ppsx ppsm odp otp key sxi pot potx potm".split(" "),
  ebooks: "epub mobi azw azw3 fb2 cbz cbr djvu lit lrf pdb rb snb tcr".split(" "),
  archives: "zip 7z rar tar gz tgz bz2 tbz tbz2 xz txz z lz lzma lz4 zst cab arj cpio deb rpm apk jar war ear cbz cbr".split(" "),
  fonts: "ttf otf ttc otc woff woff2 eot pfb pfa dfont fon".split(" "),
  subtitles: "srt ass ssa vtt sub sbv ttml dfxp smi sami mpl2 lrc".split(" "),
  three_d: "obj stl fbx gltf glb 3ds dae ply off 3mf blend vrml wrl x3d usdz usd usda usdc amf bvh lwo lws max m3d md2 md3 md5 pmx vox rbxl rbxm x".split(" "),
  cad: "dwg dxf dwf step stp iges igs dgn skp sat sab 3dm brep ifc sldasm slddrw sldprt".split(" "),
  data: "json csv tsv yaml yml toml ini log sql sqlite db ndjson geojson parquet avro orc".split(" "),
  markup: "xml html htm md markdown rst tex xhtml xhtm".split(" "),
  disk: "iso img dmg vhd vhdx vdi qcow qcow2 nrg bin cue".split(" "),
  scientific: "mat hdf h5 hdf5 fits fit grib grb nc netcdf vtk vtu mol sdf pdbx cif".split(" ")
};

const MIME = {
  jpg: ["image/jpeg"], jpeg: ["image/jpeg"], png: ["image/png"], webp: ["image/webp"], gif: ["image/gif"],
  svg: ["image/svg+xml"], avif: ["image/avif"], heic: ["image/heic"], heif: ["image/heif"], bmp: ["image/bmp"],
  tiff: ["image/tiff"], tif: ["image/tiff"], ico: ["image/x-icon"], pdf: ["application/pdf"],
  txt: ["text/plain"], text: ["text/plain"], csv: ["text/csv"], tsv: ["text/tab-separated-values"],
  json: ["application/json"], xml: ["application/xml", "text/xml"], html: ["text/html"], htm: ["text/html"],
  yaml: ["application/yaml", "text/yaml"], yml: ["application/yaml", "text/yaml"],
  doc: ["application/msword"], docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"], xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"], pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  odt: ["application/vnd.oasis.opendocument.text"], ods: ["application/vnd.oasis.opendocument.spreadsheet"], odp: ["application/vnd.oasis.opendocument.presentation"],
  epub: ["application/epub+zip"], zip: ["application/zip"], "7z": ["application/x-7z-compressed"], rar: ["application/vnd.rar"],
  mp4: ["video/mp4"], webm: ["video/webm"], mov: ["video/quicktime"], avi: ["video/x-msvideo"],
  mp3: ["audio/mpeg"], wav: ["audio/wav"], flac: ["audio/flac"], ogg: ["audio/ogg"], opus: ["audio/opus"],
  ttf: ["font/ttf"], otf: ["font/otf"], woff: ["font/woff"], woff2: ["font/woff2"],
  srt: ["application/x-subrip"], vtt: ["text/vtt"]
};

const SPECIAL_NAMES = {
  jpg: "JPEG Image", jpeg: "JPEG Image", png: "PNG Image", webp: "WebP Image", gif: "GIF Image", apng: "Animated PNG",
  avif: "AVIF Image", heic: "HEIC Image", heif: "HEIF Image", jxl: "JPEG XL", tiff: "TIFF Image", tif: "TIFF Image",
  pdf: "Portable Document Format", docx: "Microsoft Word", xlsx: "Microsoft Excel", pptx: "Microsoft PowerPoint",
  epub: "EPUB Ebook", mobi: "Mobipocket Ebook", azw3: "Kindle Ebook", mp4: "MPEG-4 Video", mp3: "MP3 Audio",
  wav: "Waveform Audio", flac: "FLAC Audio", mkv: "Matroska Video", webm: "WebM Media", mov: "QuickTime Video",
  ttf: "TrueType Font", otf: "OpenType Font", woff: "Web Open Font", woff2: "Web Open Font 2",
  dwg: "AutoCAD Drawing", dxf: "Drawing Exchange Format", svg: "Scalable Vector Graphics", json: "JSON Data", xml: "XML"
};

const EXT_TO_CATEGORY = new Map();
for (const [category, formats] of Object.entries(GROUPS)) {
  for (const format of formats) {
    if (!EXT_TO_CATEGORY.has(format)) EXT_TO_CATEGORY.set(format, category);
  }
}

export function getCategoryForFormat(format) {
  const id = normalizeFormat(format);
  return EXT_TO_CATEGORY.get(id) || "other";
}

export function categoryLabel(categoryId) {
  return CATEGORIES.find(item => item.id === categoryId)?.label || "Другие";
}

export function getFormat(format) {
  const extension = normalizeFormat(format);
  const category = getCategoryForFormat(extension);
  return {
    id: extension,
    extension,
    name: SPECIAL_NAMES[extension] || extension.toUpperCase(),
    category,
    categoryLabel: categoryLabel(category),
    mimeTypes: MIME[extension] || [],
    providers: [],
    conversions: []
  };
}

export function getSeedRegistry() {
  const seen = new Set();
  const formats = [];
  for (const category of CATEGORIES) {
    const values = GROUPS[category.id] || [];
    for (const extension of values) {
      if (seen.has(extension)) continue;
      seen.add(extension);
      formats.push(getFormat(extension));
    }
  }
  return formats;
}

export function enrichFormat(format, providers = [], conversions = []) {
  return {
    ...getFormat(format),
    providers: [...new Set(providers)],
    conversions: [...conversions]
  };
}

export function allKnownExtensions() {
  return getSeedRegistry().map(item => item.extension);
}
