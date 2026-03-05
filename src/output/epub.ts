import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import { chapterKey } from "../utils/ids.js";
import { ensureDir, writeJsonAtomic } from "../utils/fs.js";

export interface EpubMetadata {
  title: string;
  author: string;
  language: string;
  description: string;
  keywords?: string[];
  genre?: string;
}

interface ChapterDoc {
  chapterNumber: number;
  title: string;
  markdown: string;
}

const DEFAULT_STYLES = `
body { font-family: Georgia, serif; line-height: 1.6; margin: 0; padding: 1.2rem; color: #1b1b1b; }
h1 { font-size: 1.7rem; margin: 1.2rem 0; font-weight: 600; }
h2 { font-size: 1.3rem; margin: 1rem 0 0.5rem; }
p { margin: 0 0 0.9rem; text-indent: 1.2rem; }
.scene-break { text-align: center; letter-spacing: 0.25rem; margin: 1.2rem 0; text-indent: 0; }
`;

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function markdownToXhtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const chunks: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("# ")) {
      chunks.push(`<h1>${escapeXml(line.slice(2).trim())}</h1>`);
      continue;
    }

    if (line.startsWith("## ")) {
      chunks.push(`<h2>${escapeXml(line.slice(3).trim())}</h2>`);
      continue;
    }

    if (line === "***") {
      chunks.push(`<p class=\"scene-break\">* * *</p>`);
      continue;
    }

    chunks.push(`<p>${escapeXml(line)}</p>`);
  }

  return chunks.join("\n");
}

function chapterXhtml(chapter: ChapterDoc): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head>
    <title>${escapeXml(chapter.title)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
  </head>
  <body>
${markdownToXhtml(chapter.markdown)}
  </body>
</html>`;
}

function contentOpf(metadata: EpubMetadata, chapters: ChapterDoc[]): string {
  const nowIso = new Date().toISOString();
  const manifestItems = chapters
    .map(
      (chapter) =>
        `<item id="${chapterKey(chapter.chapterNumber)}" href="chapters/${chapterKey(chapter.chapterNumber)}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n    ");

  const spineItems = chapters
    .map((chapter) => `<itemref idref="${chapterKey(chapter.chapterNumber)}"/>`)
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(metadata.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${escapeXml(crypto.randomUUID())}</dc:identifier>
    <dc:title>${escapeXml(metadata.title)}</dc:title>
    <dc:creator>${escapeXml(metadata.author)}</dc:creator>
    <dc:language>${escapeXml(metadata.language)}</dc:language>
    <dc:description>${escapeXml(metadata.description)}</dc:description>
    ${metadata.genre ? `<dc:subject>${escapeXml(metadata.genre)}</dc:subject>` : ""}
    ${metadata.keywords ? `<meta property="keywords">${escapeXml(metadata.keywords.join(", "))}</meta>` : ""}
    <meta property="dcterms:modified">${nowIso}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;
}

function navXhtml(chapters: ChapterDoc[]): string {
  const links = chapters
    .map(
      (chapter) =>
        `<li><a href="chapters/${chapterKey(chapter.chapterNumber)}.xhtml">Chapter ${chapter.chapterNumber}: ${escapeXml(chapter.title)}</a></li>`,
    )
    .join("\n          ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>Table of Contents</title></head>
  <body>
    <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops" id="toc">
      <h1>Table of Contents</h1>
      <ol>
          ${links}
      </ol>
    </nav>
  </body>
</html>`;
}

async function loadChapterDocs(chapterRoot: string): Promise<ChapterDoc[]> {
  const entries = await readdir(chapterRoot, { withFileTypes: true });
  const chapterDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("ch-"));

  const docs: ChapterDoc[] = [];
  for (const dir of chapterDirs) {
    const chapterNumber = Number.parseInt(dir.name.replace("ch-", ""), 10);
    const markdownPath = path.join(chapterRoot, dir.name, "chapter.active.md");
    const markdown = await readFile(markdownPath, "utf-8");

    const titleLine = markdown.split(/\r?\n/)[0] ?? `Chapter ${chapterNumber}`;
    const title = titleLine.replace(/^#\s*/, "").trim();
    docs.push({ chapterNumber, title, markdown });
  }

  docs.sort((a, b) => a.chapterNumber - b.chapterNumber);
  return docs;
}

export async function exportStyledEpub(args: {
  projectDir: string;
  exportDir: string;
  slug: string;
  metadata: EpubMetadata;
}): Promise<string> {
  const chapters = await loadChapterDocs(path.join(args.projectDir, "stage3-chapters"));
  if (chapters.length === 0) {
    throw new Error("No chapter.active.md files found for EPUB export");
  }

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  zip.file("OEBPS/styles.css", DEFAULT_STYLES);
  zip.file("OEBPS/nav.xhtml", navXhtml(chapters));
  zip.file("OEBPS/content.opf", contentOpf(args.metadata, chapters));

  for (const chapter of chapters) {
    const fileName = `OEBPS/chapters/${chapterKey(chapter.chapterNumber)}.xhtml`;
    zip.file(fileName, chapterXhtml(chapter));
  }

  await ensureDir(args.exportDir);
  const epubPath = path.join(args.exportDir, `${args.slug}.epub`);
  const buffer = await zip.generateAsync({ type: "uint8array" });
  await writeFile(epubPath, Buffer.from(buffer));

  const metadataPath = path.join(args.exportDir, "metadata.json");
  await writeJsonAtomic(metadataPath, args.metadata);

  return epubPath;
}
