export function buildChapterMarkdown(chapterNumber: number, chapterTitle: string, body: string): string {
  const heading = `# Chapter ${chapterNumber}: ${chapterTitle}`;
  return `${heading}\n\n${body.trim()}\n`;
}
